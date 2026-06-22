#!/usr/bin/env node
/**
 * Smoke-tests the distribution artifacts, not the source folders.
 *
 * By default this verifies:
 *   - dist/extension is not stale
 *   - helper /health is reachable and reports the expected build
 *   - dist/extension can detect the helper in Chrome
 *   - Bilibili extraction returns a 1080p local-helper item
 *
 * Pass --download to also run the full browser-extension download path.
 */
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, "..");
const DIST_EXTENSION = path.join(ROOT, "dist", "extension");
const DIST_MANIFEST = path.join(ROOT, "dist", "distribution-manifest.json");
const EXTENSION_RELEASE_MANIFEST = path.join(ROOT, "dist", "extension-release-manifest.json");
const HELPER = path.join(
  ROOT,
  "desktop-companion",
  "build",
  "helper",
  process.platform === "win32" ? "fcdownloader-local-helper.exe" : "fcdownloader-local-helper",
);
const DEFAULT_BILIBILI_URL = "https://www.bilibili.com/video/BV1Ccjy6MEcZ?spm_id_from=333.788.player.switch";
const bilibiliUrl = process.env.FCDL_BILIBILI_TEST_URL || DEFAULT_BILIBILI_URL;
const runDownload = process.argv.includes("--download") || process.env.FCDL_SMOKE_DOWNLOAD === "1";
const staticOnly = process.argv.includes("--static") || process.env.FCDL_SMOKE_STATIC === "1";

async function readJSON(file) {
  return JSON.parse(await fs.readFile(file, "utf-8"));
}

async function assertFreshDist() {
  const popup = await fs.readFile(path.join(DIST_EXTENSION, "popup.js"), "utf-8");
  const background = await fs.readFile(path.join(DIST_EXTENSION, "background.js"), "utf-8");
  const config = await fs.readFile(path.join(DIST_EXTENSION, "config.js"), "utf-8");
  if (/targetAddressSpace:\s*"local"/.test(popup + background)) {
    throw new Error("dist/extension is stale: found targetAddressSpace \"local\"");
  }
  if (/FCDL_EXTENSION_BUILD = "dev"/.test(config)) {
    throw new Error("dist/extension is stale: FCDL_EXTENSION_BUILD is still dev");
  }
}

async function helperHealth() {
  const response = await fetch("http://127.0.0.1:8765/health", { cache: "no-store" });
  if (!response.ok) throw new Error(`helper health HTTP ${response.status}`);
  return response.json();
}

async function waitForHelper() {
  const deadline = Date.now() + 15000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const health = await helperHealth();
      if (health?.ok) return health;
    } catch (e) {
      lastError = e;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw lastError || new Error("helper did not become healthy");
}

async function ensureHelper(expectedBuild) {
  try {
    const health = await helperHealth();
    if (health?.ok) {
      if (expectedBuild && health.helperBuild && health.helperBuild !== expectedBuild) {
        throw new Error(`helper on port 8765 is build ${health.helperBuild}, expected ${expectedBuild}. Restart the rebuilt helper.`);
      }
      return { health, process: null };
    }
  } catch {
    // Start below.
  }

  await fs.access(HELPER);
  const child = spawn(HELPER, [], { cwd: ROOT, stdio: "ignore" });
  const health = await waitForHelper();
  if (expectedBuild && health.helperBuild && health.helperBuild !== expectedBuild) {
    child.kill();
    throw new Error(`started helper build ${health.helperBuild}, expected ${expectedBuild}`);
  }
  return { health, process: child };
}

async function findChromeForTesting() {
  if (process.env.FCDL_CHROME_EXECUTABLE) return process.env.FCDL_CHROME_EXECUTABLE;
  const roots = [
    path.join(os.homedir(), ".cache", "puppeteer", "chrome"),
    path.join(os.homedir(), "Library", "Caches", "ms-playwright"),
  ];
  const candidates = [];
  async function walk(dir, depth = 0) {
    if (depth > 7) return;
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (
        entry.name === "Google Chrome for Testing" ||
        entry.name === "chrome" ||
        entry.name === "chrome.exe"
      ) {
        candidates.push(full);
      }
    }
  }
  for (const root of roots) await walk(root);
  candidates.sort((a, b) => b.localeCompare(a));
  return candidates.find((candidate) => /Chrome for Testing|chrome(?:\.exe)?$/.test(candidate)) || "";
}

async function importPlaywright() {
  try {
    return require("playwright");
  } catch (e) {
    throw new Error("Playwright is required for distribution smoke tests. Install it or run with the bundled runtime NODE_PATH. " + e.message);
  }
}

function formatQualityValue(format = {}) {
  for (const value of [format.quality, format.qn, format.id, format.formatId]) {
    const match = String(value || "").match(/\d+/);
    if (match) return Number(match[0]) || 0;
  }
  return 0;
}

function formatSizeValue(format = {}) {
  return Number(format.filesize || format.filesizeApprox || format.bandwidth || format.tbr || 0) || 0;
}

function bestVideoFormat(formats = []) {
  return [...formats]
    .filter((format) => format && format.vcodec !== "none")
    .sort((a, b) =>
      (Number(b.height || 0) - Number(a.height || 0)) ||
      (formatQualityValue(b) - formatQualityValue(a)) ||
      (formatSizeValue(b) - formatSizeValue(a)) ||
      (Number(b.width || 0) - Number(a.width || 0))
    )[0] || null;
}

