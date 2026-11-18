import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as RateLimitBucket from '~/server/utils/rate-limit-bucket';
import { isFailClosedRateLimitScope } from '~/server/utils/rate-limit-bucket';
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

const h = vi.hoisted(() => ({ claim: vi.fn() }));
vi.mock('~/server/utils/rate-limit-bucket', async (importOriginal) => ({
  ...(await importOriginal<typeof RateLimitBucket>()),
  claimRateLimitAttempt: h.claim,
}));

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
  const req = { headers: {} } as never;
  beforeEach(() => {
    h.claim.mockReset().mockResolvedValue(async () => undefined);
  });

  it("draws every viewer from one daily bucket of the cap's size", async () => {
    await claimSearchUploadSlot(req);
    expect(h.claim).toHaveBeenCalledWith(
      expect.objectContaining({
        keyName: 'imageSearchUpload:global',
        scope: 'imageSearchUpload.prepare',
        user: { id: 0 },
        rules: [expect.objectContaining({ limit: SEARCH_UPLOAD_GLOBAL_DAILY_CAP, period: 86400 })],
      })
    );
  });

  it('refuses when the bucket is full', async () => {
    h.claim.mockRejectedValue(Object.assign(new Error('full'), { code: 'TOO_MANY_REQUESTS' }));
    await expect(claimSearchUploadSlot(req)).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
  });

  it('is in a fail-closed scope, so an unreadable store refuses', () => {
    expect(isFailClosedRateLimitScope('imageSearchUpload.prepare')).toBe(true);
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
  const prepare = (url = BLOB_URL) => prepareSearchUpload({ userId: 5, url, req: {} as never });

  beforeEach(() => {
    h.claim.mockReset().mockResolvedValue(async () => undefined);
    rows.findSearchUploadByRef.mockReset().mockResolvedValue(null);
    rows.hasUnscannedSearchUpload.mockReset().mockResolvedValue(false);
    upload.stageGenerationOutputImage.mockReset().mockRejectedValue(new Error('stop at the fetch'));
  });

  it('refuses a url that is not an uploaded blob before looking anything up', async () => {
    await expect(prepare('https://evil.test/v2/consumer/blobs/x')).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(rows.findSearchUploadByRef).not.toHaveBeenCalled();
    expect(h.claim).not.toHaveBeenCalled();
  });

  it("reuses the viewer's upload of the same blob without a slot or a fetch", async () => {
    rows.findSearchUploadByRef.mockResolvedValue(41);
    await expect(prepare()).resolves.toEqual({ uploadId: 41 });
    expect(rows.findSearchUploadByRef).toHaveBeenCalledWith(5, 'upload:blob-1', expect.any(Date));
    expect(h.claim).not.toHaveBeenCalled();
    expect(upload.stageGenerationOutputImage).not.toHaveBeenCalled();
  });

  it('refuses while the viewer has an upload still being scanned, without taking a slot', async () => {
    rows.hasUnscannedSearchUpload.mockResolvedValue(true);
    await expect(prepare()).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    expect(h.claim).not.toHaveBeenCalled();
    expect(upload.stageGenerationOutputImage).not.toHaveBeenCalled();
  });

  it('takes a slot before fetching, and fetches nothing once the cap is reached', async () => {
    await expect(prepare()).rejects.toThrow('stop at the fetch');
    expect(h.claim).toHaveBeenCalledTimes(1);
    upload.stageGenerationOutputImage.mockClear();
    h.claim.mockRejectedValue(Object.assign(new Error('full'), { code: 'TOO_MANY_REQUESTS' }));
    await expect(prepare()).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    expect(upload.stageGenerationOutputImage).not.toHaveBeenCalled();
  });
});
