const api = globalThis.browser || globalThis.chrome;

const DEFAULT_TEMPLATE = "fcdownloader://share?url={url}";

const els = {
  status: document.getElementById("status"),
  sendPage: document.getElementById("send-page"),
  scan: document.getElementById("scan"),
  mediaList: document.getElementById("media-list"),
  target: document.getElementById("target"),
  customTemplate: document.getElementById("custom-template"),
};

function setStatus(text) {
  els.status.textContent = text;
}

function sendMessage(message) {
  return new Promise((resolve) => {
    api.runtime.sendMessage(message, (response) => resolve(response || { ok: false }));
  });
}

async function activeTab() {
  const tabs = await api.tabs.query({ active: true, currentWindow: true });
  return tabs && tabs[0] ? tabs[0] : null;
}

async function sendUrl(mediaUrl = "") {
  const tab = await activeTab();
  const response = await sendMessage({
    type: "fcdl:safari:send",
    pageUrl: tab?.url || "",
    mediaUrl,
  });
  setStatus(response.ok ? "Sent" : "Failed");
}

async function scan() {
  setStatus("Scanning");
  els.mediaList.textContent = "";
  const tab = await activeTab();
  let response = null;
  try {
    response = await api.tabs.sendMessage(tab.id, { type: "fcdl:safari:scan" });
  } catch {}
  const media = response?.media || [];
  if (!media.length) {
    setStatus("No media");
    return;
  }
  setStatus(`${media.length} found`);
  media.slice(0, 12).forEach((url) => {
    const button = document.createElement("button");
    button.className = "media";
    button.type = "button";
    button.textContent = url;
    button.title = url;
    button.addEventListener("click", () => sendUrl(url));
    els.mediaList.appendChild(button);
  });
}

async function loadSettings() {
  const response = await sendMessage({ type: "fcdl:safari:get-settings" });
  const settings = response.settings || {};
  els.target.value = settings.target || "fcdownloader";
  els.customTemplate.value = settings.customTemplate || DEFAULT_TEMPLATE;
  els.customTemplate.classList.toggle("visible", els.target.value === "custom");
}

async function saveSettings() {
  els.customTemplate.classList.toggle("visible", els.target.value === "custom");
  await sendMessage({
    type: "fcdl:safari:set-settings",
    settings: {
      target: els.target.value,
      customTemplate: els.customTemplate.value || DEFAULT_TEMPLATE,
    },
  });
}

els.sendPage.addEventListener("click", () => sendUrl());
els.scan.addEventListener("click", scan);
els.target.addEventListener("change", saveSettings);
els.customTemplate.addEventListener("change", saveSettings);

loadSettings().catch(() => setStatus("Error"));
