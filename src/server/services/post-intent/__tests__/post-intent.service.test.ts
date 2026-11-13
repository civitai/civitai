import { Prisma } from '@prisma/client';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as BlockPostService from '~/server/services/blocks/block-post.service';
import type * as ImageService from '~/server/services/image.service';
import type * as TagService from '~/server/services/tag.service';
import type * as ToolService from '~/server/services/tool.service';
import type * as VideoDimensions from '~/server/services/video-dimensions';
import type * as S3Utils from '~/utils/s3-utils';

const { requestMock, lookupMock, createImageMock, uploadMock, deleteManyMock, probeMock } =
  vi.hoisted(() => {
    // Before the static imports: `server-domain.ts` reads these at import time.
    process.env.SERVER_DOMAIN_BLUE = 'civitai.com';
    process.env.SERVER_DOMAIN_RED = 'civitai.red';
    return {
      requestMock: vi.fn(),
      lookupMock: vi.fn(),
      createImageMock: vi.fn(),
      uploadMock: vi.fn(),
      deleteManyMock: vi.fn(),
      probeMock: vi.fn(),
    };
  });

vi.mock('node:dns/promises', () => ({ lookup: lookupMock }));
vi.mock('sharp', () => ({
  default: () => ({ metadata: async () => ({ width: 1080, height: 1920 }) }),
}));
vi.mock('node:https', () => ({ default: { request: requestMock } }));
vi.mock('~/utils/s3-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof S3Utils>()),
  uploadImageBufferToStore: uploadMock,
  deleteManyObjects: deleteManyMock,
  getImageUploadBackend: vi.fn().mockResolvedValue({ s3: {}, bucket: 'images' }),
}));
vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  createImage: createImageMock,
}));
vi.mock('~/server/services/video-dimensions', async (importOriginal) => ({
  ...(await importOriginal<typeof VideoDimensions>()),
  probeVideoDimensions: probeMock,
}));
vi.mock('~/server/services/tag.service', async (importOriginal) => ({
  ...(await importOriginal<typeof TagService>()),
  findOrCreateTagsByName: vi.fn().mockResolvedValue({ games: 77 }),
}));
vi.mock('~/server/services/tool.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ToolService>()),
  getToolByName: vi.fn().mockResolvedValue(null),
  getToolByDomain: vi.fn().mockResolvedValue(null),
}));
vi.mock('~/server/services/blocks/block-post.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BlockPostService>()),
  applyBlockPostPublishEffects: vi.fn().mockResolvedValue(undefined),
}));

const { publishIntent, stageIntent, sweepExpiredIntentClaims } = await import(
  '~/server/services/post-intent/post-intent.service'
);

const APP_ID = 'game-frame-client';
const MANIFEST_URL = 'https://games.civitai.com/api/share/sh_1.json';
const MEDIA_URL = 'https://games.civitai.com/api/share/sh_1/still.png';
const now = new Date('2026-10-26T12:00:00Z');

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(16).fill(0)]);

const manifestJson = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    app: APP_ID,
    media: [{ url: MEDIA_URL }],
    title: 'Pictionary',
    returnUrl: 'https://games.civitai.com/?reel=A',
    ...over,
  });

type FakeResponse = { status?: number; headers?: Record<string, string>; body?: Buffer | string };

/** Each https.request call takes the next response; the requested paths are recorded. */
function serve(...responses: FakeResponse[]) {
  const requested: string[] = [];
  let i = 0;
  requestMock.mockImplementation((options: any, cb: (res: unknown) => void) => {
    requested.push(`${options.hostname}${options.path}`);
    const req = Object.assign(new EventEmitter(), {
      end: () => undefined,
      destroy: () => undefined,
    });
    req.end = () => {
      const r = responses[i++] ?? { status: 404 };
      const body = r.body === undefined ? [] : [Buffer.from(r.body)];
      const stream = Object.assign(Readable.from(body), {
        statusCode: r.status ?? 200,
        headers: r.headers ?? {},
      });
      queueMicrotask(() => cb(stream));
    };
    return req;
  });
  return requested;
}

