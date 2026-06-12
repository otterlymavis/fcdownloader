import urllib.request
import re

def search(query):
    url = f"https://html.duckduckgo.com/html/?q={urllib.parse.quote(query)}"
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'})
    try:
        html = urllib.request.urlopen(req).read().decode('utf-8')
        links = re.findall(r'href="(//duckduckgo.com/l/\?uddg=[^"]+)"', html)
        if links:
            return urllib.parse.unquote(links[0].split('uddg=')[1].split('&')[0])
    except Exception as e:
        print(f"Error {query}: {e}")
    return None

print(search("site:news.yahoo.co.jp/articles/"))
