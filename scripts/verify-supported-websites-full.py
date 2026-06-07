from __future__ import annotations

import contextlib
import argparse
import io
import json
import gzip
import socket
import re
import sys
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
SERVER = ROOT / "server"
sys.path.insert(0, str(SERVER))

import extractors  # noqa: E402
from main import _to_gallery_response, _to_response  # noqa: E402
from strategies import run_extraction  # noqa: E402

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/125.0.0.0 Safari/537.36"
)
DNS_FALLBACK_HOSTS = {"video.fc2.com", "live.fc2.com"}
DNS_FALLBACK_CACHE: dict[str, list[str]] = {}

THUMBNAIL_RE = re.compile(
    r"(?:thumb|thumbnail|avatar|profile(?:_pic)?|placeholder|blank|pixel|"
    r"[_/-](?:\d{1,3}x\d{1,3}|s\d{2,4}x\d{2,4})(?:[_.?/-]|$)|"
    r"[?&](?:thumb|thumbnail|preview|avatar)=)",
    re.I,
)


@dataclass(frozen=True)
class Case:
    name: str
    kind: str
    urls: tuple[str, ...] = ()
    seeds: tuple[str, ...] = ()
    expected: str = "pass"
    note: str = ""
    max_candidates: int = 8
    results: list[dict[str, Any]] = field(default_factory=list, compare=False)


VIDEO_CASES: list[Case] = [
    Case("YouTube", "video", ("https://www.youtube.com/watch?v=BaW_jenozKc&t=1s&end=9",)),
    Case("Vimeo", "video", ("https://vimeo.com/76979871", "http://vimeo.com/56015672#at=0")),
    Case("Bilibili", "video", ("https://www.bilibili.com/video/BV13x41117TL", "https://www.bilibili.com/video/BV1xx411c7mD")),
    Case("Niconico", "video", ("https://www.nicovideo.jp/watch/1173108780", "https://www.nicovideo.jp/watch/sm9")),
    Case("TVer", "video", ("https://tver.jp/episodes/epc1hdugbk",), expected="blocked", note="often geo/DRM/current-episode restricted"),
    Case("ABEMA", "video", ("https://abema.tv/video/episode/194-25_s2_p1",), expected="blocked", note="often region/DRM restricted"),
    Case("NHK", "video", ("https://www3.nhk.or.jp/nhkworld/en/shows/2049165/", "https://www2.nhk.or.jp/school/movie/bangumi.cgi?das_id=D0005150191_00000")),
    Case("TwitCasting", "video", ("https://twitcasting.tv/ivetesangalo/movie/2357609",)),
    Case("FC2 Video", "video", ("http://video.fc2.com/en/content/20121103kUan1KHs",)),
    Case("FC2 Live", "video", ("https://live.fc2.com/57892267/",), expected="blocked", note="sample channel is currently offline; live/auth availability varies"),
    Case("OpenREC", "video", ("https://www.openrec.tv/movie/nqz5xl5km8v", "https://www.openrec.tv/capture/l9nk2x4gn14")),
    Case("TBS", "video", ("https://www.tbs.com/shows/american-dad/season-6/episode-12/you-debt-your-life",), expected="blocked", note="US TBS sample commonly geo restricted"),
    Case("FOD / Fuji TV", "video", ("https://fod.fujitv.co.jp/title/5d40/5d40110076",), expected="blocked", note="DRM/region restrictions common"),
    Case("Yahoo Japan video/news", "video", ("https://news.yahoo.co.jp/articles/a70fe3a064f1cfec937e2252c7fc6c1ba3201c0e",), expected="blocked", note="datacenter fetches often 403"),
    Case("Naver TV", "video", ("http://tv.naver.com/v/81652",)),
    Case("Kakao TV", "video", ("http://tv.kakao.com/channel/2671005/cliplink/301965083",), expected="blocked", note="current CDN media URL rejects direct server probes"),
    Case("Reddit", "video", ("https://ja.reddit.com/r/nextfuckinglevel/comments/1s0tflu/grave_digger_getting_some_serious_air_and_showing/",)),
    Case("Instagram", "video", ("https://instagram.com/p/aye83DjauH/?foo=bar#abc",), expected="blocked", note="Meta generally needs browser cookies"),
    Case("Threads", "video", ("https://www.threads.net/@instagram/post/CuZsgc9vQ0M",), expected="blocked", note="Meta generally needs browser runtime/cookies"),
    Case("Xiaohongshu / XHS", "video", ("https://www.xiaohongshu.com/explore/6411cf99000000001300b6d9",), expected="blocked", note="often requires app/browser session"),
    Case("Bilibili dynamic / opus", "auto", ("https://t.bilibili.com/998134289197432852",), expected="blocked", note="test post has no valid video URL and dynamic pages often need browser/session context"),
]


