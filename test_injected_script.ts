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

console.log('injected script ok');
