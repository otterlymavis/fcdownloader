const api = globalThis.browser || globalThis.chrome;

const DEFAULT_SETTINGS = {
  target: "fcdownloader",
  customTemplate: "fcdownloader://share?url={url}",
};

function encode(value) {
  return encodeURIComponent(String(value || ""));
}

function commandFor(target, template, pageUrl, mediaUrl) {
  const source = mediaUrl || pageUrl;
  if (target === "fcdownloader") {
    return `fcdownloader://share?url=${encode(source)}`;
  }
  if (target === "shortcuts") {
    return `shortcuts://run-shortcut?name=${encode("FCDownloader")}&input=text&text=${encode(source)}`;
  }
  if (target === "ashell") {
    const cmd = `curl -L ${JSON.stringify(source)}`;
    return `a-shell://?command=${encode(cmd)}`;
  }
  return String(template || DEFAULT_SETTINGS.customTemplate)
    .replaceAll("{url}", encode(source))
    .replaceAll("{pageUrl}", encode(pageUrl))
    .replaceAll("{mediaUrl}", encode(mediaUrl || ""));
}

async function getSettings() {
  const stored = await api.storage.local.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...stored };
}

async function activeTab() {
  const tabs = await api.tabs.query({ active: true, currentWindow: true });
  return tabs && tabs[0] ? tabs[0] : null;
}

async function sendToDownloader(payload) {
  const tab = await activeTab();
  const pageUrl = payload?.pageUrl || tab?.url || "";
  const mediaUrl = payload?.mediaUrl || "";
  const settings = await getSettings();
  const url = commandFor(settings.target, settings.customTemplate, pageUrl, mediaUrl);
  if (!url) throw new Error("No URL to open");
  try {
    await api.tabs.create({ url });
  } catch {
    await api.tabs.update(tab?.id, { url });
  }
  return { ok: true, url };
}

api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (message?.type === "fcdl:safari:get-settings") {
      sendResponse({ ok: true, settings: await getSettings() });
      return;
    }
    if (message?.type === "fcdl:safari:set-settings") {
      await api.storage.local.set(message.settings || {});
      sendResponse({ ok: true, settings: await getSettings() });
      return;
    }
    if (message?.type === "fcdl:safari:send") {
      sendResponse(await sendToDownloader(message));
      return;
    }
    sendResponse({ ok: false, error: "Unknown message" });
  })().catch((error) => {
    sendResponse({ ok: false, error: String(error?.message || error) });
  });
  return true;
});
