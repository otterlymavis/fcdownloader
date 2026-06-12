import json
import re

with open("fresh_urls.json") as f:
    updates = json.load(f)

with open("test_all_urls.py", "r") as f:
    content = f.read()

for name, new_url in updates.items():
    pattern = r'("' + re.escape(name) + r'":\s*\(\n?\s*")([^"]+)(")'
    def replacer(match):
        return match.group(1) + new_url + match.group(3)
    content = re.sub(pattern, replacer, content)

failed_to_fetch = [
    "TVer", "TBS", "FOD / Fuji TV", "Nippon TV VOD", "Yahoo Japan video/news",
    "FRaU", "Oricon", "Weibo", "Douyin", "NicoNico", "FC2 Video", "OpenREC"
]

for name in failed_to_fetch:
    pattern = r'(\s*)("' + re.escape(name) + r'":\s*\()'
    content = re.sub(pattern, r'\1# \2', content)

with open("test_all_urls.py", "w") as f:
    f.write(content)

print("Updated test_all_urls.py successfully.")
