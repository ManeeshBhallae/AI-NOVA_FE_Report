#!/usr/bin/env node
"use strict";

/**
 * Nova Copilot CF-prepare.
 *
 * A separate, optional step from install.js - run once an app already has
 * (or is about to get) CF deploy config, when you're getting ready to
 * actually deploy and want NOVA_AI_DESTINATION to resolve in production
 * instead of relying on AICORE_SERVICE_KEY.
 *
 * Does the normal install (same as install.js), then:
 *   - requires mta.yaml to exist - a destination can only resolve once the
 *     app is bound to a destination service instance, which only exists
 *     once deploy config does. No mta.yaml -> this command refuses to guess.
 *   - asks for the AI Core destination name (must already exist in BTP)
 *   - makes sure a CAP backend module + its own destination-service binding
 *     exist in mta.yaml, via CAP's own `cds add destination` if missing -
 *     not reinvented here, since getting MTA module wiring wrong is a lot
 *     riskier than getting it from the tool that already knows how
 *   - adds the before-all build hook mbt needs to actually produce gen/srv
 *   - writes NOVA_AI_DESTINATION onto that module as a deploy-time property
 *   - wires a "srv-api" destination into the destination-SERVICE resource's
 *     own init_data (pointing at ~{srv-api/srv-url}) and the matching
 *     /nova route into xs-app.json, so the deployed app can actually route
 *     chat calls to this backend in production - see ensureSrvApiDestination
 *     in lib.js for why it's the service resource and not the more obvious
 *     destination-content module
 *
 * Usage: node prepare-cf.js [path-to-target-app] [--destination <name>]
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const readline = require("readline");
const lib = require("./lib");

function parseArgs(argv) {
    let targetArg = ".";
    let destination = null;
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === "--destination" || argv[i] === "-d") {
            destination = argv[++i];
        } else if (!argv[i].startsWith("-")) {
            targetArg = argv[i];
        }
    }
    return { targetArg, destination };
}

function ask(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer.trim());
        });
    });
}

function hasBackendModule(mtaPath) {
    return /^\s*type:\s*nodejs\s*$/m.test(fs.readFileSync(mtaPath, "utf8"));
}

function ensureBackendModule(targetRoot) {
    const mtaPath = path.join(targetRoot, "mta.yaml");
    if (hasBackendModule(mtaPath)) {
        console.log("  backend module already present in mta.yaml - left as is");
        return;
    }

    const cdsBin = path.join(targetRoot, "node_modules", ".bin", "cds");
    if (!fs.existsSync(cdsBin)) {
        lib.fail("no backend module in mta.yaml, and @sap/cds-dk isn't installed yet to add one.\n" +
            "Run `npm install` first (install.js already added it as a devDependency), then re-run this.");
    }

    console.log("  no backend module in mta.yaml yet - running `npx cds add destination`...\n");
    try {
        execSync("npx cds add destination", { cwd: targetRoot, stdio: "inherit" });
    } catch (error) {
        lib.fail("`cds add destination` failed (see output above) - fix that first, then re-run this.");
    }

    if (!hasBackendModule(mtaPath)) {
        lib.fail("ran `cds add destination` but mta.yaml still has no backend module - something unexpected " +
            "about this project's layout. Check mta.yaml by hand.");
    }
    console.log("\n  backend module added (via cds add destination)");
}

async function main() {
    const { targetArg, destination: destinationArg } = parseArgs(process.argv.slice(2));
    const { targetRoot, appId } = lib.resolveTarget(targetArg);

    const mtaPath = path.join(targetRoot, "mta.yaml");
    if (!fs.existsSync(mtaPath)) {
        lib.fail("no mta.yaml found under " + targetRoot + " - this app has no CF deploy config yet.\n" +
            "A BTP destination can only resolve once the app is bound to a destination service instance, " +
            "which requires deploy config to exist first. Run `fiori add deploy-config`, then re-run this.");
    }

    const destinationName = destinationArg || await ask(
        "AI Core destination name (must already exist in BTP, in the subaccount you'll deploy to): "
    );
    if (!destinationName) {
        lib.fail("no destination name given - nothing to configure.");
    }

    console.log("\nPreparing " + appId + " for CF deploy with AI Core destination \"" + destinationName + "\"\n");

    console.log("Install (same as install.js):");
    lib.runInstall(targetArg);

    console.log("\nCF deploy config:");
    ensureBackendModule(targetRoot);
    lib.ensureBuildHook(targetRoot);
    lib.setAiDestinationProperty(targetRoot, destinationName);
    lib.ensureSrvApiDestination(targetRoot);
    lib.ensureXsAppRoute(targetRoot);

    console.log("\nDone. Next steps:");
    console.log("  1. npm install                 (if install.js reported new dependencies above)");
    console.log("  2. npm run build:mta           (verify it builds clean before deploying for real)");
    console.log("  3. cf deploy mta_archives/<name>.mtar");
}

main();
