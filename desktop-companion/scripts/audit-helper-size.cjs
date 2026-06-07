const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const COMPANION_ROOT = path.resolve(__dirname, "..");
const BUILD_ROOT = path.join(COMPANION_ROOT, "build");
const HELPER_EXE = path.join(BUILD_ROOT, "helper", "fcdownloader-local-helper.exe");
const PYTHON = path.join(BUILD_ROOT, "pyinstaller-venv", "Scripts", "python.exe");
const REPORT = path.join(BUILD_ROOT, "helper-size-audit.txt");

if (!fs.existsSync(HELPER_EXE)) {
  throw new Error(`helper executable not found: ${HELPER_EXE}`);
}
if (!fs.existsSync(PYTHON)) {
  throw new Error(`PyInstaller venv not found: ${PYTHON}`);
}

const result = spawnSync(PYTHON, ["-m", "PyInstaller.utils.cliutils.archive_viewer", HELPER_EXE], {
  cwd: COMPANION_ROOT,
  input: "l\nq\n",
  encoding: "utf8",
  shell: false,
});
if (result.error) throw result.error;
if (result.status !== 0) {
  process.stderr.write(result.stderr || "");
  throw new Error(`archive_viewer exited with ${result.status}`);
}

fs.writeFileSync(REPORT, result.stdout, "utf8");
console.log(`[helper-audit] wrote ${REPORT}`);
