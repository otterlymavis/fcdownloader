# Store Listing Notes

Use this copy as the baseline for app-store or extension-store submissions. Keep claims focused on authorized media access.

## Short Description

Save media you have permission to access from supported websites, using the app, browser extension, or optional extractor backend.

## Long Description

FCDownloader helps you save videos, images, audio, and galleries from supported web pages when you own the content, control the content, or have permission to access it.

The app and extension can detect media on pages you choose, start downloads, and use an optional extractor backend for formats that need server-side extraction, muxing, or authenticated header replay. For signed-in pages, FCDownloader can forward the current site's session cookies or request headers to the configured backend so it can access media available to your session.

Supported routes include major video/social sites such as YouTube, Bilibili, Vimeo, TikTok, Instagram, Threads, X/Twitter, Facebook, Pinterest, Dailymotion, Reddit, Weibo, Xiaohongshu, TVer, Niconico, ABEMA, Naver, NHK, TBS, FOD/Fuji TV, TwitCasting, OpenREC, FC2, and Yahoo Japan, plus article/gallery support for many Japanese and Korean news, magazine, and blog sites such as Modelpress, Naver Blog/News, Ameblo, Natalie, Oricon, Kstyle, Daum/Tistory, Kakao TV, Livedoor Blog, Yahoo Japan galleries, Pixiv/Fanbox, Bilibili dynamic posts, Bunshun, Daily Shincho, News Post Seven, FRIDAY/Kodansha, Fashion Press, Fashionsnap, WWD Japan, Real Sound, JPrime, Smart Flash, major newspapers, sports papers, and Japanese tech/news sites.

FCDownloader does not include ads, analytics, or telemetry. It does not sell personal information. Review the privacy policy before publishing and link it from every store listing.

## Permissions Explanation

Use these explanations for Chrome Web Store or similar review forms:

- `downloads`: starts downloads the user requests and writes files to the browser Downloads folder.
- `storage`: saves backend URL and extension preferences.
- `activeTab` and `tabs`: reads the current tab URL when the popup opens or the user asks the extension to inspect a page.
- `cookies`: reads cookies for the current site only when needed to access media available to the user's signed-in session.
- `webRequest`: observes completed network requests so the extension can discover media manifests and direct media URLs that are not present in the page DOM.
- `<all_urls>` host access: media sites and embedded players use many domains, so broad host access is required for user-initiated detection across supported pages.

## Avoid This Wording

- "Download anything from YouTube/Weibo/etc."
- "Bypass paywalls."
- "Download copyrighted content."
- "Save private content without permission."

## Prefer This Wording

- "Save media you own, control, or have permission to access."
- "Uses your configured backend for extraction and muxing."
- "For signed-in pages, forwards cookies or headers only when needed to access media available to your session."
