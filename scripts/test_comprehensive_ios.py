#!/usr/bin/env python3
import json
import hashlib
import os
import re
import sys
import subprocess
import shutil
import time
from datetime import datetime, timezone
from urllib.parse import urlencode, urlsplit, urlunsplit, unquote
from pathlib import Path

# Add root to path
ROOT = Path(__file__).resolve().parents[1]
sys.path.append(str(ROOT))
from scripts.url_catalog import all_urls

SIM_UDID = "91DD8048-BB9A-42E8-8790-90D809267A88"
PHONE_UDID = "00008110-001151CC0CF3801E"
BUNDLE_ID = "com.otterpia.fcdownloader"
TASKS_STORAGE_KEY = "@fcdownloader/tasks_v1"

# Define expected media kinds for each platform/URL in the catalog
EXPECTED_MEDIA_TYPES = {
    "YouTube": "video",
    "YouTube-zoo": "video",
    "TikTok": "image",  # TikTok sample URL is photo/gallery post
    "TikTok-NASA": "video",
    "Instagram": "video",
    "Threads": "image",
    "Twitter/X": "video",
    "Bluesky": "image",
    "Mastodon": "image",
    "Tumblr": "image",
    "Facebook": "video",
    "Reddit": "video",
    "Pinterest": "video",
    "Vimeo": "video",
    "Dailymotion": "video",
    "Direct MP4": "video",
    "Direct image": "image",
    "Direct audio": "audio",
    "HLS manifest": "video",
    "DASH manifest": "video",
    "Bilibili": "video",
    "Bilibili-large": "video",
    "Bilibili dynamic / opus": "image",
    "Weibo": "video",
    "Xiaohongshu": "image",
    "Douyin": "video",
    "NicoNico": "video",
    "TVer": "video",
    "ABEMA": "video",
    "NHK": "video",
    "TwitCasting": "video",
    "FC2 Video": "video",
    "FC2 Live": "video",
    "Naver TV": "video",
    "Kakao TV": "video",
    "DMM": "image",
    "Lemino": "video",
    "U-NEXT": "video",
    "Hulu Japan": "video",
    "TELASA": "video",
    "NHK Plus": "video",
    "NHK On Demand": "video",
    "WOWOW On Demand": "video",
    "d Anime Store": "video",
    "Bandai Channel": "video",
    "Rakuten TV Japan": "video",
    "J SPORTS On Demand": "video",
    "SPOOX": "video",
    "Locipo": "video",
    "MBS Dougaizm": "video",
    "ytv MyDo": "video",
    "TV Tokyo video": "video",
    "TV Asahi Douga": "video",
    "KTV Smart": "video",
    "Oricon": "image",
    "Modelpress": "image",
    "TRILL": "image",
    "Natalie": "image",
    "Naver Blog": "image",
    "Naver News": "image",
    "Naver Entertainment": "image",
    "Naver Sports": "image",
    "note.com": "image",
    "Hatena Blog": "image",
    "FC2 Blog": "image",
    "Gyazo": "image",
    "Ameblo": "image",
    "Kstyle": "image",
    "Daum / Tistory": "image",
    "Livedoor Blog": "image",
    "Yahoo Japan articles": "image",
    "Pixiv / Fanbox": "image",
    "Bunshun": "image",
    "Daily Shincho": "image",
    "News Post Seven / Josei Seven": "image",
    "FRIDAY": "image",
    "Gendai Media": "image",
    "With": "image",
    "ViVi": "image",
    "CanCam": "image",
    "CLASSY": "image",
    "JJ": "image",
    "Ginger": "image",
    "ar": "image",
    "bis": "image",
    "Ray": "image",
    "HP+ non-no": "image",
    "HP+ SPUR": "image",
    "HP+ MAQUIA": "image",
    "HP+ LEE": "image",
    "HP+ BAILA": "image",
    "ananweb": "image",
    "Croissant Online": "image",
    "FRaU": "image",
    "mi-mollet": "image",
    "Fashion Press": "image",
    "Fashionsnap": "image",
    "WWD Japan": "image",
    "thetv.jp": "image",
    "Mantan Web": "image",
    "Crank In": "image",
    "CinemaToday": "image",
    "eiga.com": "image",
    "Real Sound": "image",
    "Spice": "image",
    "JPrime": "image",
    "Smart Flash": "image",
    "Nikkan Gendai": "image",
    "Asagei": "image",
    "Entame Next": "image",
    "GirlsNews": "image",
    "Girlswalker": "image",
    "Tokyo Sports": "image",
    "Hochi": "image",
    "Sponichi": "image",
    "Nikkan Sports": "image",
    "Sanspo": "image",
    "Mainichi": "image",
    "Asahi": "image",
    "Yomiuri": "image",
    "Sankei": "image",
    "Tokyo Shimbun": "image",
    "Kyodo": "image",
    "47News": "image",
    "Jiji": "image",
    "ITmedia": "image",
    "Impress / Watch": "image",
    "Mynavi News": "image",
    "ASCII": "image",
    "Gigazine": "image"
}

