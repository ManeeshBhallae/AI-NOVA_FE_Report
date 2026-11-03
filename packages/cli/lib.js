"use strict";

/**
 * Shared logic between install.js (vendor the AI dock into an app) and
 * prepare-cf.js (additionally wire it up for a CF deploy). Kept in one
 * place so the two commands can never drift apart on what "installed"
 * actually means.
 */

const fs = require("fs");
const path = require("path");

const UI5_SRC = path.join(__dirname, "..", "ui5-lib", "src", "nova", "copilot");
const CAP_SRC = path.join(__dirname, "..", "cap-module", "srv");

const UI5_FILES = [
    "ChatMixin.js",
    "ChartBuilder.js",
    "ActionApplier.js",
    "DataQuery.js",
    "ContextCollector.js",
    "FieldPopulator.js",
    "AiClient.js",
    "DocumentReader.js",
    "Logger.js",
    path.join("knowledge", "AppKnowledge.js"),
    path.join("knowledge", "AppBrief.js"),
    "ListReportExt.controller.js",
    "ObjectPageExt.controller.js",
    "ChatPanel.fragment.xml",
    "ChartDialog.fragment.xml",
    "ChatPanel.css",
    path.join("i18n", "messagebundle.properties")
];

const CAP_FILES = ["nova-service.cds", "nova-service.js", "prompt.js", "extractPrompt.js"];

const VENDOR_SUBDIR = path.join("webapp", "ext", "novaCopilot");

function fail(message) {
    console.error("\nnova-copilot: " + message);
    process.exit(1);
}

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, data) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
}

/** Resolves the target app, its sap.app.id, and the namespace to vendor under. */
function resolveTarget(targetArg) {
    const targetRoot = path.resolve(process.cwd(), targetArg || ".");
    const manifestPath = path.join(targetRoot, "webapp", "manifest.json");
    if (!fs.existsSync(manifestPath)) {
        fail("no webapp/manifest.json found under " + targetRoot +
            "\nRun this from a Fiori Elements V2 app's root, or pass its path as an argument.");
    }
    const manifest = readJson(manifestPath);
    const appId = manifest["sap.app"] && manifest["sap.app"].id;
    if (!appId) {
        fail("webapp/manifest.json has no sap.app.id - can't derive a namespace to install under");
    }
    return {
        targetRoot,
        appId,
        nsDot: appId + ".ext.novaCopilot",
        nsSlash: appId.replace(/\./g, "/") + "/ext/novaCopilot"
    };
}

/** Replaces the library's internal "nova.copilot" / "nova/copilot" namespace with the target app's own. */
function rewriteNamespace(text, nsDot, nsSlash) {
    return text.split("nova.copilot").join(nsDot).split("nova/copilot").join(nsSlash);
}

