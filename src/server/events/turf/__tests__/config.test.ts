import { describe, expect, it } from 'vitest';
import {
  applyTurfOverride,
  overrideSchema,
  type EventTurfConfig,
} from '~/server/events/turf/config';

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

describe('applyTurfOverride: drawCeiling', () => {
  it('reads the image-detail draw ceiling from the live override', () => {
    const { config, invalid } = applyTurfOverride(BASE, '{"drawCeiling":36}');
    expect(invalid).toBe(false);
    expect(config.drawCeiling).toBe(36);
    expect(config.renderLimit).toBe(BASE.renderLimit);
  });

  it.each([
    ['zero', 0],
    ['a negative', -4],
    ['a fraction', 2.5],
    ['a string', '24'],
  ])('ignores the whole override for %s ceiling', (_, drawCeiling) => {
    const raw = JSON.stringify({ mode: 'off', drawCeiling });
    expect(applyTurfOverride(BASE, raw)).toEqual({ config: BASE, invalid: true });
  });
});

describe('applyTurfOverride: sticker lifetime and team-relative credit', () => {
  const ENABLE = {
    ttlHours: 48,
    rolloutAt: '2026-11-08T12:00:00Z',
    creditedCatchUp: [{ from: '2026-11-08T12:00:00Z', max: 2, min: 0.4, gap: 0.25 }],
  };

  it('reads the lifetime, its rollout and the credit catch-up from the live override', () => {
    const { config, invalid } = applyTurfOverride(BASE, JSON.stringify(ENABLE));
    expect(invalid).toBe(false);
    expect(config).toMatchObject({
      ttlHours: 48,
      rolloutAt: new Date('2026-11-08T12:00:00Z'),
      creditedCatchUp: [{ from: new Date('2026-11-08T12:00:00Z'), max: 2, min: 0.4, gap: 0.25 }],
    });
  });

  it('reads a hand-written minute-precision rollout as :00 instead of dropping the override', () => {
    // Only the string before the Date coercion shows the padding: a bare datetime check passes
    // `12:00Z` through unchanged below zod 4.6, and rejects it from 4.6.
    expect(overrideSchema.shape.rolloutAt.unwrap().in.parse('2026-11-08T12:00Z')).toBe(
      '2026-11-08T12:00:00Z'
    );
    const raw = JSON.stringify({ ...ENABLE, rolloutAt: '2026-11-08T12:00Z' });
    const { config, invalid } = applyTurfOverride(BASE, raw);
    expect(invalid).toBe(false);
    expect(config.rolloutAt).toEqual(new Date('2026-11-08T12:00:00Z'));
  });

  it.each([
    ['a zero lifetime', { ttlHours: 0 }],
    ['a lifetime as a string', { ttlHours: '48' }],
    ['a rollout that is not a date', { rolloutAt: 'soon' }],
    // Coerced, null and 0 would be 1970: no fresh lifetime for anyone.
    ['a null rollout', { rolloutAt: null }],
    ['a rollout of 0', { rolloutAt: 0 }],
    ['a rollout of "0"', { rolloutAt: '0' }],
    ['a rollout that is only a year', { rolloutAt: '2026' }],
    // Deliberate: a lifetime with no rollout would expire every older sticker at once.
    ['a lifetime with no rollout', { rolloutAt: undefined }],
    [
      'a credit catch-up min above 1',
      { creditedCatchUp: [{ from: '2026-11-08T12:00:00Z', max: 2, min: 1.5, gap: 0.25 }] },
    ],
  ])('ignores the whole override for %s', (_, bad) => {
    const raw = JSON.stringify({ ...ENABLE, mode: 'off', ...bad });
    expect(applyTurfOverride(BASE, raw)).toEqual({ config: BASE, invalid: true });
  });
});
