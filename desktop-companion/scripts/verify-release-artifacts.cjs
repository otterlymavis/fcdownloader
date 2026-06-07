const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const COMPANION_ROOT = path.resolve(__dirname, "..");
const manifestPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(COMPANION_ROOT, "build", "companion-artifacts.json");

if (!fs.existsSync(manifestPath)) {
  throw new Error(`missing manifest: ${manifestPath}`);
}

function sha256(file) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(file));
  return hash.digest("hex");
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const failures = [];
for (const artifact of manifest.artifacts || []) {
  const file = path.join(COMPANION_ROOT, artifact.path);
  if (!fs.existsSync(file)) {
    failures.push(`${artifact.path}: missing`);
    continue;
  }
  const actual = sha256(file);
  if (actual !== artifact.sha256) {
    failures.push(`${artifact.path}: sha256 mismatch`);
  }
}

if (failures.length) {
  for (const failure of failures) console.error(`[release-verify] ${failure}`);
  process.exit(1);
}

console.log(`[release-verify] verified ${(manifest.artifacts || []).length} artifact(s)`);
