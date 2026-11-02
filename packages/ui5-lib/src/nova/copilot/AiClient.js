sap.ui.define([
    "./Logger"
], function (Logger) {
    "use strict";

    // The Nova CAP service owns the AI Core credentials, the system prompt and
    // the orchestration request shape. The app only sends a question + context.
    var NOVA_ASK_URL = "/nova/ask";
    var NOVA_EXTRACT_URL = "/nova/extractFields";
    var NOVA_PDF_URL = "/nova/extractPdfText";

    function postJson(sUrl, oBody) {
        return fetch(sUrl, {
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
            return fetch(NOVA_PDF_URL, {
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

            return fetch(NOVA_ASK_URL, {
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
