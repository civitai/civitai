import { describe, it, expect, vi, beforeEach } from 'vitest';

// Override the global env mock with concrete S3/B2 endpoints so module-load
// constants (s3Host, b2Host) resolve to predictable values. Any field we
// don't override falls back to the global Proxy in src/__tests__/setup.ts.
//
// `vi.mock` is hoisted, so this lands before s3-utils' module-level
// `new URL(env.S3_UPLOAD_ENDPOINT)` runs.
vi.mock('~/env/server', () => ({
  env: new Proxy(
    {
      S3_UPLOAD_ENDPOINT: 'https://abcd1234.r2.cloudflarestorage.com',
      S3_UPLOAD_BUCKET: 'civitai-modelfiles',
      S3_UPLOAD_KEY: 'test-key',
      S3_UPLOAD_SECRET: 'test-secret',
      S3_UPLOAD_B2_ENDPOINT: 'https://s3.us-west-004.backblazeb2.com',
      S3_UPLOAD_B2_ACCESS_KEY: 'b2-key',
      S3_UPLOAD_B2_SECRET_KEY: 'b2-secret',
      S3_UPLOAD_B2_BUCKET: 'civitai-modelfiles-b2',
      S3_VAULT_BUCKET: 'civitai-vault',
    } as Record<string, unknown>,
    {
      get(target, prop: string) {
        if (prop in target) return target[prop];
        return undefined;
      },
    }
  ),
}));

// vi.hoisted() runs before vi.mock() factories so we can share state with
// hoisted mocks. Without this, the mocks would reference uninitialized
// top-level constants and crash at module-load time.
const mocks = vi.hoisted(() => {
  const findManyMock = vi.fn(async () => [] as { url: string; id: number }[]);
  const deleteObjectCalls: { bucket: string; key: string }[] = [];
  const deleteManyObjectsCalls: { bucket: string; keys: string[] }[] = [];
  return { findManyMock, deleteObjectCalls, deleteManyObjectsCalls };
});

// Refcount check inside deleteModelFileObject(s) hits dbWrite.modelFile.findMany.
// Default: 0 referenced rows → all URLs are "safe to delete".
vi.mock('~/server/db/client', () => ({
  dbWrite: {
    modelFile: {
      findMany: mocks.findManyMock,
    },
  },
  dbRead: {},
}));

// Capture deleteObject / deleteManyObjects calls so we can assert which
// (bucket, key) tuples actually reach the S3 client.
vi.mock('@aws-sdk/client-s3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-s3')>();
  return {
    ...actual,
    S3Client: class {
      send = vi.fn(
        async (cmd: {
          input?: {
            Bucket?: string;
            Key?: string;
            Delete?: { Objects?: { Key?: string }[] };
          };
        }) => {
          const Bucket = cmd?.input?.Bucket ?? '';
          if (cmd?.input?.Delete?.Objects) {
            mocks.deleteManyObjectsCalls.push({
              bucket: Bucket,
              keys: cmd.input.Delete.Objects.map((o) => o.Key ?? ''),
            });
            return { Errors: [] };
          }
          mocks.deleteObjectCalls.push({ bucket: Bucket, key: cmd?.input?.Key ?? '' });
          return {};
        }
      );
    },
  };
});

import {
  parseKey,
  parseB2Url,
  deleteModelFileObject,
  deleteModelFileObjects,
} from '~/utils/s3-utils';

beforeEach(() => {
  mocks.deleteObjectCalls.length = 0;
  mocks.deleteManyObjectsCalls.length = 0;
  mocks.findManyMock.mockReset();
  mocks.findManyMock.mockResolvedValue([]);
});

describe('parseKey', () => {
  const cases: { name: string; url: string; expected: { key: string; bucket?: string } }[] = [
    {
      name: 'virtual-host-style R2 (bucket subdomain)',
      url: 'https://civitai-prod-settled.abcd1234.r2.cloudflarestorage.com/some/key.safetensors',
      expected: { key: 'some/key.safetensors', bucket: 'civitai-prod-settled' },
    },
    {
      name: 'path-style on configured S3 endpoint',
      url: 'https://abcd1234.r2.cloudflarestorage.com/civitai-modelfiles/path/to/key.safetensors',
      expected: { key: 'path/to/key.safetensors', bucket: 'civitai-modelfiles' },
    },
    {
      name: 'malformed URL falls through to bare-key form',
      url: 'not a url at all',
      expected: { key: 'not a url at all' },
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(parseKey(c.url)).toEqual(c.expected);
    });
  }
});

