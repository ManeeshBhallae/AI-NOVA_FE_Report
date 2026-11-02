sap.ui.define([
    "sap/ui/model/Filter",
    "sap/ui/model/FilterOperator",
    "sap/ui/model/Sorter",
    "./Logger"
], function (Filter, FilterOperator, Sorter, Logger) {
    "use strict";

    // hard ceiling regardless of what the model asks for
    var MAX_ROWS = 50;

    var OPERATORS = {
        EQ: FilterOperator.EQ,
        NE: FilterOperator.NE,
        GT: FilterOperator.GT,
        GE: FilterOperator.GE,
        LT: FilterOperator.LT,
        LE: FilterOperator.LE,
        BT: FilterOperator.BT,
        Contains: FilterOperator.Contains,
        StartsWith: FilterOperator.StartsWith
    };

    /** Reads "Supplier/CompanyName" out of an expanded response row. */
    function valueAt(oRow, sPath) {
        return String(sPath).split("/").reduce(function (vCurrent, sPart) {
            return (vCurrent === null || vCurrent === undefined) ? undefined : vCurrent[sPart];
        }, oRow);
    }

    function fieldIndex(oEntityMeta) {
        var mFields = {};
        ((oEntityMeta && oEntityMeta.properties) || []).forEach(function (oProp) {
            mFields[oProp.name] = oProp;
        });
        return mFields;
    }

    // OData wants numbers as numbers and booleans as booleans, but the model
    // hands everything over as text
    function coerce(oProperty, vValue) {
        var sType = (oProperty && oProperty.type) || "";
        if (/Edm\.(Int|Decimal|Double|Single|Byte)/.test(sType)) {
            var fNumber = parseFloat(vValue);
            return isNaN(fNumber) ? vValue : fNumber;
        }
        if (sType === "Edm.Boolean") {
            return vValue === true || String(vValue).toLowerCase() === "true";
        }
        return vValue;
    }

    return {
        valueAt: valueAt,

        /**
         * Runs a model-described query against the OData service and returns the
         * rows. The service does the selecting and sorting, so values are read
         * from the system of record rather than recalled or inferred - and the
         * rows never have to be shown to the model at all.
         *
         * @param {object} oQuery { select, filters, orderby, top } as described by the model
         * @param {object} mParams
         * @param {sap.ui.model.odata.v2.ODataModel} mParams.model
         * @param {string} mParams.entitySet
         * @param {object} mParams.entityMeta used to validate every field name
         * @returns {Promise<{rows: object[], dropped: string[], select: string[]}>}
         */
        run: function (oQuery, mParams) {
            var mFields = fieldIndex(mParams.entityMeta);
            var aDropped = [];

            function isKnown(sField) {
                if (mFields[sField]) {
                    return true;
                }
                // "Supplier/CompanyName" is legitimate - verify it through the metamodel
                if (String(sField).indexOf("/") !== -1 && mParams.model && mParams.model.getMetaModel) {
                    try {
                        var oMetaModel = mParams.model.getMetaModel();
                        var oEntitySet = oMetaModel.getODataEntitySet(mParams.entitySet);
                        var oType = oEntitySet && oMetaModel.getODataEntityType(oEntitySet.entityType);
                        var aParts = String(sField).split("/");
                        for (var i = 0; i < aParts.length - 1 && oType; i++) {
                            var oEnd = oMetaModel.getODataAssociationEnd(oType, aParts[i]);
                            oType = oEnd && oMetaModel.getODataEntityType(oEnd.type);
                        }
                        var sLeaf = aParts[aParts.length - 1];
                        if (oType && (oType.property || []).some(function (oProp) {
                            return oProp.name === sLeaf;
                        })) {
                            return true;
                        }
                    } catch (oError) {
                        // fall through and drop it
                    }
                }
                aDropped.push(sField);
                Logger.warn("DataQuery", "dropped unknown field '" + sField + "'");
                return false;
            }

            var aSelect = ((oQuery && oQuery.select) || []).filter(isKnown);

            var aFilters = ((oQuery && oQuery.filters) || []).filter(function (oFilter) {
                if (!oFilter || !isKnown(oFilter.field) || !OPERATORS[oFilter.op]) {
                    return false;
                }
                // "FieldA LE FieldB" compares two fields, which OData
                // V2 cannot express - passing a field name as a value blows up in
                // type conversion, so reject it with something readable instead
                var oProp = mFields[oFilter.field];
                var bNumericField = /Edm\.(Int|Decimal|Double|Single|Byte)/.test((oProp && oProp.type) || "");
                if (bNumericField && oFilter.value !== "" && isNaN(parseFloat(oFilter.value))) {
                    aDropped.push(oFilter.field);
                    Logger.warn("DataQuery", "'" + oFilter.value + "' is not a number for " + oFilter.field);
                    return false;
                }
                if (mFields[oFilter.value]) {
                    aDropped.push(oFilter.field);
                    Logger.warn("DataQuery", "cannot compare two fields: " +
                        oFilter.field + " " + oFilter.op + " " + oFilter.value);
                    return false;
                }
                return true;
            }).map(function (oFilter) {
                var oProperty = mFields[oFilter.field];
                return new Filter({
                    path: oFilter.field,
                    operator: OPERATORS[oFilter.op],
                    value1: coerce(oProperty, oFilter.value),
                    value2: oFilter.value2 === undefined ? undefined : coerce(oProperty, oFilter.value2)
                });
            });

            // whatever the user has narrowed the screen to must apply here too,
            // otherwise a chart or lookup silently reports on the whole table
            var aScreenFilters = mParams.screenFilters || [];
            if (aScreenFilters.length) {
                aFilters = aFilters.concat(aScreenFilters);
                Logger.step("DataQuery", "including " + aScreenFilters.length +
                    " filter(s) already active on screen");
            }

            var aSorters = [];
            var oOrder = oQuery && oQuery.orderby;
            if (oOrder && isKnown(oOrder.field)) {
                aSorters.push(new Sorter(oOrder.field, oOrder.direction === "desc"));
            }

            // charts legitimately need more rows than a chat answer does
            var iCap = parseInt(mParams.maxRows, 10) || MAX_ROWS;
            var iTop = Math.min(parseInt(oQuery && oQuery.top, 10) || 10, iCap);

            var mUrlParameters = { $top: iTop };
            if (aSelect.length) {
                mUrlParameters.$select = aSelect.join(",");

                // a field behind an association needs its navigation expanded
                var mExpand = {};
                aSelect.forEach(function (sField) {
                    var aParts = sField.split("/");
                    if (aParts.length > 1) {
                        mExpand[aParts.slice(0, -1).join("/")] = true;
                    }
                });
                var aExpand = Object.keys(mExpand);
                if (aExpand.length) {
                    mUrlParameters.$expand = aExpand.join(",");
                }
            }

            Logger.step("DataQuery", "reading /" + mParams.entitySet + " from the service", {
                select: aSelect,
                filters: aFilters.length,
                orderby: oOrder,
                top: iTop
            });

            return new Promise(function (resolve, reject) {
                mParams.model.read("/" + mParams.entitySet, {
                    filters: aFilters,
                    sorters: aSorters,
                    urlParameters: mUrlParameters,
                    success: function (oData) {
                        var aRows = (oData && oData.results) || [];
                        Logger.step("DataQuery", "service returned " + aRows.length + " row(s)");
                        resolve({ rows: aRows, dropped: aDropped, select: aSelect });
                    },
                    error: function (oError) {
                        Logger.error("DataQuery", "service read failed", oError && oError.message);
                        reject(new Error("The query could not be run against the service."));
                    }
                });
            });
        },

        /**
         * Turns result rows into bullet lines. Built here from the actual
         * response, so every value shown came from the service.
         */
        toBullets: function (aRows, aSelect, oEntityMeta) {
            var aFields = aSelect && aSelect.length
                ? aSelect
                : ((oEntityMeta && oEntityMeta.lineItemFields) || []).slice(0, 4);

            return aRows.map(function (oRow) {
                var aParts = aFields.map(function (sField) {
                    var vValue = valueAt(oRow, sField);
                    return sField + ": " + (vValue === undefined ? "-" : vValue);
                });
                return aParts.join(" · ");
            });
        }
    };
});
