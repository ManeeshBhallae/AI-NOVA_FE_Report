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
    var NOVA_EXTRACT_LINE_ITEMS_URL = NOVA_BASE + "nova/extractLineItems";
    var NOVA_PDF_URL = NOVA_BASE + "nova/extractPdfText";
    var NOVA_CHART_INSIGHT_URL = NOVA_BASE + "nova/describeChart";
    var NOVA_RESET_USAGE_URL = NOVA_BASE + "nova/resetUsage";
    // any URL under /nova works for fetching a token - $metadata always exists
    var NOVA_TOKEN_URL = NOVA_BASE + "nova/$metadata";

    // UI5's own ODataModel fetches and attaches CSRF tokens automatically;
    // these are plain fetch() calls, so that has to be done by hand here.
    // Locally (mocked auth), the service never asks for one and this just
    // stays null - every header below becomes a harmless no-op. In
    // production it is fetched once, cached, and only re-fetched if the
    // service reports the cached one stale.
    var sCsrfToken = null;

    // Last-known token usage, parsed off the x-nova-tokens response header
    // the service now sets on every model call - the exact counts AI Core
    // reported, which SAP meters into capacity units. Held module-level
    // (same lifetime as the dock's shared model) with a simple listener so
    // the UI can show a live counter without any extra request.
    var oLastUsage = null;
    var aUsageListeners = [];

    function captureUsage(oResponse) {
        try {
            var sHeader = oResponse.headers.get("x-nova-tokens");
            if (!sHeader) {
                return;
            }
            oLastUsage = JSON.parse(sHeader);
            Logger.step("AiClient", "token usage", oLastUsage);
            aUsageListeners.forEach(function (fnListener) {
                try {
                    fnListener(oLastUsage);
                } catch (oError) {
                    // one bad listener must not break the others or the call
                }
            });
        } catch (oError) {
            // telemetry only - never let it affect the actual response
        }
    }

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
            // one central hook - every AI action POSTs through here, so the
            // usage counter needs no per-action wiring
            captureUsage(oResponse);
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
        /** Registers a listener called with {action, prompt, completion, total, sessionCalls, sessionTotal, sessionCu} after every model call. */
        onUsage: function (fnListener) {
            if (aUsageListeners.indexOf(fnListener) === -1) {
                aUsageListeners.push(fnListener);
            }
            if (oLastUsage) {
                fnListener(oLastUsage);
            }
        },

        /**
         * Clears the usage counters everywhere: the service's session AND
         * persisted all-time totals, then this module's own last-known
         * numbers (listeners get null so the UI empties too). No model
         * call involved.
         * @returns {Promise<void>}
         */
        resetUsage: function () {
            Logger.step("AiClient", "POST " + NOVA_RESET_USAGE_URL);
            return postWithCsrf(NOVA_RESET_USAGE_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: "{}"
            }).then(function (oResponse) {
                if (!oResponse.ok) {
                    return oResponse.text().then(function (sText) {
                        throw new Error("Could not clear the usage counters (" + oResponse.status + "): " + sText);
                    });
                }
                oLastUsage = null;
                aUsageListeners.forEach(function (fnListener) {
                    try {
                        fnListener(null);
                    } catch (oError) { /* one bad listener must not break the others */ }
                });
            });
        },

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
         * Asks the service to write a short, grounded insight for a chart -
         * only called when a chart is pinned to the workboard, not on every
         * chart built in chat. Unlike ask()/extractFields(), the summary
         * sent here is already-aggregated category totals the chart itself
         * displays - never individual record values.
         *
         * @param {{title:string, dimensionLabel:string, measures:object[], rows:object[]}} oSummary
         * @returns {Promise<string>} a short plain-text insight
         */
        describeChart: function (oSummary) {
            var sPayload = JSON.stringify({ chart: JSON.stringify(oSummary) });
            Logger.step("AiClient", "POST " + NOVA_CHART_INSIGHT_URL, {
                dimension: oSummary.dimensionLabel,
                categories: (oSummary.rows || []).length,
                payloadBytes: sPayload.length
            });
            return postWithCsrf(NOVA_CHART_INSIGHT_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: sPayload
            }).then(function (oResponse) {
                return oResponse.json().then(function (oBody) {
                    if (!oResponse.ok) {
                        var sDetail = (oBody && oBody.error && oBody.error.message) ||
                            ("the service returned " + oResponse.status);
                        throw new Error(sDetail);
                    }
                    var sText = oBody && oBody.value !== undefined ? oBody.value : oBody;
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
         * Hands one or more invoice documents (text already extracted
         * client-side for text PDFs, or resized images for everything else)
         * to the service in ONE call for the whole batch - the model does
         * its own OCR on image documents, so no separate OCR library or
         * extra round trip is involved. Uses a separate, much shorter
         * prompt than the chat, same reasoning as extractFields.
         *
         * @param {object[]} aDocuments [{name, kind:"text"|"image", text?, mimeType?, base64?}]
         * @param {object[]} aFields writable fields with name, type and label
         * @returns {Promise<{documents: object[]}>}
         */
        extractLineItems: function (aDocuments, aFields) {
            Logger.step("AiClient", "POST " + NOVA_EXTRACT_LINE_ITEMS_URL, {
                documentCount: aDocuments.length,
                imageCount: aDocuments.filter(function (d) { return d.kind === "image"; }).length,
                fieldsOffered: aFields.length
                // deliberately no content/size trace beyond counts - the
                // documents are the user's own upload, same posture as
                // extractFields's documentChars-only trace
            });
            return postJson(NOVA_EXTRACT_LINE_ITEMS_URL, {
                documents: JSON.stringify(aDocuments),
                fields: JSON.stringify(aFields)
            }).then(function (oResult) {
                Logger.step("AiClient", "line-item extraction returned " +
                    ((oResult.documents || []).length) + " document result(s)");
                return oResult;
            });
        },

        /**
         * @param {string} sQuestion plain-English user question
         * @param {object} oContext app/entity/filter/row context from ContextCollector
         * @param {Array<{role:string,text:string}>} [aHistory] prior turns, most recent conversation first
         * @returns {Promise<object>} resolves to the parsed { action, filters, message } object
         */
        ask: function (sQuestion, oContext, aHistory) {
            var sPayload = JSON.stringify({
                question: sQuestion,
                context: JSON.stringify(oContext),
                history: JSON.stringify(aHistory || [])
            });

            Logger.step("AiClient", "POST " + NOVA_ASK_URL, {
                question: sQuestion,
                // record values are never part of the payload - assert it in the trace
                recordValuesSent: !!(oContext && oContext.rows),
                historyTurns: (aHistory || []).length,
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
