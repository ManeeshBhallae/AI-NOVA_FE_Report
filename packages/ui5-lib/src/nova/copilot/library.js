/*!
 * Nova Copilot - reusable AI dock for Fiori Elements V2 apps
 */
sap.ui.define([
    "sap/ui/core/Core"
], function (Core) {
    "use strict";

    /**
     * Nova Copilot library. Declaring it registers the "nova.copilot"
     * namespace with UI5 so controller extensions, fragments and the
     * library's own resource bundle resolve the same way any other UI5
     * library's do inside a host app.
     */
    sap.ui.getCore().initLibrary({
        name: "nova.copilot",
        version: "0.1.0",
        dependencies: [
            "sap.ui.core",
            "sap.m",
            "sap.ui.comp",
            "sap.ui.generic.app",
            "sap.suite.ui.generic.template",
            "sap.viz",
            "sap.ui.unified"
        ],
        types: [],
        interfaces: [],
        controls: [],
        elements: [],
        noLibraryCSS: true
    });

    return sap.ui.getCore().getLoadedLibraries()["nova.copilot"];
});
