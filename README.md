# Nova Copilot

Reusable AI chat / chart / document-fill dock for **SAP Fiori Elements V2
(List Report + Object Page)** apps, extracted from `ai_report`. Explains the
screen, filters/sorts the table, runs live OData queries, builds charts,
navigates to and fills in records, and reads uploaded documents - all gated
by server-side guardrails, with record values never sent to the model.

v1 scope is OData V2 List Report / Object Page apps only (matches
`sap.suite.ui.generic.template`, `SmartFilterBar`, V2 `ODataModel`). V4 /
`sap.fe` is not supported yet.

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
- **Production**: set `NOVA_AI_DESTINATION=<destination name>` instead - the
  service then looks up that BTP destination. This only resolves if the app
  is bound to a destination service instance, which requires CF deploy
  config to exist first. The installer detects this (checking for
  `mta.yaml` and a `nodejs` module in it) and tells you exactly what's
  missing:
  - no `mta.yaml` → destination-based config isn't reachable yet; run
    `fiori add deploy-config` first.
  - `mta.yaml` but no backend module → run `npx cds add destination` (not
    `cds add ai`, which scaffolds a direct service binding instead and
    isn't what `NOVA_AI_DESTINATION` uses). This adds both the CAP backend
    deployment module and a destination-service binding for it.
  - backend module already present → just create the actual AI Core
    destination in BTP and set `NOVA_AI_DESTINATION` to its name.

This only covers the AI Core credential path. It does **not** cover routing
(e.g. an approuter's `/nova` route forwarding to the deployed backend) -
that's a separate piece of your deployment config.

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
