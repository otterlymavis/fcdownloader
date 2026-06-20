import urllib.request
import urllib.error
import os

BACKEND = os.environ.get("FCDOWNLOADER_BACKEND", "https://fcdownloader-extractor.fly.dev").rstrip("/")

req = urllib.request.Request(
    f'{BACKEND}/extract',
    method='OPTIONS',
    headers={
        'Origin': 'http://localhost:8081',
        'Access-Control-Request-Method': 'POST'
    }
)
try:
    res = urllib.request.urlopen(req)
    print("STATUS", res.status)
    print(res.headers)
except urllib.error.HTTPError as e:
    print("ERROR", e.code)
    print(e.read().decode())
