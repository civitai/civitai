import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as HotReads5 from '@civitai/db-queries/hot-reads-5';
import { Model3DStatus } from '~/shared/utils/prisma/enums';

// getVisibleModel3DIdForPost backs the new `image.get` -> `model3dId`
// enrichment. It must (a) return the linked Model3D id when the viewer can see
// it, and (b) return null when the post has no link OR the model is hidden,
// applying the SAME visibility rule as the chip lookup. We mock only the DB
// read (the post's Model3D, one Kysely statement whose rows, against a real
// database, are pinned in hot-reads-5.kysely-parity.test.ts); the visibility
// predicate (`canViewModel3d`) is exercised through it.

const h = vi.hoisted(() => ({
  getPostModel3d: vi.fn(),
}));

vi.mock('@civitai/db-queries/hot-reads-5', async (importOriginal) => ({
  ...(await importOriginal<typeof HotReads5>()),
  getPostModel3d: h.getPostModel3d,
}));

vi.mock('~/server/db/client', () => ({
  dbRead: {},
  dbWrite: {},
}));

// model3d.service transitively imports many `Prisma.validator<...>()(...)`
// selector files at module-eval time. `Prisma.validator` isn't present in the
// SSR test transform of `@prisma/client`, so provide a pass-through. This
// unblocks the import chain without faking any logic the test exercises (we
// only call the cheap post→model3d lookup, which uses the mocked read).
vi.mock('@prisma/client', () => ({
  Prisma: {
    validator: () => (x: unknown) => x,
    sql: () => ({}),
    join: () => ({}),
    raw: () => ({}),
  },
}));

const { getVisibleModel3DIdForPost } = await import('~/server/services/model3d.service');
const { kyselyRead } = await import('~/server/db/kyselyDb');

/** The post's row from the Kysely read: the Model3D columns are null when nothing is linked. */
const setPostModel3d = (
  model3d: { id: number; userId: number; status: Model3DStatus; deletedAt: Date | null } | null
) =>
  h.getPostModel3d.mockResolvedValueOnce({
    postId: 9,
    model3dRowId: model3d?.id ?? null,
    model3dUserId: model3d?.userId ?? null,
    model3dStatus: model3d?.status ?? null,
    model3dDeletedAt: model3d?.deletedAt ?? null,
  });

beforeEach(() => h.getPostModel3d.mockReset());

describe('getVisibleModel3DIdForPost', () => {
  it('returns the id for a Published, not-deleted model (public viewer)', async () => {
    setPostModel3d({ id: 321, userId: 1, status: Model3DStatus.Published, deletedAt: null });
    await expect(getVisibleModel3DIdForPost({ postId: 9, userId: 99 })).resolves.toBe(321);
  });

  it('returns null when the post has no linked Model3D', async () => {
    setPostModel3d(null);
    await expect(getVisibleModel3DIdForPost({ postId: 9, userId: 99 })).resolves.toBeNull();
  });

  it('returns null for a non-owner non-mod when the model is a Draft (hidden)', async () => {
    setPostModel3d({ id: 321, userId: 1, status: Model3DStatus.Draft, deletedAt: null });
    await expect(getVisibleModel3DIdForPost({ postId: 9, userId: 99 })).resolves.toBeNull();
  });

  it('returns the id for the owner even when the model is a Draft', async () => {
    setPostModel3d({ id: 321, userId: 99, status: Model3DStatus.Draft, deletedAt: null });
    await expect(getVisibleModel3DIdForPost({ postId: 9, userId: 99 })).resolves.toBe(321);
  });

  it('returns the id for a moderator even when the model is deleted', async () => {
    setPostModel3d({ id: 321, userId: 1, status: Model3DStatus.Published, deletedAt: new Date() });
    await expect(
      getVisibleModel3DIdForPost({ postId: 9, userId: 5, isModerator: true })
    ).resolves.toBe(321);
  });

  it('returns null for a missing post', async () => {
    h.getPostModel3d.mockResolvedValueOnce(undefined);
    await expect(getVisibleModel3DIdForPost({ postId: 9, userId: 99 })).resolves.toBeNull();
  });

  it('reads the post by its id, once, through Kysely on the replica', async () => {
    setPostModel3d({ id: 321, userId: 1, status: Model3DStatus.Published, deletedAt: null });
    await getVisibleModel3DIdForPost({ postId: 9 });
    expect(h.getPostModel3d.mock.calls).toEqual([[kyselyRead, 9]]);
    expect(h.getPostModel3d.mock.calls[0][0]).toBe(kyselyRead);
  });
});
