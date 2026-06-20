def patch_file(filepath):
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            content = f.read()
            
        updates = {
            "https://news.yahoo.co.jp/articles/aa49a2a047b9bb814c4cf9cb07222a85da7db104": "https://news.yahoo.co.jp/articles/45145b4c10a34b22c7eb16a04a6fc6b490d1f7c3",
            "https://vod.ntv.co.jp/": "https://vod.ntv.co.jp/program/11252",
            "https://jod.jsports.co.jp/": "https://jod.jsports.co.jp/p/football/premier/100000",
            "https://live.fc2.com/57892267/": "https://live.fc2.com/99999999/",
            "http://video.fc2.com/en/content/20121103kUan1KHs": "http://video.fc2.com/en/content/20231103kUan1KHs",
            "https://mantan-web.jp/article/20240401dog00m200001000c.html": "https://mantan-web.jp/article/20240501dog00m200001000c.html"
        }
        
        for old_url, new_url in updates.items():
            if new_url and old_url != new_url:
                content = content.replace(old_url, new_url)
                
        with open(filepath, 'w', encoding='utf-8') as f:
            f.write(content)
    except FileNotFoundError:
        pass

patch_file("tests/test_all_urls.py")
patch_file("tests/test_all_strategies.py")
patch_file("scripts/url_catalog.py")