GALLERY_CASES: list[Case] = [
    Case("Oricon", "gallery", ("https://www.oricon.co.jp/news/2452025/photo/1/",)),
    Case("Modelpress / mdpr.jp", "gallery", ("https://mdpr.jp/news/4690888",)),
    Case("Natalie.mu", "gallery", ("https://natalie.mu/music/news/670712",)),
    Case("Naver Blog", "gallery", ("https://blog.naver.com/jalee3228/224297926556",)),
    Case("Naver News", "gallery", seeds=("https://n.news.naver.com/", "https://news.naver.com/")),
    Case("Naver Entertainment", "gallery", seeds=("https://m.entertain.naver.com/", "https://entertain.naver.com/"), expected="blocked", note="home feed is rendered client-side; direct article URLs are handled when available"),
    Case("Naver Sports", "gallery", seeds=("https://m.sports.naver.com/", "https://sports.news.naver.com/"), expected="blocked", note="home feed is rendered client-side or unavailable to this server environment"),
    Case("Ameblo / Ameba Blog", "gallery", seeds=("https://ameblo.jp/",)),
    Case("Kstyle", "gallery", seeds=("https://kstyle.com/",)),
    Case("Daum / Tistory", "gallery", ("https://storymarketer.tistory.com/entry/%EB%B8%94%EB%A1%9C%EA%B7%B8-%EB%A7%88%EC%BC%80%ED%8C%85-%EC%95%84%EC%A7%81-%ED%9A%A8%EA%B3%BC-%EC%9E%88%EC%9D%84%EA%B9%8C",), seeds=("https://www.daum.net/", "https://www.tistory.com/")),
    Case("Livedoor Blog", "gallery", ("http://blog.livedoor.jp/new_alces/archives/4980902.html",), seeds=("https://blog.livedoor.jp/",)),
    Case("Yahoo Japan articles", "gallery", seeds=("https://news.yahoo.co.jp/",), expected="blocked", note="server fetch often 403; extension pageHtml path supported"),
    Case("Pixiv / Fanbox", "gallery", ("https://www.pixiv.net/artworks/100000000",)),
    Case("Bunshun Online", "gallery", seeds=("https://bunshun.jp/",)),
    Case("Daily Shincho", "gallery", seeds=("https://www.dailyshincho.jp/",)),
    Case("News Post Seven / Josei Seven", "gallery", seeds=("https://www.news-postseven.com/", "https://josei7.com/")),
    Case("FRIDAY / Kodansha", "gallery", seeds=("https://friday.kodansha.co.jp/",)),
    Case("Gendai Media", "gallery", seeds=("https://gendai.media/",)),
    Case("With", "gallery", seeds=("https://withonline.jp/",)),
    Case("ViVi", "gallery", seeds=("https://www.vivi.tv/",)),
    Case("CanCam", "gallery", seeds=("https://cancam.jp/",)),
    Case("CLASSY", "gallery", seeds=("https://classy-online.jp/",)),
    Case("JJ", "gallery", seeds=("https://jj-jj.net/",)),
    Case("Ginger", "gallery", seeds=("https://gingerweb.jp/",)),
    Case("ar", "gallery", seeds=("https://ar-mag.jp/",)),
    Case("bis", "gallery", seeds=("https://bisweb.jp/",)),
    Case("Ray", "gallery", seeds=("https://ray-web.jp/",)),
    Case("HP+ non-no", "gallery", seeds=("https://nonno.hpplus.jp/",)),
    Case("HP+ SPUR", "gallery", seeds=("https://spur.hpplus.jp/",)),
    Case("HP+ MAQUIA", "gallery", ("https://maquia.hpplus.jp/tag/3259/",), seeds=("https://maquia.hpplus.jp/",)),
    Case("HP+ LEE", "gallery", seeds=("https://lee.hpplus.jp/",)),
    Case("HP+ BAILA", "gallery", seeds=("https://baila.hpplus.jp/",)),
    Case("HP+ MORE", "gallery", seeds=("https://more.hpplus.jp/",), expected="blocked", note="DNS resolution for more.hpplus.jp failed in this environment"),
    Case("anan web", "gallery", seeds=("https://ananweb.jp/",)),
    Case("Croissant Online", "gallery", seeds=("https://croissant-online.jp/",)),
    Case("FRaU", "gallery", seeds=("https://frau.tokyo/",)),
    Case("mi-mollet", "gallery", seeds=("https://mi-mollet.com/",)),
    Case("Fashion Press", "gallery", seeds=("https://www.fashion-press.net/",)),
    Case("Fashionsnap", "gallery", seeds=("https://www.fashionsnap.com/",)),
    Case("WWD Japan", "gallery", seeds=("https://www.wwdjapan.com/",)),
    Case("The Television", "gallery", seeds=("https://thetv.jp/",)),
    Case("Mantan Web", "gallery", seeds=("https://mantan-web.jp/",), expected="blocked", note="server fetch currently receives 403; browser/session path is used when available"),
    Case("Crank In", "gallery", seeds=("https://www.crank-in.net/",)),
    Case("Cinema Today", "gallery", seeds=("https://www.cinematoday.jp/",)),
    Case("Eiga.com", "gallery", seeds=("https://eiga.com/",)),
    Case("Real Sound", "gallery", seeds=("https://realsound.jp/",)),
    Case("Spice", "gallery", ("https://spice.eplus.jp/articles/346378",), seeds=("https://spice.eplus.jp/",)),
    Case("JPrime", "gallery", seeds=("https://www.jprime.jp/",)),
    Case("Smart Flash", "gallery", seeds=("https://smart-flash.jp/",)),
    Case("Flash", "gallery", seeds=("https://flash.jp/",), expected="blocked", note="flash.jp DNS/TLS lookup failed in this environment"),
    Case("Nikkan Gendai", "gallery", seeds=("https://www.nikkan-gendai.com/",)),
    Case("Asagei", "gallery", seeds=("https://www.asagei.com/",)),
    Case("Entame Next", "gallery", seeds=("https://entamenext.com/",)),
    Case("GirlsNews", "gallery", seeds=("https://girlsnews.tv/",)),
    Case("Tokyo Sports", "gallery", seeds=("https://www.tokyo-sports.co.jp/",)),
    Case("Hochi", "gallery", seeds=("https://hochi.news/",)),
    Case("Sponichi", "gallery", seeds=("https://www.sponichi.co.jp/",)),
    Case("Nikkan Sports", "gallery", seeds=("https://www.nikkansports.com/",)),
    Case("Sanspo", "gallery", seeds=("https://www.sanspo.com/",)),
    Case("Mainichi", "gallery", seeds=("https://mainichi.jp/",)),
    Case("Asahi", "gallery", seeds=("https://www.asahi.com/",)),
    Case("Yomiuri", "gallery", seeds=("https://www.yomiuri.co.jp/",)),
    Case("Sankei", "gallery", seeds=("https://www.sankei.com/",)),
    Case("Tokyo Shimbun", "gallery", seeds=("https://www.tokyo-np.co.jp/",)),
    Case("Kyodo", "gallery", seeds=("https://www.kyodo.co.jp/",)),
    Case("47News", "gallery", seeds=("https://www.47news.jp/",)),
    Case("Jiji", "gallery", seeds=("https://www.jiji.com/",)),
    Case("ITmedia", "gallery", seeds=("https://www.itmedia.co.jp/",)),
    Case("Impress / Watch", "gallery", seeds=("https://www.watch.impress.co.jp/", "https://www.impress.co.jp/")),
    Case("Mynavi News", "gallery", seeds=("https://news.mynavi.jp/",)),
    Case("ASCII", "gallery", seeds=("https://ascii.jp/",)),
    Case("Gigazine", "gallery", seeds=("https://gigazine.net/",)),
]


