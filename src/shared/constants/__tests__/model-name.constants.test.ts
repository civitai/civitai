import { describe, expect, it } from 'vitest';
import { isModelNameTooLong, truncateModelName } from '~/shared/constants/model-name.constants';

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

describe('isModelNameTooLong', () => {
  it.each([
    ['a new 101-character name', 'a'.repeat(101), undefined, true],
    ['a new 100-character name', 'a'.repeat(100), undefined, false],
    ['an unchanged long name', 'a'.repeat(150), 'a'.repeat(150), false],
    [
      'a long name that differs only in stored whitespace',
      'a'.repeat(150),
      ` ${'a'.repeat(150)} `,
      false,
    ],
    ['a long name changed to another long name', 'b'.repeat(150), 'a'.repeat(150), true],
  ])('%s', (_label, name, stored, expected) => {
    expect(isModelNameTooLong(name, stored)).toBe(expected);
  });
});
