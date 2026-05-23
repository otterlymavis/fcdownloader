// fcdownloader web frontend
//
// Talks to the Fly-hosted extractor backend. Set the URL via either:
//   1. <meta name="extractor-url" content="..."> in index.html, or
//   2. window.EXTRACTOR_URL = "..." inline before this script loads, or
//   3. ?api=https://... query param (handy for testing without a rebuild)
//   4. fall back to the hard-coded default below

const DEFAULT_BACKEND = "https://fcdownloader-extractor.fly.dev";

function getBackend() {
  const qs = new URLSearchParams(location.search).get("api");
  if (qs) return qs.replace(/\/+$/, "");
  if (window.EXTRACTOR_URL) return window.EXTRACTOR_URL.replace(/\/+$/, "");
  const meta = document.querySelector('meta[name="extractor-url"]');
  if (meta?.content) return meta.content.replace(/\/+$/, "");
  return DEFAULT_BACKEND;
}

const BACKEND = getBackend();

// ── DOM ─────────────────────────────────────────────────────────────────────

const $       = (id) => document.getElementById(id);
const form    = $("form");
const urlIn   = $("url");
const submit  = $("submit");
const status  = $("status");
const preview = $("preview");
const thumb   = $("thumb");
const title   = $("title");
const meta    = $("meta");
const downloadBtn = $("download");
const quality = $("quality");

// ── UI helpers ──────────────────────────────────────────────────────────────

function setStatus(text, isError = false) {
  if (!text) { status.hidden = true; status.textContent = ""; return; }
  status.hidden = false;
  status.textContent = text;
  status.classList.toggle("error", isError);
}

function setBusy(busy) {
  submit.disabled = busy;
  submit.textContent = busy ? "Fetching…" : "Fetch";
}

function fmtDuration(seconds) {
  if (!Number.isFinite(seconds)) return "";
  seconds = Math.floor(seconds);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// ── API calls ───────────────────────────────────────────────────────────────

async function extract(pageUrl) {
  const r = await fetch(`${BACKEND}/extract`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pageUrl }),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => r.statusText);
    throw new Error(`${r.status} — ${detail.slice(0, 200)}`);
  }
  return r.json();
}

function downloadUrl(pageUrl) {
  return `${BACKEND}/download?url=${encodeURIComponent(pageUrl)}`;
}

// ── Handlers ────────────────────────────────────────────────────────────────

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const v = urlIn.value.trim();
  if (!v) return;
  preview.hidden = true;
  setBusy(true);
  setStatus("Resolving stream URLs…");
  try {
    const info = await extract(v);
    preview.hidden = false;
    setStatus("");
    thumb.src   = info.thumbnail ?? "";
    title.textContent = info.title ?? v;
    quality.textContent = info.label ? `(${info.label})` : "";
    const bits = [];
    if (info.label)    bits.push(info.label);
    if (info.duration) bits.push(fmtDuration(info.duration));
    if (info.kind)     bits.push(info.kind);
    meta.textContent = bits.join(" · ");
    downloadBtn.onclick = () => { location.href = downloadUrl(v); };
  } catch (err) {
    setStatus(`Could not extract: ${err.message}`, true);
  } finally {
    setBusy(false);
  }
});

// Autofill from ?url= for share-link convenience
const sharedUrl = new URLSearchParams(location.search).get("url");
if (sharedUrl) {
  urlIn.value = sharedUrl;
  form.requestSubmit();
}
