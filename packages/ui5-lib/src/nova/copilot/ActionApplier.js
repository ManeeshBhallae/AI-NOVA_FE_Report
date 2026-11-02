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

    function buildFilterData(aFilters, aValidFields, aDropped, mFieldTypes) {
        var oData = {};
        (aFilters || []).forEach(function (oFilter) {
            var sField = oFilter.field;
            if (aValidFields.indexOf(sField) === -1) {
                aDropped.push(sField);
                Logger.warn("ActionApplier", "dropped unknown field '" + sField + "'", {
                    knownFields: aValidFields
                });
                return;
            }
            // a word against a numeric field - usually a name used where an id
            // belongs - would fail type conversion inside the control
            var oProperty = mFieldTypes[sField];
            var bNumeric = /Edm\.(Int|Decimal|Double|Single|Byte)/.test((oProperty && oProperty.type) || "");
            if (bNumeric && oFilter.value !== "" && isNaN(parseFloat(oFilter.value))) {
                aDropped.push(sField);
                Logger.warn("ActionApplier", "'" + oFilter.value + "' is not a number for " + sField);
                return;
            }

            var sOp = VALID_OPS.indexOf(oFilter.op) !== -1 ? oFilter.op : "EQ";
            if (sOp !== oFilter.op) {
                Logger.warn("ActionApplier", "unsupported operator '" + oFilter.op + "' on " +
                    sField + ", falling back to EQ");
            }
            if (!oData[sField]) {
                oData[sField] = { ranges: [], items: [] };
            }
            oData[sField].ranges.push({
                exclude: false,
                operation: sOp,
                value1: oFilter.value,
                value2: oFilter.value2 || "",
                keyField: sField
            });
        });
        return oData;
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
                fnShowMessage("I didn't understand that.");
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
                var oFilterData = buildFilterData(oAction.filters, aValidFields, aDropped, mFieldTypes);

                if (oSmartFilterBar) {
                    Logger.step("ActionApplier", "setting filter data on the SmartFilterBar", oFilterData);
                    oSmartFilterBar.setFilterData(oFilterData, true);
                    oSmartFilterBar.search();
                    Logger.step("ActionApplier", "search triggered");
                } else {
                    Logger.warn("ActionApplier", "no SmartFilterBar on this page - filter not applied");
                }

                var sMessage = oAction.message || "Filters applied.";
                if (aDropped.length) {
                    sMessage += " (Ignored unknown field(s): " + aDropped.join(", ") + ")";
                }
                fnShowMessage(sMessage);
                return;
            }

            fnShowMessage("Unknown action: " + oAction.action);
        }
    };
});
