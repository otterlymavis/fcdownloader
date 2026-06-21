const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const contentScript = fs.readFileSync(path.join(__dirname, "..", "extension", "content.js"), "utf8");

function createElement(tagName, attrs = {}) {
  return {
    tagName,
    naturalWidth: attrs.naturalWidth || 0,
    naturalHeight: attrs.naturalHeight || 0,
    videoWidth: attrs.videoWidth || 0,
    videoHeight: attrs.videoHeight || 0,
    currentSrc: attrs.currentSrc || "",
    src: attrs.src || "",
    getAttribute(name) {
      return attrs[name] || "";
    },
    closest() {
      return null;
    },
  };
}

function runContentScript({ url, html, images = [], metas = [], vimeoElements = [] }) {
  const messages = [];
  const locationUrl = new URL(url);
  const documentElement = { outerHTML: html || "<html></html>" };
  const document = {
    documentElement,
    querySelectorAll(selector) {
      if (selector === "img, picture source") return images;
      if (selector.includes("meta[")) return metas;
      if (selector.includes("data-vimeo")) return vimeoElements;
      return [];
    },
  };

  class MutationObserver {
    observe() {}
  }

  const context = vm.createContext({
    URL,
    console,
    navigator: { languages: ["en-US"], language: "en-US" },
    location: {
      href: locationUrl.href,
      hostname: locationUrl.hostname,
      pathname: locationUrl.pathname,
    },
    document,
    window: {},
    chrome: {
      runtime: {
        sendMessage(message) {
          messages.push(message);
        },
        onMessage: {
          addListener() {},
        },
      },
    },
    MutationObserver,
    setInterval() {
      return 1;
    },
    clearInterval() {},
    setTimeout(fn) {
      fn();
      return 1;
    },
    clearTimeout() {},
    fetch: async () => ({ json: async () => ({}) }),
  });

  vm.runInContext(contentScript, context, { filename: "extension/content.js" });
  return messages;
}

function detectedItems(messages) {
  return JSON.parse(JSON.stringify(messages.flatMap((message) => message.items || [])));
}

{
  const avatar = createElement("IMG", {
    src: "https://sns-avatar-qc.xhscdn.com/avatar/user-one.webp",
    naturalWidth: 320,
    naturalHeight: 320,
  });
  const ogAvatar = createElement("META", {
    content: "https://sns-avatar-qc.xhscdn.com/avatar/profile.webp",
  });

  const items = detectedItems(runContentScript({
    url: "https://www.rednote.com/explore/69fdcbfa0000000023004a17",
    html: "<html><head></head><body>login required</body></html>",
    images: [avatar],
    metas: [ogAvatar],
  }));

  assert.deepStrictEqual(items, [{
    url: "https://www.rednote.com/explore/69fdcbfa0000000023004a17",
    pageUrl: "https://www.rednote.com/explore/69fdcbfa0000000023004a17",
    kind: "embed",
    source: "xhs-page",
    label: "Xiaohongshu",
    backendRouted: true,
  }]);
}

{
  const html = `
    <html><body><script>
      window.__INITIAL_STATE__={
        "note":{"currentNoteId":"69fdcbfa0000000023004a17","noteDetailMap":{
          "69fdcbfa0000000023004a17":{"note":{
            "user":{"avatar":"https://sns-avatar-qc.xhscdn.com/avatar/user-one.webp"},
            "imageList":[
              {"urlDefault":"https://sns-avatar-qc.xhscdn.com/avatar/ignored.webp"},
              {"urlDefault":"http://sns-webpic-qc.xhscdn.com/202606010247/full/notes_pre_post/a!nd_dft_jpg_3"}
            ]
          }}
        }}
      }
    </script></body></html>
  `;

  const items = detectedItems(runContentScript({
    url: "https://www.xiaohongshu.com/explore/69fdcbfa0000000023004a17",
    html,
  }));

  assert.deepStrictEqual(items.map((item) => item.url), [
    "http://sns-webpic-qc.xhscdn.com/202606010247/full/notes_pre_post/a!nd_dft_jpg_3",
  ]);
  assert(items.every((item) => item.source === "xhs-state"));
  assert(items.every((item) => !item.url.includes("avatar")));
}

{
  const vimeoElement = createElement("DIV", {
    "data-vimeo-url": "https://vimeo.com/987654321/deadbeef12",
  });
  const items = detectedItems(runContentScript({
    url: "https://publisher.example.com/post",
    html: "<html><body><div data-vimeo-url=\"https://vimeo.com/987654321/deadbeef12\"></div></body></html>",
    vimeoElements: [vimeoElement],
  }));

  assert(items.some((item) =>
    item.url === "https://player.vimeo.com/video/987654321/config?h=deadbeef12" &&
    item.source === "vimeo-data-attribute" &&
    item.kind === "direct"
  ));
}

{
  const html = `
    <html><body>
      <div id="vimeo-player"></div>
      <script src="https://player.vimeo.com/api/player.js"></script>
      <script>
        new Vimeo.Player("vimeo-player", {
          url: "https://vimeo.com/123456789/privatehash",
          responsive: true
        });
      </script>
    </body></html>
  `;

  const items = detectedItems(runContentScript({
    url: "https://publisher.example.com/post",
    html,
  }));

  assert(items.some((item) =>
    item.url === "https://player.vimeo.com/video/123456789/config?h=privatehash" &&
    item.source === "vimeo-player-sdk" &&
    item.kind === "direct"
  ));
}

console.log("extension content XHS tests passed");
