import { describe, expect, it } from 'vitest';
import { truncateModelName } from '~/shared/constants/model-name.constants';

describe('truncateModelName', () => {
  it('leaves a name of 100 characters or fewer alone', () => {
    expect(truncateModelName('a'.repeat(100))).toBe('a'.repeat(100));
  });

  it('cuts a longer name to 100 characters', () => {
    expect(truncateModelName('a'.repeat(150))).toBe('a'.repeat(100));
  });

  it('drops whitespace left at the cut', () => {
    expect(truncateModelName(`${'a'.repeat(99)} - version`)).toBe('a'.repeat(99));
  });
});
