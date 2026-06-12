import urllib.request
import urllib.error
import gzip
import re
import io

sitemaps = {
    "TVer": "https://tver.jp/sitemap_episodes.xml", # often there's a specific one, or we fetch the main and find it
    "TBS": "https://cu.tbs.co.jp/sitemap.xml",
    "FOD / Fuji TV": "https://fod.fujitv.co.jp/sitemap.xml",
}

def get_url(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'Googlebot'})
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            data = response.read()
            if response.info().get('Content-Encoding') == 'gzip':
                data = gzip.GzipFile(fileobj=io.BytesIO(data)).read()
            return data.decode('utf-8', errors='ignore')
    except Exception as e:
        print(f"Failed {url}: {e}")
        return ""

print("Fetching TVer main sitemap...")
tver_main = get_url("https://tver.jp/sitemap.xml")
if tver_main:
    # Find episodes sitemap
    matches = re.findall(r'<loc>(https://tver\.jp/sitemaps/episodes[^<]+)</loc>', tver_main)
    if matches:
        print(f"Found TVer episode sitemap: {matches[0]}")
        tver_eps = get_url(matches[0])
        ep_matches = re.findall(r'<loc>(https://tver\.jp/episodes/[^<]+)</loc>', tver_eps)
        if ep_matches:
            print(f"✅ TVer: {ep_matches[0]}")

print("Fetching TBS main sitemap...")
tbs_main = get_url("https://cu.tbs.co.jp/sitemap.xml")
if tbs_main:
    matches = re.findall(r'<loc>(https://cu\.tbs\.co\.jp/sitemap/episode[^<]+)</loc>', tbs_main)
    if matches:
        tbs_eps = get_url(matches[0])
        ep_matches = re.findall(r'<loc>(https://cu\.tbs\.co\.jp/episode/[0-9]+)</loc>', tbs_eps)
        if ep_matches:
            print(f"✅ TBS: {ep_matches[0]}")
