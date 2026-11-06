sap.ui.define([
    "./AiClient",
    "./Logger"
], function (AiClient, Logger) {
    "use strict";

    // Enough for a few pages of a quote or spec. Keeps the upload cheap and
    // stops a stray large file turning into a very expensive request.
    var MAX_CHARS = 8000;

    var TEXT_EXTENSIONS = ["txt", "csv", "tsv", "json", "md", "xml", "htm", "html", "log"];

    function extensionOf(sName) {
        var aParts = String(sName || "").split(".");
        return aParts.length > 1 ? aParts.pop().toLowerCase() : "";
    }

    return {
        MAX_CHARS: MAX_CHARS,

        /**
         * True for the formats we can read in the browser without pulling in a
         * parsing library. Anything else is reported rather than half-read.
         */
        isSupported: function (oFile) {
            var sExtension = extensionOf(oFile && oFile.name);
            return TEXT_EXTENSIONS.indexOf(sExtension) !== -1 ||
                sExtension === "pdf" ||
                /^text\//.test((oFile && oFile.type) || "") ||
                (oFile && oFile.type) === "application/pdf";
        },

        describeUnsupported: function (oFile) {
            var sExtension = extensionOf(oFile && oFile.name);
            if (["xlsx", "xls"].indexOf(sExtension) !== -1) {
                return "Spreadsheets aren't readable here yet. Save the sheet as .csv and I can read that.";
            }
            if (["png", "jpg", "jpeg", "gif", "bmp", "tiff", "webp", "heic"].indexOf(sExtension) !== -1) {
                return "Filling in THIS record needs a text document - images aren't read here. " +
                    "(Reading images of invoices IS supported in Bulk create, for creating new records.)";
            }
            return "I can read plain text files: .txt, .csv, .json, .md and similar.";
        },

        /**
         * Reads the file to text in the browser. Nothing is uploaded anywhere -
         * only the extracted text is sent on, and only once the user has
         * confirmed they want it read.
         *
         * @returns {Promise<{text: string, truncated: boolean, name: string}>}
         */
        read: function (oFile) {
            var sExtension = extensionOf(oFile && oFile.name);
            var bPdf = sExtension === "pdf" || oFile.type === "application/pdf";

            if (bPdf) {
                return this._readPdf(oFile);
            }
            return this._readText(oFile);
        },

        /**
         * PDFs are decoded by the service: keeping a PDF library out of the UI
         * avoids shipping a megabyte of parser and fighting the content policy.
         * The file reaches our own service only - never the model.
         */
        _readPdf: function (oFile) {
            return new Promise(function (resolve, reject) {
                var oReader = new FileReader();
                oReader.onload = function () {
                    // strip the "data:application/pdf;base64," prefix
                    var sBase64 = String(oReader.result || "").split(",")[1] || "";
                    Logger.step("DocumentReader", "sending " + oFile.name + " for text extraction", {
                        bytes: oFile.size
                    });
                    AiClient.extractPdfText(sBase64).then(function (sText) {
                        var bTruncated = sText.length > MAX_CHARS;
                        resolve({
                            name: oFile.name,
                            text: bTruncated ? sText.slice(0, MAX_CHARS) : sText,
                            truncated: bTruncated
                        });
                    }).catch(reject);
                };
                oReader.onerror = function () {
                    reject(new Error("The file could not be read."));
                };
                oReader.readAsDataURL(oFile);
            });
        },

        _readText: function (oFile) {
            return new Promise(function (resolve, reject) {
                var oReader = new FileReader();

                oReader.onload = function () {
                    var sText = String(oReader.result || "");
                    var bTruncated = sText.length > MAX_CHARS;

                    Logger.step("DocumentReader", "read " + oFile.name, {
                        bytes: oFile.size,
                        characters: sText.length,
                        truncated: bTruncated
                    });

                    resolve({
                        name: oFile.name,
                        text: bTruncated ? sText.slice(0, MAX_CHARS) : sText,
                        truncated: bTruncated
                    });
                };

                oReader.onerror = function () {
                    Logger.error("DocumentReader", "could not read " + oFile.name);
                    reject(new Error("The file could not be read."));
                };

                oReader.readAsText(oFile);
            });
        },

        /**
         * The fields worth asking about: writable, and without the keys, which
         * should never come from a document. Pass the RICH description from
         * FieldPopulator.describeEntityType ({properties, keyFields}) - the
         * thin ContextCollector shape carries no creatable/updatable/required
         * flags and no key list at all, so with it every check here silently
         * passed and key fields were offered to the model (confirmed by
         * comparing the two shapes directly - this doc comment used to claim
         * keys were excluded while nothing excluded them).
         */
        writableFields: function (oEntityMeta, bCreateMode) {
            var aKeyFields = (oEntityMeta && oEntityMeta.keyFields) || [];
            return ((oEntityMeta && oEntityMeta.properties) || []).filter(function (oProp) {
                if (aKeyFields.indexOf(oProp.name) !== -1) {
                    return false;
                }
                var bWritable = bCreateMode ? oProp.creatable !== false : oProp.updatable !== false;
                return bWritable;
            }).map(function (oProp) {
                return {
                    name: oProp.name,
                    type: oProp.type,
                    label: oProp.label,
                    required: !!oProp.required
                };
            });
        }
    };
});
