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

function chartInsightPrompt() {
    if (process.env.NODE_ENV === "production") {
        return require("./chartInsightPrompt").CHART_INSIGHT_PROMPT;
    }
    delete require.cache[require.resolve("./chartInsightPrompt")];
    return require("./chartInsightPrompt").CHART_INSIGHT_PROMPT;
}

function lineItemsPrompt() {
    if (process.env.NODE_ENV === "production") {
        return require("./invoiceLineItemsPrompt").INVOICE_LINE_ITEMS_PROMPT;
    }
    delete require.cache[require.resolve("./invoiceLineItemsPrompt")];
    return require("./invoiceLineItemsPrompt").INVOICE_LINE_ITEMS_PROMPT;
}

// Haiku by default: this is mostly structured extraction and routing rather
// than open reasoning, and it costs a fraction of Sonnet. Override per
// environment with NOVA_MODEL without touching the code.
const DEFAULT_MODEL = "anthropic--claude-4.5-haiku";
const RESOURCE_GROUP = process.env.NOVA_RESOURCE_GROUP || "default";

function modelName() {
    return process.env.NOVA_MODEL || DEFAULT_MODEL;
}

// Document reading (field extraction, invoice line items) is transcription,
// not reasoning - a cheaper model holds up fine there even when the chat
// model is upgraded, and documents are the token-heaviest calls. Falls back
// to the main model when unset, so splitting is opt-in per environment.
function docModelName() {
    return process.env.NOVA_DOC_MODEL || modelName();
}

/**
 * Two ways to reach AI Core, picked at runtime by whether NOVA_AI_DESTINATION
 * is set - no separate code path or separate install needed for either:
 *   - unset:  the SDK's own default resolution - AICORE_SERVICE_KEY from the
 *             environment (local dev, e.g. a .env file), or a directly bound
 *             "aicore" service instance.
 *   - set:    looks up a BTP destination by that name instead. Only resolves
 *             at runtime if this app is actually bound to a destination
 *             service instance, which only exists once this app has CF
 *             deploy config (mta.yaml) set up - there is nothing to bind to
 *             otherwise. Intended for production, where a shared AI Core
 *             instance is handed out as a destination rather than a raw key.
 * Passed as the OrchestrationClient's 3rd constructor argument either way.
 */
function aiDestination() {
    const name = process.env.NOVA_AI_DESTINATION;
    return name ? { destinationName: name } : undefined;
}

// Env-overridable cost/quality dial, same pattern as NOVA_MODEL/NOVA_RESOURCE_GROUP.
// Enforced here independently of whatever cap the client applied, since the
// client's own cap is not something this service can trust.
const MAX_HISTORY_TURNS = parseInt(process.env.NOVA_MAX_HISTORY_TURNS, 10) || 10;

// Simple ceilings on the free-text fields a caller controls directly - caps
// runaway token cost from an oversized payload (accidental or not) and gives
// prompt-injection text a smaller stage, same reasoning as the history cap
// above. Generous on purpose: real usage never gets near these.
const MAX_QUESTION_CHARS = parseInt(process.env.NOVA_MAX_QUESTION_CHARS, 10) || 2000;
const MAX_CONTEXT_CHARS = parseInt(process.env.NOVA_MAX_CONTEXT_CHARS, 10) || 20000;
const MAX_DOCUMENT_CHARS = parseInt(process.env.NOVA_MAX_DOCUMENT_CHARS, 10) || 50000;

// extractLineItems batches several documents into ONE model call - these
// cap that batch, not a single document, so they're separate from the
// ask/extractFields caps above. The client enforces the same limits before
// sending (fail fast, no round trip), these are the untrusted-input backstop.
const MAX_INVOICE_DOCS = parseInt(process.env.NOVA_MAX_INVOICE_DOCS, 10) || 8;
const MAX_INVOICE_DOC_CHARS = parseInt(process.env.NOVA_MAX_INVOICE_DOC_CHARS, 10) || 20000;
// a scanned multi-page PDF arrives as several page images under ONE
// document - this caps the total image count across the whole batch
// (e.g. one 10-page scan plus a few photos), independent of the doc count
const MAX_INVOICE_IMAGES = parseInt(process.env.NOVA_MAX_INVOICE_IMAGES, 10) || 15;
// ~6MB decoded - generous ceiling for a downscaled invoice photo, never
// expected to bind for a client that actually ran ImageResizer first
const MAX_INVOICE_IMAGE_BYTES = parseInt(process.env.NOVA_MAX_INVOICE_IMAGE_BYTES, 10) || 6 * 1024 * 1024;

