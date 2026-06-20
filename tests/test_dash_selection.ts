import './test_setup.js';
import assert from 'node:assert/strict';
import { parseMPD, selectDashRepresentations } from '../src/lib/dashDownloader';
import { FormatOption } from '../src/types';

const mpd = `<?xml version="1.0"?>
<MPD>
  <Period>
    <AdaptationSet mimeType="video/mp4" contentType="video">
      <Representation id="v360" bandwidth="800000" width="640" height="360" codecs="avc1.4d401e">
        <BaseURL>https://cdn.example.com/v360.mp4</BaseURL>
      </Representation>
      <Representation id="v1080" bandwidth="4500000" width="1920" height="1080" codecs="avc1.640028">
        <BaseURL>https://cdn.example.com/v1080.mp4</BaseURL>
      </Representation>
    </AdaptationSet>
    <AdaptationSet mimeType="audio/mp4" contentType="audio">
      <Representation id="a64" bandwidth="64000" codecs="mp4a.40.2">
        <BaseURL>https://cdn.example.com/a64.m4a</BaseURL>
      </Representation>
      <Representation id="a128" bandwidth="128000" codecs="mp4a.40.2">
        <BaseURL>https://cdn.example.com/a128.m4a</BaseURL>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

const parsed = parseMPD(mpd, 'https://cdn.example.com/manifest.mpd');
const formats: FormatOption[] = [
  { id: 'v360', mediaKind: 'video', audioFormatId: 'a64' },
  { id: 'v1080', mediaKind: 'video', audioFormatId: 'a128' },
  { id: 'a64', mediaKind: 'audio', selectable: false },
  { id: 'a128', mediaKind: 'audio', selectable: false },
];

const selected = selectDashRepresentations(parsed, {
  formatId: 'v360',
  availableFormats: formats,
});
assert.equal(selected.video?.id, 'v360');
assert.equal(selected.audio?.id, 'a64');

const fallback = selectDashRepresentations(parsed, {
  availableFormats: formats,
});
assert.equal(fallback.video?.id, 'v1080');
assert.equal(fallback.audio?.id, 'a128');

assert.throws(
  () => selectDashRepresentations(parsed, { formatId: 'missing', availableFormats: formats }),
  /Requested DASH video representation not found: missing/,
);

assert.throws(
  () => selectDashRepresentations(parsed, {
    formatId: 'v1080',
    availableFormats: [{ id: 'v1080', mediaKind: 'video', audioFormatId: 'missing-audio' }],
  }),
  /Requested DASH audio representation not found: missing-audio/,
);

console.log('dash representation selection ok');
