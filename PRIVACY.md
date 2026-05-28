# FCDownloader Privacy Policy

Last updated: May 28, 2026

FCDownloader helps you save media that you own, control, or have permission to access. This policy covers the FCDownloader mobile app, browser extension, static web page, and optional extractor backend.

## Summary

- FCDownloader does not include analytics, advertising SDKs, or telemetry.
- FCDownloader does not sell personal information.
- Media page URLs and media URLs are processed only to find and download media.
- Cookies are used only when you ask FCDownloader to access media from a signed-in session.
- If you configure or use a hosted backend, that backend receives the request data needed to perform extraction or proxying.

## Information Processed

Depending on which FCDownloader surface you use, the app may process:

- Page URLs that you paste, share, open, or ask the extension to inspect.
- Media URLs, manifests, thumbnails, titles, durations, and format labels discovered on a page.
- Browser cookies or session headers for the current site when authenticated access is needed. This can include HttpOnly cookies read by the browser extension or cookies read from the in-app WebView.
- Download state stored locally on your device, such as task status, filenames, local file paths, bookmarks, backend URL settings, and extension preferences.
- Basic technical request metadata handled by the backend or hosting provider, such as IP address, timestamp, request path, response status, and user agent.

## How Information Is Used

FCDownloader uses this information to:

- Detect downloadable media on pages you choose.
- Send extraction requests to the configured backend when a site needs server-side extraction, header replay, or muxing.
- Forward cookies or headers required by a source site to access media available to your signed-in session.
- Start downloads and save files to your device or browser Downloads folder.
- Remember local app settings, bookmarks, and download history.
- Rate-limit and debug the backend.

## Backend Processing

The backend may receive page URLs, media URLs, referer headers, user-agent headers, cookies, and optional filenames. It uses this data to call extraction tools, fetch manifests, proxy media responses, or stream muxed media files.

If you use the public hosted backend, requests are processed by that deployment and its infrastructure provider. If you configure your own backend, your backend operator controls how logs and request metadata are handled.

The backend should not intentionally store cookies or downloaded media. Operators should avoid logging cookies and full signed media URLs. Standard infrastructure logs may still contain request metadata for security, debugging, abuse prevention, and rate limiting.

## Local Storage

The mobile app may store settings, bookmarks, and download task history on your device. The browser extension may store the backend URL and preferences in browser extension storage. This data remains local to your device or browser profile unless your browser syncs extension settings through its own account sync feature.

## Third Parties

FCDownloader may interact with:

- The media websites you choose to access.
- The configured extractor backend.
- Backend hosting providers such as Fly.io or another host chosen by the operator.
- Browser and mobile platform services used to save, share, or download files.

FCDownloader does not add third-party analytics or advertising services.

## Cookies

Cookies are used only to access media from sessions where you are already signed in. Cookies may be forwarded to the configured backend when needed for extraction or media proxying. Do not use FCDownloader with accounts or content you are not authorized to access.

## User Control

You can:

- Change or clear the backend URL in extension settings.
- Clear mobile app data through Android or iOS settings.
- Clear extension storage through your browser's extension settings, or remove and reinstall the extension.
- Sign out of source websites to invalidate source-site sessions.
- Rotate or remove backend cookies if you operate the backend.
- Ask the hosted backend operator to delete server logs associated with your requests when logs are still retained.
- Delete downloaded files from your device or Downloads folder.

## Children's Privacy

FCDownloader is not designed for children and does not knowingly collect information from children.

## Changes

This policy may be updated as FCDownloader changes. The latest version should be published with the app, extension, or project repository.

## Contact

For privacy questions, email mavisssz@gmail.com or contact the publisher listed on the store page.
