def extract_xiaohongshu(page_url: str, cookies: str | None) -> dict[str, Any] | None:
    import urllib.request
    import json
    import re
    from utils import safe_headers

    headers = safe_headers({
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Cookie": cookies or "",
    })

    try:
        req = urllib.request.Request(page_url, headers=headers)
        with urllib.request.urlopen(req, timeout=15) as resp:
            html = resp.read().decode('utf-8', errors='ignore')
    except Exception:
        return None

    match = re.search(r'window\.__INITIAL_STATE__\s*=\s*(\{.*?\})\s*</script>', html, re.DOTALL)
    if not match:
        return None

    try:
        # XHS initial state replaces undefined with empty quotes or literal string "undefined", 
        # python json doesn't like JS undefined. It usually is valid JSON though.
        state_str = match.group(1).replace("undefined", "null")
        data = json.loads(state_str)
        note_id = data.get("note", {}).get("currentNoteId")
        if not note_id:
            note_id = list(data.get("note", {}).get("noteDetailMap", {}).keys())[0]
            
        note = data.get("note", {}).get("noteDetailMap", {}).get(note_id, {}).get("note", {})
        if not note:
            return None

        title = note.get("title", "Xiaohongshu Media")
        video = note.get("video")
        if video and video.get("media", {}).get("stream", {}).get("h264", {}).get("masterUrl"):
            url = video["media"]["stream"]["h264"]["masterUrl"]
            return {
                "id": note_id,
                "title": title,
                "url": url,
                "ext": "mp4",
                "protocol": "https",
                "http_headers": {},
                "thumbnail": note.get("imageList", [{}])[0].get("urlDefault"),
            }
        
        # Image gallery fallback
        images = note.get("imageList", [])
        if images:
            items = []
            for idx, img in enumerate(images):
                items.append({
                    "kind": "image",
                    "url": img.get("urlDefault") or img.get("url"),
                    "id": f"{note_id}_{idx}",
                    "title": title,
                    "ext": "jpg",
                })
            return {"kind": "gallery", "items": items, "title": title, "id": note_id}
            
        return None
    except Exception:
        return None

def extract_bilibili(page_url: str, cookies: str | None) -> dict[str, Any] | None:
    import urllib.request
    import json
    import re
    from utils import safe_headers

    headers = safe_headers({
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Cookie": cookies or "",
    })

    try:
        req = urllib.request.Request(page_url, headers=headers)
        with urllib.request.urlopen(req, timeout=15) as resp:
            html = resp.read().decode('utf-8', errors='ignore')
    except Exception:
        return None

    # Try to find window.__playinfo__
    match = re.search(r'window\.__playinfo__\s*=\s*(\{.*?\})</script>', html)
    if match:
        try:
            data = json.loads(match.group(1))
            durl = data.get("data", {}).get("durl", [])
            if durl and len(durl) > 0:
                return {
                    "id": "bilibili_video",
                    "title": "Bilibili Video",
                    "url": durl[0]["url"],
                    "ext": "mp4",
                    "protocol": "https",
                    "http_headers": {"Referer": "https://www.bilibili.com/"},
                }
        except Exception:
            pass

    # Try readyVideoUrl
    match2 = re.search(r'"readyVideoUrl"\s*:\s*"([^"]+)"', html)
    if match2:
        return {
            "id": "bilibili_video",
            "title": "Bilibili Video",
            "url": match2.group(1).replace('\\/', '/').replace('\\u0026', '&'),
            "ext": "mp4",
            "protocol": "https",
            "http_headers": {"Referer": "https://www.bilibili.com/"},
        }

    return None

def extract_tiktok(page_url: str, cookies: str | None) -> dict[str, Any] | None:
    import urllib.request
    import json
    import re
    from utils import safe_headers
    
    # Simple regex to get video id
    m = re.search(r'/video/(\d+)', page_url)
    if not m:
        return None
    video_id = m.group(1)

    api_url = f"https://api16-normal-c-useast1a.tiktokv.com/aweme/v1/feed/?aweme_id={video_id}"
    headers = safe_headers({
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
        "Accept": "*/*",
    })

    try:
        req = urllib.request.Request(api_url, headers=headers)
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode('utf-8'))
        
        aweme = data.get("aweme_list", [])[0]
        video = aweme.get("video", {})
        play_addr = video.get("play_addr", {}).get("url_list", [])
        if play_addr:
            return {
                "id": video_id,
                "title": aweme.get("desc", "TikTok Video"),
                "url": play_addr[0],
                "ext": "mp4",
                "protocol": "https",
                "http_headers": {},
            }
    except Exception:
        pass
    
    return None

def extract_reddit(page_url: str, cookies: str | None) -> dict[str, Any] | None:
    import urllib.request
    import json
    from utils import safe_headers

    # append .json to reddit url
    json_url = page_url.split('?')[0].rstrip('/') + '/.json'
    
    headers = safe_headers({
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        "Accept": "application/json",
        "Cookie": cookies or "",
    })

    try:
        req = urllib.request.Request(json_url, headers=headers)
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode('utf-8'))
        
        post = data[0]["data"]["children"][0]["data"]
        
        if "secure_media" in post and post["secure_media"] and "reddit_video" in post["secure_media"]:
            video_url = post["secure_media"]["reddit_video"]["fallback_url"]
            # To get audio, we'd need DASH, but fallback_url often has just video.
            # We will just return the fallback url. Reddit pairs video/audio natively via dash,
            # but yt-dlp usually handles it. If yt-dlp fails, this is better than nothing.
            return {
                "id": post.get("id", "reddit_video"),
                "title": post.get("title", "Reddit Video"),
                "url": video_url,
                "ext": "mp4",
                "protocol": "https",
                "http_headers": {},
            }
    except Exception:
        pass

    return None
