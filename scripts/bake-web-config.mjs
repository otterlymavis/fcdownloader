import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const indexPath = path.join(root, "web", "index.html");
const releasePath = path.join(root, "release.json");

const backend = (process.env.EXTRACTOR_URL || process.env.EXPO_PUBLIC_EXTRACTOR_URL || "").trim().replace(/\/+$/, "");
const androidUrl = (process.env.ANDROID_DOWNLOAD_URL || process.env.MOBILE_DOWNLOAD_URL || "").trim();
const iosUrl = (process.env.IOS_DOWNLOAD_URL || "").trim();
const helperUrl = (process.env.HELPER_DOWNLOAD_URL || process.env.COMPANION_DOWNLOAD_URL || "").trim();
const extensionUrl = (process.env.EXTENSION_DOWNLOAD_URL || "").trim();
const selfHostUrl = (process.env.SELF_HOST_URL || "").trim();

function replaceMeta(html, name, value) {
  if (!value) return html;
  const escaped = value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  const pattern = new RegExp(`(<meta\\s+name="${name}"\\s+content=")([^"]*)("\\s*/?>)`, "i");
  if (!pattern.test(html)) {
    throw new Error(`Missing <meta name="${name}"> in web/index.html`);
  }
  return html.replace(pattern, `$1${escaped}$3`);
}

let html = fs.readFileSync(indexPath, "utf8");
const release = JSON.parse(fs.readFileSync(releasePath, "utf8"));

html = replaceMeta(html, "release-version", release.release);
html = replaceMeta(html, "extractor-url", backend);
html = replaceMeta(html, "android-download-url", androidUrl);
html = replaceMeta(html, "ios-download-url", iosUrl);
html = replaceMeta(html, "extension-download-url", extensionUrl);
html = replaceMeta(html, "helper-download-url", helperUrl);
html = replaceMeta(html, "self-host-url", selfHostUrl);

fs.writeFileSync(indexPath, html);
console.log("[web-config] baked release metadata into web/index.html");
