const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const COMPANION_ROOT = path.resolve(__dirname, "..");
const GO_HELPER_DIR = path.join(COMPANION_ROOT, "nobrowser-go-helper");
const BUILD_DIR = path.join(COMPANION_ROOT, "build", "helper");
const EXE = process.platform === "win32" ? "fcdownloader-local-helper.exe" : "fcdownloader-local-helper";
const OUT = path.join(BUILD_DIR, EXE);

if (!fs.existsSync(path.join(GO_HELPER_DIR, "main.go"))) {
  console.error(`[build-companion-go] Go helper source not found at ${GO_HELPER_DIR}`);
  process.exit(1);
}

fs.mkdirSync(BUILD_DIR, { recursive: true });

const goCmd = process.env.FCDL_GO || "go";
const helperBuild = (process.env.FCDL_HELPER_BUILD || "dev").trim() || "dev";
const minimumExtensionBuild = (process.env.FCDL_MIN_EXTENSION_BUILD || "1.5.24").trim() || "1.5.24";
const ldflags = [
  "-s",
  "-w",
  `-X main.helperBuild=${helperBuild}`,
  `-X main.minimumExtensionBuild=${minimumExtensionBuild}`,
].join(" ");

const result = spawnSync(
  goCmd,
  ["build", "-trimpath", "-ldflags", ldflags, "-o", OUT, "."],
  {
    cwd: GO_HELPER_DIR,
    env: { ...process.env, CGO_ENABLED: "0", GO111MODULE: "off" },
    stdio: "inherit",
    shell: false,
  }
);

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

if (process.platform !== "win32") fs.chmodSync(OUT, 0o755);

console.log(`[build-companion-go] Built Go helper → ${OUT}`);
console.log(`[build-companion-go] helperBuild=${helperBuild} minimumExtensionBuild=${minimumExtensionBuild}`);