function approveGamesHost() {
  dbMock.dbRead.appPostIntent.findMany.mockResolvedValue([
    { listingId: 'apl_games', host: 'games.civitai.com', pathPrefix: '/api/share/' },
  ]);
  dbMock.dbRead.appListing.findFirst.mockResolvedValue({
    name: 'Civitai Games',
    connectClientId: APP_ID,
    appBlock: null,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  redisMock.redis.incrBy.mockResolvedValue(1);
  redisMock.redis.eval.mockResolvedValue(1);
  uploadMock.mockImplementation(async () => ({ key: `key-${uploadMock.mock.calls.length}` }));
  deleteManyMock.mockResolvedValue(undefined);
  createImageMock.mockImplementation(async () => ({ id: 500 + createImageMock.mock.calls.length }));
  dbMock.dbWrite.postIntentManifest.findUnique.mockResolvedValue(null);
  dbMock.dbWrite.postIntentManifest.create.mockResolvedValue({ id: 1 });
  approveGamesHost();
});

describe('stageIntent', () => {
  it('stages an approved manifest without creating any image row', async () => {
    serve(
      { headers: { 'content-type': 'application/json' }, body: manifestJson() },
      { headers: { 'content-type': 'image/png' }, body: PNG }
    );
    const staged = await stageIntent({ manifestUrl: MANIFEST_URL, userId: 7, now });

    expect(staged.app.name).toBe('Civitai Games');
    expect(staged.media).toEqual([{ url: MEDIA_URL, type: 'image' }]);
    expect(createImageMock).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.postIntentManifest.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ manifestUrl: MANIFEST_URL, appId: APP_ID, userId: 7 }),
    });
  });

  it('refuses a host nobody approved, even when the manifest names a real app, before any fetch', async () => {
    dbMock.dbRead.appPostIntent.findMany.mockResolvedValue([]);
    const requested = serve({ body: manifestJson() });
    await expect(
      stageIntent({ manifestUrl: 'https://evil.example/api/share/x.json', userId: 7, now })
    ).rejects.toMatchObject({ code: 'not-approved' });
    expect(requested).toEqual([]);
  });

  it('refuses a manifest URL on the approved host but outside its prefix, before any fetch', async () => {
    const requested = serve({ body: manifestJson() });
    await expect(
      stageIntent({ manifestUrl: 'https://games.civitai.com/uploads/x.json', userId: 7, now })
    ).rejects.toMatchObject({ code: 'not-approved' });
    expect(requested).toEqual([]);
  });

  it('refuses a manifest that claims another app id, staging nothing', async () => {
    serve({
      headers: { 'content-type': 'application/json' },
      body: manifestJson({ app: 'other' }),
    });
    await expect(stageIntent({ manifestUrl: MANIFEST_URL, userId: 7, now })).rejects.toMatchObject({
      code: 'app-mismatch',
    });
    expect(uploadMock).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.postIntentManifest.create).not.toHaveBeenCalled();
  });

  it('refuses a redirect instead of following it', async () => {
    const requested = serve(
      { status: 302, headers: { location: 'https://games.civitai.com/api/share/other.json' } },
      { headers: { 'content-type': 'application/json' }, body: manifestJson() }
    );
    await expect(stageIntent({ manifestUrl: MANIFEST_URL, userId: 7, now })).rejects.toMatchObject({
      code: 'fetch-failed',
    });
    expect(requested).toHaveLength(1);
  });

  it.each([
    ['a private address', '10.0.0.5', 4],
    ['loopback', '127.0.0.1', 4],
    ['the metadata address', '169.254.169.254', 4],
    ['IPv6 loopback', '::1', 6],
  ])('refuses a host that resolves to %s without connecting', async (_label, address, family) => {
    lookupMock.mockResolvedValue([{ address, family }]);
    const requested = serve({ body: manifestJson() });
    await expect(stageIntent({ manifestUrl: MANIFEST_URL, userId: 7, now })).rejects.toMatchObject({
      code: 'fetch-failed',
    });
    expect(requested).toEqual([]);
  });

  it('pins the connection to the address it checked', async () => {
    serve({ headers: { 'content-type': 'application/json' }, body: manifestJson() }, { body: PNG });
    await stageIntent({ manifestUrl: MANIFEST_URL, userId: 7, now });
    const options = requestMock.mock.calls[0][0];
    const pinned = await new Promise((resolve) =>
      options.lookup('games.civitai.com', {}, (_e: unknown, address: string) => resolve(address))
    );
    expect(pinned).toBe('93.184.216.34');
  });

  it('refuses a file whose bytes are not a supported image or video, and deletes what it stored', async () => {
    serve(
      {
        headers: { 'content-type': 'application/json' },
        body: manifestJson({
          media: [{ url: MEDIA_URL }, { url: 'https://games.civitai.com/api/share/sh_1/b.png' }],
        }),
      },
      { body: PNG },
      { headers: { 'content-type': 'image/png' }, body: '<html>not an image</html>' }
    );
    await expect(stageIntent({ manifestUrl: MANIFEST_URL, userId: 7, now })).rejects.toMatchObject({
      code: 'unsupported-media',
    });
    expect(deleteManyMock).toHaveBeenCalledWith('images', ['key-1'], {});
  });

  it('refuses a video over the site length limit', async () => {
    const MP4 = Buffer.from([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, ...new Array(16).fill(0)]);
    probeMock.mockResolvedValue({ width: 1080, height: 1920, duration: 300 });
    serve(
      {
        headers: { 'content-type': 'application/json' },
        body: manifestJson({ media: [{ url: 'https://games.civitai.com/api/share/sh_1/r.mp4' }] }),
      },
      { body: MP4 }
    );
    await expect(stageIntent({ manifestUrl: MANIFEST_URL, userId: 7, now })).rejects.toMatchObject({
      code: 'video-limits',
    });
    expect(dbMock.dbWrite.postIntentManifest.create).not.toHaveBeenCalled();
  });

  it('refuses a manifest that was already posted, for any user', async () => {
    dbMock.dbWrite.postIntentManifest.findUnique.mockResolvedValue({
      id: 1,
      userId: 7,
      postedAt: now,
      claimExpiresAt: new Date(now.getTime() + 1000),
    });
    const requested = serve();
    for (const userId of [7, 8]) {
      await expect(stageIntent({ manifestUrl: MANIFEST_URL, userId, now })).rejects.toMatchObject({
        code: 'already-posted',
      });
    }
    expect(requested).toEqual([]);
  });

  it("refuses another user while the first user's claim is live", async () => {
    dbMock.dbWrite.postIntentManifest.findUnique.mockResolvedValue({
      id: 1,
      userId: 7,
      postedAt: null,
      claimExpiresAt: new Date(now.getTime() + 1000),
      manifest: {},
      staged: [],
    });
    await expect(stageIntent({ manifestUrl: MANIFEST_URL, userId: 8, now })).rejects.toMatchObject({
      code: 'claimed',
    });
  });

  it('stops staging once the per-user limit is spent', async () => {
    redisMock.redis.incrBy.mockResolvedValue(21);
    const requested = serve({ body: manifestJson() });
    await expect(stageIntent({ manifestUrl: MANIFEST_URL, userId: 7, now })).rejects.toMatchObject({
      code: 'rate-limited',
    });
    expect(requested).toEqual([]);
  });
});

