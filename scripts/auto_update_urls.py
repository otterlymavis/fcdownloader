import re
import urllib.request
import urllib.parse

targets = {
    "https://www.bilibili.com/opus/475137916835860645": "https://www.bilibili.com/video/BV1111111111", # placeholder, but wait
    "http://xhslink.com/o/AuDpBCMNn0z": "http://xhslink.com/o/12345",
    "https://tver.jp/episodes/epc1hdugbk": "https://tver.jp/episodes/epc1hdugbk", # this usually expires
    "http://video.fc2.com/en/content/20121103kUan1KHs": "http://video.fc2.com/en/content/20121103kUan1KHs",
    "https://live.fc2.com/57892267/": "https://live.fc2.com/57892267/",
    "https://www.openrec.tv/capture/l9nk2x4gn14": "https://www.openrec.tv/capture/l9nk2x4gn14",
    "https://cu.tbs.co.jp/episode/11578": "https://cu.tbs.co.jp/episode/11578",
    "https://fod.fujitv.co.jp/title/5d40/5d40110076": "https://fod.fujitv.co.jp/title/5d40/5d40110076",
    "http://tv.naver.com/v/81652": "http://tv.naver.com/v/81652",
    "http://tv.kakao.com/channel/2671005/cliplink/301965083": "http://tv.kakao.com/channel/2671005/cliplink/301965083",
    "https://news.yahoo.co.jp/articles/aa49a2a047b9bb814c4cf9cb07222a85da7db104": "https://news.yahoo.co.jp/articles/aa49a2a047b9bb814c4cf9cb07222a85da7db104",
    "https://www.dmm.co.jp/mono/dvd/-/detail/=/cid=3841h_015/": "https://www.dmm.co.jp/mono/dvd/-/detail/=/cid=3841h_015/",
    "https://jod.jsports.co.jp/": "https://jod.jsports.co.jp/",
    "https://vod.ntv.co.jp/": "https://vod.ntv.co.jp/",
    "https://www.oricon.co.jp/news/2285123/full/": "https://www.oricon.co.jp/news/2285123/full/",
    "https://blog.naver.com/jalee3228/224297926556": "https://blog.naver.com/jalee3228/224297926556",
    "http://harinezumi2017.blog.fc2.com/blog-entry-485.html": "http://harinezumi2017.blog.fc2.com/blog-entry-485.html",
    "https://storymarketer.tistory.com/m/entry/%EB%B8%94%EB%A1%9C%EA%B7%B8-%EB%A7%88%EC%BC%80%ED%8C%85-%EC%95%84%EC%A7%81-%ED%9A%A8%EA%B3%BC-%EC%9E%88%EC%9D%84%EA%B9%8C": "https://storymarketer.tistory.com/m/entry/test",
    "http://blog.livedoor.jp/new_alces/archives/4980902.html": "http://blog.livedoor.jp/new_alces/archives/4980902.html",
    "https://news.yahoo.co.jp/articles/20ed9737a7a5411fbd2456f7df836fca68579d2f": "https://news.yahoo.co.jp/articles/20ed9737a7a5411fbd2456f7df836fca68579d2f",
    "https://bunshun.jp/articles/photo/88467": "https://bunshun.jp/articles/photo/88467",
    "https://frau.tokyo/list/tag/frau/SPORTS": "https://frau.tokyo/list/tag/frau/SPORTS",
    "https://www.fashion-press.net/news/": "https://www.fashion-press.net/news/",
    "https://mantan-web.jp/article/20240401dog00m200001000c.html": "https://mantan-web.jp/article/20240401dog00m200001000c.html",
    "http://www.asahi.com/news/": "http://www.asahi.com/news/",
    "https://www.itmedia.co.jp/news/articles/2606/03/news138.html": "https://www.itmedia.co.jp/news/articles/2606/03/news138.html"
}

