import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  throwOnBlockedUserContent: vi.fn(),
}));

const { addPostImage } = await import('~/server/services/post.service');

const user = { id: 5 } as never;
const song = { duration: 200, size: 3, title: 'Night Drive' };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.music = false;
  mocks.getWorkflow.mockResolvedValue({ steps: [] });
  dbMock.dbRead.post.findFirst.mockResolvedValue({ userId: 5, collection: null });
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
