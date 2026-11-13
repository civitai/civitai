import { describe, expect, it } from 'vitest';
import { STICKER_PLACEMENT_DEFAULT_SCALE } from '~/shared/utils/sticker-placement';
import { eventTurfTopic } from '~/server/events/turf/turf-map';
import {
  teamStandings,
  RING_LENGTH,
  applyTurfPush,
  hatTone,
  readHatPose,
  readTurfPush,
  turfTopic,
  badgeLeader,
  orderedTeams,
  ringArcs,
  standingsLabel,
  formatMultiplier,
  formatRefillCadence,
} from '~/components/HatTurf/hat-turf.utils';

const counted = { blue: 6, pink: 4, green: 2, yellow: 1 };

describe('ringArcs', () => {
  it('sizes each arc by its share and leaves a gap between neighbours', () => {
    const arcs = ringArcs(counted);
    const total = 13;
    arcs.forEach((arc) => {
      const share = counted[arc.team as keyof typeof counted] / total;
      expect(arc.length).toBeCloseTo(share * RING_LENGTH - 2.2, 5);
    });
  });

  it('starts each arc where the previous share ended', () => {
    // Alphabetical: blue 6, green 2, pink 4, yellow 1.
    const [blue, green, pink, yellow] = ringArcs(counted);
    expect([blue.team, green.team, pink.team, yellow.team]).toEqual([
      'blue',
      'green',
      'pink',
      'yellow',
    ]);
    expect(blue.offset).toBe(0);
    expect(green.offset).toBeCloseTo((6 / 13) * RING_LENGTH, 5);
    expect(pink.offset).toBeCloseTo(((6 + 2) / 13) * RING_LENGTH, 5);
    expect(yellow.offset).toBeCloseTo(((6 + 2 + 4) / 13) * RING_LENGTH, 5);
  });

  it('keeps teams in a fixed order so an arc keeps its place when the lead changes', () => {
    expect(orderedTeams({ pink: 9, blue: 1 })).toEqual(['blue', 'pink']);
    expect(ringArcs({ pink: 9, blue: 1 }).map((a) => a.team)).toEqual(['blue', 'pink']);
  });

  it('draws nothing, and no gap, when there are no hats', () => {
    expect(ringArcs({ blue: 0, pink: 0 }).every((a) => a.length === 0)).toBe(true);
  });

  it('one team alone closes the whole ring with no gap', () => {
    const [blue, pink] = ringArcs({ blue: 3, pink: 0 });
    expect(blue.length).toBeCloseTo(RING_LENGTH, 5);
    expect(pink.length).toBe(0);
  });
});

describe('badgeLeader', () => {
  it('is the server leader when that team has counted hats', () => {
    expect(badgeLeader({ counted, leader: 'blue' })).toBe('blue');
  });
  it('is null with no leader, or a leader with nothing counted (shown-only stickers)', () => {
    expect(badgeLeader({ counted, leader: null })).toBeNull();
    expect(badgeLeader({ counted: { blue: 0 }, leader: 'blue' })).toBeNull();
  });
});

describe('standingsLabel', () => {
  it('names the leader, every count and the viewer’s team', () => {
    expect(standingsLabel({ counted, leader: 'blue' }, 'pink')).toBe(
      'Hat Turf: blue leads with 6. blue 6, green 2, pink 4, yellow 1. You are on pink.'
    );
  });
  it('says there are no hats yet', () => {
    expect(standingsLabel({ counted: {}, leader: null }, 'pink')).toBe('Hat Turf: no hats yet');
  });
});

describe('readHatPose', () => {
  it('reads a stored sticker and clamps it onto the picture at a legal size', () => {
    expect(readHatPose({ x: 1.4, y: -2, scale: 9, rotation: 10, flip: true })).toEqual({
      x: 1,
      y: 0,
      scale: 0.4,
      rotation: 10,
      flip: true,
      opacity: 1,
    });
  });
  it('draws a hat opaque whatever opacity its row stored', () => {
    expect(readHatPose({ x: 0.5, y: 0.5, opacity: 0.6 })?.opacity).toBe(1);
  });
  it('defaults size, turn, flip and opacity when absent', () => {
    expect(readHatPose({ x: 0.5, y: 0.5 })).toEqual({
      x: 0.5,
      y: 0.5,
      scale: STICKER_PLACEMENT_DEFAULT_SCALE,
      rotation: 0,
      flip: false,
      opacity: 1,
    });
  });
  it('is null for anything that cannot be placed', () => {
    expect(readHatPose(null)).toBeNull();
    expect(readHatPose('x')).toBeNull();
    expect(readHatPose({ x: 'a', y: 1 })).toBeNull();
    expect(readHatPose({ x: Number.NaN, y: 1 })).toBeNull();
  });
});

describe('hatTone', () => {
  it('lights the leader’s hats and dims the rest', () => {
    expect(hatTone('blue', 'blue')).toBe('lead');
    expect(hatTone('pink', 'blue')).toBe('dim');
  });
  it('leaves every hat plain when nobody leads', () => {
    expect(hatTone('pink', null)).toBe('plain');
  });
});

