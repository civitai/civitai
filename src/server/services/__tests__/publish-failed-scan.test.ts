import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as Attestation from '~/server/services/base-model-attestation.service';
import type * as NonCommercial from '~/server/services/non-commercial-publish.service';

/**
 * Every publish path refuses a version with a file that failed its scan, for moderators too. The
 * count stub applies the filter it is given, so a check that loses the scan condition or the
 * version scope shows up here.
 */

vi.mock('~/server/services/base-model-attestation.service', async (importOriginal) => ({
  ...(await importOriginal<typeof Attestation>()),
  assertBaseModelAttestations: () => undefined,
}));
vi.mock('~/server/services/non-commercial-publish.service', async (importOriginal) => ({
  ...(await importOriginal<typeof NonCommercial>()),
  assertNonCommercialVersionsUnmonetized: async () => undefined,
}));

const { publishModelById, publishPrivateModel, privateModelFromTraining } = await import(
  '~/server/services/model.service'
);
const { publishModelVersionById } = await import('~/server/services/model-version.service');
const { restoreModelRemovedWithOwner } = await import(
  '~/server/services/model-removed-with-owner.service'
);
const { failedScanPublishMessage } = await import('~/server/utils/failed-scan');

const FAILED = 7;
const CLEAN = 8;
const OTHER_MODEL_FAILED = 9;
const TAKEN_DOWN_FAILED = 10;
const versions = [
  { id: FAILED, modelId: 1, status: 'Published' },
  { id: CLEAN, modelId: 1, status: 'Draft' },
  { id: OTHER_MODEL_FAILED, modelId: 2, status: 'Published' },
  { id: TAKEN_DOWN_FAILED, modelId: 4, status: 'UnpublishedViolation' },
];
const files = [
  { modelVersionId: FAILED, pickleScanResult: 'Success', virusScanResult: 'Danger' },
  { modelVersionId: CLEAN, pickleScanResult: 'Error', virusScanResult: 'Success' },
  { modelVersionId: OTHER_MODEL_FAILED, pickleScanResult: 'Danger', virusScanResult: 'Success' },
  { modelVersionId: TAKEN_DOWN_FAILED, pickleScanResult: 'Danger', virusScanResult: 'Success' },
];

type IdFilter = number | { in: number[] };
type VersionWhere = {
  id?: IdFilter;
  modelId?: number;
  status?: { in?: string[]; notIn?: string[] };
};
type CountWhere = {
  modelVersion: VersionWhere;
  OR: Array<{ pickleScanResult?: string; virusScanResult?: string }>;
};
const matchesId = (filter: IdFilter | undefined, id: number) =>
  filter === undefined || (typeof filter === 'number' ? filter === id : filter.in.includes(id));

beforeEach(() => {
  vi.clearAllMocks();
  // Applies every filter it is given, so a lost scope or scan condition shows up as a wrong count.
  dbMock.dbWrite.modelFile.count.mockImplementation((async ({ where }: { where: CountWhere }) => {
    const scope = where.modelVersion;
    const inScope = versions
      .filter(
        (v) =>
          matchesId(scope.id, v.id) &&
          (scope.modelId === undefined || scope.modelId === v.modelId) &&
          (!scope.status?.in || scope.status.in.includes(v.status)) &&
          (!scope.status?.notIn || !scope.status.notIn.includes(v.status))
      )
      .map((v) => v.id);
    return files.filter(
      (f) =>
        inScope.includes(f.modelVersionId) &&
        where.OR.some(
          (c) =>
            (c.pickleScanResult && c.pickleScanResult === f.pickleScanResult) ||
            (c.virusScanResult && c.virusScanResult === f.virusScanResult)
        )
    ).length;
  }) as never);
});

/** The publish's error message, or undefined when it got past every check. */
const failure = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: Error) => e.message
  );