def fetch_text(url: str, timeout: int = 15) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "ja-JP,ja;q=0.9,en-US;q=0.6,en;q=0.5"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = resp.read(1_500_000)
        if body[:2] == b"\x1f\x8b" or (resp.headers.get("Content-Encoding") or "").lower() == "gzip":
            body = gzip.decompress(body)
        enc = resp.headers.get_content_charset() or "utf-8"
        return body.decode(enc, errors="replace")


def discover(seed: str, limit: int) -> list[str]:
    try:
        html = fetch_text(seed)
    except Exception:
        return []
    base = urllib.parse.urlparse(seed)
    base_site = ".".join(base.netloc.lower().split(".")[-2:])
    found: list[str] = []
    for raw in re.findall(r'''href=["']([^"'#]+)["']''', html, re.I):
        url = urllib.parse.urljoin(seed, raw)
        parsed = urllib.parse.urlparse(url)
        if parsed.scheme not in ("http", "https"):
            continue
        decoded_path = urllib.parse.unquote(parsed.path)
        if re.search(r"\.(?:css|js|ico|svg|woff2?|ttf|map|json|xml|rss|jpe?g|png|gif|webp|avif)(?:$|[?#])", decoded_path, re.I):
            continue
        if re.search(r"/(?:resizer|static|common|assets|images?)/", decoded_path, re.I):
            continue
        parsed_site = ".".join(parsed.netloc.lower().split(".")[-2:])
        same_host = parsed.netloc == base.netloc or parsed.netloc.endswith("." + base.netloc)
        same_site = base_site in {"naver.com", "naver.jp"} and parsed_site == base_site
        if parsed.netloc and not same_host and not same_site:
            continue
        path = parsed.path
        if not re.search(r"(?:news|article|articles|photo|entertain|sports|watch|column|post|entry|item|[0-9]{4}|[0-9]{6,})", path, re.I):
            continue
        clean = urllib.parse.urlunparse((parsed.scheme, parsed.netloc, path, "", parsed.query, ""))
        if clean not in found:
            found.append(clean)
        if len(found) >= limit:
            break
    return found


