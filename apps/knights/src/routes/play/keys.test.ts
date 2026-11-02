import { describe, expect, it } from 'vitest';
import { answerForKey, keyHints } from './keys';

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
