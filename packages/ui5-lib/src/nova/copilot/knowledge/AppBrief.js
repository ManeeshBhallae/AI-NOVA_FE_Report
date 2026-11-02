sap.ui.define([
    "../Logger"
], function (Logger) {
    "use strict";

    // The host app may drop a nova-brief.json next to its manifest to explain
    // what it is for in business terms. Metadata describes the shape of the
    // data; this describes why the app exists. Entirely optional.
    var BRIEF_FILE = "nova-brief.json";

    var oBrief = null;
    var sState = "missing";
    var oLoading = null;

    function briefUrl(oAppComponent) {
        var oApp = oAppComponent && oAppComponent.getManifestEntry
            ? oAppComponent.getManifestEntry("sap.app")
            : null;
        if (!oApp || !oApp.id) {
            return null;
        }
        return sap.ui.require.toUrl(oApp.id.replace(/\./g, "/") + "/" + BRIEF_FILE);
    }

    return {
        /**
         * Reads the brief once. A missing file is not an error - the component
         * simply works without it.
         *
         * @param {sap.ui.core.UIComponent} oAppComponent the application component
         * @returns {Promise} resolves when the attempt has finished
         */
        load: function (oAppComponent) {
            if (oLoading) {
                return oLoading;
            }

            var sUrl = briefUrl(oAppComponent);
            if (!sUrl) {
                sState = "missing";
                oLoading = Promise.resolve(null);
                return oLoading;
            }

            Logger.step("AppBrief", "looking for " + BRIEF_FILE);

            oLoading = fetch(sUrl).then(function (oResponse) {
                if (!oResponse.ok) {
                    sState = "missing";
                    Logger.step("AppBrief", "no brief supplied by this app (" + oResponse.status + ")");
                    return null;
                }
                return oResponse.json().then(function (oJson) {
                    oBrief = oJson;
                    sState = "ok";
                    Logger.step("AppBrief", "brief loaded", oJson);
                    return oJson;
                });
            }).catch(function (oError) {
                sState = "error";
                Logger.warn("AppBrief", "brief could not be read", oError.message);
                return null;
            });

            return oLoading;
        },

        get: function () {
            return oBrief;
        },

        /** A row for the knowledge strip, so a malformed brief is visible. */
        asSource: function () {
            if (sState === "ok") {
                var aKeys = Object.keys(oBrief || {});
                return {
                    id: "brief",
                    label: "Business brief",
                    status: "ok",
                    detail: aKeys.length + " section(s): " + aKeys.join(", "),
                    data: oBrief
                };
            }
            if (sState === "error") {
                return {
                    id: "brief",
                    label: "Business brief",
                    status: "error",
                    detail: BRIEF_FILE + " could not be read",
                    data: null
                };
            }
            return {
                id: "brief",
                label: "Business brief",
                status: "warn",
                detail: "no " + BRIEF_FILE + " supplied by this app",
                data: null
            };
        }
    };
});