describe('stageIntent: one manifest, one key', () => {
  const postedOnlyForCanonical = () =>
    dbMock.dbWrite.postIntentManifest.findUnique.mockImplementation(async (args: any) =>
      args.where.manifestUrl === MANIFEST_URL
        ? { id: 1, userId: 7, postedAt: now, claimExpiresAt: now, manifest: {}, staged: [] }
        : null
    );

  it.each([
    ['a fragment', `${MANIFEST_URL}#again`],
    ['an upper-case host', MANIFEST_URL.replace('games.civitai.com', 'GAMES.Civitai.COM')],
  ])('treats %s as the same manifest', async (_label, variant) => {
    postedOnlyForCanonical();
    const requested = serve({ body: manifestJson() });
    await expect(stageIntent({ manifestUrl: variant, userId: 8, now })).rejects.toMatchObject({
      code: 'already-posted',
    });
    expect(requested).toEqual([]);
  });

  it.each([
    ['a query', `${MANIFEST_URL}?a=1`],
    ['percent-encoding', MANIFEST_URL.replace('sh_1', 'sh%5F1')],
  ])('refuses a manifest link with %s', async (_label, variant) => {
    const requested = serve({ body: manifestJson() });
    await expect(stageIntent({ manifestUrl: variant, userId: 7, now })).rejects.toMatchObject({
      code: 'bad-manifest',
    });
    expect(requested).toEqual([]);
  });

  it('stores only the canonical form', async () => {
    serve({ headers: { 'content-type': 'application/json' }, body: manifestJson() }, { body: PNG });
    await stageIntent({ manifestUrl: `${MANIFEST_URL}#x`, userId: 7, now });
    expect(dbMock.dbWrite.postIntentManifest.create.mock.calls[0][0].data.manifestUrl).toBe(
      MANIFEST_URL
    );
  });

  it('refuses while another staging for the user is in flight, before any fetch', async () => {
    redisMock.redis.set.mockResolvedValueOnce(null);
    const requested = serve({ body: manifestJson() });
    await expect(stageIntent({ manifestUrl: MANIFEST_URL, userId: 7, now })).rejects.toMatchObject({
      code: 'busy',
    });
    expect(requested).toEqual([]);
  });

  const lockKeys = () => redisMock.redis.set.mock.calls.map((c: unknown[]) => String(c[0]));
  const releasedTokens = () =>
    redisMock.redis.eval.mock.calls.map((c: any[]) => [String(c[1].keys[0]), c[1].arguments[0]]);
  const heldTokens = () => redisMock.redis.set.mock.calls.map((c: any[]) => [String(c[0]), c[1]]);

  it('refuses while the same manifest is staging for someone, and frees the user lock', async () => {
    redisMock.redis.set.mockResolvedValueOnce('OK').mockResolvedValueOnce(null);
    const requested = serve({ body: manifestJson() });
    await expect(stageIntent({ manifestUrl: MANIFEST_URL, userId: 7, now })).rejects.toMatchObject({
      code: 'busy',
    });
    expect(requested).toEqual([]);
    expect(lockKeys()[1]).toContain(`url:${MANIFEST_URL}`);
    expect(releasedTokens()).toEqual([heldTokens()[0]]);
  });

  it.each([
    [
      'succeeds',
      () =>
        serve(
          { headers: { 'content-type': 'application/json' }, body: manifestJson() },
          { body: PNG }
        ),
    ],
    ['fails', () => serve({ status: 302, headers: { location: 'https://games.civitai.com/x' } })],
  ])('releases both locks, with their own tokens, when staging %s', async (_label, prime) => {
    prime();
    await stageIntent({ manifestUrl: MANIFEST_URL, userId: 7, now }).catch(() => null);
    const held = heldTokens();
    expect(held).toHaveLength(2);
    expect(new Set(held.map(([, token]) => token)).size).toBe(2);
    expect(releasedTokens()).toEqual(held);
  });

  it('does not spend the user quota on a double-tap refused as busy', async () => {
    redisMock.redis.set.mockResolvedValueOnce(null);
    await expect(stageIntent({ manifestUrl: MANIFEST_URL, userId: 7, now })).rejects.toMatchObject({
      code: 'busy',
    });
    expect(redisMock.redis.incrBy).not.toHaveBeenCalled();
  });

  it('refuses before any fetch when an expired hold could not be cleared', async () => {
    const stale = {
      id: 9,
      userId: 8,
      postedAt: null,
      claimExpiresAt: new Date(0),
      manifest: {},
      staged: [{ key: 'old' }],
    };
    dbMock.dbWrite.postIntentManifest.findUnique.mockResolvedValue(stale);
    dbMock.dbWrite.postIntentManifest.updateMany.mockResolvedValue({ count: 1 });
    deleteManyMock.mockRejectedValueOnce(new Error('s3 down'));
    const requested = serve({ body: manifestJson() });
    await expect(stageIntent({ manifestUrl: MANIFEST_URL, userId: 7, now })).rejects.toMatchObject({
      code: 'busy',
    });
    expect(requested).toEqual([]);
  });

  it('stops reading an image at the image cap instead of the video cap', async () => {
    const MB = 1024 * 1024;
    let pulled = 0;
    function* body() {
      yield PNG;
      for (let i = 0; i < 120; i++) {
        pulled++;
        yield Buffer.alloc(MB);
      }
    }
    let call = 0;
    requestMock.mockImplementation((options: any, cb: (res: unknown) => void) => {
      const req = Object.assign(new EventEmitter(), {
        end: () => undefined,
        destroy: () => undefined,
      });
      req.end = () => {
        const first = call++ === 0;
        const stream = Object.assign(
          first ? Readable.from([Buffer.from(manifestJson())]) : Readable.from(body()),
          { statusCode: 200, headers: first ? { 'content-type': 'application/json' } : {} }
        );
        queueMicrotask(() => cb(stream));
      };
      return req;
    });
    await expect(stageIntent({ manifestUrl: MANIFEST_URL, userId: 7, now })).rejects.toMatchObject({
      code: 'too-large',
    });
    expect(pulled).toBeLessThan(60);
  });

  it("does not spend the app's quota on a manifest that fails validation", async () => {
    serve({ headers: { 'content-type': 'application/json' }, body: manifestJson({ app: 'x' }) });
    await expect(stageIntent({ manifestUrl: MANIFEST_URL, userId: 7, now })).rejects.toMatchObject({
      code: 'app-mismatch',
    });
    const keys = redisMock.redis.incrBy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(keys.some((k: string) => k.includes(':app:'))).toBe(false);
  });

  it('returns the existing claim when the same user wins a concurrent staging', async () => {
    serve({ headers: { 'content-type': 'application/json' }, body: manifestJson() }, { body: PNG });
    dbMock.dbWrite.postIntentManifest.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' })
    );
    dbMock.dbWrite.postIntentManifest.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: 4,
      userId: 7,
      postedAt: null,
      claimExpiresAt: new Date(now.getTime() + 60_000),
      manifest: JSON.parse(manifestJson()),
      staged: [{ key: 'key-other', sourceUrl: MEDIA_URL, type: 'image' }],
    });
    const staged = await stageIntent({ manifestUrl: MANIFEST_URL, userId: 7, now });
    expect(staged.media).toEqual([{ url: MEDIA_URL, type: 'image' }]);
    expect(deleteManyMock).toHaveBeenCalledWith('images', ['key-1'], {});
  });

  it('refuses when a concurrent staging won with a claim that has already lapsed', async () => {
    serve({ headers: { 'content-type': 'application/json' }, body: manifestJson() }, { body: PNG });
    dbMock.dbWrite.postIntentManifest.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' })
    );
    dbMock.dbWrite.postIntentManifest.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: 4,
      userId: 7,
      postedAt: null,
      claimExpiresAt: new Date(now.getTime() - 1),
      manifest: JSON.parse(manifestJson()),
      staged: [],
    });
    await expect(stageIntent({ manifestUrl: MANIFEST_URL, userId: 7, now })).rejects.toMatchObject({
      code: 'claimed',
    });
  });

  it('refuses HEIC with a message that names the format', async () => {
    const HEIC = Buffer.from([0, 0, 0, 0x18, ...Buffer.from('ftypheic'), ...new Array(16).fill(0)]);
    serve(
      { headers: { 'content-type': 'application/json' }, body: manifestJson() },
      { body: HEIC }
    );
    await expect(stageIntent({ manifestUrl: MANIFEST_URL, userId: 7, now })).rejects.toThrow(
      /HEIC and AVIF/
    );
  });
});

