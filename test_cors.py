import urllib.request
import urllib.error

req = urllib.request.Request(
    'https://fcdownloader-extractor.fly.dev/extract',
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
