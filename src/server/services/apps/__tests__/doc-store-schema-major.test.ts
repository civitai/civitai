import { describe, expect, it, vi } from 'vitest';
import type { ApprovedManifest } from '~/server/services/apps/storage-schema-majors';
import { createSchemaMajorResolver } from '~/server/services/apps/doc-store-schema-major';

/**
 * The store-side major resolver: which major a production write is stamped with, when it reads
 * the history again, and that a failure never refuses the write. (That it agrees with the registry
 * adapter is `storage-schema-majors.agreement.test.ts`.)
 */

const APP = 'ab_MAJOR_6101';
const OTHER_APP = 'ab_MAJOR_6202';
const obj = (properties: Record<string, unknown>) => ({ type: 'object', properties });
const S1 = obj({ title: { type: 'string', maxLength: 80 } });
const S2 = obj({ title: { type: 'string', maxLength: 300 } });
const manifest = (schema: unknown) => ({
  blockId: 'fern-board',
  storage: {
    collections: { cards: { visibility: 'private', schema }, notes: { visibility: 'private' } },
  },
});
const approved = (id: string, schema: unknown, day: number): ApprovedManifest => ({
  id,
  manifest: manifest(schema),
  reviewedAt: new Date(Date.UTC(2026, 9, day)),
});

describe('createSchemaMajorResolver', () => {
  it('is the collection’s current major; an undeclared collection has none', async () => {
    const resolve = createSchemaMajorResolver({
      readApproved: async () => [approved('pubreq_a', S1, 1), approved('pubreq_b', S2, 2)],
    });
    const head = manifest(S2);
    expect(await resolve({ appBlockId: APP, head, collection: 'cards' })).toBe(2);
    expect(await resolve({ appBlockId: APP, head, collection: 'notes' })).toBe(1);
    expect(await resolve({ appBlockId: APP, head, collection: 'missing' })).toBeNull();
  });

  it('reads the history once per enforced manifest, and again when it changes (a rollback included)', async () => {
    let history = [approved('pubreq_a', S1, 1)];
    const readApproved = vi.fn(async () => history);
    const resolve = createSchemaMajorResolver({ readApproved });

    expect(await resolve({ appBlockId: APP, head: manifest(S1), collection: 'cards' })).toBe(1);
    expect(await resolve({ appBlockId: APP, head: manifest(S1), collection: 'cards' })).toBe(1);
    expect(readApproved).toHaveBeenCalledTimes(1);

    // An approve: new history, new enforced manifest.
    history = [...history, approved('pubreq_b', S2, 2)];
    expect(await resolve({ appBlockId: APP, head: manifest(S2), collection: 'cards' })).toBe(2);
    // Rolled back to S1: the enforced manifest equals the first one again, but it is @v3.
    history = [...history, approved('pubreq_c', S1, 3)];
    expect(await resolve({ appBlockId: APP, head: manifest(S1), collection: 'cards' })).toBe(3);
    expect(readApproved).toHaveBeenCalledTimes(3);
  });

  it('keeps each app apart', async () => {
    const readApproved = vi.fn(async (appBlockId: string) =>
      appBlockId === APP ? [approved('pubreq_a', S1, 1), approved('pubreq_b', S2, 2)] : []
    );
    const resolve = createSchemaMajorResolver({ readApproved });
    expect(await resolve({ appBlockId: APP, head: manifest(S2), collection: 'cards' })).toBe(2);
    expect(await resolve({ appBlockId: OTHER_APP, head: manifest(S2), collection: 'cards' })).toBe(
      1
    );
    expect(readApproved.mock.calls.map(([id]) => id)).toEqual([APP, OTHER_APP]);
  });

  it('a failed history read is null (not known) and reported, never thrown; the next call retries', async () => {
    const onError = vi.fn();
    const readApproved = vi
      .fn<(...args: [string]) => Promise<ApprovedManifest[]>>()
      .mockRejectedValueOnce(new Error('replica blip'))
      .mockResolvedValueOnce([approved('pubreq_a', S1, 1)]);
    const resolve = createSchemaMajorResolver({ readApproved, onError });
    expect(await resolve({ appBlockId: APP, head: manifest(S1), collection: 'cards' })).toBeNull();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'replica blip' }), APP);
    expect(await resolve({ appBlockId: APP, head: manifest(S1), collection: 'cards' })).toBe(1);
  });
});
