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
  DUPLICATE_HASH_SHARED_OWNER_THRESHOLD,
} from '~/server/services/duplicate-model-hash.service';

const queryRaw = dbMock.dbWrite.$queryRaw;

const OWNER_ID = 7;
const ORIGINAL_OWNER_ID = 99;
const MODEL_ID = 42;
const MATCH = {
  fileId: 500,
  modelId: MODEL_ID,
  sha256: 'ABCDEF',
  originalModelId: 1000,
  originalVersionId: 2000,
  originalUserId: ORIGINAL_OWNER_ID,
  originalFileId: 400,
  ownerCount: 2,
  earliestHolderUserId: ORIGINAL_OWNER_ID,
  earliestHolderFileId: 400,
};
// The other owner's file was uploaded before the uploader's first copy of the bytes.
const ROW = { ...MATCH, ownerFirstFileId: 500 };
// The same bytes re-hosted by enough owners to count as a commonly shared file.
const SHARED_ROW = { ...ROW, ownerCount: DUPLICATE_HASH_SHARED_OWNER_THRESHOLD };
// An earlier holder (88) has an unpublished or deleted copy, so the live original may itself be a copy.
const UNSURE_ORIGINAL_ROW = { ...ROW, earliestHolderUserId: 88, earliestHolderFileId: 300 };
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
      userId: constants.system.user.id,
      isModerator: true,
    });
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'duplicate-model-hash', message: 'unpublished' }),
      'webhooks'
    );
  });

  it('only logs the match, with every field the review needs, while the kill switch is off', async () => {
    mockIsFlipt.mockResolvedValue(false);

    await expect(scan()).resolves.toBe('would-block');

    expect(mockUnpublishModelById).not.toHaveBeenCalled();
    expect(loggingMock.logToAxiom).toHaveBeenCalledExactlyOnceWith(
      {
        type: 'info',
        name: 'duplicate-model-hash',
        message: 'would-block',
        path: 'scan',
        decision: 'block',
        reason: 'cross-owner-copy',
        fileId: 500,
        modelId: MODEL_ID,
        sha256: 'ABCDEF',
        ownerId: OWNER_ID,
        ownerCount: 2,
        originalModelId: 1000,
        originalVersionId: 2000,
        originalUserId: ORIGINAL_OWNER_ID,
        originalFileId: 400,
        earliestHolderUserId: ORIGINAL_OWNER_ID,
        earliestHolderFileId: 400,
        flagEnabled: false,
      },
      'webhooks'
    );
  });

  // Positive control: one uploader re-hosting another creator's file, the original still live and
  // uploaded first, and nobody else holding the bytes. This is the case the check exists for.
  it('still unpublishes a copy of a single original that only its creator and the copier hold', async () => {
    queryRaw.mockResolvedValue([{ ...ROW, ownerCount: DUPLICATE_HASH_SHARED_OWNER_THRESHOLD - 1 }]);

    await expect(scan()).resolves.toBe('unpublished');
    expect(mockUnpublishModelById).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])(
    'never acts on a file held by enough owners to be commonly shared (flag on: %s)',
    async (enabled) => {
      mockIsFlipt.mockResolvedValue(enabled);
      queryRaw.mockResolvedValue([SHARED_ROW]);

      await expect(scan()).resolves.toBe('exempt');

      expect(mockUnpublishModelById).not.toHaveBeenCalled();
      expect(loggingMock.logToAxiom).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          name: 'duplicate-model-hash',
          message: 'exempt',
          decision: 'exempt',
          reason: 'shared-file',
          ownerCount: DUPLICATE_HASH_SHARED_OWNER_THRESHOLD,
          flagEnabled: enabled,
        }),
        'webhooks'
      );
    }
  );

  it('holds the shared-file threshold at three owners', () => {
    expect(DUPLICATE_HASH_SHARED_OWNER_THRESHOLD).toBe(3);
  });

  it.each([true, false])(
    'routes a match to review instead of acting when an earlier holder is not the chosen original (flag on: %s)',
    async (enabled) => {
      mockIsFlipt.mockResolvedValue(enabled);
      queryRaw.mockResolvedValue([UNSURE_ORIGINAL_ROW]);

      await expect(scan()).resolves.toBe('review');

      expect(mockUnpublishModelById).not.toHaveBeenCalled();
      expect(loggingMock.logToAxiom).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          name: 'duplicate-model-hash',
          message: 'review-needed',
          decision: 'review',
          reason: 'original-not-earliest-holder',
          originalUserId: ORIGINAL_OWNER_ID,
          earliestHolderUserId: 88,
          earliestHolderFileId: 300,
          flagEnabled: enabled,
        }),
        'webhooks'
      );
    }
  );

  it('exempts a shared file even when its earliest holder is not the chosen original', async () => {
    queryRaw.mockResolvedValue([{ ...UNSURE_ORIGINAL_ROW, ownerCount: 5 }]);

    await expect(scan()).resolves.toBe('exempt');
    expect(mockUnpublishModelById).not.toHaveBeenCalled();
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
    // prompted this check, so every type filter (the copy, the original, the owner count and the
    // earliest holder) takes the full list.
    const [strings, ...values] = queryRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    const typeSlots = strings
      .map((s, i) => (/\.type IN \($/.test(s.trimEnd()) ? i : -1))
      .filter((i) => i >= 0);
    expect(typeSlots).toHaveLength(4);
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
    queryRaw.mockResolvedValue([{ ...ROW, ownerFirstFileId: 300 }]);

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

    // ...and as the owner whose first copy of the bytes dates the comparison, who always counts
    // towards the owner count, and who is never the earliest other holder.
    const slots = (suffix: string) =>
      strings.flatMap((s, i) => (s.trimEnd().endsWith(suffix) ? [i] : []));
    expect(slots('m."userId" =').map((i) => values[i])).toEqual([OWNER_ID, OWNER_ID]);
    expect(slots('m."userId" <>').map((i) => values[i])).toEqual([OWNER_ID, OWNER_ID]);
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
      expect.objectContaining({
        message: 'would-block',
        path: 'publish',
        versionId: 100,
        modelId: MODEL_ID,
        sha256: 'ABCDEF',
        ownerCount: 2,
        originalModelId: 1000,
        decision: 'block',
        reason: 'cross-owner-copy',
        flagEnabled: false,
      }),
      'webhooks'
    );
  });

  it.each([
    ['a commonly shared file', SHARED_ROW, 'exempt'],
    ['a match whose original is in doubt', UNSURE_ORIGINAL_ROW, 'review-needed'],
  ])('lets %s publish with the flag on, logging why', async (_, row, message) => {
    queryRaw.mockResolvedValue([row]);

    await expect(assertPublish()).resolves.toBeUndefined();
    expect(loggingMock.logToAxiom).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message, path: 'publish', flagEnabled: true }),
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

  it("checks a model publish against its versions' ids, not a sub-select the planner misjudges", async () => {
    dbMock.dbWrite.modelVersion.findMany.mockResolvedValue([{ id: 11 }, { id: 12 }]);
    queryRaw.mockResolvedValue([]);

    await assertNotCrossOwnerDuplicate({ modelId: MODEL_ID, ownerId: OWNER_ID });

    expect(dbMock.dbWrite.modelVersion.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { modelId: MODEL_ID } })
    );
    const [, ...values] = queryRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    const scope = values.find(
      (v): v is { sql: string; values: unknown[] } =>
        typeof (v as { sql?: unknown })?.sql === 'string' &&
        (v as { sql: string }).sql.includes('"modelVersionId"')
    );
    expect(scope?.sql).not.toMatch(/SELECT/i);
    expect(scope?.values).toEqual([11, 12]);
  });

  it('does not query a model with no versions', async () => {
    dbMock.dbWrite.modelVersion.findMany.mockResolvedValue([]);

    await expect(
      assertNotCrossOwnerDuplicate({ modelId: MODEL_ID, ownerId: OWNER_ID })
    ).resolves.toBeUndefined();
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it.each([
    ['a moderator', { isModerator: true }],
    ['an official model', { ownerId: constants.system.officialUserId }],
  ])('lets %s publish without checking', async (_, overrides) => {
    await expect(assertPublish(overrides)).resolves.toBeUndefined();
    expect(queryRaw).not.toHaveBeenCalled();
  });
});