def check_mp4_tracks(filepath):
    """Pure Python MP4 track inspector. Returns (has_video, has_audio)."""
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

def probe_av_tracks(filepath):
    """Return ffprobe-confirmed stream presence when ffprobe is available."""
    ffprobe = shutil.which('ffprobe')
    if not ffprobe:
        return None
    try:
        proc = subprocess.run(
            [ffprobe, '-v', 'error', '-show_entries', 'stream=codec_type',
             '-of', 'default=noprint_wrappers=1:nokey=1', filepath],
            capture_output=True, text=True, timeout=30, check=False,
        )
        if proc.returncode != 0:
            return None
        streams = {line.strip() for line in proc.stdout.splitlines()}
        return ('video' in streams, 'audio' in streams)
    except Exception:
        return None

EXPECTED_LIMIT_MARKERS = (
    'AUTH/', 'AGE-GATED', 'CURRENT-EPISODE', 'DNS', 'LOGIN-GATED',
    'SERVER IP', 'GEO-LOCKED', 'GEO-SENSITIVE', 'DRM', 'OFFLINE',
    'STALE SAMPLE', 'SUBSCRIPTION-GATED', 'BROWSER-ONLY',
)

def is_expected_limited(note):
    upper = (note or '').upper()
    return any(marker in upper for marker in EXPECTED_LIMIT_MARKERS)

def is_manual_selection(note):
    return 'MANUAL-SELECTION' in (note or '').upper()

def normalize_page_url(value):
    raw = (value or '').strip()
    try:
        parsed = urlsplit(raw)
        # Linking.parse decodes percent-encoded path components before the URL
        # reaches app state. Normalize catalog and task URLs to the same form.
        path = unquote(parsed.path).rstrip('/') or '/'
        scheme = parsed.scheme.lower()
        host = parsed.netloc.lower()
        return urlunsplit((scheme, host, path, parsed.query, ''))
    except Exception:
        return unquote(raw).rstrip('/')

def verify_media_file(filepath, expected_kind):
    if not os.path.exists(filepath):
        return False, "File does not exist on disk"
    size = os.path.getsize(filepath)
    if size == 0:
        return False, "File is 0 bytes"

    # Read headers
    try:
        with open(filepath, 'rb') as f:
            header = f.read(1024)
    except Exception as e:
        return False, f"Could not read header: {e}"

    # Verify if file header matches expectations
    is_jpeg = header.startswith(b'\xff\xd8')
    is_png = header.startswith(b'\x89PNG\r\n\x1a\n')
    is_webp = header.startswith(b'RIFF') and b'WEBP' in header
    is_heic = b'ftypheic' in header or b'ftypheix' in header or b'ftyphevc' in header
    is_gif = header.startswith(b'GIF87a') or header.startswith(b'GIF89a')

    is_image = is_jpeg or is_png or is_webp or is_heic or is_gif

    if expected_kind == 'image':
        if not is_image:
            return False, "Expected image, but file does not match image headers"
        if is_jpeg: return True, "Valid JPEG image"
        if is_png: return True, "Valid PNG image"
        if is_webp: return True, "Valid WEBP image"
        if is_heic: return True, "Valid HEIC image"
        if is_gif: return True, "Valid GIF image"
        return True, "Image file verified"

    elif expected_kind == 'audio':
        if is_image:
            return False, "Expected audio, but file has image headers (thumbnail fallback)"
        is_mp3 = header.startswith(b'ID3') or header.startswith(b'\xff\xfb') or header.startswith(b'\xff\xf3')
        is_ogg = header.startswith(b'OggS')
        is_wav = header.startswith(b'RIFF') and b'WAVE' in header
        is_m4a = b'ftypM4A' in header or b'ftypmp42' in header
        if not (is_mp3 or is_ogg or is_wav or is_m4a):
            return False, "Expected audio, but file does not match audio headers"
        if is_mp3: return True, "Valid MP3 audio"
        if is_ogg: return True, "Valid Ogg/Opus audio"
        if is_wav: return True, "Valid WAV audio"
        if is_m4a: return True, "Valid M4A/AAC audio"
        return True, "Audio file verified"

    elif expected_kind == 'video':
        if is_image:
            return False, "Expected video, but file has image headers (thumbnail fallback)"

        # HLS segment downloads may intentionally remain MPEG-TS rather than
        # being remuxed to MP4. A transport stream starts with sync byte 0x47
        # and repeats it at 188-byte packet boundaries.
        is_mpeg_ts = (
            len(header) >= 377
            and header[0] == 0x47
            and header[188] == 0x47
            and header[376] == 0x47
        )
        if is_mpeg_ts:
            return True, "Valid MPEG-TS video"

        probed = probe_av_tracks(filepath)
        has_video, has_audio = probed if probed is not None else check_mp4_tracks(filepath)
        if has_video:
            if has_audio:
                return True, "Muxed MP4 (Audio + Video streams present)"
            else:
                return True, "Video-only MP4 (No audio stream found)"
        if header.startswith(b'#EXTM3U'):
            return False, "Expected downloaded video, but file is only an HLS manifest"
        return False, "Expected video, but no video stream could be verified"

    return True, "File verified"