function checkLength(sValue, iMax, sFieldName, req) {
    if (sValue && sValue.length > iMax) {
        req.reject(400, `${sFieldName} is too long (${sValue.length} chars, max ${iMax}).`);
        return false;
    }
    return true;
}

// Running totals since the server started - logged alongside each call so
// the cost of a session is visible at a glance without adding up lines.
const oTokenTotals = { calls: 0, prompt: 0, completion: 0, total: 0, cu: 0 };

// Optional: your contract's tokens-to-capacity-unit conversion rates, per
// 1000 tokens, input and output metered separately (SAP's gen-AI-hub rates
// are model-specific - read yours off the SAP pricing calculator for the
// model in NOVA_MODEL; a single blended rate in both is fine too). Unset
// (the default) means no CU estimate is shown anywhere, only raw token
// counts - better no number than an invented one. NOVA_EUR_PER_CU is the
// contract's currency rate per capacity unit, for a money figure on top.
const CU_PER_1K_PROMPT = parseFloat(process.env.NOVA_CU_PER_1K_PROMPT) || 0;
const CU_PER_1K_COMPLETION = parseFloat(process.env.NOVA_CU_PER_1K_COMPLETION) || 0;
// Money per capacity unit, in whatever currency the contract is priced in -
// NOVA_CURRENCY names it (e.g. INR, EUR, USD; display only, no FX logic
// here). NOVA_EUR_PER_CU is the older name for the same dial, still honored.
const PRICE_PER_CU = parseFloat(process.env.NOVA_PRICE_PER_CU) ||
    parseFloat(process.env.NOVA_EUR_PER_CU) || 0;
const CURRENCY = process.env.NOVA_CURRENCY || "EUR";

function cuEstimate(iPrompt, iCompletion) {
    if (!CU_PER_1K_PROMPT && !CU_PER_1K_COMPLETION) {
        return null;
    }
    return (iPrompt / 1000) * CU_PER_1K_PROMPT + (iCompletion / 1000) * CU_PER_1K_COMPLETION;
}

// All-time totals, persisted to a small JSON file so they survive server
// restarts - unlike the session totals above, which deliberately reset.
// One tiny synchronous write per AI call (a few per minute at most, and a
// human is always waiting on the model call that dwarfs it).
const fs = require("fs");
const path = require("path");
const USAGE_FILE = process.env.NOVA_USAGE_FILE || path.join(process.cwd(), ".nova-usage.json");

const oOverallTotals = (() => {
    try {
        const oSaved = JSON.parse(fs.readFileSync(USAGE_FILE, "utf8"));
        return {
            calls: oSaved.calls || 0,
            prompt: oSaved.prompt || 0,
            completion: oSaved.completion || 0,
            total: oSaved.total || 0,
            cuSeen: oSaved.cuSeen || 0
        };
    } catch (oError) {
        return { calls: 0, prompt: 0, completion: 0, total: 0, cuSeen: 0 };
    }
})();

function persistOverallTotals() {
    try {
        fs.writeFileSync(USAGE_FILE, JSON.stringify(oOverallTotals, null, 2));
    } catch (oError) {
        cds.log("nova").warn(`[tokens] could not persist usage totals: ${oError.message}`);
    }
}

/**
 * Logs the exact token usage of one orchestration call - the same numbers
 * SAP meters into AI Core capacity units (token-based, model-specific
 * conversion rates), so this is the per-action view the BTP cockpit's
 * aggregated Usage Analytics cannot give: which feature cost what.
 * getTokenUsage() is part of the SDK's OrchestrationResponse - exact
 * counts from the model provider, not an estimate.
 */