describe('publishing a version with a file that failed its scan', () => {
  const version = (id: number) => ({
    id,
    name: 'v',
    baseModel: 'SDXL 1.0',
    publishedAt: null,
    meta: {},
    model: { userId: 1, type: 'LORA', name: 'm', availability: 'Public', nsfw: false, meta: {} },
  });

  it('is refused by publishModelVersionById; a version whose scan only errored is not', async () => {
    dbMock.dbRead.modelVersion.findUniqueOrThrow.mockImplementation((async ({
      where,
    }: {
      where: { id: number };
    }) => version(where.id)) as never);

    expect(await failure(publishModelVersionById({ id: FAILED, enforceTakedown: false }))).toBe(
      failedScanPublishMessage
    );
    expect(await failure(publishModelVersionById({ id: CLEAN, enforceTakedown: false }))).not.toBe(
      failedScanPublishMessage
    );
  });

  it('is refused by publishModelById for a listed version', async () => {
    dbMock.dbWrite.modelVersion.findMany.mockImplementation((async ({
      where,
    }: {
      where: { id: { in: number[] } };
    }) => where.id.in.map(version)) as never);

    expect(await failure(publishModelById({ id: 1, versionIds: [CLEAN, FAILED] }))).toBe(
      failedScanPublishMessage
    );
    expect(await failure(publishModelById({ id: 1, versionIds: [CLEAN] }))).not.toBe(
      failedScanPublishMessage
    );
  });

  it('is refused by publishModelById republishing the live versions, scoped to its model', async () => {
    expect(await failure(publishModelById({ id: 1 }))).toBe(failedScanPublishMessage);
    // Model 3 has no versions; model 2's failed file is not its concern.
    expect(await failure(publishModelById({ id: 3 }))).not.toBe(failedScanPublishMessage);
  });

  it('is refused by publishPrivateModel', async () => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue({
      id: 1,
      userId: 1,
      name: 'm',
      description: null,
      availability: 'Private',
      status: 'Published',
      meta: {},
      type: 'LORA',
    } as never);
    dbMock.dbWrite.modelVersion.findMany.mockResolvedValue([version(FAILED)] as never);

    expect(
      await failure(publishPrivateModel({ modelId: 1, publishVersions: true, isModerator: true }))
    ).toBe(failedScanPublishMessage);
    dbMock.dbWrite.modelVersion.findMany.mockResolvedValue([version(CLEAN)] as never);
    expect(
      await failure(publishPrivateModel({ modelId: 1, publishVersions: true, isModerator: true }))
    ).not.toBe(failedScanPublishMessage);
  });

  it('is refused by a moderator restoring a model a content wipe kept', async () => {
    const restore = (taken: { id: number; status: string }[]) => {
      dbMock.dbWrite.model.findUnique.mockResolvedValue({
        meta: { removedWithOwner: true, versionsUnpublishedByRemoval: taken },
      } as never);
      return failure(restoreModelRemovedWithOwner(1));
    };

    expect(await restore([{ id: FAILED, status: 'Published' }])).toBe(failedScanPublishMessage);
    // Restored as a draft, it is not made public.
    expect(await restore([{ id: FAILED, status: 'Draft' }])).not.toBe(failedScanPublishMessage);
  });

  it('is refused by privateModelFromTraining, ignoring versions a moderator took down', async () => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue({
      name: 'm',
      userId: 1,
      lockedProperties: [],
      meta: {},
      status: 'Draft',
      availability: 'Private',
      minor: false,
      poi: false,
    } as never);
    const fromTraining = (id: number) =>
      failure(
        privateModelFromTraining({
          id,
          name: 'm',
          type: 'LORA',
          user: { id: 1, isModerator: false },
        } as never)
      );

    expect(await fromTraining(1)).toBe(failedScanPublishMessage);
    // Model 3 has no versions; model 4's failed file is in a version that stays down.
    for (const id of [3, 4]) {
      expect(await fromTraining(id)).not.toBe(failedScanPublishMessage);
      // Reached the guard rather than failing before it.
      expect(dbMock.dbWrite.modelFile.count).toHaveBeenLastCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            modelVersion: expect.objectContaining({ modelId: id }),
          }),
        })
      );
    }
  });
});
