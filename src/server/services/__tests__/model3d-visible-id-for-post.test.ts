import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Model3DStatus } from '~/shared/utils/prisma/enums';

// getVisibleModel3DIdForPost backs the new `image.get` -> `model3dId`
// enrichment. It must (a) return the linked Model3D id when the viewer can see
// it, and (b) return null when the post has no link OR the model is hidden,
// applying the SAME visibility rule as the chip lookup. We mock only the DB
// read; the visibility predicate (`canViewModel3d`) is exercised through it.

const h = vi.hoisted(() => ({
  findUnique: vi.fn(),
}));

vi.mock('~/server/db/client', () => ({
  dbRead: { post: { findUnique: h.findUnique } },
  dbWrite: {},
}));

// model3d.service transitively imports many `Prisma.validator<...>()(...)`
// selector files at module-eval time. `Prisma.validator` isn't present in the
// SSR test transform of `@prisma/client`, so provide a pass-through. This
// unblocks the import chain without faking any logic the test exercises (we
// only call the cheap post→model3d lookup, which uses the mocked dbRead).
vi.mock('@prisma/client', () => ({
  Prisma: {
    validator: () => (x: unknown) => x,
    sql: () => ({}),
    join: () => ({}),
    raw: () => ({}),
  },
}));

const { getVisibleModel3DIdForPost } = await import('~/server/services/model3d.service');

const setPostModel3d = (
  model3d: { id: number; userId: number; status: Model3DStatus; deletedAt: Date | null } | null
) => h.findUnique.mockResolvedValueOnce({ model3d });

beforeEach(() => h.findUnique.mockReset());

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

  it('selects only the minimal model3d fields (no thumbnail/name) for the cheap lookup', async () => {
    setPostModel3d({ id: 321, userId: 1, status: Model3DStatus.Published, deletedAt: null });
    await getVisibleModel3DIdForPost({ postId: 9 });
    const arg = h.findUnique.mock.calls[0][0];
    expect(arg.where).toEqual({ id: 9 });
    expect(arg.select.model3d.select).toEqual({
      id: true,
      userId: true,
      status: true,
      deletedAt: true,
    });
  });
});
