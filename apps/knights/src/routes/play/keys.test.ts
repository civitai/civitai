import { describe, expect, it } from 'vitest';
import { answerForKey, answerForKeyPress, keyHints } from './keys';

const options = [
  { value: '1', label: 'PG' },
  { value: '2', label: 'PG-13' },
  { value: '4', label: 'R' },
];

describe('answerForKey', () => {
  it('numbers the options in the order the question lists them', () => {
    expect(answerForKey(options, '1')).toBe('1');
    expect(answerForKey(options, '3')).toBe('4');
  });

  it('ignores keys that match no option', () => {
    expect(answerForKey(options, '4')).toBeNull();
    expect(answerForKey(options, '0')).toBeNull();
    expect(answerForKey(options, 'a')).toBeNull();
    expect(answerForKey(options, '10')).toBeNull();
  });
});

describe('keyHints', () => {
  it('pairs each key with its label', () => {
    expect(keyHints(options)).toEqual([
      { key: '1', label: 'PG' },
      { key: '2', label: 'PG-13' },
      { key: '3', label: 'R' },
    ]);
  });

  it('stops at nine, the last single key', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ value: String(i), label: `L${i}` }));
    expect(keyHints(many)).toHaveLength(9);
  });
});

describe('answerForKeyPress', () => {
  const yesNo = [
    { value: 'yes', label: 'Yes' },
    { value: 'no', label: 'No' },
  ];

  it('answers a yes/no question with 1 and 2 as well as Y and N', () => {
    expect(answerForKeyPress(yesNo, '1', true)).toBe('yes');
    expect(answerForKeyPress(yesNo, '2', true)).toBe('no');
    expect(answerForKeyPress(yesNo, 'Y', true)).toBe('yes');
    expect(answerForKeyPress(yesNo, 'n', true)).toBe('no');
    expect(answerForKeyPress(yesNo, '3', true)).toBeNull();
  });

  it('ignores letters on a rating question', () => {
    expect(answerForKeyPress(options, 'y', false)).toBeNull();
    expect(answerForKeyPress(options, '2', false)).toBe('2');
  });
});

describe('block reasons', () => {
  it('are picked with the keys 1 to 5, in the original order, and no others', async () => {
    const { BLOCK_REASONS } = await import('$lib/block-reasons');
    const reasons = [...BLOCK_REASONS];
    expect([1, 2, 3, 4, 5].map((n) => answerForKey(reasons, String(n)))).toEqual([
      'InappropriateMinors',
      'RealisticMinors',
      'DepictsRealPerson',
      'Bestiality',
      'Other',
    ]);
    expect(answerForKey(reasons, '6')).toBeNull();
  });
});
