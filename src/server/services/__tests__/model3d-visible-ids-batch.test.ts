import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Model3DStatus } from '~/shared/utils/prisma/enums';

// getVisibleModel3DIds is the BATCHED authZ used by the image FEED path
// (getAllImages / getAllImagesIndex). The feed payload carries a RAW
// `Post.model3dId` (from SQL or the Meili doc) that is NOT visibility-checked;
// this function must, in ONE query (no per-image N+1), return the SET of ids the
// viewer may see so a hidden Draft / deleted / non-owner model is nulled before
// reaching the client — exactly as the single-post lookup does for image.get.
// We mock only the DB read; the visibility predicate (canViewModel3d) is
// exercised through it.

const h = vi.hoisted(() => ({
  findMany: vi.fn(),
}));

vi.mock('~/server/db/client', () => ({
  dbRead: { model3D: { findMany: h.findMany } },
  dbWrite: {},
}));

// model3d.service transitively imports many `Prisma.validator<...>()(...)`
// selector files at module-eval time (see model3d-visible-id-for-post.test.ts).
vi.mock('@prisma/client', () => ({
  Prisma: {
    validator: () => (x: unknown) => x,
    sql: () => ({}),
    join: () => ({}),
    raw: () => ({}),
  },
}));

const { getVisibleModel3DIds } = await import('~/server/services/model3d.service');

type Row = { id: number; userId: number; status: Model3DStatus; deletedAt: Date | null };
const setRows = (rows: Row[]) => h.findMany.mockResolvedValueOnce(rows);

const OWNER = 1;
const OTHER = 99;

beforeEach(() => h.findMany.mockReset());

describe('getVisibleModel3DIds — batched feed authZ for the model3dId field', () => {
  it('returns an empty set without querying when no ids are passed', async () => {
    const visible = await getVisibleModel3DIds({ model3dIds: [], userId: OTHER });
    expect(visible.size).toBe(0);
    expect(h.findMany).not.toHaveBeenCalled();
  });

  it('keeps a Published, not-deleted model for a public (non-owner) viewer', async () => {
    setRows([{ id: 10, userId: OWNER, status: Model3DStatus.Published, deletedAt: null }]);
    const visible = await getVisibleModel3DIds({ model3dIds: [10], userId: OTHER });
    expect([...visible]).toEqual([10]);
  });

  it('nulls a Draft (unpublished) model for a non-owner non-mod', async () => {
    setRows([{ id: 11, userId: OWNER, status: Model3DStatus.Draft, deletedAt: null }]);
    const visible = await getVisibleModel3DIds({ model3dIds: [11], userId: OTHER });
    expect(visible.has(11)).toBe(false);
  });

  it('nulls a deleted (Published-but-deletedAt) model for a non-owner non-mod', async () => {
    setRows([
      { id: 12, userId: OWNER, status: Model3DStatus.Published, deletedAt: new Date() },
    ]);
    const visible = await getVisibleModel3DIds({ model3dIds: [12], userId: OTHER });
    expect(visible.has(12)).toBe(false);
  });

  it('keeps the owner-own Draft for the owner', async () => {
    setRows([{ id: 13, userId: OWNER, status: Model3DStatus.Draft, deletedAt: null }]);
    const visible = await getVisibleModel3DIds({ model3dIds: [13], userId: OWNER });
    expect(visible.has(13)).toBe(true);
  });

  it('keeps a deleted model for a moderator', async () => {
    setRows([
      { id: 14, userId: OWNER, status: Model3DStatus.Published, deletedAt: new Date() },
    ]);
    const visible = await getVisibleModel3DIds({
      model3dIds: [14],
      userId: OTHER,
      isModerator: true,
    });
    expect(visible.has(14)).toBe(true);
  });

  it('partitions a mixed batch in ONE query — visible kept, hidden dropped', async () => {
    setRows([
      { id: 20, userId: OWNER, status: Model3DStatus.Published, deletedAt: null }, // visible
      { id: 21, userId: OWNER, status: Model3DStatus.Draft, deletedAt: null }, // hidden (draft)
      { id: 22, userId: OWNER, status: Model3DStatus.Published, deletedAt: new Date() }, // hidden (deleted)
    ]);
    const visible = await getVisibleModel3DIds({ model3dIds: [20, 21, 22], userId: OTHER });
    expect([...visible].sort((a, b) => a - b)).toEqual([20]);
    // Single batched read — no per-image N+1.
    expect(h.findMany).toHaveBeenCalledTimes(1);
  });

  it('dedupes ids and queries only the minimal authZ fields', async () => {
    setRows([{ id: 30, userId: OWNER, status: Model3DStatus.Published, deletedAt: null }]);
    await getVisibleModel3DIds({ model3dIds: [30, 30, 30] });
    const arg = h.findMany.mock.calls[0][0];
    expect(arg.where).toEqual({ id: { in: [30] } });
    expect(arg.select).toEqual({ id: true, userId: true, status: true, deletedAt: true });
  });
});