def shape(info: dict[str, Any]) -> dict[str, Any]:
    if info.get("_type") == "playlist" and info.get("entries"):
        out = _to_gallery_response(info)
        out["title"] = info.get("title")
        return out
    out = _to_response(info)
    out["title"] = info.get("title")
    return out


def first_media(response: dict[str, Any]) -> tuple[str | None, dict[str, str], str]:
    if response.get("kind") == "gallery":
        for item in response.get("items") or []:
            url = item.get("url") or item.get("videoUrl")
            if url:
                return url, item.get("headers") or {}, item.get("kind") or "gallery-item"
        return None, {}, "gallery"
    if response.get("kind") == "paired":
        return response.get("videoUrl"), response.get("headers") or {}, "paired-video"
    return response.get("url"), response.get("headers") or {}, str(response.get("kind") or "unknown")


def thumbnail_like(url: str) -> bool:
    if THUMBNAIL_RE.search(url):
        return True
    parsed = urllib.parse.urlparse(url)
    qs = urllib.parse.parse_qs(parsed.query)
    dims = []
    for key in ("width", "w", "height", "h"):
        if key not in qs:
            continue
        value = (qs.get(key) or [""])[-1]
        if str(value).isdigit() and int(value) > 0:
            dims.append(int(value))
    return bool(dims and max(dims) <= 512)


def probe(url: str, headers: dict[str, str]) -> dict[str, Any]:
    if not url or url.startswith("/"):
        return {"ok": True, "skipped": "backend-relative URL"}
    if "ytdl-stream" in url:
        return {"ok": True, "skipped": "backend stream endpoint"}
    req_headers = {"User-Agent": headers.get("User-Agent") or headers.get("user-agent") or UA, "Accept": "*/*"}
    for key in ("Referer", "Origin", "Cookie"):
        if headers.get(key):
            req_headers[key] = headers[key]
    req = urllib.request.Request(url, headers=req_headers)
    with patched_dns_fallback(url):
        with urllib.request.urlopen(req, timeout=25) as resp:
            chunk = resp.read(2048)
            ctype = resp.headers.get("Content-Type", "")
            return {
                "ok": bool(chunk),
                "status": getattr(resp, "status", None),
                "content_type": ctype,
                "content_length": resp.headers.get("Content-Length"),
                "bytes": len(chunk),
            }


