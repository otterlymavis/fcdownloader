# fcdownloader extraction server

Minimal yt-dlp-backed HTTP service the mobile app talks to for HD YouTube
extraction. The on-device fallback (InnerTube → 360p muxed mp4) keeps working
when this server is offline; the server only kicks in when you've pointed the
app at it via **Settings → HD Extractor (Optional) → Backend URL**.

## Endpoint

```http
POST /extract
Content-Type: application/json
Authorization: Bearer <SHARED_TOKEN>   ← optional

{ "pageUrl": "https://www.youtube.com/watch?v=..." }
```

Response (200):

```json
{
  "kind": "paired",          // or "hls" or "direct"
  "videoUrl": "https://...", // when kind=paired
  "audioUrl": "https://...", // when kind=paired
  "url":      "https://...", // when kind=hls or kind=direct
  "headers":  { "User-Agent": "...", "Origin": "...", "Referer": "..." },
  "label":         "1080p",
  "mimeType":      "video/mp4",
  "audioMimeType": "audio/mp4",
  "expire":        1779600000
}
```

The app downloads the URL(s) directly from the CDN — no bytes traverse the
server, so cost stays at the lowest possible tier.

## Run locally (sanity check)

```bash
cd server
python -m venv .venv && source .venv/bin/activate    # Windows: .venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --port 8080 --reload
```

Test it:

```bash
curl -X POST http://localhost:8080/extract \
  -H 'Content-Type: application/json' \
  -d '{"pageUrl":"https://www.youtube.com/watch?v=dQw4w9WgXcQ"}'
```

You should get a JSON response with `videoUrl`, `audioUrl`, and headers. To
use this from the app, set the Backend URL to `http://<your-LAN-IP>:8080` and
make sure your phone is on the same network.

Health check:

```bash
curl http://localhost:8080/
```

## Deploy to Fly.io (recommended)

Free tier covers it. ~3 minutes total.

```bash
# One-time setup
brew install flyctl                       # or: curl -L https://fly.io/install.sh | sh
fly auth signup                            # or fly auth login

# From the server/ directory
cd server
fly launch --no-deploy --copy-config       # accept defaults; say NO to overwriting fly.toml

# Optional but recommended: lock it down with a shared secret
fly secrets set SHARED_TOKEN=$(openssl rand -hex 24)
fly secrets list                           # note the token value here

fly deploy
fly status                                 # confirm it's running
curl https://your-instance.fly.dev/
curl https://your-instance.fly.dev/version
```

The app's Backend URL becomes `https://your-instance.fly.dev`.
Paste the token you set (from `fly secrets list` or whatever you copy/pasted)
into the **Token** field in Settings.

To change region or app name, edit `fly.toml` before `fly launch`.

## Deploy to Railway

```bash
# Sign in at railway.app, then:
npm i -g @railway/cli
railway login
cd server
railway init                               # creates a new project
railway up                                 # builds + deploys from this dir
railway variables set SHARED_TOKEN=$(openssl rand -hex 24)
railway domain                             # generates a public URL
```

Free tier: $5/mo of credit, this app idle-cost is well under that.

## Deploy via Docker anywhere

```bash
docker build -t fcdl-extractor server/
docker run -p 8080:8080 \
  -e SHARED_TOKEN=$(openssl rand -hex 24) \
  fcdl-extractor
```

Push to your container registry and deploy on any host that runs Docker —
Render, fly, your own VPS, k8s, whatever. The app needs only:
- A reachable HTTPS URL
- Port 8080 (or set `PORT` env var)

## Configuration

| Env var           | Default                          | What it does |
|-------------------|----------------------------------|--------------|
| `PORT`            | 8080                             | Listen port |
| `RATE_LIMIT`      | `30/minute;300/hour;1500/day`    | Per-IP rate limit. Multiple windows enforced simultaneously. Format: see slowapi docs. |
| `CACHE_TTL`       | 300                              | Cache lifetime in seconds. Same video extracted within this window returns instantly from RAM. |
| `CACHE_MAX`       | 2000                             | Max number of cached entries (auto-evicts oldest). |
| `TRUSTED_TOKEN`   | (none)                           | If set, requests carrying `Authorization: Bearer <token>` (or `?token=`) are still rate-limited but logged separately. Use for your own dev/testing devices. |
| `YT_COOKIES_FILE` | (none)                           | Path to a Netscape-format cookies file. Needed for age-gated / members-only / region-locked content. |

## Cookies (required for Fly.io / any datacenter deploy)

YouTube detects datacenter IPs (Fly, AWS, GCP, …) and rejects most extraction
requests with `Sign in to confirm you're not a bot` — *even though local
yt-dlp on a residential IP works fine for the same video*. The workaround is
cookies from a logged-in YouTube session.

