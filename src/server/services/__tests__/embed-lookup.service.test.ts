import { describe, expect, it, vi } from 'vitest';
import { findBandcampItem, resolveBandcampEmbed } from '~/server/services/embed-lookup.service';

const PAGE = 'https://artist.bandcamp.com/track/a-song';
const TRACK_HTML =
  '<html><head><meta property="og:video" content="https://bandcamp.com/EmbeddedPlayer/v=2/track=3254853429/size=large/tracklist=false/artwork=small/"></head></html>';

const html = (body: string, headers: Record<string, string> = {}) =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/html', ...headers } });
const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });

function stubFetch(...responses: (Response | Error)[]) {
  const fn = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error('unexpected fetch');
    if (next instanceof Error) throw next;
    return next;
  });
  return fn as unknown as typeof fetch & typeof fn;
}

describe('resolveBandcampEmbed', () => {
  it('builds the player URL from the page item id', async () => {
    const fetchImpl = stubFetch(html(TRACK_HTML));
    await expect(resolveBandcampEmbed(PAGE, fetchImpl)).resolves.toEqual({
      ok: true,
      playerUrl:
        'https://bandcamp.com/EmbeddedPlayer/track=3254853429/size=large/bgcol=333333/linkcol=0f91ff/tracklist=false/artwork=small/transparent=true/',
    });
    expect(fetchImpl).toHaveBeenCalledWith(PAGE, expect.objectContaining({ redirect: 'manual' }));
  });

  it.each([
    'https://bandcamp.com.evil.test/track/a',
    'https://evilbandcamp.com/track/a',
    'http://artist.bandcamp.com/track/a',
    'https://bandcamp.com@evil.test/track/a',
    'https://127.0.0.1/track/a',
  ])('never fetches a non-Bandcamp URL: %s', async (url) => {
    const fetchImpl = stubFetch();
    await expect(resolveBandcampEmbed(url, fetchImpl)).resolves.toEqual({
      ok: false,
      reason: 'invalid-url',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('follows a redirect that stays on Bandcamp', async () => {
    const fetchImpl = stubFetch(redirect('/track/a-song-2'), html(TRACK_HTML));
    await expect(resolveBandcampEmbed(PAGE, fetchImpl)).resolves.toMatchObject({ ok: true });
    expect(fetchImpl).toHaveBeenLastCalledWith(
      'https://artist.bandcamp.com/track/a-song-2',
      expect.anything()
    );
  });

  it.each(['http://169.254.169.254/latest/meta-data/', 'https://evil.test/track/a'])(
    'refuses a redirect off Bandcamp without fetching it: %s',
    async (location) => {
      const fetchImpl = stubFetch(redirect(location));
      await expect(resolveBandcampEmbed(PAGE, fetchImpl)).resolves.toEqual({
        ok: false,
        reason: 'unavailable',
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  );

  it('stops after two redirects', async () => {
    const fetchImpl = stubFetch(
      redirect('/track/b'),
      redirect('/track/c'),
      redirect('/track/d'),
      html(TRACK_HTML)
    );
    await expect(resolveBandcampEmbed(PAGE, fetchImpl)).resolves.toMatchObject({ ok: false });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('refuses a body over the size cap', async () => {
    const big = 'x'.repeat(1_000_001) + TRACK_HTML;
    await expect(resolveBandcampEmbed(PAGE, stubFetch(html(big)))).resolves.toEqual({
      ok: false,
      reason: 'unavailable',
    });
    await expect(
      resolveBandcampEmbed(PAGE, stubFetch(html(TRACK_HTML, { 'content-length': '5000000' })))
    ).resolves.toEqual({ ok: false, reason: 'unavailable' });
  });

  it('reports a bot-challenge page as not found, and a network error as unavailable', async () => {
    await expect(
      resolveBandcampEmbed(PAGE, stubFetch(html('<html>challenge</html>')))
    ).resolves.toEqual({ ok: false, reason: 'not-found' });
    await expect(
      resolveBandcampEmbed(PAGE, stubFetch(new DOMException('timed out', 'TimeoutError')))
    ).resolves.toEqual({ ok: false, reason: 'unavailable' });
  });
});

describe('findBandcampItem', () => {
  it('falls back to bc-page-properties', () => {
    expect(
      findBandcampItem(
        '<meta name="bc-page-properties" content="{&quot;item_type&quot;:&quot;a&quot;,&quot;item_id&quot;:42}">'
      )
    ).toEqual({ type: 'album', id: '42' });
  });
});
