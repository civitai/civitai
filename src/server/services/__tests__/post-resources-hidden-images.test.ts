import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * `post.getResources` serves the resources of a post the viewer may open, but only those used by an
 * image in it the viewer may open too. `getImageIdsVisibleToViewer` is stubbed with its contract
 * (the hidden image opens only for its owner and moderators); its predicate against a real
 * database is pinned in image-detail-visibility.behavior.test.ts.
 */

const { mockVisibleIds } = vi.hoisted(() => ({ mockVisibleIds: vi.fn() }));
vi.mock('~/server/services/image-visibility.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getImageIdsVisibleToViewer: mockVisibleIds,
}));

import { getPostResources } from '~/server/services/post.service';

const POST_ID = 9;
const OWNER = 5;
const SHOWN = 101;
const HIDDEN = 102;

// Version 1 is on the shown image, 2 on the hidden one, 3 on both.
const USES = [
  { imageId: SHOWN, modelVersionId: 1 },
  { imageId: HIDDEN, modelVersionId: 2 },
  { imageId: SHOWN, modelVersionId: 3 },
  { imageId: HIDDEN, modelVersionId: 3 },
];
// The view keeps one row per version, naming whichever image it met first.
const VIEW_ROWS = [
  { postId: POST_ID, modelVersionId: 1, name: 'a', imageId: SHOWN },
  { postId: POST_ID, modelVersionId: 2, name: 'b', imageId: HIDDEN },
  { postId: POST_ID, modelVersionId: 3, name: 'c', imageId: HIDDEN },
];

type Viewer = { userId?: number; isModerator?: boolean };
const ANON: Viewer = {};
const STRANGER: Viewer = { userId: 77 };
const SELF: Viewer = { userId: OWNER };
const MOD: Viewer = { userId: 77, isModerator: true };

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbRead.postResourceHelper.findMany.mockResolvedValue(VIEW_ROWS as never);
  dbMock.dbRead.image.findMany.mockResolvedValue([{ id: SHOWN }, { id: HIDDEN }] as never);
  dbMock.dbRead.imageResourceNew.findMany.mockImplementation((async (args: {
    where: { imageId: { in: number[] } };
  }) => USES.filter((u) => args.where.imageId.in.includes(u.imageId))) as never);
  mockVisibleIds.mockImplementation(async ({ ids, userId, isModerator }) => {
    const opens = isModerator || userId === OWNER;
    return new Set((ids as number[]).filter((id) => id !== HIDDEN || opens));
  });
});

const resourcesFor = (viewer: Viewer) => getPostResources({ id: POST_ID, ...viewer });

describe('post resources from images the viewer may not open', () => {
  it('drops a resource only the hidden image uses, for a stranger and signed out', async () => {
    for (const viewer of [ANON, STRANGER]) {
      const rows = await resourcesFor(viewer);
      expect(rows.map((r) => r.modelVersionId)).toEqual([1, 3]);
    }
  });

  it('keeps a resource the hidden image shares with a shown one, naming the shown image', async () => {
    const rows = await resourcesFor(STRANGER);
    expect(rows.find((r) => r.modelVersionId === 3)?.imageId).toBe(SHOWN);
    expect(rows.some((r) => r.imageId === HIDDEN)).toBe(false);
  });

  it('serves every resource to the owner and a moderator', async () => {
    for (const viewer of [SELF, MOD]) {
      const rows = await resourcesFor(viewer);
      expect(rows.map((r) => r.modelVersionId)).toEqual([1, 2, 3]);
    }
  });

  it('answers a post whose every image is hidden with no resources', async () => {
    mockVisibleIds.mockResolvedValue(new Set());
    expect(await resourcesFor(STRANGER)).toEqual([]);
  });
});