def get_current_container():
    try:
        proc = subprocess.run(
            ['xcrun', 'simctl', 'get_app_container', SIM_UDID, BUNDLE_ID, 'data'],
            capture_output=True, text=True, check=True
        )
        return proc.stdout.strip()
    except Exception:
        # Fallback to search in library
        base = Path(f'/Users/imac/Library/Developer/CoreSimulator/Devices/{SIM_UDID}/data/Containers/Data/Application')
        candidates = sorted(base.glob(f'*/Library/Application Support/{BUNDLE_ID}/RCTAsyncLocalStorage_V1'), key=lambda p: p.stat().st_mtime, reverse=True)
        if candidates:
            return str(candidates[0].parents[3])
    return None

def get_tasks_db_file(db_dir):
    """Resolve the exact AsyncStorage file for the download-task key."""
    manifest_path = db_dir / 'manifest.json'
    try:
        manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(f"Could not read AsyncStorage manifest: {error}") from error

    if TASKS_STORAGE_KEY not in manifest:
        raise RuntimeError(f"AsyncStorage key {TASKS_STORAGE_KEY!r} was not found")
    if manifest[TASKS_STORAGE_KEY] is not None:
        raise RuntimeError("Task storage is inline in manifest.json; no pollable task file exists")

    filename = hashlib.md5(TASKS_STORAGE_KEY.encode('utf-8')).hexdigest()
    db_file = db_dir / filename
    if not db_file.is_file():
        raise RuntimeError(f"Task storage file is missing: {db_file}")
    return db_file

def read_tasks(db_file):
    with open(db_file, 'r', encoding='utf-8') as f:
        return json.load(f)

def task_status(tasks, task_id):
    for task in tasks:
        if task.get('id') == task_id:
            return task.get('status'), task
    return None, None

def exercise_retry(db_file, task, timeout_seconds=90):
    """Retry the same persisted task and verify that its state changes."""
    task_id = task.get('id')
    if not task_id:
        return "❌ FAIL (task has no ID)"

    previous_error = task.get('error')
    previous_completed_at = task.get('completedAt')
    previous_retry_count = task.get('retryCount', 0)
    deep_link = f"fcdownloader://retry?{urlencode({'taskId': task_id})}"
    proc = subprocess.run(
        ['xcrun', 'simctl', 'openurl', SIM_UDID, deep_link],
        capture_output=True, text=True, check=False,
    )
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "simctl openurl failed").strip()
        return f"❌ FAIL ({detail[:120]})"

    deadline = time.time() + timeout_seconds
    observed_transition = False
    last_status = task.get('status')
    while time.time() < deadline:
        time.sleep(1)
        try:
            current_tasks = read_tasks(db_file)
        except (OSError, json.JSONDecodeError):
            continue
        status, current = task_status(current_tasks, task_id)
        if current is None:
            continue
        last_status = status
        if (
            current.get('retryCount', 0) > previous_retry_count
            or status != 'failed'
            or current.get('error') != previous_error
            or current.get('completedAt') != previous_completed_at
        ):
            observed_transition = True
        if observed_transition and status in {'completed', 'failed', 'cancelled'}:
            return f"✅ PASS (same task transitioned; final status: {status})"

    if observed_transition:
        return f"✅ PASS (same task transitioned; status after timeout: {last_status})"
    return "❌ FAIL (same task never changed persisted state)"

