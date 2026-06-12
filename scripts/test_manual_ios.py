import json
import sys
import subprocess
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[1]
sys.path.append(str(ROOT))
from scripts.url_catalog import all_urls

udid = '91DD8048-BB9A-42E8-8790-90D809267A88'
bundle_id = 'com.otterpia.fcdownloader'

try:
    container_path = subprocess.check_output(['xcrun', 'simctl', 'get_app_container', udid, bundle_id, 'data']).decode('utf-8').strip()
    db_dir = Path(container_path) / 'Library' / 'Application Support' / bundle_id / 'RCTAsyncLocalStorage_V1'
except Exception as e:
    print(f"Error getting app container: {e}")
    sys.exit(1)

db_files = list(db_dir.glob('*'))
db_file = None
for f in db_files:
    if f.is_file() and f.name != 'manifest.json' and len(f.name) == 32:
        db_file = f
        break

if not db_file:
    print("AsyncStorage file not found!")
    sys.exit(1)

with open(db_file, 'r', encoding='utf-8') as f:
    tasks = json.load(f)

url_tasks = {}
for task in tasks:
    page_url = task.get('media', {}).get('pageUrl')
    if page_url:
        norm_url = page_url.strip().rstrip('/')
        url_tasks.setdefault(norm_url, []).append(task)

catalog = all_urls()
failed_urls = []

for name, (url, note) in catalog.items():
    norm_url = url.strip().rstrip('/')
    matching = url_tasks.get(norm_url, [])
    if not matching:
        alt_urls = [norm_url.replace('http://', 'https://'), norm_url.replace('https://', 'http://')]
        if '?' in norm_url:
            alt_urls.append(norm_url.split('?')[0])
        for alt in alt_urls:
            matching = url_tasks.get(alt.rstrip('/'), [])
            if matching:
                break
    
    completed = [t for t in matching if t.get('status') == 'completed']
    if not completed:
        failed_urls.append((name, url))

print(f"Found {len(failed_urls)} URLs that failed or had no media.")
print("Starting manual test loop...")
print("For each URL, it will open the iOS Simulator.")
print("Manually dismiss any cookie banners, click the Play button on the video, and verify if it triggers.")
print("Then press Enter in this terminal to load the next URL.\n")

for i, (name, url) in enumerate(failed_urls, start=1):
    print(f"[{i}/{len(failed_urls)}] Testing: {name}")
    print(f"URL: {url}")
    
    subprocess.run(['xcrun', 'simctl', 'pbcopy', udid], input=url.encode('utf-8'))
    
    input("Press Enter to move to the next URL (or press Ctrl+C to stop)...")
    print("-" * 50)

print("\nDone! Now you can run `npm run report:ios` to generate the updated report based on your manual interactions.")
