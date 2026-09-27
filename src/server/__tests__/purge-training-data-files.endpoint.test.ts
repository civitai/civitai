import { DeleteObjectCommand, ListObjectVersionsCommand } from '@aws-sdk/client-s3';
import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as EndpointHelpers from '~/server/utils/endpoint-helpers';
import type * as S3Utils from '~/utils/s3-utils';

const BUCKET = 'civitai-modelfiles';
const KEY = 'training-images/1/10TrainingData.abcd.zip';
const URL_ = `https://s3.us-west-004.backblazeb2.com/${BUCKET}/${KEY}`;

type Entry = { key: string; versionId: string; isDeleteMarker: boolean; size?: number };

/** A versioned bucket: a delete WITHOUT a VersionId only adds a delete marker, as on B2. */
function versionedBucket(initial: Entry[]) {
  let store = [...initial];
  let seq = 0;
  let calls = 0;
  const deletes: (string | undefined)[] = [];
  const s3 = {
    send: vi.fn(async (cmd: unknown) => {
      if (++calls > 200) throw new Error('runaway s3 loop');
      if (cmd instanceof ListObjectVersionsCommand) {
        const prefix = cmd.input.Prefix ?? '';
        const hits = store.filter((e) => e.key.startsWith(prefix));
        return {
          IsTruncated: false,
          Versions: hits
            .filter((e) => !e.isDeleteMarker)
            .map((e) => ({ Key: e.key, VersionId: e.versionId, Size: e.size })),
          DeleteMarkers: hits
            .filter((e) => e.isDeleteMarker)
            .map((e) => ({ Key: e.key, VersionId: e.versionId })),
        };
      }
      if (cmd instanceof DeleteObjectCommand) {
        const { Key, VersionId } = cmd.input;
        deletes.push(VersionId);
        if (VersionId) store = store.filter((e) => !(e.key === Key && e.versionId === VersionId));
        else store.push({ key: Key!, versionId: `marker-${++seq}`, isDeleteMarker: true });
        return {};
      }
      throw new Error('unexpected command');
    }),
  };
  const current = (key: string) => {
    const mine = store.filter((e) => e.key === key);
    const latest = mine[mine.length - 1];
    return latest && !latest.isDeleteMarker;
  };
  return { s3, deletes, store: () => store, current };
}

const mocks = vi.hoisted(() => ({
  bucket: null as null | ReturnType<typeof versionedBucket>,
  safe: vi.fn(),
}));

vi.mock('~/server/utils/endpoint-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof EndpointHelpers>()),
  WebhookEndpoint: (handler: unknown) => handler,
}));
vi.mock('~/utils/s3-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof S3Utils>()),
  getB2S3Client: () => mocks.bucket!.s3,
  urlsSafeToDelete: mocks.safe,
  headObject: async (_b: string, key: string) =>
    mocks.bucket!.current(key) ? { status: 'present', size: 1 } : { status: 'absent' },
}));

import handler from '~/pages/api/admin/temp/purge-training-data-files';

function fileRow(overrides: { deletedAt?: Date | null; url?: string } = {}) {
  return {
    id: 7,
    url: overrides.url ?? URL_,
    modelVersionId: 10,
    modelVersion: {
      uploadType: 'Trained',
      model: { deletedAt: 'deletedAt' in overrides ? overrides.deletedAt : new Date() },
    },
  };
}

