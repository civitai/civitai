import { describe, expect, it } from 'vitest';
import * as live from '~/components/Events/ScoredEvent/event-points-live';
import {
  applyHatPoints,
  applyTeamPoints,
  hatTopic,
  readHatPush,
  readTeamsPush,
  teamsTopic,
} from '~/components/Events/ScoredEvent/event-points-live';
import { SignalMessages } from '~/server/common/enums';
import {
  eventHatTopic,
  eventTeamsTopic,
  hatField,
  hatTopicId,
  previewTopicId,
  seasonTeamsTopic,
  seasonTeamsTopicId,
} from '~/server/events/points/keys';
import { createEventPointsPusher } from '~/server/events/points/push';
import * as serverWatch from '~/server/events/points/watch';

describe('topics', () => {
  // The client builds its topics without the server module (it pulls in Redis); the pusher sends
  // to the server's. A mismatch subscribes every screen to a topic nothing is sent to.
  it("watch the server's interest-set member and refresh inside its TTL", () => {
    expect(live.TEAMS_WATCH).toBe(serverWatch.TEAMS_WATCH);
    expect(live.WATCH_REFRESH_MS).toBe(serverWatch.WATCH_REFRESH_MS);
    // Two refreshes can be missed before a mark lapses.
    expect(serverWatch.WATCH_TTL_MS).toBeGreaterThanOrEqual(3 * live.WATCH_REFRESH_MS);
  });

  it("match the server's, so the client subscribes where the pusher sends", () => {
    expect(hatTopic('birthday2026', 'a1b2c3d4e5f60718')).toBe(
      eventHatTopic('birthday2026', 'a1b2c3d4e5f60718')
    );
    expect(teamsTopic('birthday2026', live.TEAMS_WATCH)).toBe(eventTeamsTopic('birthday2026'));
    expect(hatTopic('birthday2026', 'x')).toBe('event-points:birthday2026:hat:x');
    // The preview's team totals: the client joins the id it was handed onto the same prefix.
    const keyed = seasonTeamsTopicId('birthday2026', 'preview');
    expect(teamsTopic('birthday2026', keyed)).toBe(seasonTeamsTopic('birthday2026', keyed));
    expect(teamsTopic('birthday2026', keyed)).toBe(`event-points:birthday2026:teams:${keyed}`);
    expect(seasonTeamsTopicId('birthday2026', 'live')).toBe(live.TEAMS_WATCH);
    expect(keyed).toBe(previewTopicId('birthday2026', 'teams'));
  });
});

// The two ends of the wire: what the pusher sends must be what the screens read. A renamed field
// on either side would leave every screen silently ignoring every push.
describe('what the pusher sends, the client reads', () => {
  it('a hat push and a teams push round-trip', async () => {
    const hat = { ownerId: 9, cosmeticId: 31, claimKey: 'claimed' };
    const sent: { target: string; data: Record<string, unknown> }[] = [];
    const pusher = createEventPointsPusher({
      selectWatched: async (_e, hats, teams) => ({ hats, teams }),
      claimTeamsPush: async () => true,
      getHatPoints: async () => ({ [hatField(hat)]: 64 }),
      getTeamPoints: async () => ({ Blue: 900 }),
      topicSend: async (args) => void sent.push(args),
      isEnabled: () => true,
    });
    const event = {
      name: 'birthday2026',
      startDate: new Date('2026-01-01'),
      endDate: new Date('2999-01-01'),
      teams: ['Blue'],
    };
    pusher.markDirty(event, hat, new Date());
    await pusher.flush();
    const hatData = sent.find((s) => s.target === SignalMessages.EventPointsHat)!.data;
    const teamsData = sent.find((s) => s.target === SignalMessages.EventPointsTeams)!.data;
    expect(readHatPush(hatData, 'birthday2026')).toEqual({ topicId: hatTopicId(hat), points: 64 });
    expect(readTeamsPush(teamsData, 'birthday2026')).toEqual({ Blue: 900 });
  });
});