**Strongly recommended: use a throwaway Google account.** The cookies file
is a full session credential — anyone who reads it can hijack the account.
Don't use your main account.

### 1. Create / log into a throwaway account

Sign in at https://youtube.com with a Gmail account you don't care about. A
brand-new free account works fine.

### 2. Export cookies

In Chrome / Firefox / Brave, install **"Get cookies.txt LOCALLY"** (an
open-source extension; *do not* install random "cookie exporter" forks —
many are malicious). With `youtube.com` open:

- Click the extension icon → **Export** → save as `cookies.txt`

### 3. Upload to Fly as a base64 secret

In PowerShell:

```powershell
$bytes = [System.IO.File]::ReadAllBytes("C:\path\to\cookies.txt")
$b64 = [Convert]::ToBase64String($bytes)
cd D:\fcdownloader\server
fly secrets set YT_COOKIES_BASE64=$b64
```

The server decodes it to a tempfile at startup and points yt-dlp at it.

Redeploy after setting any secret:

```powershell
fly deploy
```

### 4. Rotate periodically

YouTube cookies expire (~2 weeks typical, can be longer). When the server
starts returning "Sign in" again, re-export and re-upload. Easy to script if
this gets annoying.

### Alternative: bake into Docker image (less secure)

If you don't mind rebuilding when cookies expire:

```dockerfile
COPY cookies.txt /cookies.txt
ENV YT_COOKIES_FILE=/cookies.txt
```

Don't check `cookies.txt` into git — add it to `.dockerignore` (already done).

## Security & abuse protection

The endpoint is **not authenticated by default** because a token bundled into
a distributed APK leaks the moment anyone decompiles it. Real defenses are
multi-layered:

1. **Per-IP rate limiting** (built in via SlowAPI) — defaults to
   `30/minute;300/hour;1500/day` per source IP. Override with the
   `RATE_LIMIT` env var. Behind Fly.io / Cloudflare the real client IP is
   read from `Fly-Client-IP` / `CF-Connecting-IP` headers automatically.
2. **Response cache** — same video extracted within `CACHE_TTL` seconds
   (default 300) returns instantly from RAM, costing nothing. A popular
   video extracted 10,000 times only invokes yt-dlp once.
3. **Spend cap on Fly** — see "Setting a billing cap" below. Absolute
   ceiling on your monthly bill, regardless of any abuse.
4. **Optional trusted-token bypass** — set `TRUSTED_TOKEN` env var if you
   want your own dev devices to bypass the rate limit (handy for testing).

For Tailscale / Cloudflare Tunnel / VPN-only deployments the rate limit
matters less but doesn't hurt.

### Setting a billing cap on Fly.io

Hard ceiling on your monthly bill — recommended for any public-facing
deployment. From the Fly dashboard:

1. https://fly.io/dashboard → your org → **Billing** → **Spend Management**
2. Set a monthly cap (e.g. `$5`). Fly will email you at 80% and suspend the
   app at 100%.

### Estimating cost at scale

The server returns ~3 KB JSON per call; video bytes go phone↔CDN directly.

| Active users (DAU) | Calls / month | Fly cost / mo |
|--------------------|---------------|---------------|
| 10 (just you+friends) | ~3 000     | $0            |
| 100                | ~30 000       | $0            |
| 1 000              | ~300 000      | $0 (free tier covers ~400k calls) |
| 10 000             | ~3 M          | ~$2           |
| 100 000            | ~30 M         | ~$15–25       |

Numbers assume ~10 downloads/user/month and ~30% cache hit rate. Cache hit
rate goes way up for popular content (think music videos, viral clips), so
real cost is typically lower.

### What still leaks if the token leaks

Nothing critical — the endpoint just returns CDN URLs. There's no API key
for a paid service, no user data, no credentials. The worst an abuser can do
is consume your rate-limit slot.

## Updating yt-dlp

YouTube changes frequently. On Fly: `fly deploy` (rebuilds with latest
`yt-dlp>=...` from pip). On Railway: `railway up`. On Docker: rebuild the
image. A weekly cron is reasonable for hobby use.

## What the server costs

| Host       | Idle      | ~30 extracts/day | Notes |
|------------|-----------|------------------|-------|
| Fly.io     | $0        | $0               | Free tier covers 3 small machines + 160GB egress |
| Railway    | $0        | $0–1             | $5/mo credit, this app uses maybe $0.10–0.50/mo |
| Render free| $0        | $0               | Sleeps after 15 min idle — first extract is slow (~30s cold start) |

Each `/extract` call is ~50ms of CPU + ~30 KB of egress (just the JSON, the
phone fetches CDN bytes directly).
