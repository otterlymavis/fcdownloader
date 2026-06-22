const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const backgroundScript = fs.readFileSync(path.join(__dirname, "..", "extension", "background.js"), "utf8")
  .replace(
    /import\s+\{[\s\S]*?\}\s+from "\.\/config\.js";/,
    'const FCDL_DEFAULT_BACKEND = ""; const FCDL_EXTENSION_BUILD = "test"; const FCDL_EXTENSION_BUILT_AT = ""; const FCDL_LOCAL_HELPER_API = "v1"; const FCDL_MIN_HELPER_VERSION = "0.4.1-go";',
  );

const listeners = [];
const tabUrl = "https://www.rednote.com/explore/69fdcbfa0000000023004a17";

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
      return { id: 7, url: tabUrl };
    },
    async sendMessage() {
      throw new Error("no content script in test");
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
    onChanged: { addListener() {} },
    async download() {
      return 1;
    },
  },
};

vm.runInNewContext(backgroundScript, {
  URL,
  URLSearchParams,
  console,
  chrome,
  fetch: async () => ({ ok: true, json: async () => ({}) }),
  btoa: (value) => Buffer.from(value, "binary").toString("base64"),
  unescape,
  encodeURIComponent,
  setTimeout,
  clearTimeout,
}, { filename: "extension/background.js" });

assert.strictEqual(listeners.length, 1);

function send(msg) {
  return new Promise((resolve) => {
    listeners[0](msg, { tab: { id: 7, url: tabUrl } }, resolve);
  });
}

(async () => {
  await send({
    type: "fcdl:detected",
    items: [
      {
        url: "https://webapi.rednote.com/api/sns/web/v1/note/feed",
        kind: "audio",
        source: "network",
        mime: "audio/mp4",
      },
      {
        url: "https://as.rednote.com/api/redcaptcha/v2",
        kind: "audio",
        source: "network",
        mime: "audio/mpeg",
      },
      {
        url: "https://sns-avatar-qc.xhscdn.com/avatar/user-one",
        kind: "image",
        source: "network",
        mime: "image/webp",
      },
    ],
  });

  const pruned = await send({ type: "fcdl:list", tabId: 7 });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(pruned.items)), [{
    url: tabUrl,
    pageUrl: tabUrl,
    kind: "embed",
    source: "xhs-page",
    label: "Xiaohongshu",
    backendRouted: true,
    capturedAt: pruned.items[0].capturedAt,
    priority: 100,
  }]);

  await send({
    type: "fcdl:detected",
    items: [{
      url: tabUrl,
      pageUrl: tabUrl,
      kind: "embed",
      source: "xhs-page",
      label: "Xiaohongshu",
      backendRouted: true,
    }],
  });

  const listed = await send({ type: "fcdl:list", tabId: 7 });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(listed.items)), [{
    url: tabUrl,
    pageUrl: tabUrl,
    kind: "embed",
    source: "xhs-page",
    label: "Xiaohongshu",
    backendRouted: true,
    capturedAt: listed.items[0].capturedAt,
    priority: 100,
  }]);

  console.log("extension background XHS tests passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
