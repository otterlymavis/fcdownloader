#!/usr/bin/env node
/**
 * Packages the browser extension for public distribution.
 *
 * Reads `EXTENSION_DEFAULT_BACKEND` from the environment, copies
 * `extension/` to `dist/extension/`, replaces FCDL_DEFAULT_BACKEND inside
 * `dist/extension/config.js` with the env value, then zips the directory
 * to `dist/fcdownloader-extension-v<version>.zip` for upload to Chrome
 * Web Store / Firefox AMO / direct distribution.
 *
 * Usage:
 *   EXTENSION_DEFAULT_BACKEND=https://your-instance.fly.dev \
 *     node scripts/pack-extension.mjs
 *
 * The committed `extension/config.js` is never modified.
 */
import { promises as fs, createWriteStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SRC  = path.join(ROOT, "extension");
const OUT  = path.join(ROOT, "dist", "extension");

const backend = (process.env.EXTENSION_DEFAULT_BACKEND ?? "").trim().replace(/\/+$/, "");
if (!backend) {
  console.error(
    "EXTENSION_DEFAULT_BACKEND is not set. Re-run with the URL of your backend:\n" +
    "  EXTENSION_DEFAULT_BACKEND=https://your-instance.fly.dev node scripts/pack-extension.mjs"
  );
  process.exit(1);
}
if (!/^https?:\/\//.test(backend)) {
  console.error(`EXTENSION_DEFAULT_BACKEND must start with http:// or https:// (got: ${backend})`);
  process.exit(1);
}

async function copyDir(src, dst) {
  await fs.mkdir(dst, { recursive: true });
  for (const entry of await fs.readdir(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) await copyDir(s, d);
    else await fs.copyFile(s, d);
  }
}

console.log(`[pack] cleaning ${path.relative(ROOT, OUT)}`);
await fs.rm(OUT, { recursive: true, force: true });

console.log(`[pack] copying ${path.relative(ROOT, SRC)} → ${path.relative(ROOT, OUT)}`);
await copyDir(SRC, OUT);

const configPath = path.join(OUT, "config.js");
let cfg = await fs.readFile(configPath, "utf-8");
const replaced = cfg.replace(
  /export const FCDL_DEFAULT_BACKEND = "[^"]*";/,
  `export const FCDL_DEFAULT_BACKEND = ${JSON.stringify(backend)};`,
);
if (replaced === cfg) {
  console.error("[pack] FAILED to substitute FCDL_DEFAULT_BACKEND — has the pattern in config.js changed?");
  process.exit(1);
}
await fs.writeFile(configPath, replaced, "utf-8");
console.log(`[pack] baked backend URL into ${path.relative(ROOT, configPath)}`);

// Read version from the source manifest for the zip filename.
const manifest = JSON.parse(await fs.readFile(path.join(SRC, "manifest.json"), "utf-8"));
const version  = manifest.version || "0.0.0";

// Use Node 22+ built-in zip via the `node:zlib` approach — actually there's
// no built-in zip writer, but the cross-platform path is to spawn `zip`
// (Unix) or `Compress-Archive` (Windows). Stick to a JS-only writer so
// CI doesn't need extra tools: use the well-known `adm-zip` if available,
// else fall back to a system command.
let zipPath = path.join(ROOT, "dist", `fcdownloader-extension-v${version}.zip`);
try {
  const { default: AdmZip } = await import("adm-zip");
  const zip = new AdmZip();
  zip.addLocalFolder(OUT);
  zip.writeZip(zipPath);
  console.log(`[pack] zipped → ${path.relative(ROOT, zipPath)}`);
} catch (e) {
  console.warn("[pack] adm-zip not available — skipping zip step. Install with:");
  console.warn("       npm install --save-dev adm-zip");
  console.warn(`[pack] unpacked extension is ready at ${path.relative(ROOT, OUT)}`);
  console.warn("[pack] You can zip it manually for Chrome Web Store / AMO upload.");
}

console.log("[pack] done.");
