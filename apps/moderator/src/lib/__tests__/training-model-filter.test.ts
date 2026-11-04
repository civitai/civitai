import { describe, expect, it } from 'vitest';
import { NO_MODEL, parseModelIdFilter } from '../training-model-filter';

describe('parseModelIdFilter', () => {
  it('is not filtering only when the param is absent', () => {
    expect(parseModelIdFilter('')).toBeUndefined();
  });

  it('reads a model id', () => {
    expect(parseModelIdFilter('12345')).toBe(12345);
  });

  it.each(['abc', '12abc', '-5', '1.5', '0', '99999999999', '2147483648', ' 7'])(
    'matches no model for %j rather than falling back to the whole feed',
    (raw) => {
      expect(parseModelIdFilter(raw)).toBe(NO_MODEL);
    }
  );
});
