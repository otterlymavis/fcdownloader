// Build-time configuration baked into this extension package.
//
// The OSS source ships with FCDL_DEFAULT_BACKEND = "" so forks don't
// accidentally inherit anyone else's infrastructure. For your distribution
// build:
//   - Edit this file by hand to set the URL, OR
//   - Run `node scripts/pack-extension.mjs` from the repo root with
//     `EXTENSION_DEFAULT_BACKEND=https://your-instance.fly.dev` set in your
//     environment — the script copies extension/ to dist/extension/ and
//     replaces this constant before zipping.
//
// On first install, the value here is written into chrome.storage.sync so
// the user never has to type it. They can still override it via the
// options page afterwards.

export const FCDL_DEFAULT_BACKEND = "";