describe('readHatPush / readTeamsPush', () => {
  const hatPush = { event: 'birthday2026', topicId: 'a', points: 5 };

  it("ignores another event's push", () => {
    expect(readHatPush(hatPush, 'other')).toBeNull();
    expect(readTeamsPush({ event: 'birthday2026', teams: { Blue: 1 } }, 'other')).toBeNull();
  });

  it('ignores a push whose total is not a finite number', () => {
    for (const points of ['5', NaN, Infinity, null, undefined])
      expect(readHatPush({ ...hatPush, points }, 'birthday2026')).toBeNull();
    expect(readHatPush({ ...hatPush, topicId: 5 }, 'birthday2026')).toBeNull();
    expect(readHatPush(undefined, 'birthday2026')).toBeNull();
  });

  it('keeps only numeric team totals', () => {
    expect(
      readTeamsPush(
        { event: 'birthday2026', teams: { Blue: 3, Pink: 'x', Green: NaN } },
        'birthday2026'
      )
    ).toEqual({ Blue: 3 });
    expect(readTeamsPush({ event: 'birthday2026' }, 'birthday2026')).toBeNull();
  });
});

describe('applyHatPoints', () => {
  const rows = [
    { topicId: 'a', points: 10, name: 'Party Cap' },
    { topicId: 'b', points: 20, name: 'Crown' },
  ];

  it('sets the pushed total on the matching hat only', () => {
    expect(applyHatPoints(rows, 'b', 25)).toEqual([
      { topicId: 'a', points: 10, name: 'Party Cap' },
      { topicId: 'b', points: 25, name: 'Crown' },
    ]);
  });

  // A lower total is real: the referee takes back points from a banned account.
  it('applies a total that went down', () => {
    expect(applyHatPoints(rows, 'a', 4)?.[0].points).toBe(4);
  });

  it('keeps the same array when no hat matches or the total is unchanged', () => {
    expect(applyHatPoints(rows, 'zzz', 99)).toBe(rows);
    expect(applyHatPoints(rows, 'a', 10)).toBe(rows);
    expect(applyHatPoints(undefined, 'a', 10)).toBeUndefined();
  });
});

describe('applyTopHatPoints', () => {
  const standings = {
    updatedAt: 1,
    topCosmetics: [
      { topicId: 'a', points: 30 },
      { topicId: 'b', points: 20 },
      { topicId: 'c', points: 10 },
    ],
  };

  it('puts the pushed total on its row and re-sorts by points', () => {
    expect(live.applyTopHatPoints(standings, 'c', 25)).toEqual({
      updatedAt: 1,
      topCosmetics: [
        { topicId: 'a', points: 30 },
        { topicId: 'c', points: 25 },
        { topicId: 'b', points: 20 },
      ],
    });
  });

  it('returns the same object for a hat not in the list, or an unchanged total', () => {
    expect(live.applyTopHatPoints(standings, 'zz', 99)).toBe(standings);
    expect(live.applyTopHatPoints(standings, 'b', 20)).toBe(standings);
    expect(live.applyTopHatPoints(undefined, 'a', 1)).toBeUndefined();
  });
});

describe('applyTeamPoints', () => {
  const standings = {
    teams: [
      { team: 'Yellow', score: 900, rank: 1 },
      { team: 'Blue', score: 800, rank: 2 },
      { team: 'Pink', score: 100, rank: 3 },
    ],
    history: [],
  };

  it('sets the pushed totals and re-ranks', () => {
    expect(applyTeamPoints(standings, { Blue: 950, Yellow: 900 })?.teams).toEqual([
      { team: 'Blue', score: 950, rank: 1 },
      { team: 'Yellow', score: 900, rank: 2 },
      { team: 'Pink', score: 100, rank: 3 },
    ]);
  });

  it('keeps the same object when nothing changed', () => {
    expect(applyTeamPoints(standings, { Yellow: 900 })).toBe(standings);
    expect(applyTeamPoints(standings, { Green: 5 })).toBe(standings);
    expect(applyTeamPoints(undefined, { Yellow: 1 })).toBeUndefined();
  });
});
