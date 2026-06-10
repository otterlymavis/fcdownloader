import urllib.request
import re
import json

def get_html(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.read().decode('utf-8', errors='ignore')
    except Exception:
        return ""

def update_asahi():
    html = get_html("http://www.asahi.com/news/")
    m = re.search(r'href="(https://www.asahi.com/articles/[^"]+)"', html)
    return m.group(1) if m else None

def update_fashion_press():
    html = get_html("https://www.fashion-press.net/news/")
    m = re.search(r'href="(/news/\d+)"', html)
    return "https://www.fashion-press.net" + m.group(1) if m else None

def update_frau():
    html = get_html("https://frau.tokyo/list/tag/frau/SPORTS")
    m = re.search(r'href="(/articles/-/detail/\d+)"', html)
    return "https://frau.tokyo" + m.group(1) if m else None

# To avoid complexity, maybe just use standard search for the domains?
