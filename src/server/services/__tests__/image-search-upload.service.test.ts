import { beforeEach, describe, expect, it, vi } from 'vitest';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import type * as BlobRatings from '~/server/services/orchestrator/blobRatings';
import type * as BlockImageUpload from '~/server/services/blocks/block-image-upload.service';
import type * as SearchUploadRows from '~/server/services/search-upload-rows';
import type { SearchUploadRecord } from '~/server/services/search-upload-rows';

const rows = vi.hoisted(() => ({
  findOwnedSearchUpload: vi.fn(),
  findSearchUploadByRef: vi.fn(),
  hasUnscannedSearchUpload: vi.fn(),
}));
const blob = vi.hoisted(() => ({ readBlobState: vi.fn() }));
const upload = vi.hoisted(() => ({ stageGenerationOutputImage: vi.fn() }));
vi.mock('~/server/services/search-upload-rows', async (importOriginal) => ({
  ...(await importOriginal<typeof SearchUploadRows>()),
  ...rows,
}));
vi.mock('~/server/services/orchestrator/blobRatings', async (importOriginal) => ({
  ...(await importOriginal<typeof BlobRatings>()),
  ...blob,
}));
vi.mock('~/server/services/blocks/block-image-upload.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BlockImageUpload>()),
  ...upload,
}));

const h = {
  get incrBy() {
    return redisMock.redis.incrBy as unknown as ReturnType<typeof vi.fn>;
  },
  get expire() {
    return redisMock.redis.expire as unknown as ReturnType<typeof vi.fn>;
  },
};

import {
  claimSearchUploadSlot,
  getSearchUploadStatus,
  prepareSearchUpload,
  resolveSearchUploadAnchor,
  SEARCH_UPLOAD_GLOBAL_DAILY_CAP,
  SEARCH_UPLOAD_REFUSED_MESSAGE,
  SEARCH_UPLOAD_TTL_MS,
} from '~/server/services/image-search-upload.service';

