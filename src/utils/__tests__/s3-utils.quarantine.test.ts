import { describe, it, expect, vi, beforeEach } from 'vitest';
// A top-level type-only import rather than `typeof import('…')` inline: the repo's
// `consistent-type-imports` rule forbids the inline form. (The sibling s3-utils.test.ts still
// carries that violation; it is pre-existing and out of scope here, but there is no reason to
// add a second instance of it.) Type imports are erased, so this is unaffected by vi.mock
// hoisting.
import type * as AwsS3 from '@aws-sdk/client-s3';

// A MUTABLE env object, unlike the sibling s3-utils.test.ts which freezes one shape. The whole
// point of several cases below is the difference between a configured and an unconfigured
// quarantine bucket, and that is read at call time rather than at module load — so a test can
// flip it. (`getQuarantineBucket` reads `env` per call precisely so this is testable; a
// module-level constant would have made the unconfigured branch unreachable from here.)
// 🔴 `vi.hoisted`, not a plain const. `vi.mock` factories are hoisted above every top-level
// binding, so a bare const here is in the temporal dead zone when the factory runs and the file
// dies with "Cannot access 'envState' before initialization" — which vitest reports as
// `Tests no tests`, i.e. a file that looks skipped rather than broken.
const envState = vi.hoisted(
  () =>
    ({
      S3_UPLOAD_ENDPOINT: 'https://abcd1234.r2.cloudflarestorage.com',
      S3_UPLOAD_BUCKET: 'civitai-modelfiles',
      S3_UPLOAD_KEY: 'test-key',
      S3_UPLOAD_SECRET: 'test-secret',
      S3_UPLOAD_B2_ENDPOINT: 'https://s3.us-west-004.backblazeb2.com',
      S3_UPLOAD_B2_ACCESS_KEY: 'b2-key',
      S3_UPLOAD_B2_SECRET_KEY: 'b2-secret',
      S3_UPLOAD_B2_BUCKET: 'civitai-modelfiles-b2',
      S3_UPLOAD_B2_QUARANTINE_BUCKET: 'civitai-quarantine',
    } as Record<string, unknown>)
);

vi.mock('~/env/server', () => ({
  env: new Proxy(envState, {
    get: (t, p: string) => (p in t ? t[p] : undefined),
  }),
}));

const mocks = vi.hoisted(() => {
  const copies: { bucket: string; key: string; copySource: string }[] = [];
  const deletes: { bucket: string; key: string; versionId?: string }[] = [];
  const heads: { bucket: string; key: string }[] = [];
  // (bucket/key) -> ContentLength, or 'absent' for a 404, or null for "reported no size".
  const headSizes = new Map<string, number | null | 'absent'>();
  const state = { copyThrows: false, copySourceVersionId: undefined as string | undefined };
  return { copies, deletes, heads, headSizes, state };
});

vi.mock('@aws-sdk/client-s3', async (importOriginal) => {
  const actual = await importOriginal<typeof AwsS3>();
  const mocked = {
    ...actual,
    S3Client: class {
      cfg: { endpoint?: string };
      constructor(cfg: { endpoint?: string } = {}) {
        this.cfg = cfg;
      }
      // 🔴 DISPATCHES ON THE COMMAND TYPE rather than on which fields happen to be present.
      // The sibling test file records "anything that is not a batch delete" as a delete, which
      // is why these cases could not live there: a CopyObject or a HeadObject would have been
      // counted as a delete and every existing assertion in that file would still have passed.
      send = vi.fn(
        async (cmd: { constructor: { name: string }; input?: Record<string, never> }) => {
          const input = (cmd?.input ?? {}) as Record<string, string | undefined>;
          const name = cmd?.constructor?.name;
          const bucket = input.Bucket ?? '';
          const key = input.Key ?? '';

          if (name === 'HeadObjectCommand') {
            mocks.heads.push({ bucket, key });
            const v = mocks.headSizes.get(`${bucket}/${key}`);
            if (v === 'absent' || v === undefined) {
              const e = new Error('NotFound') as Error & { name: string };
              e.name = 'NotFound';
              throw e;
            }
            return { ContentLength: v };
          }
          if (name === 'CopyObjectCommand') {
            if (mocks.state.copyThrows) throw new Error('copy exploded');
            mocks.copies.push({ bucket, key, copySource: input.CopySource ?? '' });
            return { CopySourceVersionId: mocks.state.copySourceVersionId };
          }
          if (name === 'DeleteObjectCommand') {
            mocks.deletes.push({ bucket, key, versionId: input.VersionId });
            return {};
          }
          return {};
        }
      );
    },
  };
  return { ...mocked, default: mocked };
});

