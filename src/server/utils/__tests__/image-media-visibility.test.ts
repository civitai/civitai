import { describe, expect, it } from 'vitest';
import { NsfwLevel } from '~/server/common/enums';
import { VERIFIED_BOT_HEADER } from '~/server/utils/bot-detection/header';
import { withoutMediaReferences, withViewerMedia } from '~/server/utils/image-media-visibility';

const OWNER_ID = 7;

type Viewer = {
  user?: { id: number; isModerator?: boolean };
  canViewNsfw: boolean;
  bot?: 'googlebot';
};

function ctxFor({ user, canViewNsfw, bot }: Viewer) {
  return {
    user,
    features: { canViewNsfw },
    req: { headers: bot ? { [VERIFIED_BOT_HEADER]: bot } : {} },
    cache: { edgeTTL: 60, browserTTL: 60, staleWhileRevalidate: 30, skip: false },
  } as never as Parameters<typeof withViewerMedia>[0];
}

function imageAt(nsfwLevel: number) {
  return {
    id: 1,
    url: 'media-key',
    hash: 'blur-hash',
    nsfwLevel,
    metadata: { width: 512, height: 512, youtubeVideoId: 'yt', vimeoVideoId: 'vm', duration: 3 },
    user: { id: OWNER_ID },
  };
}

const signedIn = { id: 99 };
const viewers: Record<string, Viewer> = {
  'signed out on the SFW domain': { canViewNsfw: false },
  'signed out on the mature domain': { canViewNsfw: true },
  'a crawler on the SFW domain': { canViewNsfw: false, bot: 'googlebot' },
  'a crawler on the mature domain': { canViewNsfw: true, bot: 'googlebot' },
  'signed in on the SFW domain': { canViewNsfw: false, user: signedIn },
  'signed in on the mature domain': { canViewNsfw: true, user: signedIn },
  'the owner on the SFW domain': { canViewNsfw: false, user: { id: OWNER_ID } },
  'a moderator on the SFW domain': { canViewNsfw: false, user: { id: 5, isModerator: true } },
};

// Rating levels whose media each viewer receives.
const expected: Record<string, number[]> = {
  'signed out on the SFW domain': [NsfwLevel.PG],
  'signed out on the mature domain': [NsfwLevel.PG],
  'a crawler on the SFW domain': [NsfwLevel.PG],
  'a crawler on the mature domain': [
    0,
    NsfwLevel.PG,
    NsfwLevel.PG13,
    NsfwLevel.R,
    NsfwLevel.X,
    NsfwLevel.XXX,
  ],
  'signed in on the SFW domain': [NsfwLevel.PG, NsfwLevel.PG13],
  'signed in on the mature domain': [
    0,
    NsfwLevel.PG,
    NsfwLevel.PG13,
    NsfwLevel.R,
    NsfwLevel.X,
    NsfwLevel.XXX,
  ],
  'the owner on the SFW domain': [
    0,
    NsfwLevel.PG,
    NsfwLevel.PG13,
    NsfwLevel.R,
    NsfwLevel.X,
    NsfwLevel.XXX,
  ],
  'a moderator on the SFW domain': [
    0,
    NsfwLevel.PG,
    NsfwLevel.PG13,
    NsfwLevel.R,
    NsfwLevel.X,
    NsfwLevel.XXX,
  ],
};

const LEVELS = [0, NsfwLevel.PG, NsfwLevel.PG13, NsfwLevel.R, NsfwLevel.X, NsfwLevel.XXX];