async function runChromeSmoke(expectedBuild) {
  const { chromium } = await importPlaywright();
  const executablePath = await findChromeForTesting();
  if (!executablePath) {
    throw new Error("Chrome for Testing not found. Set FCDL_CHROME_EXECUTABLE to a Chrome-for-Testing binary.");
  }
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "fcdl-dist-smoke-"));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    executablePath,
    acceptDownloads: true,
    ignoreDefaultArgs: ["--disable-extensions"],
    args: [
      `--disable-extensions-except=${DIST_EXTENSION}`,
      `--load-extension=${DIST_EXTENSION}`,
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });
  try {
    let worker = context.serviceWorkers()[0];
    if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 15000 }).catch(() => null);
    const extensionId = worker ? new URL(worker.url()).host : null;
    if (!extensionId) throw new Error("dist extension did not load");

    const mediaPage = await context.newPage();
    await mediaPage.goto(bilibiliUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await mediaPage.waitForTimeout(1000);

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: "domcontentloaded" });
    await popup.waitForFunction(() => (document.querySelector("#helper-text")?.textContent || "").length > 0, { timeout: 12000 });
    await popup.waitForTimeout(1000);

    const result = await popup.evaluate(async ({ bilibiliUrl, runDownload }) => {
      const helper = await chrome.runtime.sendMessage({ type: "fcdl:helper_status" });
      const tabs = await chrome.tabs.query({ url: "*://www.bilibili.com/*" });
      const tab = tabs[0];
      if (!tab) throw new Error("Bilibili tab not found");
      const extract = await chrome.runtime.sendMessage({ type: "fcdl:extract", tabId: tab.id, pageUrl: bilibiliUrl });
      if (!extract?.ok) throw new Error(`extract failed: ${extract?.error}`);
      const info = extract.info || {};
      const out = {
        helper: {
          ready: helper?.ready,
          extensionBuild: helper?.extensionBuild,
          helperBuild: helper?.health?.helperBuild,
          helperVersion: helper?.health?.version,
          problem: helper?.problem,
        },
        extract: {
          source: info.source,
          label: info.label,
          height: info.height,
          formatId: info.formatId,
          formatsList: Array.isArray(info.formats) ? info.formats : [],
          formats: Array.isArray(info.formats) ? info.formats.length : null,
        },
        download: null,
      };
      if (runDownload) {
        const item = {
          url: info.url,
          title: info.title,
          label: info.label,
          height: info.height,
          ext: "mp4",
          kind: info.kind,
          source: info.source,
          backendRouted: info.backendRouted,
          pageUrl: bilibiliUrl,
          formatId: info.formatId,
          formats: info.formats,
        };
        const download = await chrome.runtime.sendMessage({ type: "fcdl:download", tabId: tab.id, item });
        if (!download?.ok) throw new Error(`download failed: ${download?.error}`);
        const deadline = Date.now() + 420000;
        let dl = null;
        while (Date.now() < deadline) {
          const matches = await chrome.downloads.search({ id: download.downloadId });
          dl = matches?.[0] || null;
          if (dl && (dl.state === "complete" || dl.state === "interrupted")) break;
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }
        out.download = {
          route: download.route,
          state: dl?.state,
          error: dl?.error,
          fileSize: dl?.fileSize,
          totalBytes: dl?.totalBytes,
          mime: dl?.mime,
        };
      }
      return out;
    }, { bilibiliUrl, runDownload });

    if (!result.helper.ready) throw new Error(`helper was not ready in dist extension: ${result.helper.problem || "unknown"}`);
    if (expectedBuild && result.helper.extensionBuild !== expectedBuild) {
      throw new Error(`extension build mismatch: got ${result.helper.extensionBuild}, expected ${expectedBuild}`);
    }
    if (expectedBuild && result.helper.helperBuild && result.helper.helperBuild !== expectedBuild) {
      throw new Error(`helper build mismatch: got ${result.helper.helperBuild}, expected ${expectedBuild}`);
    }
    if (Number(result.extract.height || 0) < 1080) {
      throw new Error(`Bilibili smoke did not find 1080p: ${JSON.stringify(result.extract)}`);
    }
    const bestFormat = bestVideoFormat(result.extract.formatsList || []);
    if (bestFormat && String(result.extract.formatId || "") !== String(bestFormat.formatId || bestFormat.id || "")) {
      throw new Error(`Bilibili smoke did not select the highest quality format: selected ${result.extract.formatId}, best ${bestFormat.formatId || bestFormat.id}`);
    }
    if (runDownload && result.download?.state !== "complete") {
      throw new Error(`Bilibili smoke download did not complete: ${JSON.stringify(result.download)}`);
    }
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await context.close();
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
}

await assertFreshDist();
const distribution = await readJSON(DIST_MANIFEST).catch(() => null);
const extensionRelease = await readJSON(EXTENSION_RELEASE_MANIFEST).catch(() => null);
const expectedBuild = distribution?.distributionBuild || extensionRelease?.extensionBuild || "";
const helper = await ensureHelper(expectedBuild);
try {
  if (staticOnly) {
    console.log(JSON.stringify({
      helper: {
        ready: true,
        helperBuild: helper.health?.helperBuild || "",
        helperVersion: helper.health?.version || "",
        minimumExtensionBuild: helper.health?.compatibility?.minimumExtensionBuild || "",
      },
      extension: {
        build: extensionRelease?.extensionBuild || "",
        version: extensionRelease?.extensionVersion || "",
        unpacked: extensionRelease?.unpacked || distribution?.extension || "",
        zip: extensionRelease?.zip || distribution?.extensionZip || "",
      },
    }, null, 2));
  } else {
    await runChromeSmoke(expectedBuild);
  }
  console.log("[smoke] distribution artifacts passed");
} finally {
  if (helper.process) helper.process.kill();
}
