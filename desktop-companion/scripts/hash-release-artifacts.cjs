const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const COMPANION_ROOT = path.resolve(__dirname, "..");
const BUILD_ROOT = path.join(COMPANION_ROOT, "build");
const OUTPUT_JSON = path.join(BUILD_ROOT, "companion-artifacts.json");
const OUTPUT_SHA = path.join(BUILD_ROOT, "companion-artifacts.sha256");

const roots = [
  path.join(COMPANION_ROOT, "dist"),
  path.join(COMPANION_ROOT, "dist-nobrowser-go-ver"),
  path.join(COMPANION_ROOT, "dist-lite-ver-fresh"),
];
const wanted = /\.(exe|dmg|zip|blockmap|ya?ml)$/i;
const ignored = /(?:^|\/)builder-debug\.ya?ml$/i;

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "win-unpacked") continue;
      walk(full, out);
    } else if (wanted.test(entry.name) && !ignored.test(full.replace(/\\/g, "/"))) {
      out.push(full);
    }
  }
  return out;
}

function sha256(file) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(file));
  return hash.digest("hex");
}

const files = [...new Set(roots.flatMap((root) => walk(root)))].sort();
const artifacts = files.map((file) => ({
  name: path.basename(file),
  path: path.relative(COMPANION_ROOT, file).replace(/\\/g, "/"),
  size: fs.statSync(file).size,
  sizeMB: Number((fs.statSync(file).size / 1024 / 1024).toFixed(2)),
  sha256: sha256(file),
}));

fs.mkdirSync(BUILD_ROOT, { recursive: true });
fs.writeFileSync(OUTPUT_JSON, JSON.stringify({ generatedAt: new Date().toISOString(), artifacts }, null, 2) + "\n", "utf8");
fs.writeFileSync(OUTPUT_SHA, artifacts.map((item) => `${item.sha256}  ${item.name}`).join("\n") + "\n", "utf8");

console.log(`[release-hash] wrote ${OUTPUT_JSON}`);
console.log(`[release-hash] wrote ${OUTPUT_SHA}`);
