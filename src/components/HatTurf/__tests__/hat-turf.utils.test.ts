import { describe, expect, it } from 'vitest';
import { eventTurfTopic } from '~/server/events/turf/turf-map';
import {
  HAT_DEFAULT_SCALE,
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
  viewerBehind,
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

describe('viewerBehind', () => {
  it('shows the viewer’s team count when it is not the leader', () => {
    expect(viewerBehind({ counted, leader: 'blue' }, 'pink')).toEqual({ team: 'pink', count: 4 });
  });
  it('is null for the leader, for no team, and when nobody leads', () => {
    expect(viewerBehind({ counted, leader: 'blue' }, 'blue')).toBeNull();
    expect(viewerBehind({ counted, leader: 'blue' }, null)).toBeNull();
    expect(viewerBehind({ counted: {}, leader: null }, 'pink')).toBeNull();
  });
  it('a team with no hats yet reads 0', () => {
    expect(viewerBehind({ counted: { blue: 2 }, leader: 'blue' }, 'green')).toEqual({
      team: 'green',
      count: 0,
    });
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
    });
  });
  it('defaults size, turn and flip when absent', () => {
    expect(readHatPose({ x: 0.5, y: 0.5 })).toEqual({
      x: 0.5,
      y: 0.5,
      scale: HAT_DEFAULT_SCALE,
      rotation: 0,
      flip: false,
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
  const base = { 1: { ...counts, hatted: true } };

  it('replaces an image’s counts and keeps what the push does not carry', () => {
    const next = applyTurfPush(base, 1, {
      ...counts,
      counted: { blue: 3, pink: 4 },
      leader: 'pink',
    });
    expect(next[1].leader).toBe('pink');
    expect(next[1].hatted).toBe(true);
  });
  it('adds an image that had no turf, not hatted', () => {
    expect(applyTurfPush({}, 9, counts)[9]).toEqual({ ...counts, hatted: false });
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