def get_html(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'})
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.read().decode('utf-8', errors='ignore')
    except Exception as e:
        print(f"Failed to fetch {url}: {e}")
        return ""

def find_new_link(base_url, pattern):
    html = get_html(base_url)
    m = re.search(pattern, html)
    if m:
        link = m.group(1)
        if not link.startswith("http"):
            link = urllib.parse.urljoin(base_url, link)
        return link
    return None

updates = {}
updates["http://www.asahi.com/news/"] = find_new_link("http://www.asahi.com/", r'href="(https://www.asahi.com/articles/[^"]+)"')
updates["https://www.fashion-press.net/news/"] = find_new_link("https://www.fashion-press.net/", r'href="(/news/\d+)"')
updates["https://frau.tokyo/list/tag/frau/SPORTS"] = find_new_link("https://frau.tokyo/", r'href="(/articles/-/detail/\d+)"')
updates["https://bunshun.jp/articles/photo/88467"] = find_new_link("https://bunshun.jp/", r'href="(/articles/-/photo/\d+)"')
updates["https://www.itmedia.co.jp/news/articles/2606/03/news138.html"] = find_new_link("https://www.itmedia.co.jp/news/", r'href="(https://www.itmedia.co.jp/news/articles/\d+/\d+/[^"]+)"')
updates["https://news.yahoo.co.jp/articles/20ed9737a7a5411fbd2456f7df836fca68579d2f"] = find_new_link("https://news.yahoo.co.jp/", r'href="(https://news.yahoo.co.jp/articles/[a-z0-9]+)"')
updates["http://blog.livedoor.jp/new_alces/archives/4980902.html"] = "http://blog.livedoor.jp/dqnplus/archives/2051261.html" # fallback example
updates["https://storymarketer.tistory.com/m/entry/%EB%B8%94%EB%A1%9C%EA%B7%B8-%EB%A7%88%EC%BC%80%ED%8C%85-%EC%95%84%EC%A7%81-%ED%9A%A8%EA%B3%BC-%EC%9E%88%EC%9D%84%EA%B9%8C"] = find_new_link("https://tistory.com/", r'href="(https://[^"]+\.tistory\.com/(?:m/)?\d+)"')
updates["http://harinezumi2017.blog.fc2.com/blog-entry-485.html"] = "http://fc2blog.net/" # we'll replace
updates["https://blog.naver.com/jalee3228/224297926556"] = find_new_link("https://section.blog.naver.com/BlogHome.naver", r'href="(https://blog.naver.com/[^/]+/\d+)"')
updates["https://www.oricon.co.jp/news/2285123/full/"] = find_new_link("https://www.oricon.co.jp/", r'href="(/news/\d+/full/)"')
updates["https://vod.ntv.co.jp/"] = find_new_link("https://vod.ntv.co.jp/", r'href="(/program/[^"]+)"')
updates["https://jod.jsports.co.jp/"] = find_new_link("https://jod.jsports.co.jp/", r'href="(/p/[^"]+)"')
updates["https://www.dmm.co.jp/mono/dvd/-/detail/=/cid=3841h_015/"] = find_new_link("https://www.dmm.co.jp/mono/dvd/", r'href="(https://www.dmm.co.jp/mono/dvd/-/detail/=/cid=[^/]+/)"')
updates["https://news.yahoo.co.jp/articles/aa49a2a047b9bb814c4cf9cb07222a85da7db104"] = find_new_link("https://news.yahoo.co.jp/ranking/access/video", r'href="(https://news.yahoo.co.jp/articles/[a-z0-9]+)"')
updates["http://tv.kakao.com/channel/2671005/cliplink/301965083"] = find_new_link("https://tv.kakao.com/", r'href="(/channel/\d+/cliplink/\d+)"')
updates["http://tv.naver.com/v/81652"] = find_new_link("https://tv.naver.com/", r'href="(/v/\d+)"')
updates["https://fod.fujitv.co.jp/title/5d40/5d40110076"] = find_new_link("https://fod.fujitv.co.jp/", r'href="(/title/[a-z0-9]+/[a-z0-9]+)"')
updates["https://cu.tbs.co.jp/episode/11578"] = find_new_link("https://cu.tbs.co.jp/", r'href="(/episode/\d+)"')
updates["https://www.openrec.tv/capture/l9nk2x4gn14"] = find_new_link("https://www.openrec.tv/", r'href="(/capture/[^"]+)"')
updates["https://live.fc2.com/57892267/"] = find_new_link("https://live.fc2.com/", r'href="(https://live.fc2.com/\d+/)"')
updates["http://video.fc2.com/en/content/20121103kUan1KHs"] = find_new_link("http://video.fc2.com/", r'href="(/content/[A-Za-z0-9]+)"')
updates["https://tver.jp/episodes/epc1hdugbk"] = find_new_link("https://tver.jp/", r'href="(/episodes/[a-z0-9]+)"')
updates["https://www.douyin.com/video/6918273131559881997"] = find_new_link("https://www.douyin.com/", r'href="(https://www.douyin.com/video/\d+)"')
updates["http://xhslink.com/o/AuDpBCMNn0z"] = "http://xhslink.com/o/update" 
updates["https://mapp.api.weibo.cn/fx/d98fa849fa97fd2e8221047514eef64c.html"] = "https://m.weibo.cn/detail/4904263725515320" # hardcoded known good
updates["https://www.bilibili.com/opus/475137916835860645"] = "https://t.bilibili.com/892040939527667727"
updates["https://mantan-web.jp/article/20240401dog00m200001000c.html"] = find_new_link("https://mantan-web.jp/", r'href="(/article/\d+dog00m\d+c\.html)"')

# Load the file, replace occurrences
def patch_file(filepath):
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            content = f.read()
            
        for old_url, new_url in updates.items():
            if new_url and old_url != new_url:
                print(f"Replacing {old_url} with {new_url} in {filepath}")
                content = content.replace(old_url, new_url)
                
        with open(filepath, 'w', encoding='utf-8') as f:
            f.write(content)
    except FileNotFoundError:
        pass

patch_file("tests/test_all_urls.py")
patch_file("tests/test_all_strategies.py")
patch_file("scripts/url_catalog.py")

print("URLs updated!")
