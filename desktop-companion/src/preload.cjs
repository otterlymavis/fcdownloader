const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("fcdl", {
  start: () => ipcRenderer.invoke("helper:start"),
  stop: () => ipcRenderer.invoke("helper:stop"),
  status: () => ipcRenderer.invoke("helper:status"),
  onStatus: (callback) => ipcRenderer.on("helper-status", (_event, value) => callback(value)),
  onLog: (callback) => ipcRenderer.on("helper-log", (_event, value) => callback(value)),
});
