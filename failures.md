# FCDownloader - Backend Test Failures Log

Total Failures: **21**

## Summary Table

| Platform | HTTP Status | Error Message Summary |
| :--- | :--- | :--- |
| **Instagram** | 502 | This page requires you to be signed in, or the server's IP is blocked by the site. Open the ... |
| **Threads** | 502 | No extractor found for this URL and the page HTML contained no detectable media. This usuall... |
| **Reddit** | 502 | This page requires you to be signed in, or the server's IP is blocked by the site. Open the ... |
| **Bilibili dynamic / opus** | 502 | unsupported after all extraction strategies failed: yt-dlp: ERROR: [BiliBili] 1TAmBYVEJr: Un... |
| **Weibo** | 502 | No extractor found for this URL and the page HTML contained no detectable media. This usuall... |
| **Douyin** | 502 | This page requires you to be signed in, or the server's IP is blocked by the site. Open the ... |
| **TVer** | 502 | unsupported after all extraction strategies failed: yt-dlp: ERROR: [TVer] ep1orpabaq: MEDIA_... |
| **ABEMA** | 502 | This page requires you to be signed in, or the server's IP is blocked by the site. Open the ... |
| **FC2 Live** | 502 | unsupported after all extraction strategies failed: yt-dlp: ERROR: [fc2:live] 57892267: The ... |
| **OpenREC** | 502 | This page requires you to be signed in, or the server's IP is blocked by the site. Open the ... |
| **TBS** | 502 | unsupported after all extraction strategies failed: yt-dlp: ERROR: you-debt-your-life: An ex... |
| **FOD / Fuji TV** | 502 | unsupported after all extraction strategies failed: yt-dlp: ERROR: [FujiTVFODPlus7] 5d401100... |
| **Yahoo Japan video/news** | 502 | unsupported after all extraction strategies failed: yt-dlp: ERROR: [yahoo:japannews] a70fe3a... |
| **DMM** | 502 | No extractor found for this URL and the page HTML contained no detectable media. This usuall... |
| **Mildom** | 502 | unsupported after all extraction strategies failed: yt-dlp: ERROR: [generic] Unable to downl... |
| **Naver Entertainment** | 502 | No extractor found for this URL and the page HTML contained no detectable media. This usuall... |
| **Naver Sports** | 502 | unsupported after all extraction strategies failed: yt-dlp: ERROR: [generic] Unable to downl... |
| **ViVi** | 502 | unsupported after all extraction strategies failed: yt-dlp: ERROR: [generic] Unable to downl... |
| **Fashionsnap** | 502 | No extractor found for this URL and the page HTML contained no detectable media. This usuall... |
| **WWD Japan** | 502 | No extractor found for this URL and the page HTML contained no detectable media. This usuall... |
| **Mainichi** | 502 | No extractor found for this URL and the page HTML contained no detectable media. This usuall... |

---

## Detailed Diagnostics

### Instagram (HTTP 502)

> This page requires you to be signed in, or the server's IP is blocked by the site. Open the page in your browser, use the FCDownload bookmarklet or extension to capture your session cookies, and try again.

**Diagnostics by extraction strategy:**

- **yt-dlp**: `ERROR: [Instagram] C7VgIvhsKgR: Requested content is not available, rate-limit reached or login required. Use --cookies-from-browser or --cookies for the authentication. See  https://github.com/yt-dlp/yt-dlp/wiki/FAQ#how-do-i-pass-cookies-to-yt-dlp  for how to manually pass cookies`
- **platform-specific extractor**: `Instagram extractor found no media`
- **WebView/runtime interception**: `browser runtime is client-side only`
- **HLS manifest detector**: `hls detector found no media`
- **DASH manifest detector**: `dash detector found no media`
- **OG/meta tag extractor**: `og detector found no media`
- **generic media detector**: `generic detector found no media`
- **embedded player detector**: `no embedded player signatures found in page HTML`
- **generic yt-dlp extractor**: `ERROR: [Instagram] C7VgIvhsKgR: Requested content is not available, rate-limit reached or login required. Use --cookies-from-browser or --cookies for the authentication. See  https://github.com/yt-dlp/yt-dlp/wiki/FAQ#how-do-i-pass-cookies-to-yt-dlp  for how to manually pass cookies`
- **ytdl-stream**: `URL does not need ytdl-stream`
- **browser playback fallback**: `browser playback fallback must run in the app WebView`

---

### Threads (HTTP 502)

