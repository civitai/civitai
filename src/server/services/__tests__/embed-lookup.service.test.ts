import { describe, expect, it, vi } from 'vitest';
import {
  BANDCAMP_FETCH_OPTIONS,
  findBandcampItem,
  resolveBandcampEmbed,
} from '~/server/services/embed-lookup.service';
import { SafeFetchError } from '~/server/utils/safe-fetch';
import { isAllowedPlayerUrl } from '~/shared/utils/embed-providers';
import { sanitizeHtml } from '~/utils/html-sanitize-helpers';

const PAGE = 'https://artist.bandcamp.com/track/a-song';
const TRACK_HTML =
  '<meta property="og:video" content="https://bandcamp.com/EmbeddedPlayer/v=2/track=3254853429/size=large/tracklist=false/artwork=small/">';

const page = (html: string) =>
  vi.fn(async () => ({ finalUrl: PAGE, contentType: 'text/html', bytes: Buffer.from(html) }));

describe('resolveBandcampEmbed', () => {
  it('returns a player URL the sanitizer keeps', async () => {
    const result = await resolveBandcampEmbed(PAGE, page(TRACK_HTML));
    if (!result.ok) throw new Error(`lookup failed: ${result.reason}`);
    expect(result.playerUrl).toContain('/EmbeddedPlayer/track=3254853429/');
    expect(isAllowedPlayerUrl(result.playerUrl)).toBe('bandcamp');
    expect(sanitizeHtml(`<iframe src="${result.playerUrl}"></iframe>`)).toContain(result.playerUrl);
  });

  it.each([
    'https://bandcamp.com.evil.test/track/a',
    'https://evilbandcamp.com/track/a',
    'http://artist.bandcamp.com/track/a',
    'https://bandcamp.com@evil.test/track/a',
    'https://127.0.0.1/track/a',
  ])('never fetches a non-Bandcamp URL: %s', async (url) => {
    const fetchPage = page(TRACK_HTML);
    await expect(resolveBandcampEmbed(url, fetchPage)).resolves.toEqual({
      ok: false,
      reason: 'invalid-url',
    });
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it('reports a page with no item id as not found, and a fetch error as unavailable', async () => {
    await expect(resolveBandcampEmbed(PAGE, page('<html>challenge</html>'))).resolves.toEqual({
      ok: false,
      reason: 'not-found',
    });
    const failing = vi.fn(async () => {
      throw new SafeFetchError('timeout', 'timed out');
    });
    await expect(resolveBandcampEmbed(PAGE, failing)).resolves.toEqual({
      ok: false,
      reason: 'unavailable',
    });
  });
});

// safeFetch checks allowUrl on every hop (its own suite pins the redirect case); this pins what we pass it.
describe('BANDCAMP_FETCH_OPTIONS.allowUrl', () => {
  const allow = (url: string) => BANDCAMP_FETCH_OPTIONS.allowUrl?.(new URL(url));

  it('keeps every hop on Bandcamp', () => {
    expect(allow('https://artist.bandcamp.com/album/x')).toBe(true);
    for (const url of [
      'https://evil.test/track/a',
      'https://169.254.169.254/track/a',
      'http://artist.bandcamp.com/track/a',
      'https://bandcamp.com.evil.test/track/a',
    ])
      expect(allow(url), url).toBe(false);
  });
});

describe('findBandcampItem', () => {
  it('falls back to bc-page-properties', () => {
    const props = (type: string) =>
      `<meta name="bc-page-properties" content="{&quot;item_type&quot;:&quot;${type}&quot;,&quot;item_id&quot;:42}">`;
    expect(findBandcampItem(props('a'))).toEqual({ type: 'album', id: '42' });
    expect(findBandcampItem(props('t'))).toEqual({ type: 'track', id: '42' });
  });
});
