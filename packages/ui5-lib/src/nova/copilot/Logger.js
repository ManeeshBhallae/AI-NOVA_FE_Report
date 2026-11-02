sap.ui.define([], function () {
    "use strict";

    // Silence the trace with:  localStorage.setItem("nova.trace", "off")
    // Turn it back on with:    localStorage.removeItem("nova.trace")
    function isEnabled() {
        try {
            return window.localStorage.getItem("nova.trace") !== "off";
        } catch (oError) {
            return true;
        }
    }

    var STYLE = "color:#4a5fd4;font-weight:600";

    function emit(sMethod, sArea, sMessage, vDetail) {
        if (!isEnabled()) {
            return;
        }
        var sLabel = "%c[Nova] " + sArea + " › " + sMessage;
        if (vDetail === undefined) {
            // eslint-disable-next-line no-console
            console[sMethod](sLabel, STYLE);
        } else {
            // eslint-disable-next-line no-console
            console[sMethod](sLabel, STYLE, vDetail);
        }
    }

    return {
        /** A step the component took, with optional detail. */
        step: function (sArea, sMessage, vDetail) {
            emit("log", sArea, sMessage, vDetail);
        },

        /** Something unexpected but survivable. */
        warn: function (sArea, sMessage, vDetail) {
            emit("warn", sArea, sMessage, vDetail);
        },

        /** Something that stopped a step from completing. */
        error: function (sArea, sMessage, vDetail) {
            emit("error", sArea, sMessage, vDetail);
        },

        /** Times a step and logs how long it took. */
        time: function (sArea, sMessage, oPromise) {
            var iStart = Date.now();
            return oPromise.then(function (vResult) {
                emit("log", sArea, sMessage + " finished in " + (Date.now() - iStart) + "ms");
                return vResult;
            }, function (oError) {
                emit("error", sArea, sMessage + " failed after " + (Date.now() - iStart) + "ms", oError.message);
                throw oError;
            });
        },

        isEnabled: isEnabled
    };
});
