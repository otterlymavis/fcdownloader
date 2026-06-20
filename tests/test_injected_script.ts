import assert from 'node:assert/strict';
import fs from 'node:fs';
import { INJECTED_SCRIPT } from '../src/constants/injectedScript';

assert.doesNotThrow(
  () => new Function(INJECTED_SCRIPT),
  'Injected script should remain valid JavaScript',
);
assert.ok(
  INJECTED_SCRIPT.includes("setAttribute('playsinline'"),
  'Injected script should force playsinline on video elements',
);
assert.ok(
  INJECTED_SCRIPT.includes("setAttribute('webkit-playsinline'"),
  'Injected script should force webkit-playsinline on video elements',
);
assert.ok(
  INJECTED_SCRIPT.includes('Document.prototype.createElement'),
  'Injected script should patch document.createElement for dynamically-created videos',
);
assert.ok(
  INJECTED_SCRIPT.includes('vimeocdn') && INJECTED_SCRIPT.includes('playlist\\.json'),
  'Injected script should detect Vimeo CDN playlist JSON as media',
);
assert.ok(
  INJECTED_SCRIPT.includes('player\\.vimeo\\.com\\/video\\/\\d+\\/config'),
  'Injected script should detect Vimeo player config JSON as media',
);
assert.ok(
  INJECTED_SCRIPT.includes('[data-vimeo-id],[data-vimeo-url]'),
  'Injected script should scan Vimeo SDK data attributes',
);
assert.ok(
  INJECTED_SCRIPT.includes("suffix = '?h=' + encodeURIComponent(privateHash)"),
  'Injected script should preserve Vimeo unlisted-video hashes',
);

const browserView = fs.readFileSync('./src/components/BrowserView.tsx', 'utf8');
assert.ok(
  browserView.includes(
    "injectedJavaScriptBeforeContentLoadedForMainFrameOnly={Platform.OS !== 'ios'}",
  ),
  'BrowserView should inject early detection into iOS subframes',
);

console.log('injected script ok');
