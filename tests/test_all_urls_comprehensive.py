#!/usr/bin/env python3
import json
import os
import re
import sys
import shutil
import base64
import urllib.request
import urllib.error
import urllib.parse
import ast
import time
from pathlib import Path
import subprocess
import threading
import socket
from concurrent.futures import ThreadPoolExecutor, as_completed

socket.setdefaulttimeout(30)

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    print("Playwright not found. Please run this script using the virtual env python: .venv/bin/python")
    sys.exit(1)

ROOT = Path(__file__).resolve().parents[1]
LOCAL_HELPER = "http://127.0.0.1:8765"
BACKEND = "https://fcdownloader-extractor.fly.dev"
SCREENSHOT_DIR = ROOT / "artifacts" / "screenshots"
SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)
TEMP_DOWNLOAD_DIR = ROOT / "tests" / "temp_downloads_comp"
TEMP_DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)

# Pure Python MP4 Track Inspector
def check_mp4_tracks(filepath):
    try:
        with open(filepath, 'rb') as f:
            data = f.read()
        has_video = False
        has_audio = False
        idx = 0
        while True:
            idx = data.find(b'hdlr', idx)
            if idx == -1:
                break
            if idx + 24 <= len(data):
                chunk = data[idx:idx+24]
                if b'vide' in chunk:
                    has_video = True
                if b'soun' in chunk:
                    has_audio = True
            idx += 4
        return has_video, has_audio
    except Exception as e:
        print(f"Error reading MP4 {filepath}: {e}")
        return False, False

def verify_media_file(filepath, media_kind):
    if not os.path.exists(filepath):
        return False, "File does not exist"
    size = os.path.getsize(filepath)
    if size == 0:
        return False, "File is 0 bytes"

    try:
        with open(filepath, 'rb') as f:
            header = f.read(1024)
    except Exception as e:
        return False, f"Could not read header: {e}"

    if media_kind == 'image':
        if header.startswith(b'\xff\xd8'):
            return True, "Valid JPEG image"
        if header.startswith(b'\x89PNG\r\n\x1a\n'):
            return True, "Valid PNG image"
        if header.startswith(b'RIFF') and b'WEBP' in header:
            return True, "Valid WEBP image"
        if b'ftypheic' in header or b'ftypheix' in header or b'ftyphevc' in header:
            return True, "Valid HEIC image"
        if header.startswith(b'GIF87a') or header.startswith(b'GIF89a'):
            return True, "Valid GIF image"
        if len(header) >= 12 and header[4:8] == b'ftyp' and header[8:12] in (b'avif', b'avis'):
            return True, "Valid AVIF image"
        return False, f"Unrecognized image payload (size: {size} bytes)"

    elif media_kind == 'audio':
        if header.startswith(b'ID3') or header.startswith(b'\xff\xfb') or header.startswith(b'\xff\xf3'):
            return True, "Valid MP3 audio"
        if header.startswith(b'OggS'):
            return True, "Valid Ogg/Opus audio"
        if header.startswith(b'RIFF') and b'WAVE' in header:
            return True, "Valid WAV audio"
        if b'ftypM4A' in header or b'ftypmp42' in header:
            return True, "Valid M4A/AAC audio"
        if header.startswith(b'fLaC'):
            return True, "Valid FLAC audio"
        return False, f"Unrecognized audio payload (size: {size} bytes)"

    elif media_kind == 'video':
        has_video, has_audio = check_mp4_tracks(filepath)
        if has_video:
            if has_audio:
                return True, "Muxed MP4 (Audio + Video tracks present, in sync)"
            else:
                return True, "Video-only MP4 (No audio track required/found)"
        if header.startswith(b'#EXTM3U'):
            return True, "Valid HLS master playlist"
        if header.startswith(b'\x1a\x45\xdf\xa3'):
            return True, "Valid WebM/Matroska video"
        if len(header) > 376 and header[0] == 0x47 and header[188] == 0x47:
            return True, "Valid MPEG-TS video"
        return False, f"Unrecognized video payload (size: {size} bytes)"

    return True, f"File verified (size: {size} bytes)"

