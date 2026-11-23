import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as Metadata from '~/utils/metadata';
import type * as S3Utils from '~/utils/s3-utils';
import type * as FeatureFlags from '~/server/services/feature-flags.service';

/**
 * Songs enter a post only through `addPostImage`, and only for users with the `music` flag. The
 * post.service import scaffold mirrors add-post-image-upload-metadata.test.ts.
 */

const KEY = '6f1c2b9e-3a4d-4e5f-8a7b-9c0d1e2f3a4b';

const mocks = vi.hoisted(() => ({
  readImageUploadObjectHead: vi.fn(),
  getMetadata: vi.fn(),
  fetch: vi.fn(),
  getWorkflow: vi.fn(),
  createImage: vi.fn(),
  submitTrackLyricsScan: vi.fn(async () => undefined),
  throwOnBlockedUserContent: vi.fn(),
  stageGenerationOutputImage: vi.fn(),
  deleteImages: vi.fn(async () => undefined),
  music: false,
}));

vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlags>()),
  getFeatureFlagsLazy: () => ({ music: mocks.music }),
}));

vi.mock('~/server/services/orchestrator/workflows', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getWorkflow: mocks.getWorkflow,
}));
vi.mock('~/server/orchestrator/get-orchestrator-token', () => ({
  getOrchestratorToken: vi.fn(async () => 'token'),
}));
vi.mock('~/server/services/blocks/block-image-upload.service', () => ({
  stageGenerationOutputImage: mocks.stageGenerationOutputImage,
}));

vi.mock('~/server/events/points/hooks', () => ({
  onStorySparkLost: vi.fn(),
  onStorySparkPostsHidden: vi.fn(),
}));
vi.mock('~/utils/s3-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof S3Utils>()),
  readImageUploadObjectHead: mocks.readImageUploadObjectHead,
}));
vi.mock('~/utils/metadata', async (importOriginal) => ({
  ...(await importOriginal<typeof Metadata>()),
  getMetadata: mocks.getMetadata,
}));

// --- infra scaffold (mirrors contest-entry-resource-gate.test.ts) ---------------------
// `~/server/redis/client` is covered by the canonical mock registered in src/__tests__/setup.ts,
// which supplies redis/sysRedis plus the REAL key tables. The local stub this replaces returned a
// self-vivifying proxy for every REDIS_*_KEYS lookup, so any key the code composed came back as the
// same placeholder — nothing here asserts a key, so the swap changes no assertion.
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));
vi.mock('@civitai/db', () => ({
  createLagTracker: vi.fn(() => ({})),
  loadDbEnv: vi.fn(() => ({})),
}));
vi.mock('~/server/db/pgDb', () => ({ pgDbReadLong: {}, pgDbRead: {}, pgDbWrite: {} }));
vi.mock('~/server/db/db-lag-helpers', () => ({
  getDbWithoutLag: vi.fn(),
  preventReplicationLag: vi.fn(),
  preventReplicationLagBatch: vi.fn(),
}));
vi.mock('~/server/search-index', () => ({}));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));

// Every cache post.service imports — each a stub whose methods are no-op vi.fns. (Named
// exports must be statically present for ESM import binding; a Proxy has no own keys.)
vi.mock('~/server/redis/caches', () => {
  const cacheStub = () => ({
    refresh: vi.fn().mockResolvedValue(undefined),
    bust: vi.fn().mockResolvedValue(undefined),
    fetch: vi.fn(),
    refreshMany: vi.fn(),
  });
  return {
    imageMetaCache: cacheStub(),
    imageResourcesCache: cacheStub(),
    modelVersionAccessCache: cacheStub(),
    postStatCache: cacheStub(),
    thumbnailCache: cacheStub(),
    imageMetadataCache: cacheStub(),
    userBasicCache: cacheStub(),
    userImageVideoCountCaches: cacheStub(),
    userPostCountCache: cacheStub(),
  };
});

vi.mock('~/server/services/audio-scan/track-lyrics', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  submitTrackLyricsScan: mocks.submitTrackLyricsScan,
}));

vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));

