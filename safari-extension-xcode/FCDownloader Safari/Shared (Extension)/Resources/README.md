# FCDownloader Safari Extension

This folder is the Safari Web Extension resource set for FCDownloader. It is
intended to be packaged into both iOS Safari and macOS Safari extension targets
with Xcode's Safari Web Extension tooling.

## What it does

- Sends the current Safari page to `fcdownloader://share?url=...`.
- Scans the current page for media URLs and lets the user send one detected URL.
- Supports handoff targets:
  - FCDownloader: `fcdownloader://share?url={url}`
  - Shortcuts: runs a shortcut named `FCDownloader` with the URL as text input
  - a-Shell: opens a generated `curl -L "<url>"` command
  - Custom URL template: supports `{url}`, `{pageUrl}`, and `{mediaUrl}`

## Packaging

Apple packages Safari Web Extensions as native app extensions. For iOS and
macOS, create Safari Web Extension targets in Xcode or use Xcode's Safari Web
Extension converter, then point/copy the extension resources from this folder.

The main FCDownloader app already owns the `fcdownloader://share?url=...` deep
link, so the Safari extension can hand links into the existing downloader flow.

## Limits

Safari Web Extensions can inspect the current Safari page after the user grants
permission, but they cannot directly reuse the React Native app's WKWebView
cookie store. For authenticated downloads, the Safari extension should send the
page URL and detected media to FCDownloader; FCDownloader then performs the
download through its backend/native strategies.