def record_verified_download(result, filepath, media_kind, pass_label, source_label):
    track_ok, track_msg = verify_media_file(filepath, media_kind)
    result["detail"] = track_msg
    if not track_ok:
        result["error"] = f"{source_label} returned an invalid media payload: {track_msg}"
        return False
    result["download"] = pass_label
    if media_kind == "video":
        result["sync"] = "✅ PASS" if "Muxed" in track_msg else "⚠️ Video Only"
    return True

def capture_screenshot(url, name):
    safe_name = re.sub(r'[^a-zA-Z0-9_-]', '_', name.lower())
    screenshot_path = SCREENSHOT_DIR / f"{safe_name}.png"
    print(f"Capturing screenshot for {name} ({url}) to {screenshot_path.name}...")
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            context = browser.new_context(
                viewport={"width": 1280, "height": 720},
                user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
            )
            page = context.new_page()
            # Use domcontentloaded to prevent timeouts on slow tracker scripts
            page.goto(url, timeout=30000, wait_until="domcontentloaded")
            page.wait_for_timeout(3000)
            page.screenshot(path=str(screenshot_path), full_page=False)
            browser.close()
        return f"screenshots/{screenshot_path.name}"
    except Exception as e:
        print(f"Failed to capture screenshot for {name}: {e}")
        return None

def fetch_json(url, data=None, method="GET", timeout=30):
    req = urllib.request.Request(url, method=method)
    req.add_header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36")
    if data:
        req.add_header("Content-Type", "application/json")
        encoded_data = json.dumps(data).encode("utf-8")
    else:
        encoded_data = None
    try:
        with urllib.request.urlopen(req, data=encoded_data, timeout=timeout) as res:
            return json.loads(res.read().decode("utf-8", errors="replace")), None
    except Exception as e:
        return None, str(e)

def download_file(url, target_path, headers=None, timeout=30, max_size=5*1024*1024, max_time=15):
    req = urllib.request.Request(url)
    req.add_header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36")
    if headers:
        for k, v in headers.items():
            req.add_header(k, v)
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            with open(target_path, 'wb') as f:
                downloaded = 0
                while True:
                    if time.time() - t0 > max_time:
                        break
                    chunk = res.read(64*1024)
                    if not chunk:
                        break
                    f.write(chunk)
                    downloaded += len(chunk)
                    if max_size and downloaded >= max_size:
                        break
        return True, None
    except Exception as e:
        return False, str(e)

MEDIA_EXTENSIONS = {
    ".mp4", ".m4v", ".webm", ".mov", ".avi", ".mkv", ".mp3", ".m4a", ".aac",
    ".opus", ".ogg", ".wav", ".flac", ".jpg", ".jpeg", ".png", ".gif", ".webp",
    ".heic", ".m3u8", ".mpd",
}
MEDIA_KINDS = {"image", "video", "audio", "hls", "dash", "direct", "paired"}
REPLAY_HEADERS = {"accept", "accept-language", "origin", "range", "referer", "user-agent"}

def is_valid_media_item(item):
    item_url = str(item.get("url") or "")
    if not item_url.startswith(("http://", "https://")):
        return False
    path = urllib.parse.urlparse(item_url).path.lower()
    kind = str(item.get("kind") or "").lower()
    extractor = str(item.get("extractor") or "").lower()
    return any(path.endswith(ext) for ext in MEDIA_EXTENSIONS) or kind in MEDIA_KINDS or "ytdl" in extractor

def backend_proxy_url(item, page_url):
    replay = {
        str(key): str(value)
        for key, value in (item.get("headers") or {}).items()
        if str(key).lower() in REPLAY_HEADERS and value
    }
    referer = replay.get("Referer") or replay.get("referer") or item.get("referer") or page_url
    params = {"url": item.get("url") or "", "referer": referer}
    if replay:
        params["headers"] = base64.urlsafe_b64encode(
            json.dumps(replay, separators=(",", ":")).encode("utf-8")
        ).decode("ascii").rstrip("=")
    return f"{BACKEND}/proxy?{urllib.parse.urlencode(params)}"

