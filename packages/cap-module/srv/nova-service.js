"use strict";

const cds = require("@sap/cds");
const { OrchestrationClient } = require("@sap-ai-sdk/orchestration");

/**
 * Outside production the prompt is re-read on every call, so editing the
 * guardrails takes effect immediately instead of needing a server restart -
 * a restart that is easy to forget and leaves the model running stale rules.
 */
function extractionPrompt() {
    if (process.env.NODE_ENV === "production") {
        return require("./extractPrompt").EXTRACTION_PROMPT;
    }
    delete require.cache[require.resolve("./extractPrompt")];
    return require("./extractPrompt").EXTRACTION_PROMPT;
}

function systemPrompt() {
    if (process.env.NODE_ENV === "production") {
        return require("./prompt").SYSTEM_PROMPT;
    }
    delete require.cache[require.resolve("./prompt")];
    return require("./prompt").SYSTEM_PROMPT;
}

// Haiku by default: this is mostly structured extraction and routing rather
// than open reasoning, and it costs a fraction of Sonnet. Override per
// environment with NOVA_MODEL without touching the code.
const DEFAULT_MODEL = "anthropic--claude-4.5-haiku";
const RESOURCE_GROUP = process.env.NOVA_RESOURCE_GROUP || "default";

function modelName() {
    return process.env.NOVA_MODEL || DEFAULT_MODEL;
}

// models often wrap JSON in a ```json fence despite being told not to
function stripCodeFence(sText) {
    if (!sText) {
        return sText;
    }
    const sTrimmed = sText.trim();
    const aMatch = sTrimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
    return aMatch ? aMatch[1].trim() : sTrimmed;
}

/**
 * Returns the first complete JSON object in the text. Models sometimes append
 * commentary, or a second attempt, after the object they were asked for -
 * taking the whole string would fail to parse. Brace depth is tracked outside
 * of string literals so braces in values do not confuse the scan.
 */
function firstJsonObject(sText) {
    if (!sText) {
        return sText;
    }
    const iStart = sText.indexOf("{");
    if (iStart === -1) {
        return sText;
    }

    let iDepth = 0;
    let bInString = false;
    let bEscaped = false;

    for (let i = iStart; i < sText.length; i++) {
        const sChar = sText[i];

        if (bEscaped) {
            bEscaped = false;
            continue;
        }
        if (sChar === "\\") {
            bEscaped = true;
            continue;
        }
        if (sChar === '"') {
            bInString = !bInString;
            continue;
        }
        if (bInString) {
            continue;
        }
        if (sChar === "{") {
            iDepth++;
        } else if (sChar === "}") {
            iDepth--;
            if (iDepth === 0) {
                return sText.slice(iStart, i + 1);
            }
        }
    }
    return sText.slice(iStart);
}

module.exports = class NovaService extends cds.ApplicationService {
    init() {
        this.on("ask", async (req) => {
            const { question, context } = req.data;

            if (!question || !question.trim()) {
                return req.reject(400, "A question is required.");
            }

            const client = new OrchestrationClient(
                {
                    promptTemplating: {
                        model: {
                            name: modelName(),
                            params: { temperature: 0, max_tokens: 2048 }
                        },
                        prompt: {
                            // the context is passed as a placeholder value rather than
                            // inlined, so its JSON braces are never parsed as template syntax
                            template: [
                                { role: "system", content: systemPrompt() },
                                {
                                    role: "user",
                                    content: "App context:\n{{?appContext}}\n\nQuestion: {{?question}}"
                                }
                            ]
                        }
                    }
                },
                { resourceGroup: RESOURCE_GROUP }
            );

            try {
                const response = await client.chatCompletion({
                    placeholderValues: {
                        appContext: context || "{}",
                        question: question
                    }
                });
                return firstJsonObject(stripCodeFence(response.getContent()));
            } catch (oError) {
                cds.log("nova").error("Orchestration call failed", oError);
                return req.reject(502, `AI Core call failed: ${oError.message}`);
            }
        });

        this.on("extractPdfText", async (req) => {
            const { content } = req.data;
            if (!content) {
                return req.reject(400, "No file content was sent.");
            }

            let parser;
            try {
                const { PDFParse } = require("pdf-parse");
                const buffer = Buffer.from(content, "base64");
                parser = new PDFParse({ data: new Uint8Array(buffer) });
                const result = await parser.getText();
                const text = (result && result.text ? result.text : "").trim();

                cds.log("nova").info(`extracted ${text.length} characters from a PDF`);

                if (!text) {
                    // a scanned page has no text layer; OCR would be needed
                    return req.reject(422,
                        "That PDF has no text layer - it is most likely a scan. " +
                        "A text-based PDF or a .txt/.csv export will work.");
                }
                return text;
            } catch (oError) {
                cds.log("nova").error("PDF extraction failed", oError);
                return req.reject(422, `The PDF could not be read: ${oError.message}`);
            } finally {
                if (parser && parser.destroy) {
                    await parser.destroy();
                }
            }
        });

        this.on("extractFields", async (req) => {
            const { text, fields } = req.data;

            if (!text || !text.trim()) {
                return req.reject(400, "The document appears to be empty.");
            }

            const client = new OrchestrationClient(
                {
                    promptTemplating: {
                        model: {
                            name: modelName(),
                            params: { temperature: 0, max_tokens: 1024 }
                        },
                        prompt: {
                            template: [
                                { role: "system", content: extractionPrompt() },
                                {
                                    role: "user",
                                    content: "Fields:\n{{?fields}}\n\nDocument:\n{{?text}}"
                                }
                            ]
                        }
                    }
                },
                { resourceGroup: RESOURCE_GROUP }
            );

            try {
                const response = await client.chatCompletion({
                    placeholderValues: { fields: fields || "[]", text: text }
                });
                return firstJsonObject(stripCodeFence(response.getContent()));
            } catch (oError) {
                cds.log("nova").error("Extraction call failed", oError);
                return req.reject(502, `Document could not be read: ${oError.message}`);
            }
        });

        return super.init();
    }
};