def resolve_host_via_google(host: str) -> list[str]:
    cached = DNS_FALLBACK_CACHE.get(host)
    if cached:
        return cached
    query = urllib.parse.urlencode({"name": host, "type": "A"})
    req = urllib.request.Request(
        f"https://dns.google/resolve?{query}",
        headers={"User-Agent": UA, "Accept": "application/dns-json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=6) as resp:
            data = json.loads(resp.read().decode("utf-8", errors="replace"))
    except Exception:
        return []
    addrs = [
        str(item.get("data"))
        for item in data.get("Answer") or []
        if item.get("type") == 1 and item.get("data")
    ]
    DNS_FALLBACK_CACHE[host] = addrs
    return addrs


@contextlib.contextmanager
def patched_dns_fallback(url: str):
    host = (urllib.parse.urlsplit(url).hostname or "").lower()
    if host not in DNS_FALLBACK_HOSTS:
        yield
        return
    original = socket.getaddrinfo

    def getaddrinfo(name, port, family=0, type=0, proto=0, flags=0):  # noqa: A002
        try:
            return original(name, port, family, type, proto, flags)
        except socket.gaierror:
            if str(name).lower() != host:
                raise
            answers = resolve_host_via_google(host)
            if not answers:
                raise
            return [
                (socket.AF_INET, type or socket.SOCK_STREAM, proto or socket.IPPROTO_TCP, "", (addr, port))
                for addr in answers
            ]

    socket.getaddrinfo = getaddrinfo
    try:
        yield
    finally:
        socket.getaddrinfo = original


def test_url(case: Case, url: str) -> dict[str, Any]:
    started = time.time()
    with contextlib.redirect_stdout(io.StringIO()):
        lowered = url.lower()
        if case.kind == "auto":
            info = run_extraction(url)
        elif "mdpr.jp" in lowered or "modelpress.jp" in lowered:
            info = extractors.extract_modelpress(url, None)
        elif "blog.naver.com" in lowered:
            info = extractors.extract_naver_blog(url, None)
        elif case.kind == "gallery":
            info = extractors.extract_curated_site(url, None)
        else:
            info = run_extraction(url)
    if not info:
        raise RuntimeError("no extraction result")
    response = shape(info)
    media_url, headers, media_kind = first_media(response)
    if not media_url:
        raise RuntimeError("no media URL in extraction result")
    if thumbnail_like(media_url):
        raise RuntimeError(f"thumbnail-like media selected: {media_url}")
    pr = probe(media_url, headers)
    if not pr.get("ok"):
        raise RuntimeError(f"probe failed: {pr}")
    return {
        "url": url,
        "status": "pass",
        "kind": response.get("kind"),
        "media_kind": media_kind,
        "count": len(response.get("items") or []) if response.get("kind") == "gallery" else 1,
        "media_url": media_url,
        "probe": pr,
        "elapsed_ms": int((time.time() - started) * 1000),
    }


def run_case(case: Case) -> dict[str, Any]:
    urls = list(case.urls)
    for seed in case.seeds:
        urls.extend(discover(seed, case.max_candidates))
    seen: set[str] = set()
    attempts: list[dict[str, Any]] = []
    for url in urls:
        if url in seen:
            continue
        seen.add(url)
        try:
            result = test_url(case, url)
            return {"name": case.name, "status": "pass", "note": case.note, **result}
        except Exception as exc:  # noqa: BLE001
            attempts.append({"url": url, "error": str(exc)[:240]})
    status = "expected-blocked" if case.expected == "blocked" else "fail"
    return {"name": case.name, "status": status, "note": case.note, "attempts": attempts[:5]}


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify real media extraction for supported websites.")
    parser.add_argument("--filter", help="case name regex to run a subset", default=None)
    parser.add_argument(
        "--report",
        default=str(ROOT / "artifacts" / "supported-websites-full-report.json"),
        help="where to write the JSON report",
    )
    args = parser.parse_args()

    cases = VIDEO_CASES + GALLERY_CASES
    if args.filter:
        pattern = re.compile(args.filter, re.I)
        cases = [case for case in cases if pattern.search(case.name)]

    results = [run_case(case) for case in cases]
    report = {
        "total": len(results),
        "pass": sum(1 for r in results if r["status"] == "pass"),
        "fail": [r for r in results if r["status"] == "fail"],
        "expected_blocked": [r for r in results if r["status"] == "expected-blocked"],
        "results": results,
    }
    report_path = Path(args.report)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 1 if report["fail"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