function logTokenUsage(sAction, response, req) {
    try {
        const oUsage = response.getTokenUsage();
        if (!oUsage) {
            return;
        }
        // Confirmed live: with prompt caching active, AI Core reports cached
        // tokens in prompt_tokens_details but NOT in prompt_tokens itself -
        // a 7.3k-token prompt showed prompt=42 once the rest was cached. For
        // the cost estimate, cache traffic is folded back in at Anthropic's
        // standard multipliers: a cache WRITE bills at 1.25x the base input
        // rate, a cache READ at 0.1x. Raw token counters keep the full
        // picture (prompt + cached) so "tokens processed" stays honest too.
        const oDetailsForTotals = oUsage.prompt_tokens_details || {};
        const iReadNow = oDetailsForTotals.cached_tokens || 0;
        const iWriteNow = oDetailsForTotals.cache_creation_tokens || 0;
        const iPromptAll = (oUsage.prompt_tokens || 0) + iReadNow + iWriteNow;
        const iTotalAll = iPromptAll + (oUsage.completion_tokens || 0);
        // billing-equivalent prompt tokens, for the CU estimate only
        const fPromptEquivalent = (oUsage.prompt_tokens || 0) + 1.25 * iWriteNow + 0.1 * iReadNow;

        oTokenTotals.calls++;
        oTokenTotals.prompt += iPromptAll;
        oTokenTotals.completion += oUsage.completion_tokens || 0;
        oTokenTotals.total += iTotalAll;
        oOverallTotals.calls++;
        oOverallTotals.prompt += iPromptAll;
        oOverallTotals.completion += oUsage.completion_tokens || 0;
        oOverallTotals.total += iTotalAll;
        persistOverallTotals();

        const bHasRates = !!(CU_PER_1K_PROMPT || CU_PER_1K_COMPLETION);
        const fCu = cuEstimate(fPromptEquivalent, oUsage.completion_tokens || 0);
        if (fCu !== null) {
            oTokenTotals.cu += fCu;
        }
        // all-time CU accumulates per call (cache splits aren't persisted),
        // so it lives in its own running counter seeded from the session
        oOverallTotals.cuSeen = (oOverallTotals.cuSeen || 0) + (fCu || 0);
        const fOverallCu = bHasRates ? oOverallTotals.cuSeen : null;

        const sCost = (fCuValue) => PRICE_PER_CU && fCuValue !== null
            ? ` = ${CURRENCY} ${(fCuValue * PRICE_PER_CU).toFixed(4)}`
            : "";

        // Anthropic prompt caching: cached_tokens were served from cache
        // (billed at the provider's much lower cached rate), and
        // cache_creation_tokens were written to it this call. Reported so
        // it's visible the caching is actually working - the CU estimate
        // deliberately stays based on raw prompt tokens (an upper bound);
        // the billed figure in the cockpit will be lower on cache hits.
        const oDetails = oUsage.prompt_tokens_details || {};
        const iCachedRead = oDetails.cached_tokens || 0;
        const iCacheWrite = oDetails.cache_creation_tokens || 0;

        cds.log("nova").info(
            `[tokens] ${sAction}: prompt=${oUsage.prompt_tokens} completion=${oUsage.completion_tokens} ` +
            `total=${oUsage.total_tokens}` +
            (iCachedRead || iCacheWrite
                ? ` (cache: ${iCachedRead} read, ${iCacheWrite} written)` : "") +
            ` | session: ${oTokenTotals.calls} call(s), ` +
            `${oTokenTotals.total} tokens (${oTokenTotals.prompt} in / ${oTokenTotals.completion} out)` +
            (fCu !== null ? ` ~${oTokenTotals.cu.toFixed(4)} CU${sCost(oTokenTotals.cu)}` : "") +
            ` | all-time: ${oOverallTotals.calls} call(s), ${oOverallTotals.total} tokens` +
            (fOverallCu !== null ? ` ~${fOverallCu.toFixed(4)} CU${sCost(fOverallCu)}` : ""));

        // the same numbers, riding back to the browser on the response so
        // the dock can show a live usage counter - a header, not part of
        // the body, so no existing response parsing changes shape
        if (req && req.http && req.http.res && !req.http.res.headersSent) {
            req.http.res.setHeader("x-nova-tokens", JSON.stringify({
                action: sAction,
                // full per-call picture including cache traffic, so the UI's
                // "X of those from cache" phrasing adds up
                prompt: iPromptAll,
                completion: oUsage.completion_tokens || 0,
                total: iTotalAll,
                lastCachedRead: iCachedRead,
                lastCacheWrite: iCacheWrite,
                lastCu: fCu !== null ? +fCu.toFixed(4) : null,
                lastCost: fCu !== null && PRICE_PER_CU ? +(fCu * PRICE_PER_CU).toFixed(4) : null,
                sessionCalls: oTokenTotals.calls,
                sessionTotal: oTokenTotals.total,
                sessionCu: bHasRates ? +oTokenTotals.cu.toFixed(4) : null,
                sessionCost: bHasRates && PRICE_PER_CU ? +(oTokenTotals.cu * PRICE_PER_CU).toFixed(4) : null,
                overallCalls: oOverallTotals.calls,
                overallTotal: oOverallTotals.total,
                overallCu: fOverallCu !== null ? +fOverallCu.toFixed(4) : null,
                overallCost: fOverallCu !== null && PRICE_PER_CU ? +(fOverallCu * PRICE_PER_CU).toFixed(4) : null,
                currency: PRICE_PER_CU ? CURRENCY : null
            }));
        }
    } catch (oError) {
        // never let telemetry break the actual answer
        cds.log("nova").warn(`[tokens] could not read token usage for ${sAction}: ${oError.message}`);
    }
}

