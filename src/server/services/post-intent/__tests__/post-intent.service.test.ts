import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as BlockPostService from '~/server/services/blocks/block-post.service';
import type * as ImageService from '~/server/services/image.service';
import type * as TagService from '~/server/services/tag.service';
import type * as ToolService from '~/server/services/tool.service';
import type * as VideoDimensions from '~/server/services/video-dimensions';
import type * as S3Utils from '~/utils/s3-utils';

const { requestMock, lookupMock, createImageMock, uploadMock, deleteManyMock, probeMock } =
  vi.hoisted(() => ({
    requestMock: vi.fn(),
    lookupMock: vi.fn(),
    createImageMock: vi.fn(),
    uploadMock: vi.fn(),
    deleteManyMock: vi.fn(),
    probeMock: vi.fn(),
  }));

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

  it('rolls back when a concurrent publish marked the manifest first', async () => {
    dbMock.dbWrite.postIntentManifest.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      publishIntent({ manifestUrl: MANIFEST_URL, userId: 7, publish: true, now })
    ).rejects.toMatchObject({ code: 'already-posted' });
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

describe('sweepExpiredIntentClaims', () => {
  it('only touches unposted, expired claims and deletes their stored files', async () => {
    dbMock.dbWrite.postIntentManifest.findMany.mockResolvedValue([
      { id: 3, staged: [{ key: 'key-a' }, { key: 'key-b' }] },
    ]);
    dbMock.dbWrite.postIntentManifest.deleteMany.mockResolvedValue({ count: 1 });

    await sweepExpiredIntentClaims(now);

    expect(dbMock.dbWrite.postIntentManifest.findMany.mock.calls[0][0].where).toEqual({
      postedAt: null,
      claimExpiresAt: { lt: now },
    });
    expect(dbMock.dbWrite.postIntentManifest.deleteMany).toHaveBeenCalledWith({
      where: { id: 3, postedAt: null },
    });
    expect(deleteManyMock).toHaveBeenCalledWith('images', ['key-a', 'key-b'], {});
  });
});
