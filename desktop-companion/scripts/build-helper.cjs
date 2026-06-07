const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const COMPANION_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(COMPANION_ROOT, "..");
const HELPER_SOURCE = path.join(REPO_ROOT, "scripts", "local-youtube-helper.py");
const REQUIREMENTS = path.join(COMPANION_ROOT, "helper-requirements.txt");
const BUILD_ROOT = path.join(COMPANION_ROOT, "build");
const HELPER_DIST = path.join(BUILD_ROOT, "helper");
const BUILD_VENV = path.join(BUILD_ROOT, "pyinstaller-venv");
const PYI_WORK = path.join(BUILD_ROOT, "pyinstaller-work");
const PYI_SPEC = path.join(BUILD_ROOT, "pyinstaller-spec");
const HELPER_NAME = process.platform === "win32"
  ? "fcdownloader-local-helper.exe"
  : "fcdownloader-local-helper";

function run(command, args, options = {}) {
  console.log(`[helper-build] ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: options.cwd || COMPANION_ROOT,
    env: { ...process.env, ...(options.env || {}) },
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with ${result.status}`);
  }
}

function probe(command, args) {
  const result = spawnSync(command, args, {
    cwd: COMPANION_ROOT,
    stdio: "ignore",
    shell: false,
  });
  return !result.error && result.status === 0;
}

function pythonVersion(command, args = []) {
  const result = spawnSync(command, [
    ...args,
    "-c",
    "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}')",
  ], {
    cwd: COMPANION_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    shell: false,
  });
  if (result.error || result.status !== 0) return null;
  const [major, minor, patch] = String(result.stdout || "").trim().split(".").map((x) => Number.parseInt(x, 10));
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return null;
  return { major, minor, patch: Number.isFinite(patch) ? patch : 0 };
}

function isSupportedPython(command, args = []) {
  const version = pythonVersion(command, args);
  return Boolean(version && (version.major > 3 || (version.major === 3 && version.minor >= 10)));
}

function findPython() {
  if (process.env.FCDL_BUILD_PYTHON) {
    if (!isSupportedPython(process.env.FCDL_BUILD_PYTHON, [])) {
      throw new Error("FCDL_BUILD_PYTHON must point to Python 3.10 or newer.");
    }
    return { command: process.env.FCDL_BUILD_PYTHON, args: [] };
  }
  const repoVenvPython = process.platform === "win32"
    ? path.join(REPO_ROOT, ".venv", "Scripts", "python.exe")
    : path.join(REPO_ROOT, ".venv", "bin", "python");
  const candidates = process.platform === "win32"
    ? [
        { command: repoVenvPython, args: [] },
        { command: "py", args: ["-3"] },
        { command: "python", args: [] },
        { command: "python3", args: [] },
      ]
    : [
        { command: repoVenvPython, args: [] },
        { command: "python3.14", args: [] },
        { command: "python3.13", args: [] },
        { command: "python3.12", args: [] },
        { command: "python3.11", args: [] },
        { command: "python3.10", args: [] },
        { command: "python3", args: [] },
        { command: "python", args: [] },
      ];
  for (const candidate of candidates) {
    if (
      probe(candidate.command, [...candidate.args, "--version"]) &&
      isSupportedPython(candidate.command, candidate.args)
    ) {
      return candidate;
    }
  }
  throw new Error("Python 3.10 or newer is required to build the companion helper executable.");
}

function venvPythonPath() {
  return process.platform === "win32"
    ? path.join(BUILD_VENV, "Scripts", "python.exe")
    : path.join(BUILD_VENV, "bin", "python");
}

function ensureBuildVenv(systemPython) {
  const venvPython = venvPythonPath();
  if (fs.existsSync(venvPython) && !isSupportedPython(venvPython, [])) {
    console.log(`[helper-build] removing stale Python <3.10 venv: ${BUILD_VENV}`);
    fs.rmSync(BUILD_VENV, { recursive: true, force: true });
  }
  if (!fs.existsSync(venvPython)) {
    run(systemPython.command, [...systemPython.args, "-m", "venv", BUILD_VENV]);
  }
  return { command: venvPython, args: [] };
}

function main() {
  if (!fs.existsSync(HELPER_SOURCE)) {
    throw new Error(`Missing helper source: ${HELPER_SOURCE}`);
  }

  fs.mkdirSync(HELPER_DIST, { recursive: true });
  fs.mkdirSync(PYI_WORK, { recursive: true });
  fs.mkdirSync(PYI_SPEC, { recursive: true });

  const python = ensureBuildVenv(findPython());
  run(python.command, [...python.args, "-m", "pip", "install", "--upgrade", "-r", REQUIREMENTS]);
  const pyinstallerArgs = [
    ...python.args,
    "-m",
    "PyInstaller",
    "--noconfirm",
    "--clean",
    "--onefile",
    "--name",
    "fcdownloader-local-helper",
    "--distpath",
    HELPER_DIST,
    "--workpath",
    PYI_WORK,
    "--specpath",
    PYI_SPEC,
    "--collect-all",
    "yt_dlp",
    "--exclude-module",
    "tkinter",
    "--exclude-module",
    "unittest",
    "--exclude-module",
    "pydoc",
    "--exclude-module",
    "doctest",
    HELPER_SOURCE,
  ];
  if (process.env.FCDL_PYI_UPX_DIR) {
    pyinstallerArgs.splice(pyinstallerArgs.length - 1, 0, "--upx-dir", process.env.FCDL_PYI_UPX_DIR);
  }
  run(python.command, pyinstallerArgs);

  const output = path.join(HELPER_DIST, HELPER_NAME);
  if (!fs.existsSync(output)) {
    throw new Error(`PyInstaller finished but ${output} was not created.`);
  }
  console.log(`[helper-build] ready: ${output}`);
}

main();
