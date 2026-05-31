import asyncio
import json
import sys
import yt_dlp

TEST_URLS = {
    "YouTube": "https://www.youtube.com/watch?v=jNQXAC9IVRw",
    "Instagram": "https://www.instagram.com/p/C-00-5lA2Qd/?img_index=1",
    "Twitter": "https://twitter.com/SpaceX/status/1768271505370423719",
    "Facebook": "https://www.facebook.com/watch/?v=1329243767851936",
    "Naver TV": "https://tv.naver.com/v/41725595",
    "Niconico": "https://www.nicovideo.jp/watch/sm43343389",
    "Bilibili": "https://www.bilibili.com/video/BV11h4y1f7Xk/",
    "Xiaohongshu": "https://www.xiaohongshu.com/explore/654854cd000000001e00e00f",
    "TikTok": "https://www.tiktok.com/@tiktok/video/7339798485299875114",
    "Reddit": "https://www.reddit.com/r/aww/comments/1f4x0x1/this_is_my_life_now/"
}

def test_ytdlp(url):
    ydl_opts = {
        'quiet': True,
        'no_warnings': True,
        'extract_flat': True,
    }
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)
            if info:
                return f"SUCCESS (Title: {info.get('title', 'Unknown')})"
            return "FAIL: No info returned"
    except Exception as e:
        return f"FAIL: {str(e)}"

def main():
    print("--- STARTING TESTS ---")
    for name, url in TEST_URLS.items():
        print(f"Testing {name} ({url})...")
        result = test_ytdlp(url)
        print(f"[{name}] -> {result}")

if __name__ == "__main__":
    main()
