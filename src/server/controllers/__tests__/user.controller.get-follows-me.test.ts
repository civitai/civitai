import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FollowsViewerService from '~/server/services/follows-viewer.service';

const { getFollowsViewer } = vi.hoisted(() => ({ getFollowsViewer: vi.fn(async () => true) }));

vi.mock('~/server/services/follows-viewer.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FollowsViewerService>()),
  getFollowsViewer,
}));

import { getFollowsMeHandler } from '~/server/controllers/user.controller';

type Ctx = Parameters<typeof getFollowsMeHandler>[0]['ctx'];

const VIEWER = 990000101;
const OTHER = 990000202;

beforeEach(() => vi.clearAllMocks());

describe('user.getFollowsMe', () => {
  // Swapped, it answers "does the viewer follow them", which the client never asks while the
  // viewer follows them, so the label would silently always read Follow.
  it('asks whether the input user follows the session user', async () => {
    await expect(
      getFollowsMeHandler({ ctx: { user: { id: VIEWER } } as unknown as Ctx, input: { id: OTHER } })
    ).resolves.toBe(true);
    expect(getFollowsViewer).toHaveBeenCalledWith({ viewerId: VIEWER, userId: OTHER });
  });
});