/**
 * Parses the client's JSON-encoded history array defensively - it is
 * untrusted input, same posture as every other field on this request.
 * Drops anything that isn't a plain {role: "user"|"assistant", text} turn
 * and caps the result, regardless of what the client already sent.
 */
function parseHistory(sHistory) {
    if (!sHistory) {
        return [];
    }
    let aParsed;
    try {
        aParsed = JSON.parse(sHistory);
    } catch (oError) {
        return [];
    }
    if (!Array.isArray(aParsed)) {
        return [];
    }
    return aParsed
        .filter((oTurn) => oTurn
            && (oTurn.role === "user" || oTurn.role === "assistant")
            && typeof oTurn.text === "string"
            && oTurn.text.trim())
        .slice(-MAX_HISTORY_TURNS)
        .map((oTurn) => ({ role: oTurn.role, text: oTurn.text }));
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
            const { question, context, history } = req.data;

            if (!question || !question.trim()) {
                return req.reject(400, "A question is required.");
            }
            if (!checkLength(question, MAX_QUESTION_CHARS, "The question", req)) { return; }
            if (!checkLength(context, MAX_CONTEXT_CHARS, "The app context", req)) { return; }

            const aHistory = parseHistory(history);

            // Each prior turn rides in as its own indexed placeholder
            // ({{?h0}}, {{?h1}}, ...), same reason "context"/"question"
            // already go through placeholderValues rather than being
            // inlined: a prior turn's text could itself contain "{"/"}"
            // that the template engine would otherwise try to parse.
            const aHistoryMessages = aHistory.map((oTurn, i) => ({
                role: oTurn.role,
                content: "{{?h" + i + "}}"
            }));
            const mHistoryPlaceholders = {};
            aHistory.forEach((oTurn, i) => {
                mHistoryPlaceholders["h" + i] = oTurn.text;
            });

            // The single biggest repeated cost in this whole dock: the system
            // prompt and the app-knowledge pack are byte-identical on every
            // question asked on the same screen, yet used to be re-billed at
            // the full input rate every call (confirmed live: ~7.8k prompt
            // tokens per ask, most of it this). Anthropic prompt caching via
            // cache_control marks them as cache breakpoints, so repeat calls
            // bill them at the provider's cached rate instead. The context is
            // split: appKnowledge + entity metadata are stable per screen and
            // go INSIDE the cached prefix; everything else (active filters,
            // row count, page state, consent flag) changes call to call and
            // stays outside, so it can never invalidate the cache. Inlined,
            // not placeholders: the template engine only reacts to the
            // "{{?name}}" shape, which valid JSON output can never contain
            // (an object cannot open directly inside an object without a key,
            // so "{{" never occurs) - same reason inlining systemPrompt()
            // always worked despite its many JSON examples.
            let oFullContext = {};
            try {
                oFullContext = JSON.parse(context || "{}");
            } catch (oError) {
                oFullContext = {};
            }
            const oStableContext = {
                appKnowledge: oFullContext.appKnowledge,
                entity: oFullContext.entity
            };
            const oVolatileContext = Object.assign({}, oFullContext);
            delete oVolatileContext.appKnowledge;
            delete oVolatileContext.entity;

            const client = new OrchestrationClient(
                {
                    promptTemplating: {
                        model: {
                            name: modelName(),
                            params: { temperature: 0, max_tokens: 2048 }
                        },
                        prompt: {
                            template: [
                                {
                                    role: "system",
                                    content: [
                                        {
                                            type: "text",
                                            text: systemPrompt(),
                                            cache_control: { type: "ephemeral" }
                                        },
                                        {
                                            type: "text",
                                            text: "Stable app knowledge (identical for every question on this screen):\n" +
                                                JSON.stringify(oStableContext),
                                            cache_control: { type: "ephemeral" }
                                        }
                                    ]
                                },
                                ...aHistoryMessages,
                                {
                                    role: "user",
                                    // volatile screen state only - small, and passed as a
                                    // placeholder since filter VALUES are user-typed text
                                    // that could contain anything, unlike the JSON above
                                    content: "Current screen state:\n{{?appContext}}\n\nQuestion: {{?question}}"
                                }
                            ]
                        }
                    }
                },
                { resourceGroup: RESOURCE_GROUP },
                aiDestination()
            );

            try {
                const response = await client.chatCompletion({
                    placeholderValues: {
                        appContext: JSON.stringify(oVolatileContext),
                        question: question,
                        ...mHistoryPlaceholders
                    }
                });
                logTokenUsage("ask [" + modelName() + "]", response, req);
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
            if (!checkLength(text, MAX_DOCUMENT_CHARS, "The document text", req)) { return; }

            const client = new OrchestrationClient(
                {
                    promptTemplating: {
                        model: {
                            name: docModelName(),
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
                { resourceGroup: RESOURCE_GROUP },
                aiDestination()
            );

            try {
                const response = await client.chatCompletion({
                    placeholderValues: { fields: fields || "[]", text: text }
                });
                logTokenUsage("extractFields [" + docModelName() + "]", response, req);
                return firstJsonObject(stripCodeFence(response.getContent()));
            } catch (oError) {
                cds.log("nova").error("Extraction call failed", oError);
                return req.reject(502, `Document could not be read: ${oError.message}`);
            }
        });

        this.on("extractLineItems", async (req) => {
            const { documents, fields } = req.data;
            if (!documents) {
                return req.reject(400, "No documents were sent.");
            }

            let aDocs;
            try {
                aDocs = JSON.parse(documents);
            } catch (oError) {
                return req.reject(400, "Documents were not valid JSON.");
            }
            if (!Array.isArray(aDocs) || !aDocs.length) {
                return req.reject(400, "No documents were sent.");
            }
            if (aDocs.length > MAX_INVOICE_DOCS) {
                return req.reject(400,
                    `Too many documents in one batch (${aDocs.length}, max ${MAX_INVOICE_DOCS}).`);
            }

            // Built fresh per request, same reasoning as "ask"'s own
            // aHistoryMessages: text content that could itself contain "{"/"}"
            // goes through indexed placeholders, never inlined directly, so it
            // can never be misparsed as template syntax. Image content is
            // structured (type/image_url), not text, so it has no placeholder
            // form at all - it is spliced in as a literal object instead,
            // exactly the way history turns are spliced in as literal
            // {role, content} entries rather than template strings.
            const aContentParts = [
                { type: "text", text: "Fields:\n{{?fields}}\n\nDocuments follow, each labelled by name." }
            ];
            const mPlaceholders = { fields: fields || "[]" };
            let iDocIndex = 0;
            let iImageCount = 0;

            // rough decoded-size check (base64 is ~4/3 the decoded size) -
            // the real enforcement point is the client resizing before it
            // ever sends this; this is defense in depth against an
            // untrusted/bypassing caller, not the primary control
            const checkImage = (sName, sBase64) => {
                const iDecodedBytes = (sBase64 || "").length * 0.75;
                if (iDecodedBytes > MAX_INVOICE_IMAGE_BYTES) {
                    req.reject(400,
                        `"${sName}" is too large (${Math.round(iDecodedBytes / 1024)} KB, ` +
                        `max ${Math.round(MAX_INVOICE_IMAGE_BYTES / 1024)} KB).`);
                    return false;
                }
                iImageCount++;
                if (iImageCount > MAX_INVOICE_IMAGES) {
                    req.reject(400,
                        `Too many page images in one batch (max ${MAX_INVOICE_IMAGES}).`);
                    return false;
                }
                return true;
            };

            for (const oDoc of aDocs) {
                const sNameKey = "name" + iDocIndex;
                mPlaceholders[sNameKey] = (oDoc && oDoc.name) || ("document " + (iDocIndex + 1));

                // a scanned multi-page PDF: one document, several page images
                // rendered client-side - all pages belong to the SAME invoice
                if (oDoc && oDoc.kind === "image" && Array.isArray(oDoc.pages) && oDoc.pages.length) {
                    aContentParts.push({
                        type: "text",
                        text: "--- Document: {{?" + sNameKey + "}} (" + oDoc.pages.length +
                            " page(s), all pages belong to this ONE document) ---"
                    });
                    for (const oPage of oDoc.pages) {
                        if (!oPage || !oPage.base64 || !oPage.mimeType) {
                            continue;
                        }
                        if (!checkImage(oDoc.name, oPage.base64)) {
                            return;
                        }
                        aContentParts.push({
                            type: "image_url",
                            image_url: { url: `data:${oPage.mimeType};base64,${oPage.base64}` }
                        });
                    }
                } else if (oDoc && oDoc.kind === "image" && oDoc.base64 && oDoc.mimeType) {
                    if (!checkImage(oDoc.name, oDoc.base64)) {
                        return;
                    }
                    aContentParts.push({ type: "text", text: "--- Document: {{?" + sNameKey + "}} ---" });
                    aContentParts.push({
                        type: "image_url",
                        image_url: { url: `data:${oDoc.mimeType};base64,${oDoc.base64}` }
                    });
                } else {
                    const sText = (oDoc && oDoc.text) || "";
                    if (!checkLength(sText, MAX_INVOICE_DOC_CHARS, `Document "${oDoc && oDoc.name}"`, req)) {
                        return;
                    }
                    const sTextKey = "doc" + iDocIndex;
                    mPlaceholders[sTextKey] = sText;
                    aContentParts.push({
                        type: "text",
                        text: "--- Document: {{?" + sNameKey + "}} ---\n{{?" + sTextKey + "}}"
                    });
                }
                iDocIndex++;
            }

            const client = new OrchestrationClient(
                {
                    promptTemplating: {
                        model: {
                            name: docModelName(),
                            // a 10-page scan can legitimately carry dozens of
                            // line items - headroom so the reply never clips
                            // mid-JSON (unused ceiling costs nothing)
                            params: { temperature: 0, max_tokens: 8192 }
                        },
                        prompt: {
                            template: [
                                { role: "system", content: lineItemsPrompt() },
                                { role: "user", content: aContentParts }
                            ]
                        }
                    }
                },
                { resourceGroup: RESOURCE_GROUP },
                aiDestination()
            );

            try {
                const response = await client.chatCompletion({ placeholderValues: mPlaceholders });
                logTokenUsage("extractLineItems [" + docModelName() + "]", response, req);
                return firstJsonObject(stripCodeFence(response.getContent()));
            } catch (oError) {
                cds.log("nova").error("Line-item extraction failed", oError);
                return req.reject(502, `Documents could not be read: ${oError.message}`);
            }
        });

        this.on("resetUsage", async () => {
            oTokenTotals.calls = 0;
            oTokenTotals.prompt = 0;
            oTokenTotals.completion = 0;
            oTokenTotals.total = 0;
            oTokenTotals.cu = 0;
            oOverallTotals.calls = 0;
            oOverallTotals.prompt = 0;
            oOverallTotals.completion = 0;
            oOverallTotals.total = 0;
            oOverallTotals.cuSeen = 0;
            persistOverallTotals();
            cds.log("nova").info("[tokens] usage counters cleared (session and all-time)");
            return "cleared";
        });

        this.on("describeChart", async (req) => {
            const { chart } = req.data;
            if (!chart) {
                return req.reject(400, "No chart data was sent.");
            }

            const client = new OrchestrationClient(
                {
                    promptTemplating: {
                        model: {
                            name: modelName(),
                            params: { temperature: 0.2, max_tokens: 256 }
                        },
                        prompt: {
                            template: [
                                { role: "system", content: chartInsightPrompt() },
                                { role: "user", content: "Chart data:\n{{?chart}}" }
                            ]
                        }
                    }
                },
                { resourceGroup: RESOURCE_GROUP },
                aiDestination()
            );

            try {
                const response = await client.chatCompletion({ placeholderValues: { chart } });
                logTokenUsage("describeChart [" + modelName() + "]", response, req);
                return response.getContent().trim();
            } catch (oError) {
                cds.log("nova").error("Chart insight call failed", oError);
                return req.reject(502, `Could not generate an insight: ${oError.message}`);
            }
        });

        return super.init();
    }
};
