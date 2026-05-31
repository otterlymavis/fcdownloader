const $ = (id) => document.getElementById(id);

(async () => {
  const stored = await chrome.storage.sync.get({ backend: "", muxRemote: true, allowCookies: false });
  $("backend").value = stored.backend || "";
  $("muxRemote").checked = stored.muxRemote !== false;
  $("allowCookies").checked = stored.allowCookies === true;
})();

$("save").addEventListener("click", async () => {
  const backend = $("backend").value.trim().replace(/\/+$/, "");
  const muxRemote = $("muxRemote").checked;
  const allowCookies = $("allowCookies").checked;
  await chrome.storage.sync.set({ backend, muxRemote, allowCookies });
  $("saved").textContent = "✓ Saved";
  setTimeout(() => ($("saved").textContent = ""), 1800);
});
