import { describe, expect, it } from 'vitest';
import { removalWeight } from '~/shared/utils/creator-removal-weights';

describe('removalWeight', () => {
  it.each([
    ['realPerson', 1],
    ['minorViolence', 1],
    ['hate', 1],
    ['fecalMatter', 0.5],
    ['non-ai', 0.5],
    ['spam', 0.5],
    ['other', 0],
  ])('weighs %s as %s', (reason, weight) => {
    expect(removalWeight(reason)).toBe(weight);
  });

  it.each([
    null,
    undefined,
    '',
    '  ',
    'manual',
    'tag',
    'newUser',
    'minor',
    'csam',
    'poi',
    'free text',
  ])('charges the full penalty for the unrecognised reason %j', (reason) => {
    expect(removalWeight(reason)).toBe(1);
  });

  it('does not read Object.prototype members as violation types', () => {
    expect(removalWeight('constructor')).toBe(1);
    expect(removalWeight('toString')).toBe(1);
  });
});
