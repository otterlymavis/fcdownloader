const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const release = require(path.join(root, "release.json"));
const config = fs.readFileSync(path.join(root, "extension", "config.js"), "utf8");
const variants = fs.readFileSync(
  path.join(root, "desktop-companion", "scripts", "build-variants.cjs"),
  "utf8",
);
const electronMain = fs.readFileSync(
  path.join(root, "desktop-companion", "src", "main.cjs"),
  "utf8",
);

assert(
  config.includes(`FCDL_LOCAL_HELPER_API = "${release.localHelperApi}"`),
  "extension helper API must match release.json",
);
assert(
  variants.includes("-X main.apiVersion=${RELEASE.localHelperApi}") &&
    variants.includes("-X main.serviceVersion=${RELEASE.localHelperVersion}"),
  "Go helper builds must receive compatibility metadata from release.json",
);
assert(
  variants.includes('"Owner" "nobrowser-go"'),
  "canonical Go installer must identify itself as protocol owner",
);
assert(
  variants.includes("fcdownloader-companion-legacy"),
  "legacy installer must use a separate protocol",
);
assert(
  electronMain.includes('const PROTOCOL = "fcdownloader-companion-electron"'),
  "Electron companion must not replace the canonical public protocol",
);
assert(
  variants.includes("ReadRegStr $0") && variants.includes("StrCmp $0"),
  "uninstallers must verify ownership before removing protocol registrations",
);
assert(
  variants.includes('Section /o "Run Companion on login" SecRunAtLogin'),
  "canonical installer should keep login startup opt-in",
);

console.log("companion version contract tests passed");
