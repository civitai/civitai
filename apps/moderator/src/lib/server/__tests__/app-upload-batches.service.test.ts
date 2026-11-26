import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The audit page's reads before the hand-applied table is usable: absent (42P01) or present without
 * this app's grant (42501) both read as "unavailable", so the page shows its notice instead of a 500.
 * Any other failure still throws.
 */

const h = vi.hoisted(() => ({ failure: null as unknown }));

/** A query builder whose every chained call returns itself and whose execution fails with `h.failure`. */
function failingBuilder(): unknown {
  const fail = async () => {
    throw h.failure;
  };
  const proxy: unknown = new Proxy(
    {},
    {
      get: (_t, key) => {
        if (key === 'then') return undefined;
        if (key === 'execute' || key === 'executeTakeFirst') return fail;
        return () => proxy;
      },
    }
  );
  return proxy;
}

vi.mock('$lib/server/db', () => ({ dbRead: failingBuilder(), dbWrite: {} }));

const { listUploadBatches, getUploadBatch } = await import('../app-upload-batches.service');

beforeEach(() => {
  h.failure = null;
});

describe('app-upload-batches reads', () => {
  it.each([
    [
      'the table is not applied',
      { code: '42P01', message: 'relation "app_block_upload_batches" does not exist' },
    ],
    [
      'the table is not granted',
      { code: '42501', message: 'permission denied for table app_block_upload_batches' },
    ],
  ])('%s: the list and the detail read as unavailable', async (_label, err) => {
    h.failure = Object.assign(new Error(err.message), { code: err.code });
    await expect(listUploadBatches({})).resolves.toEqual({ kind: 'unavailable' });
    await expect(getUploadBatch(1)).resolves.toEqual({ kind: 'unavailable' });
  });

  it('any other failure still throws', async () => {
    h.failure = Object.assign(new Error('connection terminated'), { code: '57P01' });
    await expect(listUploadBatches({})).rejects.toThrow('connection terminated');
  });
});
