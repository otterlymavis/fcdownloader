const $ = (id) => document.getElementById(id);

(async () => {
  const stored = await chrome.storage.sync.get({ backend: "", muxRemote: true, allowCookies: false, removeWatermark: false });
  $("backend").value = stored.backend || "";
  $("muxRemote").checked = stored.muxRemote !== false;
  $("allowCookies").checked = stored.allowCookies === true;
  $("removeWatermark").checked = stored.removeWatermark === true;
})();

$("save").addEventListener("click", async () => {
  const backend = $("backend").value.trim().replace(/\/+$/, "");
  const muxRemote = $("muxRemote").checked;
  const allowCookies = $("allowCookies").checked;
  const removeWatermark = $("removeWatermark").checked;
  await chrome.storage.sync.set({ backend, muxRemote, allowCookies, removeWatermark });
  $("saved").textContent = "✓ Saved";
  setTimeout(() => ($("saved").textContent = ""), 1800);
});
