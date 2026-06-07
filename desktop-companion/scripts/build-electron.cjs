const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const COMPANION_ROOT = path.resolve(__dirname, "..");
const BUILD_ROOT = path.join(COMPANION_ROOT, "build");
const ELECTRON_CACHE = path.join(BUILD_ROOT, "electron-cache");
const ELECTRON_BUILDER_CACHE = path.join(BUILD_ROOT, "electron-builder-cache");
const cli = path.join(COMPANION_ROOT, "node_modules", "electron-builder", "cli.js");

fs.mkdirSync(ELECTRON_CACHE, { recursive: true });
fs.mkdirSync(ELECTRON_BUILDER_CACHE, { recursive: true });

const signingEnv = {};
const builderArgs = process.argv.slice(2);
if (!process.env.CSC_LINK && !process.env.WIN_CSC_LINK) {
  signingEnv.CSC_IDENTITY_AUTO_DISCOVERY = "false";
  if (process.platform === "win32") {
    builderArgs.push("--config.win.signAndEditExecutable=false");
  }
}

const result = spawnSync(process.execPath, [cli, ...builderArgs], {
  cwd: COMPANION_ROOT,
  stdio: "inherit",
  shell: false,
  env: {
    ...process.env,
    ELECTRON_CACHE,
    ELECTRON_BUILDER_CACHE,
    ...signingEnv,
  },
});

if (result.error) throw result.error;
process.exit(result.status ?? 0);
