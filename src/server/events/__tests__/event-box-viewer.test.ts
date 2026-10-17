import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as EventAccess from '~/server/events/event-access';

// How a viewer sees an event's mystery boxes: the event's own gate decides whether they see any and
// whether they may buy, and their team is read strictly, never placed.

const { mocks } = vi.hoisted(() => ({
  mocks: { events: vi.fn(), access: vi.fn(), getUserTeam: vi.fn(), settle: vi.fn() },
}));

vi.mock('~/server/events/load-events', () => ({ loadEvents: mocks.events }));
vi.mock('~/server/events/event-access', async (importOriginal) => ({
  ...(await importOriginal<typeof EventAccess>()),
  getEventAccess: mocks.access,
}));

import { getEventBoxViewer } from '../event-shop-item';

const VIEWER = { id: 5, isModerator: false };
const event = (teams: string[] = ['Pink', 'Blue']) => ({
  name: 'birthday2026',
  startDate: new Date('2026-11-01'),
  endDate: new Date('2026-11-30'),
  teams,
  getUserTeam: mocks.getUserTeam,
  settleBalancedTeam: mocks.settle,
});

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.events.mockResolvedValue([event()]);
  mocks.access.mockResolvedValue('open');
  mocks.getUserTeam.mockResolvedValue('Pink');
});

describe('getEventBoxViewer', () => {
  it('lets a viewer buy while the event is playable, with their strictly read team', async () => {
    expect(await getEventBoxViewer('birthday2026', VIEWER)).toEqual({
      playable: true,
      team: 'Pink',
    });
    expect(mocks.access).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'birthday2026' }),
      VIEWER
    );
    expect(mocks.getUserTeam).toHaveBeenCalledWith(5, { strict: true });
    expect(mocks.settle).not.toHaveBeenCalled();
  });

  it.each([
    ['preview', true],
    ['ended', false],
  ])('an event in %s is readable; playable is %s', async (access, playable) => {
    mocks.access.mockResolvedValue(access);
    expect(await getEventBoxViewer('birthday2026', VIEWER)).toEqual({ playable, team: 'Pink' });
  });

  it('shows nothing of an event closed to the viewer, or whose access cannot be read', async () => {
    mocks.access.mockResolvedValue('closed');
    expect(await getEventBoxViewer('birthday2026', VIEWER)).toBeNull();
    mocks.access.mockRejectedValue(new Error('flipt down'));
    expect(await getEventBoxViewer('birthday2026', VIEWER)).toBeNull();
    expect(mocks.getUserTeam).not.toHaveBeenCalled();
  });

  it('shows nothing of an unregistered or unloadable event', async () => {
    expect(await getEventBoxViewer('other', VIEWER)).toBeNull();
    mocks.events.mockRejectedValue(new Error('no events'));
    expect(await getEventBoxViewer('birthday2026', VIEWER)).toBeNull();
  });

  it('shows nothing when the team cannot be read', async () => {
    mocks.getUserTeam.mockRejectedValue(new Error('redis down'));
    expect(await getEventBoxViewer('birthday2026', VIEWER)).toBeNull();
  });

  it('has no team for an event without teams', async () => {
    mocks.events.mockResolvedValue([event([])]);
    expect(await getEventBoxViewer('birthday2026', VIEWER)).toEqual({
      playable: true,
      team: undefined,
    });
    expect(mocks.getUserTeam).not.toHaveBeenCalled();
  });
});
