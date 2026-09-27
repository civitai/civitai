import {
  AbortMultipartUploadCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectVersionsCommand,
} from '@aws-sdk/client-s3';
import type { NextApiRequest, NextApiResponse } from 'next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as EndpointHelpers from '~/server/utils/endpoint-helpers';
import type * as DeliveryWorker from '~/utils/delivery-worker';
import type * as S3Utils from '~/utils/s3-utils';
import type * as StorageResolver from '~/utils/storage-resolver';

const OWNER = 1;
const BUCKET = 'civitai-modelfiles';
const KEY = `training-images/${OWNER}/10TrainingData.abcd.zip`;
const URL_ = `https://s3.us-west-004.backblazeb2.com/${BUCKET}/${KEY}`;

type Entry = { key: string; versionId: string; isDeleteMarker: boolean; size?: number };

/**
 * A versioned bucket. A delete WITHOUT a VersionId only adds a delete marker, as on B2, and HEAD
 * answers from the latest entry for the key, so a hidden object reads as absent.
 */
function versionedBucket(initial: Entry[], uploads: { key: string; uploadId: string }[] = []) {
  let store = [...initial];
  let pending = [...uploads];
  let seq = 0;
  let calls = 0;
  const deletes: (string | undefined)[] = [];
  const aborts: string[] = [];
  const heads: { bucket?: string; key?: string }[] = [];
  const current = (key: string) => {
    const mine = store.filter((e) => e.key === key);
    const latest = mine[mine.length - 1];
    return !!latest && !latest.isDeleteMarker;
  };
  const s3 = {
    truncateEvery: 0,
    send: vi.fn(async (cmd: unknown) => {
      if (++calls > 200) throw new Error('runaway s3 loop');
      if (cmd instanceof ListObjectVersionsCommand) {
        const prefix = cmd.input.Prefix ?? '';
        const all = store.filter((e) => e.key.startsWith(prefix));
        const start = cmd.input.VersionIdMarker
          ? all.findIndex((e) => e.versionId === cmd.input.VersionIdMarker) + 1
          : 0;
        const pageSize = s3.truncateEvery || all.length || 1;
        const hits = all.slice(start, start + pageSize);
        const truncated = start + pageSize < all.length;
        return {
          IsTruncated: truncated,
          NextKeyMarker: truncated ? hits[hits.length - 1].key : undefined,
          NextVersionIdMarker: truncated ? hits[hits.length - 1].versionId : undefined,
          Versions: hits
            .filter((e) => !e.isDeleteMarker)
            .map((e) => ({ Key: e.key, VersionId: e.versionId, Size: e.size })),
          DeleteMarkers: hits
            .filter((e) => e.isDeleteMarker)
            .map((e) => ({ Key: e.key, VersionId: e.versionId })),
        };
      }
      if (cmd instanceof ListMultipartUploadsCommand) {
        const prefix = cmd.input.Prefix ?? '';
        return {
          Uploads: pending
            .filter((u) => u.key.startsWith(prefix))
            .map((u) => ({ Key: u.key, UploadId: u.uploadId })),
        };
      }
      if (cmd instanceof AbortMultipartUploadCommand) {
        aborts.push(cmd.input.UploadId!);
        pending = pending.filter((u) => u.uploadId !== cmd.input.UploadId);
        return {};
      }
      if (cmd instanceof HeadObjectCommand) {
        heads.push({ bucket: cmd.input.Bucket, key: cmd.input.Key });
        if (cmd.input.Bucket === BUCKET && current(cmd.input.Key!)) return { ContentLength: 1 };
        throw Object.assign(new Error('NotFound'), { name: 'NotFound' });
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
  return { s3, deletes, aborts, heads, store: () => store, current };
}

type FileRow = {
  id: number;
  url: string;
  type: string;
  dataPurged: boolean;
  modelVersionId: number;
  modelVersion: { uploadType: string; model: { userId: number; deletedAt: Date | null } };
};

const mocks = vi.hoisted(() => ({
  bucket: null as null | ReturnType<typeof versionedBucket>,
  safe: vi.fn(),
  deregister: vi.fn(),
  // 'follow' = the resolver points at the fake bucket; others model a registration elsewhere.
  resolver: 'follow' as 'follow' | 'unregistered' | 'elsewhere' | 'forbidden' | 'down',
  rows: [] as unknown[],
  csamHeld: [] as number[],
}));

vi.mock('~/server/utils/endpoint-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof EndpointHelpers>()),
  WebhookEndpoint: (handler: unknown) => handler,
}));
vi.mock('~/utils/s3-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof S3Utils>()),
  getB2S3Client: () => mocks.bucket!.s3,
  urlsSafeToDelete: mocks.safe,
}));
vi.mock('~/utils/storage-resolver', async (importOriginal) => ({
  ...(await importOriginal<typeof StorageResolver>()),
  deregisterFileLocationsByFile: mocks.deregister,
}));
vi.mock('~/utils/delivery-worker', async (importOriginal) => {
  const actual = await importOriginal<typeof DeliveryWorker>();
  return {
    ...actual,
    getDownloadUrlByFileId: async () => {
      if (mocks.resolver === 'unregistered') throw new actual.StorageResolverError(404, 'nope');
      if (mocks.resolver === 'down') throw new Error('resolver unreachable');
      return { url: `https://cdn.test/${mocks.resolver}`, urlExpiryDate: new Date() };
    },
  };
});

