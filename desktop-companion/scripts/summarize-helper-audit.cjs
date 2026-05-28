const fs = require("node:fs");
const path = require("node:path");

const COMPANION_ROOT = path.resolve(__dirname, "..");
const BUILD_ROOT = path.join(COMPANION_ROOT, "build");
const INPUT = path.join(BUILD_ROOT, "helper-size-audit.txt");
const OUTPUT = path.join(BUILD_ROOT, "helper-size-summary.json");

if (!fs.existsSync(INPUT)) {
  throw new Error(`missing audit file: ${INPUT}`);
}

const entries = [];
for (const line of fs.readFileSync(INPUT, "utf8").split(/\r?\n/)) {
  const match = line.match(/^\s*\d+,\s*(\d+),\s*(\d+),\s*[01],\s*'([^']+)',\s*'(.+)'$/);
  if (!match) continue;
  entries.push({
    compressed: Number(match[1]),
    uncompressed: Number(match[2]),
    type: match[3],
    name: match[4],
  });
}

function groupName(name) {
  if (name.startsWith("yt_dlp\\")) return "yt_dlp package";
  if (name.startsWith("yt_dlp-")) return "yt_dlp metadata";
  if (name.startsWith("api-ms-") || name === "ucrtbase.dll" || name.startsWith("VCRUNTIME")) return "Windows runtime DLLs";
  if (name.startsWith("setuptools\\")) return "setuptools metadata";
  if (name.endsWith(".pyd")) return "Python extension modules";
  if (name.endsWith(".dll")) return "DLLs";
  if (name === "base_library.zip" || name === "python314.dll") return "Python runtime";
  return "Other";
}

const groups = new Map();
for (const entry of entries) {
  const key = groupName(entry.name);
  const group = groups.get(key) || { group: key, compressed: 0, uncompressed: 0, count: 0 };
  group.compressed += entry.compressed;
  group.uncompressed += entry.uncompressed;
  group.count += 1;
  groups.set(key, group);
}

const totalCompressed = entries.reduce((sum, entry) => sum + entry.compressed, 0);
const summary = {
  totalCompressed,
  totalCompressedMB: Number((totalCompressed / 1024 / 1024).toFixed(2)),
  groups: [...groups.values()]
    .sort((a, b) => b.compressed - a.compressed)
    .map((group) => ({
      ...group,
      compressedMB: Number((group.compressed / 1024 / 1024).toFixed(2)),
      percent: Number((group.compressed * 100 / totalCompressed).toFixed(1)),
    })),
  topFiles: entries
    .sort((a, b) => b.compressed - a.compressed)
    .slice(0, 25)
    .map((entry) => ({
      name: entry.name,
      type: entry.type,
      compressedMB: Number((entry.compressed / 1024 / 1024).toFixed(2)),
      uncompressedMB: Number((entry.uncompressed / 1024 / 1024).toFixed(2)),
    })),
};

fs.writeFileSync(OUTPUT, JSON.stringify(summary, null, 2) + "\n", "utf8");
console.log(`[helper-audit] wrote ${OUTPUT}`);
console.log(summary.groups.slice(0, 8).map((g) => `${g.group}: ${g.compressedMB} MB (${g.percent}%)`).join("\n"));