describe('parseB2Url', () => {
  it('parses public path-style B2 URL (s3.<region>.backblazeb2.com)', () => {
    expect(
      parseB2Url('https://s3.us-west-004.backblazeb2.com/civitai-modelfiles-b2/some/key.safetensors')
    ).toEqual({ bucket: 'civitai-modelfiles-b2', key: 'some/key.safetensors' });
  });

  it('parses public virtual-host-style B2 URL', () => {
    expect(
      parseB2Url('https://civitai-modelfiles-b2.f004.backblazeb2.com/some/key.safetensors')
    ).toEqual({ bucket: 'civitai-modelfiles-b2', key: 'some/key.safetensors' });
  });

  it('parses configured B2 endpoint (matches env.S3_UPLOAD_B2_ENDPOINT host)', () => {
    expect(
      parseB2Url('https://s3.us-west-004.backblazeb2.com/civitai-modelfiles-b2/k')
    ).toEqual({ bucket: 'civitai-modelfiles-b2', key: 'k' });
  });

  it('returns null for malformed URLs', () => {
    expect(parseB2Url('not a url')).toBeNull();
  });

  it('returns null for non-B2 URLs', () => {
    expect(
      parseB2Url('https://civitai-prod-settled.abcd1234.r2.cloudflarestorage.com/key')
    ).toBeNull();
  });

  it('returns null for path-style URL with no bucket segment', () => {
    expect(parseB2Url('https://s3.us-west-004.backblazeb2.com/')).toBeNull();
  });
});

describe('deleteModelFileObject — bucket allowlist gate', () => {
  it('deletes from an allowlisted R2 bucket', async () => {
    await deleteModelFileObject(
      'https://civitai-prod-settled.abcd1234.r2.cloudflarestorage.com/key/file.safetensors'
    );
    expect(mocks.deleteObjectCalls).toEqual([
      { bucket: 'civitai-prod-settled', key: 'key/file.safetensors' },
    ]);
  });

  it('blocks delete to a non-allowlisted R2 bucket', async () => {
    await deleteModelFileObject(
      'https://attacker-bucket.abcd1234.r2.cloudflarestorage.com/victim.bin'
    );
    expect(mocks.deleteObjectCalls).toHaveLength(0);
  });

  it('blocks delete to S3_VAULT_BUCKET (intentionally excluded from allowlist)', async () => {
    // Even though env.S3_VAULT_BUCKET is set, vault objects must be deleted
    // exclusively via vault.service.ts — never via the ModelFile cleanup path.
    await deleteModelFileObject(
      'https://civitai-vault.abcd1234.r2.cloudflarestorage.com/secret/key.bin'
    );
    expect(mocks.deleteObjectCalls).toHaveLength(0);
  });

  it('skips when refcount check finds the URL still referenced', async () => {
    mocks.findManyMock.mockResolvedValueOnce([
      { url: 'https://civitai-prod-settled.abcd1234.r2.cloudflarestorage.com/k', id: 7 },
    ]);
    await deleteModelFileObject(
      'https://civitai-prod-settled.abcd1234.r2.cloudflarestorage.com/k'
    );
    expect(mocks.deleteObjectCalls).toHaveLength(0);
  });

  it('returns silently for empty url', async () => {
    await deleteModelFileObject('');
    expect(mocks.deleteObjectCalls).toHaveLength(0);
  });
});

describe('deleteModelFileObjects — bucket allowlist + grouping', () => {
  it('groups by (backend, bucket) and skips non-allowlisted buckets', async () => {
    await deleteModelFileObjects([
      'https://civitai-prod-settled.abcd1234.r2.cloudflarestorage.com/a',
      'https://civitai-prod-settled.abcd1234.r2.cloudflarestorage.com/b',
      'https://civitai-prod.abcd1234.r2.cloudflarestorage.com/c',
      'https://attacker.abcd1234.r2.cloudflarestorage.com/d',
      'https://civitai-vault.abcd1234.r2.cloudflarestorage.com/e',
      'https://s3.us-west-004.backblazeb2.com/civitai-modelfiles-b2/f',
    ]);

    // Each (backend, bucket) group → one DeleteObjects call. The two
    // non-allowlisted urls (attacker, civitai-vault) must be filtered before
    // any group is built.
    const buckets = mocks.deleteManyObjectsCalls
      .map((c) => `${c.bucket}:${c.keys.sort().join(',')}`)
      .sort();
    expect(buckets).toEqual([
      'civitai-modelfiles-b2:f',
      'civitai-prod-settled:a,b',
      'civitai-prod:c',
    ]);
  });

  it('handles empty input cleanly', async () => {
    await deleteModelFileObjects([]);
    expect(mocks.deleteManyObjectsCalls).toHaveLength(0);
  });

  it('drops urls when refcount check finds them still referenced', async () => {
    mocks.findManyMock.mockResolvedValueOnce([
      { url: 'https://civitai-prod-settled.abcd1234.r2.cloudflarestorage.com/a', id: 1 },
    ]);
    await deleteModelFileObjects([
      'https://civitai-prod-settled.abcd1234.r2.cloudflarestorage.com/a',
      'https://civitai-prod-settled.abcd1234.r2.cloudflarestorage.com/b',
    ]);
    expect(mocks.deleteManyObjectsCalls).toEqual([
      { bucket: 'civitai-prod-settled', keys: ['b'] },
    ]);
  });
});
