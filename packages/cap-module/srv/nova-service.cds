@path: '/nova'
service NovaService {

    /**
     * Turns a plain-English question about the current screen into either a
     * filter instruction or an answer. `context` carries the app/entity
     * metadata, active filters and visible rows as a JSON string.
     * Returns the model's raw JSON reply.
     */
    action ask(question : String, context : LargeString) returns LargeString;

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
}
