sap.ui.define([
    "sap/ui/core/mvc/ControllerExtension",
    "./ChatMixin"
], function (ControllerExtension, ChatMixin) {
    "use strict";

    return ControllerExtension.extend("nova.copilot.ListReportExt", Object.assign({}, ChatMixin, {

        override: {
            onInit: function () {
                this._initChatModel();
            },
            // the manifest's declarative Actions "press" binding does not reach this
            // controller extension on this template version, so the handler is
            // wired directly to the button control instead, once it exists.
            onAfterRendering: function () {
                this._ensureChatUi();
                // a sort or filter may have been queued before navigating back
                this._resumePending();
            }
        },

        /**
         * Describes a list-report surrounding: a filter bar and a table, no
         * single open record.
         */
        _getPageInfo: function () {
            var oView = this.base.getView();
            var oTable = ChatMixin.findControlByType(oView, "sap.ui.comp.smarttable.SmartTable");
            var oFilterBar = oView.byId("listReportFilter") ||
                ChatMixin.findControlByType(oView, "sap.ui.comp.smartfilterbar.SmartFilterBar");

            return {
                pageType: "ListReport",
                entitySet: oTable && oTable.getEntitySet && oTable.getEntitySet(),
                table: oTable,
                filterBar: oFilterBar,
                record: null
            };
        }
    }));
});
