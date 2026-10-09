import { describe, expect, it } from 'vitest';
import {
  applyHatPoints,
  applyTeamPoints,
  hatTopic,
  teamsTopic,
} from '~/components/Events/ScoredEvent/event-points-live';
import { eventHatTopic, eventTeamsTopic } from '~/server/events/points/keys';

describe('topics', () => {
  // The client builds its topics without the server module (it pulls in Redis); the ticker sends
  // to the server's. A mismatch subscribes every screen to a topic nothing is sent to.
  it("match the server's, so the client subscribes where the ticker sends", () => {
    expect(hatTopic('birthday2026', 'a1b2c3d4e5f60718')).toBe(
      eventHatTopic('birthday2026', 'a1b2c3d4e5f60718')
    );
    expect(teamsTopic('birthday2026')).toBe(eventTeamsTopic('birthday2026'));
    expect(hatTopic('birthday2026', 'x')).toBe('event-points:birthday2026:hat:x');
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