describe('the global daily upload cap', () => {
  beforeEach(() => {
    h.incrBy.mockReset();
    h.expire.mockReset().mockResolvedValue(true);
  });

  it('admits the last upload under the cap', async () => {
    h.incrBy.mockResolvedValue(SEARCH_UPLOAD_GLOBAL_DAILY_CAP);
    await expect(claimSearchUploadSlot()).resolves.toBeUndefined();
  });

  it('refuses the first upload over the cap', async () => {
    h.incrBy.mockResolvedValue(SEARCH_UPLOAD_GLOBAL_DAILY_CAP + 1);
    await expect(claimSearchUploadSlot()).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
  });

  it('refuses when the counter cannot be read', async () => {
    h.incrBy.mockRejectedValue(new Error('redis down'));
    await expect(claimSearchUploadSlot()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });

  it('counts per UTC day and expires the day it starts', async () => {
    h.incrBy.mockResolvedValue(1);
    await claimSearchUploadSlot(new Date('2026-11-18T23:59:00Z'));
    await claimSearchUploadSlot(new Date('2026-11-19T00:01:00Z'));
    const [first, second] = h.incrBy.mock.calls.map(([key]) => key as string);
    expect(first).toMatch(/:2026-11-18$/);
    expect(second).toMatch(/:2026-11-19$/);
    expect(h.expire).toHaveBeenCalledTimes(2);
  });
});

describe('search upload status and search anchor', () => {
  const MIN = '0.5';
  const owned = (over: Partial<SearchUploadRecord> = {}): SearchUploadRecord => ({
    id: 40,
    url: 'uuid-key',
    nsfwLevel: 1,
    createdAt: new Date(),
    ingestion: 'Scanned',
    tosViolation: false,
    blockedFor: null,
    needsReview: null,
    minor: false,
    poi: false,
    metadata: {
      searchUploadAppId: 'search-upload',
      searchUploadRef: 'upload:blob-1',
      searchUploadFaceScan: { ran: true, faces: [] },
    },
    ...over,
  });
  const ask = (isModerator = false) =>
    resolveSearchUploadAnchor({ userId: 5, uploadId: 40, isModerator });

  beforeEach(() => {
    setEnv({ SEARCH_UPLOAD_FACE_ANIME_MIN: MIN });
    rows.findOwnedSearchUpload.mockReset().mockResolvedValue(owned());
    blob.readBlobState.mockReset().mockResolvedValue({
      verdict: 'rated',
      nsfwLevel: 'pg',
      blockedReason: null,
      location: null,
    });
  });

  it("gives a passed upload's level and embed url, looked up for the viewer", async () => {
    await expect(ask()).resolves.toMatchObject({ nsfwLevel: 1 });
    expect(rows.findOwnedSearchUpload).toHaveBeenCalledWith(5, 40);
    expect(blob.readBlobState).toHaveBeenCalledWith('blob-1');
  });

  it("is not found when the upload is not the viewer's", async () => {
    rows.findOwnedSearchUpload.mockResolvedValue(null);
    await expect(ask()).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('is not found once the upload has expired', async () => {
    rows.findOwnedSearchUpload.mockResolvedValue(
      owned({ createdAt: new Date(Date.now() - SEARCH_UPLOAD_TTL_MS - 1000) })
    );
    await expect(ask()).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('waits while the blob verdict is pending', async () => {
    blob.readBlobState.mockResolvedValue({ verdict: 'pending' });
    await expect(ask()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('refuses a non-moderator a photo, with only the generic message, and lets a moderator search', async () => {
    rows.findOwnedSearchUpload.mockResolvedValue(
      owned({
        metadata: {
          ...owned().metadata,
          searchUploadFaceScan: { ran: true, faces: [{ animeProbability: 0.1 }] },
        },
      })
    );
    await expect(ask()).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: SEARCH_UPLOAD_REFUSED_MESSAGE,
    });
    await expect(ask(true)).resolves.toMatchObject({ nsfwLevel: 1 });
    await expect(
      getSearchUploadStatus({ userId: 5, uploadId: 40, isModerator: false })
    ).resolves.toEqual({ status: 'refused', message: SEARCH_UPLOAD_REFUSED_MESSAGE });
  });

  it('refuses any face when the setting is missing', async () => {
    setEnv({ SEARCH_UPLOAD_FACE_ANIME_MIN: undefined });
    rows.findOwnedSearchUpload.mockResolvedValue(
      owned({
        metadata: {
          ...owned().metadata,
          searchUploadFaceScan: { ran: true, faces: [{ animeProbability: 1 }] },
        },
      })
    );
    await expect(ask()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuses a row with no blob to check, for a moderator too', async () => {
    rows.findOwnedSearchUpload.mockResolvedValue(
      owned({ metadata: { searchUploadAppId: 'search-upload' } })
    );
    await expect(ask(true)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(blob.readBlobState).not.toHaveBeenCalled();
  });
});

describe('preparing a search upload', () => {
  const BLOB_URL = 'https://orchestration.civitai.com/v2/consumer/blobs/blob-1';
  const prepare = (url = BLOB_URL) => prepareSearchUpload({ userId: 5, url });

  beforeEach(() => {
    h.incrBy.mockReset().mockResolvedValue(1);
    h.expire.mockReset().mockResolvedValue(true);
    rows.findSearchUploadByRef.mockReset().mockResolvedValue(null);
    rows.hasUnscannedSearchUpload.mockReset().mockResolvedValue(false);
    upload.stageGenerationOutputImage.mockReset().mockRejectedValue(new Error('stop at the fetch'));
  });

  it('refuses a url that is not an uploaded blob before looking anything up', async () => {
    await expect(prepare('https://evil.test/v2/consumer/blobs/x')).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(rows.findSearchUploadByRef).not.toHaveBeenCalled();
    expect(h.incrBy).not.toHaveBeenCalled();
  });

  it("reuses the viewer's upload of the same blob without a slot or a fetch", async () => {
    rows.findSearchUploadByRef.mockResolvedValue(41);
    await expect(prepare()).resolves.toEqual({ uploadId: 41 });
    expect(rows.findSearchUploadByRef).toHaveBeenCalledWith(5, 'upload:blob-1', expect.any(Date));
    expect(h.incrBy).not.toHaveBeenCalled();
    expect(upload.stageGenerationOutputImage).not.toHaveBeenCalled();
  });

  it('refuses while the viewer has an upload still being scanned, without taking a slot', async () => {
    rows.hasUnscannedSearchUpload.mockResolvedValue(true);
    await expect(prepare()).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    expect(h.incrBy).not.toHaveBeenCalled();
    expect(upload.stageGenerationOutputImage).not.toHaveBeenCalled();
  });

  it('takes a slot before fetching, and fetches nothing once the cap is reached', async () => {
    await expect(prepare()).rejects.toThrow('stop at the fetch');
    expect(h.incrBy).toHaveBeenCalledTimes(1);
    upload.stageGenerationOutputImage.mockClear();
    h.incrBy.mockResolvedValue(SEARCH_UPLOAD_GLOBAL_DAILY_CAP + 1);
    await expect(prepare()).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    expect(upload.stageGenerationOutputImage).not.toHaveBeenCalled();
  });
});
