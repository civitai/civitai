import { describe, expect, it } from 'vitest';
import {
  embedRenderSrc,
  isAllowedPlayerUrl,
  parseBandcampPageUrl,
  parseEmbedUrl,
} from '~/shared/utils/embed-providers';
import { sanitizeHtml } from '~/utils/html-sanitize-helpers';

const iframe = (src: string) => `<iframe src="${src}"></iframe>`;

// One row per site: a real page URL, the player URL it must become, and lookalikes that must be
// refused. Every lookalike is a host-rule bypass (suffix, prefix, userinfo), not a typo.
const SITES = [
  {
    provider: 'soundcloud',
    page: 'https://soundcloud.com/forss/flickermood',
    player:
      'https://w.soundcloud.com/player/?url=https%3A%2F%2Fsoundcloud.com%2Fforss%2Fflickermood',
    lookalikes: [
      'https://evilsoundcloud.com/forss/flickermood',
      'https://soundcloud.com.evil.test/forss/flickermood',
      'https://soundcloud.com@evil.test/forss/flickermood',
    ],
    badPlayers: [
      'https://w.soundcloud.com.evil.test/player/?url=https%3A%2F%2Fsoundcloud.com%2Fa%2Fb',
      'https://w.soundcloud.com/player/?url=https%3A%2F%2Fevil.test%2Fa%2Fb',
    ],
  },
  {
    provider: 'spotify',
    page: 'https://open.spotify.com/intl-de/track/4cOdK2wGLETKBW3PvgPWqT?si=abc',
    player: 'https://open.spotify.com/embed/track/4cOdK2wGLETKBW3PvgPWqT',
    lookalikes: [
      'https://open.spotify.com.evil.test/track/4cOdK2wGLETKBW3PvgPWqT',
      'https://evilopen.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT',
      'https://open.spotify.com@evil.test/track/4cOdK2wGLETKBW3PvgPWqT',
    ],
    badPlayers: [
      'https://open.spotify.com/embed/../user/x',
      'http://open.spotify.com/embed/track/4cOdK2wGLETKBW3PvgPWqT',
    ],
  },
  {
    provider: 'vimeo',
    page: 'https://vimeo.com/76979871/abc123',
    player: 'https://player.vimeo.com/video/76979871?h=abc123',
    lookalikes: [
      'https://evilvimeo.com/76979871',
      'https://vimeo.com.evil.test/76979871',
      'https://vimeo.com@evil.test/76979871',
    ],
    badPlayers: [
      'https://player.vimeo.com/redirect?to=evil',
      'https://player.vimeo.com.evil.test/video/1',
    ],
  },
  {
    provider: 'twitch',
    page: 'https://www.twitch.tv/videos/1234567890',
    player: 'https://player.twitch.tv/?video=v1234567890',
    lookalikes: [
      'https://eviltwitch.tv/videos/1234567890',
      'https://twitch.tv.evil.test/videos/1234567890',
      'https://twitch.tv@evil.test/videos/1234567890',
    ],
    badPlayers: [
      'https://player.twitch.tv/?video=v1&channel=x',
      'https://player.twitch.tv.evil.test/?video=v1',
    ],
  },
  {
    provider: 'huggingface',
    page: 'https://huggingface.co/spaces/black-forest-labs/FLUX.1-schnell',
    player: 'https://black-forest-labs-flux-1-schnell.hf.space/',
    lookalikes: [
      'https://evilhuggingface.co/spaces/a/b',
      'https://huggingface.co.evil.test/spaces/a/b',
      'https://x.hf.space.evil.test/',
      'https://huggingface.co@evil.test/spaces/a/b',
    ],
    badPlayers: ['https://a.b.hf.space/', 'https://evilhf.space/', 'https://x.hf.space/login'],
  },
] as const;

