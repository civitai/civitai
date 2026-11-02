import { describe, expect, it } from 'vitest';
import { truncateModelName } from '~/shared/constants/model-name.constants';

describe('truncateModelName', () => {
  it('leaves a name of 150 characters or fewer alone', () => {
    expect(truncateModelName('a'.repeat(150))).toBe('a'.repeat(150));
  });

  it('cuts a longer name to 150 characters', () => {
    expect(truncateModelName('a'.repeat(200))).toBe('a'.repeat(150));
  });

  it('drops whitespace left at the cut', () => {
    expect(truncateModelName(`${'a'.repeat(149)} - version`)).toBe('a'.repeat(149));
  });
});
