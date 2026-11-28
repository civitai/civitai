import { describe, expect, it } from 'vitest';
import { currentLyricIndex, isSyncedLyrics, toLyricRows } from '../song-lyrics';

const lines = [
  { t: 0, text: '[Verse 1]' },
  { t: 1000, text: 'Coins in the slot' },
  { t: null, text: 'the city hums in blue' },
  { t: 4000, text: 'Joystick heartbeat' },
  { t: 9000, text: 'Player two' },
];

describe('toLyricRows', () => {
  it('turns a bracketed line into a section label and keeps every other line with its index', () => {
    expect(toLyricRows(lines)).toEqual([
      { kind: 'section', label: 'Verse 1' },
      { kind: 'line', index: 1, t: 1000, text: 'Coins in the slot' },
      { kind: 'line', index: 2, t: null, text: 'the city hums in blue' },
      { kind: 'line', index: 3, t: 4000, text: 'Joystick heartbeat' },
      { kind: 'line', index: 4, t: 9000, text: 'Player two' },
    ]);
  });
});

describe('isSyncedLyrics', () => {
  it('is true when any sung line has a time', () => {
    expect(isSyncedLyrics(lines)).toBe(true);
  });

  it('is false when no sung line has one, a timed section label included', () => {
    expect(
      isSyncedLyrics([
        { t: 0, text: '[Chorus]' },
        { t: null, text: 'Hold the light' },
      ])
    ).toBe(false);
  });
});

describe('currentLyricIndex', () => {
  it('is the last timed line the playhead has reached', () => {
    expect(currentLyricIndex(lines, 1000)).toBe(1);
    expect(currentLyricIndex(lines, 3999)).toBe(1);
    expect(currentLyricIndex(lines, 4000)).toBe(3);
    expect(currentLyricIndex(lines, 60_000)).toBe(4);
  });

  it('is -1 before the first sung line, and never a section label or an untimed line', () => {
    expect(currentLyricIndex(lines, 500)).toBe(-1);
    expect(currentLyricIndex([{ t: null, text: 'plain' }], 5000)).toBe(-1);
  });
});