describe('parseEmbedUrl', () => {
  it.each(SITES)('$provider: a page URL becomes the official player URL', (site) => {
    expect(parseEmbedUrl(site.page)).toEqual({
      kind: 'embed',
      provider: site.provider,
      playerUrl: site.player,
    });
    expect(isAllowedPlayerUrl(site.player)).toBe(site.provider);
  });

  it.each(SITES.flatMap((s) => s.lookalikes.map((url) => ({ provider: s.provider, url }))))(
    '$provider: refuses lookalike $url',
    ({ url }) => {
      expect(parseEmbedUrl(url)).toBeNull();
    }
  );

  it('maps twitch clips and channels', () => {
    expect(parseEmbedUrl('https://clips.twitch.tv/FunnyClipSlug-abc')).toMatchObject({
      playerUrl: 'https://clips.twitch.tv/embed?clip=FunnyClipSlug-abc',
    });
    expect(parseEmbedUrl('https://www.twitch.tv/somechannel')).toMatchObject({
      playerUrl: 'https://player.twitch.tv/?channel=somechannel',
    });
    expect(parseEmbedUrl('https://www.twitch.tv/directory')).toBeNull();
  });

  it('defers Bandcamp pages to the server lookup, and refuses lookalikes', () => {
    expect(parseEmbedUrl('https://artist.bandcamp.com/track/a-song')).toEqual({
      kind: 'bandcamp-lookup',
      pageUrl: 'https://artist.bandcamp.com/track/a-song',
    });
    for (const url of [
      'https://bandcamp.com.evil.test/track/a',
      'https://evilbandcamp.com/track/a',
      'https://a.b.bandcamp.com/track/a',
      'https://bandcamp.com@evil.test/track/a',
      'https://artist.bandcamp.com:8443/track/a',
    ])
      expect(parseEmbedUrl(url), url).toBeNull();
    expect(parseBandcampPageUrl('http://artist.bandcamp.com/track/a')).toBeNull();
  });

  it('routes the legacy sites to their own nodes by exact host', () => {
    expect(parseEmbedUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')?.kind).toBe('youtube');
    expect(parseEmbedUrl('https://www.instagram.com/p/COZ3QqYhZ5I')?.kind).toBe('instagram');
    expect(parseEmbedUrl('https://strawpoll.com/polls/rae5gcp1')?.kind).toBe('strawpoll');
    expect(parseEmbedUrl('https://evilinstagram.com/p/COZ3QqYhZ5I')).toBeNull();
    expect(parseEmbedUrl('https://youtube.com.evil.test/watch?v=x')).toBeNull();
  });

  it('returns null for an ordinary link so it is inserted as a link', () => {
    expect(parseEmbedUrl('https://example.com/article')).toBeNull();
    expect(parseEmbedUrl('javascript:alert(1)')).toBeNull();
  });
});

describe('sanitizeHtml embed iframes', () => {
  it.each(SITES)('$provider: keeps the real player iframe', (site) => {
    expect(sanitizeHtml(iframe(site.player))).toContain(
      `src="${site.player.replace(/&/g, '&amp;')}"`
    );
  });

  it('keeps a real Bandcamp player iframe', () => {
    const src = 'https://bandcamp.com/EmbeddedPlayer/track=12345/size=large/tracklist=false/';
    expect(sanitizeHtml(iframe(src))).toContain(src);
  });

  it.each(
    SITES.flatMap((s) => s.badPlayers.map((url) => ({ provider: s.provider, url }))).concat([
      { provider: 'bandcamp', url: 'https://bandcamp.com/login' },
      { provider: 'bandcamp', url: 'https://bandcamp.com.evil.test/EmbeddedPlayer/track=1/' },
    ] as never)
  )('$provider: strips lookalike player $url', ({ url }) => {
    expect(sanitizeHtml(iframe(url))).not.toContain('src=');
  });

  it('strips stored allow and sandbox attributes', () => {
    const out = sanitizeHtml(
      '<iframe src="https://player.vimeo.com/video/1" allow="camera; microphone" sandbox=""></iframe>'
    );
    expect(out).toContain('src="https://player.vimeo.com/video/1"');
    expect(out).not.toContain('allow=');
    expect(out).not.toContain('sandbox');
  });
});

describe('embedRenderSrc', () => {
  it('sets twitch parent from the request host, overwriting any stored one', () => {
    expect(
      embedRenderSrc(
        'twitch',
        'https://player.twitch.tv/?video=v1&parent=evil.test',
        'civitai.red:443'
      )
    ).toBe('https://player.twitch.tv/?video=v1&parent=civitai.red');
    expect(embedRenderSrc('twitch', 'https://clips.twitch.tv/embed?clip=x', undefined)).toBe(
      'https://clips.twitch.tv/embed?clip=x&parent=civitai.com'
    );
  });
});

describe('Bandcamp embed code', () => {
  it('accepts the Share → Embed snippet without a lookup', () => {
    const snippet =
      '<iframe style="border: 0; width: 100%; height: 120px;" src="https://bandcamp.com/EmbeddedPlayer/album=1234567/size=large/bgcol=ffffff/linkcol=0687f5/tracklist=false/artwork=small/transparent=true/" seamless><a href="https://artist.bandcamp.com/album/x">x</a></iframe>';
    expect(parseEmbedUrl(snippet)).toEqual({
      kind: 'embed',
      provider: 'bandcamp',
      playerUrl:
        'https://bandcamp.com/EmbeddedPlayer/album=1234567/size=large/bgcol=333333/linkcol=0f91ff/tracklist=false/artwork=small/transparent=true/',
    });
  });

  it('holds a snippet to the same host rules', () => {
    expect(
      parseEmbedUrl(
        '<iframe src="https://bandcamp.com.evil.test/EmbeddedPlayer/album=1/"></iframe>'
      )
    ).toBeNull();
    expect(parseEmbedUrl('<iframe src="https://evil.test/"></iframe>')).toBeNull();
  });
});