// The heavy image.service graph — replaced wholesale with the named exports post.service imports.
vi.mock('~/server/services/image.service', () => ({
  createImage: mocks.createImage,
  createImageResources: vi.fn(async () => undefined),
  deleteImages: mocks.deleteImages,
  deleteImageFromS3: vi.fn(),
  deleteImagesForModelVersionCache: vi.fn(),
  getImagesForPosts: vi.fn(),
  imagesForModelVersionsCache: { refresh: vi.fn() },
  enqueueImageIngestion: vi.fn(),
  invalidateManyImageExistence: vi.fn(),
  purgeResizeCache: vi.fn(),
  queueImageSearchIndexUpdate: vi.fn(),
}));

// Other sibling services post.service imports — mocked so their graphs aren't evaluated.
vi.mock('~/server/services/collection.service', () => ({
  getCollectionById: vi.fn(),
  getUserCollectionPermissionsById: vi.fn(),
  removeEntityFromAllCollections: vi.fn(),
}));
vi.mock('~/server/services/cosmetic.service', () => ({ getCosmeticsForEntity: vi.fn() }));
vi.mock('~/server/services/post-collection-visibility', () => ({ canViewCollectionPost: vi.fn() }));
vi.mock('~/server/services/tag.service', () => ({
  findOrCreateTagsByName: vi.fn(),
  getVotableImageTags: vi.fn(),
}));
vi.mock('~/server/services/technique.service', () => ({ getTechniqueForWorkflow: vi.fn() }));
vi.mock('~/server/services/tool.service', () => ({
  getToolByAlias: vi.fn(),
  getToolByDomain: vi.fn(),
  getToolByName: vi.fn(),
}));
vi.mock('~/server/services/blocklist.service', () => ({
  throwOnBlockedLinkDomain: vi.fn(),
  throwOnBlockedUserContent: mocks.throwOnBlockedUserContent,
}));

const { addPostImage, SONG_ON_SCHEDULED_POST_MESSAGE } = await import(
  '~/server/services/post.service'
);
const { thumbnailCache } = await import('~/server/redis/caches');
const { getVotableImageTags } = await import('~/server/services/tag.service');
const { getOrchestratorToken } = await import('~/server/orchestrator/get-orchestrator-token');

const user = { id: 5 } as never;
const song = { duration: 200, size: 3, title: 'Night Drive' };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.music = false;
  mocks.throwOnBlockedUserContent.mockResolvedValue(undefined);
  mocks.getWorkflow.mockResolvedValue({ steps: [] });
  dbMock.dbRead.post.findFirst.mockResolvedValue({ userId: 5, collection: null });
  dbMock.dbWrite.post.findFirst.mockResolvedValue({ userId: 5, collection: null });
  dbMock.dbRead.image.findFirst.mockResolvedValue(null);
  // Stop right after the create call: its arguments are what is under test.
  mocks.createImage.mockRejectedValue(new Error('stop after create'));
});

const addSong = (extra: Record<string, unknown> = {}) =>
  addPostImage({ url: KEY, type: 'audio', postId: 1, user, metadata: song, ...extra } as never);

