import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProtectedContext } from '~/server/createContext';
import type * as HotReads5 from '@civitai/db-queries/hot-reads-5';
import type { EventPointGrant } from '~/server/events/points/award';

// `reaction.toggleWithPoints`: the toggle's result plus what it earned the viewer's own team, if
// that is known within EVENT_POINTS_WAIT_MS. Past the wait the answer goes without points and the
// award is left running; another team's grant is never handed to this viewer.

const { mockToggleReaction, viewerTeam, viewerJoined } = vi.hoisted(() => ({
  mockToggleReaction: vi.fn(),
  viewerTeam: { value: 'Yellow' as string | undefined },
  viewerJoined: { value: true },
}));

vi.mock('@civitai/db-queries/hot-reads-5', async (importOriginal) => ({
  ...(await importOriginal<typeof HotReads5>()),
  getImagePostId: vi.fn(async () => ({ postId: 42 })),
  getImageNsfwLevelAndOwner: vi.fn(async () => ({ nsfwLevel: 1, userId: 99 })),
}));
vi.mock('~/server/services/reaction.service', () => ({ toggleReaction: mockToggleReaction }));
vi.mock('~/server/utils/metric-helpers', () => ({ updateEntityMetric: vi.fn(async () => 0) }));
vi.mock('~/server/services/collection.service', () => ({
  getContestsFromEntity: vi.fn(async () => []),
}));
vi.mock('~/server/services/common.service', () => ({
  hasEntityAccess: vi.fn(async () => [{ hasAccess: true }]),
}));
vi.mock('~/server/rewards', () => ({
  encouragementReward: { apply: vi.fn(async () => undefined) },
  goodContentReward: { apply: vi.fn(async () => undefined) },
}));
vi.mock('~/server/notifications/client', () => ({
  notifications: { notificationExists: vi.fn(async () => true) },
}));
vi.mock('~/server/services/notification.service', () => ({
  createNotification: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/metric-excluded-users.service', () => ({
  getMetricExcludedUserIds: vi.fn(async () => []),
}));
vi.mock('~/server/events/load-events', () => ({
  loadEvents: async () => [{ name: 'birthday2026', getUserTeam: async () => viewerTeam.value }],
}));

import {
  EVENT_POINTS_WAIT_MS,
  toggleReactionWithPointsHandler,
} from '~/server/controllers/reaction.controller';
import { dbMock } from '~/__tests__/mocks/db.mock';
dbMock.dbRead.imageReaction.count.mockImplementation(async () => 1);
// The viewer's held team hats, by event: the only raw read on this path.
dbMock.dbRead.$queryRaw.mockImplementation((async () =>
  viewerJoined.value ? [{ event: 'birthday2026' }] : []) as never);

const input = { entityType: 'image', entityId: 1, reaction: 'Like' } as const;
const ctx = {
  user: { id: 5, isModerator: false },
  ip: '127.0.0.1',
  track: { reaction: vi.fn(async () => undefined) },
} as unknown as ProtectedContext;
const grant = (team: string, points: number): EventPointGrant => ({
  event: 'birthday2026',
  team,
  points,
});

// The service as it is called: created, handing the award's grants to `onEventPoints`.
function createdWith(grants: Promise<EventPointGrant[]>) {
  mockToggleReaction.mockImplementation(
    async (args: { onEventPoints?: (g: Promise<EventPointGrant[]>) => void }) => {
      args.onEventPoints?.(grants);
      return 'created';
    }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  viewerTeam.value = 'Yellow';
  viewerJoined.value = true;
});

describe('toggleReactionWithPointsHandler', () => {
  it("returns the viewer's team's grants, summed per event", async () => {
    createdWith(Promise.resolve([grant('Yellow', 5), grant('Yellow', 10)]));
    await expect(toggleReactionWithPointsHandler({ ctx, input })).resolves.toEqual({
      result: 'created',
      eventPoints: [grant('Yellow', 15)],
    });
  });

  it("drops another team's grant: no pop for points that help the other side", async () => {
    createdWith(Promise.resolve([grant('Blue', 25)]));
    await expect(toggleReactionWithPointsHandler({ ctx, input })).resolves.toEqual({
      result: 'created',
    });
  });

  it('drops every grant for a viewer with no team in the event', async () => {
    viewerTeam.value = undefined;
    createdWith(Promise.resolve([grant('Yellow', 5)]));
    await expect(toggleReactionWithPointsHandler({ ctx, input })).resolves.toEqual({
      result: 'created',
    });
  });

  // getUserTeam seeds a team for anyone, so a team alone does not mean they joined.
  it('drops every grant for a viewer who never joined, though a team is seeded for them', async () => {
    viewerJoined.value = false;
    createdWith(Promise.resolve([grant('Yellow', 5)]));
    await expect(toggleReactionWithPointsHandler({ ctx, input })).resolves.toEqual({
      result: 'created',
    });
  });

  it('answers without points after the wait, and leaves the award running', async () => {
    vi.useFakeTimers();
    let finish: (g: EventPointGrant[]) => void = () => undefined;
    const slow = new Promise<EventPointGrant[]>((resolve) => (finish = resolve));
    createdWith(slow);
    const answer = toggleReactionWithPointsHandler({ ctx, input });
    await vi.advanceTimersByTimeAsync(EVENT_POINTS_WAIT_MS);
    await expect(answer).resolves.toEqual({ result: 'created' });
    // The award was never cancelled: its grants still arrive, just after the answer went.
    finish([grant('Yellow', 5)]);
    await expect(slow).resolves.toEqual([grant('Yellow', 5)]);
  });

  it('does not wait for points when asked not to (event cosmetics off)', async () => {
    createdWith(new Promise<EventPointGrant[]>(() => undefined));
    await expect(
      toggleReactionWithPointsHandler({ ctx, input: { ...input, waitForPoints: false } })
    ).resolves.toEqual({ result: 'created' });
    // The service got no listener, so it was never asked to wait.
    expect(mockToggleReaction.mock.calls[0][0].onEventPoints).toBeUndefined();
    expect(mockToggleReaction.mock.calls[0][0]).not.toHaveProperty('waitForPoints');
  });

  it('returns the plain result when nothing was created', async () => {
    mockToggleReaction.mockResolvedValue('removed');
    await expect(toggleReactionWithPointsHandler({ ctx, input })).resolves.toEqual({
      result: 'removed',
    });
  });
});
