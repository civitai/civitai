import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

const { mockIsFlipt, mockUnpublishModelById } = vi.hoisted(() => ({
  mockIsFlipt: vi.fn(),
  mockUnpublishModelById: vi.fn(),
}));

vi.mock('~/server/flipt/client', () => ({
  isFlipt: mockIsFlipt,
  FLIPT_FEATURE_FLAGS: { DUPLICATE_MODEL_HASH_BLOCK: 'duplicate-model-hash-block' },
}));
vi.mock('~/server/services/model.service', () => ({ unpublishModelById: mockUnpublishModelById }));

import { constants } from '~/server/common/constants';
import { primaryModelFileTypes } from '~/utils/file-display-helpers';
import {
  assertNotCrossOwnerDuplicate,
  checkDuplicateHashOnScan,
  DUPLICATE_HASH_MIN_SIZE_KB,
} from '~/server/services/duplicate-model-hash.service';

const queryRaw = dbMock.dbWrite.$queryRaw;

const OWNER_ID = 7;
const ORIGINAL_OWNER_ID = 99;
const MODEL_ID = 42;
const MATCH = {
  fileId: 500,
  originalModelId: 1000,
  originalVersionId: 2000,
  originalUserId: ORIGINAL_OWNER_ID,
};
// The other owner's file was uploaded before the uploader's first copy of the bytes.
const ROW = { ...MATCH, originalFileId: 400, ownerFirstFileId: 500 };
// A copy of the uploader's own work: the other owner's file came after the uploader's first one.
const LATER_COPY_ROW = { ...MATCH, originalFileId: 600, ownerFirstFileId: 500 };

const scan = (overrides: Partial<Parameters<typeof checkDuplicateHashOnScan>[0]> = {}) =>
  checkDuplicateHashOnScan({
    fileId: 500,
    fileType: 'Model',
    sizeKB: 200_000,
    sha256: 'ABCDEF',
    modelId: MODEL_ID,
    ownerId: OWNER_ID,
    modelStatus: 'Draft',
    modelMeta: { showcaseCollectionId: 3 } as never,
    ...overrides,
  });

beforeEach(() => {
  vi.clearAllMocks();
  queryRaw.mockResolvedValue([ROW]);
  mockIsFlipt.mockResolvedValue(true);
  mockUnpublishModelById.mockResolvedValue({});
});

