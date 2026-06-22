const assert = require("assert");
const fs = require("fs");
const path = require("path");

const popup = fs.readFileSync(path.join(__dirname, "..", "extension", "popup.js"), "utf8");

assert(
  popup.includes("Backend not set; Companion and direct downloads still work."),
  "popup should show a non-blocking companion-only backend warning",
);
assert(
  !popup.includes("Backend URL isn't set yet."),
  "popup should not hard-block when the backend is missing",
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

console.log("extension popup companion-only tests passed");
