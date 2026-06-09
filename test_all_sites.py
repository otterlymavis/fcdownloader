import asyncio
import json
import sys
import yt_dlp

TEST_URLS = {
    "YouTube": "https://www.youtube.com/watch?v=jNQXAC9IVRw",
    "YouTube Classic": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "Instagram Reel": "https://www.instagram.com/reel/C7VgIvhsKgR/",
    "Twitter/X": "https://x.com/NASA/status/1902118174591521056",
    "Facebook": "https://www.facebook.com/watch/?v=10153231379946729",
    "Naver TV": "http://tv.naver.com/v/81652",
    "Niconico": "https://www.nicovideo.jp/watch/sm9",
    "Bilibili": "https://www.bilibili.com/video/BV1PkR2BkEUt",
    "Bilibili Large": "https://www.bilibili.com/video/BV1ux411U7Dp/",
    "Xiaohongshu": "https://www.xiaohongshu.com/explore/654854cd000000001e00e00f",
    "Xiaohongshu Shortlink": "http://xhslink.com/o/AuDpBCMNn0z",
    "TikTok Short": "https://vm.tiktok.com/ZNR7eeRqB/",
    "TikTok NASA": "https://www.tiktok.com/@nasa.tiktok2/video/7624845650504469780",
    "Reddit Gallery": "https://www.reddit.com/r/shiba/s/nC3HbrECzI",
    "Vimeo": "https://vimeo.com/76979871",
    "Dailymotion": "https://www.dailymotion.com/video/xa52aa8",
    "Pinterest": "https://www.pinterest.com/pin/84301824269690044/",
    "NHK World": "https://www3.nhk.or.jp/nhkworld/en/shows/2049165/",
    "Oricon": "https://www.oricon.co.jp/news/2285123/full/",
    "Modelpress": "https://mdpr.jp/photo/detail/20095233",
    "Direct MP4": "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4",
    "Direct Image": "https://upload.wikimedia.org/wikipedia/commons/3/3f/Fronalpstock_big.jpg",
    "Direct Audio": "https://upload.wikimedia.org/wikipedia/commons/c/c8/Example.ogg",
    "HLS Manifest": "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
    "DASH Manifest": "https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd",
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


test_ytdlp.__test__ = False

def main():
    print("--- STARTING TESTS ---")
    for name, url in TEST_URLS.items():
        print(f"Testing {name} ({url})...")
        result = test_ytdlp(url)
        print(f"[{name}] -> {result}")

if __name__ == "__main__":
    main()
