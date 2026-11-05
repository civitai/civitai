import { describe, expect, it } from 'vitest';
import { isComSafeLevel } from '../com-face';

describe('isComSafeLevel', () => {
  it('takes PG and PG-13 only: unrated and R or above are not what civitai.com shows', () => {
    expect([0, 1, 2, 4, 8, 16].map(isComSafeLevel)).toEqual([
      false,
      true,
      true,
      false,
      false,
      false,
    ]);
  });
});
