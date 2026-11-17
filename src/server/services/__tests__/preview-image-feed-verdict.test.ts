import { describe, expect, it } from 'vitest';
import { imageFeedVerdict } from '../../../../tests/preview-image-feed.verdict';

describe('the preview smoke verdict (tests/preview-image-feed.verdict.ts)', () => {
  it('rejects an empty page that did not come through the retirement guard', () => {
    expect(imageFeedVerdict({ items: [], nextCursor: undefined, source: 'meili' })).toMatch(
      /source=meili\) answered an empty page/
    );
    expect(imageFeedVerdict({ items: [], source: 'feed' })).toMatch(/source=feed/);
    expect(imageFeedVerdict({ items: [] })).toMatch(/names no known source/);
  });

  it('rejects rows or a cursor under the retired source', () => {
    expect(imageFeedVerdict({ items: [{ id: 1 }], source: 'retired' })).toMatch(/1 item/);
    expect(imageFeedVerdict({ items: [], nextCursor: '5|1', source: 'retired' })).toMatch(
      /nextCursor/
    );
  });

  // A preview deploy has no feed service, so getAllImagesIndex answers from Postgres as `db`.
  it.each(['feed', 'db'])('accepts a real page from %s', (source) => {
    expect(imageFeedVerdict({ items: [{ id: 12097475 }], source })).toBeNull();
  });
});
