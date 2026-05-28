const fs = require("node:fs");
const path = require("node:path");

const COMPANION_ROOT = path.resolve(__dirname, "..");
const distName = process.env.FCDL_LITE_DIST || "dist-lite-ver-fresh";
const DIST_ROOT = path.join(COMPANION_ROOT, distName);
const ROOT = fs.existsSync(path.join(DIST_ROOT, "win-unpacked"))
  ? path.join(DIST_ROOT, "win-unpacked")
  : DIST_ROOT;
const OUTPUT = path.join(COMPANION_ROOT, "build", "lite-size-summary.json");

if (!fs.existsSync(DIST_ROOT)) {
  throw new Error(`missing lite output: ${DIST_ROOT}`);
}

const files = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else {
      const size = fs.statSync(full).size;
      files.push({ path: path.relative(ROOT, full), size });
    }
  }
}
walk(ROOT);

function groupName(file) {
  const normalized = file.replace(/\\/g, "/");
  if (normalized.endsWith(".exe")) return "executables";
  if (normalized.includes("/resources/fcdownloader/bin/")) return "bundled helper";
  if (normalized.includes("/resources/fcdownloader/scripts/")) return "helper scripts";
  if (normalized.includes("/locales/")) return "locales";
  if (normalized.endsWith(".dll")) {
    if (/^(dxcompiler|dxil|d3dcompiler|libEGL|libGLESv2|vulkan|vk_swiftshader|ffmpeg)\.dll$/i.test(path.basename(normalized))) {
      return "Electron graphics/media DLLs";
    }
    return "DLLs";
  }
  if (normalized.includes("/resources/") || normalized.endsWith(".pak") || normalized.endsWith(".dat") || normalized.endsWith(".bin")) return "Electron resources";
  if (normalized.endsWith(".blockmap") || normalized.endsWith(".yml")) return "update metadata";
  return "Other";
}

const total = files.reduce((sum, file) => sum + file.size, 0);
const groups = new Map();
for (const file of files) {
  const key = groupName(file.path);
  const group = groups.get(key) || { group: key, size: 0, count: 0 };
  group.size += file.size;
  group.count += 1;
  groups.set(key, group);
}

const summary = {
  root: ROOT,
  distRoot: DIST_ROOT,
  totalMB: Number((total / 1024 / 1024).toFixed(2)),
  groups: [...groups.values()]
    .sort((a, b) => b.size - a.size)
    .map((group) => ({
      ...group,
      sizeMB: Number((group.size / 1024 / 1024).toFixed(2)),
      percent: Number((group.size * 100 / total).toFixed(1)),
    })),
  topFiles: files
    .sort((a, b) => b.size - a.size)
    .slice(0, 40)
    .map((file) => ({
      path: file.path,
      sizeMB: Number((file.size / 1024 / 1024).toFixed(2)),
    })),
};

fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
fs.writeFileSync(OUTPUT, JSON.stringify(summary, null, 2) + "\n", "utf8");
console.log(`[lite-audit] wrote ${OUTPUT}`);
console.log(summary.groups.slice(0, 10).map((g) => `${g.group}: ${g.sizeMB} MB (${g.percent}%)`).join("\n"));
