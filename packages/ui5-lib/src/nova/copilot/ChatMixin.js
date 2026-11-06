sap.ui.define([
    "sap/ui/core/Fragment",
    "sap/ui/core/Component",
    "sap/ui/model/json/JSONModel",
    "sap/ui/model/resource/ResourceModel",
    "sap/ui/model/Sorter",
    "sap/ui/core/routing/HashChanger",
    "sap/m/MessageToast",
    "sap/m/ResponsivePopover",
    "sap/m/Button",
    "sap/m/Text",
    "sap/m/VBox",
    "./ContextCollector",
    "./AiClient",
    "./ActionApplier",
    "./knowledge/AppKnowledge",
    "./knowledge/AppBrief",
    "./DataQuery",
    "./ChartBuilder",
    "./FieldPopulator",
    "./DocumentReader",
    "./BulkUpload",
    "./Workboard",
    "./WorkboardExporter",
    "./ODataBatchFix",
    "./Logger"
], function (Fragment, Component, JSONModel, ResourceModel, Sorter, HashChanger, MessageToast, ResponsivePopover, Button, Text, VBox, ContextCollector, AiClient, ActionApplier, AppKnowledge, AppBrief, DataQuery, ChartBuilder, FieldPopulator, DocumentReader, BulkUpload, Workboard, WorkboardExporter, ODataBatchFix, Logger) {
    "use strict";

    function findControl(oRoot, fnMatches) {
        if (!oRoot || !oRoot.getMetadata) {
            return null;
        }
        if (fnMatches(oRoot)) {
            return oRoot;
        }
        if (!oRoot.getMetadata().getAllAggregations) {
            return null;
        }
        var mAggregations = oRoot.getMetadata().getAllAggregations();
        var aNames = Object.keys(mAggregations);
        for (var i = 0; i < aNames.length; i++) {
            if (!oRoot.getAggregation) {
                continue;
            }
            var vValue = oRoot.getAggregation(aNames[i]);
            if (!vValue) {
                continue;
            }
            var aChildren = Array.isArray(vValue) ? vValue : [vValue];
            for (var j = 0; j < aChildren.length; j++) {
                var oFound = findControl(aChildren[j], fnMatches);
                if (oFound) {
                    return oFound;
                }
            }
        }
        return null;
    }

    function findControlByType(oRoot, sTypeName) {
        return findControl(oRoot, function (oControl) {
            return oControl.getMetadata().getName() === sTypeName;
        });
    }

    function formatTime() {
        return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }

    // how many prior turns ride along with a new question - a cost/quality
    // dial, not a hard limit; the server enforces its own cap independently
    var MAX_HISTORY_TURNS = 10;

    /**
     * Renders the small amount of structure the assistant is allowed to use -
     * bold and bullet lines - as markup FormattedText accepts. Everything is
     * escaped first, so model output can never inject markup of its own.
     */
    function escapeHtml(sText) {
        return String(sText === undefined || sText === null ? "" : sText)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
    }

    function emphasise(sHtml) {
        return sHtml.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    }

    /**
     * Builds the markup FormattedText renders: a lead sentence plus, when the
     * assistant returned a list, a real <ul>. Everything is escaped before any
     * markup is added, so model output can never inject its own.
     */
    function buildHtml(sText, aBullets) {
        var aOut = [];
        if (sText) {
            aOut.push("<p>" + emphasise(escapeHtml(sText)) + "</p>");
        }
        if (aBullets && aBullets.length) {
            aOut.push("<ul>");
            aBullets.forEach(function (vBullet) {
                aOut.push("<li>" + emphasise(escapeHtml(vBullet)) + "</li>");
            });
            aOut.push("</ul>");
        }
        return aOut.join("");
    }

    // the launchpad knows who is signed in; fall back to a neutral label outside FLP
    function getLaunchpadUserInitials() {
        try {
            var oContainer = sap.ushell && sap.ushell.Container;
            var oUser = oContainer && oContainer.getUser && oContainer.getUser();
            var sName = oUser && oUser.getFullName && oUser.getFullName();
            if (sName) {
                return sName.trim().split(/\s+/).map(function (sPart) {
                    return sPart.charAt(0);
                }).join("").substring(0, 2).toUpperCase();
            }
        } catch (oError) {
            // not running inside a launchpad shell
        }
        return "ME";
    }

    // One dock for the whole app. Navigating between list and object page swaps
    // which controller owns it, but the conversation and the position survive.
    var oSharedModel = null;
    var oMountedUi = null;

    // The library's own texts, independent of whatever i18n bundle (or none)
    // the host app ships - built once and reused by every view.
    var oI18nModel = null;
    function getI18nModel() {
        if (!oI18nModel) {
            oI18nModel = new ResourceModel({ bundleName: "nova.copilot.i18n.messagebundle" });
        }
        return oI18nModel;
    }

    // Injected once per page load, so a host app needs no manifest CSS entry
    // to install this library.
    var bCssInjected = false;
    function ensureLibraryCss() {
        if (bCssInjected) {
            return;
        }
        bCssInjected = true;
        try {
            var sUrl = sap.ui.require.toUrl("nova/copilot/ChatPanel.css");
            var oLink = document.createElement("link");
            oLink.rel = "stylesheet";
            oLink.href = sUrl;
            oLink.dataset.novaCopilotCss = "true";
            document.head.appendChild(oLink);
        } catch (oError) {
            Logger.error("ChatMixin", "could not inject the library stylesheet", oError.message);
        }
    }

    // Every page extension registers itself here. Which one is "current" is
    // decided by looking at the DOM rather than by trusting lifecycle events -
    // a cached view can be navigated back to without re-rendering, which used
    // to leave the assistant believing it was still on the object page.
    var aRegisteredPages = [];

    // Values waiting for an object page to open and enter edit mode. Navigation
    // destroys and rebuilds the page, so this lives outside any controller.
    var oPendingPopulate = null;

    // Work queued for the list report after navigating back to it.
    var oPendingTableAction = null;

    // Steps still to run after a navigation. A multi-step request such as
    // "go back, filter, then chart it" cannot finish in one go: the page has
    // to change first, so the remainder waits here.
    var aPendingSteps = [];

    function isVisible(oController) {
        try {
            var oView = oController.base.getView();
            var oDom = oView && oView.getDomRef();
            return !!(oDom && oDom.offsetParent !== null);
        } catch (oError) {
            return false;
        }
    }

    /**
     * Everything the chat panel does, independent of which floorplan hosts it.
     * Each page type supplies _getPageInfo() describing its own surroundings.
     */
    return {

        findControl: findControl,
        findControlByType: findControlByType,

        _initChatModel: function () {
            ODataBatchFix.apply();
            if (!oSharedModel) {
                oSharedModel = new JSONModel({
                    messages: [],
                    hasMessages: false,
                    busy: false,
                    open: false,
                    question: "",
                    userInitials: getLaunchpadUserInitials(),
                    knowledgeSources: [],
                    showKnowledge: false,
                    minimised: false,
                    // off by default - the model never sees real data values
                    // unless the user explicitly turns this on. Session-only,
                    // same as everything else on this shared model: resets on
                    // reload, no persistence layer, matching the existing
                    // privacy posture rather than remembering consent across
                    // visits.
                    aiDataConsent: false,
                    // the latest usage/cost numbers each model call reports
                    // back (the counts SAP meters into capacity units) -
                    // null until the first call. Shown on demand via the
                    // header's "AI usage & cost" button, NOT as an always-on
                    // header line: that crowded the header badly (confirmed
                    // live) for a number nobody needs in view permanently.
                    tokenStats: null
                });

                // one registration for the whole session - the shared model
                // is created exactly once, so this can't stack up listeners
                AiClient.onUsage(function (oUsage) {
                    oSharedModel.setProperty("/tokenStats", oUsage);
                });
            }
            this._oChatModel = oSharedModel;

            if (aRegisteredPages.indexOf(this) === -1) {
                aRegisteredPages.push(this);
            }
        },

        /**
         * The page the user is actually looking at right now, which is not
         * necessarily the one that happens to own the dock.
         */
        _activePageInfo: function () {
            var oActive = aRegisteredPages.filter(isVisible)[0];
            var oPage = (oActive || this)._getPageInfo();
            Logger.step("ChatMixin", "active page resolved to " + oPage.pageType +
                (oPage.record ? " on record " + JSON.stringify(oPage.record.keys) : ""), {
                registeredPages: aRegisteredPages.length,
                entitySet: oPage.entitySet
            });
            return oPage;
        },

        /**
         * Mounts the launcher and the panel into a fixed container on the page.
         * Nothing needs to be declared in the host manifest - the component
         * brings its own entry point, which keeps it drop-in for any app.
         */
        _ensureChatUi: function () {
            var oView = this.base.getView();
            var sOwnerId = oView.getId();

            ensureLibraryCss();

            // already mounted for this page - nothing to do
            if (oMountedUi && oMountedUi.ownerId === sOwnerId) {
                return oMountedUi.promise;
            }
            Logger.step("ChatMixin", "mounting the dock for view " + sOwnerId);

            // the business brief is optional and loads in the background
            AppBrief.load(AppKnowledge.resolveAppComponent(Component.getOwnerComponentFor(oView))).then(function () {
                this._loadKnowledge(true);
            }.bind(this));

            // mounted for a different page (we navigated): tear the old one down
            // so the dock never appears twice
            if (oMountedUi) {
                var oPrevious = oMountedUi;
                oMountedUi = null;
                Logger.step("ChatMixin", "navigated away - destroying the dock owned by " + oPrevious.ownerId);
                oPrevious.promise.then(function (aControls) {
                    aControls.forEach(function (oControl) {
                        oControl.destroy();
                    });
                });
            }

            var oPromise = Fragment.load({
                id: sOwnerId,
                name: "nova.copilot.ChatPanel",
                controller: this
            }).then(function (vControls) {
                var aControls = Array.isArray(vControls) ? vControls : [vControls];
                var oContainer = document.getElementById("novaDockContainer");
                if (!oContainer) {
                    oContainer = document.createElement("div");
                    oContainer.id = "novaDockContainer";
                    document.body.appendChild(oContainer);
                }
                aControls.forEach(function (oControl) {
                    oControl.setModel(this._oChatModel, "aiChat");
                    oControl.setModel(getI18nModel(), "novaI18n");
                    oView.addDependent(oControl);
                    oControl.placeAt(oContainer);
                }, this);

                // keep the open/collapsed styling in step with the model
                oContainer.classList.toggle("novaOpen", !!this._oChatModel.getProperty("/open"));
                this._enableDrag(oContainer);
                this._observeDockResize(oContainer);
                setTimeout(this._syncDockLayout.bind(this), 0);
                return aControls;
            }.bind(this));

            oMountedUi = { ownerId: sOwnerId, promise: oPromise };
            this._oChatPanelPromise = oPromise;
            return oPromise;
        },

        /**
         * Lets the user drag the whole dock by its handle. A small movement
         * threshold keeps an ordinary click on the launcher working as a click.
         */
        _enableDrag: function (oContainer) {
            // the container outlives controllers, so the guard lives on it
            if (!oContainer || oContainer.dataset.novaDrag === "on") {
                return;
            }
            oContainer.dataset.novaDrag = "on";
            var iStartX = 0, iStartY = 0, iStartLeft = 0, iStartTop = 0;
            var bPressed = false, bMoved = false;

            function onMove(oEvent) {
                if (!bPressed) {
                    return;
                }
                var iDx = oEvent.clientX - iStartX;
                var iDy = oEvent.clientY - iStartY;
                if (!bMoved && Math.abs(iDx) + Math.abs(iDy) < 4) {
                    return;
                }
                bMoved = true;
                oContainer.classList.add("novaDragging");

                var iMaxLeft = window.innerWidth - oContainer.offsetWidth;
                var iMaxTop = window.innerHeight - 48;
                oContainer.style.left = Math.max(0, Math.min(iStartLeft + iDx, iMaxLeft)) + "px";
                oContainer.style.top = Math.max(0, Math.min(iStartTop + iDy, iMaxTop)) + "px";
                oContainer.style.right = "auto";
                oContainer.style.bottom = "auto";
                oEvent.preventDefault();
            }

            function onUp(oEvent) {
                if (bMoved) {
                    // swallow the click that would otherwise follow the drag
                    oEvent.stopPropagation();
                    oEvent.preventDefault();
                }
                bPressed = false;
                bMoved = false;
                oContainer.classList.remove("novaDragging");
                document.removeEventListener("mousemove", onMove, true);
                document.removeEventListener("mouseup", onUp, true);
            }

            oContainer.addEventListener("mousedown", function (oEvent) {
                var oHandle = oEvent.target.closest(".novaDragHandle");
                if (!oHandle) {
                    return;
                }
                // header buttons must stay clickable
                if (oEvent.target.closest(".sapMBtn") && !oEvent.target.closest(".novaLauncher")) {
                    return;
                }
                var oRect = oContainer.getBoundingClientRect();
                iStartX = oEvent.clientX;
                iStartY = oEvent.clientY;
                iStartLeft = oRect.left;
                iStartTop = oRect.top;
                bPressed = true;
                bMoved = false;
                document.addEventListener("mousemove", onMove, true);
                document.addEventListener("mouseup", onUp, true);
            });
        },

        _loadKnowledge: function (bRefresh) {
            var oView = this.base.getView();
            var oPage = this._activePageInfo();

            var oKnowledge = AppKnowledge.get({
                component: Component.getOwnerComponentFor(oView),
                model: oView.getModel(),
                entitySet: oPage.entitySet,
                pageType: oPage.pageType,
                table: oPage.table,
                refresh: bRefresh
            });

            var oData = this._oChatModel.getData();
            oData.knowledgeSources = oKnowledge.sources;
            this._oChatModel.setData(oData);

            // the full pack, once per page, so it is obvious what the assistant was given
            if (!this._bKnowledgeLogged || bRefresh) {
                this._bKnowledgeLogged = true;
                Logger.step("ChatMixin", "knowledge pack for " + oPage.pageType, oKnowledge.pack);
            }

            return oKnowledge;
        },

        /**
         * The one user-facing control for the one real exception to "the AI
         * never reads data" - off by default. When on, the model may be
         * told a comparison between two fields is possible (e.g. "below
         * reorder level"); the app still does the actual row-matching
         * itself via a real query, never the model - see
         * _resolveFieldCompareFilters. When off, that capability is
         * withheld entirely (see prompt.js), not just unused.
         */
        onToggleDataConsent: function () {
            var oData = this._oChatModel.getData();
            oData.aiDataConsent = !oData.aiDataConsent;
            this._oChatModel.setData(oData);
            Logger.step("ChatMixin", "AI data consent " + (oData.aiDataConsent ? "enabled" : "disabled") + " by the user");
        },

        /**
         * Opens a small popover with the session and all-time AI usage,
         * anchored to the header's "AI usage & cost" button. Content is
         * rebuilt from the latest numbers on every open - a popover is only
         * ever open for a moment, so there's nothing to keep bound.
         */
        onShowAiUsage: function (oEvent) {
            var oButton = oEvent.getSource();
            var oUsage = this._oChatModel.getProperty("/tokenStats");
            if (!oUsage) {
                MessageToast.show("No AI calls yet this session - ask something first.");
                return;
            }

            // "₹" reads better than "INR" next to a number; anything else
            // (EUR, USD, ...) is shown as the code the service sent
            var mCurrencySymbols = { INR: "₹", EUR: "€", USD: "$" };
            var sCurrency = mCurrencySymbols[oUsage.currency] || oUsage.currency || "";

            function line(sLabel, iCalls, iTokens, fCu, fCost) {
                var sText = sLabel + ": " + iTokens.toLocaleString() + " tokens / " +
                    iCalls + " call(s)";
                if (fCu !== null && fCu !== undefined) {
                    sText += "  ≈ " + fCu + " CU";
                }
                if (fCost !== null && fCost !== undefined) {
                    sText += " (" + sCurrency + fCost.toLocaleString() + ")";
                }
                return new Text({ text: sText });
            }

            var oContent = new VBox({
                items: [
                    line("This session", oUsage.sessionCalls, oUsage.sessionTotal,
                        oUsage.sessionCu, oUsage.sessionCost),
                    line("All-time", oUsage.overallCalls, oUsage.overallTotal,
                        oUsage.overallCu, oUsage.overallCost),
                    new Text({ text: "Last call: " + oUsage.action + " — " + oUsage.total +
                        " tokens (" + oUsage.prompt + " in / " + oUsage.completion + " out)" +
                        (oUsage.lastCu !== null && oUsage.lastCu !== undefined
                            ? "  ≈ " + oUsage.lastCu + " CU" : "") +
                        (oUsage.lastCost !== null && oUsage.lastCost !== undefined
                            ? " (" + sCurrency + oUsage.lastCost.toLocaleString() + ")" : "") +
                        (oUsage.lastCachedRead
                            ? " — " + oUsage.lastCachedRead.toLocaleString() +
                                " of those served from cache at the reduced cached rate"
                            : "") })
                ]
            }).addStyleClass("novaDialogContentPad");

            if (!this._oUsagePopover) {
                this._oUsagePopover = new ResponsivePopover({
                    title: "AI usage & estimated cost",
                    placement: "Bottom",
                    contentWidth: "22rem",
                    // clears EVERYTHING: the service's session counters, the
                    // persisted all-time file, and this client's display -
                    // via a dedicated resetUsage action that involves no
                    // model call
                    endButton: new Button({
                        text: "Clear all usage",
                        icon: "sap-icon://reset",
                        press: function () {
                            AiClient.resetUsage().then(function () {
                                MessageToast.show("AI usage counters cleared.");
                            }).catch(function (oError) {
                                MessageToast.show(oError.message);
                            });
                            this._oUsagePopover.close();
                        }.bind(this)
                    })
                });
                this.base.getView().addDependent(this._oUsagePopover);
            }
            this._oUsagePopover.destroyContent();
            this._oUsagePopover.addContent(oContent);
            // Never anchor to the pressed button: when the dock is narrow it
            // lives inside the OverflowToolbar's "..." popup, which closes on
            // press - and at press time the button still HAS a DOM node (it's
            // rendered in that popup), so checking for one isn't enough; the
            // node is gone a tick later and the popover silently never shows
            // (confirmed live, twice). The header toolbar is always rendered,
            // so anchor there unconditionally, and open after a short delay
            // so the closing overflow popup can't swallow the new popover in
            // its own close/focus handling.
            var oToolbar = this.base.getView().byId("novaHeaderToolbar") || oButton;
            setTimeout(function () {
                this._oUsagePopover.openBy(oToolbar);
            }.bind(this), 150);
        },

        onToggleKnowledge: function () {
            var oData = this._oChatModel.getData();
            oData.showKnowledge = !oData.showKnowledge;
            this._oChatModel.setData(oData);
        },

        onRefreshKnowledge: function () {
            this._loadKnowledge(true);
        },

        _collectContext: function () {
            var oView = this.base.getView();
            var oPage = this._activePageInfo();

            var oContext = ContextCollector.collect({
                component: Component.getOwnerComponentFor(oView),
                model: oView.getModel(),
                entitySet: oPage.entitySet,
                filterBar: oPage.filterBar,
                table: oPage.table,
                maxRows: 50
            });

            // tell the model which floorplan it is on and, on an object page,
            // which record the user currently has open
            oContext.page = {
                type: oPage.pageType,
                entitySet: oPage.entitySet
            };
            if (oPage.record) {
                oContext.page.openRecord = oPage.record;
            }
            if (oPage.editable !== undefined) {
                oContext.page.editable = oPage.editable;
                oContext.page.createMode = !!oPage.createMode;
            }

            var oKnowledge = this._loadKnowledge(false);
            oContext.appKnowledge = oKnowledge.pack;
            oContext.dataConsent = !!this._oChatModel.getData().aiDataConsent;

            return oContext;
        },

        _pushMessage: function (sRole, sText, aBullets, sBasis, aPrompts, bHasChart, oChartRef) {
            var oData = this._oChatModel.getData();
            oData.messages.push({
                role: sRole,
                text: sText,
                bullets: aBullets || [],
                html: buildHtml(sText, aBullets),
                basis: sBasis || "",
                prompts: aPrompts || [],
                hasPrompts: !!(aPrompts && aPrompts.length),
                hasChart: !!bHasChart,
                // this specific message's own {createFrame, title} - lets a
                // "pin to workboard" press on THIS bubble re-render the chart
                // it actually showed, even if a newer chart has since replaced
                // _lastChart (which only ever tracks the most recent one)
                chartRef: oChartRef || null,
                time: formatTime()
            });
            oData.hasMessages = true;
            this._oChatModel.setData(oData);
            this._scrollToLatest();
        },

        /**
         * Compact {role, text} turns for AiClient.ask's history argument -
         * built from the same transcript the UI already renders, not a
         * separate store. Capped to the most recent turns (MAX_HISTORY_TURNS)
         * and to turns that actually carry text, since an assistant turn can
         * be bullets-only.
         */
        _buildHistory: function (aMessages) {
            // Two caps, chars not just turns: a long assistant answer (big
            // bullet lists especially) made 10 turns of history cost
            // thousands of input tokens per question - and history sits
            // AFTER the cached prefix, so it's billed at the full rate
            // every time. For continuity, the model needs the gist of each
            // turn, not every bullet verbatim.
            var MAX_TURN_CHARS = 600;
            var MAX_HISTORY_CHARS = 3000;

            var aTurns = (aMessages || [])
                .slice(-MAX_HISTORY_TURNS)
                .map(function (oMsg) {
                    var sText = oMsg.text || (oMsg.bullets && oMsg.bullets.length ? oMsg.bullets.join("; ") : "");
                    if (sText.length > MAX_TURN_CHARS) {
                        sText = sText.slice(0, MAX_TURN_CHARS) + "…";
                    }
                    return { role: oMsg.role, text: sText };
                })
                .filter(function (oTurn) {
                    return !!oTurn.text;
                });

            // drop the OLDEST turns until the total fits
            var iTotal = aTurns.reduce(function (iSum, oTurn) { return iSum + oTurn.text.length; }, 0);
            while (aTurns.length && iTotal > MAX_HISTORY_CHARS) {
                iTotal -= aTurns.shift().text.length;
            }
            return aTurns;
        },

        /**
         * Sizes the message area from the dock's real inner height minus the
         * measured header and footer, so the input bar is always on screen no
         * matter how the user resizes. Measured rather than derived from CSS,
         * because the panel's internal DOM is not ours to rely on.
         */
        _syncDockLayout: function () {
            var oView = this.base.getView();
            var oContainer = document.getElementById("novaDockContainer");
            if (!oContainer || !oContainer.classList.contains("novaOpen")) {
                return;
            }

            function domOf(sId) {
                var oControl = oView.byId(sId);
                return oControl && oControl.getDomRef ? oControl.getDomRef() : null;
            }

            var oHeader = domOf("novaHeaderToolbar");
            var oFooter = domOf("novaFooterToolbar");
            var iHeader = oHeader ? oHeader.offsetHeight : 52;
            var iFooter = oFooter ? oFooter.offsetHeight : 52;
            var iBody = Math.max(96, oContainer.clientHeight - iHeader - iFooter);

            ["novaScroll", "novaKnowledgePanel"].forEach(function (sId) {
                var oDom = domOf(sId);
                if (oDom) {
                    oDom.style.height = iBody + "px";
                    oDom.style.maxHeight = iBody + "px";
                }
            });

            // the dock itself must never scroll - only the message area does
            oContainer.scrollTop = 0;
        },

        // re-measure whenever the user drags the resize grip
        _observeDockResize: function (oContainer) {
            if (!oContainer || oContainer.dataset.novaResize === "on" || !window.ResizeObserver) {
                return;
            }
            oContainer.dataset.novaResize = "on";
            var that = this;
            new window.ResizeObserver(function () {
                that._syncDockLayout();
            }).observe(oContainer);
        },

        _scrollToLatest: function () {
            var oView = this.base.getView();
            setTimeout(function () {
                this._syncDockLayout();
                var oScroll = oView.byId("novaScroll");
                var oDom = oScroll && oScroll.getDomRef();
                if (!oDom) {
                    return;
                }
                // the root element is the one with the bounded height, so scroll
                // it directly rather than going through the scroll delegate
                oDom.scrollTop = oDom.scrollHeight;
            }.bind(this), 50);
        },

        /**
         * Answers a data question by querying the service directly. The rows
         * come back to the app, never to the model - so the values shown are
         * read from the system of record and cannot be recalled or invented.
         */
        _runQuery: function (oAction) {
            var oView = this.base.getView();
            var oPage = this._activePageInfo();
            var oContext = this._collectContext();

            Logger.step("ChatMixin", "running a service query on the app's behalf", oAction.query);

            return DataQuery.run(oAction.query || {}, {
                model: oView.getModel(),
                entitySet: oPage.entitySet,
                entityMeta: oContext.entity,
                screenFilters: this._screenFilters(oPage)
            }).then(function (oResult) {
                var aBullets = DataQuery.toBullets(oResult.rows, oResult.select, oContext.entity);
                var sMessage = oAction.message ||
                    (oResult.rows.length + " record(s) found:");

                if (!oResult.rows.length) {
                    sMessage = "The service returned no records for that.";
                }
                if (oResult.dropped.length) {
                    sMessage += " (ignored unknown field(s): " + oResult.dropped.join(", ") + ")";
                }

                var iFilters = this._screenFilters(oPage).length;
                this._pushMessage("assistant", sMessage, aBullets,
                    iFilters
                        ? "a live query using the " + iFilters + " filter(s) currently applied"
                        : "a live query against the service");
            }.bind(this)).catch(function (oError) {
                Logger.error("ChatMixin", "query failed", oError.message);
                this._pushMessage("assistant", "I couldn't run that query: " + oError.message);
            }.bind(this));
        },

        /**
         * Fills the open record's fields from what the user described. Values
         * are written into the pending record only - nothing is submitted, so
         * the user reviews the form and presses Save themselves.
         */
        _runPopulate: function (oAction) {
            var oView = this.base.getView();
            var oPage = this._activePageInfo();

            if (!oPage.editable) {
                Logger.warn("ChatMixin", "populate requested but the record is not in edit mode");
                this._pushMessage("assistant",
                    "I can only fill in fields while the record is open for editing. " +
                    "Choose Edit (or Create) first, then ask me again.");
                return;
            }

            var oContext = oPage.bindingContext;
            if (!oContext) {
                this._pushMessage("assistant", "I couldn't find the record to fill in.");
                return;
            }

            var oResult = FieldPopulator.run(oAction.values || [], {
                model: oView.getModel(),
                context: oContext,
                entitySet: oPage.entitySet,
                // rich description with real creatable/updatable flags, same
                // reasoning as onDocumentSelected - the thin context shape
                // made every writability check a silent pass
                entityMeta: FieldPopulator.describeEntityType(oView.getModel(), oPage.entitySet) ||
                    this._collectContext().entity,
                createMode: oPage.createMode
            });

            var aBullets = oResult.applied.map(function (oApplied) {
                return "**" + (oApplied.label || oApplied.field) + "** - " + oApplied.value;
            }).concat(oResult.skipped.map(function (oSkipped) {
                return "**" + oSkipped.field + "** - not set (" + oSkipped.reason + ")";
            }));

            var sMessage = oResult.applied.length
                ? "I've filled in " + oResult.applied.length + " field(s). Review them and press Save:"
                : "I couldn't fill in any of those fields:";

            // changing a field behind an association edits the related record,
            // which is shared - the user needs to know before they save
            if (oResult.viaNavigation && oResult.viaNavigation.length) {
                sMessage += " Note that " + oResult.viaNavigation.join(", ") +
                    " belong to a linked record, so saving changes it everywhere it is used.";
            }

            this._pushMessage("assistant", sMessage, aBullets,
                "the fields you described - nothing has been saved");
        },

        /**
         * Opens the chart builder. With nothing specified the assistant is asked
         * to suggest what is worth charting from the fields available, so a user
         * who is not sure what they want still gets somewhere.
         */
        onConstructChart: function () {
            var oSuggestions = ChartBuilder.suggest(this._collectContext().entity);

            if (!oSuggestions.measures.length) {
                this._pushMessage("assistant",
                    "There are no numeric fields on this screen, so there is nothing to plot.");
                return;
            }

            var oData = this._oChatModel.getData();
            oData.question = "Suggest some charts I could build from this data, " +
                "and tell me what to say to build one.";
            this._oChatModel.setData(oData);
            this.onSendPress();
        },

        /**
         * One click instead of having to type a question first - sends the
         * same kind of request prompt.js's "SUGGESTING FILTERS AND SORTS
         * WORTH USING" section is built to answer well: business-scenario-
         * grounded suggestions, combining filter and sort where that's
         * actually what the scenario calls for, never a field-to-field
         * filter this service can't execute.
         */
        onSmartSuggest: function () {
            var oData = this._oChatModel.getData();
            oData.question = "Suggest some useful filter and sort operations for this screen, " +
                "combining them where that fits the scenario.";
            this._oChatModel.setData(oData);
            this.onSendPress();
        },

        /**
         * Renders a chart the assistant described. It chooses the type and the
         * fields; the data is read from the service and aggregated here, so the
         * figures plotted never pass through the model.
         */
        /** The filters the user currently has applied on screen. */
        _screenFilters: function (oPage) {
            try {
                var oFilterBar = oPage.filterBar;
                var aFilters = oFilterBar && oFilterBar.getFilters ? oFilterBar.getFilters() : [];
                return aFilters || [];
            } catch (oError) {
                Logger.warn("ChatMixin", "could not read the filter bar", oError.message);
                return [];
            }
        },

        _runChart: function (oAction) {
            var oView = this.base.getView();
            var oPage = this._activePageInfo();
            var oContext = this._collectContext();

            return ChartBuilder.build(oAction.chart || {}, {
                model: oView.getModel(),
                entitySet: oPage.entitySet,
                entityMeta: oContext.entity,
                screenFilters: this._screenFilters(oPage)
            }).then(function (oResult) {
                var sTitle = (oAction.chart && oAction.chart.title) || "Chart";
                var sMessage = oAction.message ||
                    ("Here is the chart, built from " + oResult.rows + " category(ies).");
                if (oResult.dropped.length) {
                    sMessage += " (ignored unknown field(s): " + oResult.dropped.join(", ") + ")";
                }

                // the chart lives in the conversation; full screen renders a
                // second frame from the same data rather than moving this one
                this._lastChart = {
                    createFrame: oResult.createFrame,
                    title: sTitle,
                    chartSummary: oResult.chartSummary
                };

                var iScreenFilters = this._screenFilters(oPage).length;
                var sBasis = iScreenFilters
                    ? "a live query using the " + iScreenFilters +
                        " filter(s) currently applied, charted in the app"
                    : "a live query against the service, charted in the app";

                this._pushMessage("assistant", sMessage, oAction.bullets, sBasis,
                    oAction.prompts, true, this._lastChart);

                this._placeInlineChart(oResult.createFrame("14rem"));
            }.bind(this)).catch(function (oError) {
                Logger.error("ChatMixin", "chart could not be built", oError.message);
                this._pushMessage("assistant", "I couldn't build that chart: " + oError.message);
            }.bind(this));
        },

        /** Drops the chart into the bubble that was just added. */
        _placeInlineChart: function (oVizFrame) {
            var oView = this.base.getView();
            setTimeout(function () {
                var oList = oView.byId("novaMessageList");
                var aItems = (oList && oList.getItems && oList.getItems()) || [];
                var oLast = aItems[aItems.length - 1];
                if (!oLast) {
                    return;
                }
                var oHost = findControl(oLast, function (oControl) {
                    return oControl.hasStyleClass && oControl.hasStyleClass("novaMsgChart");
                });
                if (oHost) {
                    oHost.destroyItems();
                    oHost.addItem(oVizFrame);
                    this._syncDockLayout();
                    this._scrollToLatest();
                }
            }.bind(this), 60);
        },

        /** Opens the last chart full screen, as a fresh frame. */
        onExpandChart: function () {
            if (!this._lastChart) {
                return;
            }
            this._showChart(this._lastChart.createFrame("26rem"), this._lastChart.title);
        },

        _showChart: function (oVizFrame, sTitle) {
            var oView = this.base.getView();
            this._oChatModel.setProperty("/chartTitle", sTitle);

            var fnPlace = function (oDialog) {
                var oHost = oView.byId("novaChartHost");
                if (oHost) {
                    oHost.destroyItems();
                    oHost.addItem(oVizFrame);
                }
                oDialog.open();
            };

            if (!this._oChartDialogPromise) {
                this._oChartDialogPromise = Fragment.load({
                    id: oView.getId(),
                    name: "nova.copilot.ChartDialog",
                    controller: this
                }).then(function (oDialog) {
                    oDialog.setModel(this._oChatModel, "aiChat");
                    oView.addDependent(oDialog);
                    return oDialog;
                }.bind(this));
            }
            this._oChartDialogPromise.then(fnPlace);
        },

        onChartDialogClose: function () {
            if (!this._oChartDialogPromise) {
                return;
            }
            this._oChartDialogPromise.then(function (oDialog) {
                oDialog.close();
            });
        },

        /**
         * Bulk Excel upload entry point. Only meaningful from a List Report
         * (creating many new rows in an entity set, not editing one open
         * record), so this is the one dock feature gated by page type right
         * at the button press, the same way onDocumentSelected gates on
         * page.editable before going any further.
         */
        onBulkUploadPress: function () {
            var oPage = this._activePageInfo();
            if (oPage.pageType !== "ListReport" || !oPage.entitySet) {
                this._pushMessage("assistant",
                    "Bulk upload works from a list - open a list report first.");
                return;
            }
            this._openBulkUploadDialog(oPage);
        },

        _setBulkUploadStatus: function (sText, bIsError) {
            if (this._oBulkUpload && this._oBulkUpload.reviewModel) {
                this._oBulkUpload.reviewModel.setProperty("/statusText", sText || "");
                this._oBulkUpload.reviewModel.setProperty("/isError", !!bIsError);
            }
        },

        _openBulkUploadDialog: function (oPage) {
            var oView = this.base.getView();
            var oODataModel = oView.getModel();
            var oReviewModel = new JSONModel({ rows: [], cleanCount: 0, statusText: "", isError: false });
            this._oBulkUpload = {
                entitySet: oPage.entitySet,
                odataModel: oODataModel,
                fields: [],
                reviewModel: oReviewModel,
                dialog: null
            };

            var fnOpen = function (oDialog) {
                this._oBulkUpload.dialog = oDialog;
                oDialog.setModel(oReviewModel, "bulkUpload");
                var oHost = oView.byId("novaBulkUploadHost");
                if (oHost) {
                    oHost.destroyItems();
                }
                oDialog.open();
            }.bind(this);

            if (!this._oBulkUploadDialogPromise) {
                this._oBulkUploadDialogPromise = Fragment.load({
                    id: oView.getId(),
                    name: "nova.copilot.BulkUploadDialog",
                    controller: this
                }).then(function (oDialog) {
                    oView.addDependent(oDialog);
                    return oDialog;
                });
            }
            this._oBulkUploadDialogPromise.then(fnOpen);
        },

        /**
         * Runs one bulk-upload step (download / parse / submit) with a hard
         * re-entrancy guard plus a busy dialog - the direct fix for records
         * getting created twice: without this, a second click (or even the
         * same click registering twice) could call submitRows again before
         * the first call's OData batch had even finished. setBusy(true)
         * both shows a spinner AND blocks all interaction with the dialog
         * natively, so there is no disabled-button timing gap to race.
         */
        _runBulkUploadStep: function (sBusyText, fnAsync) {
            var oCtx = this._oBulkUpload;
            if (!oCtx || oCtx.busy) {
                return;
            }
            oCtx.busy = true;
            if (oCtx.dialog) {
                oCtx.dialog.setBusyIndicatorDelay(0);
                oCtx.dialog.setBusy(true);
            }
            this._setBulkUploadStatus(sBusyText, false);

            fnAsync().finally(function () {
                oCtx.busy = false;
                if (oCtx.dialog) {
                    oCtx.dialog.setBusy(false);
                }
            });
        },

        onBulkDownloadTemplate: function () {
            var oCtx = this._oBulkUpload;
            if (!oCtx) {
                return;
            }
            this._runBulkUploadStep("Building the template...", function () {
                return BulkUpload.buildTemplate(oCtx.odataModel, oCtx.entitySet).then(function (oResult) {
                    this._setBulkUploadStatus("Downloaded " + oResult.fileName + " - fill in rows and upload it back below.", false);
                }.bind(this)).catch(function (oError) {
                    Logger.error("ChatMixin", "bulk template build failed", oError.message);
                    this._setBulkUploadStatus("Could not build the template: " + oError.message, true);
                }.bind(this));
            }.bind(this));
        },

        onBulkFileSelected: function (oEvent) {
            var oFile = oEvent.getParameter("files") && oEvent.getParameter("files")[0];
            var oUploader = oEvent.getSource();
            if (oUploader.clear) {
                oUploader.clear();
            }
            if (!oFile || !this._oBulkUpload) {
                return;
            }

            var oCtx = this._oBulkUpload;
            var oView = this.base.getView();

            this._runBulkUploadStep("Reading " + oFile.name + "...", function () {
                return BulkUpload.parseUpload(oFile, oCtx.odataModel, oCtx.entitySet).then(function (oResult) {
                    oCtx.fields = oResult.fields;
                    var iClean = oResult.rows.filter(function (r) { return !r.hasIssues; }).length;
                    var iIssues = oResult.rows.length - iClean;
                    oCtx.reviewModel.setProperty("/rows", oResult.rows);
                    oCtx.reviewModel.setProperty("/cleanCount", iClean);
                    this._setBulkUploadStatus(oResult.rows.length + " row(s) read, " + iClean + " ready to create" +
                        (iIssues ? ", " + iIssues + " need attention before you can create them" : "") + ".", false);

                    var oHost = oView.byId("novaBulkUploadHost");
                    if (oHost) {
                        oHost.destroyItems();
                        oHost.addItem(BulkUpload.buildReviewTable(oResult.fields, oCtx.reviewModel));
                    }
                }.bind(this)).catch(function (oError) {
                    Logger.error("ChatMixin", "bulk upload parse failed", oError.message);
                    this._setBulkUploadStatus("Could not read that file: " + oError.message, true);
                }.bind(this));
            }.bind(this));
        },

        /**
         * Second way to stage rows in the same dialog/grid: one or more
         * invoice documents (text PDFs or images - the model does its own
         * vision OCR, no separate OCR library) instead of a filled Excel
         * template. Appends onto whatever's already staged (an earlier
         * Excel upload, or an earlier invoice batch) rather than replacing
         * it, so several uploads in one dialog session combine into one
         * list before the single Create press.
         */
        onInvoiceFilesSelected: function (oEvent) {
            // The "files" event parameter is the live FileList of the
            // uploader's inner <input> (confirmed in FileUploader's own
            // source: fireChange({files: this.FUEl.files})), and clear()
            // resets that form - emptying the very same list. Snapshot the
            // File objects (immutable blobs, safe to hold) into a real
            // array BEFORE clearing, or every selection arrives empty and
            // the handler silently does nothing.
            var aFiles = Array.prototype.slice.call(oEvent.getParameter("files") || []);
            var oUploader = oEvent.getSource();
            if (oUploader.clear) {
                oUploader.clear();
            }
            if (!aFiles.length || !this._oBulkUpload) {
                return;
            }

            var oCtx = this._oBulkUpload;
            var oView = this.base.getView();

            this._runBulkUploadStep("Reading " + aFiles.length + " document(s)...", function () {
                return BulkUpload.buildRowsFromDocuments(aFiles, oCtx.odataModel, oCtx.entitySet)
                    .then(function (oResult) {
                        oCtx.fields = oResult.fields;
                        var aExistingRows = oCtx.reviewModel.getProperty("/rows") || [];
                        var aAllRows = aExistingRows.concat(oResult.rows);
                        // same formula recomputeRow uses - previously-staged
                        // rows the user already excluded must stay out of the
                        // count, or the Create button's number lies after an
                        // append
                        var iClean = aAllRows.filter(function (r) {
                            return !r.excluded && !r.hasIssues;
                        }).length;

                        oCtx.reviewModel.setProperty("/rows", aAllRows);
                        oCtx.reviewModel.setProperty("/cleanCount", iClean);

                        var aNamed = oResult.rows.length
                            ? [oResult.rows.length + " item(s) from " +
                                this._uniqueSourceNames(oResult.rows).join(", ")]
                            : [];
                        var aProblems = (oResult.unreadable || []).map(function (u) {
                            return u.name + ": " + u.message;
                        });
                        this._setBulkUploadStatus(
                            (aNamed.length ? "Added " + aNamed[0] + " - " + aAllRows.length + " total staged." : "") +
                            (aProblems.length ? (aNamed.length ? " " : "") + aProblems.join(" ") : ""),
                            !oResult.rows.length && !!aProblems.length);

                        // rebuilt (not just re-bound) because bShowSource may
                        // be flipping on for the first time this session -
                        // cheap and safe since every edit is already
                        // committed to oReviewModel via each Input's own
                        // "change" handler before a new file selection can
                        // happen at all
                        var oHost = oView.byId("novaBulkUploadHost");
                        if (oHost) {
                            oHost.destroyItems();
                            var bShowSource = aAllRows.some(function (r) { return r.source; });
                            oHost.addItem(BulkUpload.buildReviewTable(oCtx.fields, oCtx.reviewModel, bShowSource));
                        }
                    }.bind(this)).catch(function (oError) {
                        Logger.error("ChatMixin", "invoice upload failed", oError.message);
                        this._setBulkUploadStatus("Could not read those documents: " + oError.message, true);
                    }.bind(this));
            }.bind(this));
        },

        /**
         * Fires INSTEAD of "change" when a selected file's extension doesn't
         * match the uploader's fileType list - confirmed in FileUploader's
         * own source: it resets the input and returns before ever reaching
         * the code that fires "change", so without this handler a mismatched
         * file (an iPhone .heic photo is the common case - vision models here
         * need jpg/png/webp) produced total silence: no status text, no
         * error, nothing - exactly "I pick a file and nothing happens".
         */
        onInvoiceFileTypeMismatch: function (oEvent) {
            var sFileName = oEvent.getParameter("fileName") || "that file";
            this._setBulkUploadStatus(
                "'" + sFileName + "' isn't a supported type - upload a PDF, JPG, PNG or WEBP " +
                "(an iPhone photo saved as .heic needs converting to JPG first).", true);
        },

        _uniqueSourceNames: function (aRows) {
            var aSeen = [];
            aRows.forEach(function (r) {
                if (r.source && aSeen.indexOf(r.source) === -1) {
                    aSeen.push(r.source);
                }
            });
            return aSeen;
        },

        /**
         * THE ONLY code path in the entire bulk-upload feature that may
         * actually write to the OData service - a direct response to a
         * user pressing this specific button, nothing else. There is no AI
         * action that reaches this function. Routed through
         * _runBulkUploadStep so a second click while the first create is
         * still in flight is a no-op, not a second batch of creates.
         */
        onConfirmBulkUpload: function () {
            var oCtx = this._oBulkUpload;
            if (!oCtx) {
                return;
            }
            var aRows = oCtx.reviewModel.getProperty("/rows") || [];

            this._runBulkUploadStep("Creating records...", function () {
                return BulkUpload.submitRows(oCtx.odataModel, oCtx.entitySet, oCtx.fields, aRows).then(function (oResult) {
                    MessageToast.show("Created " + oResult.created + " record(s).");
                    this._pushMessage("assistant",
                        "Created " + oResult.created + " " + oCtx.entitySet + " record(s) from your upload.");
                    this.onBulkUploadDialogClose();
                }.bind(this)).catch(function (oError) {
                    Logger.error("ChatMixin", "bulk create failed", oError.message);
                    this._setBulkUploadStatus("Could not create the records: " + oError.message, true);
                    MessageToast.show("Create failed - see the message below for details.");
                }.bind(this));
            }.bind(this));
        },

        onBulkUploadDialogClose: function () {
            if (!this._oBulkUploadDialogPromise) {
                return;
            }
            this._oBulkUploadDialogPromise.then(function (oDialog) {
                oDialog.close();
            });
        },

        onBulkUploadDialogClosed: function () {
            this._oBulkUpload = null;
        },

        /**
         * Pins the chart THIS message bubble showed - reads the message's
         * own chartRef (set by _runChart at push time), not the possibly-
         * newer _lastChart, so pinning an older chart bubble is correct
         * even after a more recent chart has been built since.
         */
        /**
         * Pins the chart, then separately requests a data-grounded insight
         * for it - AiClient.describeChart is the one place in this dock
         * that ever sees real numbers (already-aggregated category totals,
         * never record values), and it only runs for charts someone cared
         * enough about to put on the board, not every chart built in chat.
         */
        onPinChartToWorkboard: function (oEvent) {
            var oCtx = oEvent.getSource().getBindingContext("aiChat");
            var oMessage = oCtx && oCtx.getObject();
            if (!oMessage || !oMessage.chartRef) {
                return;
            }
            var bConsent = !!this._oChatModel.getData().aiDataConsent;
            var oChartRef = oMessage.chartRef;
            var sTileId = Workboard.pin({
                type: "chart",
                title: oChartRef.title,
                createFrame: oChartRef.createFrame,
                // kept on the tile itself, not just used transiently for the
                // insight request below - the export needs these same
                // already-aggregated totals to render an actual data table
                // alongside the chart image, not just a picture of it
                chartSummary: oChartRef.chartSummary,
                insightPending: bConsent && !!oChartRef.chartSummary
            });
            this._pushMessage("assistant", "Pinned \"" + oChartRef.title + "\" to the workboard." +
                (bConsent ? "" : " Turn on \"Let AI read data\" in the header to also get an AI insight for it."));

            // describeChart is the one place the AI ever sees real
            // (aggregated) data - gated behind the same explicit consent
            // toggle as field-compare filters, not automatic regardless of
            // what the user has or hasn't opted into
            if (bConsent && oChartRef.chartSummary) {
                AiClient.describeChart(oChartRef.chartSummary).then(function (sInsight) {
                    Workboard.setInsight(sTileId, { pending: false, text: sInsight });
                    this._refreshWorkboardCanvasIfOpen();
                }.bind(this)).catch(function (oError) {
                    Logger.error("ChatMixin", "chart insight failed", oError.message);
                    Workboard.setInsight(sTileId, { pending: false, text: "" });
                    this._refreshWorkboardCanvasIfOpen();
                }.bind(this));
            }
        },

        /** Re-renders the workboard canvas only if its dialog is already open, after an async update (an insight resolving, say). */
        _refreshWorkboardCanvasIfOpen: function () {
            if (this._oWorkboardDialogPromise) {
                this._oWorkboardDialogPromise.then(function (oDialog) {
                    if (oDialog.isOpen()) {
                        this._rebuildWorkboardCanvas();
                    }
                }.bind(this));
            }
        },

        onPinMessageToWorkboard: function (oEvent) {
            var oCtx = oEvent.getSource().getBindingContext("aiChat");
            var oMessage = oCtx && oCtx.getObject();
            if (!oMessage || (!oMessage.text && !(oMessage.bullets && oMessage.bullets.length))) {
                return;
            }
            Workboard.pin({
                type: "insight",
                title: oMessage.text ? oMessage.text.substring(0, 60) : "Note",
                text: oMessage.text || "",
                bullets: oMessage.bullets || []
            });
            this._pushMessage("assistant", "Pinned that to the workboard.");
        },

        /**
         * Rebuilds the workboard canvas from the registry's current tile
         * list - called on open, after a remove, and after "Add note", so
         * all three stay in lockstep with exactly one piece of logic.
         */
        _rebuildWorkboardCanvas: function () {
            var oView = this.base.getView();
            var oHost = oView.byId("novaWorkboardCanvasHost");
            if (!oHost) {
                return;
            }
            oHost.destroyItems();
            var oCanvas = Workboard.buildCanvas(function (sTileId) {
                Workboard.unpin(sTileId);
                this._rebuildWorkboardCanvas();
            }.bind(this));
            oHost.addItem(oCanvas);
            setTimeout(function () { Workboard.renderPendingCharts(oCanvas); }, 60);
        },

        onOpenWorkboard: function () {
            var oView = this.base.getView();
            var oWorkboardModel = Workboard.getModel();

            var fnOpen = function (oDialog) {
                this._oWorkboardDialog = oDialog;
                oDialog.setModel(oWorkboardModel, "workboard");
                this._rebuildWorkboardCanvas();
                oDialog.open();
            }.bind(this);

            if (!this._oWorkboardDialogPromise) {
                this._oWorkboardDialogPromise = Fragment.load({
                    id: oView.getId(),
                    name: "nova.copilot.WorkboardDialog",
                    controller: this
                }).then(function (oDialog) {
                    oView.addDependent(oDialog);
                    return oDialog;
                });
            }
            this._oWorkboardDialogPromise.then(fnOpen);
        },

        _setWorkboardStatus: function (sText, bIsError) {
            Workboard.getModel().setProperty("/statusText", sText || "");
            Workboard.getModel().setProperty("/isError", !!bIsError);
        },

        /**
         * Same re-entrancy guard as _runBulkUploadStep, and for the same
         * reason: export is slow (sequential chart snapshotting) and
         * nothing stopped a second click from starting a second export
         * while the first was still running.
         */
        _runWorkboardStep: function (sBusyText, fnAsync) {
            if (this._workboardBusy) {
                return;
            }
            this._workboardBusy = true;
            if (this._oWorkboardDialog) {
                this._oWorkboardDialog.setBusyIndicatorDelay(0);
                this._oWorkboardDialog.setBusy(true);
            }
            this._setWorkboardStatus(sBusyText, false);

            fnAsync().finally(function () {
                this._workboardBusy = false;
                if (this._oWorkboardDialog) {
                    this._oWorkboardDialog.setBusy(false);
                }
            }.bind(this));
        },

        onWorkboardAddNote: function () {
            Workboard.addNote();
            this._rebuildWorkboardCanvas();
        },

        onWorkboardExportPdf: function () {
            var oPage = this._activePageInfo();
            this._runWorkboardStep("Preparing PDF...", function () {
                return WorkboardExporter.exportPdf(Workboard.getAll(), {
                    title: (oPage.entitySet || "Nova Copilot") + " report",
                    onProgress: function (iDone, iTotal, sTitle) {
                        this._setWorkboardStatus("Rendering chart " + iDone + " of " + iTotal +
                            (sTitle ? " (\"" + sTitle + "\")" : "") + "...", false);
                    }.bind(this)
                }).then(function () {
                    MessageToast.show("PDF exported.");
                    this._setWorkboardStatus("", false);
                }.bind(this)).catch(function (oError) {
                    Logger.error("ChatMixin", "PDF export failed", oError.message);
                    this._setWorkboardStatus("Could not export the PDF: " + oError.message, true);
                    MessageToast.show("PDF export failed - see the message below for details.");
                }.bind(this));
            }.bind(this));
        },

        onWorkboardExportPptx: function () {
            var oPage = this._activePageInfo();
            this._runWorkboardStep("Preparing PPTX...", function () {
                return WorkboardExporter.exportPptx(Workboard.getAll(), {
                    title: (oPage.entitySet || "Nova Copilot") + " report",
                    onProgress: function (iDone, iTotal, sTitle) {
                        this._setWorkboardStatus("Rendering chart " + iDone + " of " + iTotal +
                            (sTitle ? " (\"" + sTitle + "\")" : "") + "...", false);
                    }.bind(this)
                }).then(function () {
                    MessageToast.show("PPTX exported.");
                    this._setWorkboardStatus("", false);
                }.bind(this)).catch(function (oError) {
                    Logger.error("ChatMixin", "PPTX export failed", oError.message);
                    this._setWorkboardStatus("Could not export the PPTX: " + oError.message, true);
                    MessageToast.show("PPTX export failed - see the message below for details.");
                }.bind(this));
            }.bind(this));
        },

        onWorkboardDialogClose: function () {
            if (!this._oWorkboardDialogPromise) {
                return;
            }
            this._oWorkboardDialogPromise.then(function (oDialog) {
                oDialog.close();
            });
        },

        onWorkboardDialogClosed: function () {},

        /**
         * Sorts the table the user is already looking at, rather than listing
         * records back at them in the chat. The table is the display surface -
         * reordering it answers "show me the most expensive" far better than a
         * wall of text, and leaves the result explorable.
         */
        _runSort: function (oAction) {
            var oPage = this._activePageInfo();
            var oContext = this._collectContext();
            var oSort = oAction.sort || {};

            var bKnown = ((oContext.entity || {}).properties || []).some(function (oProp) {
                return oProp.name === oSort.field;
            });
            if (!bKnown) {
                Logger.warn("ChatMixin", "sort requested on unknown field '" + oSort.field + "'");
                this._pushMessage("assistant", "There is no field called " + oSort.field + " to sort by.");
                return;
            }

            var oTable = oPage.table;
            if (!oTable) {
                this._pushMessage("assistant", "I couldn't find a table on this screen to sort.");
                return;
            }

            var bDescending = oSort.direction === "desc";

            // Register the sorter BEFORE anything triggers a rebind, so whichever
            // rebind happens next already carries it.
            if (oTable.attachBeforeRebindTable && !oTable._novaSortHooked) {
                oTable._novaSortHooked = true;
                oTable.attachBeforeRebindTable(function (oEvent) {
                    if (!this._novaSorters || !this._novaSorters.length) {
                        return;
                    }
                    var oParams = oEvent.getParameter("bindingParams");
                    var aExisting = oParams.sorter;
                    aExisting = aExisting ? [].concat(aExisting) : [];
                    // ours leads, the table's own sorters stay as tiebreakers
                    oParams.sorter = this._novaSorters.concat(aExisting);
                    Logger.step("ChatMixin", "applied sort during table rebind");
                }.bind(this));
            }
            this._novaSorters = [new Sorter(oSort.field, bDescending)];

            var bFiltered = !!(oAction.filters && oAction.filters.length);

            // field-compare resolution (only ever present when the user
            // opted into AI data consent) needs a real query first, so the
            // whole rest of this function - the try/catch and the final
            // message - now runs inside this .then(), which is an
            // immediate no-op resolve for the (overwhelmingly common)
            // plain-sort-or-plain-filter case
            var pFilterResolved = bFiltered
                ? this._resolveFieldCompareFilters(oAction.filters, oPage, oContext)
                : Promise.resolve(null);

            // MUST be returned, not just called - confirmed live this was a
            // real bug (same class as _handleAction's): callers that chain
            // multiple actions in sequence (_runSteps, in particular) need
            // this promise to actually resolve only once the sort/filter is
            // truly applied, not immediately just because this function
            // returned.
            return pFilterResolved.then(function (aResolvedFilters) {
            var bSortFailed = false;
            // the known failure shapes (unknown field, bad value) are
            // already caught upstream in bKnown/ActionApplier's own
            // validation - this is the backstop for anything a table
            // rebind/sort call could still throw unexpectedly, so a sort
            // request can never silently break the chat
            try {
                if (bFiltered) {
                    // search() rebinds on its own - triggering a second rebind here
                    // raced the first and could cancel it, leaving an empty table
                    ActionApplier.apply({ action: "filter", filters: aResolvedFilters, message: "" }, {
                        filterBar: oPage.filterBar,
                        entityMeta: oContext.entity,
                        showMessage: function () {}
                    });
                } else if (oTable.rebindTable) {
                    // The real bug a sort-only request was hitting: SmartTable's
                    // own rebindTable(), called with no argument, only does a
                    // real rebind if it judges something "meaningful" changed -
                    // and its equality check compares OData request parameters
                    // and the binding path, never the sorter. A sort-only
                    // change always looked like "nothing changed" to it, so it
                    // fell through to a plain oBinding.sort() on the EXISTING
                    // binding instead of a real rebind - confirmed by reading
                    // SmartTable.js's own source directly. That, in turn, hits
                    // ODataListBinding#sort's client-mode branch whenever
                    // operationMode is "Auto" and the table's row count is
                    // under the auto-threshold (true here - a ~100-row table is
                    // exactly what Auto mode is designed to switch to
                    // client-side for) - which just re-orders whatever rows are
                    // already cached, no server request at all. That's the
                    // literal "adjusting the position of line items instead of
                    // applying the batch query" behavior reported live.
                    // rebindTable's own bForceRebind parameter (public,
                    // documented) exists specifically to bypass that
                    // short-circuit and guarantee a genuine request - the same
                    // guarantee the filter path above already gets implicitly
                    // via SmartFilterBar's own search() wiring, which is why
                    // only sort (not filter) showed this symptom.
                    oTable.rebindTable(true);
                } else {
                    var oInner = oTable.getTable && oTable.getTable();
                    var oBinding = oInner && oInner.getBinding &&
                        (oInner.getBinding("items") || oInner.getBinding("rows"));
                    if (oBinding) {
                        oBinding.sort(this._novaSorters);
                        // same reasoning as above for tables with no SmartTable
                        // wrapper to force through - without this, a cached/
                        // client-mode binding would just reorder locally here too
                        if (oBinding.refresh) {
                            oBinding.refresh(true);
                        }
                    }
                }
            } catch (oError) {
                bSortFailed = true;
                Logger.error("ChatMixin", "applying the sort failed", oError.message);
            }

            if (bSortFailed) {
                this._pushMessage("assistant", "I couldn't sort by " + oSort.field + " - the table is unchanged.");
                return;
            }

            Logger.step("ChatMixin", "sorted the table by " + oSort.field +
                (bDescending ? " descending" : " ascending"));

            this._pushMessage("assistant",
                oAction.message || ("Sorted the list by " + oSort.field +
                    (bDescending ? ", highest first." : ", lowest first.")),
                oAction.bullets, "the table on screen, re-sorted", oAction.prompts);
            }.bind(this));
        },

        /**
         * Reads an uploaded document and offers the values it finds for the
         * record currently open for editing. The file itself is never uploaded -
         * it is read in the browser and only the extracted text is sent, and
         * only after the user chose the file. Nothing is saved either way.
         */
        onDocumentSelected: function (oEvent) {
            var oFile = oEvent.getParameter("files") && oEvent.getParameter("files")[0];
            var oUploader = oEvent.getSource();
            if (oUploader.clear) {
                oUploader.clear();
            }
            if (!oFile) {
                return;
            }

            var oPage = this._activePageInfo();
            if (!oPage.editable) {
                this._pushMessage("assistant",
                    "Open the record for editing first, then I can fill it in from a document.");
                return;
            }

            if (!DocumentReader.isSupported(oFile)) {
                Logger.warn("ChatMixin", "unsupported upload: " + oFile.name);
                this._pushMessage("assistant", DocumentReader.describeUnsupported(oFile));
                return;
            }

            this._pushMessage("user", "Read " + oFile.name + " and fill in the form");

            var oData = this._oChatModel.getData();
            oData.busy = true;
            this._oChatModel.setData(oData);

            // the RICH description (real creatable/updatable/required flags
            // plus the key list), not ContextCollector's thin prompt shape -
            // with the thin shape every writability check silently passed
            // and key fields were offered to the model
            var oDescribed = FieldPopulator.describeEntityType(
                this.base.getView().getModel(), oPage.entitySet) || this._collectContext().entity;
            var aFields = DocumentReader.writableFields(oDescribed, oPage.createMode);

            DocumentReader.read(oFile).then(function (oDocument) {
                return AiClient.extractFields(oDocument.text, aFields).then(function (oResult) {
                    this._applyExtracted(oResult, oDocument, oPage, oDescribed);
                }.bind(this));
            }.bind(this)).catch(function (oError) {
                Logger.error("ChatMixin", "document extraction failed", oError.message);
                this._pushMessage("assistant", "I couldn't read that document: " + oError.message);
            }.bind(this)).finally(function () {
                var oD = this._oChatModel.getData();
                oD.busy = false;
                this._oChatModel.setData(oD);
            }.bind(this));
        },

        _applyExtracted: function (oResult, oDocument, oPage, oEntityMeta) {
            var aValues = oResult.values || [];

            if (!aValues.length) {
                this._pushMessage("assistant",
                    oResult.message || "I couldn't find any of this record's fields in that document.",
                    [], "the document you uploaded");
                return;
            }

            var oApplied = FieldPopulator.run(aValues, {
                model: this.base.getView().getModel(),
                context: oPage.bindingContext,
                entitySet: oPage.entitySet,
                // the rich shape from describeEntityType - its real
                // creatable/updatable flags are what make run()'s own
                // writability checks actually bite
                entityMeta: oEntityMeta,
                createMode: oPage.createMode
            });

            var aBullets = oApplied.applied.map(function (oItem) {
                return "**" + (oItem.label || oItem.field) + "** - " + oItem.value;
            }).concat(oApplied.skipped.map(function (oItem) {
                return "**" + oItem.field + "** - not set (" + oItem.reason + ")";
            }));

            (oResult.notFound || []).forEach(function (sField) {
                aBullets.push("**" + sField + "** - not mentioned in the document");
            });

            var sMessage = "From **" + oDocument.name + "** I filled in " +
                oApplied.applied.length + " field(s). Check them and press Save:";
            if (oDocument.truncated) {
                sMessage += " (only the first " + DocumentReader.MAX_CHARS +
                    " characters were read)";
            }

            this._pushMessage("assistant", sMessage, aBullets,
                "the document you uploaded - nothing has been saved");
        },

        /**
         * Opens a record on the object page, optionally switching it straight
         * into edit mode. Uses the template's own navigation controller and the
         * model's key formatting, so it works for whatever keys the entity has.
         */
        _runNavigate: function (oAction) {
            var oView = this.base.getView();
            var oPage = this._activePageInfo();
            var oModel = oView.getModel();
            var oTarget = oAction.target || {};
            var oKeys = oTarget.keys || {};

            if (!Object.keys(oKeys).length) {
                this._pushMessage("assistant", "Tell me which record to open and I'll go there.");
                return;
            }

            var sPath;
            try {
                sPath = "/" + oModel.createKey(oTarget.entitySet || oPage.entitySet, oKeys);
            } catch (oError) {
                Logger.error("ChatMixin", "could not build a key path", oError.message);
                this._pushMessage("assistant", "I couldn't work out which record that is.");
                return;
            }

            var oAppComponent = AppKnowledge.resolveAppComponent(Component.getOwnerComponentFor(oView));
            var oNavController = oAppComponent && oAppComponent.getNavigationController &&
                oAppComponent.getNavigationController();

            Logger.step("ChatMixin", "navigation options", {
                path: sPath,
                hasNavController: !!oNavController,
                navMethods: oNavController
                    ? Object.keys(oNavController).filter(function (sKey) {
                        return typeof oNavController[sKey] === "function";
                    }).slice(0, 12)
                    : null
            });

            // anything to do once we land is queued, because navigating rebuilds
            // the page and this controller stops being the active one
            if (oAction.edit || (oAction.values && oAction.values.length)) {
                oPendingPopulate = {
                    edit: true,
                    values: oAction.values || [],
                    path: sPath
                };
            }

            this._pushMessage("assistant",
                oAction.message || ("Opening " + sPath.replace(/^\//, "") +
                    (oAction.edit ? " for editing." : ".")),
                oAction.bullets, "the app's own navigation", oAction.prompts);

            this._navigateTo(sPath, oNavController, oModel);
        },

        /**
         * Opens a record. The template's navigation controller is tried first,
         * then the router hash - a context built by hand does not always carry
         * what navigateToContext expects, so the hash is the dependable
         * fallback and we verify the hash actually changed.
         */
        _navigateTo: function (sPath, oNavController, oModel) {
            var sKey = sPath.replace(/^\//, "");
            var sBefore = window.location.hash;

            if (oNavController && oNavController.navigateToContext) {
                try {
                    oNavController.navigateToContext(oModel.createBindingContext(sPath));
                    Logger.step("ChatMixin", "asked the navigation controller to open " + sKey);
                } catch (oError) {
                    Logger.warn("ChatMixin", "navigateToContext threw", oError.message);
                }
            }

            setTimeout(function () {
                if (window.location.hash !== sBefore) {
                    Logger.step("ChatMixin", "navigation succeeded");
                    return;
                }
                Logger.warn("ChatMixin", "hash did not change - falling back to the router hash");

                try {
                    HashChanger.getInstance().setHash(sKey);
                    Logger.step("ChatMixin", "set the route hash to " + sKey);
                } catch (oError) {
                    Logger.error("ChatMixin", "could not set the route hash", oError.message);
                }

                setTimeout(function () {
                    if (window.location.hash === sBefore) {
                        Logger.error("ChatMixin", "navigation did not happen");
                        this._pushMessage("assistant",
                            "I couldn't open that record automatically - selecting the row works.");
                    }
                }.bind(this), 600);
            }.bind(this), 400);
        },

        /**
         * Leaves the object page for the list it came from, carrying over any
         * sort or filter the user asked for in the same breath.
         */
        _runBack: function (oAction) {
            var oView = this.base.getView();
            var oAppComponent = AppKnowledge.resolveAppComponent(Component.getOwnerComponentFor(oView));
            var oNavController = oAppComponent && oAppComponent.getNavigationController &&
                oAppComponent.getNavigationController();

            if (oAction.sort || (oAction.filters && oAction.filters.length)) {
                oPendingTableAction = {
                    sort: oAction.sort,
                    filters: oAction.filters || []
                };
                Logger.step("ChatMixin", "queued a table action for after going back",
                    oPendingTableAction);
            }

            this._pushMessage("assistant",
                oAction.message || "Going back to the list.",
                oAction.bullets, "the app's own navigation", oAction.prompts);

            Logger.step("ChatMixin", "navigating back to the list");

            if (oNavController && oNavController.navigateBack) {
                try {
                    oNavController.navigateBack();
                    return;
                } catch (oError) {
                    Logger.warn("ChatMixin", "navigateBack threw", oError.message);
                }
            }
            window.history.back();
        },

        /**
         * Runs when a page renders: the object page enters edit mode and applies
         * queued values; the list report applies a queued sort or filter.
         */
        _resumePending: function () {
            var oPage = this._getPageInfo();

            if (oPage.pageType === "ListReport" && oPendingTableAction) {
                var oWorkTable = oPendingTableAction;
                oPendingTableAction = null;
                Logger.step("ChatMixin", "applying the queued table action");
                // MUST wait for the sort/filter to actually finish before
                // running whatever steps were queued after it (e.g. "go
                // back, filter, AND chart it" - prompt.js explicitly
                // documents this as supported) - confirmed live this was a
                // real bug, the same class as _handleAction/_runSort not
                // returning their own promises: a chart step could run
                // against filter state that hadn't actually been applied
                // yet, because nothing here was waiting for it to finish.
                var pTableAction;
                if (oWorkTable.sort) {
                    pTableAction = this._runSort({
                        sort: oWorkTable.sort,
                        filters: oWorkTable.filters,
                        message: "Back on the list, sorted by " + oWorkTable.sort.field + "."
                    });
                } else if (oWorkTable.filters.length) {
                    pTableAction = this._handleAction({ action: "filter", filters: oWorkTable.filters,
                        message: "Back on the list, filtered." });
                } else {
                    pTableAction = Promise.resolve();
                }
                Promise.resolve(pTableAction).then(function () {
                    this._runPendingSteps();
                }.bind(this));
                return;
            }

            if (!oPendingPopulate) {
                this._runPendingSteps();
                return;
            }
            if (oPage.pageType !== "ObjectPage") {
                return;
            }

            if (!oPage.editable) {
                var oEdit = findControl(this.base.getView(), function (oControl) {
                    var sType = oControl.getMetadata && oControl.getMetadata().getName();
                    return (sType === "sap.m.Button" || sType === "sap.m.OverflowToolbarButton") &&
                        oControl.getVisible && oControl.getVisible() &&
                        oControl.getEnabled && oControl.getEnabled() &&
                        /^edit$/i.test((oControl.getText && oControl.getText()) || "");
                });
                if (oEdit) {
                    Logger.step("ChatMixin", "pressing Edit on the opened record");
                    oEdit.firePress();
                }
                return; // edit mode re-renders; we come back through here
            }

            var oWork = oPendingPopulate;
            oPendingPopulate = null;

            if (!oWork.values.length) {
                Logger.step("ChatMixin", "record opened in edit mode, nothing queued to fill");
                return;
            }

            Logger.step("ChatMixin", "applying " + oWork.values.length + " queued value(s)");
            var oContext = this._collectContext();
            var oResult = FieldPopulator.run(oWork.values, {
                model: this.base.getView().getModel(),
                context: oPage.bindingContext,
                entitySet: oPage.entitySet,
                entityMeta: oContext.entity,
                createMode: oPage.createMode
            });

            var aBullets = oResult.applied.map(function (oItem) {
                return "**" + (oItem.label || oItem.field) + "** - " + oItem.value;
            }).concat(oResult.skipped.map(function (oItem) {
                return "**" + oItem.field + "** - not set (" + oItem.reason + ")";
            }));

            this._pushMessage("assistant",
                "Opened the record and filled in " + oResult.applied.length +
                " field(s). Review them and press Save:",
                aBullets, "the document you uploaded - nothing has been saved");
        },

        /**
         * Runs one action and resolves when it has finished, so steps can be
         * sequenced. Navigation resolves immediately - the page change carries
         * on asynchronously and the remaining steps resume on the other side.
         */
        _dispatchAction: function (oAction) {
            if (!oAction || !oAction.action) {
                return Promise.resolve();
            }
            switch (oAction.action) {
                case "query":
                    return Promise.resolve(this._runQuery(oAction));
                case "populate":
                    return Promise.resolve(this._runPopulate(oAction));
                case "chart":
                    return Promise.resolve(this._runChart(oAction));
                case "sort":
                    return Promise.resolve(this._runSort(oAction));
                case "navigate":
                    return Promise.resolve(this._runNavigate(oAction));
                case "back":
                    return Promise.resolve(this._runBack(oAction));
                default:
                    return Promise.resolve(this._handleAction(oAction));
            }
        },

        /**
         * Runs a sequence of actions in order. A step that changes page parks
         * the rest, which _resumePending() picks up once the new page is ready.
         */
        _runSteps: function (aSteps) {
            var that = this;
            Logger.step("ChatMixin", "running " + aSteps.length + " step(s)",
                aSteps.map(function (oStep) {
                    return oStep.action;
                }));

            function next(iIndex) {
                if (iIndex >= aSteps.length) {
                    return Promise.resolve();
                }
                var oStep = aSteps[iIndex];

                // Going back when already on the list changes nothing, so no
                // re-render follows - parking the rest would strand them.
                if (oStep.action === "back" &&
                        that._activePageInfo().pageType === "ListReport") {
                    Logger.step("ChatMixin", "already on the list - skipping the back step");
                    return next(iIndex + 1);
                }

                if (oStep.action === "back" || oStep.action === "navigate") {
                    aPendingSteps = aSteps.slice(iIndex + 1);
                    Logger.step("ChatMixin", "page change - " + aPendingSteps.length +
                        " step(s) will resume after it");

                    // if the page never actually changes, run them anyway rather
                    // than leaving the request half done
                    setTimeout(function () {
                        if (aPendingSteps.length) {
                            Logger.warn("ChatMixin",
                                "no page change arrived - running the queued steps here");
                            that._runPendingSteps();
                        }
                    }, 2500);

                    return Promise.resolve(that._dispatchAction(oStep));
                }

                return Promise.resolve(that._dispatchAction(oStep)).then(function () {
                    return next(iIndex + 1);
                });
            }
            return next(0);
        },

        /** Continues a sequence that was interrupted by a page change. */
        _runPendingSteps: function () {
            if (!aPendingSteps.length) {
                return;
            }
            var aSteps = aPendingSteps;
            aPendingSteps = [];
            Logger.step("ChatMixin", "resuming " + aSteps.length + " queued step(s)");
            // let the new page settle before acting on it
            setTimeout(function () {
                this._runSteps(aSteps);
            }.bind(this), 500);
        },

        /**
         * Resolves "valueIsField" filter entries (field-to-field
         * comparisons - "below reorder level" and the like, only ever
         * present when the user turned AI data consent on, see prompt.js
         * and onToggleDataConsent) into plain literal id-based filters, via
         * one real query. The comparison itself happens in this plain JS
         * code, never the model - the model only ever chose WHICH two
         * fields to compare, it never sees or states which rows actually
         * match. Returns a Promise resolving to a filters array safe to
         * hand straight to ActionApplier.apply() - unchanged if there was
         * nothing to resolve, so this is a no-op fast path for every
         * ordinary filter request.
         */
        _resolveFieldCompareFilters: function (aFilters, oPage, oContext) {
            var aFieldCompare = (aFilters || []).filter(function (f) { return f && f.valueIsField; });
            if (!aFieldCompare.length) {
                return Promise.resolve(aFilters || []);
            }

            var aLiteralFilters = (aFilters || []).filter(function (f) { return !f.valueIsField; });

            // Consent is only ever documented to the model in prompt.js - there
            // was no enforcement of it here, so a model that ignored the
            // instruction (or the canned smart-suggest prompt) could still
            // trigger a real query and resolve a field-compare filter with
            // consent off. Checked again here as the actual gate, not just a
            // prompt-level request.
            if (!oContext.dataConsent) {
                Logger.warn("ChatMixin", "field-compare filter(s) requested without data consent - dropped");
                this._pushMessage("assistant",
                    "Comparing two fields like that needs \"Let AI read data\" turned on in the header - " +
                    "showing the rest without it.");
                return Promise.resolve(aLiteralFilters);
            }

            var oView = this.base.getView();
            var oODataModel = oView.getModel();
            var oDescribed = FieldPopulator.describeEntityType(oODataModel, oPage.entitySet);
            var sKeyField = oDescribed && oDescribed.keyFields && oDescribed.keyFields[0];

            if (!sKeyField) {
                Logger.warn("ChatMixin", "could not resolve a key field - dropping field-compare filter(s)");
                return Promise.resolve(aLiteralFilters);
            }

            var aValidFieldNames = (oDescribed.properties || []).map(function (p) { return p.name; });
            var aUsable = aFieldCompare.filter(function (f) {
                return aValidFieldNames.indexOf(f.field) !== -1 && aValidFieldNames.indexOf(f.value) !== -1;
            });
            if (!aUsable.length) {
                return Promise.resolve(aLiteralFilters);
            }

            var aSelect = [sKeyField];
            aUsable.forEach(function (f) {
                if (aSelect.indexOf(f.field) === -1) { aSelect.push(f.field); }
                if (aSelect.indexOf(f.value) === -1) { aSelect.push(f.value); }
            });

            // only numeric comparisons are meaningfully supported - matches
            // the kind of scenario this exists for ("below reorder level"),
            // not a general-purpose type-aware comparator
            var COMPARATORS = {
                EQ: function (a, b) { return a === b; },
                NE: function (a, b) { return a !== b; },
                GT: function (a, b) { return parseFloat(a) > parseFloat(b); },
                GE: function (a, b) { return parseFloat(a) >= parseFloat(b); },
                LT: function (a, b) { return parseFloat(a) < parseFloat(b); },
                LE: function (a, b) { return parseFloat(a) <= parseFloat(b); }
            };

            var oKeyProp = (oDescribed.properties || []).filter(function (p) { return p.name === sKeyField; })[0];
            var bKeyNumeric = /Edm\.(Int|Decimal|Double|Single|Byte)/.test((oKeyProp && oKeyProp.type) || "");
            var MAX_ROWS = 500;

            return DataQuery.run(
                { select: aSelect, top: MAX_ROWS },
                { model: oODataModel, entitySet: oPage.entitySet, entityMeta: oContext.entity, maxRows: MAX_ROWS }
            ).then(function (oResult) {
                var aMatchingKeys = oResult.rows.filter(function (oRow) {
                    return aUsable.every(function (f) {
                        var fnCompare = COMPARATORS[f.op] || COMPARATORS.LE;
                        // the field being compared against is named "value" on
                        // the raw filter object (f.compareField was never set -
                        // that name only exists on ActionApplier's own,
                        // differently-shaped internal fieldFilters entries) -
                        // reading the wrong property here meant every
                        // field-compare filter compared against undefined and
                        // so NEVER matched a single row, confirmed live as the
                        // cause of the bogus "no such record" sentinel filter.
                        return fnCompare(oRow[f.field], oRow[f.value]);
                    });
                }).map(function (oRow) { return oRow[sKeyField]; });

                Logger.step("ChatMixin", "resolved " + aUsable.length + " field-compare filter(s) to " +
                    aMatchingKeys.length + " matching record(s)" +
                    (oResult.rows.length >= MAX_ROWS ? " (checked the first " + MAX_ROWS + " rows only)" : ""));

                if (!aMatchingKeys.length) {
                    // an id filter that can never match is the honest way to
                    // express "nothing matched" - not silently dropping the
                    // constraint and showing everything instead. Say so in
                    // the chat too: without this, the user just sees a
                    // mystifying "<key> = -1" token in the filter bar
                    // (reported live as "there is no such product id as -1").
                    this._pushMessage("assistant",
                        "No records currently match that comparison, so the list shows none - " +
                        "the placeholder filter in the bar is how that empty result is expressed. " +
                        "Clear the filters to see everything again.");
                    return aLiteralFilters.concat([{
                        field: sKeyField, op: "EQ", value: bKeyNumeric ? "-1" : "__nova_no_match__"
                    }]);
                }

                return aLiteralFilters.concat(aMatchingKeys.map(function (vKey) {
                    return { field: sKeyField, op: "EQ", value: String(vKey) };
                }));
            }.bind(this)).catch(function (oError) {
                Logger.error("ChatMixin", "field-compare resolution failed", oError.message);
                return aLiteralFilters;
            });
        },

        /**
         * Returns a Promise now (it didn't before the field-compare-filter
         * resolution step was added) - confirmed live this was a real bug,
         * not just an oversight: anything that calls this and assumes the
         * action is done once it returns (_runSteps chaining multiple
         * actions in order, in particular) was moving on to the next step
         * before a filter had actually finished being resolved and applied,
         * since a bare `return;` with no value resolves a wrapping
         * Promise.resolve(...) immediately rather than waiting for it.
         */
        _handleAction: function (oAction) {
            var oPage = this._activePageInfo();

            // clearing the filters drops any sort the assistant applied too,
            // otherwise an old ordering silently outlives the request for it
            if (oAction && oAction.action === "clear" && this._novaSorters) {
                this._novaSorters = null;
                Logger.step("ChatMixin", "cleared the assistant's sort along with the filters");
            }
            var oContext = this._collectContext();

            if (oAction && oAction.action === "filter") {
                return this._resolveFieldCompareFilters(oAction.filters, oPage, oContext).then(function (aResolved) {
                    ActionApplier.apply(Object.assign({}, oAction, { filters: aResolved }), {
                        filterBar: oPage.filterBar,
                        entityMeta: oContext.entity,
                        showMessage: this._pushMessage.bind(this, "assistant")
                    });
                }.bind(this));
            }

            ActionApplier.apply(oAction, {
                filterBar: oPage.filterBar,
                entityMeta: oContext.entity,
                showMessage: this._pushMessage.bind(this, "assistant")
            });
            return Promise.resolve();
        },

        _setOpen: function (bOpen) {
            var oData = this._oChatModel.getData();
            oData.open = bOpen;
            this._oChatModel.setData(oData);

            // the container is sized and resizable only while the panel is shown
            var oContainer = document.getElementById("novaDockContainer");
            if (oContainer) {
                oContainer.classList.toggle("novaOpen", bOpen);
                if (!bOpen) {
                    oContainer.style.width = "";
                    oContainer.style.height = "";
                }
            }

            Logger.step("ChatMixin", bOpen ? "dock opened" : "dock collapsed to the launcher");

            if (bOpen) {
                this._loadKnowledge(false);
                setTimeout(this._syncDockLayout.bind(this), 0);
                this._scrollToLatest();
            }
        },

        /** Collapses to just the title bar, keeping the dock on screen. */
        onToggleMinimise: function () {
            var oData = this._oChatModel.getData();
            oData.minimised = !oData.minimised;
            this._oChatModel.setData(oData);

            var oContainer = document.getElementById("novaDockContainer");
            if (oContainer) {
                oContainer.classList.toggle("novaMinimised", oData.minimised);
            }
            Logger.step("ChatMixin", oData.minimised ? "dock minimised" : "dock expanded");

            if (!oData.minimised) {
                setTimeout(this._syncDockLayout.bind(this), 0);
                this._scrollToLatest();
            }
        },

        onToggleOpen: function () {
            this._setOpen(!this._oChatModel.getData().open);
        },

        // collapses back to the floating launcher rather than disappearing
        onChatClose: function () {
            this._setOpen(false);
        },

        onClearFiltersPress: function () {
            this._handleAction({ action: "clear", message: "Filters cleared." });
        },

        onClearConversation: function () {
            Logger.step("ChatMixin", "conversation cleared");
            var oData = this._oChatModel.getData();
            oData.messages = [];
            oData.hasMessages = false;
            this._oChatModel.setData(oData);
        },

        onPromptPress: function (oEvent) {
            var sPrompt = oEvent.getSource().getText();
            Logger.step("ChatMixin", "suggestion clicked: \"" + sPrompt + "\"");
            var oData = this._oChatModel.getData();
            oData.question = sPrompt;
            this._oChatModel.setData(oData);
            this.onSendPress();
        },

        onSendPress: function () {
            var oData = this._oChatModel.getData();
            var sQuestion = (oData.question || "").trim();
            if (!sQuestion || oData.busy) {
                return;
            }

            var aHistory = this._buildHistory(oData.messages);

            oData.messages.push({ role: "user", text: sQuestion, time: formatTime() });
            oData.hasMessages = true;
            oData.question = "";
            oData.busy = true;
            this._oChatModel.setData(oData);
            this._scrollToLatest();

            Logger.step("ChatMixin", "question asked: \"" + sQuestion + "\"");

            // Record values are never sent to the model. Anything that needs real
            // data comes back as a "query" which the app runs against the service,
            // so values are read rather than recalled.
            AiClient.ask(sQuestion, this._collectContext(), aHistory).then(function (oAction) {
                if (oAction && oAction.steps && oAction.steps.length) {
                    if (oAction.message) {
                        this._pushMessage("assistant", oAction.message, oAction.bullets,
                            oAction.basis, oAction.prompts);
                    }
                    return this._runSteps(oAction.steps);
                }
                if (oAction && oAction.action === "query") {
                    return this._runQuery(oAction);
                }
                if (oAction && oAction.action === "populate") {
                    return this._runPopulate(oAction);
                }
                if (oAction && oAction.action === "chart") {
                    return this._runChart(oAction);
                }
                if (oAction && oAction.action === "sort") {
                    return this._runSort(oAction);
                }
                if (oAction && oAction.action === "navigate") {
                    return this._runNavigate(oAction);
                }
                if (oAction && oAction.action === "back") {
                    return this._runBack(oAction);
                }
                return this._handleAction(oAction);
            }.bind(this)).catch(function (oError) {
                Logger.error("ChatMixin", "question failed", oError.message);
                this._pushMessage("assistant", "Sorry, something went wrong: " + oError.message);
            }.bind(this)).finally(function () {
                var oD = this._oChatModel.getData();
                oD.busy = false;
                this._oChatModel.setData(oD);
            }.bind(this));
        }
    };
});
