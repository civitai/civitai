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

const { publishModelById, publishPrivateModel } = await import('~/server/services/model.service');
const { publishModelVersionById } = await import('~/server/services/model-version.service');
const { failedScanPublishMessage } = await import('~/server/utils/failed-scan');

const FAILED = 7;
const CLEAN = 8;
const files = [
  { modelVersionId: FAILED, pickleScanResult: 'Success', virusScanResult: 'Danger' },
  { modelVersionId: CLEAN, pickleScanResult: 'Error', virusScanResult: 'Success' },
];

type CountWhere = {
  modelVersion: { id: number | { in: number[] } };
  OR: Array<{ pickleScanResult?: string; virusScanResult?: string }>;
};

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.modelFile.count.mockImplementation((async ({ where }: { where: CountWhere }) => {
    const scope = where.modelVersion.id;
    const ids = typeof scope === 'number' ? [scope] : scope.in;
    return files.filter(
      (f) =>
        ids.includes(f.modelVersionId) &&
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
  });
});