describe('publishIntent', () => {
  const claim = (over: Record<string, unknown> = {}) => ({
    id: 1,
    manifestUrl: MANIFEST_URL,
    appId: APP_ID,
    userId: 7,
    postedAt: null,
    claimExpiresAt: new Date(now.getTime() + 60_000),
    manifest: JSON.parse(manifestJson()),
    staged: [
      { key: 'key-1', sourceUrl: MEDIA_URL, type: 'image', mimeType: 'image/png', size: 24 },
    ],
    ...over,
  });

  beforeEach(() => {
    dbMock.dbWrite.postIntentManifest.findUnique.mockResolvedValue(claim());
    dbMock.dbWrite.post.create.mockResolvedValue({ id: 9001 });
    dbMock.dbWrite.image.updateMany.mockResolvedValue({ count: 1 });
    dbMock.dbWrite.postIntentManifest.updateMany.mockResolvedValue({ count: 1 });
    dbMock.dbWrite.image.deleteMany.mockResolvedValue({ count: 1 });
  });

  it('stamps the post with the app id recorded for the host and returns to the app', async () => {
    const result = await publishIntent({
      manifestUrl: MANIFEST_URL,
      userId: 7,
      title: 'Mine',
      publish: true,
      now,
    });
    expect(result).toEqual({ postId: 9001, returnUrl: 'https://games.civitai.com/?reel=A' });
    expect(dbMock.dbWrite.post.create.mock.calls[0][0].data).toMatchObject({
      userId: 7,
      publishedAt: now,
      metadata: { blockPublishedAppId: APP_ID },
    });
    expect(createImageMock.mock.calls[0][0]).toMatchObject({
      url: 'key-1',
      meta: { external: { source: { name: 'Civitai Games' } } },
    });
  });

  it('stamps no app when the host is no longer approved', async () => {
    dbMock.dbRead.appListing.findFirst.mockResolvedValue(null);
    await expect(
      publishIntent({ manifestUrl: MANIFEST_URL, userId: 7, publish: true, now })
    ).rejects.toMatchObject({ code: 'not-approved' });
    expect(dbMock.dbWrite.post.create).not.toHaveBeenCalled();
  });

  it('refuses a second post from the same manifest', async () => {
    dbMock.dbWrite.postIntentManifest.findUnique.mockResolvedValue(claim({ postedAt: now }));
    await expect(
      publishIntent({ manifestUrl: MANIFEST_URL, userId: 7, publish: true, now })
    ).rejects.toMatchObject({ code: 'already-posted' });
    expect(dbMock.dbWrite.post.create).not.toHaveBeenCalled();
  });

  it('rolls back when a concurrent publish marked the manifest first, leaving no image rows', async () => {
    dbMock.dbWrite.postIntentManifest.updateMany.mockResolvedValue({ count: 0 });
    dbMock.dbWrite.postIntentManifest.findUnique
      .mockResolvedValueOnce(claim())
      .mockResolvedValueOnce(claim({ postedAt: now }));
    await expect(
      publishIntent({ manifestUrl: MANIFEST_URL, userId: 7, publish: true, now })
    ).rejects.toMatchObject({ code: 'already-posted' });
    expect(dbMock.dbWrite.image.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: [501] }, userId: 7, postId: null },
    });
  });

  it('says not-staged, not already-posted, when the hold lapsed before commit', async () => {
    dbMock.dbWrite.postIntentManifest.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      publishIntent({ manifestUrl: MANIFEST_URL, userId: 7, publish: true, now })
    ).rejects.toMatchObject({ code: 'not-staged' });
  });

  it('deletes the image rows it made when a later item fails', async () => {
    dbMock.dbWrite.postIntentManifest.findUnique.mockResolvedValue(
      claim({
        staged: [1, 2, 3].map((i) => ({ key: `key-${i}`, type: 'image', mimeType: 'image/png' })),
      })
    );
    createImageMock
      .mockResolvedValueOnce({ id: 601 })
      .mockRejectedValueOnce(new Error('ingest down'));
    await expect(
      publishIntent({ manifestUrl: MANIFEST_URL, userId: 7, publish: true, now })
    ).rejects.toThrow('ingest down');
    expect(dbMock.dbWrite.image.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: [601] }, userId: 7, postId: null },
    });
    expect(dbMock.dbWrite.post.create).not.toHaveBeenCalled();
  });

  it('adopts only post-less images owned by the user', async () => {
    await publishIntent({ manifestUrl: MANIFEST_URL, userId: 7, publish: true, now });
    expect(dbMock.dbWrite.image.updateMany.mock.calls[0][0].where).toEqual({
      id: 501,
      userId: 7,
      postId: null,
    });
  });

  it('only marks a claim that is still live at commit', async () => {
    await publishIntent({ manifestUrl: MANIFEST_URL, userId: 7, publish: true, now });
    expect(dbMock.dbWrite.postIntentManifest.updateMany.mock.calls[0][0].where).toMatchObject({
      postedAt: null,
      claimExpiresAt: { gt: expect.any(Date) },
    });
  });

  it('looks up a fragment variant under the canonical URL', async () => {
    await publishIntent({ manifestUrl: `${MANIFEST_URL}#2`, userId: 7, publish: true, now });
    expect(dbMock.dbWrite.postIntentManifest.findUnique).toHaveBeenCalledWith({
      where: { manifestUrl: MANIFEST_URL },
    });
  });

  it('stores the description as escaped paragraphs', async () => {
    await publishIntent({
      manifestUrl: MANIFEST_URL,
      userId: 7,
      description: 'line one\n<b>two</b>',
      publish: true,
      now,
    });
    expect(dbMock.dbWrite.post.create.mock.calls[0][0].data.detail).toBe(
      '<p>line one</p><p>&lt;b&gt;two&lt;/b&gt;</p>'
    );
  });

  it("refuses to publish another user's claim", async () => {
    await expect(
      publishIntent({ manifestUrl: MANIFEST_URL, userId: 8, publish: true, now })
    ).rejects.toMatchObject({ code: 'not-staged' });
    expect(createImageMock).not.toHaveBeenCalled();
  });

  it('creates a draft with no return trip for "Open in editor"', async () => {
    const result = await publishIntent({
      manifestUrl: MANIFEST_URL,
      userId: 7,
      publish: false,
      now,
    });
    expect(result.returnUrl).toBeUndefined();
    expect(dbMock.dbWrite.post.create.mock.calls[0][0].data.publishedAt).toBeNull();
  });
});