async function call(query: Record<string, string>) {
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
  await (handler as unknown as (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>)(
    { query } as unknown as NextApiRequest,
    res as unknown as NextApiResponse
  );
  return res.json.mock.calls[0]?.[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.safe.mockImplementation(async (urls: string[]) => ({ safe: urls, skipped: 0 }));
  mocks.bucket = versionedBucket([
    { key: KEY, versionId: 'v1', isDeleteMarker: false, size: 100 },
    { key: KEY, versionId: 'v2', isDeleteMarker: false, size: 100 },
    { key: `${KEY}.other`, versionId: 'o1', isDeleteMarker: false, size: 5 },
  ]);
  dbMock.dbWrite.modelFile.findMany.mockResolvedValue([fileRow()] as never);
});

describe('purge-training-data-files', () => {
  it('removes every stored version of the object, not just the current one, then the row', async () => {
    const body = await call({ modelVersionIds: '10', dryRun: 'false' });

    expect(mocks.bucket!.store().filter((e) => e.key === KEY)).toEqual([]);
    expect(mocks.bucket!.deletes).toEqual(['v1', 'v2']);
    expect(body.results[0]).toMatchObject({ rowDeleted: true, headAfter: 'absent' });
    expect(dbMock.dbWrite.modelFile.delete).toHaveBeenCalledWith({ where: { id: 7 } });
  });

  it('leaves an object that only shares the key as a prefix alone', async () => {
    await call({ modelVersionIds: '10', dryRun: 'false' });
    expect(mocks.bucket!.store()).toEqual([
      { key: `${KEY}.other`, versionId: 'o1', isDeleteMarker: false, size: 5 },
    ]);
  });

  it('deletes nothing by default and reports the stored versions', async () => {
    const body = await call({ modelVersionIds: '10' });

    expect(body.dryRun).toBe(true);
    expect(mocks.bucket!.deletes).toEqual([]);
    expect(dbMock.dbWrite.modelFile.delete).not.toHaveBeenCalled();
    expect(body.results[0].storedVersionsBefore).toHaveLength(2);
    expect(body.results[0].headBefore).toBe('present');
  });

  it('deletes nothing when a listed version has no id, since that delete would only hide it', async () => {
    mocks.bucket = versionedBucket([{ key: KEY, versionId: '', isDeleteMarker: false, size: 100 }]);

    const body = await call({ modelVersionIds: '10', dryRun: 'false' });

    expect(body.results[0].error).toBe('a stored version has no id; nothing deleted');
    expect(mocks.bucket!.deletes).toEqual([]);
    expect(dbMock.dbWrite.modelFile.delete).not.toHaveBeenCalled();
  });

  it('keeps the row when bytes remain after the delete', async () => {
    mocks.bucket!.s3.send.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof DeleteObjectCommand) return {};
      return {
        IsTruncated: false,
        Versions: [{ Key: KEY, VersionId: 'v1', Size: 100 }],
        DeleteMarkers: [],
      };
    });

    const body = await call({ modelVersionIds: '10', dryRun: 'false' });

    expect(body.results[0].error).toBe('object still present after delete; row kept');
    expect(dbMock.dbWrite.modelFile.delete).not.toHaveBeenCalled();
  });

  it('refuses a file whose model is not deleted', async () => {
    dbMock.dbWrite.modelFile.findMany.mockResolvedValue([fileRow({ deletedAt: null })] as never);

    const body = await call({ modelVersionIds: '10', dryRun: 'false' });

    expect(body.results[0].skipped).toBe('model-not-deleted-or-not-trained');
    expect(mocks.bucket!.deletes).toEqual([]);
  });

  it('refuses an object another file row still points at', async () => {
    mocks.safe.mockResolvedValue({ safe: [], skipped: 1 });

    const body = await call({ modelVersionIds: '10', dryRun: 'false' });

    expect(mocks.safe).toHaveBeenCalledWith([URL_], 7);
    expect(body.results[0].skipped).toBe('still-referenced');
    expect(mocks.bucket!.deletes).toEqual([]);
  });

  it('refuses a url outside the allowlisted buckets', async () => {
    dbMock.dbWrite.modelFile.findMany.mockResolvedValue([
      fileRow({ url: `https://s3.us-west-004.backblazeb2.com/someone-else/${KEY}` }),
    ] as never);

    const body = await call({ modelVersionIds: '10', dryRun: 'false' });

    expect(body.results[0].skipped).toBe('bucket-not-allowed');
    expect(mocks.bucket!.deletes).toEqual([]);
  });
});