describe('checkDuplicateHashOnScan', () => {
  it("unpublishes a model whose primary file copies another creator's published file", async () => {
    await expect(scan()).resolves.toBe('unpublished');

    expect(mockIsFlipt).toHaveBeenCalledWith('duplicate-model-hash-block');
    expect(mockUnpublishModelById).toHaveBeenCalledExactlyOnceWith({
      id: MODEL_ID,
      reason: 'duplicate',
      customMessage: expect.stringContaining('/models/1000?modelVersionId=2000'),
      meta: { showcaseCollectionId: 3 },
      userId: constants.system.user.id,
      isModerator: true,
    });
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'duplicate-model-hash', message: 'unpublished' }),
      'webhooks'
    );
  });

  it('only logs the match while the kill switch is off', async () => {
    mockIsFlipt.mockResolvedValue(false);

    await expect(scan()).resolves.toBe('suppressed');

    expect(mockUnpublishModelById).not.toHaveBeenCalled();
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'duplicate-model-hash',
        message: 'suppressed',
        path: 'scan',
        originalModelId: 1000,
      }),
      'webhooks'
    );
  });

  it('does nothing when no other creator has the file', async () => {
    queryRaw.mockResolvedValue([]);

    await expect(scan()).resolves.toBe('none');

    expect(mockUnpublishModelById).not.toHaveBeenCalled();
    expect(loggingMock.logToAxiom).not.toHaveBeenCalled();
  });

  it('matches every primary weights type on both sides of the comparison', async () => {
    await scan();

    // Copies uploaded as 'Model' of originals stored as 'Diffusion Model' are the case that
    // prompted this check, so both the copy's and the original's type filter take the full list.
    const [strings, ...values] = queryRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    const typeSlots = strings
      .map((s, i) => (/\.type IN \($/.test(s.trimEnd()) ? i : -1))
      .filter((i) => i >= 0);
    expect(typeSlots).toHaveLength(2);
    for (const i of typeSlots) {
      expect((values[i] as { values: unknown[] }).values).toEqual([...primaryModelFileTypes]);
    }
  });

  it("does not treat a later copy of the uploader's own file as the original", async () => {
    queryRaw.mockResolvedValue([LATER_COPY_ROW]);

    await expect(scan()).resolves.toBe('none');

    expect(mockUnpublishModelById).not.toHaveBeenCalled();
    expect(loggingMock.logToAxiom).not.toHaveBeenCalled();
  });

  it('dates the uploader by their FIRST copy, so re-uploading their own weights is not a match', async () => {
    // The scanned file (500) is newer than the other owner's (400), but the uploader already had
    // these bytes in an older file (300): the other owner's file is the copy.
    queryRaw.mockResolvedValue([{ ...MATCH, originalFileId: 400, ownerFirstFileId: 300 }]);

    await expect(scan()).resolves.toBe('none');
    expect(mockUnpublishModelById).not.toHaveBeenCalled();
  });

  it('skips a later copy and matches an earlier original listed after it', async () => {
    queryRaw.mockResolvedValue([
      { ...LATER_COPY_ROW, originalModelId: 3000 },
      { ...ROW, originalModelId: 1000 },
    ]);

    await expect(scan()).resolves.toBe('unpublished');
    expect(mockUnpublishModelById).toHaveBeenCalledWith(
      expect.objectContaining({ customMessage: expect.stringContaining('/models/1000?') })
    );
  });

  it('binds the uploader as the owner the original must differ from', async () => {
    await scan();

    // A same-owner re-upload is excluded by the query itself, so pin that the uploader's id is
    // the value compared against the original model's owner.
    const [strings, ...values] = queryRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    const ownerSlot = strings.findIndex((s) => s.trimEnd().endsWith('om."userId" <>'));
    expect(ownerSlot).toBeGreaterThanOrEqual(0);
    expect(values[ownerSlot]).toBe(OWNER_ID);

    // ...and as the owner whose first copy of the bytes dates the comparison.
    const firstCopySlot = strings.findIndex((s) => s.trimEnd().endsWith('m."userId" ='));
    expect(firstCopySlot).toBeGreaterThanOrEqual(0);
    expect(values[firstCopySlot]).toBe(OWNER_ID);
  });

  it.each([
    ['an official upload', { ownerId: constants.system.officialUserId }],
    ['a file under the size floor', { sizeKB: DUPLICATE_HASH_MIN_SIZE_KB - 1 }],
    ['a non-primary file', { fileType: 'Config' }],
    ['a rescan of unchanged bytes', { previousSha256: 'abcdef' }],
    ['a model a moderator already took down', { modelStatus: 'UnpublishedViolation' as const }],
    ['a deleted model', { modelStatus: 'Deleted' as const }],
  ])('skips %s without querying', async (_, overrides) => {
    await expect(scan(overrides)).resolves.toBe('skipped');

    expect(queryRaw).not.toHaveBeenCalled();
    expect(mockUnpublishModelById).not.toHaveBeenCalled();
  });

  // Negative controls for the skips above: each gate lets the ordinary case through.
  it.each([
    ['a file exactly at the size floor', { sizeKB: DUPLICATE_HASH_MIN_SIZE_KB }],
    ['a primary file stored as a Diffusion Model', { fileType: 'Diffusion Model' }],
    ['a re-upload with new bytes', { previousSha256: 'OLDHASH' }],
    ['a published model', { modelStatus: 'Published' as const }],
  ])('checks %s', async (_, overrides) => {
    await expect(scan(overrides)).resolves.toBe('unpublished');
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });
});

describe('assertNotCrossOwnerDuplicate', () => {
  const assertPublish = (overrides: { ownerId?: number; isModerator?: boolean } = {}) =>
    assertNotCrossOwnerDuplicate({ versionId: 100, ownerId: OWNER_ID, ...overrides });

  it("refuses to publish a copy of another creator's file", async () => {
    await expect(assertPublish()).rejects.toThrowError(/another creator's model \(\/models\/1000/);
  });

  it('lets the publish through, logging the match, while the kill switch is off', async () => {
    mockIsFlipt.mockResolvedValue(false);

    await expect(assertPublish()).resolves.toBeUndefined();
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'suppressed', path: 'publish', versionId: 100 }),
      'webhooks'
    );
  });

  it('lets a creator republish an original that someone else has since copied', async () => {
    queryRaw.mockResolvedValue([LATER_COPY_ROW]);

    await expect(assertPublish()).resolves.toBeUndefined();
    expect(loggingMock.logToAxiom).not.toHaveBeenCalled();
  });

  it('lets an ordinary publish through', async () => {
    queryRaw.mockResolvedValue([]);

    await expect(assertPublish()).resolves.toBeUndefined();
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a moderator', { isModerator: true }],
    ['an official model', { ownerId: constants.system.officialUserId }],
  ])('lets %s publish without checking', async (_, overrides) => {
    await expect(assertPublish(overrides)).resolves.toBeUndefined();
    expect(queryRaw).not.toHaveBeenCalled();
  });
});
