import { describe, expect, it, vi } from 'vitest';
import type { ApprovedManifest } from '~/server/services/apps/storage-schema-majors';
import {
  createSchemaMajorResolver,
  enforcedManifestOf,
} from '~/server/services/apps/doc-store-schema-major';

/**
 * The store-side major resolver: which major a production write is stamped with, when it reads
 * the history again, and that a failure never refuses the write. (That it agrees with the registry
 * adapter is `storage-schema-majors.agreement.test.ts`.)
 */

type ReadApproved = Parameters<typeof createSchemaMajorResolver>[0]['readApproved'];

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

/** The enforced manifest at a row revision (`app_blocks.updated_at`). */
const head = (schema: unknown, revision: string | null = 'rev-1') => ({
  manifest: manifest(schema),
  revision,
});

describe('createSchemaMajorResolver', () => {
  it('is the collection’s current major; an undeclared collection has none', async () => {
    const resolve = createSchemaMajorResolver({
      readApproved: async () => [approved('pubreq_a', S1, 1), approved('pubreq_b', S2, 2)],
    });
    const h2 = head(S2);
    expect(await resolve({ appBlockId: APP, head: h2, collection: 'cards' })).toBe(2);
    expect(await resolve({ appBlockId: APP, head: h2, collection: 'notes' })).toBe(1);
    expect(await resolve({ appBlockId: APP, head: h2, collection: 'missing' })).toBeNull();
  });

  it('no enforced manifest: no major, and no history read', async () => {
    const readApproved = vi.fn(async () => [approved('pubreq_a', S1, 1)]);
    const resolve = createSchemaMajorResolver({ readApproved });
    expect(await resolve({ appBlockId: APP, head: undefined, collection: 'cards' })).toBeNull();
    expect(readApproved).not.toHaveBeenCalled();
  });

  it('reads the history once per revision, and again when the revision changes (a rollback included)', async () => {
    let history = [approved('pubreq_a', S1, 1)];
    const readApproved = vi.fn(async () => history);
    const resolve = createSchemaMajorResolver({ readApproved });

    expect(await resolve({ appBlockId: APP, head: head(S1, 'rev-1'), collection: 'cards' })).toBe(
      1
    );
    expect(await resolve({ appBlockId: APP, head: head(S1, 'rev-1'), collection: 'cards' })).toBe(
      1
    );
    expect(readApproved).toHaveBeenCalledTimes(1);

    // An approve: new history, new enforced manifest, new row revision.
    history = [...history, approved('pubreq_b', S2, 2)];
    expect(await resolve({ appBlockId: APP, head: head(S2, 'rev-2'), collection: 'cards' })).toBe(
      2
    );
    // Rolled back to S1: the manifest equals the first one again, but the revision is new: @v3.
    history = [...history, approved('pubreq_c', S1, 3)];
    expect(await resolve({ appBlockId: APP, head: head(S1, 'rev-3'), collection: 'cards' })).toBe(
      3
    );
    expect(readApproved).toHaveBeenCalledTimes(3);
  });

  it('the key is the revision, never the manifest content: an unchanged revision is a hit', async () => {
    const readApproved = vi.fn(async () => [approved('pubreq_a', S1, 1)]);
    const resolve = createSchemaMajorResolver({ readApproved });
    expect(await resolve({ appBlockId: APP, head: head(S1, 'rev-9'), collection: 'cards' })).toBe(
      1
    );
    // A different manifest object under the same revision (as each request reads a new copy).
    expect(await resolve({ appBlockId: APP, head: head(S2, 'rev-9'), collection: 'cards' })).toBe(
      1
    );
    expect(readApproved).toHaveBeenCalledTimes(1);
  });

  it('an unknown revision is never cached: every call derives', async () => {
    const readApproved = vi.fn(async () => [approved('pubreq_a', S1, 1)]);
    const resolve = createSchemaMajorResolver({ readApproved });
    await resolve({ appBlockId: APP, head: head(S1, null), collection: 'cards' });
    await resolve({ appBlockId: APP, head: head(S1, null), collection: 'cards' });
    expect(readApproved).toHaveBeenCalledTimes(2);
  });

  it('concurrent misses for one revision share a single history read', async () => {
    let release: (rows: ApprovedManifest[]) => void = () => undefined;
    const readApproved = vi.fn(
      () => new Promise<ApprovedManifest[]>((resolve) => (release = resolve))
    );
    const resolve = createSchemaMajorResolver({ readApproved });
    const calls = [1, 2, 3].map(() =>
      resolve({ appBlockId: APP, head: head(S2, 'rev-4'), collection: 'cards' })
    );
    await Promise.resolve();
    release([approved('pubreq_a', S1, 1), approved('pubreq_b', S2, 2)]);
    expect(await Promise.all(calls)).toEqual([2, 2, 2]);
    expect(readApproved).toHaveBeenCalledTimes(1);
  });

  it('keeps each app apart', async () => {
    const readApproved = vi.fn(async (appBlockId: string) =>
      appBlockId === APP ? [approved('pubreq_a', S1, 1), approved('pubreq_b', S2, 2)] : []
    );
    const resolve = createSchemaMajorResolver({ readApproved });
    expect(await resolve({ appBlockId: APP, head: head(S2), collection: 'cards' })).toBe(2);
    expect(await resolve({ appBlockId: OTHER_APP, head: head(S2), collection: 'cards' })).toBe(1);
    expect(readApproved.mock.calls.map(([id]) => id)).toEqual([APP, OTHER_APP]);
  });

  it('a failed history read is null (not known) and reported, never thrown or kept; the next call retries', async () => {
    const onError = vi.fn();
    const readApproved = vi
      .fn<ReadApproved>()
      .mockRejectedValueOnce(new Error('replica blip'))
      .mockResolvedValueOnce([approved('pubreq_a', S1, 1)]);
    const resolve = createSchemaMajorResolver({ readApproved, onError });
    expect(await resolve({ appBlockId: APP, head: head(S1), collection: 'cards' })).toBeNull();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'replica blip' }), APP);
    expect(await resolve({ appBlockId: APP, head: head(S1), collection: 'cards' })).toBe(1);
    expect(readApproved).toHaveBeenCalledTimes(2);
  });
});

describe('enforcedManifestOf', () => {
  it('carries the row revision as an ISO string, null when the row has none, undefined for no row', () => {
    const m = manifest(S1);
    expect(
      enforcedManifestOf({ manifest: m, updatedAt: new Date('2026-11-06T10:11:12.345Z') })
    ).toEqual({
      manifest: m,
      revision: '2026-11-06T10:11:12.345Z',
    });
    expect(enforcedManifestOf({ manifest: m })).toEqual({ manifest: m, revision: null });
    expect(enforcedManifestOf(null)).toBeUndefined();
  });
});