describe('item: the app sub-listing a share names', () => {
  const live = { author: { bannedAt: null, deletedAt: null }, ...parentWith(true) };
  function parentWith(enabled: boolean) {
    return { parentListing: { subListingParent: { enabled } } };
  }
  const SUB_LISTINGS: {
    id: string;
    parentListingId: string;
    itemKey: string;
    status: string;
    title?: string;
    contentRating?: string;
  }[] = [
    { id: 'asl_FAKEFUL', parentListingId: 'apl_games', itemKey: 'fakeful', status: 'approved' },
    {
      id: 'asl_MATURE',
      parentListingId: 'apl_games',
      itemKey: 'mature',
      status: 'approved',
      contentRating: 'x',
    },
    {
      id: 'asl_BIDI',
      parentListingId: 'apl_games',
      itemKey: 'bidi',
      status: 'approved',
      title: '\u202eFake\u200bful\n',
    },
    {
      id: 'asl_BLANK',
      parentListingId: 'apl_games',
      itemKey: 'blank',
      status: 'approved',
      title: '\u200b\u202e',
    },
    { id: 'asl_PENDING', parentListingId: 'apl_games', itemKey: 'unreviewed', status: 'pending' },
    { id: 'asl_HIDDEN', parentListingId: 'apl_games', itemKey: 'hidden', status: 'hidden' },
    { id: 'asl_OTHER', parentListingId: 'apl_other_app', itemKey: 'elsewhere', status: 'approved' },
  ]
    .map((r) => ({ ...r, ...live }))
    .concat([
      {
        id: 'asl_BANNED',
        parentListingId: 'apl_games',
        itemKey: 'banned',
        status: 'approved',
        ...live,
        author: { bannedAt: new Date('2026-10-01') as never, deletedAt: null },
      },
      {
        id: 'asl_SWITCHED_OFF',
        parentListingId: 'apl_games',
        itemKey: 'switchedoff',
        status: 'approved',
        ...live,
        ...parentWith(false),
      },
    ]);

  /** Every `where` field, nested and `is` ones included, must hold for a row to match. */
  function matches(row: unknown, where: Record<string, unknown>): boolean {
    const r = (row ?? {}) as Record<string, unknown>;
    return Object.entries(where).every(([k, v]) => {
      if (k === 'is') return matches(r, v as Record<string, unknown>);
      if (v !== null && typeof v === 'object' && !(v instanceof Date))
        return matches(r[k], v as Record<string, unknown>);
      return r[k] === v;
    });
  }

  function serveSubListings() {
    dbMock.dbRead.appSubListing.findFirst.mockImplementation((async ({
      where,
    }: {
      where: Record<string, unknown>;
    }) => {
      const row = SUB_LISTINGS.find((r) => matches(r, where));
      return row
        ? {
            id: row.id,
            title: row.title ?? `Title of ${row.itemKey}`,
            contentRating: row.contentRating ?? null,
            parentListing: { contentRating: 'pg' },
          }
        : null;
    }) as never);
  }

  const publishWith = async (item: unknown) => {
    dbMock.dbWrite.postIntentManifest.findUnique.mockResolvedValue({
      id: 1,
      manifestUrl: MANIFEST_URL,
      appId: APP_ID,
      userId: 7,
      postedAt: null,
      claimExpiresAt: new Date(now.getTime() + 60_000),
      manifest: JSON.parse(manifestJson(item === undefined ? {} : { item })),
      staged: [
        { key: 'key-1', sourceUrl: MEDIA_URL, type: 'image', mimeType: 'image/png', size: 24 },
      ],
    });
    await publishIntent({ manifestUrl: MANIFEST_URL, userId: 7, publish: true, now });
    return dbMock.dbWrite.post.create.mock.calls[0][0].data.metadata;
  };

  beforeEach(() => {
    serveSubListings();
    dbMock.dbWrite.post.create.mockResolvedValue({ id: 9001 });
    dbMock.dbWrite.image.updateMany.mockResolvedValue({ count: 1 });
    dbMock.dbWrite.postIntentManifest.updateMany.mockResolvedValue({ count: 1 });
  });

  it('credits an approved item under the app', async () => {
    expect(await publishWith('fakeful')).toEqual({
      blockPublishedAppId: APP_ID,
      blockPublishedSubListingId: 'asl_FAKEFUL',
    });
  });

  it.each([
    ['pending review', 'unreviewed'],
    ['hidden by a moderator', 'hidden'],
    ["approved under another app's listing", 'elsewhere'],
    ['by a banned author', 'banned'],
    ['under an app whose sub-listings are switched off', 'switchedoff'],
    ['unknown', 'nosuchgame'],
  ])('credits only the app for an item %s', async (_, item) => {
    expect(await publishWith(item)).toEqual({ blockPublishedAppId: APP_ID });
  });

  it('leaves a share without an item unchanged', async () => {
    expect(await publishWith(undefined)).toEqual({ blockPublishedAppId: APP_ID });
    expect(dbMock.dbRead.appSubListing.findFirst).not.toHaveBeenCalled();
  });

  it('still posts, credited to the app, when the item lookup fails, and logs it', async () => {
    loggingMock.logToAxiom.mockClear();
    dbMock.dbRead.appSubListing.findFirst.mockRejectedValue(new Error('replica down'));
    expect(await publishWith('fakeful')).toEqual({ blockPublishedAppId: APP_ID });
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'failed to resolve item', error: 'replica down' })
    );
  });

  it('credits an item whose title sanitises to nothing, which the chip then leaves unnamed', async () => {
    expect(await publishWith('blank')).toEqual({
      blockPublishedAppId: APP_ID,
      blockPublishedSubListingId: 'asl_BLANK',
    });
  });

  const stageWith = async (item: string, requestHost = 'civitai.com') => {
    serve(
      { headers: { 'content-type': 'application/json' }, body: manifestJson({ item }) },
      { headers: { 'content-type': 'image/png' }, body: PNG }
    );
    return (await stageIntent({ manifestUrl: MANIFEST_URL, userId: 7, requestHost, now })).app;
  };

  it('names an approved item on the compose sheet', async () => {
    expect(await stageWith('fakeful')).toEqual({
      name: 'Civitai Games',
      host: 'games.civitai.com',
      itemName: 'Title of fakeful',
    });
  });

  it('names a mature item on the compose sheet only on a host that shows its rating', async () => {
    expect(await stageWith('mature')).not.toHaveProperty('itemName');
    expect(await stageWith('mature', 'civitai.red')).toMatchObject({ itemName: 'Title of mature' });
    expect(await stageWith('fakeful')).toMatchObject({ itemName: 'Title of fakeful' });
  });

  it('strips hidden and reordering characters from the item name', async () => {
    expect(await stageWith('bidi')).toMatchObject({ itemName: 'Fakeful' });
    expect(await stageWith('blank')).not.toHaveProperty('itemName');
  });

  it("does not name another app's item on the compose sheet", async () => {
    expect(await stageWith('elsewhere')).toEqual({
      name: 'Civitai Games',
      host: 'games.civitai.com',
    });
  });
});

