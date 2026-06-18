import assert from 'node:assert/strict';
import { extractFirstUrl, extractSharedUrlFromDeepLink } from './src/lib/shareUrl';

const youtubeUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&feature=share';

assert.equal(
  extractFirstUrl(`Watch this ${youtubeUrl}.`),
  youtubeUrl,
  'caption text should be reduced to the first URL without trailing punctuation',
);

assert.equal(
  extractSharedUrlFromDeepLink(
    `fcdownloader://share?url=${encodeURIComponent(youtubeUrl)}`,
    { url: youtubeUrl },
  ),
  youtubeUrl,
  'properly encoded deep link should preserve URL query params',
);

assert.equal(
  extractSharedUrlFromDeepLink(
    `fcdownloader://share?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ&feature=share`,
    { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', feature: 'share' },
  ),
  youtubeUrl,
  'legacy urlQueryAllowed deep link should recover the full shared URL tail',
);

assert.equal(
  extractSharedUrlFromDeepLink(
    'fcdownloader://share?text=Title%20https%3A%2F%2Fexample.com%2Fclip.mp4%21',
    { text: 'Title https://example.com/clip.mp4!' },
  ),
  'https://example.com/clip.mp4',
  'text-style share params should be scanned for URLs',
);

assert.equal(
  extractSharedUrlFromDeepLink('fcdownloader://share?text=hello', { text: 'hello' }),
  null,
  'non-link shared content should be rejected',
);

console.log('share URL parsing ok');