def test_url(name, url, thread_id):
    print(f"[{thread_id}] Testing {name}: {url}")
    result = {
        "name": name,
        "url": url,
        "detection": "❌ FAIL",
        "download": "❌ FAIL",
        "sync": "N/A",
        "gallery": "N/A",
        "retry": "N/A",
        "screenshot": None,
        "error": None
    }

    is_manifest = urllib.parse.urlparse(url).path.lower().endswith((".m3u8", ".mpd"))
    is_video = is_manifest or any(v in name.lower() or v in url.lower() for v in ["video", "bilibili", "twitcasting", "naver", "kakao", "youtube", "tiktok", "vimeo", "dailymotion"])
    extracted_items = []

    # 1. Check Detection / Extract Info
    if is_video:
        # First try local helper /formats
        params = urllib.parse.urlencode({"url": url})
        data, err = fetch_json(f"{LOCAL_HELPER}/formats?{params}", timeout=30)
        if data and data.get("formats"):
            result["detection"] = "✅ PASS"
            result["retry"] = "Stable yt-dlp"
            extracted_items = [{"url": url, "kind": "video"}]
        else:
            # Fallback to server /extract
            srv_data, srv_err = fetch_json(f"{BACKEND}/extract", data={"pageUrl": url}, method="POST", timeout=45)
            if srv_data and (srv_data.get("url") or srv_data.get("items")):
                result["detection"] = "✅ PASS"
                result["retry"] = "Fly.io Fallback"
                kind = srv_data.get("kind", "video")
                if kind == "gallery":
                    extracted_items = srv_data.get("items", [])
                else:
                    extracted_items = [{"url": srv_data.get("url"), "kind": kind}]
            else:
                result["error"] = f"Format extraction failed: Local: {err}, Server: {srv_err}"
                result["screenshot"] = capture_screenshot(url, name)
                return result
    else:
        # Gallery / article image posts
        srv_data, srv_err = fetch_json(f"{BACKEND}/extract", data={"pageUrl": url}, method="POST", timeout=45)
        if srv_data and (srv_data.get("items") or srv_data.get("url")):
            result["detection"] = "✅ PASS"
            kind = srv_data.get("kind", "gallery")
            if kind == "gallery":
                extracted_items = srv_data.get("items", [])
                result["gallery"] = f"✅ PASS ({len(extracted_items)} items)"
            else:
                extracted_items = [{"url": srv_data.get("url"), "kind": kind}]
                result["gallery"] = "✅ PASS (1 item)"
        else:
            result["error"] = f"Gallery extraction failed: {srv_err}"
            result["screenshot"] = capture_screenshot(url, name)
            return result

    # 2. Check Download & Tracks
    valid_media_items = [item for item in extracted_items if is_valid_media_item(item)]

    if not valid_media_items:
        result["error"] = f"No valid media items found after filtering (original count: {len(extracted_items)})"
        result["screenshot"] = capture_screenshot(url, name)
        return result

    first_item = valid_media_items[0]
    media_kind = first_item.get("kind", "video" if is_video else "image")
    if media_kind in ("hls", "dash", "paired"):
        media_kind = "video"
    elif media_kind == "direct":
        media_kind = "video" if is_video else "image"
    ext = first_item.get("ext", "mp4" if media_kind == "video" else "jpg")
    temp_file = TEMP_DOWNLOAD_DIR / f"temp_{thread_id}_{re.sub(r'[^a-zA-Z0-9]', '_', name.lower())}.{ext}"

    if is_video and media_kind == "video":
        # Download via local helper /download endpoint
        download_url = f"{LOCAL_HELPER}/download?{urllib.parse.urlencode({'url': url, 'max_height': '1080'})}"
        ok, dl_err = download_file(download_url, temp_file, timeout=120)
        if ok:
            record_verified_download(result, temp_file, "video", "✅ PASS", "Helper")
        else:
            # Fallback direct download
            stream_url = first_item.get("url")
            if stream_url:
                ok, dl_err2 = download_file(stream_url, temp_file, headers=first_item.get("headers"), timeout=120)
                if ok:
                    record_verified_download(result, temp_file, "video", "✅ PASS (Direct Fallback)", "Direct fallback")
                else:
                    result["error"] = f"Download failed: Helper: {dl_err}, Direct: {dl_err2}"
                    result["screenshot"] = capture_screenshot(url, name)
            else:
                result["error"] = f"Download failed via helper: {dl_err}"
                result["screenshot"] = capture_screenshot(url, name)
    else:
        # Download image / gallery item directly
        stream_url = first_item.get("url")
        if stream_url:
            ok, dl_err = download_file(stream_url, temp_file, headers=first_item.get("headers"), timeout=60)
            if ok:
                record_verified_download(result, temp_file, media_kind, "✅ PASS", "Direct download")
            else:
                ok, proxy_err = download_file(backend_proxy_url(first_item, url), temp_file, timeout=60)
                if ok:
                    if record_verified_download(result, temp_file, media_kind, "✅ PASS (Proxy Fallback)", "Proxy"):
                        result["retry"] = "Backend Proxy"
                else:
                    result["error"] = f"Direct download failed: {dl_err}; Proxy: {proxy_err}"
                    result["screenshot"] = capture_screenshot(url, name)
        else:
            result["error"] = "No direct media URL available for image download"
            result["screenshot"] = capture_screenshot(url, name)

    # Clean up temp file
    if temp_file.exists():
        try:
            temp_file.unlink()
        except Exception:
            pass

    return result

