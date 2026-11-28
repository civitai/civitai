import { TokenScope } from '~/shared/constants/token-scope.constants';
import { ApiKeyType } from '~/shared/utils/prisma/enums';
import { describe, expect, it } from 'vitest';
import { BlockedReason, NsfwLevel } from '~/server/common/enums';
import { VERIFIED_BOT_HEADER } from '~/server/utils/bot-detection/header';
import {
  canViewImageMedia,
  keepCrawlerAnswerOutOfEdgeCache,
  viewerCanSeeImageMedia,
  withoutMedia,
  withoutMediaReferences,
} from '~/server/utils/image-media-visibility';

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
  } as never as Parameters<typeof viewerCanSeeImageMedia>[0];
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

// What `getImageHandler` returns. A postless image, so no collection lookup reaches the database.
async function withViewerMedia(
  ctx: Parameters<typeof viewerCanSeeImageMedia>[0],
  image: ReturnType<typeof imageAt>
) {
  const canSee = await viewerCanSeeImageMedia(ctx, {
    nsfwLevel: image.nsfwLevel,
    userId: image.user.id,
    postId: null,
    ingestion: 'Scanned',
    blockedFor: null,
  });
  return canSee ? image : withoutMedia(image);
}

describe('image.get media for a viewer', () => {
  it.each(Object.keys(viewers))('gives %s exactly the media its gate shows', async (name) => {
    const received: number[] = [];
    for (const level of LEVELS)
      if ((await withViewerMedia(ctxFor(viewers[name]), imageAt(level))).url === 'media-key')
        received.push(level);
    expect(received).toEqual(expected[name]);
  });

  it('withholds a mixed rating unless every part of it is allowed', async () => {
    const mixed = imageAt(NsfwLevel.PG | NsfwLevel.R);
    expect(
      (await withViewerMedia(ctxFor(viewers['signed out on the SFW domain']), mixed)).url
    ).toBeNull();
    expect(
      (await withViewerMedia(ctxFor(viewers['signed in on the SFW domain']), mixed)).url
    ).toBeNull();
    expect(
      (await withViewerMedia(ctxFor(viewers['signed in on the mature domain']), mixed)).url
    ).toBe('media-key');
  });

  it('keeps what the gate card needs and drops external video ids when withholding', async () => {
    const out = await withViewerMedia(
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

  it('returns a viewer who may see the media the image unchanged', async () => {
    const image = imageAt(NsfwLevel.R);
    expect(await withViewerMedia(ctxFor(viewers['signed in on the mature domain']), image)).toBe(
      image
    );
  });

  it("refuses a blocked image's media to its owner unless the block is exempt; a moderator keeps it", async () => {
    const blocked = (blockedFor: string) => ({
      nsfwLevel: NsfwLevel.PG,
      userId: OWNER_ID,
      postId: null,
      ingestion: 'Blocked',
      blockedFor,
    });
    const owner = ctxFor(viewers['the owner on the SFW domain']);
    const moderator = ctxFor(viewers['a moderator on the SFW domain']);
    expect(await viewerCanSeeImageMedia(owner, blocked(BlockedReason.Moderated))).toBe(false);
    expect(await viewerCanSeeImageMedia(owner, blocked(BlockedReason.AiNotVerified))).toBe(true);
    expect(await viewerCanSeeImageMedia(moderator, blocked(BlockedReason.Moderated))).toBe(true);
  });

  it('applies reviewedBlocks to the owner alone', async () => {
    const reviewed = {
      nsfwLevel: NsfwLevel.PG,
      userId: OWNER_ID,
      postId: null,
      ingestion: 'Blocked',
      blockedFor: BlockedReason.Moderated,
      ownerCsamMarked: false,
    };
    const owner = ctxFor(viewers['the owner on the SFW domain']);
    const stranger = ctxFor(viewers['signed in on the SFW domain']);
    const opts = { reviewedBlocks: true };
    expect(await viewerCanSeeImageMedia(owner, reviewed, opts)).toBe(true);
    expect(await viewerCanSeeImageMedia(stranger, reviewed, opts)).toBe(false);
    expect(await viewerCanSeeImageMedia(owner, { ...reviewed, ownerCsamMarked: true }, opts)).toBe(
      false
    );
  });

  it('keeps a crawler-only answer out of the shared signed-out edge cache', async () => {
    const crawler = ctxFor(viewers['a crawler on the mature domain']);
    await withViewerMedia(crawler, imageAt(NsfwLevel.R));
    expect(crawler.cache).toMatchObject({ edgeTTL: 0, browserTTL: 0, staleWhileRevalidate: 0 });

    // Signed-in answers are never edge-cached; a header on one changes nothing.
    const signedInCrawler = ctxFor({ canViewNsfw: true, user: signedIn, bot: 'googlebot' });
    await withViewerMedia(signedInCrawler, imageAt(NsfwLevel.R));
    expect(signedInCrawler.cache).toMatchObject({ edgeTTL: 60, browserTTL: 60 });

    const human = ctxFor(viewers['signed out on the mature domain']);
    await withViewerMedia(human, imageAt(NsfwLevel.PG));
    expect(human.cache).toMatchObject({ edgeTTL: 60, browserTTL: 60 });
  });
});

describe('keepCrawlerAnswerOutOfEdgeCache', () => {
  const signedOut = (headerValue?: string | string[]) => ({
    req: { headers: headerValue === undefined ? {} : { [VERIFIED_BOT_HEADER]: headerValue } },
    cache: { edgeTTL: 60, browserTTL: 60, staleWhileRevalidate: 30, skip: false },
  });
  const run = (ctx: ReturnType<typeof signedOut>) => {
    keepCrawlerAnswerOutOfEdgeCache(ctx as never);
    return ctx.cache;
  };
  const uncached = { edgeTTL: 0, browserTTL: 0, staleWhileRevalidate: 0 };
  const cached = { edgeTTL: 60, browserTTL: 60, staleWhileRevalidate: 30 };

  it.each([['googlebot'], ['bingbot'], [['bingbot']]])(
    'keeps a signed-out answer to the crawler %j out of the edge cache',
    (value) => {
      expect(run(signedOut(value))).toMatchObject(uncached);
    }
  );

  // Only the values the crawler decision sets count: anything else is a client's guess.
  it.each([[undefined], [''], ['1'], ['true'], ['GoogleBot'], [[]]])(
    'leaves a signed-out answer with header %j cacheable',
    (value) => {
      expect(run(signedOut(value))).toMatchObject(cached);
    }
  );

  it('leaves a signed-in answer with a crawler header cacheable', () => {
    const ctx = { ...signedOut('googlebot'), user: { id: 1 } };
    keepCrawlerAnswerOutOfEdgeCache(ctx as never);
    expect(ctx.cache).toMatchObject(cached);
  });

  it('does nothing for a crawler on a route with no cache context', () => {
    const { req } = signedOut('googlebot');
    expect(() => keepCrawlerAnswerOutOfEdgeCache({ req } as never)).not.toThrow();
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

const KEY_OWNER = 7;
// A capped (SFW) domain: signed in, without canViewNsfw.
const green = { features: { canViewNsfw: false }, req: { headers: {} } };
const mature = { nsfwLevel: NsfwLevel.X, user: { id: KEY_OWNER } };
const key = (tokenScope: bigint) => ({
  apiKeyId: 9,
  apiKeyType: ApiKeyType.User,
  subject: { type: 'apiKey' as const, id: 9 },
  tokenScope,
});

const canSee = (ctx: object) => canViewImageMedia({ ...green, ...ctx } as never, mature);

describe('canViewImageMedia owner and moderator exemption from the domain cap', () => {
  it('lets a moderator and the owner past the cap on a session or a full-access key', () => {
    expect(canSee({ user: { id: 5, isModerator: true } })).toBe(true);
    expect(canSee({ user: { id: KEY_OWNER } })).toBe(true);
    expect(canSee({ user: { id: 5, isModerator: true }, ...key(TokenScope.Full) })).toBe(true);
    expect(canSee({ user: { id: KEY_OWNER }, ...key(TokenScope.Full) })).toBe(true);
  });

  it('holds a moderator or the owner to the cap on a scoped token', () => {
    expect(canSee({ user: { id: 5, isModerator: true }, ...key(TokenScope.ModelsRead) })).toBe(
      false
    );
    expect(canSee({ user: { id: KEY_OWNER }, ...key(TokenScope.ModelsRead) })).toBe(false);
  });

  // A full-scope token an OAuth app holds is still not the user's own credential.
  it('holds a moderator or the owner to the cap on a full-scope OAuth token', () => {
    const oauth = {
      apiKeyId: undefined,
      apiKeyType: undefined,
      subject: { type: 'oauth', id: 'app' },
      tokenScope: TokenScope.Full,
    };
    expect(canSee({ user: { id: 5, isModerator: true }, ...oauth })).toBe(false);
    expect(canSee({ user: { id: KEY_OWNER }, ...oauth })).toBe(false);
  });

  it('holds anyone else to the cap', () => {
    expect(canSee({ user: { id: 6 } })).toBe(false);
    expect(canSee({})).toBe(false);
  });
});

describe('canViewImageMedia on a capped domain', () => {
  const stranger = { ...green, user: { id: 6 } } as never;
  const rated = (nsfwLevel: number) => ({ nsfwLevel, user: { id: KEY_OWNER } });

  it('keeps a mixed rating wholly inside the cap', () => {
    expect(canViewImageMedia(stranger, rated(NsfwLevel.PG | NsfwLevel.PG13))).toBe(true);
  });

  it('withholds an unrated image and a mixed rating that reaches above the cap', () => {
    expect(canViewImageMedia(stranger, rated(0))).toBe(false);
    expect(canViewImageMedia(stranger, rated(NsfwLevel.PG | NsfwLevel.R))).toBe(false);
  });
});
