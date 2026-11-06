sap.ui.define([
    "sap/viz/ui5/controls/VizFrame",
    "sap/viz/ui5/data/FlattenedDataset",
    "sap/viz/ui5/controls/common/feeds/FeedItem",
    "sap/ui/model/json/JSONModel",
    "./DataQuery",
    "./Logger"
], function (VizFrame, FlattenedDataset, FeedItem, JSONModel, DataQuery, Logger) {
    "use strict";

    var MAX_CATEGORIES = 30;

    // which feed slots each chart type expects
    var FEEDS = {
        column: { measure: "valueAxis", dimension: "categoryAxis" },
        bar: { measure: "valueAxis", dimension: "categoryAxis" },
        line: { measure: "valueAxis", dimension: "categoryAxis" },
        stacked_column: { measure: "valueAxis", dimension: "categoryAxis" },
        stacked_bar: { measure: "valueAxis", dimension: "categoryAxis" },
        pie: { measure: "size", dimension: "color" },
        donut: { measure: "size", dimension: "color" }
    };

    // a binding path cannot contain "/", so flatten it for the chart's model
    function flatKey(sField) {
        return String(sField).replace(/\//g, "_");
    }

    // "average" division produces long repeating decimals (215/6 =
    // 35.833333333333336) that showed up verbatim in both the chart's data
    // labels and, worse, in the AI-written insight text - confirmed live,
    // the model faithfully reproduced the raw unrounded figure because it
    // was told never to state a number it wasn't given. Rounding once here,
    // at the one place aggregation actually happens, fixes it everywhere
    // downstream (chart, chartSummary, the insight prompt) rather than
    // needing a fix at each consumer.
    function round2(fValue) {
        return Math.round(fValue * 100) / 100;
    }

    function isNumeric(oProperty) {
        return /Edm\.(Int|Decimal|Double|Single|Byte)/.test((oProperty && oProperty.type) || "");
    }

    function propertyIndex(oEntityMeta) {
        var mFields = {};
        ((oEntityMeta && oEntityMeta.properties) || []).forEach(function (oProp) {
            mFields[oProp.name] = oProp;
        });
        return mFields;
    }

    /**
     * Groups rows by the dimension and aggregates each measure, because OData V2
     * has no grouping of its own. Done here so the figures come from the service
     * response rather than from anything the model produced.
     */
    function aggregate(aRows, sDimension, aMeasures, sAggregation) {
        var mGroups = {};
        var aOrder = [];

        aRows.forEach(function (oRow) {
            var sKey = DataQuery.valueAt(oRow, sDimension);
            sKey = (sKey === undefined || sKey === null || sKey === "") ? "(none)" : String(sKey);

            if (!mGroups[sKey]) {
                mGroups[sKey] = { key: sKey, count: 0, sums: {} };
                aOrder.push(sKey);
            }
            var oGroup = mGroups[sKey];
            oGroup.count++;
            aMeasures.forEach(function (sMeasure) {
                var fValue = parseFloat(DataQuery.valueAt(oRow, sMeasure));
                oGroup.sums[sMeasure] = (oGroup.sums[sMeasure] || 0) + (isNaN(fValue) ? 0 : fValue);
            });
        });

        return aOrder.map(function (sKey) {
            var oGroup = mGroups[sKey];
            var oOut = {};
            oOut[flatKey(sDimension)] = sKey;
            aMeasures.forEach(function (sMeasure) {
                if (sAggregation === "average") {
                    oOut[flatKey(sMeasure)] = oGroup.count ? round2(oGroup.sums[sMeasure] / oGroup.count) : 0;
                } else if (sAggregation === "count") {
                    oOut[flatKey(sMeasure)] = oGroup.count;
                } else {
                    oOut[flatKey(sMeasure)] = round2(oGroup.sums[sMeasure]);
                }
            });
            return oOut;
        });
    }

    return {
        /**
         * Suggests what could be charted from the entity alone - used when the
         * user opens the chart builder without saying what they want.
         */
        suggest: function (oEntityMeta) {
            var aProperties = (oEntityMeta && oEntityMeta.properties) || [];
            var aMeasures = aProperties.filter(isNumeric);
            var aDimensions = aProperties.filter(function (oProp) {
                return !isNumeric(oProp);
            });
            return {
                measures: aMeasures.map(function (oProp) {
                    return { name: oProp.name, label: oProp.label };
                }),
                dimensions: aDimensions.map(function (oProp) {
                    return { name: oProp.name, label: oProp.label };
                })
            };
        },

        /**
         * Fetches the data the chart needs and returns a ready VizFrame.
         * Field names are validated against the metadata first, so an invented
         * field never reaches the service.
         *
         * @returns {Promise<{vizFrame: sap.viz.ui5.controls.VizFrame, rows: number, dropped: string[]}>}
         */
        build: function (oChart, mParams) {
            var mFields = propertyIndex(mParams.entityMeta);
            var aDropped = [];

            function resolve(sField) {
                if (mFields[sField]) {
                    return mFields[sField];
                }
                if (String(sField).indexOf("/") === -1 || !mParams.model || !mParams.model.getMetaModel) {
                    return null;
                }
                try {
                    var oMetaModel = mParams.model.getMetaModel();
                    var oEntitySet = oMetaModel.getODataEntitySet(mParams.entitySet);
                    var oType = oEntitySet && oMetaModel.getODataEntityType(oEntitySet.entityType);
                    var aParts = String(sField).split("/");
                    for (var i = 0; i < aParts.length - 1 && oType; i++) {
                        var oEnd = oMetaModel.getODataAssociationEnd(oType, aParts[i]);
                        oType = oEnd && oMetaModel.getODataEntityType(oEnd.type);
                    }
                    var sLeaf = aParts[aParts.length - 1];
                    var oRaw = oType && (oType.property || []).filter(function (oProp) {
                        return oProp.name === sLeaf;
                    })[0];
                    if (!oRaw) {
                        return null;
                    }
                    // remember it so labels and types resolve later
                    mFields[sField] = {
                        name: sField,
                        type: oRaw.type,
                        label: oRaw["sap:label"] || sLeaf
                    };
                    return mFields[sField];
                } catch (oError) {
                    return null;
                }
            }

            function keep(sField) {
                if (resolve(sField)) {
                    return true;
                }
                aDropped.push(sField);
                Logger.warn("ChartBuilder", "dropped unknown field '" + sField + "'");
                return false;
            }

            var aDimensions = ((oChart && oChart.dimensions) || []).filter(keep);
            var aMeasures = ((oChart && oChart.measures) || []).filter(keep);

            if (!aDimensions.length || !aMeasures.length) {
                return Promise.reject(new Error(
                    "A chart needs one category field and at least one numeric field."));
            }

            var sType = FEEDS[oChart.type] ? oChart.type : "column";
            var sDimension = aDimensions[0];

            Logger.step("ChartBuilder", "building a " + sType + " chart", {
                dimension: sDimension,
                measures: aMeasures,
                aggregation: oChart.aggregation || "sum"
            });

            // read only the columns the chart needs
            return DataQuery.run({
                select: [sDimension].concat(aMeasures),
                filters: oChart.filters,
                top: 500
            }, Object.assign({}, mParams, { maxRows: 500, screenFilters: mParams.screenFilters })).then(function (oResult) {
                var aRows = aggregate(oResult.rows, sDimension, aMeasures, oChart.aggregation);

                if (aRows.length > MAX_CATEGORIES) {
                    aRows = aRows.slice(0, MAX_CATEGORIES);
                    Logger.warn("ChartBuilder", "showing the first " + MAX_CATEGORIES + " categories only");
                }

                var sDimensionLabel = (mFields[sDimension] || {}).label || sDimension;
                var aMeasureDefs = aMeasures.map(function (sMeasure) {
                    return {
                        name: (mFields[sMeasure] || {}).label || sMeasure,
                        value: "{" + flatKey(sMeasure) + "}"
                    };
                });

                function createFrame(sHeight) {
                var oVizFrame = new VizFrame({
                    vizType: sType,
                    width: "100%",
                    // an explicit height: a percentage collapses to zero inside
                    // a container whose box has no resolved height
                    height: sHeight || "24rem",
                    uiConfig: { applicationSet: "fiori" }
                });

                oVizFrame.setDataset(new FlattenedDataset({
                    dimensions: [{ name: sDimensionLabel, value: "{" + flatKey(sDimension) + "}" }],
                    measures: aMeasureDefs,
                    data: { path: "/rows" }
                }));
                oVizFrame.setModel(new JSONModel({ rows: aRows }));

                var oFeeds = FEEDS[sType];
                oVizFrame.addFeed(new FeedItem({
                    uid: oFeeds.measure,
                    type: "Measure",
                    values: aMeasureDefs.map(function (oDef) {
                        return oDef.name;
                    })
                }));
                oVizFrame.addFeed(new FeedItem({
                    uid: oFeeds.dimension,
                    type: "Dimension",
                    values: [sDimensionLabel]
                }));

                oVizFrame.setVizProperties({
                    title: { visible: !!oChart.title, text: oChart.title || "" },
                    plotArea: {
                        dataLabel: { visible: aRows.length <= 12 },
                        // a restrained, deliberate palette instead of the
                        // theme's default chart blue on everything - every
                        // chart in the app used the exact same single blue
                        // regardless of context, which read as flat/generic
                        // rather than considered, especially once several
                        // charts sit together on the workboard
                        colorPalette: ["#4C5FD5", "#16A394", "#E8A33D", "#D1495B", "#8661C5", "#5B8C5A"]
                    },
                    legend: { visible: aMeasures.length > 1 || sType === "pie" || sType === "donut" }
                });

                return oVizFrame;
                }

                Logger.step("ChartBuilder", "chart ready with " + aRows.length + " category(ies)");

                // a plain summary of the already-aggregated totals the chart
                // itself displays, pre-built here (where the label/flatKey
                // logic already lives) so a caller pinning this chart to the
                // workboard can hand it straight to AiClient.describeChart()
                // without re-deriving any of this
                var aSummaryRows = aRows.map(function (oRow) {
                    var oValues = {};
                    aMeasureDefs.forEach(function (oDef, i) {
                        oValues[oDef.name] = oRow[flatKey(aMeasures[i])];
                    });
                    return { category: oRow[flatKey(sDimension)], values: oValues };
                });

                return {
                    createFrame: createFrame,
                    rows: aRows.length,
                    dropped: aDropped,
                    chartSummary: {
                        title: oChart.title || "",
                        dimensionLabel: sDimensionLabel,
                        aggregation: oChart.aggregation || "sum",
                        rows: aSummaryRows
                    }
                };
            });
        }
    };
});
