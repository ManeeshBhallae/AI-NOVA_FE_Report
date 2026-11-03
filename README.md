# Nova Copilot

Reusable AI chat / chart / document-fill dock for **SAP Fiori Elements V2
(List Report + Object Page)** apps, extracted from `ai_report`. Explains the
screen, filters/sorts the table, runs live OData queries, builds charts,
navigates to and fills in records, and reads uploaded documents - all gated
by server-side guardrails, with record values never sent to the model.

v1 scope is OData V2 List Report / Object Page apps only (matches
`sap.suite.ui.generic.template`, `SmartFilterBar`, V2 `ODataModel`). V4 /
`sap.fe` is not supported yet.

## Complete install sequence (field-tested end to end on `ai_report`)

**Local dev:**
1. Clone this repo as a sibling of the target app (`git clone <this-repo> nova-copilot`).
2. From the app's own root: `node ../nova-copilot/packages/cli/install.js`
3. `npm install`
4. `cp .env.example .env`, fill in `AICORE_SERVICE_KEY` from a real AI Core service key.
5. *(optional)* drop a `webapp/nova-brief.json` describing the app.
6. Start the backend: `npm run start-srv` (not `watch-srv` - flaky in some sandboxes).
7. Start the frontend: `npm run start-mock` (or `npm start`).
8. Test locally - ask the chat something, try a filter/chart, confirm it works.

**Production / CF deploy, if you need it:**

9. Make sure the app has CF deploy config already (`mta.yaml`) - if not, `fiori add deploy-config` first.
10. Have a real AI Core **destination** in BTP with credentials that actually authenticate.
    **Important:** the cockpit's "Check Connection" button only tests that the URL is
    network-reachable *without* auth - it does **not** validate the OAuth2
    `clientId`/`clientSecret`. The only real test is an actual call through the app. If in
    doubt, use the same `clientId`/`clientSecret` as a `.env` you already know works.
