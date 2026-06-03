#!/usr/bin/env node
/**
 * FCDownloader — browser-extension end-to-end test tool.
 *
 * Unlike `test_all_urls.py` (which only pokes the backend /extract endpoint or
 * injects URLs into the Android app), this drives the REAL browser extension as
 * a user would: it launches Chrome with the unpacked extension loaded, opens
 * each sample URL in a real tab, lets the content script + webRequest capture
 * run, then fires the extension's own message API (fcdl:extract / fcdl:list /
 * fcdl:download) — the exact calls popup.js makes when you click the toolbar
 * button. So a PASS here means the installed extension actually detects (and,
 * with --download, actually saves) media on the live page.
 *
 * The URL list is parsed straight from test_all_urls.py so there is one source
 * of truth.
 *
 * Setup (one time):
 *   npm install            # installs playwright (devDependency)
 *   # Auto-detects a browser: installed Chrome, then Edge, then a managed
 *   # Chromium. To force one:  --channel chrome | msedge | ''   ('' = managed).
 *   # For the managed build:  npx playwright install chromium
 *
 * Usage:
 *   node scripts/test-extension-urls.mjs                 # detect-only, all URLs
 *   node scripts/test-extension-urls.mjs youtube xhs     # only named platforms
 *   node scripts/test-extension-urls.mjs --download      # also save files + verify bytes
 *   node scripts/test-extension-urls.mjs --cookies       # allow the extension to read profile cookies
 *   node scripts/test-extension-urls.mjs --headless      # run headless (new headless supports MV3)
 *   node scripts/test-extension-urls.mjs --backend https://your-instance.fly.dev
 *   node scripts/test-extension-urls.mjs --ext dist/extension   # test a baked build
 *   node scripts/test-extension-urls.mjs --detect 9000   # ms to wait for capture per page
 *   node scripts/test-extension-urls.mjs --keep-open     # leave the browser open at the end
 *
 * What counts as PASS:
 *   PASS    backend /extract returned media (a video/audio kind, or a gallery)
 *   DETECT  /extract found nothing but the extension captured media in-page
 *           (network/DOM) — the popup can still download it. Counted as a pass.
 *   FAIL    neither extraction nor capture produced any media.
 *
 * Login/geo-gated sites (Instagram, TVer, XHS server route, ...) may DETECT or
 * FAIL without cookies / the right region — that is a source-site limitation,
 * not an extension bug. Run with --cookies after logging into those sites in
 * the test profile to exercise the authenticated path.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DEFAULT_BACKEND = "https://fcdownloader-extractor.fly.dev";

// ── arg parsing ─────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = {
    platforms: [],
    download: false,
    cookies: false,
    headless: false,
    keepOpen: false,
    backend: DEFAULT_BACKEND,
    ext: path.join(ROOT, "extension"),
    channel: null, // null = auto: try chrome, then msedge, then bundled chromium
    detect: 6000,
    dlTimeout: 60000,
    nav: 45000,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--download") opts.download = true;
    else if (a === "--cookies") opts.cookies = true;
    else if (a === "--headless") opts.headless = true;
    else if (a === "--keep-open") opts.keepOpen = true;
    else if (a === "--backend") opts.backend = (argv[++i] || "").trim().replace(/\/+$/, "");
    else if (a === "--ext") opts.ext = path.resolve(ROOT, argv[++i] || "");
    else if (a === "--channel") { opts.channel = argv[++i] ?? ""; opts.channelExplicit = true; }
    else if (a === "--detect") opts.detect = Number(argv[++i]) || opts.detect;
    else if (a === "--dl-timeout") opts.dlTimeout = Number(argv[++i]) || opts.dlTimeout;
    else if (a === "--nav") opts.nav = Number(argv[++i]) || opts.nav;
    else if (a === "--help" || a === "-h") opts.help = true;
    else if (a.startsWith("--")) { console.error(`Unknown flag: ${a}`); process.exit(2); }
    else opts.platforms.push(a.toLowerCase());
  }
  return opts;
}

// ── pull the URL table out of test_all_urls.py (single source of truth) ──────
async function loadUrls() {
  const py = await fs.readFile(path.join(ROOT, "test_all_urls.py"), "utf-8");
  const block = py.match(/URLS\s*=\s*\{([\s\S]*?)\n\}/);
  if (!block) throw new Error("Could not locate the URLS dict in test_all_urls.py");
  const entries = [];
  // "Name": ("https://url", "note"),   (note may live on the next line)
  const re = /"([^"]+)"\s*:\s*\(\s*"((?:[^"\\]|\\.)*)"\s*,\s*"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(block[1])) !== null) {
    entries.push({ name: m[1], url: m[2], note: m[3] });
  }
  if (!entries.length) throw new Error("Parsed zero URLs from test_all_urls.py");
  return entries;
}

// ── browser-side helpers (run inside the extension popup page context) ───────
// One round-trip to the service worker, mirroring popup.js's sendMessage().
const SEND_MESSAGE = ({ message, timeoutMs }) =>
  new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => {
      if (!done) { done = true; resolve({ ok: false, error: "popup→sw timeout", __timeout: true }); }
    }, timeoutMs);
    try {
      chrome.runtime.sendMessage(message, (resp) => {
        if (done) return;
        done = true;
        clearTimeout(t);
        const err = chrome.runtime.lastError;
        if (err) resolve({ ok: false, error: err.message });
        else resolve(resp);
      });
    } catch (e) {
      if (!done) { done = true; clearTimeout(t); resolve({ ok: false, error: String(e && e.message || e) }); }
    }
  });

const send = (bridge, message, timeoutMs = 35000) =>
  bridge.evaluate(SEND_MESSAGE, { message, timeoutMs });

// Resolve the chrome tab id for the live target page. The bridge popup is a
// chrome-extension:// page, so the only http(s) tab is the one under test.
const findTabId = (bridge, url) =>
  bridge.evaluate(
    (wantUrl) =>
      new Promise((resolve) => {
        chrome.tabs.query({}, (tabs) => {
          const http = (tabs || []).filter((t) => /^https?:/.test(t.url || ""));
          const t =
            http.find((x) => x.url === wantUrl) ||
            http.find((x) => x.active) ||
            http[http.length - 1];
          resolve(t ? { id: t.id, url: t.url } : null);
        });
      }),
    url,
  );

// Poll chrome.downloads until the given id finishes (or we time out). Used to
// confirm a real file actually lands on disk, not just that download() returned.
const waitForDownload = (bridge, id, timeoutMs) =>
  bridge.evaluate(
    ({ id, timeoutMs }) =>
      new Promise((resolve) => {
        const deadline = Date.now() + timeoutMs;
        const tick = () => {
          chrome.downloads.search({ id }, (items) => {
            const d = items && items[0];
            if (d && (d.state === "complete" || (d.state === "in_progress" && d.bytesReceived > 0))) {
              resolve({ ok: true, state: d.state, bytes: d.bytesReceived, total: d.totalBytes, filename: d.filename });
            } else if (d && d.state === "interrupted") {
              resolve({ ok: false, error: d.error || "interrupted", filename: d.filename });
            } else if (Date.now() > deadline) {
              resolve({ ok: false, error: "download timeout", state: d ? d.state : "none" });
            } else {
              setTimeout(tick, 750);
            }
          });
        };
        tick();
      }),
    { id, timeoutMs },
  );

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(await fs.readFile(fileURLToPath(import.meta.url), "utf-8").then((s) => s.split("\n").slice(1, 60).join("\n")));
    return;
  }

  // confirm the extension folder looks real before launching anything
  try {
    await fs.access(path.join(opts.ext, "manifest.json"));
  } catch {
    console.error(`No manifest.json under ${opts.ext}. Pass --ext <dir> pointing at the extension folder.`);
    process.exit(2);
  }

  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    console.error(
      "Playwright is not installed. Install it first:\n" +
      "  npm install            # picks up the playwright devDependency\n" +
      "It will drive your installed Chrome (channel \"chrome\"). For a managed\n" +
      "browser instead, run:  npx playwright install chromium  --  then add --channel ''",
    );
    process.exit(2);
  }

  const all = await loadUrls();
  const targets = opts.platforms.length
    ? all.filter((e) => opts.platforms.includes(e.name.toLowerCase()))
    : all;
  if (!targets.length) {
    console.error("No matching platforms. Available:\n  " + all.map((e) => e.name).join(", "));
    process.exit(2);
  }

  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "fcdl-ext-test-"));
  const launchArgs = [
    `--disable-extensions-except=${opts.ext}`,
    `--load-extension=${opts.ext}`,
    "--no-first-run",
    "--no-default-browser-check",
  ];
  console.log(
    `Backend: ${opts.backend || "(none — server extraction will fail)"}\n` +
    `Mode: ${opts.download ? "download + verify bytes" : "detect-only"}` +
    `${opts.cookies ? "  +cookies" : ""}\n`,
  );

  // Pick a browser: an explicit --channel wins; otherwise try installed Chrome,
  // then installed Edge, then a Playwright-managed Chromium. Extensions need a
  // real Chromium-family browser, so this covers the common Windows/macOS setup.
  const candidates = opts.channelExplicit
    ? [opts.channel]
    : ["chrome", "msedge", ""]; // "" = bundled chromium
  let context = null;
  const launchErrors = [];
  for (const channel of candidates) {
    const launchOpts = { headless: opts.headless, args: launchArgs };
    if (channel) launchOpts.channel = channel;
    try {
      context = await chromium.launchPersistentContext(userDataDir, launchOpts);
      console.log(`Launched ${channel || "chromium"}${opts.headless ? " (headless)" : ""} with extension:\n  ${opts.ext}\n`);
      break;
    } catch (e) {
      launchErrors.push(`  ${channel || "chromium"}: ${String(e.message || e).split("\n")[0]}`);
    }
  }
  if (!context) {
    console.error("Could not launch a Chromium-family browser. Tried:\n" + launchErrors.join("\n"));
    console.error(
      "\nInstall one of: Google Chrome, Microsoft Edge, or a managed Chromium:\n" +
      "  npx playwright install chromium",
    );
    process.exit(1);
  }

  // Wait for the MV3 service worker so we can learn the extension id.
  let sw = context.serviceWorkers()[0];
  if (!sw) {
    sw = await context.waitForEvent("serviceworker", { timeout: 15000 }).catch(() => null);
  }
  if (!sw) {
    console.error(
      "Extension service worker never started. In older headless Chrome MV3 " +
      "extensions don't load — try without --headless.",
    );
    await context.close();
    process.exit(1);
  }
  const extId = new URL(sw.url()).host;
  console.log(`Extension id: ${extId}\n`);

  // The bridge page is the extension's own popup.html — a real extension
  // context with chrome.runtime/tabs/downloads/storage, exactly like the popup.
  const bridge = await context.newPage();
  await bridge.goto(`chrome-extension://${extId}/popup.html`);

  // Seed settings the way onInstalled/options would, so /extract is usable.
  await bridge.evaluate(
    ({ backend, allowCookies }) =>
      new Promise((resolve) => {
        chrome.storage.sync.set({ backend, allowCookies, muxRemote: true }, () => resolve(true));
      }),
    { backend: opts.backend, allowCookies: opts.cookies },
  );

  const results = [];
  const width = Math.max(...targets.map((t) => t.name.length));

  for (const { name, url, note } of targets) {
    const row = { name, url, note, status: "FAIL", detail: "", seconds: 0, download: null };
    const t0 = Date.now();
    const page = await context.newPage();
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: opts.nav }).catch(() => {});
      // Give content.js + webRequest + lazy players time to surface media.
      await page.waitForTimeout(opts.detect);
      const finalUrl = page.url();

      const tab = await findTabId(bridge, finalUrl);
      if (!tab) throw new Error("could not resolve the page's tab id");
      const tabId = tab.id;

      // Same call popup.js makes on the toolbar button.
      const ex = await send(bridge, { type: "fcdl:extract", tabId, pageUrl: finalUrl }, 35000);
      const list = await send(bridge, { type: "fcdl:list", tabId }, 5000);
      const captured = Array.isArray(list?.items) ? list.items.length : 0;

      let downloadable = null; // { gallery } | { item }
      if (ex?.ok && ex.info) {
        const info = ex.info;
        if (info.kind === "gallery" && Array.isArray(info.items) && info.items.length) {
          row.status = "PASS";
          row.detail = `gallery: ${info.items.length} items`;
          downloadable = { gallery: info };
        } else if (info.kind) {
          row.status = "PASS";
          row.detail = `${info.kind} — ${String(info.title || "").slice(0, 36)}`;
          // Build the exact item popup.js would download (non-gallery path).
          const isYtdlStream = typeof info.url === "string" && info.url.includes("/ytdl-stream?");
          downloadable = {
            item: {
              url: isYtdlStream ? finalUrl : info.kind === "paired" ? info.videoUrl : info.url,
              title: info.title,
              label: isYtdlStream ? "HD (local helper)" : info.label,
              width: info.width,
              height: info.height,
              ext: "mp4",
              kind: isYtdlStream ? "embed" : info.kind,
              source: isYtdlStream ? "youtube-hd-local" : "backend",
              backendRouted: !isYtdlStream,
              pageUrl: finalUrl,
              formatId: info.formatId,
              formats: info.formats,
            },
          };
        } else {
          row.detail = "extract returned no media kind";
        }
      }

      if (row.status !== "PASS") {
        if (captured > 0) {
          row.status = "DETECT";
          row.detail = `in-page capture: ${captured} item${captured === 1 ? "" : "s"}` +
            (ex?.error ? `  (extract: ${String(ex.error).slice(0, 50)})` : "");
          downloadable = { item: { ...list.items[0], pageUrl: finalUrl } };
        } else {
          row.detail = String(ex?.error || ex?.detail || "no media").slice(0, 70);
        }
      }

      // Real download path — fire the same message and verify bytes hit disk.
      if (opts.download && downloadable) {
        try {
          if (downloadable.gallery) {
            const g = downloadable.gallery;
            const r = await send(
              bridge,
              { type: "fcdl:download_gallery", tabId, pageUrl: finalUrl, title: g.title, items: g.items },
              120000,
            );
            row.download = r?.ok
              ? { ok: r.failed ? false : true, detail: `gallery started ${r.started || 0}, failed ${r.failed || 0}` }
              : { ok: false, detail: String(r?.error || "failed") };
          } else {
            const r = await send(
              bridge,
              { type: "fcdl:download", tabId, item: downloadable.item },
              90000,
            );
            if (r?.ok && r.downloadId != null) {
              const v = await waitForDownload(bridge, r.downloadId, opts.dlTimeout);
              row.download = v.ok
                ? { ok: true, detail: `${v.state}, ${formatBytes(v.bytes)}`, filename: v.filename }
                : { ok: false, detail: String(v.error) };
            } else {
              row.download = { ok: false, detail: String(r?.error || "download() failed") };
            }
          }
        } catch (e) {
          row.download = { ok: false, detail: String(e.message || e).slice(0, 70) };
        }
      }
    } catch (e) {
      row.detail = String(e.message || e).slice(0, 70);
    } finally {
      row.seconds = (Date.now() - t0) / 1000;
      await page.close().catch(() => {});
    }

    results.push(row);
    printRow(row, width);
  }

  // ── summary + report ─────────────────────────────────────────────────────
  const pass = results.filter((r) => r.status === "PASS").length;
  const detect = results.filter((r) => r.status === "DETECT").length;
  const fail = results.filter((r) => r.status === "FAIL").length;
  console.log(`\n${pass} PASS, ${detect} DETECT, ${fail} FAIL  (of ${results.length})`);
  if (opts.download) {
    const dlOk = results.filter((r) => r.download?.ok).length;
    const dlTried = results.filter((r) => r.download).length;
    console.log(`Downloads verified: ${dlOk}/${dlTried}`);
  }

  const reportDir = path.join(ROOT, "artifacts");
  await fs.mkdir(reportDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = path.join(reportDir, `extension-test-${stamp}.json`);
  await fs.writeFile(
    reportPath,
    JSON.stringify({ when: new Date().toISOString(), opts: { ...opts, ext: opts.ext }, results }, null, 2),
    "utf-8",
  );
  console.log(`Report: ${path.relative(ROOT, reportPath)}`);

  if (opts.keepOpen) {
    console.log("\n--keep-open: browser left running. Ctrl+C to exit.");
    await new Promise(() => {});
  }
  await context.close().catch(() => {});
  await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  process.exit(fail === results.length ? 1 : 0);
}

function formatBytes(n) {
  if (!n || n < 0) return "0 B";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

function printRow(row, width) {
  const tag = row.status === "PASS" ? "PASS  " : row.status === "DETECT" ? "DETECT" : "FAIL  ";
  let line = `[${tag}] ${row.name.padEnd(width)}  ${row.detail}  (${row.seconds.toFixed(1)}s)`;
  if (row.download) line += `  {dl: ${row.download.ok ? "OK" : "X"} ${row.download.detail}}`;
  if (row.note) line += `  <${row.note}>`;
  console.log(line);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
