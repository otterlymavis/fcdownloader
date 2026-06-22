const $ = (id) => document.getElementById(id);

(async () => {
  const stored = await chrome.storage.sync.get({ muxRemote: true, allowCookies: false, removeWatermark: false });
  $("muxRemote").checked = stored.muxRemote !== false;
  $("allowCookies").checked = stored.allowCookies === true;
  $("removeWatermark").checked = stored.removeWatermark === true;
})();

$("save").addEventListener("click", async () => {
  const muxRemote = $("muxRemote").checked;
  const allowCookies = $("allowCookies").checked;
  const removeWatermark = $("removeWatermark").checked;
  await chrome.storage.sync.set({ muxRemote, allowCookies, removeWatermark });
  $("saved").textContent = "✓ Saved";
  setTimeout(() => ($("saved").textContent = ""), 1800);
});