> No extractor found for this URL and the page HTML contained no detectable media. This usually means the video is loaded by a JavaScript player that the server cannot run. If you are using the FCDownloader browser extension, check the extension popup — it may have already detected the video automatically as the page loaded in your browser. Otherwise use the FCDownload bookmarklet to capture the stream URL directly. (details: yt-dlp: ERROR: Unsupported URL: https://www.threads.com/?error=invalid_post; platform-specific extractor: Threads extractor found no media; HLS manifest detector: hls detector found no media; DASH manifest detector: dash detector found no media; OG/meta tag extractor: og detector found no media; generic media detector: generic detector found no media; embedded player detector: no embedded player s)

**Diagnostics by extraction strategy:**

- **yt-dlp**: `ERROR: Unsupported URL: https://www.threads.com/?error=invalid_post`
- **platform-specific extractor**: `Threads extractor found no media`
- **WebView/runtime interception**: `browser runtime is client-side only`
- **HLS manifest detector**: `hls detector found no media`
- **DASH manifest detector**: `dash detector found no media`
- **OG/meta tag extractor**: `og detector found no media`
- **generic media detector**: `generic detector found no media`
- **embedded player detector**: `no embedded player signatures found in page HTML`
- **generic yt-dlp extractor**: `ERROR: Unsupported URL: https://www.threads.com/?error=invalid_post`
- **ytdl-stream**: `URL does not need ytdl-stream`
- **browser playback fallback**: `browser playback fallback must run in the app WebView`

---

### Reddit (HTTP 502)

> This page requires you to be signed in, or the server's IP is blocked by the site. Open the page in your browser, use the FCDownload bookmarklet or extension to capture your session cookies, and try again.

**Diagnostics by extraction strategy:**

- **platform-specific extractor**: `Reddit extractor found no media`
- **yt-dlp**: `ERROR: [generic] Unable to download webpage: HTTP Error 403: Blocked (caused by <HTTPError 403: Blocked>)`
- **WebView/runtime interception**: `browser runtime is client-side only`
- **HLS manifest detector**: `network error: HTTP Error 403: Blocked`
- **DASH manifest detector**: `network error: HTTP Error 403: Blocked`
- **OG/meta tag extractor**: `network error: HTTP Error 403: Blocked`
- **generic media detector**: `network error: HTTP Error 403: Blocked`
- **embedded player detector**: `fetch: HTTP Error 403: Blocked`
- **generic yt-dlp extractor**: `ERROR: [generic] Unable to download webpage: HTTP Error 403: Blocked (caused by <HTTPError 403: Blocked>)`
- **ytdl-stream**: `URL does not need ytdl-stream`
- **browser playback fallback**: `browser playback fallback must run in the app WebView`

---

### Bilibili dynamic / opus (HTTP 502)

> unsupported after all extraction strategies failed: yt-dlp: ERROR: [BiliBili] 1TAmBYVEJr: Unable to download webpage: HTTP Error 412: Precondition Failed (caused by <HTTPError 412: Precondition Failed>); platform-specific extractor: Bilibili extractor found no media; HLS manifest detector: network error: HTTP Error 412: Precondition Failed; DASH manifest detector: network error: HTTP Error 412: Precondition Failed; OG/meta tag extractor: network error: HTTP Error 412: Precondition Failed; generic media detector: network error: HTTP Error 412: Precondition Failed; embedded player detector: fetch: HTTP Error 412: Precondition Failed; generic yt-dlp extractor: ERROR: [BiliBili] 1TAmBYVEJr: Unable to download webpage: HTTP Error 412: Precondition Failed (caused by <HTTPError 412: Precondition Failed>); ytdl-stream: URL does not need ytdl-stream

**Diagnostics by extraction strategy:**

- **yt-dlp**: `ERROR: [BiliBili] 1TAmBYVEJr: Unable to download webpage: HTTP Error 412: Precondition Failed (caused by <HTTPError 412: Precondition Failed>)`
- **platform-specific extractor**: `Bilibili extractor found no media`
- **WebView/runtime interception**: `browser runtime is client-side only`
- **HLS manifest detector**: `network error: HTTP Error 412: Precondition Failed`
- **DASH manifest detector**: `network error: HTTP Error 412: Precondition Failed`
- **OG/meta tag extractor**: `network error: HTTP Error 412: Precondition Failed`
- **generic media detector**: `network error: HTTP Error 412: Precondition Failed`
- **embedded player detector**: `fetch: HTTP Error 412: Precondition Failed`
- **generic yt-dlp extractor**: `ERROR: [BiliBili] 1TAmBYVEJr: Unable to download webpage: HTTP Error 412: Precondition Failed (caused by <HTTPError 412: Precondition Failed>)`
- **ytdl-stream**: `URL does not need ytdl-stream`
- **browser playback fallback**: `browser playback fallback must run in the app WebView`

---

### Weibo (HTTP 502)

> No extractor found for this URL and the page HTML contained no detectable media. This usually means the video is loaded by a JavaScript player that the server cannot run. If you are using the FCDownloader browser extension, check the extension popup — it may have already detected the video automatically as the page loaded in your browser. Otherwise use the FCDownload bookmarklet to capture the stream URL directly. (details: platform-specific extractor: Weibo extractor found no media; yt-dlp: ERROR: Unsupported URL: https://visitor.passport.weibo.cn/visitor/visitor?entry=sinawap&a=enter&url=https%3A%2F%2Fm.weibo.cn%2Fstatus%2F4286822303972514&domain=.weibo.cn&sudaref=&ua=php-sso_sdk_client-0.6.36&_rand=1780497602.3352; HLS manifest detector: hls detector found no media; DASH manifest detector: dash detector found no m)

**Diagnostics by extraction strategy:**

- **platform-specific extractor**: `Weibo extractor found no media`
- **yt-dlp**: `ERROR: Unsupported URL: https://visitor.passport.weibo.cn/visitor/visitor?entry=sinawap&a=enter&url=https%3A%2F%2Fm.weibo.cn%2Fstatus%2F4286822303972514&domain=.weibo.cn&sudaref=&ua=php-sso_sdk_client-0.6.36&_rand=1780497602.3352`
- **WebView/runtime interception**: `browser runtime is client-side only`
- **HLS manifest detector**: `hls detector found no media`
- **DASH manifest detector**: `dash detector found no media`
- **OG/meta tag extractor**: `og detector found no media`
- **generic media detector**: `generic detector found no media`
- **embedded player detector**: `no embedded player signatures found in page HTML`
- **generic yt-dlp extractor**: `ERROR: Unsupported URL: https://visitor.passport.weibo.cn/visitor/visitor?entry=sinawap&a=enter&url=https%3A%2F%2Fm.weibo.cn%2Fstatus%2F4286822303972514&domain=.weibo.cn&sudaref=&ua=php-sso_sdk_client-0.6.36&_rand=1780497635.8693`
- **ytdl-stream**: `URL does not need ytdl-stream`
- **browser playback fallback**: `browser playback fallback must run in the app WebView`

---

### Douyin (HTTP 502)

> This page requires you to be signed in, or the server's IP is blocked by the site. Open the page in your browser, use the FCDownload bookmarklet or extension to capture your session cookies, and try again.

**Diagnostics by extraction strategy:**

- **yt-dlp**: `ERROR: [Douyin] 7212345678901234567: Fresh cookies (not necessarily logged in) are needed`
- **platform-specific extractor**: `TikTok extractor found no media`
- **WebView/runtime interception**: `browser runtime is client-side only`
- **HLS manifest detector**: `hls detector found no media`
- **DASH manifest detector**: `dash detector found no media`
- **OG/meta tag extractor**: `og detector found no media`
- **generic media detector**: `generic detector found no media`
- **embedded player detector**: `no embedded player signatures found in page HTML`
- **generic yt-dlp extractor**: `ERROR: [Douyin] 7212345678901234567: Fresh cookies (not necessarily logged in) are needed`
- **ytdl-stream**: `URL does not need ytdl-stream`
- **browser playback fallback**: `browser playback fallback must run in the app WebView`

---

### TVer (HTTP 502)

> unsupported after all extraction strategies failed: yt-dlp: ERROR: [TVer] ep1orpabaq: MEDIA_NOT_FOUND: 対象が存在しません; platform-specific extractor: Japanese site — handled by yt-dlp with Accept-Language:ja; falling through; HLS manifest detector: hls detector found no media; DASH manifest detector: dash detector found no media; OG/meta tag extractor: og detector found no media; generic media detector: generic detector found no media; embedded player detector: no embedded player signatures found in page HTML; generic yt-dlp extractor: ERROR: [TVer] ep1orpabaq: MEDIA_NOT_FOUND: 対象が存在しません; ytdl-stream: URL does not need ytdl-stream

**Diagnostics by extraction strategy:**

- **yt-dlp**: `ERROR: [TVer] ep1orpabaq: MEDIA_NOT_FOUND: 対象が存在しません`
- **platform-specific extractor**: `Japanese site — handled by yt-dlp with Accept-Language:ja; falling through`
- **WebView/runtime interception**: `browser runtime is client-side only`
- **HLS manifest detector**: `hls detector found no media`
- **DASH manifest detector**: `dash detector found no media`
- **OG/meta tag extractor**: `og detector found no media`
- **generic media detector**: `generic detector found no media`
- **embedded player detector**: `no embedded player signatures found in page HTML`
- **generic yt-dlp extractor**: `ERROR: [TVer] ep1orpabaq: MEDIA_NOT_FOUND: 対象が存在しません`
- **ytdl-stream**: `URL does not need ytdl-stream`
- **browser playback fallback**: `browser playback fallback must run in the app WebView`

---

### ABEMA (HTTP 502)

> This page requires you to be signed in, or the server's IP is blocked by the site. Open the page in your browser, use the FCDownload bookmarklet or extension to capture your session cookies, and try again.

**Diagnostics by extraction strategy:**

- **yt-dlp**: `ERROR: [AbemaTV] 194-25_s2_p1: Failed to download m3u8 information: HTTP Error 403: Forbidden (caused by <HTTPError 403: Forbidden>)`
- **platform-specific extractor**: `Japanese site — handled by yt-dlp with Accept-Language:ja; falling through`
- **WebView/runtime interception**: `browser runtime is client-side only`
- **HLS manifest detector**: `hls detector found no media`
- **DASH manifest detector**: `dash detector found no media`
- **OG/meta tag extractor**: `og detector found no media`
- **generic media detector**: `generic detector found no media`
- **embedded player detector**: `no embedded player signatures found in page HTML`
- **generic yt-dlp extractor**: `ERROR: [AbemaTV] 194-25_s2_p1: Failed to download m3u8 information: HTTP Error 403: Forbidden (caused by <HTTPError 403: Forbidden>)`
- **ytdl-stream**: `URL does not need ytdl-stream`
- **browser playback fallback**: `browser playback fallback must run in the app WebView`

---

### FC2 Live (HTTP 502)

> unsupported after all extraction strategies failed: yt-dlp: ERROR: [fc2:live] 57892267: The channel is not currently live; platform-specific extractor: Japanese site — handled by yt-dlp with Accept-Language:ja; falling through; HLS manifest detector: hls detector found no media; DASH manifest detector: dash detector found no media; OG/meta tag extractor: network error: HTTP Error 429: Too Many Requests; generic media detector: network error: HTTP Error 429: Too Many Requests; embedded player detector: fetch: HTTP Error 429: Too Many Requests; generic yt-dlp extractor: ERROR: [fc2:live] 57892267: The channel is not currently live; ytdl-stream: URL does not need ytdl-stream

**Diagnostics by extraction strategy:**

- **yt-dlp**: `ERROR: [fc2:live] 57892267: The channel is not currently live`
- **platform-specific extractor**: `Japanese site — handled by yt-dlp with Accept-Language:ja; falling through`
- **WebView/runtime interception**: `browser runtime is client-side only`
- **HLS manifest detector**: `hls detector found no media`
- **DASH manifest detector**: `dash detector found no media`
- **OG/meta tag extractor**: `network error: HTTP Error 429: Too Many Requests`
- **generic media detector**: `network error: HTTP Error 429: Too Many Requests`
- **embedded player detector**: `fetch: HTTP Error 429: Too Many Requests`
- **generic yt-dlp extractor**: `ERROR: [fc2:live] 57892267: The channel is not currently live`
- **ytdl-stream**: `URL does not need ytdl-stream`
- **browser playback fallback**: `browser playback fallback must run in the app WebView`

---

### OpenREC (HTTP 502)

> This page requires you to be signed in, or the server's IP is blocked by the site. Open the page in your browser, use the FCDownload bookmarklet or extension to capture your session cookies, and try again.

**Diagnostics by extraction strategy:**

- **yt-dlp**: `ERROR: [openrec:movie] nqz5xl5km8v: Unable to download webpage: HTTP Error 403: Forbidden (caused by <HTTPError 403: Forbidden>)`
- **platform-specific extractor**: `Japanese site — handled by yt-dlp with Accept-Language:ja; falling through`
- **WebView/runtime interception**: `browser runtime is client-side only`
- **HLS manifest detector**: `network error: HTTP Error 403: Forbidden`
- **DASH manifest detector**: `network error: HTTP Error 403: Forbidden`
- **OG/meta tag extractor**: `network error: HTTP Error 403: Forbidden`
- **generic media detector**: `network error: HTTP Error 403: Forbidden`
- **embedded player detector**: `fetch: HTTP Error 403: Forbidden`
- **generic yt-dlp extractor**: `ERROR: [openrec:movie] nqz5xl5km8v: Unable to download webpage: HTTP Error 403: Forbidden (caused by <HTTPError 403: Forbidden>)`
- **ytdl-stream**: `URL does not need ytdl-stream`
- **browser playback fallback**: `browser playback fallback must run in the app WebView`

---

### TBS (HTTP 502)

> unsupported after all extraction strategies failed: yt-dlp: ERROR: you-debt-your-life: An extractor error has occurred. (caused by KeyError('media')); please report this issue on  https://github.com/yt-dlp/yt-dlp/issues?q= , filling out the appropriate issue template. Confirm you are on the latest version using  yt-dlp -U; platform-specific extractor: no matching platform extractor; HLS manifest detector: hls detector found no media; DASH manifest detector: dash detector found no media; OG/meta tag extractor: og detector found no media; generic media detector: generic detector found no media; embedded player detector: no embedded player signatures found in page HTML; generic yt-dlp extractor: ERROR: you-debt-your-life: An extractor error has occurred. (caused by KeyError('media')); please report this issue on  https://github.com/yt-dlp/yt-d

**Diagnostics by extraction strategy:**

- **yt-dlp**: `ERROR: you-debt-your-life: An extractor error has occurred. (caused by KeyError('media')); please report this issue on  https://github.com/yt-dlp/yt-dlp/issues?q= , filling out the appropriate issue template. Confirm you are on the latest version using  yt-dlp -U`
- **platform-specific extractor**: `no matching platform extractor`
- **WebView/runtime interception**: `browser runtime is client-side only`
- **HLS manifest detector**: `hls detector found no media`
- **DASH manifest detector**: `dash detector found no media`
- **OG/meta tag extractor**: `og detector found no media`
- **generic media detector**: `generic detector found no media`
- **embedded player detector**: `no embedded player signatures found in page HTML`
- **generic yt-dlp extractor**: `ERROR: you-debt-your-life: An extractor error has occurred. (caused by KeyError('media')); please report this issue on  https://github.com/yt-dlp/yt-dlp/issues?q= , filling out the appropriate issue template. Confirm you are on the latest version using  yt-dlp -U`
- **ytdl-stream**: `URL does not need ytdl-stream`
- **browser playback fallback**: `browser playback fallback must run in the app WebView`

---

### FOD / Fuji TV (HTTP 502)

> unsupported after all extraction strategies failed: yt-dlp: ERROR: [FujiTVFODPlus7] 5d40110076: 5d40110076: Failed to parse JSON (caused by JSONDecodeError("Expecting value in '': line 1 column 1 (char 0)")); please report this issue on  https://github.com/yt-dlp/yt-dlp/issues?q= , filling out the appropriate issue template. Confirm you are on the latest version using  yt-dlp -U; platform-specific extractor: Japanese site — handled by yt-dlp with Accept-Language:ja; falling through; HLS manifest detector: hls detector found no media; DASH manifest detector: dash detector found no media; OG/meta tag extractor: og detector found no media; generic media detector: generic detector found no media; embedded player detector: no embedded player signatures found in page HTML; generic yt-dlp extractor: ERROR: [FujiTVFODPlus7] 5d40110076: 5d40110076: 

**Diagnostics by extraction strategy:**

- **yt-dlp**: `ERROR: [FujiTVFODPlus7] 5d40110076: 5d40110076: Failed to parse JSON (caused by JSONDecodeError("Expecting value in '': line 1 column 1 (char 0)")); please report this issue on  https://github.com/yt-dlp/yt-dlp/issues?q= , filling out the appropriate issue template. Confirm you are on the latest version using  yt-dlp -U`
- **platform-specific extractor**: `Japanese site — handled by yt-dlp with Accept-Language:ja; falling through`
- **WebView/runtime interception**: `browser runtime is client-side only`
- **HLS manifest detector**: `hls detector found no media`
- **DASH manifest detector**: `dash detector found no media`
- **OG/meta tag extractor**: `og detector found no media`
- **generic media detector**: `generic detector found no media`
- **embedded player detector**: `no embedded player signatures found in page HTML`
- **generic yt-dlp extractor**: `ERROR: [FujiTVFODPlus7] 5d40110076: 5d40110076: Failed to parse JSON (caused by JSONDecodeError("Expecting value in '': line 1 column 1 (char 0)")); please report this issue on  https://github.com/yt-dlp/yt-dlp/issues?q= , filling out the appropriate issue template. Confirm you are on the latest version using  yt-dlp -U`
- **ytdl-stream**: `URL does not need ytdl-stream`
- **browser playback fallback**: `browser playback fallback must run in the app WebView`

---

### Yahoo Japan video/news (HTTP 502)

> unsupported after all extraction strategies failed: yt-dlp: ERROR: [yahoo:japannews] a70fe3a064f1cfec937e2252c7fc6c1ba3201c0e: Unable to download webpage: HTTP Error 404: Not Found (caused by <HTTPError 404: Not Found>); platform-specific extractor: Japanese site — handled by yt-dlp with Accept-Language:ja; falling through; HLS manifest detector: network error: HTTP Error 404: Not Found; DASH manifest detector: network error: HTTP Error 404: Not Found; OG/meta tag extractor: network error: HTTP Error 404: Not Found; generic media detector: network error: HTTP Error 404: Not Found; embedded player detector: fetch: HTTP Error 404: Not Found; generic yt-dlp extractor: ERROR: [yahoo:japannews] a70fe3a064f1cfec937e2252c7fc6c1ba3201c0e: Unable to download webpage: HTTP Error 404: Not Found (caused by <HTTPError 404: Not Found>); ytdl-stream: URL 

**Diagnostics by extraction strategy:**

- **yt-dlp**: `ERROR: [yahoo:japannews] a70fe3a064f1cfec937e2252c7fc6c1ba3201c0e: Unable to download webpage: HTTP Error 404: Not Found (caused by <HTTPError 404: Not Found>)`
- **platform-specific extractor**: `Japanese site — handled by yt-dlp with Accept-Language:ja; falling through`
- **WebView/runtime interception**: `browser runtime is client-side only`
- **HLS manifest detector**: `network error: HTTP Error 404: Not Found`
- **DASH manifest detector**: `network error: HTTP Error 404: Not Found`
- **OG/meta tag extractor**: `network error: HTTP Error 404: Not Found`
- **generic media detector**: `network error: HTTP Error 404: Not Found`
- **embedded player detector**: `fetch: HTTP Error 404: Not Found`
- **generic yt-dlp extractor**: `ERROR: [yahoo:japannews] a70fe3a064f1cfec937e2252c7fc6c1ba3201c0e: Unable to download webpage: HTTP Error 404: Not Found (caused by <HTTPError 404: Not Found>)`
- **ytdl-stream**: `URL does not need ytdl-stream`
- **browser playback fallback**: `browser playback fallback must run in the app WebView`

---

### DMM (HTTP 502)

> No extractor found for this URL and the page HTML contained no detectable media. This usually means the video is loaded by a JavaScript player that the server cannot run. If you are using the FCDownloader browser extension, check the extension popup — it may have already detected the video automatically as the page loaded in your browser. Otherwise use the FCDownload bookmarklet to capture the stream URL directly. (details: yt-dlp: ERROR: Unsupported URL: https://www.dmm.co.jp/en/age_check/=/?rurl=https%3A%2F%2Fvideo.dmm.co.jp%2Fcontent%2F%3Fid%3D13ds00645; platform-specific extractor: Japanese site — handled by yt-dlp with Accept-Language:ja; falling through; HLS manifest detector: hls detector found no media; DASH manifest detector: dash detector found no media; OG/meta tag extractor: og detector found no media; ge)

**Diagnostics by extraction strategy:**

- **yt-dlp**: `ERROR: Unsupported URL: https://www.dmm.co.jp/en/age_check/=/?rurl=https%3A%2F%2Fvideo.dmm.co.jp%2Fcontent%2F%3Fid%3D13ds00645`
- **platform-specific extractor**: `Japanese site — handled by yt-dlp with Accept-Language:ja; falling through`
- **WebView/runtime interception**: `browser runtime is client-side only`
- **HLS manifest detector**: `hls detector found no media`
- **DASH manifest detector**: `dash detector found no media`
- **OG/meta tag extractor**: `og detector found no media`
- **generic media detector**: `generic detector found no media`
- **embedded player detector**: `no embedded player signatures found in page HTML`
- **generic yt-dlp extractor**: `ERROR: Unsupported URL: https://www.dmm.co.jp/en/age_check/=/?rurl=https%3A%2F%2Fvideo.dmm.co.jp%2Fcontent%2F%3Fid%3D13ds00645`
- **ytdl-stream**: `URL does not need ytdl-stream`
- **browser playback fallback**: `browser playback fallback must run in the app WebView`

---

### Mildom (HTTP 502)

> unsupported after all extraction strategies failed: yt-dlp: ERROR: [generic] Unable to download webpage: [Errno -3] Temporary failure in name resolution (caused by TransportError('[Errno -3] Temporary failure in name resolution')); platform-specific extractor: Japanese site — handled by yt-dlp with Accept-Language:ja; falling through; HLS manifest detector: network error: <urlopen error [Errno -3] Temporary failure in name resolution>; DASH manifest detector: network error: <urlopen error [Errno -3] Temporary failure in name resolution>; OG/meta tag extractor: network error: <urlopen error [Errno -3] Temporary failure in name resolution>; generic media detector: network error: <urlopen error [Errno -3] Temporary failure in name resolution>; embedded player detector: fetch: <urlopen error [Errno -3] Temporary failure in name resolution>; gen

**Diagnostics by extraction strategy:**

- **yt-dlp**: `ERROR: [generic] Unable to download webpage: [Errno -3] Temporary failure in name resolution (caused by TransportError('[Errno -3] Temporary failure in name resolution'))`
- **platform-specific extractor**: `Japanese site — handled by yt-dlp with Accept-Language:ja; falling through`
- **WebView/runtime interception**: `browser runtime is client-side only`
- **HLS manifest detector**: `network error: <urlopen error [Errno -3] Temporary failure in name resolution>`
- **DASH manifest detector**: `network error: <urlopen error [Errno -3] Temporary failure in name resolution>`
- **OG/meta tag extractor**: `network error: <urlopen error [Errno -3] Temporary failure in name resolution>`
- **generic media detector**: `network error: <urlopen error [Errno -3] Temporary failure in name resolution>`
- **embedded player detector**: `fetch: <urlopen error [Errno -3] Temporary failure in name resolution>`
- **generic yt-dlp extractor**: `ERROR: [generic] Unable to download webpage: [Errno -3] Temporary failure in name resolution (caused by TransportError('[Errno -3] Temporary failure in name resolution'))`
- **ytdl-stream**: `URL does not need ytdl-stream`
- **browser playback fallback**: `browser playback fallback must run in the app WebView`

---

### Naver Entertainment (HTTP 502)

> No extractor found for this URL and the page HTML contained no detectable media. This usually means the video is loaded by a JavaScript player that the server cannot run. If you are using the FCDownloader browser extension, check the extension popup — it may have already detected the video automatically as the page loaded in your browser. Otherwise use the FCDownload bookmarklet to capture the stream URL directly. (details: yt-dlp: ERROR: Unsupported URL: https://m.entertain.naver.com/now; platform-specific extractor: no matching platform extractor; HLS manifest detector: hls detector found no media; DASH manifest detector: dash detector found no media; OG/meta tag extractor: og detector found no media; generic media detector: generic detector found no media; embedded player detector: no embedded player signatures fo)

**Diagnostics by extraction strategy:**

- **yt-dlp**: `ERROR: Unsupported URL: https://m.entertain.naver.com/now`
- **platform-specific extractor**: `no matching platform extractor`
- **WebView/runtime interception**: `browser runtime is client-side only`
- **HLS manifest detector**: `hls detector found no media`
- **DASH manifest detector**: `dash detector found no media`
- **OG/meta tag extractor**: `og detector found no media`
- **generic media detector**: `generic detector found no media`
- **embedded player detector**: `no embedded player signatures found in page HTML`
- **generic yt-dlp extractor**: `ERROR: Unsupported URL: https://m.entertain.naver.com/now`
- **ytdl-stream**: `URL does not need ytdl-stream`
- **browser playback fallback**: `browser playback fallback must run in the app WebView`

---

### Naver Sports (HTTP 502)

> unsupported after all extraction strategies failed: yt-dlp: ERROR: [generic] Unable to download webpage: HTTP Error 404: Not Found (caused by <HTTPError 404: Not Found>); platform-specific extractor: no matching platform extractor; HLS manifest detector: network error: HTTP Error 404: Not Found; DASH manifest detector: network error: HTTP Error 404: Not Found; OG/meta tag extractor: network error: HTTP Error 404: Not Found; generic media detector: network error: HTTP Error 404: Not Found; embedded player detector: fetch: HTTP Error 404: Not Found; generic yt-dlp extractor: ERROR: [generic] Unable to download webpage: HTTP Error 404: Not Found (caused by <HTTPError 404: Not Found>); ytdl-stream: URL does not need ytdl-stream

**Diagnostics by extraction strategy:**

- **yt-dlp**: `ERROR: [generic] Unable to download webpage: HTTP Error 404: Not Found (caused by <HTTPError 404: Not Found>)`
- **platform-specific extractor**: `no matching platform extractor`
- **WebView/runtime interception**: `browser runtime is client-side only`
- **HLS manifest detector**: `network error: HTTP Error 404: Not Found`
- **DASH manifest detector**: `network error: HTTP Error 404: Not Found`
- **OG/meta tag extractor**: `network error: HTTP Error 404: Not Found`
- **generic media detector**: `network error: HTTP Error 404: Not Found`
- **embedded player detector**: `fetch: HTTP Error 404: Not Found`
- **generic yt-dlp extractor**: `ERROR: [generic] Unable to download webpage: HTTP Error 404: Not Found (caused by <HTTPError 404: Not Found>)`
- **ytdl-stream**: `URL does not need ytdl-stream`
- **browser playback fallback**: `browser playback fallback must run in the app WebView`

---

### ViVi (HTTP 502)

> unsupported after all extraction strategies failed: yt-dlp: ERROR: [generic] Unable to download webpage: HTTP Error 404: Not Found (caused by <HTTPError 404: Not Found>); platform-specific extractor: no matching platform extractor; HLS manifest detector: network error: HTTP Error 404: Not Found; DASH manifest detector: network error: HTTP Error 404: Not Found; OG/meta tag extractor: network error: HTTP Error 404: Not Found; generic media detector: network error: HTTP Error 404: Not Found; embedded player detector: fetch: HTTP Error 404: Not Found; generic yt-dlp extractor: ERROR: [generic] Unable to download webpage: HTTP Error 404: Not Found (caused by <HTTPError 404: Not Found>); ytdl-stream: URL does not need ytdl-stream

**Diagnostics by extraction strategy:**

- **yt-dlp**: `ERROR: [generic] Unable to download webpage: HTTP Error 404: Not Found (caused by <HTTPError 404: Not Found>)`
- **platform-specific extractor**: `no matching platform extractor`
- **WebView/runtime interception**: `browser runtime is client-side only`
- **HLS manifest detector**: `network error: HTTP Error 404: Not Found`
- **DASH manifest detector**: `network error: HTTP Error 404: Not Found`
- **OG/meta tag extractor**: `network error: HTTP Error 404: Not Found`
- **generic media detector**: `network error: HTTP Error 404: Not Found`
- **embedded player detector**: `fetch: HTTP Error 404: Not Found`
- **generic yt-dlp extractor**: `ERROR: [generic] Unable to download webpage: HTTP Error 404: Not Found (caused by <HTTPError 404: Not Found>)`
- **ytdl-stream**: `URL does not need ytdl-stream`
- **browser playback fallback**: `browser playback fallback must run in the app WebView`

---

### Fashionsnap (HTTP 502)

> No extractor found for this URL and the page HTML contained no detectable media. This usually means the video is loaded by a JavaScript player that the server cannot run. If you are using the FCDownloader browser extension, check the extension popup — it may have already detected the video automatically as the page loaded in your browser. Otherwise use the FCDownload bookmarklet to capture the stream URL directly. (details: yt-dlp: ERROR: Unsupported URL: https://www.fashionsnap.com/article/2026-06-03/nakagawa-masashichi-shitsurindo/?ref=simple-news-click; platform-specific extractor: no matching platform extractor; HLS manifest detector: hls detector found no media; DASH manifest detector: dash detector found no media; OG/meta tag extractor: og detector found no media; generic media detector: generic detector found )

**Diagnostics by extraction strategy:**

- **yt-dlp**: `ERROR: Unsupported URL: https://www.fashionsnap.com/article/2026-06-03/nakagawa-masashichi-shitsurindo/?ref=simple-news-click`
- **platform-specific extractor**: `no matching platform extractor`
- **WebView/runtime interception**: `browser runtime is client-side only`
- **HLS manifest detector**: `hls detector found no media`
- **DASH manifest detector**: `dash detector found no media`
- **OG/meta tag extractor**: `og detector found no media`
- **generic media detector**: `generic detector found no media`
- **embedded player detector**: `no embedded player signatures found in page HTML`
- **generic yt-dlp extractor**: `ERROR: Unsupported URL: https://www.fashionsnap.com/article/2026-06-03/nakagawa-masashichi-shitsurindo/?ref=simple-news-click`
- **ytdl-stream**: `URL does not need ytdl-stream`
- **browser playback fallback**: `browser playback fallback must run in the app WebView`

---

### WWD Japan (HTTP 502)

> No extractor found for this URL and the page HTML contained no detectable media. This usually means the video is loaded by a JavaScript player that the server cannot run. If you are using the FCDownloader browser extension, check the extension popup — it may have already detected the video automatically as the page loaded in your browser. Otherwise use the FCDownload bookmarklet to capture the stream URL directly. (details: yt-dlp: ERROR: Unsupported URL: https://www.wwdjapan.com/c/leaders/; platform-specific extractor: Japanese site — handled by yt-dlp with Accept-Language:ja; falling through; HLS manifest detector: hls detector found no media; DASH manifest detector: dash detector found no media; OG/meta tag extractor: og detector found no media; generic media detector: generic detector found no media; embedded pla)

**Diagnostics by extraction strategy:**

- **yt-dlp**: `ERROR: Unsupported URL: https://www.wwdjapan.com/c/leaders/`
- **platform-specific extractor**: `Japanese site — handled by yt-dlp with Accept-Language:ja; falling through`
- **WebView/runtime interception**: `browser runtime is client-side only`
- **HLS manifest detector**: `hls detector found no media`
- **DASH manifest detector**: `dash detector found no media`
- **OG/meta tag extractor**: `og detector found no media`
- **generic media detector**: `generic detector found no media`
- **embedded player detector**: `no embedded player signatures found in page HTML`
- **generic yt-dlp extractor**: `ERROR: Unsupported URL: https://www.wwdjapan.com/c/leaders/`
- **ytdl-stream**: `URL does not need ytdl-stream`
- **browser playback fallback**: `browser playback fallback must run in the app WebView`

---

### Mainichi (HTTP 502)

> No extractor found for this URL and the page HTML contained no detectable media. This usually means the video is loaded by a JavaScript player that the server cannot run. If you are using the FCDownloader browser extension, check the extension popup — it may have already detected the video automatically as the page loaded in your browser. Otherwise use the FCDownload bookmarklet to capture the stream URL directly. (details: yt-dlp: ERROR: Unsupported URL: https://mainichi.jp/ch150910144i/%E9%A6%96%E7%9B%B8%E6%97%A5%E3%80%85; platform-specific extractor: Japanese site — handled by yt-dlp with Accept-Language:ja; falling through; HLS manifest detector: hls detector found no media; DASH manifest detector: dash detector found no media; OG/meta tag extractor: og detector found no media; generic media detector: generic det)

**Diagnostics by extraction strategy:**

- **yt-dlp**: `ERROR: Unsupported URL: https://mainichi.jp/ch150910144i/%E9%A6%96%E7%9B%B8%E6%97%A5%E3%80%85`
- **platform-specific extractor**: `Japanese site — handled by yt-dlp with Accept-Language:ja; falling through`
- **WebView/runtime interception**: `browser runtime is client-side only`
- **HLS manifest detector**: `hls detector found no media`
- **DASH manifest detector**: `dash detector found no media`
- **OG/meta tag extractor**: `og detector found no media`
- **generic media detector**: `generic detector found no media`
- **embedded player detector**: `no embedded player signatures found in page HTML`
- **generic yt-dlp extractor**: `ERROR: Unsupported URL: https://mainichi.jp/ch150910144i/%E9%A6%96%E7%9B%B8%E6%97%A5%E3%80%85`
- **ytdl-stream**: `URL does not need ytdl-stream`
- **browser playback fallback**: `browser playback fallback must run in the app WebView`

---

