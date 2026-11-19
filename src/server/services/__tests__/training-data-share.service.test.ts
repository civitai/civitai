import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

const ownerHeld = vi.hoisted(() => vi.fn());
vi.mock('~/server/services/legal-hold.service', () => ({ ownerHeld, ownerHeldSql: () => '' }));
const deleteFilesForModelVersionCache = vi.hoisted(() => vi.fn());
vi.mock('~/server/services/model-file.service', () => ({ deleteFilesForModelVersionCache }));

const { setStudioDatasetShare, trainingDataShareFromQuery } = await import(
  '~/server/services/training-data-share.service'
);

const row = (sizeKB: number, metadata: Record<string, unknown> = {}) =>
  dbMock.dbWrite.$queryRaw.mockResolvedValue([
    { id: 7, sizeKB, metadata: { selectedEpochUrl: 'https://orch.example/E', ...metadata } },
  ]);
const written = () =>
  dbMock.dbWrite.modelFile.update.mock.calls[0][0] as {
    where: unknown;
    data: { visibility?: string; metadata: Record<string, unknown> };
  };
const archived = (complete?: boolean) => ({
  datasetArchive: { status: 'archived', items: 2, skipped: 0, complete, at: 'now' },
});
const shared = { ownRights: true, shareDataset: true };
/** The owner's own click. */
const owner = { raise: true, ownerId: 5 };

beforeEach(() => {
  dbMock.dbWrite.$queryRaw.mockReset();
  dbMock.dbWrite.modelFile.update.mockReset().mockResolvedValue({});
  ownerHeld.mockReset().mockResolvedValue(false);
  deleteFilesForModelVersionCache.mockReset();
});

describe('trainingDataShareFromQuery', () => {
  it('reads the publish entry’s choice, and only shares with the rights', () => {
    expect(trainingDataShareFromQuery({ ownRights: '1', shareDataset: '1' })).toEqual(shared);
    expect(trainingDataShareFromQuery({ ownRights: '0', shareDataset: '1' })).toEqual({
      ownRights: false,
      shareDataset: false,
    });
  });

  it('is undefined for an entry that carries no choice', () => {
    expect(trainingDataShareFromQuery({ workflowId: 'wf' })).toBeUndefined();
  });
});

describe('setStudioDatasetShare', () => {
  it('records the choice on a placeholder without touching its visibility', async () => {
    row(0);
    await setStudioDatasetShare(70, shared, owner);
    expect(written().data).not.toHaveProperty('visibility');
    expect(written().data.metadata).toMatchObject(shared);
    expect(deleteFilesForModelVersionCache).not.toHaveBeenCalled();
  });

  it('applies the choice to a complete archived zip at once', async () => {
    row(1024, archived(true));
    await setStudioDatasetShare(70, shared, owner);
    expect(written().data.visibility).toBe('Public');
    expect(deleteFilesForModelVersionCache).toHaveBeenCalledWith(70);
  });

  it('un-sharing an archived zip takes it back from Public', async () => {
    row(1024, { ...archived(true), ...shared });
    await setStudioDatasetShare(70, { ownRights: true, shareDataset: false }, owner);
    expect(written().data.visibility).toBe('Sensitive');
  });

  it.each([
    ['archived before completeness was recorded', archived(undefined)],
    ['missing items', archived(false)],
  ])('a zip %s stays Private when shared', async (_, metadata) => {
    row(1024, metadata);
    await setStudioDatasetShare(70, shared, owner);
    expect(written().data.visibility).toBe('Private');
  });

  it('a restricted owner or content keeps a shared zip Private', async () => {
    row(1024, archived(true));
    ownerHeld.mockResolvedValue(true);
    await setStudioDatasetShare(70, shared, owner);
    expect(written().data.visibility).toBe('Private');
  });

  it('a link alone records neither answer: rights and share wait for the owner’s click', async () => {
    row(1024, archived(true));
    await expect(setStudioDatasetShare(70, shared)).resolves.toBe(true);
    expect(written().data.metadata).toMatchObject({ ownRights: false, shareDataset: false });
    expect(written().data.visibility).toBe('Private');
  });

  it('a link alone cannot claim the rights', async () => {
    row(1024, archived(true));
    await setStudioDatasetShare(70, { ownRights: true, shareDataset: false });
    expect(written().data.metadata).toMatchObject({ ownRights: false });
    expect(written().data.visibility).toBe('Private');
  });

  it('the owner’s click cannot share a replaced dataset, which carries no archive state', async () => {
    // What a content replace leaves on a Studio row: real size, the choice, no archive or rating.
    row(2048, shared);
    await setStudioDatasetShare(70, shared, owner);
    expect(written().data).not.toHaveProperty('visibility');
  });

  it('a link un-sharing an archived zip takes it back from Public', async () => {
    row(1024, { ...archived(true), ...shared });
    await setStudioDatasetShare(70, { ownRights: true, shareDataset: false });
    expect(written().data.metadata).toMatchObject({ ownRights: true, shareDataset: false });
    expect(written().data.visibility).toBe('Sensitive');
  });

  it('the click writes only for the version’s owner', async () => {
    row(1024, archived(true));
    await setStudioDatasetShare(70, shared, owner);
    const [strings, ...values] = dbMock.dbWrite.$queryRaw.mock.calls[0] as [
      TemplateStringsArray,
      ...unknown[]
    ];
    const query = Prisma.sql(strings, ...values);
    expect(query.sql).toMatch(/m\."userId" = \?/);
    expect(query.values).toContain(5);
  });

  it('does nothing for a version with no Studio dataset row', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValue([]);
    await expect(setStudioDatasetShare(70, shared, owner)).resolves.toBe(false);
    expect(dbMock.dbWrite.modelFile.update).not.toHaveBeenCalled();
  });
});
