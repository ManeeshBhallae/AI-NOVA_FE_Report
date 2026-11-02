sap.ui.define([
    "./Logger"
], function (Logger) {
    "use strict";

    function getEntityMetadata(oODataModel, sEntitySet) {
        if (!oODataModel || !sEntitySet) {
            return { entitySet: sEntitySet, entityType: null, properties: [], lineItemFields: [] };
        }
        var oMetaModel = oODataModel.getMetaModel();
        var oEntitySet = oMetaModel.getODataEntitySet(sEntitySet);
        var oEntityType = oEntitySet && oMetaModel.getODataEntityType(oEntitySet.entityType);

        var aProperties = ((oEntityType && oEntityType.property) || []).map(function (oProp) {
            return {
                name: oProp.name,
                type: oProp.type,
                label: oProp["sap:label"] || oProp.name,
                filterable: oProp["sap:filterable"] !== "false"
            };
        });

        var aLineItem = ((oEntityType && oEntityType["com.sap.vocabularies.UI.v1.LineItem"]) || [])
            .map(function (oField) {
                return oField.Value && oField.Value.Path;
            })
            .filter(Boolean);

        return {
            entitySet: sEntitySet,
            entityType: oEntitySet && oEntitySet.entityType,
            properties: aProperties,
            lineItemFields: aLineItem
        };
    }

    function getFilterData(oSmartFilterBar) {
        if (!oSmartFilterBar || !oSmartFilterBar.getFilterData) {
            return {};
        }
        var oRaw;
        try {
            oRaw = oSmartFilterBar.getFilterData() || {};
        } catch (oError) {
            return {};
        }
        // drop template-internal bookkeeping such as _CUSTOM, which carries no
        // user filter state and only adds noise to the prompt
        var oClean = {};
        Object.keys(oRaw).forEach(function (sKey) {
            if (sKey.charAt(0) !== "_") {
                oClean[sKey] = oRaw[sKey];
            }
        });
        return oClean;
    }

    function getTableBinding(oTable) {
        if (!oTable) {
            return null;
        }
        var oInnerTable = oTable.getTable ? oTable.getTable() : oTable;
        if (!oInnerTable || !oInnerTable.getBinding) {
            return null;
        }
        return oInnerTable.getBinding("items") || oInnerTable.getBinding("rows") || null;
    }

    function getVisibleRowCount(oTable) {
        var oBinding = getTableBinding(oTable);
        if (!oBinding) {
            return 0;
        }
        return (oBinding.getLength && oBinding.getLength()) || 0;
    }

    return {
        /**
         * Record values are never included - only the shape of the data and how
         * many records there are. Anything needing real values goes through a
         * service query instead, so business data never reaches the model.
         *
         * @param {object} mParams
         * @param {sap.ui.core.UIComponent} mParams.component owner component
         * @param {sap.ui.model.odata.v2.ODataModel} mParams.model OData model
         * @param {string} mParams.entitySet main entity set name
         * @param {sap.ui.comp.smartfilterbar.SmartFilterBar} [mParams.filterBar]
         * @param {sap.ui.comp.smarttable.SmartTable} [mParams.table]
         */
        collect: function (mParams) {
            var oComponent = mParams.component;
            var oManifestApp = (oComponent && oComponent.getManifestEntry && oComponent.getManifestEntry("sap.app")) || {};
            var oEntityMeta = getEntityMetadata(mParams.model, mParams.entitySet);

            var oContext = {
                app: {
                    id: oManifestApp.id,
                    title: oManifestApp.title
                },
                entity: oEntityMeta,
                filters: getFilterData(mParams.filterBar),
                visibleRowCount: getVisibleRowCount(mParams.table)
            };

            Logger.step("ContextCollector", "metadata only - no record values leave the app", {
                entitySet: mParams.entitySet,
                visibleRowCount: oContext.visibleRowCount,
                activeFilters: Object.keys(oContext.filters || {})
            });

            return oContext;
        }
    };
});
