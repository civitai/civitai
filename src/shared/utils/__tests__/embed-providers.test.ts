import { describe, expect, it } from 'vitest';
import {
  embedRenderSrc,
  isAllowedPlayerUrl,
  legacyPreviewSrc,
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
    badPlayers: ['https://w.soundcloud.com/player/?url=https%3A%2F%2Fevil.test%2Fa%2Fb'],
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
    badPlayers: ['https://player.vimeo.com/redirect?to=evil'],
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
    badPlayers: ['https://player.twitch.tv/?video=v1&channel=x'],
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
  const kept = (src: string) =>
    expect(sanitizeHtml(iframe(src))).toContain(`src="${src.replace(/&/g, '&amp;')}"`);

  it.each(SITES)('$provider: keeps the real player iframe', (site) => kept(site.player));

  it('keeps the other real player shapes', () => {
    kept('https://bandcamp.com/EmbeddedPlayer/track=12345/size=large/tracklist=false/');
    kept('https://bandcamp.com/EmbeddedPlayer/v=2/album=9/size=large/');
    kept('https://clips.twitch.tv/embed?clip=FunnyClipSlug-abc');
    kept(
      'https://open.spotify.com/embed/track/4uLU6hMCjMI75M1A2tKUQC?utm_source=generator&theme=0'
    );
  });

  // A real provider host at a non-player path: only the exact-player filter can refuse these
  // (sanitize-html's host list admits them), and it drops the iframe whole.
  it.each([
    ...SITES.flatMap((s) => s.badPlayers.map((url) => ({ provider: s.provider, url }))),
    { provider: 'bandcamp', url: 'https://bandcamp.com/login' },
    { provider: 'bandcamp', url: 'https://bandcamp.com/EmbeddedPlayer/track=1/?x=1' },
    { provider: 'twitch', url: 'https://clips.twitch.tv/other?clip=x' },
  ])('$provider: drops non-player $url', ({ url }) => {
    expect(sanitizeHtml(iframe(url))).toBe('');
  });

  // Each resolves in a browser to a provider host. The player check accepts only a literal
  // `https://host` prefix, so relative, backslash and entity-encoded spellings are refused.
  it.each([
    '//w.soundcloud.com/player/?url=https%3A%2F%2Fsoundcloud.com%2Fa%2Fb',
    '  //w.soundcloud.com/signin',
    '/\\bandcamp.com/login',
    '//player.vimeo.com/video/1',
    '&#x2f;&#x2f;open.spotify.com/login',
    'https:\\\\player.vimeo.com/video/1',
    // Scheme-less: not an absolute https URL, so the player check refuses it.
    'player.twitch.tv/?video=v1',
    // Read as absolute by sanitize-html's host gate, as a same-origin path by a browser.
    'https:/player.vimeo.com/../../user/account',
    'https:player.vimeo.com/../../../user/account',
    'https:open.spotify.com/login',
    '/ /player.vimeo.com/../../user/account',
    // Lookalike hosts: sanitize-html's host list already removes the src.
    'https://w.soundcloud.com.evil.test/player/?url=https%3A%2F%2Fsoundcloud.com%2Fa%2Fb',
    'https://player.vimeo.com.evil.test/video/1',
    'https://player.twitch.tv.evil.test/?video=v1',
  ])('drops relative, backslash or lookalike src %s', (src) => {
    expect(sanitizeHtml(iframe(src))).not.toMatch(/src=/);
  });

  // The value checks read the first value of a key; a player may read a later one.
  it.each([
    'https://player.vimeo.com/video/1?h=ab&h=zz%22',
    'https://player.twitch.tv/?channel=abc&channel=..%2Fx',
    'https://w.soundcloud.com/player/?url=https%3A%2F%2Fsoundcloud.com%2Fa%2Fb&url=https%3A%2F%2Fevil.test%2F',
    'https://open.spotify.com/embed/track/4uLU6hMCjMI75M1A2tKUQC?utm_source=%22%3E%3Cb%3E',
  ])('drops a player src with a repeated or unchecked param %s', (src) => {
    expect(sanitizeHtml(iframe(src))).toBe('');
  });

  // The iframe rules are set after the caller's options, so no caller can widen them.
  it('ignores caller options that would widen the iframe allowlist', () => {
    const widened = {
      allowedIframeHostnames: ['evil.test'],
      allowedIframeDomains: ['evil.test'],
      allowIframeRelativeUrls: true,
    };
    for (const src of ['https://evil.test/x', '/api/x'])
      expect(sanitizeHtml(iframe(src), widened)).not.toMatch(/src=/);
  });

  it('keeps a twitch player after the render-time parent is added', () => {
    for (const src of [
      'https://player.twitch.tv/?video=v1234567890',
      'https://clips.twitch.tv/embed?clip=abc',
    ])
      kept(embedRenderSrc('twitch', src, 'civitai.red'));
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

// Product decision: Hugging Face Spaces are not embeddable. Enabling them is a separate,
// reviewed change; do not loosen this test to get there.
describe('Hugging Face Spaces are not embeddable', () => {
  it('inserts a Space link as a plain link and drops a stored Space iframe', () => {
    expect(
      parseEmbedUrl('https://huggingface.co/spaces/black-forest-labs/FLUX.1-schnell')
    ).toBeNull();
    expect(parseEmbedUrl('https://black-forest-labs-flux-1-schnell.hf.space/')).toBeNull();
    expect(isAllowedPlayerUrl('https://black-forest-labs-flux-1-schnell.hf.space/')).toBeNull();
    expect(sanitizeHtml(iframe('https://black-forest-labs-flux-1-schnell.hf.space/'))).not.toMatch(
      /src=/
    );
  });
});

describe('legacyPreviewSrc', () => {
  it('builds the official embed URL for the dialog preview', () => {
    expect(legacyPreviewSrc('youtube', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(
      'https://www.youtube.com/embed/dQw4w9WgXcQ'
    );
    expect(legacyPreviewSrc('youtube', 'https://youtu.be/dQw4w9WgXcQ')).toBe(
      'https://www.youtube.com/embed/dQw4w9WgXcQ'
    );
    expect(legacyPreviewSrc('instagram', 'https://www.instagram.com/p/COZ3QqYhZ5I')).toBe(
      'https://www.instagram.com/p/COZ3QqYhZ5I/embed'
    );
    expect(legacyPreviewSrc('strawpoll', 'https://strawpoll.com/polls/rae5gcp1')).toBe(
      'https://www.strawpoll.com/embed/rae5gcp1'
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
