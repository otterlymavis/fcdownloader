import './test_setup.js';
import assert from 'node:assert/strict';
import { isRetryableDownloadError } from '../src/hooks/useDownloadManager';
import { DRMProtectedError } from '../src/lib/downloadStrategies';
import { ServerExtractionError } from '../src/lib/serverExtractor';

assert.equal(isRetryableDownloadError(new Error('Download stalled')), true);
assert.equal(isRetryableDownloadError(new Error('Truncated download: 500/1000 bytes')), true);
assert.equal(isRetryableDownloadError(new Error('Network request failed')), true);
assert.equal(isRetryableDownloadError(new Error('HTTP 503 downloading track')), true);

assert.equal(isRetryableDownloadError(new Error('Cancelled')), false);
assert.equal(isRetryableDownloadError(new Error('HTTP 403 — server rejected the request')), false);
assert.equal(isRetryableDownloadError(new Error('Server returned a non-media response')), false);
assert.equal(isRetryableDownloadError(new DRMProtectedError('DRM-protected')), false);
assert.equal(isRetryableDownloadError(new ServerExtractionError('Please sign in', 'AUTH_REQUIRED')), false);
assert.equal(isRetryableDownloadError(new ServerExtractionError('Not available here', 'GEO_BLOCKED')), false);
assert.equal(isRetryableDownloadError(new ServerExtractionError('Too many requests', 'RATE_LIMITED')), false);
assert.equal(isRetryableDownloadError(new ServerExtractionError('Temporary upstream reset')), true);

console.log('download retry policy ok');
