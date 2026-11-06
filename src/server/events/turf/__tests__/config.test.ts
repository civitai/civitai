import { describe, expect, it } from 'vitest';
import { applyTurfOverride, type EventTurfConfig } from '~/server/events/turf/config';

const BASE: EventTurfConfig = {
  mode: 'live',
  testerFlag: 'e-turf',
  supply: [{ from: new Date('2026-11-01T00:00:00Z'), perHour: 5, cap: 50 }],
  creditedPlayers: [{ from: new Date('2026-11-01T00:00:00Z'), players: 25 }],
  renderLimit: 12,
  mapMaxEntries: 10,
};

describe('applyTurfOverride: catchUp', () => {
  it('reads dated catch-up steps from the live override', () => {
    const raw = JSON.stringify({
      catchUp: [
        { from: '2026-11-01T00:00:00Z', max: 2, min: 0.5, gap: 0.2 },
        { from: '2026-11-20T00:00:00Z', max: 4, min: 0.2, gap: 0.3 },
      ],
    });
    const { config, invalid } = applyTurfOverride(BASE, raw);
    expect(invalid).toBe(false);
    expect(config.catchUp).toEqual([
      { from: new Date('2026-11-01T00:00:00Z'), max: 2, min: 0.5, gap: 0.2 },
      { from: new Date('2026-11-20T00:00:00Z'), max: 4, min: 0.2, gap: 0.3 },
    ]);
    expect(config.supply).toBe(BASE.supply);
  });

  it.each([
    ['a max below 1', { max: 0.9, min: 0.5, gap: 0.2 }],
    ['a min above 1', { max: 2, min: 1.2, gap: 0.2 }],
    ['a zero gap', { max: 2, min: 0.5, gap: 0 }],
  ])('ignores the whole override for %s', (_, step) => {
    const raw = JSON.stringify({
      mode: 'off',
      catchUp: [{ from: '2026-11-01T00:00:00Z', ...step }],
    });
    expect(applyTurfOverride(BASE, raw)).toEqual({ config: BASE, invalid: true });
  });
});
