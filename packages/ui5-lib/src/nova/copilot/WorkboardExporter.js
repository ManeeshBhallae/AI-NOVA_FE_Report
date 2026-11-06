sap.ui.define([
    "./ThirdPartyLoader",
    "./Logger"
], function (ThirdPartyLoader, Logger) {
    "use strict";

    function sanitiseFileName(sName) {
        return String(sName).replace(/[^\w\- ]/g, "").trim().replace(/\s+/g, "-").substring(0, 60) || "nova-report";
    }

    // the exact same already-aggregated totals the chart itself plots and
    // the insight was written from - turned into a plain {headers, rows}
    // shape both export formats can render as a real table, not just a
    // picture of the chart, capped so one chart with many categories
    // doesn't take over the whole report
    var MAX_TABLE_ROWS = 20;

    function chartSummaryToTable(oChartSummary) {
        if (!oChartSummary || !oChartSummary.rows || !oChartSummary.rows.length) {
            return null;
        }
        var aMeasureLabels = Object.keys(oChartSummary.rows[0].values || {});
        if (!aMeasureLabels.length) {
            return null;
        }
        var aHeaders = [oChartSummary.dimensionLabel || "Category"].concat(aMeasureLabels);
        var aRows = oChartSummary.rows.slice(0, MAX_TABLE_ROWS).map(function (oRow) {
            return [oRow.category].concat(aMeasureLabels.map(function (sLabel) {
                var vValue = oRow.values[sLabel];
                return typeof vValue === "number" ? formatNumber(vValue) : String(vValue || "");
            }));
        });
        var iOmitted = oChartSummary.rows.length - aRows.length;
        return { headers: aHeaders, rows: aRows, omitted: iOmitted > 0 ? iOmitted : 0 };
    }

    function formatNumber(fValue) {
        var fRounded = Math.round(fValue * 100) / 100;
        return String(fRounded);
    }

    // off-screen but laid out - position:absolute, left:-9999px, NOT
    // display:none, since VizFrame (sap.viz, SVG/d3-based) needs real layout
    // to paint, the same requirement ChatMixin's own chart placement
    // already works around.
    function createOffscreenHost() {
        var oDiv = document.createElement("div");
        oDiv.style.position = "absolute";
        oDiv.style.left = "-9999px";
        oDiv.style.top = "0";
        oDiv.style.width = "600px";
        oDiv.style.height = "320px";
        document.body.appendChild(oDiv);
        return oDiv;
    }

    // VizFrame renders asynchronously after being placed in a live DOM node -
    // two animation frames plus a short delay, more generous than but the
    // same idea as ChatMixin._placeInlineChart's existing setTimeout(..., 60).
    function waitForPaint() {
        return new Promise(function (resolve) {
            requestAnimationFrame(function () {
                requestAnimationFrame(function () {
                    setTimeout(resolve, 80);
                });
            });
        });
    }

    /**
     * Hand-drawn, not a plugin (jsPDF core has no table support -
     * jspdf-autotable is a separate package this project doesn't vendor,
     * and this table is simple enough not to need it): a header row, a
     * rule, then one row of plain text per category, columns aligned by
     * x-offset. Returns the y position just after the table so the caller
     * can keep laying out content below it.
     */
    function drawPdfTable(oDoc, oTable, iX, iY, iWidth) {
        var iCols = oTable.headers.length;
        var iColWidth = iWidth / iCols;
        var iRowHeight = 15;

        oDoc.setFontSize(9);
        oDoc.setFont(undefined, "bold");
        oTable.headers.forEach(function (sLabel, i) {
            oDoc.text(String(sLabel), iX + i * iColWidth, iY, { maxWidth: iColWidth - 4 });
        });
        var iRuleY = iY + 4;
        oDoc.setDrawColor(180);
        oDoc.line(iX, iRuleY, iX + iWidth, iRuleY);
        oDoc.setFont(undefined, "normal");
        oDoc.setDrawColor(0);

        var iRowY = iY + iRowHeight;
        oTable.rows.forEach(function (aCells) {
            aCells.forEach(function (vCell, i) {
                oDoc.text(String(vCell), iX + i * iColWidth, iRowY, { maxWidth: iColWidth - 4 });
            });
            iRowY += iRowHeight;
        });

        if (oTable.omitted) {
            oDoc.setFontSize(8);
            oDoc.setTextColor(140);
            oDoc.text("+ " + oTable.omitted + " more row(s) not shown", iX, iRowY);
            oDoc.setTextColor(0);
            iRowY += iRowHeight;
        }

        return iRowY;
    }

    /**
     * Renders one chart tile's createFrame factory into a PNG dataURL via
     * html2canvas, since sap.viz exposes no documented export API (confirmed:
     * no toDataURL/exportToSVG anywhere in this library). The VizFrame built
     * here is a brand new instance purely for this snapshot - it is never
     * the one shown on the workboard itself, same as how createFrame is
     * already called fresh for the inline bubble and the full-screen dialog.
     */
    function snapshotChartTile(oTile, html2canvas) {
        var oHost = createOffscreenHost();
        var oVizFrame;
        try {
            oVizFrame = oTile.createFrame("18rem");
        } catch (oError) {
            document.body.removeChild(oHost);
            return Promise.reject(oError);
        }

        // this is a brand-new, throwaway VizFrame instance built purely for
        // the snapshot (never the one shown on the workboard itself), so
        // disabling all interactivity here is safe - it also happens to be
        // exactly what removes sap.viz's own scroll/zoom/tooltip chrome
        // (the stray grey pill otherwise visible in the exported image),
        // which is meaningless on a static picture anyway
        oVizFrame.setVizProperties({ interaction: { noninteractiveMode: true } });
        oVizFrame.placeAt(oHost);

        return waitForPaint().then(function () {
            return html2canvas(oHost, { backgroundColor: "#ffffff", scale: 2 });
        }).then(function (oCanvas) {
            var sDataUrl = oCanvas.toDataURL("image/png");
            oVizFrame.destroy();
            document.body.removeChild(oHost);
            return sDataUrl;
        }).catch(function (oError) {
            if (oVizFrame && oVizFrame.destroy) {
                oVizFrame.destroy();
            }
            if (oHost.parentNode) {
                document.body.removeChild(oHost);
            }
            throw oError;
        });
    }

    /**
     * Sequential, not parallel - two off-screen sap.viz VizFrames rendering
     * at the same time share internal render-queue state and have been
     * observed to interfere with each other; one at a time is slower but
     * reliable, and export is not a latency-sensitive path.
     */
    function snapshotAllCharts(aTiles, html2canvas, fnProgress) {
        var aResults = [];
        var iChartCount = aTiles.filter(function (t) { return t.type === "chart"; }).length;
        var iDone = 0;
        return aTiles.reduce(function (oChain, oTile) {
            return oChain.then(function () {
                if (oTile.type !== "chart" || !oTile.createFrame) {
                    aResults.push(null);
                    return undefined;
                }
                iDone++;
                if (fnProgress) {
                    fnProgress(iDone, iChartCount, oTile.title);
                }
                return snapshotChartTile(oTile, html2canvas).then(function (sDataUrl) {
                    aResults.push(sDataUrl);
                }).catch(function (oError) {
                    Logger.error("WorkboardExporter", "could not snapshot chart '" + oTile.title + "'", oError.message);
                    aResults.push(null);
                });
            });
        }, Promise.resolve()).then(function () { return aResults; });
    }

    return {
        /**
         * @param {object[]} aTiles from Workboard.getAll(), in display order
         * @param {{title: string}} [mOptions]
         * @returns {Promise<void>} resolves once the browser download has started
         */
        exportPdf: function (aTiles, mOptions) {
            var sTitle = (mOptions && mOptions.title) || "Nova Copilot report";
            var fnProgress = mOptions && mOptions.onProgress;
            return Promise.all([ThirdPartyLoader.loadJsPdf(), ThirdPartyLoader.loadHtml2Canvas()])
                .then(function (aLoaded) {
                    var JsPdfCtor = aLoaded[0];
                    var html2canvas = aLoaded[1];
                    return snapshotAllCharts(aTiles, html2canvas, fnProgress).then(function (aSnapshots) {
                        var oDoc = new JsPdfCtor({ unit: "pt", format: "a4" });
                        var iPageWidth = oDoc.internal.pageSize.getWidth();
                        var iPageHeight = oDoc.internal.pageSize.getHeight();
                        var iMargin = 36;
                        var iY = iMargin;

                        oDoc.setFontSize(18);
                        oDoc.text(sTitle, iMargin, iY);
                        iY += 26;
                        oDoc.setFontSize(10);
                        oDoc.setTextColor(120);
                        oDoc.text(new Date().toLocaleString(), iMargin, iY);
                        oDoc.setTextColor(0);
                        iY += 22;

                        aTiles.forEach(function (oTile, i) {
                            var iEstHeight = oTile.type === "chart" ? 280 : 30 + 14 * ((oTile.bullets || []).length + 1);
                            if (iY + iEstHeight > iPageHeight - iMargin) {
                                oDoc.addPage();
                                iY = iMargin;
                            }
                            oDoc.setFontSize(13);
                            oDoc.text(oTile.title || "", iMargin, iY);
                            iY += 18;

                            if (oTile.type === "chart" && aSnapshots[i]) {
                                var iImgWidth = iPageWidth - iMargin * 2;
                                var iImgHeight = iImgWidth * 0.53;
                                oDoc.addImage(aSnapshots[i], "PNG", iMargin, iY, iImgWidth, iImgHeight);
                                iY += iImgHeight + 10;
                                if (oTile.insightText) {
                                    oDoc.setFontSize(10);
                                    oDoc.setTextColor(80);
                                    var aInsightLines = oDoc.splitTextToSize(oTile.insightText, iPageWidth - iMargin * 2);
                                    oDoc.text(aInsightLines, iMargin, iY);
                                    oDoc.setTextColor(0);
                                    iY += aInsightLines.length * 13 + 10;
                                } else {
                                    iY += 6;
                                }

                                // the same totals the chart plots, as an actual
                                // table - the report reads as a document with
                                // real data in it, not just a gallery of chart
                                // pictures
                                var oTable = chartSummaryToTable(oTile.chartSummary);
                                if (oTable) {
                                    var iTableHeight = (oTable.rows.length + (oTable.omitted ? 2 : 1)) * 15 + 10;
                                    if (iY + iTableHeight > iPageHeight - iMargin) {
                                        oDoc.addPage();
                                        iY = iMargin;
                                    }
                                    iY = drawPdfTable(oDoc, oTable, iMargin, iY, iPageWidth - iMargin * 2) + 10;
                                }
                            } else {
                                oDoc.setFontSize(10);
                                if (oTile.text) {
                                    var aLines = oDoc.splitTextToSize(oTile.text, iPageWidth - iMargin * 2);
                                    oDoc.text(aLines, iMargin, iY);
                                    iY += aLines.length * 13 + 6;
                                }
                                (oTile.bullets || []).forEach(function (sBullet) {
                                    var aBulletLines = oDoc.splitTextToSize("• " + sBullet, iPageWidth - iMargin * 2 - 10);
                                    oDoc.text(aBulletLines, iMargin + 10, iY);
                                    iY += aBulletLines.length * 13 + 2;
                                });
                                iY += 10;
                            }
                        });

                        oDoc.save(sanitiseFileName(sTitle) + ".pdf");
                        Logger.step("WorkboardExporter", "PDF exported with " + aTiles.length + " tile(s)");
                    });
                });
        },

        /**
         * @param {object[]} aTiles from Workboard.getAll(), in display order
         * @param {{title: string}} [mOptions]
         * @returns {Promise<void>} resolves once the browser download has started
         */
        exportPptx: function (aTiles, mOptions) {
            var sTitle = (mOptions && mOptions.title) || "Nova Copilot report";
            var fnProgress = mOptions && mOptions.onProgress;
            return Promise.all([ThirdPartyLoader.loadPptxGenJs(), ThirdPartyLoader.loadHtml2Canvas()])
                .then(function (aLoaded) {
                    var PptxGenJsCtor = aLoaded[0];
                    var html2canvas = aLoaded[1];
                    return snapshotAllCharts(aTiles, html2canvas, fnProgress).then(function (aSnapshots) {
                        var oPres = new PptxGenJsCtor();

                        var oTitleSlide = oPres.addSlide();
                        oTitleSlide.addText(sTitle, { x: 0.5, y: 2, w: 9, h: 1, fontSize: 28, bold: true });
                        oTitleSlide.addText(new Date().toLocaleString(),
                            { x: 0.5, y: 3, w: 9, h: 0.5, fontSize: 12, color: "666666" });

                        aTiles.forEach(function (oTile, i) {
                            var oSlide = oPres.addSlide();
                            oSlide.addText(oTile.title || "", { x: 0.4, y: 0.3, w: 9.2, h: 0.6, fontSize: 20, bold: true });

                            if (oTile.type === "chart" && aSnapshots[i]) {
                                var bHasInsight = !!oTile.insightText;
                                oSlide.addImage({
                                    data: aSnapshots[i],
                                    x: 0.5, y: 1.1, w: 9,
                                    h: bHasInsight ? 3.9 : 4.6
                                });
                                if (bHasInsight) {
                                    oSlide.addText(oTile.insightText,
                                        { x: 0.5, y: 5.15, w: 9, h: 0.6, fontSize: 12, color: "595959", italic: true });
                                }

                                // a dedicated data slide right after the chart,
                                // not crammed onto the same one - pptxgenjs has
                                // real table support built in, so this is the
                                // report's actual numbers, not just a picture
                                var oTable = chartSummaryToTable(oTile.chartSummary);
                                if (oTable) {
                                    var oDataSlide = oPres.addSlide();
                                    oDataSlide.addText((oTile.title || "Chart") + " - data",
                                        { x: 0.4, y: 0.3, w: 9.2, h: 0.6, fontSize: 18, bold: true });
                                    var aTableRows = [oTable.headers.map(function (sLabel) {
                                        return { text: sLabel, options: { bold: true, fill: { color: "F2F2F2" } } };
                                    })].concat(oTable.rows.map(function (aCells) {
                                        return aCells.map(function (vCell) { return String(vCell); });
                                    }));
                                    oDataSlide.addTable(aTableRows, {
                                        x: 0.5, y: 1.1, w: 9, fontSize: 11,
                                        border: { type: "solid", color: "CCCCCC", pt: 0.5 }
                                    });
                                    if (oTable.omitted) {
                                        oDataSlide.addText("+ " + oTable.omitted + " more row(s) not shown",
                                            { x: 0.5, y: 6.3, w: 9, h: 0.3, fontSize: 10, italic: true, color: "888888" });
                                    }
                                }
                                return;
                            }

                            var aRuns = [];
                            if (oTile.text) {
                                aRuns.push({ text: oTile.text, options: { fontSize: 16, breakLine: true } });
                            }
                            (oTile.bullets || []).forEach(function (sBullet) {
                                aRuns.push({ text: sBullet, options: { bullet: true, fontSize: 14, breakLine: true } });
                            });
                            if (aRuns.length) {
                                oSlide.addText(aRuns, { x: 0.5, y: 1.2, w: 9, h: 4.5 });
                            }
                        });

                        Logger.step("WorkboardExporter", "PPTX exported with " + aTiles.length + " tile(s)");
                        return oPres.writeFile({ fileName: sanitiseFileName(sTitle) + ".pptx" });
                    });
                });
        }
    };
});
