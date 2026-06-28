const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const backgroundScript = fs.readFileSync(path.join(__dirname, "..", "extension", "background.js"), "utf8")
  .replace(
    /import\s+\{[\s\S]*?\}\s+from "\.\/config\.js";/,
    'const FCDL_DEFAULT_BACKEND = ""; const FCDL_EXTENSION_BUILD = "test"; const FCDL_EXTENSION_BUILT_AT = ""; const FCDL_LOCAL_HELPER_API = "v1"; const FCDL_MIN_HELPER_VERSION = "0.4.1-go";'
  );

const listeners = [];
let helperHealth = { ok: true, version: "0.4.1-go" };
let failPrimaryHelperHost = false;
let lastDownload = null;
const fetchedUrls = [];
const bilibiliHelperFormats = [
  { formatId: "bili-dash-v-64", label: "720p", height: 720, ext: "mp4", vcodec: "avc1.640028", acodec: "none", filesize: 800_000 },
  { formatId: "bili-dash-a-30280", label: "audio", height: null, ext: "m4a", vcodec: "none", acodec: "mp4a.40.2", filesize: 128_000 },
  { formatId: "bili-dash-v-80", label: "1080p", height: 1080, ext: "mp4", vcodec: "avc1.640028", acodec: "none", filesize: 200_000 },
  { formatId: "bili-dash-v-120", label: "4K", height: 2160, ext: "mp4", vcodec: "hev1.2.4.L153", acodec: "none", filesize: 2_400_000 },
  { formatId: "bili-dash-v-112", label: "1080p+", height: 1080, ext: "mp4", vcodec: "hev1.2.4.L153", acodec: "none", filesize: 1_400_000 },
];
let currentTab = { id: 1, url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", title: "Test YouTube" };
const downloadChangeListeners = [];
const webRequestCompletedListeners = [];

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
      return currentTab;
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
    onCompleted: {
      addListener(fn) {
        webRequestCompletedListeners.push(fn);
      },
    },
  },
  cookies: {
    async getAll() {
      return [{ name: "SESSDATA", value: "local-session" }];
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
  Headers,
  console,
  chrome,
  fetch: async (url) => {
    fetchedUrls.push(String(url));
    if (String(url).includes("/health")) {
      if (failPrimaryHelperHost && String(url).startsWith("http://127.0.0.1:8765")) {
        throw new Error("primary loopback unavailable");
      }
      return { ok: true, json: async () => helperHealth };
    }
    if (String(url).includes("/formats?")) {
      const checkedUrl = new URL(String(url)).searchParams.get("url") || "";
      if (/\.(?:m3u8|mpd)(?:[?#]|$)/i.test(checkedUrl)) {
        return {
          ok: false,
          json: async () => ({ ok: false, error: "unsupported manifest fixture" }),
        };
      }
      if (/bilibili\.com|b23\.tv|bilibili\.tv/i.test(checkedUrl)) {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            service: "fcdownloader-native-helper",
            extractor: "BiliBiliAPI",
            title: "Bilibili Video",
            webpageUrl: checkedUrl,
            formats: bilibiliHelperFormats,
          }),
        };
      }
    }
    if (String(url).startsWith("https://fcdownloader-extractor.fly.dev/download?") && /bbb_30fps\.mpd/.test(String(url))) {
      return {
        ok: false,
        status: 502,
        headers: { get: () => "application/json" },
        text: async () => JSON.stringify({ error: "backend manifest fixture failed" }),
        json: async () => ({ error: "backend manifest fixture failed" }),
      };
    }
    if (String(url).startsWith("https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd")) {
      return {
        ok: true,
        headers: { get: (name) => name.toLowerCase() === "content-type" ? "application/dash+xml" : "3060" },
        json: async () => ({ ok: true }),
      };
    }
    return {
      ok: true,
      headers: { get: () => "video/mp4" },
      json: async () => ({ ok: true }),
    };
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

  helperHealth = { ok: true, version: "0.4.1-go" };
  const currentHelper = await send({ type: "fcdl:helper_status" });
  assert.strictEqual(currentHelper.ready, true);
  assert.strictEqual(currentHelper.problem, "");
  assert.strictEqual(currentHelper.health.helperBaseUrl, "http://127.0.0.1:8765");

  failPrimaryHelperHost = true;
  const fallbackHelper = await send({ type: "fcdl:helper_status" });
  assert.strictEqual(fallbackHelper.ready, true);
  assert.strictEqual(fallbackHelper.health.helperBaseUrl, "http://localhost:8765");
  const ensuredFallbackTools = await send({ type: "fcdl:helper_ensure_tools" });
  assert.strictEqual(ensuredFallbackTools.ok, true);
  assert(
    fetchedUrls.some((url) => url === "http://localhost:8765/tools/ensure"),
    "helper operations should keep using the detected loopback hostname"
  );
  failPrimaryHelperHost = false;

  currentTab = { id: 1, url: "https://publisher.example.com/post", title: "Publisher Post" };
  assert(webRequestCompletedListeners.length > 0, "background should register webRequest completion listener");
  webRequestCompletedListeners[0]({
    tabId: 1,
    url: "https://player.vimeo.com/video/123456789/config?h=privatehash",
    statusCode: 200,
    responseHeaders: [
      { name: "Content-Type", value: "application/json" },
      { name: "Content-Length", value: "2048" },
    ],
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const vimeoList = await send({ type: "fcdl:list", tabId: 1 });
  assert(vimeoList.items.some((item) =>
    item.url === "https://player.vimeo.com/video/123456789/config?h=privatehash" &&
    item.kind === "direct" &&
    item.source === "network"
  ), "Vimeo player config JSON should be captured from network events");

  const biliPage = "https://www.bilibili.com/video/BV1QkjC6nEQU/";
  currentTab = { id: 1, url: biliPage, title: "Bilibili Video" };
  await send({
    type: "fcdl:detected",
    tabId: 1,
    pageUrl: biliPage,
    items: [{
      url: biliPage,
      pageUrl: biliPage,
      kind: "embed",
      source: "bili-playinfo",
      label: "Bilibili",
      backendRouted: true,
    }],
  });
  for (const url of [
    "https://upos-hz-mirrorakam.akamaized.net/upgcxcode/25/27/39252722725/39252722725-1-30080.m4s?deadline=1",
    "https://upos-sz-mirrorcosov.bilivideo.com/upgcxcode/25/27/39252722725/39252722725-1-30280.m4s?deadline=1",
    "https://boss.hdslb.com/bfs/seed/jinkela/short/ai.m4s",
    "https://broadcast.chat.bilibili.com/sub",
  ]) {
    webRequestCompletedListeners[0]({
      tabId: 1,
      url,
      statusCode: 200,
      responseHeaders: [
        { name: "Content-Type", value: url.includes("30280") ? "audio/mp4" : "video/mp4" },
        { name: "Content-Length", value: "123456" },
      ],
    });
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  const biliList = await send({ type: "fcdl:list", tabId: 1 });
  assert.strictEqual(biliList.items.length, 1, `Bilibili CDN fragments should be hidden: ${JSON.stringify(biliList.items)}`);
  assert.strictEqual(biliList.items[0].source, "bili-playinfo");
  assert.strictEqual(biliList.items[0].url, biliPage);
  assert(
    biliList.technicalItems.length >= 3,
    `hidden Bilibili fragments should remain available as technical sources: ${JSON.stringify(biliList.technicalItems)}`
  );
  const biliExtract = await send({
    type: "fcdl:extract",
    tabId: 1,
    pageUrl: biliPage,
    referer: biliPage,
  });
  assert.strictEqual(biliExtract.ok, true, biliExtract.error);
  assert.strictEqual(biliExtract.info.source, "local-helper");
  assert.strictEqual(biliExtract.info.height, 2160);
  assert.strictEqual(biliExtract.info.formatId, "bili-dash-v-120");
  assert.match(biliExtract.info.label, /2160p/);

  const biliHelperFormats = await send({
    type: "fcdl:helper_formats",
    pageUrl: biliPage,
  });
  assert.strictEqual(biliHelperFormats.ok, true, biliHelperFormats.error);
  assert.strictEqual(biliHelperFormats.info.source, "local-helper");
  assert.strictEqual(biliHelperFormats.info.formatId, "bili-dash-v-120");
  assert.strictEqual(biliHelperFormats.info.formats.length, bilibiliHelperFormats.length);

  lastDownload = null;
  const biliDownload = await send({
    type: "fcdl:download",
    tabId: 1,
    item: biliList.items[0],
  });
  assert.strictEqual(biliDownload.ok, true, biliDownload.error);
  assert.strictEqual(biliDownload.route, "local helper");
  assert(lastDownload, "Bilibili should download through the local helper");
  assert.match(lastDownload.url, /^http:\/\/127\.0\.0\.1:8765\/download\?/);
  assert.match(lastDownload.url, /url=https%3A%2F%2Fwww\.bilibili\.com%2Fvideo%2FBV1QkjC6nEQU%2F/);
  assert(!/max_height=/.test(lastDownload.url), `Bilibili download should not cap quality: ${lastDownload.url}`);

  lastDownload = null;
  const selectedBiliDownload = await send({
    type: "fcdl:download",
    tabId: 1,
    item: {
      ...biliList.items[0],
      formatId: "bili-dash-v-64",
      maxHeight: "720",
      removeWatermark: true,
    },
  });
  assert.strictEqual(selectedBiliDownload.ok, true, selectedBiliDownload.error);
  assert(lastDownload, "Selected Bilibili options should download through the local helper");
  assert.match(lastDownload.url, /format=bili-dash-v-64/);
  assert.match(lastDownload.url, /max_height=720/);
  assert.match(lastDownload.url, /remove_watermark=1/);

  const articlePage = "https://publisher.example.com/watch/123";
  currentTab = { id: 1, url: articlePage, title: "Publisher Video" };
  webRequestCompletedListeners[0]({
    tabId: 1,
    url: "https://cdn.example-video.net/hls/segment-00001.mp4?token=abc&expires=999",
    statusCode: 200,
    responseHeaders: [
      { name: "Content-Type", value: "video/mp2t" },
      { name: "Content-Length", value: "262144" },
    ],
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  let noisyList = await send({ type: "fcdl:list", tabId: 1 });
  assert(
    noisyList.items.some((item) => item.source === "network"),
    "standalone network media should remain visible before a better page-level item exists"
  );
  await send({
    type: "fcdl:detected",
    tabId: 1,
    pageUrl: articlePage,
    items: [{
      url: articlePage,
      pageUrl: articlePage,
      kind: "embed",
      source: "backend",
      label: "Publisher Video",
      backendRouted: true,
    }],
  });
  noisyList = await send({ type: "fcdl:list", tabId: 1 });
  assert.strictEqual(noisyList.items.length, 1, `page-level media should hide CDN fragments: ${JSON.stringify(noisyList.items)}`);
  assert.strictEqual(noisyList.items[0].source, "backend");
  assert.strictEqual(noisyList.items[0].url, articlePage);
  assert.strictEqual(noisyList.technicalItems.length, 1, "hidden generic CDN fragment should be preserved");
  assert.match(noisyList.technicalItems[0].reason, /better page-level/i);

  currentTab = { id: 1, url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", title: "Test YouTube" };
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
  assert.strictEqual(localDownload.route, "local helper");
  assert.strictEqual(localDownload.progressUrl, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  assert(lastDownload, "local helper download should call chrome.downloads.download");
  assert(
    fetchedUrls.some((url) => url.startsWith("http://127.0.0.1:8765/formats?")),
    "local helper download should validate extraction before handing the URL to Chrome"
  );
  assert.match(lastDownload.url, /^http:\/\/127\.0\.0\.1:8765\/youtube-hd\?/);
  assert.match(lastDownload.url, /url=https%3A%2F%2Fwww\.youtube\.com%2Fwatch%3Fv%3DdQw4w9WgXcQ/);
  assert.strictEqual(lastDownload.filename, "Test YouTube.mp4");
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(lastDownload.headers)),
    [{ name: "X-FCDL-Cookies", value: "SESSDATA=local-session" }],
    "local companion should receive browser cookies even when remote cookie sharing is disabled"
  );

  const fallbackUrl = "https://cdn.example.com/video-360.mp4";
  await send({
    type: "fcdl:detected",
    tabId: 1,
    pageUrl: currentTab.url,
    items: [{
      url: fallbackUrl,
      pageUrl: currentTab.url,
      kind: "direct",
      source: "video-tag",
      title: "Browser fallback",
      ext: "mp4",
    }],
  });
  helperHealth = { ok: true, version: "0.2.0-go", apiVersion: "v0" };
  lastDownload = null;
  const outdatedFallback = await send({
    type: "fcdl:download",
    tabId: 1,
    item: {
      url: currentTab.url,
      pageUrl: currentTab.url,
      kind: "embed",
      source: "youtube-hd-local",
      title: "Test YouTube",
    },
  });
  assert.strictEqual(outdatedFallback.ok, true, outdatedFallback.error);
  assert.strictEqual(outdatedFallback.route, "direct");
  assert.strictEqual(lastDownload.url, fallbackUrl);

  helperHealth = { ok: true, version: "0.4.1-go" };
  lastDownload = null;
  const manifestDownload = await send({
    type: "fcdl:download",
    tabId: 1,
    item: {
      url: "https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd",
      pageUrl: "https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd",
      kind: "dash",
      source: "network",
      title: "DASH manifest",
    },
  });
  assert.strictEqual(manifestDownload.ok, false);
  assert.match(manifestDownload.error, /stream manifest requires helper\/backend download/);
  assert.strictEqual(lastDownload, null, "raw DASH manifests must not be saved through chrome.downloads");

  console.log("extension background helper tests passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
