sap.ui.define([], function () {
    "use strict";

    /**
     * Lazy, cached <script> injection for the plain browser (UMD) builds
     * vendored under ./thirdparty/ - xlsx, jsPDF, pptxgenjs (+ its own JSZip
     * dependency) and html2canvas. This app has no bundler (classic UI5
     * `ui5 build`, not webpack), so an npm package.json dependency is only
     * ever reachable from the CAP backend's Node code - never from browser
     * code. These libraries are vendored as real files precisely so nothing
     * is fetched from a CDN at runtime, matching how every other asset in
     * this dock is shipped. Each script loads at most once and only when a
     * feature that actually needs it first asks for it.
     */
    var mLoading = {};

    /**
     * Every one of these libraries ships a UMD wrapper that checks for an
     * AMD loader (a global `define` with `.amd`) before falling back to
     * attaching itself to `window`. SAPUI5's own module system can leave
     * loader-like globals in place, which was enough to make jszip.min.js,
     * pptxgen.bundle.js, jspdf.umd.min.js and xlsx.full.min.js all silently
     * register as anonymous AMD modules instead of setting window.JSZip /
     * window.PptxGenJS / window.jspdf / window.XLSX - the scripts loaded
     * with no network error, they just never attached anything, so every
     * later `window.X` lookup was undefined. Hiding define/module/exports
     * for the narrow window around one script's load forces it down the
     * plain-global branch regardless of what's actually on the page -
     * the standard workaround for vendoring classic UMD builds.
     */
    function hideAmdGlobals() {
        var oSaved = { define: window.define, module: window.module, exports: window.exports };
        window.define = undefined;
        window.module = undefined;
        window.exports = undefined;
        return oSaved;
    }

    function restoreAmdGlobals(oSaved) {
        window.define = oSaved.define;
        window.module = oSaved.module;
        window.exports = oSaved.exports;
    }

    function loadScript(sFile, fnAlreadyPresent) {
        if (fnAlreadyPresent && fnAlreadyPresent()) {
            return Promise.resolve();
        }
        if (mLoading[sFile]) {
            return mLoading[sFile];
        }
        mLoading[sFile] = new Promise(function (resolve, reject) {
            var sUrl = sap.ui.require.toUrl("nova/copilot/thirdparty/" + sFile);
            var oScript = document.createElement("script");
            oScript.src = sUrl;
            oScript.dataset.novaCopilotVendor = sFile;

            var oSavedGlobals = hideAmdGlobals();
            oScript.onload = function () {
                restoreAmdGlobals(oSavedGlobals);
                resolve();
            };
            oScript.onerror = function () {
                restoreAmdGlobals(oSavedGlobals);
                delete mLoading[sFile];
                reject(new Error("could not load " + sFile));
            };
            document.head.appendChild(oScript);
        });
        return mLoading[sFile];
    }

    return {
        /** @returns {Promise<object>} resolves to the global XLSX object */
        loadXlsx: function () {
            return loadScript("xlsx.full.min.js", function () { return !!window.XLSX; })
                .then(function () { return window.XLSX; });
        },

        /** @returns {Promise<Function>} resolves to the jsPDF constructor */
        loadJsPdf: function () {
            return loadScript("jspdf.umd.min.js", function () {
                return !!(window.jspdf && window.jspdf.jsPDF);
            }).then(function () { return window.jspdf.jsPDF; });
        },

        /** @returns {Promise<Function>} resolves to the html2canvas function */
        loadHtml2Canvas: function () {
            return loadScript("html2canvas.min.js", function () { return !!window.html2canvas; })
                .then(function () { return window.html2canvas; });
        },

        /**
         * Mozilla's pdf.js (3.11.174, the last classic-UMD build - 4.x is
         * ESM-only and can't be vendored this way). Used to render a
         * scanned PDF's pages to images client-side so the model can OCR
         * them; its worker script must be pointed at the vendored copy or
         * it would try to fetch one from a CDN, which this app never does.
         * @returns {Promise<object>} resolves to the pdfjsLib global
         */
        loadPdfJs: function () {
            return loadScript("pdf.min.js", function () { return !!window.pdfjsLib; })
                .then(function () {
                    window.pdfjsLib.GlobalWorkerOptions.workerSrc =
                        sap.ui.require.toUrl("nova/copilot/thirdparty/pdf.worker.min.js");
                    return window.pdfjsLib;
                });
        },

        /**
         * pptxgenjs's own browser build expects a global JSZip to already
         * exist before it runs, so that loads first.
         * @returns {Promise<Function>} resolves to the PptxGenJS constructor
         */
        loadPptxGenJs: function () {
            return loadScript("jszip.min.js", function () { return !!window.JSZip; })
                .then(function () {
                    return loadScript("pptxgen.bundle.js", function () { return !!window.PptxGenJS; });
                })
                .then(function () { return window.PptxGenJS; });
        }
    };
});
