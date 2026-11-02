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
 * This only covers local dev (AICORE_SERVICE_KEY in .env). For wiring up a
 * BTP destination for production, see prepare-cf.js instead.
 *
 * Usage: node install.js <path-to-target-app>   (defaults to the current directory)
 */

const fs = require("fs");
const path = require("path");
const lib = require("./lib");

function main() {
    const { targetRoot, depsChanged } = lib.runInstall(process.argv[2]);

    const mtaPath = path.join(targetRoot, "mta.yaml");
    const hasDeployConfig = fs.existsSync(mtaPath);
    const hasBackendModule = hasDeployConfig && /type:\s*nodejs/.test(fs.readFileSync(mtaPath, "utf8"));

    console.log("\nAI Core credentials - two ways to supply them, same code either way:");
    console.log("  - Local dev: cp .env.example .env, fill in AICORE_SERVICE_KEY.");
    if (hasDeployConfig && hasBackendModule) {
        console.log("  - Production: this app already deploys a backend module. Run:");
        console.log("      node " + path.relative(targetRoot, path.join(__dirname, "prepare-cf.js")));
        console.log("    to wire a BTP destination name into mta.yaml for it.");
    } else if (hasDeployConfig) {
        console.log("  - Production: this app has CF deploy config but no backend module yet. Run:");
        console.log("      node " + path.relative(targetRoot, path.join(__dirname, "prepare-cf.js")));
        console.log("    which adds the backend module, a destination-service binding, and wires in");
        console.log("    an AI Core destination name you provide.");
    } else {
        console.log("  - Production / destination-based config isn't available yet - this app has");
        console.log("    no mta.yaml (no CF deploy config), so there is nothing to bind a destination");
        console.log("    service instance to. Run `fiori add deploy-config` first if you want that.");
    }

    console.log("\nDone. Next steps:");
    let step = 1;
    if (depsChanged) {
        console.log("  " + step++ + ". npm install                 (picks up the two new dependencies)");
    }
    console.log("  " + step++ + ". set up AI Core credentials as described above");
    console.log("  " + step++ + ". optionally drop a webapp/nova-brief.json describing what this app is for");
    console.log("  " + step++ + ". start your CAP service, then run the app - the launcher mounts itself");
}

main();