import { deleteModelFileObject, getQuarantineBucket, quarantineKeyFor } from '~/utils/s3-utils';
import { dbMock } from '~/__tests__/mocks/db.mock';

const B2_URL = 'https://s3.us-west-004.backblazeb2.com/civitai-modelfiles-b2/training-images/a.zip';
const SRC = 'civitai-modelfiles-b2';
const KEY = 'training-images/a.zip';
const QKEY = `${SRC}/${KEY}`;

/** No live row references the url -> the refcount guard lets the delete through. */
function refcountAllows() {
  dbMock.dbWrite.modelFile.findMany.mockResolvedValue([] as never);
}

beforeEach(() => {
  mocks.copies.length = 0;
  mocks.deletes.length = 0;
  mocks.heads.length = 0;
  mocks.headSizes.clear();
  mocks.state.copyThrows = false;
  mocks.state.copySourceVersionId = undefined;
  envState.S3_UPLOAD_B2_QUARANTINE_BUCKET = 'civitai-quarantine';
  dbMock.dbWrite.modelFile.findMany.mockReset();
  refcountAllows();
});

describe('getQuarantineBucket', () => {
  it('returns the configured bucket for b2', () => {
    expect(getQuarantineBucket('b2')).toBe('civitai-quarantine');
  });

  it('returns undefined for b2 when unset', () => {
    envState.S3_UPLOAD_B2_QUARANTINE_BUCKET = undefined;
    expect(getQuarantineBucket('b2')).toBeUndefined();
  });

  it('returns undefined for an empty string, not the empty string', () => {
    // An empty env var is "unset" — returning '' would be a falsy bucket name that still
    // passes a `!== undefined` check at a call site.
    envState.S3_UPLOAD_B2_QUARANTINE_BUCKET = '';
    expect(getQuarantineBucket('b2')).toBeUndefined();
  });

  it('returns undefined for the default backend even when b2 is configured', () => {
    // The R2 asymmetry is deliberate: no quarantine bucket means a quarantine caller is
    // REFUSED, never silently hard-deleted.
    expect(getQuarantineBucket('default')).toBeUndefined();
  });
});

describe('quarantineKeyFor', () => {
  it('prefixes the key with its source bucket', () => {
    expect(quarantineKeyFor('bucket-a', 'training-images/x.zip')).toBe(
      'bucket-a/training-images/x.zip'
    );
  });

  it('keeps same-keyed objects from different buckets apart', () => {
    // Without the prefix these collide and one silently overwrites the other in quarantine.
    expect(quarantineKeyFor('bucket-a', 'k')).not.toBe(quarantineKeyFor('bucket-b', 'k'));
  });
});

describe('deleteModelFileObject — quarantine opt-out (default)', () => {
  it('deletes directly and copies nothing', async () => {
    const out = await deleteModelFileObject(B2_URL, 1);
    expect(out).toEqual({ deleted: true });
    expect(mocks.copies).toHaveLength(0);
    expect(mocks.deletes).toEqual([{ bucket: SRC, key: KEY, versionId: undefined }]);
  });

  it('issues no HeadObject either', async () => {
    // The verification probes belong to the quarantine path. If they fired for every existing
    // caller this change would have silently added two network round-trips per delete
    // repo-wide.
    await deleteModelFileObject(B2_URL, 1);
    expect(mocks.heads).toHaveLength(0);
  });
});

