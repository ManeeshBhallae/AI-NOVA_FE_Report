sap.ui.define([
    "sap/ui/table/Table",
    "sap/ui/table/Column",
    "sap/m/Text",
    "sap/m/Input",
    "sap/m/ObjectStatus",
    "sap/m/CheckBox",
    "./ThirdPartyLoader",
    "./FieldPopulator",
    "./AiClient",
    "./ImageResizer",
    "./Logger"
], function (GridTable, GridColumn, Text, Input, ObjectStatus, CheckBox,
    ThirdPartyLoader, FieldPopulator, AiClient, ImageResizer, Logger) {
    "use strict";

    // Mirrors nova-service.js's own MAX_INVOICE_DOCS - checked here too so an
    // over-limit selection fails fast with a clear message instead of a
    // round trip, same "client cap not trusted, server re-checks
    // independently" posture already used for the chat history cap.
    var MAX_INVOICE_DOCS = 8;

    /**
     * Mass-create from an Excel upload, built on the exact same safety
     * boundary FieldPopulator.js already enforces for a single record: this
     * module can stage, coerce and validate rows, but the only function in
     * it that is allowed to actually write to the OData service
     * (submitRows) is never called from anywhere an AI response could
     * reach - there is no "action" the model can emit that leads here, it
     * is wired to exactly one manual button press in the controller.
     */

    // Fields offered on the template/upload: creatable, not part of the key -
    // the service can't create a key value for you, and non-creatable fields
    // (computed, read-only) would just be rejected on submit anyway.
    function writableCreateFields(oDescribed) {
        var aKeyFields = (oDescribed && oDescribed.keyFields) || [];
        return ((oDescribed && oDescribed.properties) || []).filter(function (oProp) {
            return oProp.creatable !== false && aKeyFields.indexOf(oProp.name) === -1;
        });
    }

    function coerceCell(oField, vRaw) {
        var bPresent = vRaw !== undefined && vRaw !== null && vRaw !== "";
        if (!bPresent) {
            if (oField.required) {
                return { raw: "", ok: false, value: null, reason: oField.label + " is required" };
            }
            return { raw: "", ok: true, value: null, reason: "" };
        }
        var oCoerced = FieldPopulator.coerce(oField, vRaw);
        return {
            raw: String(vRaw),
            ok: oCoerced.ok,
            value: oCoerced.ok ? oCoerced.value : null,
            reason: oCoerced.ok ? "" : oCoerced.reason
        };
    }

    function rowHasIssues(aCells) {
        return aCells.some(function (oCell) { return !oCell.ok; });
    }

    function buildStagedRow(iIndex, oRawRow, aFields, sSource) {
        var aCells = aFields.map(function (oField) {
            return coerceCell(oField, oRawRow[oField.name]);
        });
        return {
            // doc-sourced rows get their own id namespace so an invoice
            // append can never collide with an Excel upload's "row-0..."
            id: (sSource ? "doc-row-" : "row-") + iIndex,
            index: iIndex,
            excluded: false,
            cells: aCells,
            hasIssues: rowHasIssues(aCells),
            // only ever set for document-sourced rows (additive - an
            // Excel-only session's rows simply don't carry this field, and
            // buildReviewTable only renders a Source column when asked to)
            source: sSource || ""
        };
    }

    // .pdf is handled via extractPdfText (text layer) first; these are the
    // image kinds routed straight to ImageResizer + vision OCR.
    var IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"];

    // Scanned PDFs (no text layer): rendered page by page via the vendored
    // pdf.js and sent as page images for the model's own OCR. Ten pages
    // covers the stated requirement; a smaller long edge than single photos
    // (1200 vs 1500) keeps a 10-page scan's vision cost in check while
    // staying comfortably readable for printed invoice text.
    var MAX_PDF_PAGES = 10;
    var PDF_PAGE_LONG_EDGE = 1200;

    /**
     * Renders a scanned PDF's pages to JPEG images client-side. Returns the
     * {name, kind:"image", pages:[{mimeType, base64}]} document shape the
     * service accepts for multi-page documents - all pages stay ONE
     * document, so its line items come back under one source, not ten.
     */
    function renderPdfPages(oFile) {
        return ThirdPartyLoader.loadPdfJs().then(function (pdfjsLib) {
            return oFile.arrayBuffer().then(function (oBuffer) {
                return pdfjsLib.getDocument({ data: oBuffer }).promise;
            }).then(function (oPdf) {
                var iPages = Math.min(oPdf.numPages, MAX_PDF_PAGES);
                var aPages = [];

                // sequential, one canvas at a time - rendering ten pages in
                // parallel just spikes memory for no latency win here
                function renderNext(iPageNo) {
                    if (iPageNo > iPages) {
                        return Promise.resolve();
                    }
                    return oPdf.getPage(iPageNo).then(function (oPage) {
                        var oBase = oPage.getViewport({ scale: 1 });
                        var fScale = PDF_PAGE_LONG_EDGE / Math.max(oBase.width, oBase.height);
                        var oViewport = oPage.getViewport({ scale: fScale });

                        var oCanvas = document.createElement("canvas");
                        oCanvas.width = Math.round(oViewport.width);
                        oCanvas.height = Math.round(oViewport.height);

                        return oPage.render({
                            canvasContext: oCanvas.getContext("2d"),
                            viewport: oViewport
                        }).promise.then(function () {
                            return ImageResizer.canvasToJpeg(oCanvas, 0.8);
                        }).then(function (oJpeg) {
                            aPages.push(oJpeg);
                            return renderNext(iPageNo + 1);
                        });
                    });
                }

                return renderNext(1).then(function () {
                    Logger.step("BulkUpload", "rendered " + aPages.length + " page(s) of '" +
                        oFile.name + "' for vision OCR" +
                        (oPdf.numPages > iPages ? " (of " + oPdf.numPages + " - capped)" : ""));
                    return { name: oFile.name, kind: "image", pages: aPages };
                });
            });
        });
    }

    function readFileAsBase64(oFile) {
        return new Promise(function (resolve, reject) {
            var oReader = new FileReader();
            oReader.onload = function () {
                var sDataUrl = String(oReader.result || "");
                var iComma = sDataUrl.indexOf(",");
                resolve(iComma === -1 ? sDataUrl : sDataUrl.slice(iComma + 1));
            };
            oReader.onerror = function () {
                reject(new Error("'" + oFile.name + "' could not be read."));
            };
            oReader.readAsDataURL(oFile);
        });
    }

    // One text part's size and how many parts one file may become. A flat
    // 8000-char truncation here silently DROPPED the later invoices of a
    // multi-invoice PDF (confirmed live: a 7-page file with ~61 line items
    // staged only 41) - splitting into parts keeps every item while still
    // bounding what one request carries.
    var CHUNK_CHARS = 7000;
    var MAX_TEXT_PARTS = 5;

    /**
     * Splits a long document text into part-documents at line boundaries.
     * Part names carry a " (part i/N)" suffix so the model can label them,
     * which the caller strips again for the Source column - to the user it
     * is still one file.
     * @returns {object[]} one or more {name, kind:"text", text} entries
     */
    function chunkTextDocument(sName, sText) {
        if (sText.length <= CHUNK_CHARS) {
            return [{ name: sName, kind: "text", text: sText }];
        }
        var aParts = [];
        var sRemaining = sText;
        while (sRemaining.length && aParts.length < MAX_TEXT_PARTS) {
            var sChunk = sRemaining;
            if (sRemaining.length > CHUNK_CHARS) {
                var iCut = sRemaining.lastIndexOf("\n", CHUNK_CHARS);
                if (iCut < CHUNK_CHARS / 2) {
                    iCut = CHUNK_CHARS;
                }
                sChunk = sRemaining.slice(0, iCut);
            }
            aParts.push(sChunk);
            sRemaining = sRemaining.slice(sChunk.length);
        }
        if (sRemaining.length) {
            Logger.warn("BulkUpload", "'" + sName + "': " + sRemaining.length +
                " character(s) beyond " + MAX_TEXT_PARTS + " part(s) were not sent");
        }
        var iTotal = aParts.length;
        Logger.step("BulkUpload", "'" + sName + "' split into " + iTotal + " part(s) (" +
            sText.length + " characters)");
        return aParts.map(function (sPart, i) {
            return {
                name: iTotal > 1 ? sName + " (part " + (i + 1) + "/" + iTotal + ")" : sName,
                kind: "text",
                text: sPart
            };
        });
    }

    /**
     * Prepares one uploaded file into one or more {name, kind,
     * text|base64/mimeType|pages} entries for extractLineItems, OR resolves
     * to a client-side "unreadable" entry (never rejects) so one bad file
     * can never sink the rest of the batch before it even reaches the
     * server. Always resolves to an ARRAY - a long text PDF becomes several
     * part-entries, everything else exactly one.
     */
    function prepareDocument(oFile) {
        var sName = oFile.name;
        var sLower = sName.toLowerCase();

        if (sLower.indexOf(".pdf") === sLower.length - 4 || oFile.type === "application/pdf") {
            return readFileAsBase64(oFile).then(function (sBase64) {
                return AiClient.extractPdfText(sBase64).then(function (sText) {
                    return chunkTextDocument(sName, sText);
                });
            }).catch(function (oError) {
                // the "no text layer" case is a scan - render its pages to
                // images client-side and let the model OCR them, instead of
                // the old dead end of telling the user to export it by hand
                if (/no text layer|scan/i.test(oError.message)) {
                    Logger.step("BulkUpload", "'" + sName + "' has no text layer - rendering pages for OCR");
                    return renderPdfPages(oFile).then(function (oDoc) {
                        return [oDoc];
                    }).catch(function (oRenderError) {
                        return [{ name: sName, unreadable: true,
                            message: "Could not render this scanned PDF: " + oRenderError.message }];
                    });
                }
                // any other PDF read failure - synthesized as unreadable
                // rather than thrown, so the rest of the batch still goes
                return [{ name: sName, unreadable: true,
                    message: "Could not read this PDF: " + oError.message }];
            });
        }

        if (IMAGE_MIME_TYPES.indexOf(oFile.type) !== -1) {
            return ImageResizer.resize(oFile).then(function (oResized) {
                return [{ name: sName, kind: "image", base64: oResized.base64, mimeType: oResized.mimeType }];
            }).catch(function (oError) {
                return [{ name: sName, unreadable: true, message: "Could not read this image: " + oError.message }];
            });
        }

        return Promise.resolve([{
            name: sName, unreadable: true,
            message: "Unsupported file type - upload a PDF, JPG, PNG or WEBP."
        }]);
    }

    /** Strips the internal " (part i/N)" suffix so the Source column shows the real file name. */
    function sourceNameOf(sDocName) {
        return String(sDocName || "").replace(/ \(part \d+\/\d+\)$/, "");
    }

    return {
        /**
         * Reads the entity's real metamodel (via FieldPopulator.describeEntityType)
         * and returns the fields a bulk-create template should offer. Exposed so
         * the controller can decide whether there's anything to offer before
         * even showing the button's result.
         * @returns {{properties: object[], keyFields: string[]}|null}
         */
        describeEntity: function (oODataModel, sEntitySet) {
            return FieldPopulator.describeEntityType(oODataModel, sEntitySet);
        },

        /**
         * Generates and downloads an .xlsx template: one header row, one
         * column per creatable non-key field, named by the field's
         * technical name (not its label) so a round-tripped upload maps
         * back onto fields unambiguously.
         * @returns {Promise<{fields: object[], fileName: string}>}
         */
        buildTemplate: function (oODataModel, sEntitySet, sFileNamePrefix) {
            var oDescribed = this.describeEntity(oODataModel, sEntitySet);
            if (!oDescribed) {
                return Promise.reject(new Error("Could not read this entity's metadata."));
            }
            var aFields = writableCreateFields(oDescribed);
            if (!aFields.length) {
                return Promise.reject(new Error("This entity has no fields that can be created."));
            }

            return ThirdPartyLoader.loadXlsx().then(function (XLSX) {
                var aHeader = aFields.map(function (oField) { return oField.name; });
                var oSheet = XLSX.utils.aoa_to_sheet([aHeader]);
                var oWorkbook = XLSX.utils.book_new();
                XLSX.utils.book_append_sheet(oWorkbook, oSheet, "New records");
                var sFileName = (sFileNamePrefix || sEntitySet || "records") + "-template.xlsx";
                XLSX.writeFile(oWorkbook, sFileName);
                Logger.step("BulkUpload", "downloaded template with " + aFields.length + " column(s)", sFileName);
                return { fields: aFields, fileName: sFileName };
            });
        },

        /**
         * Parses an uploaded .xlsx file against the entity's writable fields.
         * Deterministic coercion/validation only - no model call, matching
         * the template's happy path (its own columns, exactly).
         * @returns {Promise<{fields: object[], rows: object[]}>}
         */
        parseUpload: function (oFile, oODataModel, sEntitySet) {
            var oDescribed = this.describeEntity(oODataModel, sEntitySet);
            if (!oDescribed) {
                return Promise.reject(new Error("Could not read this entity's metadata."));
            }
            var aFields = writableCreateFields(oDescribed);

            return ThirdPartyLoader.loadXlsx().then(function (XLSX) {
                return oFile.arrayBuffer().then(function (oBuffer) {
                    var oWorkbook = XLSX.read(oBuffer, { type: "array" });
                    var sSheetName = oWorkbook.SheetNames[0];
                    if (!sSheetName) {
                        throw new Error("The file has no sheets.");
                    }
                    var oSheet = oWorkbook.Sheets[sSheetName];
                    var aRawRows = XLSX.utils.sheet_to_json(oSheet, { defval: "" });
                    var aRows = aRawRows.map(function (oRawRow, i) {
                        return buildStagedRow(i, oRawRow, aFields);
                    });
                    Logger.step("BulkUpload", "parsed " + aRows.length + " row(s), " +
                        aRows.filter(function (r) { return r.hasIssues; }).length + " with issues");
                    return { fields: aFields, rows: aRows };
                });
            });
        },

        /**
         * Reads one or more invoice documents - text-layer PDFs via the
         * existing extractPdfText (free, no model call), images via
         * ImageResizer + the model's own vision OCR - and sends the whole
         * batch to extractLineItems in ONE call, not one per file. Every
         * line item the model finds becomes a staged row in the exact same
         * shape parseUpload produces, tagged with its source filename. A
         * document the model (or the client, before ever sending it) could
         * not read contributes zero rows and is reported back separately -
         * one bad invoice never sinks the rest of the batch.
         * @param {FileList|File[]} aFiles
         * @returns {Promise<{fields: object[], rows: object[], unreadable: object[]}>}
         */
        buildRowsFromDocuments: function (aFiles, oODataModel, sEntitySet) {
            var aFileList = Array.prototype.slice.call(aFiles || []);
            if (!aFileList.length) {
                return Promise.reject(new Error("No files were selected."));
            }
            if (aFileList.length > MAX_INVOICE_DOCS) {
                return Promise.reject(new Error("Too many files at once (" + aFileList.length +
                    ", max " + MAX_INVOICE_DOCS + ") - upload them in smaller batches."));
            }

            var oDescribed = this.describeEntity(oODataModel, sEntitySet);
            if (!oDescribed) {
                return Promise.reject(new Error("Could not read this entity's metadata."));
            }
            var aFields = writableCreateFields(oDescribed);

            return Promise.all(aFileList.map(prepareDocument)).then(function (aNested) {
                // prepareDocument resolves to an array per file (a long text
                // PDF becomes several parts) - flatten to one document list
                var aPrepared = [].concat.apply([], aNested);
                var aUnreadableUpfront = aPrepared.filter(function (d) { return d.unreadable; });
                var aSendable = aPrepared.filter(function (d) { return !d.unreadable; });

                if (!aSendable.length) {
                    return { fields: aFields, rows: [], unreadable: aUnreadableUpfront };
                }

                // the server's per-batch document cap counts PART entries,
                // so re-check after splitting, not just on the file count
                if (aSendable.length > MAX_INVOICE_DOCS) {
                    return Promise.reject(new Error("These files split into " + aSendable.length +
                        " document part(s) (max " + MAX_INVOICE_DOCS + ") - upload fewer files per batch."));
                }

                // mirrors the server's MAX_INVOICE_IMAGES - a 10-page scan
                // plus several photos can exceed it, and failing here beats
                // shipping megabytes for a guaranteed 400
                var MAX_INVOICE_IMAGES = 15;
                var iImages = aSendable.reduce(function (iSum, oDoc) {
                    if (oDoc.kind !== "image") {
                        return iSum;
                    }
                    return iSum + (oDoc.pages ? oDoc.pages.length : 1);
                }, 0);
                if (iImages > MAX_INVOICE_IMAGES) {
                    return Promise.reject(new Error("Too many page images at once (" + iImages +
                        ", max " + MAX_INVOICE_IMAGES + ") - upload fewer documents per batch."));
                }

                return AiClient.extractLineItems(aSendable, aFields).then(function (oResult) {
                    var aRows = [];
                    var aUnreadable = aUnreadableUpfront.slice();
                    var iIndex = 0;

                    (oResult.documents || []).forEach(function (oDoc) {
                        // compact column-based reply (columns named once,
                        // one value-array per item) - cut the model's output
                        // tokens by ~60-70% on multi-item documents vs
                        // repeating every field name on every item. Mapped
                        // back to plain {Field: value} objects here. The old
                        // per-item "items" object shape is still accepted as
                        // a fallback in case the model ignores the format.
                        var aItems = [];
                        if (Array.isArray(oDoc.columns) && Array.isArray(oDoc.rows)) {
                            oDoc.rows.forEach(function (aValues) {
                                var oRow = {};
                                oDoc.columns.forEach(function (sColumn, i) {
                                    if (aValues[i] !== null && aValues[i] !== undefined) {
                                        oRow[sColumn] = aValues[i];
                                    }
                                });
                                aItems.push(oRow);
                            });
                        } else if (Array.isArray(oDoc.items)) {
                            aItems = oDoc.items;
                        }

                        if (oDoc.unreadable || !aItems.length) {
                            aUnreadable.push({ name: sourceNameOf(oDoc.name), message: oDoc.message || "No line items found.",
                                isPart: / \(part \d+\/\d+\)$/.test(oDoc.name || "") });
                            return;
                        }
                        aItems.forEach(function (oRawRow) {
                            // part suffix stripped: to the user it's one file
                            aRows.push(buildStagedRow(iIndex++, oRawRow, aFields, sourceNameOf(oDoc.name)));
                        });
                    });

                    Logger.step("BulkUpload", "read " + aRows.length + " line item(s) from " +
                        aSendable.length + " document(s), " + aUnreadable.length + " unreadable");
                    // a PART of a file that yielded no items is only worth
                    // reporting when NO part of that file yielded anything -
                    // a chunk boundary routinely leaves one part holding just
                    // tax tables and footers, and surfacing the model's
                    // "nothing new here" note for it read like a failure
                    // (confirmed live) when in fact every item was captured
                    var mSourcesWithRows = {};
                    aRows.forEach(function (oRow) { mSourcesWithRows[oRow.source] = true; });
                    aUnreadable = aUnreadable.filter(function (oEntry) {
                        if (oEntry.isPart && mSourcesWithRows[oEntry.name]) {
                            Logger.step("BulkUpload", "suppressed empty-part note for '" + oEntry.name + "'");
                            return false;
                        }
                        return true;
                    });

                    return { fields: aFields, rows: aRows, unreadable: aUnreadable };
                });
            });
        },

        /**
         * Builds the staging review table: one column per field plus a
         * status column, one editable row per staged record. Built fully in
         * JS (not XML binding) since the column count varies per entity -
         * the same "empty host, programmatic content" split ChartBuilder's
         * createFrame/ChatMixin._showChart already use for VizFrame.
         *
         * @param {object[]} aFields from parseUpload
         * @param {sap.ui.model.json.JSONModel} oReviewModel holds { rows: [...] } -
         *        the caller owns this model (e.g. to read it back for submitRows,
         *        and to recompute the "clean to submit" count for the submit button)
         * @returns {sap.m.Table}
         */
        /**
         * sap.ui.table.Table, not sap.m.Table - a deliberate choice: its
         * columns are genuinely user-resizable (drag the header border,
         * same as Excel) with no extra wiring, since that's a native
         * capability of sap.ui.table.Column, not something sap.m.Table's
         * columns support at all. Needs the sap.ui.table library declared
         * in the consuming app's manifest - see lib.js's patchManifest.
         */
        buildReviewTable: function (aFields, oReviewModel, bShowSource) {
            function recomputeRow(sRowPath) {
                var oRow = oReviewModel.getProperty(sRowPath);
                oRow.hasIssues = rowHasIssues(oRow.cells);
                oReviewModel.setProperty(sRowPath, oRow);
                oReviewModel.setProperty("/cleanCount", oReviewModel.getProperty("/rows")
                    .filter(function (r) { return !r.excluded && !r.hasIssues; }).length);
            }

            var oTable = new GridTable({
                visibleRowCount: 8,
                selectionMode: "None",
                enableColumnReordering: false
            });
            // addStyleClass, not a "class" constructor setting - that key is
            // not a real ManagedObject setting and is silently discarded in
            // JS (XML views special-case it; constructors do not)
            oTable.addStyleClass("novaBulkUploadGrid");

            oTable.addColumn(new GridColumn({
                label: new Text({ text: "" }),
                width: "3rem",
                resizable: false,
                template: new CheckBox({
                    selected: "{bulkUpload>excluded}",
                    tooltip: "Exclude this row from the create",
                    select: function (oEvent) {
                        var sPath = oEvent.getSource().getBindingContext("bulkUpload").getPath();
                        recomputeRow(sPath);
                    }
                })
            }));

            if (bShowSource) {
                oTable.addColumn(new GridColumn({
                    label: new Text({ text: "Source" }),
                    width: "9rem",
                    resizable: true,
                    template: new Text({ text: "{bulkUpload>source}" })
                }));
            }

            aFields.forEach(function (oField, i) {
                oTable.addColumn(new GridColumn({
                    label: new Text({ text: oField.label }),
                    width: "11rem",
                    resizable: true,
                    autoResizable: true,
                    template: new Input({
                        value: "{bulkUpload>cells/" + i + "/raw}",
                        valueState: {
                            path: "bulkUpload>cells/" + i + "/ok",
                            formatter: function (bOk) { return bOk === false ? "Error" : "None"; }
                        },
                        valueStateText: "{bulkUpload>cells/" + i + "/reason}",
                        change: function (oEvent) {
                            var oInput = oEvent.getSource();
                            var oCtx = oInput.getBindingContext("bulkUpload");
                            var sRowPath = oCtx.getPath();
                            var sCellPath = sRowPath + "/cells/" + i;
                            var oCoerced = coerceCell(oField, oEvent.getParameter("value"));
                            oReviewModel.setProperty(sCellPath, oCoerced);
                            recomputeRow(sRowPath);
                        }
                    })
                }));
            });

            oTable.addColumn(new GridColumn({
                label: new Text({ text: "Status" }),
                width: "10rem",
                resizable: true,
                template: new ObjectStatus({
                    text: {
                        path: "bulkUpload>hasIssues",
                        formatter: function (bHasIssues) { return bHasIssues ? "Needs attention" : "Understood"; }
                    },
                    state: {
                        path: "bulkUpload>hasIssues",
                        formatter: function (bHasIssues) { return bHasIssues ? "Error" : "Success"; }
                    },
                    icon: {
                        path: "bulkUpload>hasIssues",
                        formatter: function (bHasIssues) {
                            return bHasIssues ? "sap-icon://alert" : "sap-icon://accept";
                        }
                    }
                })
            }));

            // The caller is responsible for putting oReviewModel on an ancestor
            // (the dialog itself) as the "bulkUpload" named model, so both this
            // table and sibling controls (e.g. the footer's submit button and
            // its cleanCount-driven label) resolve it the same way.
            oTable.bindRows({ path: "bulkUpload>/rows" });
            return oTable;
        },

        /**
         * THE ONLY FUNCTION IN THIS ENTIRE FEATURE ALLOWED TO ACTUALLY WRITE
         * TO THE ODATA SERVICE. Must only ever be called from a direct,
         * explicit user button press - never from anywhere the AI's response
         * could reach. There is no "action" type in the AI's vocabulary that
         * leads here, and ActionApplier.js has no branch for it; this is a
         * structural guarantee, not a convention.
         *
         * Stages each non-excluded, issue-free row as a new pending OData
         * entry and submits them together in one batch.
         *
         * @param {sap.ui.model.odata.v2.ODataModel} oODataModel
         * @param {string} sEntitySet
         * @param {object[]} aFields
         * @param {object[]} aRows staged rows from the review model
         * @returns {Promise<{created: number}>}
         */
        submitRows: function (oODataModel, sEntitySet, aFields, aRows) {
            var aToCreate = (aRows || []).filter(function (oRow) {
                return !oRow.excluded && !oRow.hasIssues;
            });
            if (!aToCreate.length) {
                return Promise.reject(new Error("No clean rows to create."));
            }

            // All rows share one changeset - one atomic create, which is
            // the actually-intended semantics anyway. (The Content-ID
            // integer requirement some OData v2 backends have - confirmed
            // live against services.odata.org's Northwind demo service -
            // is handled once, globally, for every createEntry call the
            // whole app makes, by ODataBatchFix.js. Not duplicated here.)
            var sGroupId = "novaBulkCreate-" + Date.now();

            aToCreate.forEach(function (oRow) {
                var oProperties = {};
                aFields.forEach(function (oField, i) {
                    var oCell = oRow.cells[i];
                    if (oCell && oCell.value !== null && oCell.value !== undefined) {
                        oProperties[oField.name] = oCell.value;
                    }
                });
                oODataModel.createEntry("/" + sEntitySet, {
                    properties: oProperties,
                    groupId: sGroupId,
                    changeSetId: sGroupId
                });
            });

            Logger.step("BulkUpload", "submitting " + aToCreate.length + " record(s) - human-initiated");

            return new Promise(function (resolve, reject) {
                oODataModel.submitChanges({
                    groupId: sGroupId,
                    success: function (oData) {
                        var bHasErrors = oData && oData.__batchResponses && oData.__batchResponses.some(
                            function (oResponse) {
                                return oResponse.response && parseInt(oResponse.response.statusCode, 10) >= 300;
                            }
                        );
                        if (bHasErrors) {
                            reject(new Error("The service rejected one or more records - check them and try again."));
                            return;
                        }
                        resolve({ created: aToCreate.length });
                    },
                    error: function (oError) {
                        reject(new Error((oError && oError.message) || "The create request failed."));
                    }
                });
            });
        }
    };
});
