const $ = (id) => document.getElementById(id);

(async () => {
  const stored = await chrome.storage.sync.get({ backend: "", muxRemote: true });
  $("backend").value = stored.backend || "";
  $("muxRemote").checked = stored.muxRemote !== false;
})();

$("save").addEventListener("click", async () => {
  const backend = $("backend").value.trim().replace(/\/+$/, "");
  const muxRemote = $("muxRemote").checked;
  await chrome.storage.sync.set({ backend, muxRemote });
  $("saved").textContent = "✓ Saved";
  setTimeout(() => ($("saved").textContent = ""), 1800);
});
