import { describe, expect, it } from 'vitest';
import { evaluateTextScan, highestNsfwLevel } from '~/server/services/text-scan/evaluate';
import type { NsfwLevelName } from '~/server/services/text-scan/types';

const nsfw = (level: NsfwLevelName) => ({ nsfw: { level, reason: 'r' } });

describe('highestNsfwLevel', () => {
  it.each([
    [null, 0],
    [undefined, 0],
    [0, 0],
    [1, 1],
    [4, 4],
    [5, 4], // PG | R
    [31, 16],
  ])('%s -> %s', (input, expected) => expect(highestNsfwLevel(input)).toBe(expected));
});

describe('evaluateTextScan — nsfw', () => {
  // declared (highest bit) × detected → raised
  it.each([
    [0, 'none', false],
    [0, 'pg13', true],
    [1, 'none', false],
    [1, 'r', true],
    [4, 'r', false],
    [4, 'pg13', false],
    [4, 'x', true],
    [5, 'x', true],
    [5, 'r', false],
    [16, 'xxx', false],
    [8, 'xxx', true],
  ] as const)('declared %s, detected %s -> raised %s', (declared, level, raised) => {
    const outcome = evaluateTextScan(nsfw(level), { nsfwLevel: declared }, ['nsfw']);
    expect(outcome.nsfw?.raised).toBe(raised);
    expect(outcome.triggeredLabels.includes('nsfw')).toBe(raised);
  });

  it('stores the detected level even when not raised', () => {
    const outcome = evaluateTextScan(nsfw('r'), { nsfwLevel: 8 }, ['nsfw']);
    expect(outcome.nsfwLevel).toBe(4);
    expect(outcome.nsfw).toMatchObject({ detectedLevel: 4, declaredLevel: 8, raised: false });
  });

  it('nsfwLevel is null when nsfw was not requested', () => {
    const outcome = evaluateTextScan({ scam: { detected: false, reason: 'r' } }, {}, ['scam']);
    expect(outcome.nsfwLevel).toBeNull();
  });
});

describe('evaluateTextScan — flag labels', () => {
  it.each([
    [false, false, false, false],
    [false, true, true, true],
    [true, true, true, false],
    [true, false, false, false],
  ])(
    'poi declared %s detected %s -> triggered %s newly %s',
    (declared, detected, triggered, newly) => {
      const outcome = evaluateTextScan(
        { poi: { detected, names: detected ? ['A'] : [], reason: 'r' } },
        { poi: declared },
        ['poi']
      );
      expect(outcome.triggeredLabels.includes('poi')).toBe(triggered);
      expect(outcome.poi).toMatchObject({ detected, declared, newlyDetected: newly });
    }
  );

  it('carries poi names', () => {
    const outcome = evaluateTextScan(
      { poi: { detected: true, names: ['A', 'B'], reason: 'r' } },
      {},
      ['poi']
    );
    expect(outcome.poi?.names).toEqual(['A', 'B']);
  });

  it('minor and scam trigger on detected', () => {
    const outcome = evaluateTextScan(
      { minor: { detected: true, reason: 'r' }, scam: { detected: true, reason: 's' } },
      {},
      ['minor', 'scam']
    );
    expect(outcome.triggeredLabels).toEqual(['minor', 'scam']);
    expect(outcome.scam).toEqual({ detected: true, reason: 's' });
  });

  it('ignores output for labels that were not requested', () => {
    const outcome = evaluateTextScan({ scam: { detected: true, reason: 's' } }, {}, ['nsfw']);
    expect(outcome.scam).toBeUndefined();
    expect(outcome.triggeredLabels).toEqual([]);
  });
});
