import assert from 'node:assert/strict';
import { INJECTED_SCRIPT } from './src/constants/injectedScript';

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

console.log('injected script ok');
