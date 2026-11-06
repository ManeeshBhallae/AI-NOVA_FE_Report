@path: '/nova'
// CAP's body parser inherits Express's 100kb default limit - confirmed in
// @sap/cds's own body-parser.js. A real invoice PDF (color, logos, multiple
// pages) is megabytes as base64, so every such upload died with 413 before
// reaching any handler. This annotation is the documented way to raise it
// (read per service in cds' http.js); generous ceiling, the per-document
// caps inside extractLineItems still bound what actually gets processed.
@cds.server.body_parser.limit: '30mb'
service NovaService {

    /**
     * Turns a plain-English question about the current screen into either a
     * filter instruction or an answer. `context` carries the app/entity
     * metadata, active filters and visible rows as a JSON string. `history`
     * is an optional JSON array of prior {role, text} turns from this same
     * chat session, letting the model answer with real conversational
     * continuity - omit it (or pass "[]") for a one-shot question.
     * Returns the model's raw JSON reply.
     */
    action ask(question : String, context : LargeString, history : LargeString) returns LargeString;

    /**
     * Pulls field values out of an uploaded document. `fields` is the JSON list
     * of writable fields with their types; `text` is the document's text, read
     * in the browser. Returns the values for the user to review - nothing is
     * written or saved here.
     */
    action extractFields(text : LargeString, fields : LargeString) returns LargeString;

    /**
     * Pulls the text layer out of a base64 PDF. Done here rather than in the
     * browser so no PDF library has to ship with the UI. Returns plain text;
     * the file itself goes no further than this service.
     */
    action extractPdfText(content : LargeString) returns LargeString;

    /**
     * Reads one or more uploaded invoice documents - text already extracted
     * client-side for text-layer PDFs, or images for everything else (the
     * model does its own OCR, no separate library) - and pulls out every
     * product line item it can find in each, grouped per document.
     * `documents` is a JSON array of { name, kind: "text"|"image", text?,
     * mimeType?, base64? }; `fields` is the same writable-field-list shape
     * extractFields already takes. One model call for the whole batch, not
     * one per document. Returns the line items for the user to review in
     * the bulk-create grid - nothing is written or saved here.
     */
    action extractLineItems(documents : LargeString, fields : LargeString) returns LargeString;

    /**
     * Writes a short, data-grounded insight for a chart that's been pinned
     * to the workboard. `chart` is a JSON summary of already-aggregated
     * category totals (the numbers the chart itself displays) - never
     * individual record values. Deliberately separate from `ask`, which is
     * never shown this kind of real figure. Returns plain text, not JSON.
     */
    action describeChart(chart : LargeString) returns LargeString;

    /**
     * Resets the AI usage counters - the in-memory session totals AND the
     * persisted all-time totals. User-triggered housekeeping (the "Clear
     * all usage" button in the dock's usage popover); involves no model
     * call and touches nothing but the counters themselves.
     */
    action resetUsage() returns String;
}