describe('addPostImage — audio', () => {
  it('refuses a song from a user without the music flag, before touching the post or storage', async () => {
    await expect(addSong()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(dbMock.dbRead.post.findFirst).not.toHaveBeenCalled();
    expect(mocks.createImage).not.toHaveBeenCalled();
  });

  it('does not apply the flag to images', async () => {
    await expect(
      addPostImage({ url: KEY, type: 'image', postId: 1, user } as never)
    ).rejects.toThrow('stop after create');
    expect(mocks.createImage).toHaveBeenCalledTimes(1);
  });

  it('creates the song for a music user, vouching for audio and never reading its bytes for EXIF', async () => {
    mocks.music = true;
    await expect(addSong()).rejects.toThrow('stop after create');
    expect(mocks.readImageUploadObjectHead).not.toHaveBeenCalled();
    expect(mocks.createImage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'audio', allowAudio: true, metadata: song })
    );
  });

  // A scheduled post goes live by time alone, so a song added to it would skip the genre check.
  describe('on a scheduled post', () => {
    // A song's post is read on the primary, an image's on the replica.
    const scheduled = (publishedAt: Date | null) => {
      dbMock.dbWrite.post.findFirst.mockResolvedValue({ userId: 5, publishedAt });
      dbMock.dbRead.post.findFirst.mockResolvedValue({ userId: 5, publishedAt });
    };

    it('refuses a song, creating nothing', async () => {
      mocks.music = true;
      scheduled(new Date(Date.now() + 86_400_000));
      await expect(addSong()).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: SONG_ON_SCHEDULED_POST_MESSAGE,
      });
      expect(mocks.createImage).not.toHaveBeenCalled();
      expect(dbMock.dbRead.post.findFirst).not.toHaveBeenCalled();
    });

    it('still takes an image', async () => {
      scheduled(new Date(Date.now() + 86_400_000));
      await expect(
        addPostImage({ url: KEY, type: 'image', postId: 1, user } as never)
      ).rejects.toThrow('stop after create');
      expect(mocks.createImage).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['a draft', null],
      ['a published post', new Date(Date.now() - 86_400_000)],
    ])('takes a song on %s', async (_, publishedAt) => {
      mocks.music = true;
      scheduled(publishedAt);
      await expect(addSong()).rejects.toThrow('stop after create');
      expect(mocks.createImage).toHaveBeenCalledTimes(1);
    });
  });

  it('refuses a song whose title the blocked-content check rejects, creating nothing', async () => {
    mocks.music = true;
    mocks.throwOnBlockedUserContent.mockRejectedValue(new Error('blocked'));

    await expect(
      addSong({ generationWorkflowId: 'wf-1', metadata: { ...song, title: 'bad words' } })
    ).rejects.toThrow('blocked');
    expect(mocks.throwOnBlockedUserContent).toHaveBeenCalledWith('bad words', expect.anything());
    expect(mocks.createImage).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.trackLyrics.upsert).not.toHaveBeenCalled();
  });

  it('checks a clean title and posts the song', async () => {
    mocks.music = true;

    await expect(addSong()).rejects.toThrow('stop after create');
    expect(mocks.throwOnBlockedUserContent).toHaveBeenCalledWith('Night Drive', expect.anything());
    expect(mocks.createImage).toHaveBeenCalledTimes(1);
  });

  it('keeps only the audio metadata fields and rejects metadata that is not a song', async () => {
    mocks.music = true;
    await expect(addSong({ metadata: { ...song, youtubeVideoId: 'x' } })).rejects.toThrow(
      'stop after create'
    );
    expect(mocks.createImage.mock.calls[0][0].metadata).toEqual(song);

    mocks.createImage.mockClear();
    await expect(addSong({ metadata: { title: 'no duration' } })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(mocks.createImage).not.toHaveBeenCalled();
  });

  it.each([
    ['a title longer than a post title', { title: 'x'.repeat(256) }],
    ['a key longer than 16 characters', { key: 'x'.repeat(17) }],
  ])('rejects a song with %s', async (_, extra) => {
    mocks.music = true;
    await expect(addSong({ metadata: { ...song, ...extra } })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(mocks.createImage).not.toHaveBeenCalled();
  });

  it('stores a title and key at their caps', async () => {
    mocks.music = true;
    const metadata = { ...song, title: 'x'.repeat(255), key: 'x'.repeat(16) };
    await expect(addSong({ metadata })).rejects.toThrow('stop after create');
    expect(mocks.createImage.mock.calls[0][0].metadata).toEqual(metadata);
  });

  // The lyrics are saved after the create; stop at the read that follows them.
  const createThenStop = () => {
    mocks.createImage.mockResolvedValue({ id: 11 });
    dbMock.dbWrite.image.findUnique.mockResolvedValue(null);
  };
  const savedLines = () =>
    dbMock.dbWrite.trackLyrics.upsert.mock.calls.map(([args]) => args.create.lines);

  it("fills a simple-mode song's bpm and key from its drafting step, and saves its lyrics apart", async () => {
    mocks.music = true;
    createThenStop();
    mocks.getWorkflow.mockResolvedValue({
      steps: [
        {
          $type: 'chatCompletion',
          output: { parsed: { lyrics: '[Verse]\nrain', bpm: 90, key: 'A minor' } },
        },
      ],
    });
    await expect(addSong({ generationWorkflowId: 'wf-1' })).rejects.toThrow('An unexpected error');
    expect(mocks.createImage.mock.calls[0][0].metadata).toEqual({
      ...song,
      bpm: 90,
      key: 'A minor',
    });
    expect(dbMock.dbWrite.trackLyrics.upsert).toHaveBeenCalledWith({
      where: { imageId: 11 },
      create: {
        imageId: 11,
        text: '[Verse]\nrain',
        lines: [
          { t: null, text: '[Verse]' },
          { t: null, text: 'rain' },
        ],
        source: 'generator',
      },
      update: {
        text: '[Verse]\nrain',
        lines: [
          { t: null, text: '[Verse]' },
          { t: null, text: 'rain' },
        ],
        source: 'generator',
      },
    });
  });

  it('sends the saved lyrics for their verdict', async () => {
    mocks.music = true;
    createThenStop();
    mocks.getWorkflow.mockResolvedValue({ steps: [{ $type: 'yuE2', input: { lyrics: 'sun' } }] });
    await expect(addSong({ generationWorkflowId: 'wf-1' })).rejects.toThrow('An unexpected error');
    expect(mocks.submitTrackLyricsScan).toHaveBeenCalledWith({ imageId: 11 });
  });

  it('reaches the read after the create when the lyrics send rejects', async () => {
    mocks.music = true;
    createThenStop();
    mocks.getWorkflow.mockResolvedValue({ steps: [{ $type: 'yuE2', input: { lyrics: 'sun' } }] });
    mocks.submitTrackLyricsScan.mockRejectedValueOnce(new Error('orchestrator down'));

    await expect(addSong({ generationWorkflowId: 'wf-1' })).rejects.toThrow('An unexpected error');
    expect(mocks.submitTrackLyricsScan).toHaveBeenCalledTimes(1);
    expect(dbMock.dbWrite.image.findUnique).toHaveBeenCalled();
  });

  it('keeps the song when its lyrics fail to save, and sends nothing to scan', async () => {
    mocks.music = true;
    createThenStop();
    mocks.getWorkflow.mockResolvedValue({ steps: [{ $type: 'yuE2', input: { lyrics: 'sun' } }] });
    dbMock.dbWrite.trackLyrics.upsert.mockRejectedValueOnce(new Error('db down'));

    // Past the failed save: the read after the create is where the test stops.
    await expect(addSong({ generationWorkflowId: 'wf-1' })).rejects.toThrow('An unexpected error');
    expect(mocks.createImage).toHaveBeenCalledTimes(1);
    expect(dbMock.dbWrite.trackLyrics.upsert).toHaveBeenCalledTimes(1);
    expect(dbMock.dbWrite.image.findUnique).toHaveBeenCalled();
    expect(mocks.submitTrackLyricsScan).not.toHaveBeenCalled();
  });

  it('ignores the lyrics the client sent when the workflow has lyrics', async () => {
    mocks.music = true;
    createThenStop();
    mocks.getWorkflow.mockResolvedValue({
      steps: [{ $type: 'chatCompletion', output: { parsed: { lyrics: 'drafted', bpm: 90 } } }],
    });
    await expect(
      addSong({
        generationWorkflowId: 'wf-1',
        metadata: { ...song, lyrics: [{ t: null, text: 'mine' }] },
      })
    ).rejects.toThrow('An unexpected error');
    expect(mocks.createImage.mock.calls[0][0].metadata).toEqual({ ...song, bpm: 90 });
    expect(savedLines()).toEqual([[{ t: null, text: 'drafted' }]]);
  });

  it.each(['aceStepAudio', 'miniMaxMusic3', 'yuE2'])(
    "takes a custom-mode song's lyrics from its %s step input, never the client's",
    async ($type) => {
      mocks.music = true;
      createThenStop();
      mocks.getWorkflow.mockResolvedValue({
        steps: [{ $type, input: { lyrics: '[Verse]\nsun' }, output: {} }],
      });
      await expect(
        addSong({
          generationWorkflowId: 'wf-1',
          metadata: { ...song, lyrics: [{ t: null, text: 'mine' }] },
        })
      ).rejects.toThrow('An unexpected error');
      expect(savedLines()).toEqual([
        [
          { t: null, text: '[Verse]' },
          { t: null, text: 'sun' },
        ],
      ]);
    }
  );

  it('prefers the lyrics the audio step was given over the drafting step', async () => {
    mocks.music = true;
    createThenStop();
    mocks.getWorkflow.mockResolvedValue({
      steps: [
        { $type: 'chatCompletion', output: { parsed: { lyrics: 'drafted' } } },
        { $type: 'miniMaxMusic3', input: { lyrics: 'sung' } },
      ],
    });
    await expect(addSong({ generationWorkflowId: 'wf-1' })).rejects.toThrow('An unexpected error');
    expect(savedLines()).toEqual([[{ t: null, text: 'sung' }]]);
  });

  it.each([
    ['no workflow id', {}],
    ['a workflow that cannot be read', { generationWorkflowId: 'wf-1' }],
  ])("saves no lyrics for %s, rather than the client's", async (_, extra) => {
    mocks.music = true;
    createThenStop();
    mocks.getWorkflow.mockRejectedValue(new Error('orchestrator down'));
    await expect(
      addSong({ ...extra, metadata: { ...song, lyrics: [{ t: null, text: 'mine' }] } })
    ).rejects.toThrow('An unexpected error');
    expect(mocks.createImage.mock.calls[0][0].metadata).toEqual(song);
    expect(dbMock.dbWrite.trackLyrics.upsert).not.toHaveBeenCalled();
    expect(mocks.submitTrackLyricsScan).not.toHaveBeenCalled();
  });

  it('accepts client lyrics timed in fractional seconds, and discards them', async () => {
    mocks.music = true;
    await expect(
      addSong({ metadata: { ...song, lyrics: [{ t: 1.5, text: 'mine' }] } })
    ).rejects.toThrow('stop after create');
    expect(mocks.createImage.mock.calls[0][0].metadata).toEqual(song);
  });

  it('returns the new song with its lyrics read from the primary, which has the row just saved', async () => {
    mocks.music = true;
    const lines = [{ t: null, text: 'sun' }];
    mocks.createImage.mockResolvedValue({ id: 11 });
    dbMock.dbWrite.image.findUnique.mockResolvedValue({
      id: 11,
      index: 0,
      type: 'audio',
      metadata: song,
      tools: [],
      techniques: [],
      resourceHelper: [],
    } as never);
    vi.mocked(getVotableImageTags).mockResolvedValue([]);
    vi.mocked(thumbnailCache.fetch).mockResolvedValue({} as never);
    dbMock.dbWrite.trackLyrics.findMany.mockResolvedValue([{ imageId: 11, lines }] as never);

    const image = await addSong();

    expect(image.lyrics).toEqual(lines);
    expect(dbMock.dbRead.trackLyrics.findMany).not.toHaveBeenCalled();
  });

  it('reads the workflow once for both the song details and the provenance', async () => {
    mocks.music = true;
    await expect(addSong({ generationWorkflowId: 'wf-1' })).rejects.toThrow('stop after create');
    expect(mocks.getWorkflow).toHaveBeenCalledTimes(1);
  });

  it("does not let a slow orchestrator hold the post: it stores no lyrics rather than the client's", async () => {
    vi.useFakeTimers();
    try {
      mocks.music = true;
      mocks.getWorkflow.mockReturnValue(new Promise(() => undefined));
      const pending = expect(
        addSong({
          generationWorkflowId: 'wf-1',
          metadata: { ...song, lyrics: [{ t: null, text: 'mine' }] },
        })
      ).rejects.toThrow('stop after create');
      await vi.advanceTimersByTimeAsync(10_000);
      await pending;
      expect(mocks.createImage.mock.calls[0][0].metadata).toEqual(song);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('addPostImage — generated song cover', () => {
  const COVER_URL = 'https://orchestration.civitai.com/v2/consumer/blobs/cover.png';
  const coverStep = (blob: Record<string, unknown> = {}) => ({
    $type: 'imageGen',
    metadata: { suppressOutput: true },
    output: {
      images: [
        { url: COVER_URL, available: true, width: 1024, height: 1024, nsfwLevel: 'pg', ...blob },
      ],
    },
  });
  const songStep = { $type: 'aceStepAudio', input: {}, output: {} };
  const staged = {
    url: '0b5e9d1c-7a2f-4e3b-9c8d-1f2a3b4c5d6e',
    mimeType: 'image/png',
    hash: 'blur',
    width: 1024,
    height: 1024,
    metadata: { size: 2048 },
  };

  beforeEach(() => {
    mocks.music = true;
    mocks.createImage.mockReset();
    mocks.createImage.mockResolvedValueOnce({ id: 11 }).mockResolvedValueOnce({ id: 12 });
    mocks.stageGenerationOutputImage.mockResolvedValue(staged);
    mocks.getWorkflow.mockResolvedValue({ steps: [songStep, coverStep()] });
    dbMock.dbWrite.$executeRaw.mockResolvedValue(1 as never);
    // Stop at the read after the create: everything before it is under test.
    dbMock.dbWrite.image.findUnique.mockResolvedValue(null);
  });

  const postFromGenerator = (extra: Record<string, unknown> = {}) =>
    expect(addSong({ generationWorkflowId: 'wf-1', ...extra })).rejects.toThrow(
      'An unexpected error'
    );
  /** The link statement's bound values: the song id, then the cover id. */
  const linkValues = () => dbMock.dbWrite.$executeRaw.mock.calls.map(([, ...values]) => values);

  it("links the workflow's cover as the song's cover: a scanned row outside the post, named by the song", async () => {
    await postFromGenerator();

    expect(mocks.stageGenerationOutputImage).toHaveBeenCalledTimes(1);
    expect(mocks.stageGenerationOutputImage).toHaveBeenCalledWith(
      expect.objectContaining({
        imageUrl: COVER_URL,
        width: 1024,
        height: 1024,
        signal: expect.any(AbortSignal),
      })
    );
    expect(mocks.createImage).toHaveBeenCalledTimes(2);
    const coverArgs = mocks.createImage.mock.calls[1][0];
    expect(coverArgs).toEqual({
      url: staged.url,
      type: 'image',
      mimeType: 'image/png',
      hash: 'blur',
      width: 1024,
      height: 1024,
      metadata: { size: 2048, parentId: 11 },
      userId: 5,
    });
    // No postId and no skipped ingestion: createImage's default path requests the scan.
    expect(coverArgs).not.toHaveProperty('postId');
    expect(coverArgs).not.toHaveProperty('skipIngestion');
    expect(linkValues()).toEqual([[11, 12]]);
    expect(mocks.deleteImages).not.toHaveBeenCalled();
  });

  // The link statement runs on a `Track` table in PGlite: the song's row is what it reads back.
  describe('linking on the Track row', () => {
    let pg: PGlite;
    const track = async () =>
      (
        await pg.query<{ coverImageId: number | null; genre: string | null }>(
          `SELECT "coverImageId", genre FROM "Track" WHERE "imageId" = 11`
        )
      ).rows;

    beforeAll(async () => {
      pg = new PGlite();
      await pg.exec(
        `CREATE TABLE "Track" ("imageId" int PRIMARY KEY, "coverImageId" int UNIQUE, genre text)`
      );
    }, 60_000);
    afterAll(() => pg.close());
    beforeEach(async () => {
      await pg.exec(`TRUNCATE "Track"`);
      const INT4_OID = 23;
      dbMock.dbWrite.$executeRaw.mockImplementation((async (
        strings: TemplateStringsArray,
        ...values: unknown[]
      ) => {
        const sql = Prisma.sql(strings, ...values);
        const paramTypes = sql.values.map((v) => (Number.isInteger(v) ? INT4_OID : 0));
        return (await pg.query(sql.text, sql.values, { paramTypes })).affectedRows ?? 0;
      }) as never);
    });

    it('creates the Track row with the cover for a song that has none', async () => {
      await postFromGenerator();
      expect(await track()).toEqual([{ coverImageId: 12, genre: null }]);
      expect(mocks.deleteImages).not.toHaveBeenCalled();
    });

    it("links the cover on a song's genre-only row, keeping its genre", async () => {
      await pg.exec(`INSERT INTO "Track" ("imageId", genre) VALUES (11, 'Pop')`);
      await postFromGenerator();
      expect(await track()).toEqual([{ coverImageId: 12, genre: 'Pop' }]);
      expect(mocks.deleteImages).not.toHaveBeenCalled();
    });

    it('keeps the cover a song gained first and removes the row it made, leaving one cover', async () => {
      await pg.exec(`INSERT INTO "Track" ("imageId", "coverImageId") VALUES (11, 99)`);
      await postFromGenerator();
      expect(await track()).toEqual([{ coverImageId: 99, genre: null }]);
      expect(mocks.deleteImages).toHaveBeenCalledWith([12], { actor: { id: 5 } });
    });
  });

  it('links a cover the creator uploaded with the song, the same scanned way', async () => {
    const UPLOADED = 'https://orchestration.civitai.com/v2/consumer/blobs/mine.png';
    mocks.getWorkflow.mockResolvedValue({
      steps: [
        {
          ...songStep,
          metadata: { coverImage: { url: UPLOADED, width: 768, height: 768 } },
        },
      ],
    });
    await postFromGenerator();

    expect(mocks.stageGenerationOutputImage).toHaveBeenCalledWith(
      expect.objectContaining({ imageUrl: UPLOADED, width: 768, height: 768 })
    );
    expect(mocks.createImage.mock.calls[1][0]).not.toHaveProperty('skipIngestion');
    expect(linkValues()).toEqual([[11, 12]]);
  });

  it("reads the workflow with the caller's own orchestrator token", async () => {
    await postFromGenerator();
    expect(getOrchestratorToken).toHaveBeenCalledWith(5, expect.anything());
    expect(mocks.getWorkflow).toHaveBeenCalledWith({
      token: 'token',
      path: { workflowId: 'wf-1' },
    });
  });

  it('links the cover before reading the song back, so the add result carries it', async () => {
    await postFromGenerator();
    const [linkOrder] = dbMock.dbWrite.$executeRaw.mock.invocationCallOrder;
    const [readOrder] = dbMock.dbWrite.image.findUnique.mock.invocationCallOrder;
    expect(linkOrder).toBeLessThan(readOrder);
  });

  it.each([
    ['the workflow has no cover step', { steps: [songStep] }],
    ['the cover is not available', { steps: [songStep, coverStep({ available: false })] }],
    ['the cover was blocked', { steps: [songStep, coverStep({ blockedReason: 'NSFWLevel' })] }],
    ['the cover is unrated', { steps: [songStep, coverStep({ nsfwLevel: 'na' })] }],
    ['the cover has no rating', { steps: [songStep, coverStep({ nsfwLevel: null })] }],
  ])('posts the song without a cover when %s', async (_, workflow) => {
    mocks.getWorkflow.mockResolvedValue(workflow);
    await postFromGenerator();
    expect(mocks.getWorkflow).toHaveBeenCalledTimes(1);
    expect(mocks.stageGenerationOutputImage).not.toHaveBeenCalled();
    expect(mocks.createImage).toHaveBeenCalledTimes(1);
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
  });

  it('posts the song without a cover when the copy fails', async () => {
    mocks.stageGenerationOutputImage.mockRejectedValue(new Error('not an allowed host'));
    await postFromGenerator();
    expect(mocks.stageGenerationOutputImage).toHaveBeenCalledTimes(1);
    expect(mocks.createImage).toHaveBeenCalledTimes(1);
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.image.findUnique).toHaveBeenCalled();
  });

  it('abandons a slow copy at the budget, so nothing is stored, and posts the song without a cover', async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      mocks.stageGenerationOutputImage.mockImplementation(
        (args: { signal: AbortSignal }) =>
          new Promise((_, reject) => {
            signal = args.signal;
            args.signal.addEventListener('abort', () => reject(new Error('aborted')));
          })
      );
      const pending = postFromGenerator();
      await vi.advanceTimersByTimeAsync(9_999);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(signal?.aborted).toBe(true);
      expect(mocks.createImage).toHaveBeenCalledTimes(1);
      expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  // A cover is linked only through `Track`; the metadata key is no longer part of the schema.
  it('ignores a cover id the client sent: the song keeps none of it and takes its generated cover', async () => {
    await postFromGenerator({ metadata: { ...song, coverImageId: 3 } });
    expect(mocks.createImage.mock.calls[0][0].metadata).not.toHaveProperty('coverImageId');
    expect(mocks.stageGenerationOutputImage).toHaveBeenCalledTimes(1);
    expect(linkValues()).toEqual([[11, 12]]);
  });

  it('removes the cover row when the link fails, and still posts the song', async () => {
    dbMock.dbWrite.$executeRaw.mockRejectedValue(new Error('db down'));
    await postFromGenerator();
    expect(mocks.deleteImages).toHaveBeenCalledWith([12], { actor: { id: 5 } });
    expect(dbMock.dbWrite.image.findUnique).toHaveBeenCalled();
  });

  it('posts the song without a cover when the cover row cannot be created', async () => {
    mocks.createImage.mockReset();
    mocks.createImage
      .mockResolvedValueOnce({ id: 11 })
      .mockRejectedValueOnce(new Error('media missing'));
    await postFromGenerator();
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.image.findUnique).toHaveBeenCalled();
  });

  it('copies no cover for a song posted without its workflow', async () => {
    await expect(addSong()).rejects.toThrow('An unexpected error');
    expect(mocks.getWorkflow).not.toHaveBeenCalled();
    expect(mocks.stageGenerationOutputImage).not.toHaveBeenCalled();
  });
});
