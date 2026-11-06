sap.ui.define([
    "sap/ui/model/json/JSONModel",
    "sap/m/VBox",
    "sap/m/HBox",
    "sap/m/Text",
    "sap/m/Input",
    "sap/m/TextArea",
    "sap/m/Button",
    "sap/m/List",
    "sap/m/CustomListItem",
    "sap/m/StandardListItem",
    "./Logger"
], function (JSONModel, VBox, HBox, Text, Input, TextArea, Button, List, CustomListItem, StandardListItem,
    Logger) {
    "use strict";

    /**
     * A shared, module-level pinned-tile registry - same lifetime as
     * ChatMixin's own oSharedModel (persists across page navigation within
     * a session, resets on reload, no new persistence layer). Generalises
     * the single _lastChart = {createFrame, title} shape ChatMixin already
     * uses for the chart dialog, keyed per tile instead of one mutable
     * field, so the same createFrame factory can be re-rendered for the
     * inline bubble, the full-screen dialog, the workboard tile, AND an
     * export snapshot without any of them fighting over one instance.
     */
    var oModel = null;
    var iNextId = 1;

    /**
     * Applies CSS classes to a JS-constructed control. A "class" key in a
     * JS constructor's settings object is NOT a real ManagedObject setting -
     * confirmed in ManagedObject.applySettings' own source: unknown keys hit
     * a no-op assert and are silently discarded ("class" is special-cased by
     * the XML view parser only). Every tile/canvas/insight class here used
     * to be passed that way, so none of the workboard's CSS ever actually
     * reached the DOM - the styling looked broken while the stylesheet was
     * fine. addStyleClass is the real API.
     */
    function styled(oControl, sClasses) {
        String(sClasses || "").split(" ").forEach(function (sClass) {
            if (sClass) {
                oControl.addStyleClass(sClass);
            }
        });
        return oControl;
    }

    function ensureModel() {
        if (!oModel) {
            oModel = new JSONModel({ tiles: [], statusText: "", isError: false });
        }
        return oModel;
    }

    function findTile(sId) {
        return ensureModel().getData().tiles.filter(function (t) { return t.id === sId; })[0];
    }

    function persist() {
        ensureModel().setData(ensureModel().getData());
    }

    function buildBulletList(aBullets) {
        var oList = new List({ showSeparators: "None" });
        (aBullets || []).forEach(function (sBullet) {
            oList.addItem(new StandardListItem({ title: sBullet, type: "Inactive" }));
        });
        return oList;
    }

    /**
     * Builds one tile's content. Chart tiles defer their actual VizFrame
     * rendering until after this is in the live DOM (same "render the host
     * first, inject the real chart a tick later" pattern
     * ChatMixin._placeInlineChart/_showChart already use), since createFrame
     * needs real layout to paint into. Text tiles (pinned chat answers AND
     * blank notes added directly on the board) are editable in place - a
     * plain TextArea bound straight back into the registry, so what you
     * type survives a reorder, a re-render, and feeds the export as-is.
     */
    function buildTile(oTile, fnOnRemove, iIndex) {
        var oContent = styled(new VBox(), "novaWorkboardTileContent");

        if (oTile.type === "chart") {
            // the chart host and the insight block are separate children of
            // oContent (not both bundled into one node) specifically so
            // renderPendingCharts's destroyItems() - which replaces the
            // host with a real VizFrame - can never wipe out the insight
            // text sitting next to it
            var oChartHost = styled(new VBox(), "novaWorkboardChartHost");
            oChartHost.data("novaWorkboardPendingChart", true);
            oContent.addItem(oChartHost);

            if (oTile.insightPending) {
                oContent.addItem(styled(new VBox({
                    items: [styled(new Text({ text: "Generating insight..." }), "novaWorkboardInsightText")]
                }), "novaWorkboardInsightBlock novaWorkboardInsightPending"));
            } else if (oTile.insightText) {
                // a small label plus a left accent bar (both pure CSS, via
                // the novaWorkboardInsightBlock class) so this clearly reads
                // as "the AI's commentary", distinct from plain body text
                oContent.addItem(styled(new VBox({
                    items: [styled(new Text({ text: oTile.insightText }), "novaWorkboardInsightText")]
                }), "novaWorkboardInsightBlock"));
            }
        } else {
            oContent.addItem(new TextArea({
                value: oTile.text || "",
                placeholder: "Write a note...",
                growing: true,
                width: "100%",
                liveChange: function (oEvent) {
                    var oLive = findTile(oTile.id);
                    if (oLive) {
                        oLive.text = oEvent.getParameter("value");
                        persist();
                    }
                }
            }));
            if (oTile.bullets && oTile.bullets.length) {
                oContent.addItem(buildBulletList(oTile.bullets));
            }
        }

        // Read-only by default, an Input only while actively editing - not
        // just nicer (a title that looks like an input box the rest of the
        // time isn't the polish asked for), it also fixes a second, related
        // problem: an always-editable Input filled nearly the whole header,
        // leaving almost no plain surface to grab for the drag gesture that
        // reorders tiles. A Text control doesn't intercept the mousedown,
        // so the drag can actually start from the title area again.
        var oTitleText = styled(new Text({
            text: oTile.title || "(untitled)"
        }), "novaWorkboardTileTitle novaWorkboardTileTitleText");
        function commitTitleEdit() {
            var sValue = oTitleInput.getValue();
            var oLive = findTile(oTile.id);
            if (oLive) {
                oLive.title = sValue;
                persist();
            }
            oTitleText.setText(sValue || "(untitled)");
            oTitleInput.setVisible(false);
            oTitleText.setVisible(true);
            oEditTitleButton.setIcon("sap-icon://edit");
            oEditTitleButton.setTooltip("Rename");
            oHeader.removeStyleClass("novaWorkboardEditing");
        }

        var oTitleInput = styled(new Input({
            value: oTile.title || "",
            visible: false,
            // Enter commits immediately
            submit: commitTitleEdit
        }), "novaWorkboardTileTitle");

        // One button, two states, rather than a separate pencil + checkmark
        // + relying on blur to notice you're done - blur alone turned out
        // unreliable here (confirmed live: there was no way back to the
        // read-only view once editing started), so this button is now the
        // single, explicit, always-visible way both in and back out.
        var oEditTitleButton = new Button({
            icon: "sap-icon://edit",
            type: "Transparent",
            tooltip: "Rename",
            press: function () {
                if (oTitleInput.getVisible()) {
                    commitTitleEdit();
                } else {
                    oTitleText.setVisible(false);
                    oTitleInput.setVisible(true);
                    oEditTitleButton.setIcon("sap-icon://accept");
                    oEditTitleButton.setTooltip("Done");
                    oHeader.addStyleClass("novaWorkboardEditing");
                    oTitleInput.focus();
                }
            }
        });

        var oRemoveButton = new Button({
            icon: "sap-icon://decline",
            type: "Transparent",
            tooltip: "Remove from workboard",
            press: function () {
                fnOnRemove(oTile.id);
            }
        });

        // grouped so hover-reveal (see .novaWorkboardHeaderActions in CSS)
        // fades them in together - a resting section shows just its number
        // and title, not a row of admin controls
        var oActions = styled(new HBox({
            items: [oEditTitleButton, oRemoveButton]
        }), "novaWorkboardHeaderActions");

        var oNumber = styled(new Text({ text: String((iIndex || 0) + 1) + "." }), "novaWorkboardTileNumber");

        // two rows, not one - number/actions on top, title on its own row
        // below at full width. In one row together, the title's flex:1 was
        // still being squeezed by the actions sitting right next to it
        // (confirmed live: truncating well before the available space ran
        // out); giving the title its own row removes that fight entirely.
        var oTopRow = styled(new HBox({
            justifyContent: "SpaceBetween",
            alignItems: "Center",
            items: [oNumber, oActions]
        }), "novaWorkboardTileTopRow");

        var oTitleRow = styled(new VBox({
            items: [oTitleText, oTitleInput]
        }), "novaWorkboardTileTitleRow");

        var oHeader = styled(new VBox({
            items: [oTopRow, oTitleRow]
        }), "novaWorkboardTileHeader");

        return styled(new VBox({
            items: [oHeader, oContent]
        }), "novaWorkboardTile");
    }

    return {
        getModel: function () {
            return ensureModel();
        },

        /**
         * @param {object} oTile {type: "chart"|"insight", title, chartConfig,
         *        createFrame, rows, text, bullets}
         * @returns {string} the new tile's id
         */
        pin: function (oTile) {
            var oData = ensureModel().getData();
            var oNew = Object.assign({ id: "tile-" + (iNextId++) }, oTile);
            oData.tiles.push(oNew);
            ensureModel().setData(oData);
            Logger.step("Workboard", "pinned '" + (oNew.title || oNew.type) + "' (" + oData.tiles.length + " tile(s) total)");
            return oNew.id;
        },

        /** Adds a blank, immediately-editable note tile - the board's own content, not pinned from chat. */
        addNote: function () {
            return this.pin({ type: "insight", title: "New note", text: "", bullets: [] });
        },

        unpin: function (sId) {
            var oData = ensureModel().getData();
            oData.tiles = oData.tiles.filter(function (t) { return t.id !== sId; });
            ensureModel().setData(oData);
        },

        getAll: function () {
            return ensureModel().getData().tiles;
        },

        clear: function () {
            ensureModel().setData({ tiles: [] });
        },

        /**
         * Builds the whole canvas as a plain sap.m.List, one section per
         * pinned tile, in registry order - reordering is not a feature
         * (removed: it never worked reliably, confirmed live more than
         * once, and wasn't worth the complexity it added). A CSS rule
         * (novaWorkboardCanvasFlex) reflows the list's internal <ul> as a
         * wrapping flex row so it still reads as a tile board, not a
         * vertical list.
         * @param {function(string)} fnOnRemove called with a tile's id when its remove button is pressed
         * @returns {sap.m.List} the canvas control - caller injects chart content after it is rendered
         */
        buildCanvas: function (fnOnRemove) {
            var oList = styled(new List({
                mode: "None",
                showSeparators: "None",
                showNoData: false
            }), "novaWorkboardCanvasFlex");

            this.getAll().forEach(function (oTile, iIndex) {
                var oListItem = new CustomListItem({
                    content: [buildTile(oTile, fnOnRemove, iIndex)]
                });
                oListItem.data("novaWorkboardTileId", oTile.id);
                // the actual gap between sections lives here, as padding on
                // the <li> itself - not as margin on the inner tile VBox,
                // which is subject to margin-collapse depending on how the
                // parent list's own box model behaves and wasn't reliably
                // producing visible space (confirmed live). Padding on an
                // element I tag and target directly has no such dependency.
                oListItem.addStyleClass("novaWorkboardListItem");
                oList.addItem(oListItem);
            });

            return oList;
        },

        /**
         * Finds the still-pending chart content hosts built by buildCanvas
         * and renders each one's real VizFrame into it - split from
         * buildCanvas because createFrame needs the host already in the
         * live DOM to paint correctly (mirrors ChatMixin's existing chart
         * placement timing).
         */
        renderPendingCharts: function (oCanvas) {
            var mTileById = {};
            this.getAll().forEach(function (oTile) { mTileById[oTile.id] = oTile; });

            oCanvas.getItems().forEach(function (oListItem) {
                var oTile = mTileById[oListItem.data("novaWorkboardTileId")];
                if (!oTile || oTile.type !== "chart" || !oTile.createFrame) {
                    return;
                }
                var oTileBox = oListItem.getContent()[0];
                var oContent = oTileBox && oTileBox.getItems()[1];
                var oChartHost = oContent && oContent.getItems()[0];
                if (!oChartHost || !oChartHost.data("novaWorkboardPendingChart")) {
                    return;
                }
                oChartHost.data("novaWorkboardPendingChart", false);
                oChartHost.destroyItems();
                oChartHost.addItem(oTile.createFrame("14rem"));
            });
        },

        /**
         * @param {string} sId
         * @param {{pending: boolean, text: string}} mInsight
         */
        setInsight: function (sId, mInsight) {
            var oTile = findTile(sId);
            if (!oTile) {
                return;
            }
            oTile.insightPending = !!mInsight.pending;
            oTile.insightText = mInsight.text || "";
            persist();
        }
    };
});
