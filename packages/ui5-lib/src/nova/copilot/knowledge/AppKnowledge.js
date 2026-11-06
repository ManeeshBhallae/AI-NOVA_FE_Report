sap.ui.define([
    "sap/ui/core/Component",
    "./AppBrief",
    "../Logger"
], function (Component, AppBrief, Logger) {
    "use strict";

    var UI_NS = "com.sap.vocabularies.UI.v1.";
    var COMMON_NS = "com.sap.vocabularies.Common.v1.";

    // assembled once per entity set - manifest, metadata and annotations do not
    // change while the app is running, but each page has its own entity
    var mCache = {};

    /**
     * A Fiori Elements view is owned by the TEMPLATE component (ListReport,
     * ObjectPage, ...), whose descriptor knows nothing about the host app.
     * Walk up the owner chain to the component whose sap.app.type is
     * "application" - that is the one carrying the real manifest.
     */
    function resolveAppComponent(oComponent) {
        var oCurrent = oComponent;
        var iGuard = 0;
        while (oCurrent && iGuard < 10) {
            iGuard++;
            try {
                var oApp = oCurrent.getManifestEntry && oCurrent.getManifestEntry("sap.app");
                if (oApp && oApp.type === "application") {
                    return oCurrent;
                }
            } catch (oError) {
                // keep walking
            }
            var oOwner = Component.getOwnerComponentFor(oCurrent);
            if (!oOwner || oOwner === oCurrent) {
                break;
            }
            oCurrent = oOwner;
        }
        return oComponent;
    }

    function source(sId, sLabel, sStatus, sDetail, oData) {
        return { id: sId, label: sLabel, status: sStatus, detail: sDetail, data: oData || null };
    }

    /**
     * App identity and declared models, straight from the descriptor.
     */
    function collectApp(oComponent) {
        if (!oComponent || !oComponent.getManifestEntry) {
            return source("app", "App manifest", "error", "Component not available");
        }
        var oApp = oComponent.getManifestEntry("sap.app") || {};
        var oUi5 = oComponent.getManifestEntry("sap.ui5") || {};
        var aDataSources = Object.keys(oApp.dataSources || {});

        var oData = {
            id: oApp.id,
            title: oApp.title,
            description: oApp.description,
            dataSources: aDataSources
        };

        if (!oApp.id) {
            return source("app", "App manifest", "warn", "No app id in descriptor", oData);
        }
        return source("app", "App manifest", "ok",
            (oApp.title || oApp.id) + (aDataSources.length ? " · " + aDataSources.length + " data source(s)" : ""),
            oData);
    }

    /**
     * Pages declared by the floorplan. Handles the V2 (sap.ui.generic.app) and
     * V4 (sap.ui5/routing/targets) shapes so the component is template-agnostic.
     */
    function collectPages(oComponent) {
        if (!oComponent || !oComponent.getManifestEntry) {
            return source("pages", "Floorplan pages", "error", "Component not available");
        }
        var aPages = [];

        function walkV2(vPages) {
            if (!vPages) {
                return;
            }
            var aEntries = Array.isArray(vPages) ? vPages : Object.keys(vPages).map(function (sKey) {
                return vPages[sKey];
            });
            aEntries.forEach(function (oPage) {
                if (!oPage) {
                    return;
                }
                aPages.push({
                    entitySet: oPage.entitySet,
                    template: (oPage.component && oPage.component.name) || undefined
                });
                walkV2(oPage.pages);
            });
        }

        try {
            var oGeneric = oComponent.getManifestEntry("sap.ui.generic.app");
            if (oGeneric && oGeneric.pages) {
                walkV2(oGeneric.pages);
            }

            // OData V4 / sap.fe floorplans declare pages as routing targets
            var oUi5 = oComponent.getManifestEntry("sap.ui5") || {};
            var oTargets = (oUi5.routing && oUi5.routing.targets) || {};
            Object.keys(oTargets).forEach(function (sKey) {
                var oTarget = oTargets[sKey] || {};
                var oSettings = (oTarget.options && oTarget.options.settings) || {};
                if (oSettings.entitySet || oSettings.contextPath) {
                    aPages.push({
                        entitySet: oSettings.entitySet || oSettings.contextPath,
                        template: oTarget.name
                    });
                }
            });
        } catch (oError) {
            return source("pages", "Floorplan pages", "error", oError.message);
        }

        if (!aPages.length) {
            return source("pages", "Floorplan pages", "warn", "No pages declared in manifest", { pages: [] });
        }

        var sDetail = aPages.map(function (oPage) {
            var sTemplate = (oPage.template || "").split(".").pop() || "page";
            return sTemplate + (oPage.entitySet ? " (" + oPage.entitySet + ")" : "");
        }).join(", ");

        return source("pages", "Floorplan pages", "ok", sDetail, { pages: aPages });
    }

    /**
     * Entity shape from the OData metamodel: properties, key and navigations.
     */
    function collectService(oModel, sEntitySet) {
        if (!oModel || !oModel.getMetaModel) {
            return source("service", "Service metadata", "error", "No OData model");
        }
        if (!sEntitySet) {
            return source("service", "Service metadata", "warn", "Main entity set unknown");
        }
        try {
            var oMetaModel = oModel.getMetaModel();
            var oEntitySet = oMetaModel.getODataEntitySet(sEntitySet);
            if (!oEntitySet) {
                return source("service", "Service metadata", "error", "Entity set '" + sEntitySet + "' not found");
            }
            var oEntityType = oMetaModel.getODataEntityType(oEntitySet.entityType);
            if (!oEntityType) {
                return source("service", "Service metadata", "error", "Entity type not resolvable");
            }

            var aProperties = (oEntityType.property || []).map(function (oProp) {
                return {
                    name: oProp.name,
                    type: oProp.type,
                    label: oProp[COMMON_NS + "Label"] ? oProp[COMMON_NS + "Label"].String : (oProp["sap:label"] || oProp.name),
                    // the service states this outright, so the assistant never
                    // has to guess which fields are mandatory
                    required: oProp.nullable === "false",
                    maxLength: oProp.maxLength,
                    creatable: oProp["sap:creatable"] !== "false",
                    updatable: oProp["sap:updatable"] !== "false",
                    filterable: oProp["sap:filterable"] !== "false"
                    // "sortable" was computed and sent here too, but never
                    // once referenced by any instruction in prompt.js -
                    // pure wasted tokens on every single question, for
                    // every field, dropped per the "don't send more than
                    // the model actually needs" rule
                };
            });

            var aNavigations = (oEntityType.navigationProperty || []).map(function (oNav) {
                return { name: oNav.name, relationship: oNav.relationship };
            });

            var aKeys = ((oEntityType.key || {}).propertyRef || []).map(function (oRef) {
                return oRef.name;
            });

            return source("service", "Service metadata", "ok",
                sEntitySet + " · " + aProperties.length + " fields · " + aNavigations.length + " navigations",
                {
                    entitySet: sEntitySet,
                    entityType: oEntitySet.entityType,
                    keys: aKeys,
                    properties: aProperties,
                    navigations: aNavigations
                });
        } catch (oError) {
            return source("service", "Service metadata", "error", oError.message);
        }
    }

    /**
     * UI vocabulary annotations driving the floorplan - columns, filters,
     * header and facets. Qualified terms (FieldGroup#Stock) are included.
     */
    function collectAnnotations(oModel, sEntitySet) {
        if (!oModel || !oModel.getMetaModel || !sEntitySet) {
            return source("annotations", "UI annotations", "warn", "Metadata not available");
        }
        try {
            var oMetaModel = oModel.getMetaModel();
            var oEntitySet = oMetaModel.getODataEntitySet(sEntitySet);
            var oEntityType = oEntitySet && oMetaModel.getODataEntityType(oEntitySet.entityType);
            if (!oEntityType) {
                return source("annotations", "UI annotations", "error", "Entity type not resolvable");
            }

            var oTerms = {};
            Object.keys(oEntityType).forEach(function (sKey) {
                if (sKey.indexOf(UI_NS) === 0) {
                    oTerms[sKey.substring(UI_NS.length)] = oEntityType[sKey];
                }
            });

            var aLineItem = (oTerms.LineItem || []).map(function (oField) {
                return oField.Value && oField.Value.Path;
            }).filter(Boolean);

            var aSelectionFields = (oTerms.SelectionFields || []).map(function (oField) {
                return oField.PropertyPath;
            }).filter(Boolean);

            var aFacets = (oTerms.Facets || []).map(function (oFacet) {
                return {
                    label: oFacet.Label && oFacet.Label.String,
                    target: oFacet.Target && oFacet.Target.AnnotationPath
                };
            });

            var oHeaderInfo = oTerms.HeaderInfo ? {
                typeName: oTerms.HeaderInfo.TypeName && oTerms.HeaderInfo.TypeName.String,
                typeNamePlural: oTerms.HeaderInfo.TypeNamePlural && oTerms.HeaderInfo.TypeNamePlural.String,
                title: oTerms.HeaderInfo.Title && oTerms.HeaderInfo.Title.Value && oTerms.HeaderInfo.Title.Value.Path
            } : null;

            var aFieldGroups = Object.keys(oTerms).filter(function (sTerm) {
                return sTerm.indexOf("FieldGroup") === 0;
            }).map(function (sTerm) {
                var oGroup = oTerms[sTerm];
                return {
                    qualifier: sTerm.split("#")[1] || "",
                    fields: ((oGroup && oGroup.Data) || []).map(function (oField) {
                        return oField.Value && oField.Value.Path;
                    }).filter(Boolean)
                };
            });

            // actions the floorplan renders as buttons, wherever they are declared
            var aAnnotatedActions = [];
            ["LineItem", "Identification"].forEach(function (sTerm) {
                (oTerms[sTerm] || []).forEach(function (oRecord) {
                    var sType = oRecord.RecordType || "";
                    if (sType.indexOf("DataFieldForAction") !== -1) {
                        aAnnotatedActions.push({
                            kind: "action",
                            label: oRecord.Label && oRecord.Label.String,
                            action: oRecord.Action && oRecord.Action.String
                        });
                    } else if (sType.indexOf("DataFieldForIntentBasedNavigation") !== -1) {
                        aAnnotatedActions.push({
                            kind: "navigation",
                            label: oRecord.Label && oRecord.Label.String,
                            target: (oRecord.SemanticObject && oRecord.SemanticObject.String) +
                                "-" + (oRecord.Action && oRecord.Action.String)
                        });
                    }
                });
            });

            var oData = {
                lineItem: aLineItem,
                selectionFields: aSelectionFields,
                headerInfo: oHeaderInfo,
                facets: aFacets,
                fieldGroups: aFieldGroups,
                annotatedActions: aAnnotatedActions
            };

            if (!aLineItem.length && !aSelectionFields.length) {
                return source("annotations", "UI annotations", "warn", "No LineItem or SelectionFields found", oData);
            }

            return source("annotations", "UI annotations", "ok",
                aLineItem.length + " columns · " + aSelectionFields.length + " filters · " + aFacets.length + " facets",
                oData);
        } catch (oError) {
            return source("annotations", "UI annotations", "error", oError.message);
        }
    }

    /**
     * What the service says may be done with this entity set. V2 services carry
     * sap:creatable/updatable/deletable; V4 uses the Capabilities vocabulary.
     * Both are read so the assistant can describe the app honestly instead of
     * guessing it is read-only.
     */
    function collectCapabilities(oModel, sEntitySet) {
        if (!oModel || !oModel.getMetaModel || !sEntitySet) {
            return source("capabilities", "CRUD capabilities", "warn", "Metadata not available");
        }
        try {
            var oMetaModel = oModel.getMetaModel();
            var oEntitySet = oMetaModel.getODataEntitySet(sEntitySet);
            if (!oEntitySet) {
                return source("capabilities", "CRUD capabilities", "error", "Entity set not found");
            }

            function v2Flag(sName) {
                var sValue = oEntitySet["sap:" + sName];
                return sValue === undefined ? undefined : sValue !== "false";
            }

            function v4Flag(sTerm, sProperty) {
                var oTerm = oEntitySet["Org.OData.Capabilities.V1." + sTerm];
                if (!oTerm || !oTerm[sProperty]) {
                    return undefined;
                }
                return oTerm[sProperty].Bool !== "false";
            }

            // searchable/pageable used to be computed and sent here too -
            // dropped for the same reason as "sortable" on properties above:
            // prompt.js's instructions only ever reason about create/update/
            // delete, never about search or pagination support, so those
            // two flags were pure wasted tokens on every question
            var oFlags = {
                creatable: v2Flag("creatable") !== undefined ? v2Flag("creatable") : v4Flag("InsertRestrictions", "Insertable"),
                updatable: v2Flag("updatable") !== undefined ? v2Flag("updatable") : v4Flag("UpdateRestrictions", "Updatable"),
                deletable: v2Flag("deletable") !== undefined ? v2Flag("deletable") : v4Flag("DeleteRestrictions", "Deletable")
            };

            // operations the service exposes beyond plain CRUD
            var aFunctionImports = [];
            try {
                var oContainer = oMetaModel.getODataEntityContainer();
                aFunctionImports = ((oContainer && oContainer.functionImport) || []).map(function (oFn) {
                    return { name: oFn.name, method: oFn["m:HttpMethod"] || oFn.httpMethod };
                });
            } catch (oInner) {
                aFunctionImports = [];
            }

            var aDeclared = Object.keys(oFlags).filter(function (sKey) {
                return oFlags[sKey] !== undefined;
            });

            var oData = { flags: oFlags, functionImports: aFunctionImports };

            if (!aDeclared.length) {
                return source("capabilities", "CRUD capabilities", "warn",
                    "Service declares no restrictions - assume read-only", oData);
            }

            var sDetail = aDeclared.map(function (sKey) {
                return (oFlags[sKey] ? "" : "no ") + sKey;
            }).join(", ");

            return source("capabilities", "CRUD capabilities", "ok", sDetail, oData);
        } catch (oError) {
            return source("capabilities", "CRUD capabilities", "error", oError.message);
        }
    }

    /**
     * Where this app can hand off to other apps, from the descriptor.
     */
    function collectIntents(oComponent) {
        if (!oComponent || !oComponent.getManifestEntry) {
            return source("intents", "App navigation", "warn", "Component not available");
        }
        try {
            var oApp = oComponent.getManifestEntry("sap.app") || {};
            var oCross = oApp.crossNavigation || {};
            var oInbounds = oCross.inbounds || {};
            var aOutbounds = Object.keys(oCross.outbounds || {}).map(function (sKey) {
                var oOut = oCross.outbounds[sKey];
                return oOut.semanticObject + "-" + oOut.action;
            });
            var aInbounds = Object.keys(oInbounds).map(function (sKey) {
                var oIn = oInbounds[sKey];
                return oIn.semanticObject + "-" + oIn.action;
            });

            var oData = { inbounds: aInbounds, outbounds: aOutbounds };
            if (!aInbounds.length && !aOutbounds.length) {
                return source("intents", "App navigation", "warn", "No cross-app intents declared", oData);
            }
            return source("intents", "App navigation", "ok",
                aInbounds.length + " inbound · " + aOutbounds.length + " outbound", oData);
        } catch (oError) {
            return source("intents", "App navigation", "error", oError.message);
        }
    }

    /**
     * Actions the user can actually press, read from the table toolbar via
     * public aggregation APIs.
     */
    function collectActions(oTable) {
        if (!oTable || !oTable.getToolbar) {
            return source("actions", "Toolbar actions", "warn", "No table toolbar available");
        }
        try {
            var oToolbar = oTable.getToolbar();
            var aContent = (oToolbar && oToolbar.getContent && oToolbar.getContent()) || [];
            // only real pressable controls - titles and spacers also carry text
            var aActions = aContent.filter(function (oControl) {
                var sType = oControl.getMetadata && oControl.getMetadata().getName();
                var bPressable = sType === "sap.m.Button" ||
                    sType === "sap.m.OverflowToolbarButton" ||
                    sType === "sap.m.MenuButton";
                return bPressable && oControl.getVisible && oControl.getVisible();
            }).map(function (oControl) {
                return (oControl.getText && oControl.getText()) ||
                    (oControl.getTooltip && oControl.getTooltip()) ||
                    (oControl.getIcon && oControl.getIcon());
            }).filter(Boolean);

            if (!aActions.length) {
                return source("actions", "Toolbar actions", "warn", "No labelled actions found", { actions: [] });
            }
            return source("actions", "Toolbar actions", "ok", aActions.length + " found", { actions: aActions });
        } catch (oError) {
            return source("actions", "Toolbar actions", "error", oError.message);
        }
    }

    return {
        /**
         * Assembles (and caches) everything that can be learned about the host
         * application. Nothing here is specific to any entity or app - it is all
         * read from the descriptor and the OData metamodel at runtime.
         *
         * @param {object} mParams
         * @param {sap.ui.core.UIComponent} mParams.component
         * @param {sap.ui.model.odata.v2.ODataModel} mParams.model
         * @param {string} mParams.entitySet main entity set of the current page
         * @param {sap.ui.comp.smarttable.SmartTable} [mParams.table]
         * @param {boolean} [mParams.refresh] rebuild instead of using the cache
         * @returns {{sources: object[], pack: object}}
         */
        get: function (mParams) {
            var sKey = (mParams.pageType || "page") + "|" + (mParams.entitySet || "__unknown__");
            if (mCache[sKey] && !mParams.refresh) {
                Logger.step("AppKnowledge", "reusing cached knowledge for " + sKey);
                return mCache[sKey];
            }
            Logger.step("AppKnowledge", "reading the app for " + sKey +
                (mParams.refresh ? " (forced refresh)" : ""));

            // the view's owner is the template component; the descriptor we want
            // belongs to the application component further up the chain
            var oAppComponent = resolveAppComponent(mParams.component);
            if (oAppComponent !== mParams.component) {
                Logger.step("AppKnowledge", "walked up from the template component to the app component",
                    (oAppComponent.getManifestEntry("sap.app") || {}).id);
            }

            var aSources = [
                collectApp(oAppComponent),
                AppBrief.asSource(),
                collectPages(oAppComponent),
                collectService(mParams.model, mParams.entitySet),
                collectAnnotations(mParams.model, mParams.entitySet),
                collectCapabilities(mParams.model, mParams.entitySet),
                collectIntents(oAppComponent),
                collectActions(mParams.table)
            ];

            var oPack = {};
            aSources.forEach(function (oSource) {
                if (oSource.data) {
                    oPack[oSource.id] = oSource.data;
                }
                var sMethod = oSource.status === "ok" ? "step" : (oSource.status === "warn" ? "warn" : "error");
                Logger[sMethod]("AppKnowledge", oSource.label + ": " + oSource.detail);
            });

            mCache[sKey] = { sources: aSources, pack: oPack };
            return mCache[sKey];
        },

        /** Exposed so callers can reach the host app's descriptor too. */
        resolveAppComponent: resolveAppComponent,

        reset: function () {
            mCache = {};
        }
    };
});