describe('deleteModelFileObject — quarantine enabled', () => {
  it('copies, verifies, then deletes the exact version it copied', async () => {
    mocks.headSizes.set(`${SRC}/${KEY}`, 1024);
    mocks.headSizes.set(`civitai-quarantine/${QKEY}`, 1024);
    mocks.state.copySourceVersionId = 'ver-abc';

    const out = await deleteModelFileObject(B2_URL, 1, { quarantine: true });

    expect(out).toEqual({ deleted: true });
    expect(mocks.copies).toEqual([
      {
        bucket: 'civitai-quarantine',
        key: QKEY,
        copySource: `${SRC}/${KEY}`.split('/').map(encodeURIComponent).join('/'),
      },
    ]);
    // 🔴 THE ASSERTION THIS WHOLE FILE EXISTS FOR. A delete carrying no VersionId against a
    // versioned bucket writes a delete marker and frees nothing, so quarantine would hold the
    // bytes in two places and release them from neither — while still reporting success.
    expect(mocks.deletes).toEqual([{ bucket: SRC, key: KEY, versionId: 'ver-abc' }]);
  });

  it('passes VersionId undefined when the backend reports no source version', async () => {
    // Unversioned backend: the plain delete already removes the bytes.
    mocks.headSizes.set(`${SRC}/${KEY}`, 10);
    mocks.headSizes.set(`civitai-quarantine/${QKEY}`, 10);
    mocks.state.copySourceVersionId = undefined;

    const out = await deleteModelFileObject(B2_URL, 1, { quarantine: true });
    expect(out).toEqual({ deleted: true });
    expect(mocks.deletes).toEqual([{ bucket: SRC, key: KEY, versionId: undefined }]);
  });

  it('refuses and deletes NOTHING when no quarantine bucket is configured', async () => {
    envState.S3_UPLOAD_B2_QUARANTINE_BUCKET = undefined;
    mocks.headSizes.set(`${SRC}/${KEY}`, 1024);

    const out = await deleteModelFileObject(B2_URL, 1, { quarantine: true });

    expect(out).toEqual({ deleted: false, reason: 'quarantine-not-configured' });
    expect(mocks.deletes).toHaveLength(0);
    expect(mocks.copies).toHaveLength(0);
  });

  it('refuses and deletes NOTHING when the copy throws', async () => {
    mocks.headSizes.set(`${SRC}/${KEY}`, 1024);
    mocks.state.copyThrows = true;

    const out = await deleteModelFileObject(B2_URL, 1, { quarantine: true });

    expect(out).toEqual({ deleted: false, reason: 'quarantine-copy-failed' });
    expect(mocks.deletes).toHaveLength(0);
  });

  it('refuses and deletes NOTHING when the copy lands at a different size', async () => {
    mocks.headSizes.set(`${SRC}/${KEY}`, 1024);
    mocks.headSizes.set(`civitai-quarantine/${QKEY}`, 512);

    const out = await deleteModelFileObject(B2_URL, 1, { quarantine: true });

    expect(out).toEqual({ deleted: false, reason: 'quarantine-verify-failed' });
    expect(mocks.deletes).toHaveLength(0);
  });

  it('refuses and deletes NOTHING when the copy is not there afterwards', async () => {
    mocks.headSizes.set(`${SRC}/${KEY}`, 1024);
    // destination intentionally absent

    const out = await deleteModelFileObject(B2_URL, 1, { quarantine: true });

    expect(out).toEqual({ deleted: false, reason: 'quarantine-verify-failed' });
    expect(mocks.deletes).toHaveLength(0);
  });

  it('refuses when the SOURCE size is unknown, rather than copying blind', async () => {
    // `headObject` returns size null when the backend reported none. For a probe guarding a
    // READ that must not fire; for one guarding a DELETE it must, because an unverifiable copy
    // cannot be a recovery path.
    mocks.headSizes.set(`${SRC}/${KEY}`, null);

    const out = await deleteModelFileObject(B2_URL, 1, { quarantine: true });

    expect(out).toEqual({ deleted: false, reason: 'quarantine-copy-failed' });
    expect(mocks.copies).toHaveLength(0);
    expect(mocks.deletes).toHaveLength(0);
  });

  it('refuses when the source object is already gone', async () => {
    const out = await deleteModelFileObject(B2_URL, 1, { quarantine: true });
    expect(out).toEqual({ deleted: false, reason: 'quarantine-copy-failed' });
    expect(mocks.copies).toHaveLength(0);
    expect(mocks.deletes).toHaveLength(0);
  });

  it('runs the refcount guard BEFORE copying anything', async () => {
    // Ordering matters beyond correctness: a still-referenced url must not be copied into
    // quarantine either, or the guard leaks the victim's bytes into a second bucket.
    dbMock.dbWrite.modelFile.findMany.mockResolvedValue([{ url: B2_URL, id: 99 }] as never);
    mocks.headSizes.set(`${SRC}/${KEY}`, 1024);

    const out = await deleteModelFileObject(B2_URL, 1, { quarantine: true });

    expect(out).toEqual({ deleted: false, reason: 'still-referenced' });
    expect(mocks.copies).toHaveLength(0);
    expect(mocks.deletes).toHaveLength(0);
    expect(mocks.heads).toHaveLength(0);
  });

  it('refuses a non-allowlisted bucket without copying it into quarantine', async () => {
    const foreign =
      'https://s3.us-west-004.backblazeb2.com/someone-elses-bucket/training-images/a.zip';
    const out = await deleteModelFileObject(foreign, 1, { quarantine: true });

    expect(out).toEqual({ deleted: false, reason: 'bucket-not-allowed' });
    expect(mocks.copies).toHaveLength(0);
    expect(mocks.deletes).toHaveLength(0);
  });
});
