sap.ui.define([
    "./Logger"
], function (Logger) {
    "use strict";

    // Resolved relative to THIS module's own deployed location, the same way
    // sap.ui.model.odata.v2.ODataModel resolves a manifest dataSource URI -
    // NOT a literal browser-absolute path. The two give the same answer for
    // a standalone deploy, but diverge the moment the app runs embedded
    // somewhere that serves it under its own path prefix (e.g. SAP Build
    // Work Zone, which mounts each app under a long per-registration path).
    // A hardcoded fetch("/nova/ask") misses that prefix entirely and 404s;
    // this does not, because it is computed the same way the dock's own
    // CSS/i18n bundle already is (see ChatMixin.js) - and those are
    // confirmed to load correctly inside Work Zone.
    // normalized to exactly one trailing slash - toUrl()'s handling of a
    // trailing "/" in the argument isn't something to bet string
    // concatenation on
    var NOVA_BASE = sap.ui.require.toUrl("nova/copilot/../../").replace(/\/*$/, "/");

    // The Nova CAP service owns the AI Core credentials, the system prompt and
    // the orchestration request shape. The app only sends a question + context.
    var NOVA_ASK_URL = NOVA_BASE + "nova/ask";
    var NOVA_EXTRACT_URL = NOVA_BASE + "nova/extractFields";
    var NOVA_PDF_URL = NOVA_BASE + "nova/extractPdfText";
    // any URL under /nova works for fetching a token - $metadata always exists
    var NOVA_TOKEN_URL = NOVA_BASE + "nova/$metadata";

    // UI5's own ODataModel fetches and attaches CSRF tokens automatically;
    // these are plain fetch() calls, so that has to be done by hand here.
    // Locally (mocked auth), the service never asks for one and this just
    // stays null - every header below becomes a harmless no-op. In
    // production it is fetched once, cached, and only re-fetched if the
    // service reports the cached one stale.
    var sCsrfToken = null;

    function fetchCsrfToken() {
        return fetch(NOVA_TOKEN_URL, {
            method: "GET",
            headers: { "X-CSRF-Token": "Fetch" }
        }).then(function (oResponse) {
            sCsrfToken = oResponse.headers.get("x-csrf-token") || sCsrfToken;
            return sCsrfToken;
        }).catch(function () {
            return null;
        });
    }

    /**
     * Runs a POST, fetching a CSRF token first if none is cached yet, and
     * retrying exactly once with a fresh token if the service rejects the
     * attempt as needing one (the standard SAP signal: a 403 carrying an
     * "x-csrf-token: Required" response header) - covers both "never fetched
     * one" and "the cached one went stale" without the caller knowing which.
     */
    function postWithCsrf(sUrl, oInit, bRetried) {
        var oTokenPromise = sCsrfToken ? Promise.resolve(sCsrfToken) : fetchCsrfToken();
        return oTokenPromise.then(function (sToken) {
            oInit.headers = oInit.headers || {};
            if (sToken) {
                oInit.headers["X-CSRF-Token"] = sToken;
            }
            return fetch(sUrl, oInit);
        }).then(function (oResponse) {
            var sNeedsToken = oResponse.headers.get("x-csrf-token");
            if (oResponse.status === 403 && !bRetried &&
                    sNeedsToken && /required/i.test(sNeedsToken)) {
                Logger.warn("AiClient", "CSRF token was rejected - fetching a fresh one and retrying once");
                sCsrfToken = null;
                return postWithCsrf(sUrl, oInit, true);
            }
            return oResponse;
        });
    }

    function postJson(sUrl, oBody) {
        return postWithCsrf(sUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(oBody)
        }).then(function (oResponse) {
            if (!oResponse.ok) {
                return oResponse.text().then(function (sText) {
                    throw new Error("Nova service failed (" + oResponse.status + "): " + sText);
                });
            }
            return oResponse.json();
        }).then(function (oResponseBody) {
            var sContent = oResponseBody && oResponseBody.value !== undefined
                ? oResponseBody.value
                : oResponseBody;
            if (!sContent) {
                throw new Error("Nova returned an empty answer");
            }
            try {
                return JSON.parse(sContent);
            } catch (oParseError) {
                throw new Error("Nova did not return valid JSON: " + sContent);
            }
        });
    }

    return {
        /**
         * Hands a base64 PDF to the service and gets its text layer back.
         * The file reaches our own service only; the model sees just the text.
         *
         * @param {string} sBase64 the PDF, base64 encoded
         * @returns {Promise<string>} the extracted text
         */
        extractPdfText: function (sBase64) {
            Logger.step("AiClient", "POST " + NOVA_PDF_URL, { base64Chars: sBase64.length });
            return postWithCsrf(NOVA_PDF_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ content: sBase64 })
            }).then(function (oResponse) {
                return oResponse.json().then(function (oBody) {
                    if (!oResponse.ok) {
                        var sDetail = (oBody && oBody.error && oBody.error.message) ||
                            ("the service returned " + oResponse.status);
                        throw new Error(sDetail);
                    }
                    var sText = oBody && oBody.value !== undefined ? oBody.value : oBody;
                    Logger.step("AiClient", "PDF text extracted", { characters: String(sText).length });
                    return String(sText || "");
                });
            });
        },

        /**
         * Asks the service to pull field values out of a document's text. Uses
         * a separate, much shorter prompt than the chat, so an upload costs a
         * fraction of an ordinary question.
         *
         * @param {string} sText the document text, read in the browser
         * @param {object[]} aFields writable fields with name, type and label
         * @returns {Promise<{values: object[], message: string, notFound: string[]}>}
         */
        extractFields: function (sText, aFields) {
            Logger.step("AiClient", "POST " + NOVA_EXTRACT_URL, {
                documentChars: sText.length,
                fieldsOffered: aFields.length
            });
            return postJson(NOVA_EXTRACT_URL, {
                text: sText,
                fields: JSON.stringify(aFields)
            }).then(function (oResult) {
                Logger.step("AiClient", "extraction returned " +
                    ((oResult.values || []).length) + " value(s)", oResult.notFound);
                return oResult;
            });
        },

        /**
         * @param {string} sQuestion plain-English user question
         * @param {object} oContext app/entity/filter/row context from ContextCollector
         * @returns {Promise<object>} resolves to the parsed { action, filters, message } object
         */
        ask: function (sQuestion, oContext) {
            var sPayload = JSON.stringify({
                question: sQuestion,
                context: JSON.stringify(oContext)
            });

            Logger.step("AiClient", "POST " + NOVA_ASK_URL, {
                question: sQuestion,
                // record values are never part of the payload - assert it in the trace
                recordValuesSent: !!(oContext && oContext.rows),
                payloadBytes: sPayload.length
            });

            var iStart = Date.now();

            return postWithCsrf(NOVA_ASK_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: sPayload
            }).then(function (oResponse) {
                if (!oResponse.ok) {
                    return oResponse.text().then(function (sText) {
                        Logger.error("AiClient", "service returned " + oResponse.status, sText);
                        throw new Error("Nova service failed (" + oResponse.status + "): " + sText);
                    });
                }
                return oResponse.json();
            }).then(function (oResponseBody) {
                // a CAP action returning a scalar wraps it in "value"
                var sContent = oResponseBody && oResponseBody.value !== undefined
                    ? oResponseBody.value
                    : oResponseBody;

                if (!sContent) {
                    Logger.error("AiClient", "empty answer from service");
                    throw new Error("Nova returned an empty answer");
                }
                try {
                    var oAction = JSON.parse(sContent);
                    Logger.step("AiClient", "answer received in " + (Date.now() - iStart) + "ms", {
                        action: oAction.action,
                        filters: (oAction.filters || []).length,
                        bullets: (oAction.bullets || []).length,
                        basis: oAction.basis
                    });
                    return oAction;
                } catch (oParseError) {
                    Logger.error("AiClient", "answer was not valid JSON", sContent);
                    throw new Error("Nova did not return valid JSON: " + sContent);
                }
            });
        }
    };
});