import handler from '~/pages/api/admin/temp/purge-training-data-files';

function fileRow(overrides: Partial<FileRow> & { deletedAt?: Date | null } = {}): FileRow {
  const { deletedAt, ...rest } = overrides;
  return {
    id: 7,
    url: URL_,
    type: 'Training Data',
    dataPurged: false,
    modelVersionId: 10,
    modelVersion: {
      uploadType: 'Trained',
      model: { userId: OWNER, deletedAt: deletedAt === undefined ? new Date() : deletedAt },
    },
    ...rest,
  };
}

async function call(query: Record<string, string>, method = 'POST') {
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
  await (handler as unknown as (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>)(
    { query, method } as unknown as NextApiRequest,
    res as unknown as NextApiResponse
  );
  return { status: res.status.mock.calls[0]?.[0], body: res.json.mock.calls[0]?.[0] };
}

const live = (q: Record<string, string> = {}) =>
  call({ modelVersionIds: '10', dryRun: 'false', ...q });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolver = 'follow';
  mocks.csamHeld = [];
  mocks.safe.mockImplementation(async (urls: string[]) => ({ safe: urls, skipped: 0 }));
  mocks.deregister.mockResolvedValue({ deleted: 1 });
  mocks.bucket = versionedBucket([
    { key: KEY, versionId: 'v1', isDeleteMarker: false, size: 100 },
    { key: KEY, versionId: 'v2', isDeleteMarker: false, size: 100 },
    { key: `${KEY}.other`, versionId: 'o1', isDeleteMarker: false, size: 5 },
  ]);
  mocks.rows = [fileRow()];
  // The fake applies the endpoint's own filter, so a dropped condition selects rows it must not.
  dbMock.dbWrite.modelFile.findMany.mockImplementation((async (args: {
    where: { modelVersionId?: { in: number[] }; type?: string };
  }) =>
    (mocks.rows as FileRow[]).filter(
      (r) =>
        (!args.where.modelVersionId || args.where.modelVersionId.in.includes(r.modelVersionId)) &&
        (!args.where.type || r.type === args.where.type)
    )) as never);
  dbMock.dbWrite.$queryRaw.mockImplementation((async () =>
    mocks.csamHeld.map((id) => ({ id }))) as never);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.endsWith('/elsewhere')) return new Response(null, { status: 200 });
      if (url.endsWith('/forbidden')) return new Response(null, { status: 403 });
      return new Response(null, { status: mocks.bucket!.current(KEY) ? 200 : 404 });
    })
  );
});

afterEach(() => vi.unstubAllGlobals());

