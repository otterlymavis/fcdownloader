const { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const HELPER_HOST = "127.0.0.1";
const HELPER_PORT = 8765;
const HEALTH_URL = `http://${HELPER_HOST}:${HELPER_PORT}/health`;
const PROTOCOL = "fcdownloader-companion";

let mainWindow = null;
let tray = null;
let helperProcess = null;
let helperState = {
  running: false,
  healthy: false,
  pid: null,
  message: "Stopped",
  runtime: null,
};

function registerProtocol() {
  if (process.defaultApp) {
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
    return;
  }
  app.setAsDefaultProtocolClient(PROTOCOL);
}

function repoRoot() {
  if (app.isPackaged) return path.join(process.resourcesPath, "fcdownloader");
  return path.resolve(__dirname, "..", "..");
}

function helperScriptPath() {
  return path.join(repoRoot(), "scripts", "local-youtube-helper.py");
}

function helperExecutableName() {
  return process.platform === "win32"
    ? "fcdownloader-local-helper.exe"
    : "fcdownloader-local-helper";
}

function packagedHelperPath() {
  return path.join(repoRoot(), "bin", helperExecutableName());
}

function devHelperPath() {
  return path.join(repoRoot(), "desktop-companion", "build", "helper", helperExecutableName());
}

function pythonCandidates() {
  const root = repoRoot();
  return [
    process.env.FCDL_PYTHON,
    path.join(root, ".venv", "Scripts", "python.exe"),
    "py",
    "python",
    "python3",
  ].filter(Boolean);
}

function helperCandidates() {
  const candidates = [];
  if (process.env.FCDL_HELPER_EXE) {
    candidates.push({ kind: "binary", command: process.env.FCDL_HELPER_EXE, label: "configured helper" });
  }
  for (const candidate of [packagedHelperPath(), devHelperPath()]) {
    if (fs.existsSync(candidate)) {
      candidates.push({ kind: "binary", command: candidate, label: path.basename(candidate) });
    }
  }
  for (const candidate of pythonCandidates()) {
    candidates.push({ kind: "python", command: candidate, label: candidate });
  }
  return candidates;
}

function sendStatus() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("helper-status", helperState);
  }
  updateTray();
}

function setState(patch) {
  helperState = { ...helperState, ...patch };
  sendStatus();
}

function log(line) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("helper-log", String(line));
  }
}

function checkHealth() {
  return new Promise((resolve) => {
    const req = http.get(HEALTH_URL, { timeout: 2500 }, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 300);
    });
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}

async function pollHealth() {
  const healthy = await checkHealth();
  setState({
    healthy,
    running: healthy || Boolean(helperProcess),
    message: healthy ? "Ready on 127.0.0.1:8765" : helperProcess ? "Starting..." : "Stopped",
  });
}

function spawnWithCandidate(candidate) {
  const script = helperScriptPath();
  let command = candidate.command;
  let args = [];

  if (candidate.kind === "python") {
    const isPyLauncher = path.basename(candidate.command).toLowerCase() === "py";
    args = isPyLauncher ? ["-3", script] : [script];
    command = isPyLauncher ? "py" : candidate.command;
  }

  return spawn(command, args, {
    cwd: repoRoot(),
    windowsHide: true,
    env: { ...process.env },
  });
}

async function startHelper() {
  if (await checkHealth()) {
    setState({ running: true, healthy: true, pid: helperProcess?.pid ?? null, message: "Ready on 127.0.0.1:8765", runtime: helperState.runtime || "external helper" });
    return helperState;
  }

  if (helperProcess) return helperState;

  const candidates = helperCandidates();
  let lastError = null;
  for (const candidate of candidates) {
    try {
      const child = spawnWithCandidate(candidate);
      helperProcess = child;
      setState({ running: true, healthy: false, pid: child.pid, message: `Starting with ${candidate.label}`, runtime: candidate.label });

      child.stdout.on("data", (chunk) => log(chunk.toString()));
      child.stderr.on("data", (chunk) => log(chunk.toString()));
      child.on("error", (error) => {
        lastError = error;
        log(`Helper start failed with ${candidate.label}: ${error.message}`);
      });
      child.on("exit", (code, signal) => {
        helperProcess = null;
        setState({ running: false, healthy: false, pid: null, message: `Stopped (${signal || code || 0})` });
      });

      for (let i = 0; i < 12; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 750));
        if (await checkHealth()) {
          setState({ running: true, healthy: true, pid: child.pid, message: "Ready on 127.0.0.1:8765", runtime: candidate.label });
          return helperState;
        }
        if (child.exitCode !== null) break;
      }

      if (child.exitCode === null) {
        child.kill();
      }
    } catch (error) {
      lastError = error;
      log(`Helper start failed with ${candidate.label}: ${error.message}`);
    }
  }

  setState({
    running: false,
    healthy: false,
    pid: null,
    runtime: null,
    message: lastError ? lastError.message : "Helper runtime was not found",
  });
  return helperState;
}

async function stopHelper() {
  if (helperProcess && helperProcess.exitCode === null) {
    helperProcess.kill();
  }
  helperProcess = null;
  setState({ running: false, healthy: false, pid: null, runtime: null, message: "Stopped" });
  return helperState;
}

function updateTray() {
  if (!tray) return;
  const label = helperState.healthy ? "Ready" : helperState.running ? "Starting" : "Stopped";
  tray.setToolTip(`FCDownloader Companion: ${label}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Status: ${label}`, enabled: false },
    { type: "separator" },
    { label: "Show", click: () => showWindow() },
    { label: "Start Helper", click: () => startHelper() },
    { label: "Stop Helper", click: () => stopHelper() },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ]));
}

function createTray() {
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);
  updateTray();
  tray.on("click", () => showWindow());
}

function showWindow() {
  if (!mainWindow) createWindow();
  mainWindow.show();
  mainWindow.focus();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 360,
    minWidth: 380,
    minHeight: 300,
    title: "FCDownloader Companion",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  mainWindow.loadFile(path.join(__dirname, "renderer.html"));
  mainWindow.on("close", (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

ipcMain.handle("helper:start", () => startHelper());
ipcMain.handle("helper:stop", () => stopHelper());
ipcMain.handle("helper:status", async () => {
  await pollHealth();
  return helperState;
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", async () => {
    showWindow();
    await startHelper();
  });

  app.whenReady().then(async () => {
    registerProtocol();
    createWindow();
    createTray();
    await startHelper();
    setInterval(pollHealth, 5000);
  });
}

app.on("before-quit", () => {
  app.isQuitting = true;
  if (helperProcess && helperProcess.exitCode === null) helperProcess.kill();
});

app.on("window-all-closed", (event) => {
  event.preventDefault();
});
