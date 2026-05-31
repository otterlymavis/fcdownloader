import re
import json

html = open('xhs_test.html', 'r', encoding='utf-8').read()

match = re.search(r'window\.__INITIAL_STATE__=({.+?})</script>', html)
if match:
    data = match.group(1)
    data = data.replace('undefined', 'null')
    try:
        j = json.loads(data)
        note = j.get('note', {}).get('noteDetailMap', {})
        for key, value in note.items():
            if 'note' in value:
                n = value['note']
                print("Title:", n.get('title'))
                for img in n.get('imageList', []):
                    print("Image:", img.get('urlDefault'))
                if n.get('video'):
                    print("Video:", n['video'].get('media', {}).get('stream', {}).get('h264', [])[0].get('masterUrl'))
    except Exception as e:
        print("JSON parse error", e)
