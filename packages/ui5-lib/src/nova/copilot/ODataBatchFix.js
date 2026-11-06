sap.ui.define([
    "sap/ui/model/odata/v2/ODataModel",
    "./Logger"
], function (ODataModel, Logger) {
    "use strict";

    var bPatched = false;
    var iCounter = 0;

    return {
        /**
         * sap.ui.model.odata.v2.ODataModel ALWAYS assigns
         * "Content-ID: uid()" (something like "id-<timestamp>-<n>") to
         * every batched write request, unless the caller already supplied
         * one - confirmed by reading ODataModel.js's own source directly
         * (the assignment lives in the internal _createRequest). Most
         * OData v2 backends accept any string there, but some - confirmed
         * live, repeatedly, against services.odata.org's Northwind demo
         * service - validate strictly per the OData v2 spec (Content-ID
         * must be an integer) and reject anything else outright. That
         * breaks EVERY create in the app this way, including the
         * standard Fiori Elements "+ New" button - nothing nova-copilot
         * added, a pre-existing incompatibility between plain UI5 behavior
         * and this specific backend.
         *
         * Fixed by wrapping the PUBLIC createEntry API - not the "_"-
         * prefixed internal method the real assignment happens in, which
         * carries real forward-compatibility risk since it's explicitly
         * marked internal/unstable - to always supply a real integer up
         * front. One small, idempotent patch applied once at startup fixes
         * every create path uniformly, rather than needing a workaround in
         * each one separately.
         */
        apply: function () {
            if (bPatched) {
                return;
            }
            bPatched = true;

            var fnOriginalCreateEntry = ODataModel.prototype.createEntry;
            ODataModel.prototype.createEntry = function (sPath, mParameters) {
                var mParams = mParameters || {};
                var mHeaders = mParams.headers || {};
                if (!mHeaders["Content-ID"]) {
                    mHeaders = Object.assign({}, mHeaders, { "Content-ID": String(++iCounter) });
                    mParams = Object.assign({}, mParams, { headers: mHeaders });
                }
                return fnOriginalCreateEntry.call(this, sPath, mParams);
            };

            Logger.step("ODataBatchFix", "patched ODataModel#createEntry to always supply an integer Content-ID");
        }
    };
});
