const assert = require("assert");
const fs = require("fs");
const path = require("path");

const popup = fs.readFileSync(path.join(__dirname, "..", "extension", "popup.js"), "utf8");
const config = fs.readFileSync(path.join(__dirname, "..", "extension", "config.js"), "utf8");
const optionsHtml = fs.readFileSync(path.join(__dirname, "..", "extension", "options.html"), "utf8");
const optionsJs = fs.readFileSync(path.join(__dirname, "..", "extension", "options.js"), "utf8");

assert(
  config.includes('FCDL_DEFAULT_BACKEND = "https://fcdownloader-extractor.fly.dev"'),
  "extension source should include the production backend",
);
assert(!optionsHtml.includes('id="backend"'), "options should not expose a backend URL field");
assert(!optionsJs.includes('$("backend")'), "options code should not read or save a backend URL");

assert(
  !popup.includes("Backend not set; Companion and direct downloads still work."),
  "popup should not expose backend configuration state",
);
assert(
  !popup.includes("Open settings and add the FCDownloader backend URL."),
  "popup should not ask users to configure the bundled backend",
);
assert(
  !popup.includes("return;  // skip the refresh loop: nothing to fetch"),
  "popup should keep refreshing detected media without a backend",
);
assert(
  popup.includes("renderTechnicalSources") && popup.includes("Show technical sources"),
  "popup should expose hidden raw captures behind a technical sources toggle",
);
assert(
  popup.includes("helperFormatCache") && popup.includes("fcdl:helper_formats"),
  "popup should hydrate helper quality options without requiring a full extract",
);
assert(
  popup.includes("quality-select") && popup.includes("watermark-toggle"),
  "popup should expose quality and watermark controls before download",
);
assert(
  popup.includes("function likelyUsesCompanion") && popup.includes("startProgressPolling(companionProgressTarget)"),
  "popup should start companion progress polling before long helper preflight work",
);
assert(
  popup.includes('data.status === "starting"') && popup.includes('setProgressIndeterminate("Companion is starting download...")'),
  "popup should show an active companion state before numeric download percent is available",
);

console.log("extension popup companion-only tests passed");
