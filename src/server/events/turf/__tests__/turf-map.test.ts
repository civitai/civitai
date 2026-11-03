import { describe, expect, it } from 'vitest';
import { capTurfMap, computeImageTurf, type TurfStickerRow } from '~/server/events/turf/turf-map';

const COSMETICS: Record<string, number> = { Blue: 11, Pink: 12 };
const cosmetic = (team: string) => COSMETICS[team];
let t = 0;
const row = (userId: number, team: string, eligible = true): TurfStickerRow => ({
  userId,
  team,
  cosmeticId: 500 + userId,
  eligible,
  createdAt: new Date(1_000 + t++),
});

describe('computeImageTurf', () => {
  it('between teams level on eligible stickers, the first to reach the count leads', () => {
    // Pink reaches 2 with its third sticker overall, Blue only with the fourth.
    const { counts, entry } = computeImageTurf(
      [row(1, 'Blue'), row(2, 'Pink'), row(3, 'Pink'), row(4, 'Blue'), row(5, 'Blue', false)],
      25,
      cosmetic
    );
    expect(counts.leader).toBe('Pink');
    expect(entry?.players).toEqual([2, 3]);
    expect(counts.leaderCosmeticId).toBe(502);
  });

  it('ineligible stickers show but never decide the lead', () => {
    const { counts, entry } = computeImageTurf(
      [row(1, 'Blue'), row(2, 'Pink', false), row(3, 'Pink', false)],
      25,
      cosmetic
    );
    expect(counts.shown).toEqual({ Blue: 1, Pink: 2 });
    expect(counts.leader).toBe('Blue');
    expect(entry?.players).toEqual([1]);
  });

  it("credits the leading team's earliest eligible stickerers, up to the cap", () => {
    const { entry } = computeImageTurf(
      [row(1, 'Pink'), row(2, 'Pink', false), row(3, 'Pink'), row(4, 'Blue'), row(5, 'Pink')],
      2,
      cosmetic
    );
    expect(entry).toMatchObject({ team: 'Pink', cosmeticId: 12, players: [1, 3] });
  });
});

describe('capTurfMap', () => {
  it('keeps the most recently stickered images', () => {
    const entry = (lastAt: number) => ({ team: 'Blue', cosmeticId: 11, players: [1], lastAt });
    const { kept, dropped } = capTurfMap(
      new Map([
        ['Image:1', entry(10)],
        ['Image:2', entry(30)],
        ['Image:3', entry(20)],
      ]),
      2
    );
    expect([...kept.keys()]).toEqual(['Image:2', 'Image:3']);
    expect(dropped).toBe(1);
  });
});