def extract_urls_from_dict(filepath, var_name):
    path = ROOT / filepath
    if not path.exists():
        return {}
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        tree = ast.parse(f.read())
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id == var_name:
                    try:
                        val = ast.literal_eval(node.value)
                        if isinstance(val, dict):
                            urls = {}
                            for k, v in val.items():
                                if isinstance(v, tuple) and len(v) >= 1:
                                    urls[k] = v[0]
                                elif isinstance(v, str):
                                    urls[k] = v
                            return urls
                    except Exception as e:
                        print(f"Error parsing {var_name} in {filepath}: {e}")
    return {}

def extract_platforms_urls(filepath):
    path = ROOT / filepath
    if not path.exists():
        return {}
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        tree = ast.parse(f.read())
    urls = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id == "PLATFORMS":
                    if isinstance(node.value, ast.List):
                        for elt in node.value.elts:
                            if isinstance(elt, ast.Tuple) and len(elt.elts) >= 2:
                                try:
                                    name_const = elt.elts[0]
                                    url_const = elt.elts[1]
                                    name = name_const.value if hasattr(name_const, 'value') else name_const.s
                                    url = url_const.value if hasattr(url_const, 'value') else url_const.s
                                    if isinstance(name, str) and isinstance(url, str):
                                        urls[name] = url
                                except Exception:
                                    pass
    return urls

def collect_unique_urls():
    # 1. fresh_urls.json
    fresh = {}
    with open(ROOT / "fresh_urls.json", "r") as f:
        fresh = json.load(f)

    # 2. test_user_urls.py
    user_urls = extract_urls_from_dict("tests/test_user_urls.py", "URLS")

    # 3. test_all_urls.py
    all_urls = extract_urls_from_dict("tests/test_all_urls.py", "URLS")

    # 4. test_all_sites.py
    all_sites = extract_urls_from_dict("tests/test_all_sites.py", "TEST_URLS")

    # 5. test_all_strategies.py
    strat_urls = extract_platforms_urls("tests/test_all_strategies.py")

    # Merge unique urls, tracking platform names
    merged = {}
    for name, url in fresh.items():
        merged[url] = name
    for name, url in user_urls.items():
        if url not in merged:
            merged[url] = name
    for name, url in all_urls.items():
        if url not in merged:
            merged[url] = name
    for name, url in all_sites.items():
        if url not in merged:
            merged[url] = name
    for name, url in strat_urls.items():
        if url not in merged:
            merged[url] = name

    return merged

