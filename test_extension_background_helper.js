const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const backgroundScript = fs.readFileSync(path.join(__dirname, "extension", "background.js"), "utf8")
  .replace(/import \{ FCDL_DEFAULT_BACKEND \} from "\.\/config\.js";/, 'const FCDL_DEFAULT_BACKEND = "";');

const listeners = [];
let helperHealth = { ok: true, version: "0.3.0-go" };
let lastDownload = null;
const downloadChangeListeners = [];

const chrome = {
  runtime: {
    onInstalled: { addListener() {} },
    onMessage: {
      addListener(fn) {
        listeners.push(fn);
      },
    },
    getManifest() {
      return { version: "0.0.0" };
    },
  },
  storage: {
    sync: {
      async get(defaults) {
        return defaults || {};
      },
      async set() {},
    },
  },
  tabs: {
    onRemoved: { addListener() {} },
    onUpdated: { addListener() {} },
    async get() {
      return { id: 1, url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" };
    },
    async create() {
      return { id: 2 };
    },
    async sendMessage() {
      return { ok: false };
    },
  },
  action: {
    setBadgeText() {},
    setBadgeBackgroundColor() {},
  },
  webRequest: {
    onBeforeSendHeaders: { addListener() {} },
    onCompleted: { addListener() {} },
  },
  cookies: {
    async getAll() {
      return [];
    },
  },
  downloads: {
    onChanged: {
      addListener(fn) {
        downloadChangeListeners.push(fn);
      },
      removeListener(fn) {
        const index = downloadChangeListeners.indexOf(fn);
        if (index >= 0) downloadChangeListeners.splice(index, 1);
      },
    },
    search(_query, cb) {
      cb([{ id: 1, state: "complete", filename: "Test YouTube.mp4", fileSize: 1024 * 1024 }]);
    },
    download(opts, cb) {
      lastDownload = opts;
      cb(1);
      setTimeout(() => {
        for (const listener of [...downloadChangeListeners]) {
          listener({ id: 1, state: { current: "complete" } });
        }
      }, 0);
    },
  },
};

vm.runInNewContext(backgroundScript, {
  URL,
  URLSearchParams,
  AbortController,
  console,
  chrome,
  fetch: async (url) => {
    if (String(url).includes("/health")) {
      return { ok: true, json: async () => helperHealth };
    }
    return { ok: true, json: async () => ({ ok: true }) };
  },
  btoa: (value) => Buffer.from(value, "binary").toString("base64"),
  unescape,
  encodeURIComponent,
  setTimeout,
  clearTimeout,
}, { filename: "extension/background.js" });

assert.strictEqual(listeners.length, 1);

function send(msg) {
  return new Promise((resolve) => {
    listeners[0](msg, { tab: { id: 1, url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" } }, resolve);
  });
}

(async () => {
  helperHealth = { ok: true, version: "0.2.0-go" };
  const oldHelper = await send({ type: "fcdl:helper_status" });
  assert.strictEqual(oldHelper.ready, false);
  assert.match(oldHelper.problem, /outdated/i);

  helperHealth = { ok: true, version: "0.3.0-go" };
  const currentHelper = await send({ type: "fcdl:helper_status" });
  assert.strictEqual(currentHelper.ready, true);
  assert.strictEqual(currentHelper.problem, "");

  lastDownload = null;
  const localDownload = await send({
    type: "fcdl:download",
    tabId: 1,
    item: {
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      pageUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      kind: "embed",
      source: "youtube-hd-local",
      title: "Test YouTube",
    },
  });
  assert.strictEqual(localDownload.ok, true, localDownload.error);
  assert(lastDownload, "local helper download should call chrome.downloads.download");
  assert.match(lastDownload.url, /^http:\/\/127\.0\.0\.1:8765\/youtube-hd\?/);
  assert.match(lastDownload.url, /url=https%3A%2F%2Fwww\.youtube\.com%2Fwatch%3Fv%3DdQw4w9WgXcQ/);
  assert.strictEqual(lastDownload.filename, "Test YouTube.mp4");

  console.log("extension background helper tests passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
