sap.ui.define([
    "./Logger"
], function (Logger) {
    "use strict";

    var VALID_OPS = ["EQ", "NE", "GT", "GE", "LT", "LE", "BT", "Contains", "StartsWith"];

    function getValidFieldNames(oEntityMeta) {
        return ((oEntityMeta && oEntityMeta.properties) || []).map(function (oProp) {
            return oProp.name;
        });
    }

    // Common ways a model might phrase a boolean rather than the literal
    // "true"/"false" the control actually needs - a string like "active"
    // reaching setFilterData for an Edm.Boolean field was going straight
    // through unnormalized, which the control can't coerce (confirmed as
    // one of the two concrete "unknown value" failure modes reported live).
    var TRUE_WORDS = ["true", "yes", "y", "1", "active", "x", "discontinued"];
    var FALSE_WORDS = ["false", "no", "n", "0", "inactive"];

    function normalizeBoolean(vValue) {
        var sValue = String(vValue).trim().toLowerCase();
        if (TRUE_WORDS.indexOf(sValue) !== -1) {
            return "true";
        }
        if (FALSE_WORDS.indexOf(sValue) !== -1) {
            return "false";
        }
        return null;
    }

    /** @returns {{ok:true,value:string}|{ok:false,reason:string}} */
    function validateValue(oProperty, vValue, sWhich) {
        var sType = (oProperty && oProperty.type) || "";
        if (/Edm\.(Int|Decimal|Double|Single|Byte)/.test(sType)) {
            if (vValue !== "" && vValue !== undefined && isNaN(parseFloat(vValue))) {
                return { ok: false, reason: "'" + vValue + "' is not a number (" + sWhich + ")" };
            }
            return { ok: true, value: vValue };
        }
        if (sType === "Edm.Boolean") {
            var sNormalized = normalizeBoolean(vValue);
            if (sNormalized === null) {
                return { ok: false, reason: "'" + vValue + "' is not yes/no (" + sWhich + ")" };
            }
            return { ok: true, value: sNormalized };
        }
        return { ok: true, value: vValue };
    }

    var FIELD_COMPARE_OPS = ["EQ", "NE", "GT", "GE", "LT", "LE"];

    /**
     * Splits out "compare this field to another field" requests (only
     * meaningful when the model was told dataConsent is true - see
     * prompt.js) from ordinary literal-value filters. These can't be
     * resolved here - buildFilterData has no access to actual row data,
     * by design - so they're returned separately for the caller
     * (ChatMixin._resolveFieldCompareFilters) to turn into real, literal
     * id-based filters via an actual query. The AI only ever chose WHICH
     * comparison to make; it never sees or states which rows match it.
     *
     * @returns {{rangeData: object, fieldFilters: object[]}}
     */
    function buildFilterData(aFilters, aValidFields, aDropped, mFieldTypes) {
        var oData = {};
        var aFieldFilters = [];
        (aFilters || []).forEach(function (oFilter) {
            var sField = oFilter.field;
            if (aValidFields.indexOf(sField) === -1) {
                aDropped.push(sField);
                Logger.warn("ActionApplier", "dropped unknown field '" + sField + "'", {
                    knownFields: aValidFields
                });
                return;
            }

            if (oFilter.valueIsField) {
                var sCompareField = oFilter.value;
                if (aValidFields.indexOf(sCompareField) === -1) {
                    aDropped.push(sField + " (compared to unknown field '" + sCompareField + "')");
                    Logger.warn("ActionApplier", "field-compare target '" + sCompareField + "' is unknown");
                    return;
                }
                var sCompareOp = FIELD_COMPARE_OPS.indexOf(oFilter.op) !== -1 ? oFilter.op : "LE";
                aFieldFilters.push({ field: sField, compareField: sCompareField, op: sCompareOp });
                return;
            }

            var oProperty = mFieldTypes[sField];
            var sOp = VALID_OPS.indexOf(oFilter.op) !== -1 ? oFilter.op : "EQ";
            if (sOp !== oFilter.op) {
                Logger.warn("ActionApplier", "unsupported operator '" + oFilter.op + "' on " +
                    sField + ", falling back to EQ");
            }

            var oValue1 = validateValue(oProperty, oFilter.value, "value");
            if (!oValue1.ok) {
                aDropped.push(sField);
                Logger.warn("ActionApplier", oValue1.reason + " for " + sField);
                return;
            }

            // BT (between) is the one operator that needs a second bound -
            // previously neither its presence nor its type were checked at
            // all, so a missing or non-numeric upper bound sailed straight
            // into a malformed range (the other concrete "unknown value"/
            // broken-query failure mode reported live). Rather than send a
            // half-valid range, fall back to a plain "at least value1"
            // (GE) - still useful, and never a broken query - and say so.
            var sValue2 = oFilter.value2;
            if (sOp === "BT") {
                var oValue2 = sValue2 !== undefined && sValue2 !== ""
                    ? validateValue(oProperty, sValue2, "upper bound")
                    : { ok: false, reason: "no upper bound given" };
                if (!oValue2.ok) {
                    Logger.warn("ActionApplier", "BT on " + sField + " " + oValue2.reason +
                        " - using 'at least' instead");
                    sOp = "GE";
                    sValue2 = "";
                } else {
                    sValue2 = oValue2.value;
                }
            }

            if (!oData[sField]) {
                oData[sField] = { ranges: [], items: [] };
            }
            oData[sField].ranges.push({
                exclude: false,
                operation: sOp,
                value1: oValue1.value,
                value2: sValue2 || "",
                keyField: sField
            });
        });
        return { rangeData: oData, fieldFilters: aFieldFilters };
    }

    return {
        /**
         * @param {object} oAction parsed AI response: { action, filters, message }
         * @param {object} mParams
         * @param {sap.ui.comp.smartfilterbar.SmartFilterBar} [mParams.filterBar]
         * @param {object} mParams.entityMeta entity metadata from ContextCollector (for field validation)
         * @param {function(string, string[])} mParams.showMessage callback to display a message,
         *        optionally with a list of bullet points, to the user
         */
        apply: function (oAction, mParams) {
            var oSmartFilterBar = mParams.filterBar;
            var fnRaw = mParams.showMessage || function () {};
            // carry the structured bullets through alongside the lead sentence
            var fnShowMessage = function (sText) {
                fnRaw(sText, (oAction && oAction.bullets) || [], oAction && oAction.basis,
                    (oAction && oAction.prompts) || []);
            };

            if (!oAction || !oAction.action) {
                // A reply with real content (message/prompts/bullets) but no
                // "action" key is the model answering - e.g. a suggestions
                // request - just without the field it should have set. Showing
                // the actual content beats a flat "I didn't understand that."
                // when there plainly was an understood answer attached.
                var bHasContent = oAction && (oAction.message ||
                    (oAction.prompts && oAction.prompts.length) ||
                    (oAction.bullets && oAction.bullets.length));
                fnShowMessage(bHasContent ? (oAction.message || "") : "I didn't understand that.");
                return;
            }

            Logger.step("ActionApplier", "applying action '" + oAction.action + "'");

            if (oAction.action === "clear") {
                if (oSmartFilterBar) {
                    Logger.step("ActionApplier", "clearing filter bar and re-running search");
                    oSmartFilterBar.clear();
                    oSmartFilterBar.search();
                }
                fnShowMessage(oAction.message || "Filters cleared.");
                return;
            }

            if (oAction.action === "answer") {
                fnShowMessage(oAction.message || "");
                return;
            }

            if (oAction.action === "filter") {
                var aValidFields = getValidFieldNames(mParams.entityMeta);
                var aDropped = [];
                var mFieldTypes = {};
                ((mParams.entityMeta && mParams.entityMeta.properties) || []).forEach(function (oProp) {
                    mFieldTypes[oProp.name] = oProp;
                });
                var oBuilt = buildFilterData(oAction.filters, aValidFields, aDropped, mFieldTypes);
                var oNewFilterData = oBuilt.rangeData;
                // By the time a filter action reaches here, field-compare
                // entries are expected to have already been resolved into
                // plain literal filters by the caller (ChatMixin -
                // _resolveFieldCompareFilters, using a real query, never
                // this module, which has no access to row data at all).
                // Anything still carrying valueIsField this late didn't go
                // through that resolution for some reason - dropped and
                // reported rather than silently ignored or, worse, sent to
                // the filter bar unresolved.
                oBuilt.fieldFilters.forEach(function (oFieldFilter) {
                    aDropped.push(oFieldFilter.field + " (needs resolving before it can be applied)");
                });

                var bFilterFailed = false;
                if (oSmartFilterBar) {
                    // The model is instructed (see prompt.js) to restate its full
                    // desired filter set each turn, including anything already
                    // active - this merge is the safety net for when it doesn't:
                    // fields it restated win, fields it left out survive from
                    // whatever's currently on the filter bar, rather than every
                    // filter turn wiping the bar back to blank first.
                    var oCurrentFilterData = oSmartFilterBar.getFilterData() || {};
                    var oFilterData = Object.assign({}, oCurrentFilterData, oNewFilterData);
                    Logger.step("ActionApplier", "setting filter data on the SmartFilterBar", oFilterData);
                    // validateValue/buildFilterData catch the known failure
                    // shapes (unknown field, bad number, bad boolean,
                    // malformed BT), but this is the backstop for anything
                    // else - the filter bar's own internals throwing on some
                    // value combination we didn't anticipate should never
                    // surface as an uncaught error breaking the chat.
                    try {
                        oSmartFilterBar.setFilterData(oFilterData, true);
                        oSmartFilterBar.search();
                        Logger.step("ActionApplier", "search triggered");
                    } catch (oError) {
                        bFilterFailed = true;
                        Logger.error("ActionApplier", "applying the filter failed", oError.message);
                    }
                } else {
                    Logger.warn("ActionApplier", "no SmartFilterBar on this page - filter not applied");
                }

                var sMessage;
                if (bFilterFailed) {
                    sMessage = "I couldn't apply that filter - the screen's filters are unchanged.";
                } else {
                    sMessage = oAction.message || "Filters applied.";
                    if (aDropped.length) {
                        sMessage += " (Ignored unknown or invalid value for: " + aDropped.join(", ") + ")";
                    }
                }
                fnShowMessage(sMessage);
                return;
            }

            fnShowMessage("Unknown action: " + oAction.action);
        }
    };
});
