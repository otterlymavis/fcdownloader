#!/usr/bin/env node
/**
 * Builds the paired FCDownloader distribution artifacts:
 *   - desktop-companion/build/helper/fcdownloader-local-helper
 *   - dist/extension/
 *   - dist/fcdownloader-extension-v<version>.zip
 *
 * This script deliberately regenerates dist/extension from extension/ so
 * Chrome cannot keep testing or shipping a stale copied extension folder.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DIST_EXTENSION_CONFIG = path.join(ROOT, "dist", "extension", "config.js");
const EXTENSION_MANIFEST = path.join(ROOT, "extension", "manifest.json");
const RELEASE_MANIFEST = path.join(ROOT, "dist", "distribution-manifest.json");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env: { ...process.env, ...options.env },
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function gitShortSha() {
  try {
    const sha = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
      cwd: ROOT,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const dirty = execFileSync("git", ["status", "--short"], {
      cwd: ROOT,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return "nogit";
  }
}

async function backendFromExistingDist() {
  try {
    const config = await fs.readFile(DIST_EXTENSION_CONFIG, "utf-8");
    const match = config.match(/FCDL_DEFAULT_BACKEND = "([^"]+)";/);
    return match?.[1]?.trim() || "";
  } catch {
    return "";
  }
}

const manifest = JSON.parse(await fs.readFile(EXTENSION_MANIFEST, "utf-8"));
const extensionVersion = manifest.version || "0.0.0";
const builtAt = (process.env.FCDL_DISTRIBUTION_BUILT_AT || new Date().toISOString()).trim();
const buildId = (
  process.env.FCDL_DISTRIBUTION_BUILD ||
  `${extensionVersion}-${gitShortSha()}-${builtAt.replace(/[-:.TZ]/g, "").slice(0, 14)}`
).trim();
const backend = (
  process.env.EXTENSION_DEFAULT_BACKEND ||
  await backendFromExistingDist()
).trim().replace(/\/+$/, "");

if (!/^https?:\/\//.test(backend)) {
  console.error(
    "No distribution backend URL found. Set EXTENSION_DEFAULT_BACKEND, e.g.:\n" +
    "  EXTENSION_DEFAULT_BACKEND=https://fcdownloader.fly.dev npm run build:distribution"
  );
  process.exit(1);
}

console.log(`[distribution] build=${buildId}`);
console.log(`[distribution] backend=${backend}`);

run("npm", ["--prefix", "desktop-companion", "run", "helper:build:go"], {
  env: {
    FCDL_HELPER_BUILD: buildId,
    FCDL_MIN_EXTENSION_BUILD: extensionVersion,
  },
});

run("npm", ["run", "pack:extension"], {
  env: {
    EXTENSION_DEFAULT_BACKEND: backend,
    FCDL_EXTENSION_BUILD: buildId,
    FCDL_EXTENSION_BUILT_AT: builtAt,
    FCDL_MIN_HELPER_VERSION: "0.4.1-go",
  },
});

const out = {
  extensionVersion,
  distributionBuild: buildId,
  builtAt,
  backend,
  helper: "desktop-companion/build/helper/fcdownloader-local-helper",
  extension: "dist/extension",
  extensionZip: `dist/fcdownloader-extension-v${extensionVersion}.zip`,
};
await fs.writeFile(RELEASE_MANIFEST, JSON.stringify(out, null, 2) + "\n", "utf-8");
console.log(`[distribution] wrote ${path.relative(ROOT, RELEASE_MANIFEST)}`);
console.log("[distribution] done");