describe('turf pushes', () => {
  const counts = { shown: { blue: 3 }, counted: { blue: 3 }, leader: 'blue', leaderCosmeticId: 5 };
  const base = { 1: { ...counts, hatted: true, hattedTeam: 'green' } };

  it('replaces an image’s counts and keeps what the push does not carry', () => {
    const next = applyTurfPush(base, 1, {
      ...counts,
      counted: { blue: 3, pink: 4 },
      leader: 'pink',
    });
    expect(next[1].leader).toBe('pink');
    expect(next[1].hatted).toBe(true);
    expect(next[1].hattedTeam).toBe('green');
  });
  it('adds an image that had no turf, not hatted', () => {
    expect(applyTurfPush({}, 9, counts)[9]).toEqual({ ...counts, hatted: false, hattedTeam: null });
  });
  it('removes the image when the last sticker is gone, and is a no-op if it was not there', () => {
    expect(applyTurfPush(base, 1, null)).toEqual({});
    const empty = {};
    expect(applyTurfPush(empty, 1, null)).toBe(empty);
  });
  it('reads a well-formed push for this event only', () => {
    expect(readTurfPush({ event: 'e', imageId: 4, counts }, 'e')).toEqual({ imageId: 4, counts });
    expect(readTurfPush({ event: 'other', imageId: 4, counts }, 'e')).toBeNull();
    expect(readTurfPush({ event: 'e', imageId: 4, counts: null }, 'e')).toEqual({
      imageId: 4,
      counts: null,
    });
  });
  it("keeps each pushed sticker's hat art, and drops a malformed one", () => {
    const sticker = { id: '1', userId: 3, team: 'blue', cosmeticId: 11, data: {} };
    const read = (art: unknown) =>
      readTurfPush({ event: 'e', imageId: 4, counts, stickers: [{ ...sticker, art }] }, 'e')
        ?.stickers?.[0];
    expect(read({ url: 'cap', canvas: [128, 160], bounds: [1, 2, 3, 4] })?.art).toEqual({
      url: 'cap',
      canvas: [128, 160],
      bounds: [1, 2, 3, 4],
    });
    // A bad fit is dropped, the art kept; art without a url is no art.
    expect(read({ url: 'cap', canvas: ['x'] })?.art).toEqual({
      url: 'cap',
      canvas: null,
      bounds: null,
    });
    expect(read({ canvas: [128, 160] })).not.toHaveProperty('art');
  });
  it("keeps each pushed sticker's placement time, so the reveal plays in placement order", () => {
    const sticker = { id: '1', userId: 3, team: 'blue', cosmeticId: 11, data: {} };
    const read = (createdAt: unknown) =>
      readTurfPush({ event: 'e', imageId: 4, counts, stickers: [{ ...sticker, createdAt }] }, 'e')
        ?.stickers?.[0];
    expect(read('2026-11-05T03:00:00.000Z')?.createdAt).toBe('2026-11-05T03:00:00.000Z');
    expect(read('not a date')).not.toHaveProperty('createdAt');
  });
  it('refuses a malformed push instead of drawing from it', () => {
    expect(readTurfPush({ event: 'e', imageId: 'x', counts }, 'e')).toBeNull();
    expect(readTurfPush({ event: 'e', imageId: 4, counts: { shown: 1 } }, 'e')).toBeNull();
    expect(readTurfPush(undefined, 'e')).toBeNull();
  });
});

describe('turfTopic', () => {
  it('is the topic the server pushes to', () => {
    expect(turfTopic('birthday2026', 42)).toBe(eventTurfTopic('birthday2026', 42));
  });
});

describe('teamStandings', () => {
  it('lists the viewer team with no hats, most hats first, and the total', () => {
    const out = teamStandings({ counted: { blue: 2, pink: 5 }, leader: 'pink' }, 'yellow');
    expect(out.rows).toEqual([
      { team: 'pink', count: 5 },
      { team: 'blue', count: 2 },
      { team: 'yellow', count: 0 },
    ]);
    expect(out.total).toBe(7);
    expect(out.toTake).toBe(6);
  });

  it('a tie is not a take: level with the leader still needs one more', () => {
    expect(teamStandings({ counted: { blue: 3, pink: 3 }, leader: 'pink' }, 'blue').toTake).toBe(1);
  });

  it('nothing to take when the viewer leads, has no team, or nobody has hats', () => {
    expect(teamStandings({ counted: { pink: 3 }, leader: 'pink' }, 'pink').toTake).toBeNull();
    expect(teamStandings({ counted: { pink: 3 }, leader: 'pink' }, null).toTake).toBeNull();
    expect(teamStandings({ counted: {}, leader: null }, 'blue').toTake).toBeNull();
  });
});

describe('formatRefillCadence', () => {
  it.each([
    [15, '4 min'],
    [5, '12 min'],
    [60, '1 min'],
    [120, '30 s'],
    [0.4, '2h 30m'],
    [1, '1h'],
    [0, null],
    [Number.NaN, null],
  ])('%s an hour is %s', (perHour, expected) => {
    expect(formatRefillCadence(perHour)).toBe(expected);
  });
});

describe('formatMultiplier', () => {
  it('keeps at most two decimals and no trailing zeros', () => {
    expect(formatMultiplier(1.5)).toBe('1.5');
    expect(formatMultiplier(0.75)).toBe('0.75');
    expect(formatMultiplier(2)).toBe('2');
    expect(formatMultiplier(1.2345)).toBe('1.23');
  });
});
