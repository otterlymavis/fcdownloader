import assert from 'node:assert/strict';
import { isSocialPageUrl, tumblrApiUrl } from '../src/lib/platformExtractors';

const modern = 'https://www.tumblr.com/humansofnewyork/753752476340060160';
assert.equal(
  tumblrApiUrl(modern),
  'https://humansofnewyork.tumblr.com/api/read/json?id=753752476340060160',
  'modern Tumblr URLs should resolve through the blog subdomain API',
);
assert.equal(isSocialPageUrl(modern), true, 'modern Tumblr URLs should select the Tumblr extractor');

const legacy = 'https://humansofnewyork.tumblr.com/post/753752476340060160/example';
assert.equal(
  tumblrApiUrl(legacy),
  'https://humansofnewyork.tumblr.com/api/read/json?id=753752476340060160',
);
assert.equal(isSocialPageUrl(legacy), true);

assert.equal(tumblrApiUrl('https://www.tumblr.com/explore'), undefined);

console.log('Tumblr extractor tests passed');
