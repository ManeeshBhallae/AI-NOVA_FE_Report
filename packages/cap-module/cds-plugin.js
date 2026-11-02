// CAP auto-requires this file for every npm dependency that has one (see
// @sap/cds/lib/plugins.js). Its mere presence is what makes CAP read this
// package's own package.json#cds section (see @sap/cds/lib/env/cds-env.js),
// which is where `cds.requires.nova.model` actually registers the service -
// so a host app gets NovaService just by having this package installed,
// with no `using` statement and no srv/ code of its own to write.
"use strict";

const cds = require("@sap/cds");
cds.log("nova").info("nova-copilot-cap plugin active - NovaService will be served at /nova");