describe('sweepExpiredIntentClaims', () => {
  beforeEach(() => {
    dbMock.dbWrite.postIntentManifest.updateMany.mockResolvedValue({ count: 1 });
    dbMock.dbWrite.postIntentManifest.deleteMany.mockResolvedValue({ count: 1 });
  });

  it('releases an expired claim: mark, delete its files, then delete the row', async () => {
    dbMock.dbWrite.postIntentManifest.findMany.mockResolvedValueOnce([
      { id: 3, staged: [{ key: 'key-a' }, { key: 'key-b' }] },
    ]);
    await sweepExpiredIntentClaims(now);

    expect(dbMock.dbWrite.postIntentManifest.findMany.mock.calls[0][0].where).toEqual({
      id: { gt: 0 },
      postedAt: null,
      claimExpiresAt: { lt: now },
    });
    expect(dbMock.dbWrite.postIntentManifest.updateMany).toHaveBeenCalledWith({
      where: { id: 3, postedAt: null },
      data: { claimExpiresAt: new Date(0) },
    });
    expect(deleteManyMock).toHaveBeenCalledWith('images', ['key-a', 'key-b'], {});
    expect(dbMock.dbWrite.postIntentManifest.deleteMany).toHaveBeenCalledWith({
      where: { id: 3, postedAt: null },
    });
  });

  it('keeps the row when its files could not be deleted, so a later sweep retries', async () => {
    dbMock.dbWrite.postIntentManifest.findMany.mockResolvedValueOnce([
      { id: 3, staged: [{ key: 'key-a' }] },
    ]);
    deleteManyMock.mockRejectedValueOnce(new Error('s3 down'));
    await sweepExpiredIntentClaims(now);
    expect(dbMock.dbWrite.postIntentManifest.deleteMany).not.toHaveBeenCalled();
  });

  it('leaves the files alone when the claim was posted in the meantime', async () => {
    dbMock.dbWrite.postIntentManifest.findMany.mockResolvedValueOnce([
      { id: 3, staged: [{ key: 'key-a' }] },
    ]);
    dbMock.dbWrite.postIntentManifest.updateMany.mockResolvedValueOnce({ count: 0 });
    await sweepExpiredIntentClaims(now);
    expect(deleteManyMock).not.toHaveBeenCalled();
  });

  it('keeps sweeping full batches until the backlog is clear', async () => {
    const rows = (from: number, n: number) =>
      Array.from({ length: n }, (_, i) => ({ id: from + i, staged: [] }));
    dbMock.dbWrite.postIntentManifest.findMany
      .mockResolvedValueOnce(rows(1, 2))
      .mockResolvedValueOnce(rows(3, 2))
      .mockResolvedValueOnce(rows(5, 1));
    expect(await sweepExpiredIntentClaims(now, 2)).toBe(5);
    expect(dbMock.dbWrite.postIntentManifest.findMany).toHaveBeenCalledTimes(3);
  });

  it('does nothing before the migration is applied', async () => {
    dbMock.dbWrite.postIntentManifest.findMany.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('missing', { code: 'P2021', clientVersion: 'x' })
    );
    await expect(sweepExpiredIntentClaims(now)).resolves.toBe(0);
  });
});