describe('withViewerMedia', () => {
  it.each(Object.keys(viewers))('gives %s exactly the media its gate shows', (name) => {
    const received = LEVELS.filter(
      (level) => withViewerMedia(ctxFor(viewers[name]), imageAt(level)).url === 'media-key'
    );
    expect(received).toEqual(expected[name]);
  });

  it('withholds a mixed rating unless every part of it is allowed', () => {
    const mixed = imageAt(NsfwLevel.PG | NsfwLevel.R);
    expect(withViewerMedia(ctxFor(viewers['signed out on the SFW domain']), mixed).url).toBeNull();
    expect(withViewerMedia(ctxFor(viewers['signed in on the SFW domain']), mixed).url).toBeNull();
    expect(withViewerMedia(ctxFor(viewers['signed in on the mature domain']), mixed).url).toBe(
      'media-key'
    );
  });

  it('keeps what the gate card needs and drops external video ids when withholding', () => {
    const out = withViewerMedia(
      ctxFor(viewers['signed out on the SFW domain']),
      imageAt(NsfwLevel.R)
    );
    expect(out).toEqual({
      id: 1,
      url: null,
      hash: 'blur-hash',
      nsfwLevel: NsfwLevel.R,
      metadata: { width: 512, height: 512, duration: 3 },
      user: { id: OWNER_ID },
    });
  });

  it('returns a viewer who may see the media the image unchanged', () => {
    const image = imageAt(NsfwLevel.R);
    expect(withViewerMedia(ctxFor(viewers['signed in on the mature domain']), image)).toBe(image);
  });

  it('keeps a crawler-only answer out of the shared signed-out edge cache', () => {
    const crawler = ctxFor(viewers['a crawler on the mature domain']);
    withViewerMedia(crawler, imageAt(NsfwLevel.R));
    expect(crawler.cache).toMatchObject({ edgeTTL: 0, browserTTL: 0, staleWhileRevalidate: 0 });

    // Signed-in answers are never edge-cached; a header on one changes nothing.
    const signedInCrawler = ctxFor({ canViewNsfw: true, user: signedIn, bot: 'googlebot' });
    withViewerMedia(signedInCrawler, imageAt(NsfwLevel.R));
    expect(signedInCrawler.cache).toMatchObject({ edgeTTL: 60, browserTTL: 60 });

    const human = ctxFor(viewers['signed out on the mature domain']);
    withViewerMedia(human, imageAt(NsfwLevel.PG));
    expect(human.cache).toMatchObject({ edgeTTL: 60, browserTTL: 60 });
  });
});

describe('withoutMediaReferences', () => {
  it.each([
    ['an entry holding a url, whole', { a: { url: 'https://x/a.png', w: 1 }, b: 1 }, { b: 1 }],
    ['a root url, leaving the rest', { url: 'https://x/a.png', prompt: 'p' }, { prompt: 'p' }],
    ['a link in any case', { x: 'HTTPS://x/a.png', y: 'Data:image/png;base64,AA' }, {}],
    ['a padded data URI', { mask: '  data:image/png;base64,AA  ' }, {}],
    ['a protocol-relative link', { thumb: '//image.example/a.png' }, {}],
    ['bare links inside nested arrays', { a: [['https://x/a.png', 'keep']] }, { a: [['keep']] }],
    ['a prompt that is only a link', { prompt: 'https://x/a.png' }, {}],
    ['a comfy graph, as text or object', { comfy: '{"a":1}', ComfyUI: { nodes: [] } }, {}],
    [
      'a workflow graph',
      { a: { workflow: { nodes: [] } }, b: { workflow: ' {"a":1}' } },
      { a: {}, b: {} },
    ],
  ])('drops %s', (_label, input, expected) => {
    expect(withoutMediaReferences(input)).toEqual(expected);
  });

  it.each([
    ['a workflow name', { workflow: 'txt2img:face-fix' }],
    ['a link inside text', { prompt: 'see https://x/a.png for more' }],
    ['a non-string url field', { url: null, n: 1 }],
    ['settings', { steps: 30, cfgScale: 7, sampler: 'Euler a', extra: { sourceImageIds: [1] } }],
  ])('keeps %s', (_label, input) => {
    expect(withoutMediaReferences(input)).toEqual(input);
  });

  it('does not change its input', () => {
    const input = { images: [{ url: 'https://x/a.png' }], prompt: 'p' };
    const copy = structuredClone(input);
    withoutMediaReferences(input);
    expect(input).toEqual(copy);
  });
});
