import { beforeEach, describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { followsViewerFromRows, getFollowsViewer } from '~/server/services/follows-viewer.service';

const queryRaw = dbMock.dbRead.$queryRaw;

const viewerId = 10;
const userId = 20;
const follow = { userId, targetUserId: viewerId, type: 'Follow' as const };
const viewerFollows = { userId: viewerId, targetUserId: userId, type: 'Follow' as const };
const viewerBlocks = { userId: viewerId, targetUserId: userId, type: 'Block' as const };
const viewerHides = { userId: viewerId, targetUserId: userId, type: 'Hide' as const };

describe('followsViewerFromRows', () => {
  it('is true when the other user follows the viewer', () => {
    expect(followsViewerFromRows([follow], { viewerId, userId })).toBe(true);
  });

  it('is false with no follow row', () => {
    expect(followsViewerFromRows([], { viewerId, userId })).toBe(false);
  });

  it("does not read the viewer's own follow as the other user's", () => {
    expect(followsViewerFromRows([viewerFollows], { viewerId, userId })).toBe(false);
  });

  // Each direction is its own primary-key row, so a viewer who blocked a follower still has
  // that follower's Follow row beside their Block. "Follow back" must not show across a block.
  it('is false when the viewer has blocked a user who follows them', () => {
    expect(followsViewerFromRows([follow, viewerBlocks], { viewerId, userId })).toBe(false);
  });

  it('is false when the other user has blocked the viewer', () => {
    const blockedBy = { userId, targetUserId: viewerId, type: 'Block' as const };
    expect(followsViewerFromRows([blockedBy], { viewerId, userId })).toBe(false);
  });

  it('a Hide by the viewer does not suppress it', () => {
    expect(followsViewerFromRows([follow, viewerHides], { viewerId, userId })).toBe(true);
  });
});

describe('getFollowsViewer', () => {
  beforeEach(() => {
    queryRaw.mockReset();
  });

  it('reads both directions of the pair', async () => {
    queryRaw.mockResolvedValue([follow, viewerBlocks]);
    await expect(getFollowsViewer({ viewerId, userId })).resolves.toBe(false);
    expect(queryRaw).toHaveBeenCalledTimes(1);
    const [strings, ...values] = queryRaw.mock.calls[0] as [TemplateStringsArray, ...number[]];
    // Nothing here executes SQL, so the statement is pinned as text: `AND` for `OR`, or a
    // swapped column, would read one direction only and still bind these same four values.
    expect(strings.join('$').replace(/\s+/g, ' ').trim()).toBe(
      'SELECT "userId", "targetUserId", "type" FROM "UserEngagement" ' +
        'WHERE ("userId" = $ AND "targetUserId" = $) OR ("userId" = $ AND "targetUserId" = $)'
    );
    expect(values).toEqual([userId, viewerId, viewerId, userId]);
  });

  it('answers true for a follower with no block', async () => {
    queryRaw.mockResolvedValue([follow]);
    await expect(getFollowsViewer({ viewerId, userId })).resolves.toBe(true);
  });

  it('never queries for the viewer themselves', async () => {
    await expect(getFollowsViewer({ viewerId, userId: viewerId })).resolves.toBe(false);
    expect(queryRaw).not.toHaveBeenCalled();
  });
});