describe('purge-training-data-files', () => {
  it('removes every stored version, deregisters the file, then deletes the row', async () => {
    const { body } = await live();

    expect(mocks.bucket!.store().filter((e) => e.key === KEY)).toEqual([]);
    expect(mocks.bucket!.deletes).toEqual(['v1', 'v2']);
    expect(body.results[0]).toMatchObject({
      headAfter: 'absent',
      resolverAfter: 'absent',
      resolverDeregistered: 1,
      rowDeleted: true,
    });
    expect(mocks.deregister).toHaveBeenCalledWith([7]);
    expect(dbMock.dbWrite.modelFile.delete).toHaveBeenCalledTimes(1);
    expect(dbMock.dbWrite.modelFile.delete).toHaveBeenCalledWith({ where: { id: 7 } });
  });

  it('removes bytes an earlier delete only hid behind a marker', async () => {
    mocks.bucket = versionedBucket([
      { key: KEY, versionId: 'v1', isDeleteMarker: false, size: 100 },
      { key: KEY, versionId: 'm1', isDeleteMarker: true },
    ]);

    const { body } = await live();

    expect(body.results[0].headBefore).toBe('absent');
    expect(mocks.bucket!.deletes).toEqual(['v1', 'm1']);
    expect(mocks.bucket!.store()).toEqual([]);
    expect(body.results[0].rowDeleted).toBe(true);
  });

  it('follows the version listing across pages', async () => {
    mocks.bucket!.s3.truncateEvery = 1;

    await live();

    expect(mocks.bucket!.deletes).toEqual(['v1', 'v2']);
  });

  it('aborts an unfinished upload of the same key and no other', async () => {
    mocks.bucket = versionedBucket(
      [{ key: KEY, versionId: 'v1', isDeleteMarker: false, size: 100 }],
      [
        { key: KEY, uploadId: 'u1' },
        { key: `${KEY}.other`, uploadId: 'u2' },
      ]
    );

    const { body } = await live();

    expect(mocks.bucket!.aborts).toEqual(['u1']);
    expect(body.results[0]).toMatchObject({ unfinishedUploadsBefore: 1, rowDeleted: true });
  });

  it('leaves an object that only shares the key as a prefix alone', async () => {
    mocks.bucket = versionedBucket([
      { key: KEY, versionId: 'v1', isDeleteMarker: false, size: 100 },
      { key: `${KEY}.other`, versionId: 'o1', isDeleteMarker: false, size: 5 },
      { key: `${KEY}.other`, versionId: 'om1', isDeleteMarker: true },
    ]);

    await live();

    expect(mocks.bucket!.deletes).toEqual(['v1']);
    expect(mocks.bucket!.store()).toEqual([
      { key: `${KEY}.other`, versionId: 'o1', isDeleteMarker: false, size: 5 },
      { key: `${KEY}.other`, versionId: 'om1', isDeleteMarker: true },
    ]);
  });

  it('heads the object in its own bucket with the backend client', async () => {
    await live();
    expect(mocks.bucket!.heads.length).toBeGreaterThan(0);
    expect(mocks.bucket!.heads.every((h) => h.bucket === BUCKET && h.key === KEY)).toBe(true);
  });

  it('only selects the Training Data of the requested versions', async () => {
    mocks.rows = [
      fileRow(),
      fileRow({ id: 8, type: 'Model', url: `${URL_}.weights` }),
      fileRow({ id: 9, modelVersionId: 11, url: `${URL_}.v11` }),
    ];

    const { body } = await live();

    expect(body.results.map((r: { fileId: number }) => r.fileId)).toEqual([7]);
  });

  it('processes every file even when an earlier one is skipped', async () => {
    mocks.rows = [fileRow({ id: 6, deletedAt: null, modelVersionId: 9 }), fileRow()];

    const { body } = await live({ modelVersionIds: '9,10' });

    expect(body.results[0].skipped).toBe('model-not-deleted');
    expect(body.results[1].rowDeleted).toBe(true);
    expect(dbMock.dbWrite.modelFile.delete).toHaveBeenCalledTimes(1);
  });

  it('deletes nothing by default and reports what is stored', async () => {
    const { body } = await call({ modelVersionIds: '10' }, 'GET');

    expect(body.dryRun).toBe(true);
    expect(mocks.bucket!.deletes).toEqual([]);
    expect(mocks.deregister).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.modelFile.delete).not.toHaveBeenCalled();
    expect(body.results[0]).toMatchObject({ headBefore: 'present', resolverBefore: 'present' });
    expect(body.results[0].storedVersionsBefore).toHaveLength(2);
  });

  it('refuses a destructive GET before touching storage', async () => {
    const { status } = await call({ modelVersionIds: '10', dryRun: 'false' }, 'GET');

    expect(status).toBe(405);
    expect(mocks.bucket!.deletes).toEqual([]);
  });

  it('warns in the dry run when a listed version has no id', async () => {
    mocks.bucket = versionedBucket([{ key: KEY, versionId: '', isDeleteMarker: false, size: 100 }]);

    const { body } = await call({ modelVersionIds: '10' }, 'GET');

    expect(body.results[0].error).toBe('a stored version or upload has no id; nothing deleted');
  });

  it('deletes nothing when a listed version has no id, since that delete would only hide it', async () => {
    mocks.bucket = versionedBucket([{ key: KEY, versionId: '', isDeleteMarker: false, size: 100 }]);

    const { body } = await live();

    expect(body.results[0].error).toBe('a stored version or upload has no id; nothing deleted');
    expect(mocks.bucket!.deletes).toEqual([]);
    expect(dbMock.dbWrite.modelFile.delete).not.toHaveBeenCalled();
  });

  describe('keeps the row unless every check says the bytes are gone', () => {
    it('when the version listing still shows a version', async () => {
      mocks.bucket!.s3.send.mockImplementation(async (cmd: unknown) => {
        if (cmd instanceof ListObjectVersionsCommand)
          return {
            IsTruncated: false,
            Versions: [{ Key: KEY, VersionId: 'v1' }],
            DeleteMarkers: [],
          };
        if (cmd instanceof ListMultipartUploadsCommand) return { Uploads: [] };
        if (cmd instanceof HeadObjectCommand)
          throw Object.assign(new Error('NotFound'), { name: 'NotFound' });
        return {};
      });
      mocks.resolver = 'unregistered';

      const { body } = await live();

      expect(body.results[0]).toMatchObject({ headAfter: 'absent', resolverAfter: 'absent' });
      expect(body.results[0].error).toBe('not confirmed gone after delete; row kept');
      expect(dbMock.dbWrite.modelFile.delete).not.toHaveBeenCalled();
    });

    it('when HEAD still serves the object', async () => {
      mocks.bucket!.s3.send.mockImplementation(async (cmd: unknown) => {
        if (cmd instanceof ListObjectVersionsCommand)
          return { IsTruncated: false, Versions: [], DeleteMarkers: [] };
        if (cmd instanceof ListMultipartUploadsCommand) return { Uploads: [] };
        if (cmd instanceof HeadObjectCommand) return { ContentLength: 1 };
        return {};
      });
      mocks.resolver = 'unregistered';

      const { body } = await live();

      expect(body.results[0]).toMatchObject({ storedVersionsAfter: [], headAfter: 'present' });
      expect(dbMock.dbWrite.modelFile.delete).not.toHaveBeenCalled();
    });

    it('when HEAD cannot be answered', async () => {
      mocks.bucket!.s3.send.mockImplementation(async (cmd: unknown) => {
        if (cmd instanceof ListObjectVersionsCommand)
          return { IsTruncated: false, Versions: [], DeleteMarkers: [] };
        if (cmd instanceof ListMultipartUploadsCommand) return { Uploads: [] };
        if (cmd instanceof HeadObjectCommand)
          throw Object.assign(new Error('Forbidden'), { $metadata: { httpStatusCode: 403 } });
        return {};
      });
      mocks.resolver = 'unregistered';

      const { body } = await live();

      expect(body.results[0]).toMatchObject({ storedVersionsAfter: [], headAfter: 'unknown' });
      expect(dbMock.dbWrite.modelFile.delete).not.toHaveBeenCalled();
    });

    it('when an unfinished upload survives', async () => {
      mocks.bucket = versionedBucket(
        [{ key: KEY, versionId: 'v1', isDeleteMarker: false, size: 100 }],
        [{ key: KEY, uploadId: 'u1' }]
      );
      const send = mocks.bucket.s3.send.getMockImplementation()!;
      mocks.bucket.s3.send.mockImplementation(async (cmd: unknown) =>
        cmd instanceof AbortMultipartUploadCommand ? {} : send(cmd)
      );

      const { body } = await live();

      expect(body.results[0]).toMatchObject({ unfinishedUploadsAfter: 1 });
      expect(dbMock.dbWrite.modelFile.delete).not.toHaveBeenCalled();
    });

    it('when the resolver still serves a copy registered elsewhere', async () => {
      mocks.resolver = 'elsewhere';

      const { body } = await live();

      expect(body.results[0]).toMatchObject({ headAfter: 'absent', resolverAfter: 'present' });
      expect(mocks.deregister).not.toHaveBeenCalled();
      expect(dbMock.dbWrite.modelFile.delete).not.toHaveBeenCalled();
    });

    it('when the resolved copy answers neither present nor not-found', async () => {
      mocks.resolver = 'forbidden';

      const { body } = await live();

      expect(body.results[0].resolverAfter).toBe('unknown');
      expect(dbMock.dbWrite.modelFile.delete).not.toHaveBeenCalled();
    });

    it('when the resolver cannot be asked', async () => {
      mocks.resolver = 'down';

      const { body } = await live();

      expect(body.results[0].resolverAfter).toBe('unknown');
      expect(dbMock.dbWrite.modelFile.delete).not.toHaveBeenCalled();
    });
  });

  describe('refuses before touching storage', () => {
    it.each([
      ['model-not-deleted', { deletedAt: null }],
      [
        'not-a-trained-version',
        {
          modelVersion: { uploadType: 'Created', model: { userId: OWNER, deletedAt: new Date() } },
        },
      ],
      ['already-purged', { dataPurged: true }],
      [
        'outside-owner-upload-path',
        {
          url: `https://s3.us-west-004.backblazeb2.com/${BUCKET}/training-images/2/10TrainingData.zip`,
        },
      ],
      [
        'outside-owner-upload-path',
        {
          url: `https://s3.us-west-004.backblazeb2.com/${BUCKET}/model/${OWNER}/weights.safetensors`,
        },
      ],
      ['bucket-not-allowed', { url: `https://s3.us-west-004.backblazeb2.com/someone-else/${KEY}` }],
    ] as [string, Partial<FileRow> & { deletedAt?: Date | null }][])(
      '%s',
      async (reason, overrides) => {
        mocks.rows = [fileRow(overrides)];

        const { body } = await live();

        expect(body.results[0].skipped).toBe(reason);
        expect(mocks.bucket!.s3.send).not.toHaveBeenCalled();
        expect(dbMock.dbWrite.modelFile.delete).not.toHaveBeenCalled();
      }
    );

    it('held-by-unsent-csam-report', async () => {
      mocks.csamHeld = [10];

      const { body } = await live();

      expect(body.results[0].skipped).toBe('held-by-unsent-csam-report');
      expect(mocks.bucket!.s3.send).not.toHaveBeenCalled();
    });

    it('still-referenced', async () => {
      mocks.safe.mockResolvedValue({ safe: [], skipped: 1 });

      const { body } = await live();

      expect(mocks.safe).toHaveBeenCalledWith([URL_], 7);
      expect(body.results[0].skipped).toBe('still-referenced');
      expect(mocks.bucket!.s3.send).not.toHaveBeenCalled();
    });
  });
});
