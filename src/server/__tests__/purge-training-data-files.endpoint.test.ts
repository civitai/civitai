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
import { env } from '~/env/server';
import type * as ModelFileService from '~/server/services/model-file.service';
import type * as EndpointHelpers from '~/server/utils/endpoint-helpers';
import type * as TimeoutHelpers from '~/server/utils/timeout-helpers';
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
        mocks.deleted = true;
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

type Resolver =
  | 'follow'
  | 'unregistered'
  | 'elsewhere'
  | 'forbidden'
  | 'error'
  | 'down'
  | 'unreachable';

const mocks = vi.hoisted(() => ({
  bucket: null as null | ReturnType<typeof versionedBucket>,
  safe: vi.fn(),
  deregister: vi.fn(),
  cacheBust: vi.fn(),
  resolveOptions: [] as unknown[],
  timeout: vi.fn(),
  realTimeout: null as null | ((...args: never[]) => unknown),
  // Set by the first object delete, so the resolver can answer differently before and after.
  deleted: false,
  // 'follow' serves the fake bucket AFTER the first delete, but reports present BEFORE it whatever
  // the bucket holds, so the listing gate and the resolver gate can each be tested alone.
  // trackBucketBefore makes it follow the bucket in both phases. The others model what it may
  // answer instead.
  trackBucketBefore: false,
  // A server may answer a Range request with the whole object (200) instead of 206.
  ignoreRange: false,
  resolverBefore: 'follow' as Resolver,
  resolverAfter: 'follow' as Resolver,
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
vi.mock('~/server/services/model-file.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelFileService>()),
  deleteFilesForModelVersionCache: mocks.cacheBust,
}));
vi.mock('~/server/utils/timeout-helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof TimeoutHelpers>();
  mocks.realTimeout = actual.withTimeoutFallback as never;
  return { ...actual, withTimeoutFallback: mocks.timeout };
});
vi.mock('~/utils/storage-resolver', async (importOriginal) => ({
  ...(await importOriginal<typeof StorageResolver>()),
  deregisterFileLocationsByFile: mocks.deregister,
}));
vi.mock('~/utils/delivery-worker', async (importOriginal) => {
  const actual = await importOriginal<typeof DeliveryWorker>();
  return {
    ...actual,
    getDownloadUrlByFileId: async (_fileId: number, _name?: string, options?: unknown) => {
      mocks.resolveOptions.push(options);
      const mode = mocks.deleted ? mocks.resolverAfter : mocks.resolverBefore;
      if (mode === 'unregistered') throw new actual.StorageResolverError(404, 'nope');
      if (mode === 'error') throw new actual.StorageResolverError(503, 'unavailable');
      if (mode === 'down') throw new Error('resolver unreachable');
      return { url: `https://cdn.test/${mode}`, urlExpiryDate: new Date() };
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

/**
 * A storage double that shows one live version until it is asked to delete, then answers each
 * after-check as given. Used to trip exactly one after-check at a time.
 */
function afterState(after: { versions?: boolean; head?: 'present' | 'absent' | 'forbidden' }) {
  mocks.bucket!.s3.send.mockImplementation(async (cmd: unknown) => {
    if (cmd instanceof DeleteObjectCommand) {
      mocks.deleted = true;
      return {};
    }
    if (cmd instanceof ListObjectVersionsCommand)
      return {
        IsTruncated: false,
        Versions: !mocks.deleted || after.versions ? [{ Key: KEY, VersionId: 'v1' }] : [],
        DeleteMarkers: [],
      };
    if (cmd instanceof ListMultipartUploadsCommand) return { Uploads: [] };
    if (cmd instanceof HeadObjectCommand) {
      const head = mocks.deleted ? after.head ?? 'absent' : 'present';
      if (head === 'present') return { ContentLength: 1 };
      if (head === 'forbidden')
        throw Object.assign(new Error('Forbidden'), { $metadata: { httpStatusCode: 403 } });
      throw Object.assign(new Error('NotFound'), { name: 'NotFound' });
    }
    return {};
  });
}

const RESOLVER_ENV = [
  'STORAGE_RESOLVER_ENDPOINT',
  'STORAGE_RESOLVER_INTERNAL_URL',
  'STORAGE_RESOLVER_INTERNAL_TOKEN',
] as const;
const envBefore = Object.fromEntries(RESOLVER_ENV.map((k) => [k, env[k]]));

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of RESOLVER_ENV) (env as Record<string, unknown>)[k] = 'configured';
  mocks.deleted = false;
  mocks.resolverBefore = 'follow';
  mocks.resolverAfter = 'follow';
  mocks.trackBucketBefore = false;
  mocks.ignoreRange = false;
  mocks.resolveOptions = [];
  mocks.timeout.mockImplementation(mocks.realTimeout as never);
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
    vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
      if (url.endsWith('/unreachable')) throw new TypeError('fetch failed');
      if (url.endsWith('/elsewhere')) return new Response(null, { status: 200 });
      if (url.endsWith('/forbidden')) return new Response(null, { status: 403 });
      const present = mocks.deleted || mocks.trackBucketBefore ? mocks.bucket!.current(KEY) : true;
      if (!present) return new Response(null, { status: 404 });
      return new Response(null, { status: init?.headers?.Range && !mocks.ignoreRange ? 206 : 200 });
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of RESOLVER_ENV) (env as Record<string, unknown>)[k] = envBefore[k];
});

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
    expect(mocks.cacheBust).toHaveBeenCalledWith(10);
  });

  it('deregisters before deleting the row, so a failed deregister leaves the row to retry', async () => {
    await live();
    expect(mocks.deregister.mock.invocationCallOrder[0]).toBeLessThan(
      dbMock.dbWrite.modelFile.delete.mock.invocationCallOrder[0]
    );
  });

  it('asks the resolved url for one byte by GET, which its signature allows', async () => {
    await live();
    const init = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(init.method ?? 'GET').toBe('GET');
    expect(init.headers).toEqual({ Range: 'bytes=0-0' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('asks the resolver for an origin url under a timeout', async () => {
    await live();
    expect(mocks.resolveOptions.length).toBeGreaterThan(0);
    expect(mocks.resolveOptions.every((o) => (o as { direct?: boolean })?.direct === true)).toBe(
      true
    );
    expect(mocks.timeout.mock.calls.every((c) => c[1] === 10_000 && c[2] === null)).toBe(true);
  });

  it('treats a resolver that times out as unknown and deletes nothing', async () => {
    mocks.timeout.mockImplementation(
      async (_p: Promise<unknown>, _ms: number, fallback: unknown) => {
        (_p as Promise<unknown>).catch(() => undefined);
        return fallback;
      }
    );

    const { body } = await live();

    expect(body.results[0].resolverBefore).toBe('unknown');
    expect(mocks.bucket!.deletes).toEqual([]);
  });

  it('accepts a server that answers the one-byte request with the whole object', async () => {
    mocks.ignoreRange = true;

    const { body } = await live();

    expect(body.results[0]).toMatchObject({ resolverBefore: 'present', rowDeleted: true });
  });

  it('removes older versions and hide markers along with the current one', async () => {
    mocks.bucket = versionedBucket([
      { key: KEY, versionId: 'v1', isDeleteMarker: false, size: 100 },
      { key: KEY, versionId: 'm1', isDeleteMarker: true },
      { key: KEY, versionId: 'v2', isDeleteMarker: false, size: 100 },
    ]);

    const { body } = await live();

    expect(mocks.bucket!.deletes).toEqual(['v1', 'v2', 'm1']);
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
    expect(body.resolverReady).toBe(true);
    expect(mocks.bucket!.deletes).toEqual([]);
    expect(mocks.deregister).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.modelFile.delete).not.toHaveBeenCalled();
    expect(body.results[0]).toMatchObject({ headBefore: 'present', resolverBefore: 'present' });
    expect(body.results[0].storedVersionsBefore).toHaveLength(2);
  });

  it.each(RESOLVER_ENV)(
    'refuses a destructive run without %s, since the row could not be removed after',
    async (key) => {
      (env as Record<string, unknown>)[key] = undefined;

      const { status } = await live();
      const dry = await call({ modelVersionIds: '10' }, 'GET');

      expect(status).toBe(409);
      expect(mocks.bucket!.deletes).toEqual([]);
      expect(dry.body.resolverReady).toBe(false);
    }
  );

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

  describe('deletes nothing unless the object is first found at its key and through the resolver', () => {
    const NOT_CONFIRMED =
      'object not confirmed at its key and through the resolver; nothing deleted';

    it('when nothing is stored at the key', async () => {
      mocks.bucket = versionedBucket([]);

      const { body } = await live();

      expect(body.results[0].error).toBe(NOT_CONFIRMED);
      expect(mocks.deregister).not.toHaveBeenCalled();
      expect(dbMock.dbWrite.modelFile.delete).not.toHaveBeenCalled();
    });

    it('when an older version sits under a hide marker, which the resolver cannot serve', async () => {
      mocks.bucket = versionedBucket([
        { key: KEY, versionId: 'v1', isDeleteMarker: false, size: 100 },
        { key: KEY, versionId: 'm1', isDeleteMarker: true },
      ]);
      mocks.trackBucketBefore = true;

      const { body } = await live();

      expect(body.results[0]).toMatchObject({ headBefore: 'absent', resolverBefore: 'absent' });
      expect(body.results[0].error).toBe(NOT_CONFIRMED);
      expect(mocks.bucket!.deletes).toEqual([]);
    });

    it('when only a hide marker is stored at the key', async () => {
      mocks.bucket = versionedBucket([{ key: KEY, versionId: 'm1', isDeleteMarker: true }]);

      const { body } = await live();

      expect(body.results[0].error).toBe(NOT_CONFIRMED);
      expect(mocks.bucket!.deletes).toEqual([]);
    });

    it.each(['unregistered', 'forbidden', 'error', 'down', 'unreachable'] as Resolver[])(
      'when the resolver answers %s beforehand',
      async (mode) => {
        mocks.resolverBefore = mode;

        const { body } = await live();

        expect(body.results[0].error).toBe(NOT_CONFIRMED);
        expect(mocks.bucket!.deletes).toEqual([]);
        expect(dbMock.dbWrite.modelFile.delete).not.toHaveBeenCalled();
      }
    );

    it('and says so in the dry run', async () => {
      mocks.resolverBefore = 'forbidden';

      const { body } = await call({ modelVersionIds: '10' }, 'GET');

      expect(body.results[0]).toMatchObject({ resolverBefore: 'unknown', error: NOT_CONFIRMED });
    });
  });

  describe('keeps the row unless every check says the bytes are gone', () => {
    it('when the version listing still shows a version', async () => {
      afterState({ versions: true });
      mocks.resolverAfter = 'unregistered';

      const { body } = await live();

      expect(body.results[0]).toMatchObject({ headAfter: 'absent', resolverAfter: 'absent' });
      expect(body.results[0].error).toBe('not confirmed gone after delete; row kept');
      expect(dbMock.dbWrite.modelFile.delete).not.toHaveBeenCalled();
    });

    it('when HEAD still serves the object', async () => {
      afterState({ head: 'present' });
      mocks.resolverAfter = 'unregistered';

      const { body } = await live();

      expect(body.results[0]).toMatchObject({ storedVersionsAfter: [], headAfter: 'present' });
      expect(dbMock.dbWrite.modelFile.delete).not.toHaveBeenCalled();
    });

    it('when HEAD cannot be answered', async () => {
      afterState({ head: 'forbidden' });
      mocks.resolverAfter = 'unregistered';

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
      mocks.resolverAfter = 'elsewhere';

      const { body } = await live();

      expect(body.results[0]).toMatchObject({ headAfter: 'absent', resolverAfter: 'present' });
      expect(mocks.deregister).not.toHaveBeenCalled();
      expect(dbMock.dbWrite.modelFile.delete).not.toHaveBeenCalled();
    });

    it.each(['forbidden', 'error', 'down', 'unreachable'] as Resolver[])(
      'when the resolver answers %s afterwards',
      async (mode) => {
        mocks.resolverAfter = mode;

        const { body } = await live();

        expect(body.results[0].resolverAfter).toBe('unknown');
        expect(mocks.deregister).not.toHaveBeenCalled();
        expect(dbMock.dbWrite.modelFile.delete).not.toHaveBeenCalled();
      }
    );

    it.each([
      [null, 'resolver registration not removed; row kept'],
      [{ deleted: 0 }, 'resolver registration not removed; row kept'],
      [{ deleted: 2 }, 'file was registered in more than one location; row kept'],
    ])('when deregistering returns %o', async (outcome, error) => {
      mocks.deregister.mockResolvedValue(outcome);

      const { body } = await live();

      expect(body.results[0].error).toBe(error);
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
          url: `https://s3.us-west-004.backblazeb2.com/${BUCKET}/training-images/${OWNER}0/10TrainingData.zip`,
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

    // A TEXT PIN: the mocked $queryRaw cannot evaluate SQL, so this pins the hold's condition
    // and parameter only. That it matches real CsamReport rows was checked against the database
    // by hand, not here.
    it('holds versions named by any report whose evidence is not archived', async () => {
      await live();

      expect(dbMock.dbWrite.$queryRaw).toHaveBeenCalledTimes(1);
      const [strings, ...values] = dbMock.dbWrite.$queryRaw.mock.calls[0] as unknown as [
        TemplateStringsArray,
        ...unknown[]
      ];
      const sql = strings.join('?').replace(/\s+/g, ' ').trim();
      expect(sql).toBe(
        [
          `SELECT DISTINCT e.value::int AS id FROM "CsamReport" r`,
          `CROSS JOIN LATERAL jsonb_array_elements_text(`,
          `CASE WHEN jsonb_typeof(r.details->'modelVersionIds') = 'array'`,
          `THEN r.details->'modelVersionIds' ELSE '[]'::jsonb END`,
          `) AS e(value)`,
          `WHERE r."archivedAt" IS NULL AND e.value = ANY(?::text[])`,
        ].join(' ')
      );
      expect(values).toEqual([['10']]);
    });

    it('held-by-unarchived-csam-report', async () => {
      mocks.csamHeld = [10];

      const { body } = await live();

      expect(body.results[0].skipped).toBe('held-by-unarchived-csam-report');
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