function copyVendoredFiles(targetRoot, nsDot, nsSlash) {
    const destDir = path.join(targetRoot, VENDOR_SUBDIR);
    UI5_FILES.forEach((relPath) => {
        const srcPath = path.join(UI5_SRC, relPath);
        const destPath = path.join(destDir, relPath);
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        const isText = /\.(js|xml|css|properties)$/.test(relPath);
        if (isText) {
            const content = fs.readFileSync(srcPath, "utf8");
            fs.writeFileSync(destPath, rewriteNamespace(content, nsDot, nsSlash));
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    });
    console.log("  wrote " + UI5_FILES.length + " file(s) to " + path.join(VENDOR_SUBDIR));
}

function copyCapFiles(targetRoot) {
    const destDir = path.join(targetRoot, "srv");
    fs.mkdirSync(destDir, { recursive: true });
    let written = 0, skipped = 0;
    CAP_FILES.forEach((name) => {
        const destPath = path.join(destDir, name);
        if (fs.existsSync(destPath)) {
            skipped++;
            console.log("  skipped srv/" + name + " (already exists - treat as yours to edit, e.g. prompt.js)");
            return;
        }
        fs.copyFileSync(path.join(CAP_SRC, name), destPath);
        written++;
    });
    console.log("  wrote " + written + " file(s) to srv/" + (skipped ? (", skipped " + skipped + " existing") : ""));
}

function patchManifest(targetRoot, nsDot) {
    const manifestPath = path.join(targetRoot, "webapp", "manifest.json");
    const manifest = readJson(manifestPath);
    const ui5 = manifest["sap.ui5"] || (manifest["sap.ui5"] = {});
    const extend = ui5.extends || (ui5.extends = {});
    const extensions = extend.extensions || (extend.extensions = {});
    const controllerExtensions = extensions["sap.ui.controllerExtensions"] ||
        (extensions["sap.ui.controllerExtensions"] = {});

    const LIST_REPORT = "sap.suite.ui.generic.template.ListReport.view.ListReport";
    const OBJECT_PAGE = "sap.suite.ui.generic.template.ObjectPage.view.Details";

    let changed = false;
    if (!controllerExtensions[LIST_REPORT]) {
        controllerExtensions[LIST_REPORT] = { controllerName: nsDot + ".ListReportExt" };
        changed = true;
    }
    if (!controllerExtensions[OBJECT_PAGE]) {
        controllerExtensions[OBJECT_PAGE] = { controllerName: nsDot + ".ObjectPageExt" };
        changed = true;
    }

    if (changed) {
        writeJson(manifestPath, manifest);
        console.log("  patched webapp/manifest.json (sap.ui.controllerExtensions)");
    } else {
        console.log("  webapp/manifest.json already wires up controller extensions - left as is");
    }
}

/**
 * Not every Fiori Elements app already has a CAP backend wired up - plenty
 * of List Report apps are generated as pure UI5 frontends with no srv/
 * runtime at all. NovaService needs @sap/cds (runtime) and @sap/cds-dk (the
 * `cds` CLI - without it `cds watch`/`cds-serve` fall back to whatever is
 * globally installed, which can be a different version and refuse to run;
 * see ai_report's own history). So all of this is added too, not just the
 * AI-specific packages, whenever it isn't already there.
 */
function patchPackageJson(targetRoot) {
    const pkgPath = path.join(targetRoot, "package.json");
    if (!fs.existsSync(pkgPath)) {
        fail("no package.json found under " + targetRoot);
    }
    const pkg = readJson(pkgPath);
    const deps = pkg.dependencies || (pkg.dependencies = {});
    const devDeps = pkg.devDependencies || (pkg.devDependencies = {});
    const scripts = pkg.scripts || (pkg.scripts = {});
    let changed = false;

    [["@sap-ai-sdk/orchestration", "^2"], ["pdf-parse", "^2.4.5"], ["@sap/cds", "^10"]]
        .forEach(([name, version]) => {
            if (!deps[name]) {
                deps[name] = version;
                changed = true;
            }
        });

    if (!devDeps["@sap/cds-dk"]) {
        devDeps["@sap/cds-dk"] = "^10";
        changed = true;
    }

    if (!scripts["start-srv"]) {
        scripts["start-srv"] = "cds-serve";
        changed = true;
    }
    if (!scripts["watch-srv"]) {
        scripts["watch-srv"] = "cds watch";
        changed = true;
    }

    // lets cds-serve/cds watch run locally without a real auth setup
    const cdsConfig = pkg.cds || (pkg.cds = {});
    const requires = cdsConfig.requires || (cdsConfig.requires = {});
    if (!requires.auth) {
        requires.auth = {
            "[development]": { kind: "mocked" },
            "[production]": { kind: "xsuaa" }
        };
        changed = true;
    }

    if (changed) {
        writeJson(pkgPath, pkg);
        console.log("  patched package.json (AI deps + @sap/cds runtime/CLI + start-srv/watch-srv scripts, as needed)");
    } else {
        console.log("  package.json already has everything needed");
    }
    return changed;
}

/**
 * Adds a "/nova" entry to every ui5*.yaml's fiori-tools-proxy backend list,
 * so the dev server actually forwards chat calls to the local CAP service
 * instead of 404ing against itself. Apps that never had a CAP backend
 * before (unlike ai_report) never had this entry - a real gap found while
 * installing into employee_ai_report. Edits the text directly rather than
 * a full YAML round-trip, to leave comments and formatting untouched.
 */
function patchUi5YamlBackends(targetRoot) {
    const files = fs.readdirSync(targetRoot).filter((f) => /^ui5.*\.yaml$/.test(f));
    if (!files.length) {
        console.log("  no ui5*.yaml files found - nothing to patch");
        return;
    }

    files.forEach((fileName) => {
        const filePath = path.join(targetRoot, fileName);
        const original = fs.readFileSync(filePath, "utf8");

        if (/path:\s*\/nova\b/.test(original)) {
            console.log("  " + fileName + " already proxies /nova - left as is");
            return;
        }

        const lines = original.split("\n");
        const proxyIdx = lines.findIndex((l) => /name:\s*fiori-tools-proxy/.test(l));
        if (proxyIdx === -1) {
            console.log("  " + fileName + " has no fiori-tools-proxy middleware - skipped, add the /nova proxy manually");
            return;
        }

        // the backend: list belongs to this middleware only if found before
        // the next sibling "- name:" entry at the same (4-space) indent
        let backendIdx = -1;
        let blockEnd = lines.length;
        for (let i = proxyIdx + 1; i < lines.length; i++) {
            if (/^\s{4}- name:/.test(lines[i])) {
                blockEnd = i;
                break;
            }
            if (backendIdx === -1 && /^\s*backend:\s*$/.test(lines[i])) {
                backendIdx = i;
            }
        }
        if (backendIdx === -1) {
            console.log("  " + fileName + " has fiori-tools-proxy but no backend: list - skipped, add the /nova proxy manually");
            return;
        }

        const backendIndent = lines[backendIdx].match(/^(\s*)/)[1];
        const itemIndent = backendIndent + "  ";
        const urlIndent = itemIndent + "  ";

        // insert after the last existing "- path: ..." / "url: ..." pair
        let insertAt = backendIdx + 1;
        for (let i = backendIdx + 1; i < blockEnd; i++) {
            if (new RegExp("^" + itemIndent + "- path:").test(lines[i])) {
                insertAt = i + 2;
            }
        }

        lines.splice(insertAt, 0, itemIndent + "- path: /nova", urlIndent + "url: http://localhost:4004");
        fs.writeFileSync(filePath, lines.join("\n"));
        console.log("  patched " + fileName + " (added /nova backend proxy)");
    });
}

// Always refreshed, unlike srv/*.js - this is generated documentation, not
// something a team would hand-edit (their real values go in .env, untouched).
function writeEnvExample(targetRoot) {
    const dest = path.join(targetRoot, ".env.example");
    const src = path.join(__dirname, "..", "cap-module", ".env.example");
    fs.copyFileSync(src, dest);
    console.log("  wrote .env.example (copy to .env and fill in your own AI Core credentials)");
}

/** The ordinary install: vendor the dock into an app, no CF-specific wiring. */
function runInstall(targetArg) {
    const { targetRoot, appId, nsDot, nsSlash } = resolveTarget(targetArg);

    console.log("Installing Nova Copilot into " + targetRoot + " as \"" + nsDot + "\"\n");

    console.log("Frontend:");
    copyVendoredFiles(targetRoot, nsDot, nsSlash);
    patchManifest(targetRoot, nsDot);
    patchUi5YamlBackends(targetRoot);

    console.log("\nBackend:");
    copyCapFiles(targetRoot);
    const depsChanged = patchPackageJson(targetRoot);
    writeEnvExample(targetRoot);

    return { targetRoot, appId, nsDot, depsChanged };
}

/**
 * Finds a top-level module/resource block (from its "- name:" line to the
 * next sibling entry or the next top-level key) whose lines satisfy a given
 * test - e.g. "contains type: nodejs", "contains a destinations: list".
 * Works regardless of what the module is actually named, since that varies
 * per app (ai_report-srv, employeeaireport-srv, ...).
 *
 * Only matches "- name:" at exactly 2-space indent - the MTA schema's fixed
 * indent for direct children of "modules:"/"resources:". Nested "- name:"
 * entries (inside a module's own requires:/provides: list) sit deeper and
 * must NOT match here, or this mistakes a dependency reference for a module.
 */
function findModuleBlock(lines, blockMatches) {
    for (let i = 0; i < lines.length; i++) {
        const nameMatch = lines[i].match(/^ {2}- name:\s*(\S+)/);
        if (!nameMatch) {
            continue;
        }
        let end = lines.length;
        for (let j = i + 1; j < lines.length; j++) {
            if (/^ {2}- name:/.test(lines[j]) || /^\S/.test(lines[j])) {
                end = j;
                break;
            }
        }
        if (blockMatches(lines.slice(i, end))) {
            return { name: nameMatch[1], indent: "  ", start: i, end };
        }
    }
    return null;
}

/**
 * Ensures mta.yaml runs `cds build` before mbt validates/packages modules -
 * without it, a fresh `mbt build` fails with "the gen/srv path ... does not
 * exist", because gen/ is cds build's output and nothing else produces it.
 * Fiori-Tools-generated mta.yaml files never have this (only CAP's own
 * `cds add mta` adds it from scratch) - found and fixed by hand on
 * ai_report before automating it here.
 */
function ensureBuildHook(targetRoot) {
    const mtaPath = path.join(targetRoot, "mta.yaml");
    const text = fs.readFileSync(mtaPath, "utf8");
    if (/before-all:/.test(text)) {
        console.log("  mta.yaml already has a before-all build hook - left as is");
        return;
    }
    const patched = text.replace(
        /^modules:/m,
        "build-parameters:\n  before-all:\n    - builder: custom\n      commands:\n        - npx -p @sap/cds-dk cds build --production\nmodules:"
    );
    if (patched === text) {
        console.log("  could not find a top-level \"modules:\" key in mta.yaml - add the before-all build hook manually");
        return;
    }
    fs.writeFileSync(mtaPath, patched);
    console.log("  added a before-all build hook to mta.yaml (runs cds build before packaging)");
}

/**
 * Sets (or updates) NOVA_AI_DESTINATION as a property on the CAP backend
 * module (the one with "type: nodejs") in mta.yaml. Requires that module to
 * already exist - see ensureBackendModule.
 */
function setAiDestinationProperty(targetRoot, destinationName) {
    const mtaPath = path.join(targetRoot, "mta.yaml");
    const text = fs.readFileSync(mtaPath, "utf8");
    const lines = text.split("\n");
    const block = findModuleBlock(lines, (blockLines) => blockLines.some((l) => /^\s*type:\s*nodejs\s*$/.test(l)));
    if (!block) {
        fail("no backend (type: nodejs) module found in mta.yaml - run ensureBackendModule first");
    }

    // already set somewhere in this block? update in place instead of duplicating
    for (let i = block.start; i < block.end; i++) {
        if (/^\s*NOVA_AI_DESTINATION:/.test(lines[i])) {
            const existingIndent = lines[i].match(/^(\s*)/)[1];
            lines[i] = existingIndent + "NOVA_AI_DESTINATION: " + destinationName;
            fs.writeFileSync(mtaPath, lines.join("\n"));
            console.log("  updated NOVA_AI_DESTINATION on module \"" + block.name + "\" to \"" + destinationName + "\"");
            return;
        }
    }

    const moduleIndent = block.indent;
    const propIndent = moduleIndent + "  ";
    const valueIndent = propIndent + "  ";

    let propertiesIdx = -1;
    for (let i = block.start; i < block.end; i++) {
        if (new RegExp("^" + propIndent + "properties:\\s*$").test(lines[i])) {
            propertiesIdx = i;
            break;
        }
    }

    if (propertiesIdx !== -1) {
        lines.splice(propertiesIdx + 1, 0, valueIndent + "NOVA_AI_DESTINATION: " + destinationName);
    } else {
        // insert a new properties: block right after the module's "path:" line,
        // which (unlike type:/requires:) every module is guaranteed to have
        let pathIdx = -1;
        for (let i = block.start; i < block.end; i++) {
            if (new RegExp("^" + propIndent + "path:").test(lines[i])) {
                pathIdx = i;
                break;
            }
        }
        if (pathIdx === -1) {
            fail("module \"" + block.name + "\" has no \"path:\" line in mta.yaml - can't place a properties: block safely");
        }
        lines.splice(pathIdx + 1, 0, propIndent + "properties:", valueIndent + "NOVA_AI_DESTINATION: " + destinationName);
    }

    fs.writeFileSync(mtaPath, lines.join("\n"));
    console.log("  set NOVA_AI_DESTINATION: " + destinationName + " on module \"" + block.name + "\"");
}

/** First line index, from `startIdx` (exclusive) within `endIdx`, that dedents below `indentLen` - i.e. the end of a list that started at `startIdx`. */
function findListEnd(lines, startIdx, indentLen, endIdx) {
    for (let i = startIdx + 1; i < endIdx; i++) {
        if (lines[i].trim() === "") {
            continue;
        }
        const indent = (lines[i].match(/^( *)/) || ["", ""])[1].length;
        if (indent < indentLen) {
            return i;
        }
    }
    return endIdx;
}

/**
 * Wires a "srv-api" destination into the destination-SERVICE resource's own
 * init_data (found by having "service: destination" + "init_data:" - the
 * resource's actual name varies per app, e.g. "aireport-destination-service")
 * so the deployed app can route /nova to the backend module in production.
 *
 * Deliberately NOT in the separate destination-content module, despite that
 * seeming the more obvious place - a real deploy on ai_report proved that
 * mechanism rejects any destination lacking ServiceInstanceName (confirmed
 * twice, on two different destinations), while this exact shape (a plain
 * NoAuthentication entry inside a resource's own init_data) deploys
 * successfully - it's where the pre-existing "ui5" destination already
 * lives and works.
 *
 * The resource needs its own "requires: srv-api" (the backend module's
 * provided dependency) for the ~{srv-api/srv-url} placeholder inside its
 * init_data to resolve at deploy time - a resource requiring a module,
 * which inverts the usual module-requires-resource direction but was
 * confirmed to actually deploy correctly.
 *
 * Two independent read-modify-write passes (requires:, then init_data's
 * destinations: list) rather than one, so an insertion earlier in the file
 * never invalidates line indices computed for a later one.
 */
function ensureSrvApiDestination(targetRoot) {
    const mtaPath = path.join(targetRoot, "mta.yaml");

    function findDestinationServiceBlock(lines) {
        return findModuleBlock(lines, (blockLines) =>
            blockLines.some((l) => /^\s*service:\s*destination\s*$/.test(l)) &&
            blockLines.some((l) => /^\s*init_data:\s*$/.test(l)));
    }

    // pass 1: requires: srv-api (resources don't have one by default)
    let lines = fs.readFileSync(mtaPath, "utf8").split("\n");
    let block = findDestinationServiceBlock(lines);
    if (!block) {
        console.log("  no destination-service resource (one with service: destination + init_data) found");
        console.log("  in mta.yaml - skipping the srv-api route; wire it in by hand, see the README");
        return;
    }

    const alreadyHasRequire = lines.slice(block.start, block.end)
        .some((l) => /^\s*- name:\s*srv-api\s*$/.test(l));
    if (!alreadyHasRequire) {
        const requiresIdx = lines.slice(block.start, block.end).findIndex((l) => /^\s*requires:\s*$/.test(l));
        if (requiresIdx !== -1) {
            const absIdx = block.start + requiresIdx;
            const requiresIndent = lines[absIdx].match(/^(\s*)/)[1];
            const itemIndent = requiresIndent + "  ";
            const insertAt = findListEnd(lines, absIdx, itemIndent.length, block.end);
            lines.splice(insertAt, 0, itemIndent + "- name: srv-api");
        } else {
            const typeIdx = lines.slice(block.start, block.end).findIndex((l) => /^\s*type:/.test(l));
            if (typeIdx === -1) {
                console.log("  destination-service resource has no \"type:\" line - skipping, add srv-api by hand");
                return;
            }
            const absTypeIdx = block.start + typeIdx;
            const requiresIndent = block.indent + "  ";
            const itemIndent = requiresIndent + "  ";
            lines.splice(absTypeIdx + 1, 0, requiresIndent + "requires:", itemIndent + "- name: srv-api");
        }
        fs.writeFileSync(mtaPath, lines.join("\n"));
        console.log("  added requires: srv-api to the destination-service resource");
    } else {
        console.log("  destination-service resource already requires srv-api - left as is");
    }

    // pass 2: the destination entry itself, inside init_data's destinations: list
    lines = fs.readFileSync(mtaPath, "utf8").split("\n");
    block = findDestinationServiceBlock(lines);

    const alreadyHasDestination = lines.slice(block.start, block.end)
        .some((l) => /Name:\s*srv-api\s*$/.test(l));
    if (alreadyHasDestination) {
        console.log("  destination-service resource's init_data already declares srv-api - left as is");
        return;
    }

    const destIdx = lines.slice(block.start, block.end).findIndex((l) => /^\s*destinations:\s*$/.test(l));
    if (destIdx === -1) {
        console.log("  could not find a destinations: list under init_data - add srv-api by hand");
        return;
    }
    const absDestIdx = block.start + destIdx;
    const destIndent = lines[absDestIdx].match(/^(\s*)/)[1];
    const itemIndent = destIndent + "  ";
    const valIndent = itemIndent + "  ";
    const insertAt = findListEnd(lines, absDestIdx, itemIndent.length, block.end);
    lines.splice(insertAt, 0,
        itemIndent + "- Authentication: NoAuthentication",
        valIndent + "HTML5.ForwardAuthToken: true",
        valIndent + "Name: srv-api",
        valIndent + "ProxyType: Internet",
        valIndent + "Type: HTTP",
        valIndent + "URL: ~{srv-api/srv-url}");
    fs.writeFileSync(mtaPath, lines.join("\n"));
    console.log("  added the srv-api destination (pointing at ~{srv-api/srv-url}) to the destination-service resource's init_data");
}

/**
 * Binds the backend (nodejs) module to the xsuaa resource, if one exists
 * and it isn't bound already. patchPackageJson always sets
 * cds.requires.auth.[production].kind: "xsuaa" - CF sets NODE_ENV=production
 * automatically, so without this binding CAP tries to initialize xsuaa auth
 * at boot, finds no xsuaa credentials in VCAP_SERVICES, and the app crashes
 * immediately on start ("Some instances have crashed", no further detail
 * without pulling `cf logs`). Confirmed by an actual deploy on ai_report -
 * `cds add destination` does not add this binding on its own.
 */
function ensureXsuaaBinding(targetRoot) {
    const mtaPath = path.join(targetRoot, "mta.yaml");
    const lines = fs.readFileSync(mtaPath, "utf8").split("\n");

    const backend = findModuleBlock(lines, (blockLines) => blockLines.some((l) => /^\s*type:\s*nodejs\s*$/.test(l)));
    if (!backend) {
        console.log("  no backend (type: nodejs) module found - skipping the xsuaa binding");
        return;
    }
    const xsuaa = findModuleBlock(lines, (blockLines) => blockLines.some((l) => /^\s*service:\s*xsuaa\s*$/.test(l)));
    if (!xsuaa) {
        console.log("  no xsuaa resource found in mta.yaml - skipping the binding (auth may fail at boot if");
        console.log("  cds.requires.auth.[production].kind is \"xsuaa\" in package.json)");
        return;
    }

    const alreadyBound = lines.slice(backend.start, backend.end)
        .some((l) => new RegExp("^\\s*- name:\\s*" + xsuaa.name + "\\s*$").test(l));
    if (alreadyBound) {
        console.log("  backend module already requires the xsuaa resource \"" + xsuaa.name + "\" - left as is");
        return;
    }

    const requiresIdx = lines.slice(backend.start, backend.end).findIndex((l) => /^\s*requires:\s*$/.test(l));
    if (requiresIdx === -1) {
        console.log("  backend module has no requires: list - skipping the xsuaa binding, add it by hand");
        return;
    }
    const absIdx = backend.start + requiresIdx;
    const itemIndent = lines[absIdx].match(/^(\s*)/)[1] + "  ";
    const insertAt = findListEnd(lines, absIdx, itemIndent.length, backend.end);
    lines.splice(insertAt, 0, itemIndent + "- name: " + xsuaa.name);
    fs.writeFileSync(mtaPath, lines.join("\n"));
    console.log("  bound the backend module to the xsuaa resource \"" + xsuaa.name + "\"");
}

/**
 * Adds the production /nova route to xs-app.json, so the managed approuter
 * actually forwards chat calls to the srv-api destination above - the
 * production equivalent of patchUi5YamlBackends' local dev-server proxy.
 * Plain JSON, so this is a real parse/modify/write, not text surgery -
 * inserted before the last route (the SAP Fiori generator convention is a
 * catch-all "^(.*)$" route last; this keeps it last).
 */
function ensureXsAppRoute(targetRoot) {
    const xsAppPath = path.join(targetRoot, "xs-app.json");
    if (!fs.existsSync(xsAppPath)) {
        console.log("  no xs-app.json found - skipping the production /nova route");
        return;
    }
    const xsApp = readJson(xsAppPath);
    const routes = xsApp.routes || (xsApp.routes = []);

    if (routes.some((r) => r.destination === "srv-api")) {
        console.log("  xs-app.json already routes to srv-api - left as is");
        return;
    }

    const novaRoute = {
        source: "^/nova/(.*)$",
        target: "/nova/$1",
        authenticationType: "xsuaa",
        csrfProtection: false,
        destination: "srv-api"
    };
    const insertAt = routes.length > 0 ? routes.length - 1 : 0;
    routes.splice(insertAt, 0, novaRoute);
    writeJson(xsAppPath, xsApp);
    console.log("  added the /nova route to xs-app.json");
}

module.exports = {
    fail,
    readJson,
    writeJson,
    resolveTarget,
    copyVendoredFiles,
    copyCapFiles,
    patchManifest,
    patchPackageJson,
    patchUi5YamlBackends,
    writeEnvExample,
    runInstall,
    findModuleBlock,
    ensureBuildHook,
    setAiDestinationProperty,
    ensureSrvApiDestination,
    ensureXsuaaBinding,
    ensureXsAppRoute
};