def exercise_gallery_export(container_path, task_id, timeout_seconds=30):
    """Invoke the real Photos save path and verify its persisted result."""
    nonce = str(int(time.time() * 1000))
    result_path = Path(container_path) / 'Documents' / 'automation_gallery_result.json'
    try:
        result_path.unlink(missing_ok=True)
    except OSError:
        pass

    deep_link = f"fcdownloader://gallery_test?{urlencode({'taskId': task_id, 'nonce': nonce})}"
    proc = subprocess.run(
        ['xcrun', 'simctl', 'openurl', SIM_UDID, deep_link],
        capture_output=True, text=True, check=False,
    )
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "simctl openurl failed").strip()
        return f"❌ FAIL ({detail[:120]})"

    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        time.sleep(1)
        try:
            result = json.loads(result_path.read_text(encoding='utf-8'))
        except (OSError, json.JSONDecodeError):
            continue
        if result.get('nonce') != nonce:
            continue
        if result.get('success'):
            return "✅ PASS (saved through MediaLibrary)"
        return f"❌ FAIL ({str(result.get('error') or 'unknown error')[:120]})"
    return "❌ FAIL (no MediaLibrary result was persisted)"

def main():
    print("Reading AsyncStorage database from Simulator...")
    container_path = get_current_container()
    if not container_path:
        print("Error: Could not locate app container.")
        sys.exit(1)

    db_dir = Path(container_path) / 'Library' / 'Application Support' / BUNDLE_ID / 'RCTAsyncLocalStorage_V1'
    try:
        db_file = get_tasks_db_file(db_dir)
    except RuntimeError as error:
        print(f"Error: {error}")
        sys.exit(1)

    print(f"Reading tasks from: {db_file}")
    tasks = read_tasks(db_file)
    run_started_at_raw = os.environ.get('FCDL_RUN_STARTED_AT_MS')
    try:
        run_started_at = int(run_started_at_raw) if run_started_at_raw else None
    except ValueError:
        raise SystemExit("FCDL_RUN_STARTED_AT_MS must be an integer epoch timestamp in milliseconds")
    if run_started_at is not None:
        tasks = [task for task in tasks if task.get('createdAt', 0) >= run_started_at]

    # Group tasks by normalized pageUrl.
    url_tasks = {}
    for task in tasks:
        page_url = task.get('media', {}).get('pageUrl')
        if page_url:
            norm_url = normalize_page_url(page_url)
            url_tasks.setdefault(norm_url, []).append(task)

    catalog = all_urls()
    print(f"Total catalog size: {len(catalog)}")

    report_items = []
    failed_items = []

    current_container_id = Path(container_path).name

    for name, (url, note) in catalog.items():
        norm_url = normalize_page_url(url)
        matching = url_tasks.get(norm_url, [])
        if not matching:
            alt_urls = [
                norm_url + '/',
                norm_url.replace('https://', 'http://'),
                norm_url.replace('http://', 'https://'),
                normalize_page_url(url.strip())
            ]
            for alt in alt_urls:
                matching = url_tasks.get(normalize_page_url(alt), [])
                if matching:
                    break

        # Sort matching tasks by creation time descending (most recent first)
        matching = sorted(matching, key=lambda t: t.get('createdAt', 0), reverse=True)

        completed = [t for t in matching if t.get('status') == 'completed']
        failed = [t for t in matching if t.get('status') == 'failed']

        expected_kind = EXPECTED_MEDIA_TYPES.get(name, "video")
        expected_limited = is_expected_limited(note)
        manual_selection = is_manual_selection(note)

        detection = "✅ PASS" if matching else "❌ FAIL"
        download_status = "❌ FAIL"
        sync_status = "N/A"
        gallery_export = "Not exercised"
        retry_behavior = "Not exercised"
        detail = "No tasks found"

        # Check expected vs actual kind
        if completed:
            verified = []
            rejected = []
            for task in completed:
                local_path = task.get('localPlaylistPath', '')
                if local_path.startswith('file://'):
                    local_path = local_path[7:]
                corrected_path = re.sub(
                    r'/Application/[^/]+/',
                    f'/Application/{current_container_id}/',
                    local_path,
                )
                ok, msg = verify_media_file(corrected_path, expected_kind)
                if ok:
                    verified.append((task, corrected_path, msg))
                else:
                    rejected.append(msg)

            # Extraction can legitimately return a video plus poster/gallery
            # images. A platform passes when at least one completed task is the
            # requested media kind; the newest task is not necessarily primary.
            if verified:
                task, corrected_path, msg = verified[0]
                download_status = "✅ PASS"
                detail = (
                    f"Completed ({len(verified)} matching file(s), "
                    f"{len(rejected)} non-matching companion file(s))"
                )
                if expected_kind == 'video':
                    sync_status = f"✅ PASS ({msg})"
                else:
                    sync_status = f"N/A ({expected_kind.capitalize()})"
                gallery_export = (
                    "N/A (Audio)"
                    if expected_kind == 'audio'
                    else "Eligible (not exercised)"
                )
            else:
                msg = rejected[0] if rejected else "No completed file could be verified"
                download_status = "⚠️ KNOWN LIMIT" if expected_limited else "❌ FAIL"
                detail = f"Failed verification: {msg}"
                sync_status = f"N/A (source limitation: {msg})" if expected_limited else f"❌ FAIL ({msg})"
                gallery_export = "N/A" if expected_limited else "❌ FAIL"
                if not expected_limited:
                    failed_items.append((name, url, detail))
        elif failed:
            download_status = "⚠️ KNOWN LIMIT" if expected_limited else "❌ FAIL"
            detail = f"Failed: {failed[0].get('error')}"
            sync_status = "N/A (source limitation)" if expected_limited else "❌ FAIL (No file)"
            gallery_export = "N/A" if expected_limited else "❌ FAIL"
            if not expected_limited:
                failed_items.append((name, url, detail))
        else:
            if manual_selection:
                detection = "✅ PASS (Picker)"
                download_status = "⚠️ MANUAL PICKER"
            else:
                download_status = "⚠️ KNOWN LIMIT" if expected_limited else "❌ FAIL"
            detail = "No media detected"
            if expected_limited:
                detection = "⚠️ KNOWN LIMIT"
            elif not manual_selection:
                failed_items.append((name, url, "No media detected"))

        report_items.append({
            "name": name,
            "url": url,
            "expected_kind": expected_kind,
            "note": note,
            "detection": detection,
            "download": download_status,
            "sync": sync_status,
            "gallery": gallery_export,
            "retry": retry_behavior,
            "detail": detail,
            "verified_task_id": verified[0][0].get('id') if completed and verified else None,
        })

    # Switch simulator tab to Library and capture a screenshot.
    print("Navigating simulator to Library tab...")
    library_proc = subprocess.run(
        ['xcrun', 'simctl', 'openurl', SIM_UDID, 'fcdownloader://library'],
        capture_output=True, text=True, check=False,
    )
    time.sleep(2)

    screenshot_dir = ROOT / 'artifacts' / 'screenshots'
    screenshot_dir.mkdir(parents=True, exist_ok=True)
    screenshot_path = screenshot_dir / 'library_tab.png'
    print(f"Capturing simulator screenshot to {screenshot_path}...")
    screenshot_proc = subprocess.run(
        ['xcrun', 'simctl', 'io', SIM_UDID, 'screenshot', str(screenshot_path)],
        capture_output=True, text=True, check=False,
    )

    # Exercise the app's real retry path on one existing failed task. This
    # deliberately retries the same task ID rather than creating a new share.
    if os.environ.get('FCDL_EXERCISE_RETRY') == '1':
        retry_target = next(
            (
                (report, task)
                for report in report_items
                for task in sorted(
                    url_tasks.get(normalize_page_url(report['url']), []),
                    key=lambda value: value.get('createdAt', 0),
                    reverse=True,
                )
                if task.get('status') == 'failed'
            ),
            None,
        )
        if retry_target:
            target_report, target_task = retry_target
            print(f"\nExercising same-task retry for: {target_report['name']}")
            target_report['retry'] = exercise_retry(db_file, target_task)
        else:
            print("\nRetry requested, but no persisted failed task was available.")

    if os.environ.get('FCDL_EXERCISE_GALLERY') == '1':
        gallery_targets = []
        for media_kind in ('image', 'video'):
            target = next(
                (
                    report
                    for report in report_items
                    if report['download'] == "✅ PASS"
                    and report['expected_kind'] == media_kind
                    and report.get('verified_task_id')
                ),
                None,
            )
            if target:
                gallery_targets.append(target)

        if gallery_targets:
            for gallery_target in gallery_targets:
                print(f"\nExercising Gallery export for: {gallery_target['name']}")
                gallery_target['gallery'] = exercise_gallery_export(
                    container_path,
                    gallery_target['verified_task_id'],
                )
        else:
            print("\nGallery export requested, but no completed photo/video task was available.")

    # Also test injection on physical device for the failed items
    if failed_items and os.environ.get('FCDL_INJECT_PHYSICAL_FAILURES') == '1':
        print("\nInjecting failed items into physical device for manual inspection...")
        for name, url, error in failed_items:
            print(f"Injecting to physical device: {name} ({url})")
            deep_link = f"fcdownloader://share?{urlencode({'url': url})}"
            subprocess.run([
                'xcrun', 'devicectl', 'device', 'process', 'launch',
                '--device', PHONE_UDID, '--payload-url', deep_link, BUNDLE_ID
            ], capture_output=True)

    # Write report
    report_path = ROOT / 'artifacts' / 'ios_comprehensive_report.md'
    with report_path.open('w', encoding='utf-8') as f:
        f.write("# iOS Comprehensive URL & Strategy Test Report (Strict Type-Safe Edition)\n\n")
        generated_at = datetime.now(timezone.utc).isoformat(timespec='seconds')
        f.write(f"Evaluated persisted iOS results for **{len(catalog)}** catalog URLs on Simulator `{SIM_UDID}`.\n\n")
        f.write(f"Generated at `{generated_at}` from **{len(tasks)}** persisted task records.\n\n")

        # Summary stats
        passed = sum(1 for r in report_items if r['download'] == "✅ PASS")
        expected_limits = sum(1 for r in report_items if r['download'] == "⚠️ KNOWN LIMIT")
        manual_picker = sum(1 for r in report_items if r['download'] == "⚠️ MANUAL PICKER")
        failed = len(catalog) - passed - expected_limits - manual_picker

        f.write(f"### Summary Stats (Strict Media Type Verification)\n")
        f.write(f"- **Full Passes (Downloaded intended Video/Image/Audio)**: **{passed}**\n")
        f.write(f"- **Known-limited unsuccessful cases (auth/DRM/geo/offline/browser session)**: **{expected_limits}**\n")
        f.write(f"- **Manual media-picker confirmation required**: **{manual_picker}**\n")
        f.write(f"- **Unexpected failures**: **{failed}**\n\n")

        f.write("> [!WARNING]\n")
        f.write("> **Strict Media Type Verification Enabled**: A pass is recorded only when the downloaded file matches the expected media type. Wrong-type thumbnail fallbacks remain unsuccessful even when classified as a known source limitation; they are never counted as passes.\n\n")

        f.write("> [!NOTE]\n")
        if run_started_at is not None:
            f.write(f"> **Run provenance**: Only tasks created at or after epoch `{run_started_at}` ms were included. ")
        else:
            f.write("> **Run provenance**: This is a snapshot of persisted simulator tasks and may include earlier runs. ")
        f.write("The script does not erase or reinstall the app. No fresh physical-iPhone file-integrity run was included. Source-limited items require a suitable logged-in, subscribed, or region-eligible device session.\n\n")

        f.write("### Verification Matrix\n\n")
        f.write("| Platform | Expected Kind | Detection | Download Completion | Media Structure | Gallery Export | Retry Behavior | URL |\n")
        f.write("| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |\n")
        for r in report_items:
            f.write(f"| **{r['name']}** | *{r['expected_kind']}* | {r['detection']} | {r['download']} | {r['sync']} | {r['gallery']} | {r['retry']} | [{r['name']}]({r['url']}) |\n")

        f.write("\n### Library Screenshot (Simulator)\n")
        f.write("Below is the screenshot of the Library tab on the iOS simulator, displaying download status.\n\n")
        if library_proc.returncode == 0 and screenshot_proc.returncode == 0:
            f.write(f"![Library Tab screenshot](screenshots/library_tab.png)\n")
        else:
            f.write("Screenshot capture was attempted but did not complete successfully.\n")

    print(f"\nReport written to: {report_path}")
    print(f"Summary: {passed} PASS, {expected_limits} KNOWN LIMIT, {failed} UNEXPECTED FAIL")

if __name__ == '__main__':
    main()