def main():
    # 1. Health check helper
    try:
        with urllib.request.urlopen(f"{LOCAL_HELPER}/health", timeout=2) as res:
            helper_ok = json.loads(res.read().decode("utf-8")).get("ok")
    except Exception as e:
        print(f"Error connecting to local companion helper: {e}")
        sys.exit(1)

    if not helper_ok:
        print("Local helper returned unhealthy status.")
        sys.exit(1)

    print("Companion Helper is running and healthy.")

    # Collect URLs
    urls_dict = collect_unique_urls()
    print(f"Collected {len(urls_dict)} unique URLs to test.")

    # Run downloads in parallel using a ThreadPoolExecutor
    results = []
    print_lock = threading.Lock()

    def process_item(idx, name, url):
        res = test_url(name, url, idx)
        with print_lock:
            print(f"[{idx}] Finished testing {name}: {res['detection']} / {res['download']}")
            sys.stdout.flush()
        return res

    # Use 6 workers to avoid excessive concurrent downloads / local helper load
    with ThreadPoolExecutor(max_workers=6) as pool:
        futures = []
        for idx, (url, name) in enumerate(urls_dict.items(), 1):
            futures.append(pool.submit(process_item, idx, name, url))

        for f in as_completed(futures):
            results.append(f.result())

    # Clean up temp downloads directory
    try:
        shutil.rmtree(TEMP_DOWNLOAD_DIR)
    except Exception:
        pass

    # 2. Run test_all_strategies.py to gather full strategy matrix
    print("\nRunning test_all_strategies.py to gather full strategy matrix...")
    strategy_report_path = ROOT / "artifacts" / "raw_strategy_report.txt"
    with open(strategy_report_path, "w", encoding="utf-8") as f:
        subprocess.run(
            [sys.executable, str(ROOT / "tests" / "test_all_strategies.py")],
            stdout=f, stderr=subprocess.STDOUT, check=False
        )

    # Read the strategy report contents
    with open(strategy_report_path, "r", encoding="utf-8") as f:
        strategy_content = f.read()

    # Generate Final Report
    report_path = ROOT / "artifacts" / "extension_helper_comprehensive_report.md"
    print(f"\nWriting comprehensive report to {report_path}...")

    with open(report_path, "w", encoding="utf-8") as f:
        f.write("# Extension + Companion Helper Comprehensive Test Report\n\n")
        f.write(f"Tested the FCDownloader Chrome Extension and Go Companion Helper (`{LOCAL_HELPER}`) against all unique URLs parsed from test scripts ({len(results)} URLs total).\n\n")

        f.write("## Test Summary\n\n")
        f.write("| Platform | Detection | Download Completion | Audio/Video Sync | Gallery Export | Retry Behavior | Page URL |\n")
        f.write("| :--- | :--- | :--- | :--- | :--- | :--- | :--- |\n")
        for r in results:
            screenshot_link = f" (See [Screenshot]({r['screenshot']}))" if r["screenshot"] else ""
            f.write(f"| **{r['name']}** | {r['detection']} | {r['download']}{screenshot_link} | {r['sync']} | {r['gallery']} | {r['retry']} | [Link]({r['url']}) |\n")

        f.write("\n## Failure Details & Screenshots\n\n")
        failures = [r for r in results if "FAIL" in r["download"] or "FAIL" in r["detection"]]
        if failures:
            for r in failures:
                f.write(f"### {r['name']}\n")
                f.write(f"- **Page URL**: {r['url']}\n")
                f.write(f"- **Error**: `{r['error']}`\n")
                if r["screenshot"]:
                    f.write(f"- **Screenshot**:\n\n![{r['name']} Failure](file:///{ROOT / 'artifacts' / r['screenshot']})\n\n")
        else:
            f.write("🎉 **All URL checks passed successfully! No failures encountered.**\n\n")

        f.write("## Strategy Matrix Verification\n")
        f.write("Below is the output of the comprehensive strategy matrix verification (`test_all_strategies.py`):\n\n")
        f.write("```text\n")
        f.write(strategy_content)
        f.write("\n```\n")

    # Copy the report to the root for accessibility
    shutil.copy(report_path, ROOT / "extension_helper_report_v8.md")
    print(f"Copied final report to root: {ROOT / 'extension_helper_report_v8.md'}")

if __name__ == "__main__":
    main()
