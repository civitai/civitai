import { includesInappropriate as modUtilsIncludesInappropriate } from '@civitai/mod-utils/prompt-audit';
import { describe, expect, it } from 'vitest';
import { includesInappropriate, includesMinorAge } from '~/utils/metadata/audit';

// An ordinal birthday is not a stated age of the subject ("her 4th birthday party" can be a
// grown woman's photo of her daughter's party), so it is not an age phrase.
// Both audit engines read the shared template list; each is checked.
const engines = [
  ['site audit', (prompt: string) => includesInappropriate({ prompt }, true)],
  ['mod-utils audit', (prompt: string) => modUtilsIncludesInappropriate({ prompt }, true)],
] as const;

describe.each(engines)('%s', (_name, audit) => {
  it.each(['her 4th birthday party', 'an eighth birthday cake'])(
    'an ordinal birthday alone is not an age: %s',
    (prompt) => {
      expect(audit(prompt)).toBe(false);
    }
  );

  it.each(['her 4 year old birthday party', 'an eight years old birthday cake'])(
    'an explicit age in the same prompt still is: %s',
    (prompt) => {
      expect(audit(prompt)).toBe('minor');
    }
  );
});

describe('includesMinorAge', () => {
  it('ignores an ordinal birthday and still reads a stated age beside it', () => {
    expect(includesMinorAge('her 4th birthday party')).toMatchObject({ found: false });
    expect(includesMinorAge('her 4 year old birthday party')).toMatchObject({
      found: true,
      age: 4,
    });
  });
});
