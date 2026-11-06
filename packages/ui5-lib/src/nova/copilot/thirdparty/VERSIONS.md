# Vendored third-party libraries

Plain browser (UMD) builds, loaded lazily via `ThirdPartyLoader.js`. This app
has no bundler (classic UI5 `ui5 build`, not webpack), so these can't be
`npm install`ed into the browser bundle - they're committed as real files,
same "nothing fetched from a CDN at runtime" rule as every other asset here.
No package manager tracks their versions; update by hand, deliberately.

| File                   | Library    | Version | Source |
|-------------------------|-----------|---------|--------|
| `xlsx.full.min.js`     | SheetJS (xlsx) | 0.20.3 | `https://cdn.sheetjs.com/xlsx-latest/package/dist/xlsx.full.min.js` - **not** npm. The npm-published `xlsx` package is frozen at 0.18.5, which has known CVEs (prototype pollution, ReDoS) in exactly the file-parsing path this feature uses on user-uploaded files. SheetJS's own fix is only distributed through their CDN, not npm - fetched once here as a one-time vendoring source, not a runtime dependency. |
| `jspdf.umd.min.js`     | jsPDF      | 4.2.1   | `node_modules/jspdf/dist/jspdf.umd.min.js` (npm `jspdf`) |
| `pptxgen.bundle.js`    | PptxGenJS  | 4.0.1   | `node_modules/pptxgenjs/dist/pptxgen.bundle.js` (npm `pptxgenjs`) |
| `jszip.min.js`         | JSZip      | 3.10.2  | `node_modules/jszip/dist/jszip.min.js` (npm `jszip`) - PptxGenJS's browser build expects a global `JSZip` to already exist; loaded first by `ThirdPartyLoader.loadPptxGenJs()`. |
| `html2canvas.min.js`   | html2canvas| 1.4.1   | `node_modules/html2canvas/dist/html2canvas.min.js` (npm `html2canvas`) |
| `pdf.min.js` + `pdf.worker.min.js` | Mozilla pdf.js | 3.11.174 | `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/` - 3.11.174 is the last classic-UMD build (4.x is ESM-only, unloadable via plain script injection). Used only to render a scanned PDF's pages to images client-side for the invoice vision OCR; the worker is pointed at the vendored copy by `ThirdPartyLoader.loadPdfJs()`, never a CDN. |

Vendored 2026-11-03 (pdf.js added 2026-11-05).
