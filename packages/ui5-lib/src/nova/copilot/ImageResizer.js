sap.ui.define([], function () {
    "use strict";

    /**
     * Downscales an image file to a capped long edge and re-encodes it as
     * JPEG, entirely in the browser via the plain Canvas API - no vendored
     * library needed. This is the real token-cost lever for the vision OCR
     * path: the model's own image tokenization scales with pixel count
     * regardless of any "detail" hint, so a phone photo at full resolution
     * (often 3000-4000px) costs several times what a ~1500px version does
     * for exactly the same legibility on an invoice.
     */
    /**
     * Encodes an already-drawn canvas as JPEG base64 (no data: prefix) -
     * shared by resize() below and by the scanned-PDF page renderer in
     * BulkUpload.js, which draws pdf.js output into a canvas and needs the
     * exact same encoding step.
     * @returns {Promise<{base64: string, mimeType: string}>}
     */
    function canvasToJpeg(oCanvas, fQuality) {
        return new Promise(function (resolve, reject) {
            oCanvas.toBlob(function (oBlob) {
                if (!oBlob) {
                    reject(new Error("Could not encode the image."));
                    return;
                }
                var oReader = new FileReader();
                oReader.onload = function () {
                    var sDataUrl = String(oReader.result || "");
                    var iComma = sDataUrl.indexOf(",");
                    resolve({
                        base64: iComma === -1 ? sDataUrl : sDataUrl.slice(iComma + 1),
                        mimeType: "image/jpeg"
                    });
                };
                oReader.onerror = function () {
                    reject(new Error("Could not read the encoded image."));
                };
                oReader.readAsDataURL(oBlob);
            }, "image/jpeg", fQuality || 0.85);
        });
    }

    return {
        canvasToJpeg: canvasToJpeg,

        /**
         * @param {File} oFile
         * @param {number} [iMaxLongEdge=1500]
         * @param {number} [fQuality=0.85]
         * @returns {Promise<{base64: string, mimeType: string}>}
         */
        resize: function (oFile, iMaxLongEdge, fQuality) {
            var iMax = iMaxLongEdge || 1500;
            var fQ = fQuality || 0.85;

            return new Promise(function (resolve, reject) {
                var sObjectUrl = URL.createObjectURL(oFile);
                var oImage = new Image();

                oImage.onload = function () {
                    URL.revokeObjectURL(sObjectUrl);

                    var iWidth = oImage.naturalWidth;
                    var iHeight = oImage.naturalHeight;
                    var iLongEdge = Math.max(iWidth, iHeight);
                    var fScale = iLongEdge > iMax ? iMax / iLongEdge : 1;

                    var oCanvas = document.createElement("canvas");
                    oCanvas.width = Math.round(iWidth * fScale);
                    oCanvas.height = Math.round(iHeight * fScale);

                    var oCtx = oCanvas.getContext("2d");
                    if (!oCtx) {
                        reject(new Error("Could not read this image - your browser has no canvas support."));
                        return;
                    }
                    oCtx.drawImage(oImage, 0, 0, oCanvas.width, oCanvas.height);
                    canvasToJpeg(oCanvas, fQ).then(resolve, reject);
                };

                oImage.onerror = function () {
                    URL.revokeObjectURL(sObjectUrl);
                    reject(new Error("'" + oFile.name + "' could not be read as an image."));
                };

                oImage.src = sObjectUrl;
            });
        }
    };
});
