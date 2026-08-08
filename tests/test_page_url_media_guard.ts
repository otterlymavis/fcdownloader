import assert from 'node:assert/strict';
import {
  isNonContentMediaUrl,
  isRuntimeDownloadCandidate,
  isSelfPageUrl,
} from '../src/lib/mediaHelpers';

// A Wikimedia Commons file page path ends in a media extension, so the runtime
// candidate check alone happily promotes it. Downloading it then fails with
// "server returned a page or non-media response instead of downloadable media".
const commonsFilePage = 'https://commons.wikimedia.org/wiki/File:Big_Buck_Bunny_4K.webm';
const realMedia = 'https://upload.wikimedia.org/wikipedia/commons/a/a2/Big_Buck_Bunny_4K.webm';

assert.equal(
  isRuntimeDownloadCandidate(commonsFilePage, commonsFilePage),
  true,
  'precondition: the extension check alone cannot tell a file page from media',
);

// ── the page's own URL is never its media ────────────────────────

assert.equal(
  isSelfPageUrl(commonsFilePage, commonsFilePage),
  true,
  'a captured URL identical to the page URL must be rejected',
);

assert.equal(
  isSelfPageUrl(`${commonsFilePage}/`, commonsFilePage),
  true,
  'a trailing slash must not defeat the self-page check',
);

assert.equal(
  isSelfPageUrl(`${commonsFilePage}#/media/File:X`, commonsFilePage),
  true,
  'a fragment must not defeat the self-page check',
);

assert.equal(
  isSelfPageUrl(realMedia, commonsFilePage),
  false,
  'the actual media URL on the same page must survive',
);

assert.equal(
  isSelfPageUrl(realMedia, undefined),
  false,
  'an unknown page URL must not reject candidates',
);

// ── the served Content-Type overrides a media-looking path ───────

assert.equal(
  isNonContentMediaUrl(commonsFilePage, 'text/html; charset=UTF-8'),
  true,
  'a media-looking path served as HTML is a page, not a download',
);

assert.equal(
  isNonContentMediaUrl(realMedia, 'video/webm'),
  false,
  'genuine media must pass the Content-Type gate',
);

assert.equal(
  isNonContentMediaUrl(realMedia, undefined),
  false,
  'a missing Content-Type must not reject genuine media',
);

// ── media documents are both the page and the media ──────────────
// Navigating the in-app browser straight to an .mp4 renders a synthetic
// document whose <video> currentSrc IS location.href. The self-page guard alone
// would drop it, so detection is gated on document.contentType as well.

const isMediaDocument = (docContentType: unknown): boolean =>
  /^(?:video|audio|image)\//i.test(String(docContentType ?? ''));

const bareMediaUrl = 'https://example.com/clip.mp4';

assert.equal(
  isSelfPageUrl(bareMediaUrl, bareMediaUrl) && !isMediaDocument('video/mp4'),
  false,
  'a media document must not be suppressed even though url === pageUrl',
);

assert.equal(
  isSelfPageUrl(commonsFilePage, commonsFilePage) && !isMediaDocument('text/html'),
  true,
  'an HTML file page must still be suppressed',
);

assert.equal(
  isMediaDocument(undefined),
  false,
  'a missing document.contentType must not be treated as a media document',
);

assert.equal(
  isMediaDocument('audio/mpeg') && isMediaDocument('image/jpeg'),
  true,
  'audio and image documents count as media documents too',
);

console.log('page URL media guard ok');
