sap.ui.define([
    "sap/ui/core/mvc/ControllerExtension",
    "./ChatMixin",
    "./Logger"
], function (ControllerExtension, ChatMixin, Logger) {
    "use strict";

    /**
     * Whether the record is open for editing. The template exposes this in its
     * own "ui" model, but the property name and where the model hangs vary, so
     * several signals are tried and a visible Save button is used as the final
     * fallback - if the user can save, the record is editable.
     */
    function resolveEditState(oView) {
        var oUiModel = oView.getModel("ui");
        if (!oUiModel) {
            var oComponent = oView.getController() && oView.getController().getOwnerComponent
                ? oView.getController().getOwnerComponent()
                : null;
            oUiModel = oComponent && oComponent.getModel && oComponent.getModel("ui");
        }

        function flag() {
            for (var i = 0; i < arguments.length; i++) {
                var vValue = oUiModel && oUiModel.getProperty(arguments[i]);
                if (vValue !== undefined && vValue !== null) {
                    return !!vValue;
                }
            }
            return false;
        }

        var bEditable = flag("/editable", "/edit", "/isEditable");
        var bCreateMode = flag("/createMode", "/isCreateMode", "/draftStatus/createMode");

        if (!bEditable) {
            // a visible, enabled Save button means the form is live
            var oSave = ChatMixin.findControl(oView, function (oControl) {
                var sType = oControl.getMetadata && oControl.getMetadata().getName();
                return (sType === "sap.m.Button" || sType === "sap.m.OverflowToolbarButton") &&
                    oControl.getVisible && oControl.getVisible() &&
                    /save|apply/i.test((oControl.getText && oControl.getText()) || "");
            });
            if (oSave) {
                bEditable = true;
            }
        }

        Logger.step("ObjectPageExt", "edit state resolved", {
            editable: bEditable,
            createMode: bCreateMode,
            uiModelFound: !!oUiModel,
            uiModelData: oUiModel && oUiModel.getData ? oUiModel.getData() : null
        });

        return { editable: bEditable, createMode: bCreateMode };
    }

    // only ever expose the fields the floorplan already shows on screen
    function summariseRecord(oView, sEntitySet) {
        var oContext = oView.getBindingContext();
        if (!oContext) {
            return null;
        }
        var oObject = oContext.getObject();
        if (!oObject) {
            return null;
        }

        var oModel = oView.getModel();
        var aKeys = [];
        var oHeader = null;

        try {
            var oMetaModel = oModel.getMetaModel();
            var oEntitySet = oMetaModel.getODataEntitySet(sEntitySet);
            var oEntityType = oEntitySet && oMetaModel.getODataEntityType(oEntitySet.entityType);
            aKeys = (((oEntityType || {}).key || {}).propertyRef || []).map(function (oRef) {
                return oRef.name;
            });
            var oHeaderInfo = oEntityType && oEntityType["com.sap.vocabularies.UI.v1.HeaderInfo"];
            if (oHeaderInfo && oHeaderInfo.Title && oHeaderInfo.Title.Value) {
                oHeader = oHeaderInfo.Title.Value.Path;
            }
        } catch (oError) {
            aKeys = [];
        }

        var oRecord = {
            path: oContext.getPath(),
            keys: {}
        };
        aKeys.forEach(function (sKey) {
            oRecord.keys[sKey] = oObject[sKey];
        });
        if (oHeader && oObject[oHeader] !== undefined) {
            oRecord.title = oObject[oHeader];
        }
        return oRecord;
    }

    return ControllerExtension.extend("nova.copilot.ObjectPageExt", Object.assign({}, ChatMixin, {

        override: {
            onInit: function () {
                this._initChatModel();
            },
            onAfterRendering: function () {
                this._ensureChatUi();
                // the list report may have queued an edit + fill before sending
                // us here; this runs again after the edit-mode re-render
                this._resumePending();
            }
        },

        /**
         * Describes an object-page surrounding: one open record, no filter bar.
         * The entity set is taken from the view's own binding, so this works for
         * whatever entity the host app happens to show.
         */
        _getPageInfo: function () {
            var oView = this.base.getView();
            var oComponent = oView.getController() && oView.getController().getOwnerComponent
                ? oView.getController().getOwnerComponent()
                : null;
            var sEntitySet = oComponent && oComponent.getEntitySet && oComponent.getEntitySet();

            if (!sEntitySet) {
                var oContext = oView.getBindingContext();
                var sPath = oContext && oContext.getPath();
                // "/EntitySet(key)" -> "EntitySet"
                sEntitySet = sPath ? sPath.replace(/^\//, "").split("(")[0] : undefined;
            }

            var oEditState = resolveEditState(oView);

            return {
                pageType: "ObjectPage",
                entitySet: sEntitySet,
                table: ChatMixin.findControlByType(oView, "sap.ui.comp.smarttable.SmartTable"),
                filterBar: null,
                record: summariseRecord(oView, sEntitySet),
                editable: oEditState.editable,
                createMode: oEditState.createMode,
                bindingContext: oView.getBindingContext()
            };
        }
    }));
});
