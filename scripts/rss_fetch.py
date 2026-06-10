import urllib.request
import re

feeds = {
    "Yahoo": ("https://news.yahoo.co.jp/rss/topics/top-picks.xml", r'<link>(https://news.yahoo.co.jp/articles/[^<]+)</link>'),
    "Bunshun": ("https://bunshun.jp/list/feed/rss", r'<link>(https://bunshun.jp/articles/[^<]+)</link>'),
    "ITMedia": ("https://rss.itmedia.co.jp/rss/2.0/news_bursts.xml", r'<link>(https://www.itmedia.co.jp/news/articles/[^<]+)</link>'),
    "Asahi": ("https://www.asahi.com/rss/asahi/newsheadlines.rdf", r'<link>(https://www.asahi.com/articles/[^<]+)</link>'),
    "Mantan": ("https://mantan-web.jp/feed/", r'<link>(https://mantan-web.jp/article/[^<]+)</link>')
}

for name, (url, pattern) in feeds.items():
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    try:
        html = urllib.request.urlopen(req).read().decode('utf-8')
        m = re.search(pattern, html)
        if m:
            print(f"{name}: {m.group(1)}")
        else:
            print(f"{name}: No match")
    except Exception as e:
        print(f"{name}: Error {e}")
