#!/usr/bin/env node
"use strict";

/**
 * Nova Copilot installer.
 *
 * Vendors the AI dock (UI5 controller extensions, fragments, CSS, i18n) and
 * the CAP backend (NovaService) straight into a target Fiori Elements V2
 * app's own webapp/ and srv/ folders, under the app's own namespace, and
 * patches its manifest.json / package.json to wire them in.
 *
 * Deliberately NOT an npm dependency: the target app ends up fully
 * self-contained, so it works the same whether it was just cloned from git
 * or not - no registry, no file:/symlink path assumptions, no risk of a
 * second @sap/cds instance.
 *
 * Usage (run from inside nova-copilot/packages/cli, or anywhere via its
 * absolute path):
 *   node install.js <path-to-target-app>   (defaults to the current directory)
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
    console.error("\nnova-copilot installer: " + message);
    process.exit(1);
}

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, data) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
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
    if (!fs.existsSync(manifestPath)) {
        fail("no webapp/manifest.json found under " + targetRoot + " - is this a Fiori Elements app?");
    }
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

function writeEnvExample(targetRoot) {
    const dest = path.join(targetRoot, ".env.example");
    if (fs.existsSync(dest)) {
        console.log("  .env.example already exists - left as is");
        return;
    }
    const src = path.join(__dirname, "..", "cap-module", ".env.example");
    fs.copyFileSync(src, dest);
    console.log("  wrote .env.example (copy to .env and fill in your own AI Core credentials)");
}

function main() {
    const targetArg = process.argv[2] || ".";
    const targetRoot = path.resolve(process.cwd(), targetArg);

    const manifestPath = path.join(targetRoot, "webapp", "manifest.json");
    if (!fs.existsSync(manifestPath)) {
        fail("no webapp/manifest.json found under " + targetRoot +
            "\nRun this from a Fiori Elements V2 app's root, or pass its path: node install.js <path>");
    }
    const manifest = readJson(manifestPath);
    const appId = manifest["sap.app"] && manifest["sap.app"].id;
    if (!appId) {
        fail("webapp/manifest.json has no sap.app.id - can't derive a namespace to install under");
    }

    const nsDot = appId + ".ext.novaCopilot";
    const nsSlash = appId.replace(/\./g, "/") + "/ext/novaCopilot";

    console.log("Installing Nova Copilot into " + targetRoot + " as \"" + nsDot + "\"\n");

    console.log("Frontend:");
    copyVendoredFiles(targetRoot, nsDot, nsSlash);
    patchManifest(targetRoot, nsDot);

    console.log("\nBackend:");
    copyCapFiles(targetRoot);
    const depsChanged = patchPackageJson(targetRoot);
    writeEnvExample(targetRoot);

    console.log("\nDone. Next steps:");
    if (depsChanged) {
        console.log("  1. npm install                 (picks up the two new dependencies)");
    }
    console.log("  " + (depsChanged ? "2" : "1") + ". cp .env.example .env, then fill in your AI Core credentials");
    console.log("  " + (depsChanged ? "3" : "2") + ". optionally drop a webapp/nova-brief.json describing what this app is for");
    console.log("  " + (depsChanged ? "4" : "3") + ". start your CAP service, then run the app - the launcher mounts itself");
}

main();