11. `node ../nova-copilot/packages/cli/prepare-cf.js --destination <name>`
12. `npm run build:mta`
13. `npm run deploy` (or `cf deploy mta_archives/<name>.mtar`)
14. If your org's CF memory quota is tight, add `parameters: { memory: 256M, disk-quota:
    512M }` to the backend module in `mta.yaml` by hand, then rebuild and redeploy.
15. If anything 502s/404s/crashes: `cf logs <backend-app> --recent` and read the actual
    stack trace - every single bug found this session was found this way, not by
    guessing from the browser error alone.
16. To surface it in SAP Build Work Zone: register the app in Content Manager using its
    existing inbound navigation (semantic object/action already in `manifest.json`) - no
    extra destination work needed, `prepare-cf.js` already wired the production routing.

## Installing into an app - one command

```bash
cd your-fiori-app
node ../nova-copilot/packages/cli/install.js
```

(point it at the app's path as an argument if you're not running it from
inside the app's own root: `node .../install.js /path/to/your-fiori-app`.)

This **vendors** the dock straight into the target app's own repo - it is
not an npm dependency, so there's no registry to publish to and no `file:`/
symlink path assumption that would break for someone who just `git clone`d
the app on a different machine. After running it, the app is fully
self-contained:

- Copies the UI5 controller extensions, fragments, CSS and i18n bundle into
  `webapp/ext/novaCopilot/`, rewritten under the host app's **own**
  namespace (read from `sap.app.id` in its `manifest.json`) - e.g.
  `aireport.ext.novaCopilot.*` for `ai_report`. No separate UI5 library, no
  `sap.ui5.dependencies.libs` entry, nothing served from an external CDN.
- Patches `webapp/manifest.json` to add the two
  `sap.ui.controllerExtensions` entries (merges in, does not touch anything
  else already there).
- Copies the CAP `NovaService` (`nova-service.cds`/`.js`, `prompt.js`,
  `extractPrompt.js`) straight into the app's own `srv/` - ordinary files,
  no plugin, no `using` statement to add. Existing files are never
  overwritten (so a team's own edits to `prompt.js`, say, survive a re-run).
- Adds `@sap-ai-sdk/orchestration` and `pdf-parse` to `package.json`
  dependencies (merges in; run `npm install` afterwards to pick them up).
- Drops a `.env.example` at the app root documenting the AI Core
  credentials to provide.

Re-running the installer against an app that already has it refreshes the
`webapp/ext/novaCopilot/*` files (treat that folder as generated - don't
hand-edit it) and leaves `srv/*` alone if those files already exist.

### AI Core credentials - local vs. production

One code path, picked at runtime, not two separate installs:

- **Local dev**: `AICORE_SERVICE_KEY` in `.env` (the SDK's own default
  fallback). Always available, regardless of deploy config.
- **Production**: `NOVA_AI_DESTINATION=<destination name>` instead - the
  service looks up that BTP destination. This only resolves if the app is
  bound to a destination service instance, which requires CF deploy config
  to exist first.

`install.js` alone only covers the local-dev path. For production, run the
second command:

```bash
node ../nova-copilot/packages/cli/prepare-cf.js
```

It refuses to run at all if the app has no `mta.yaml` yet (a destination
can't resolve without deploy config - run `fiori add deploy-config` first).
If `mta.yaml` exists, it:

1. Runs the normal install (same as `install.js`).
2. Asks for the AI Core destination name (must already exist in BTP, in the
   subaccount you'll deploy to) - or pass it directly with
   `--destination <name>` to skip the prompt.
3. Adds a CAP backend deployment module + its own destination-service
   binding, if missing - via `npx cds add destination` (CAP's own official
   scaffolding, not reinvented here; **not** `cds add ai`, which scaffolds a
   direct service binding instead and isn't what `NOVA_AI_DESTINATION` uses).
4. Adds the `before-all: cds build --production` hook `mbt build` needs -
   without it, a fresh build fails with `"gen/srv" path ... does not exist`,
   since `gen/` is `cds build`'s own output and nothing else produces it.
5. Writes `NOVA_AI_DESTINATION: <name>` as a property on that backend
   module in `mta.yaml` (updates it in place on a re-run with a different
   name, rather than duplicating).
6. Wires a `srv-api` destination into the destination-**service** resource's
   own `init_data` (pointing at `~{srv-api/srv-url}` - resolves to wherever
   the backend module actually gets deployed), with a `requires: srv-api`
   added to that resource so the placeholder resolves, and adds the
   matching `/nova` route to `xs-app.json`. Both idempotent.

   Confirmed via a real `cf deploy` on `ai_report` - the separate
   destination-**content** module (the more obvious place) actually
   rejects any destination lacking `ServiceInstanceName`, even plain
   external/placeholder-URL ones (`Missing destination property
   [ServiceInstanceName]`, reproduced on two different destinations before
   finding this). The destination-service resource's own `init_data` is
   where the app's existing `ui5` destination already lived and deployed
   successfully, so `srv-api` goes there too - a resource requiring a
   module's output inverts the usual direction, but it deploys correctly.

7. Binds the backend module to the xsuaa resource, if one exists and isn't
   bound already. Without it: `install.js`'s `patchPackageJson` always sets
   `cds.requires.auth.[production].kind: "xsuaa"`, CF sets
   `NODE_ENV=production` automatically, so CAP tries to initialize xsuaa
   auth at boot and finds no bound credentials - the app crashes
   immediately on start ("Some instances have crashed", no further detail
   without pulling `cf logs <app> --recent`). Found the same way as the
   `srv-api` fix: by an actual deploy crashing at this exact step.
8. Sets the backend module's CF start command to `npx cds-serve`
   explicitly. In the common Fiori Tools layout (frontend and backend
   sharing one `package.json`), `cds build` copies that whole file into
   the built backend - `"start"` script included - so letting the
   buildpack default to `npm start` runs the UI5 dev server command
   instead (`fiori: not found`, exit 127, crash-looping forever). Found by
   pulling `cf logs <app> --recent` after fix #7 resolved the previous
   crash and a *new* one appeared.

Separately, if your org's CF memory quota is tight, you may also need to
add `parameters: { memory: 256M, disk-quota: 512M }` (or whatever fits) to
the backend module by hand - the default Node buildpack asks for 1024M,
which can fail staging with "organization's memory limit exceeded" on a
constrained space. Not automated, since the right value depends on your
quota.

That's the whole production-config side of things - 4 steps end to end:
`install.js` (or skip straight to `prepare-cf.js`, which does the same
install first) → fill in the destination name → `npm run build:mta` →
`cf deploy`.

### After installing

1. `npm install` (only needed if the installer added new dependencies).
2. `cp .env.example .env` and fill in your own AI Core service key - see
   `packages/cap-module/.env.example` for the shape. **Never commit a real
   key.** Each app keeps its own credentials; nothing is shared between
   apps.
3. Optionally drop a `webapp/nova-brief.json` telling the assistant what the
   app is *for* in business terms (purpose, users, key concepts) - see
   `ai_report/webapp/nova-brief.json` for the shape. Entirely optional.
4. Start the app's own CAP service, then run the app - the launcher mounts
   itself in the bottom-right corner with no further wiring.

## Repo layout

- `packages/ui5-lib/src/nova/copilot/` - the canonical source the installer
  copies from (under the fallback namespace `nova.copilot`, only used if
  this package is ever consumed directly as a UI5 library instead of
  vendored).
- `packages/cap-module/srv/` - the canonical CAP service source.
- `packages/cli/install.js` - the installer described above.

## Out of scope for v1

- V4 / `sap.fe` floorplans.
- A shared/central Nova backend - every consuming app keeps its own CAP
  service instance and its own AI Core credentials.
