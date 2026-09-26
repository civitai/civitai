import { describe, expect, it } from 'vitest';
import { includesInappropriate } from '~/utils/metadata/audit';

// The `baby` youth noun carried a stray space — `\w*ba+b+ y(?!d[o0]ll)\w*` — and
// `prepareWordRegexBody` turns a literal space into `[^a-zA-Z0-9]+`, so the rule required
// a separator between "bab" and "y" and never fired on "baby" at all. Its `babydoll`
// carve-out was dead code for the same reason.
//
// Removing the space makes the rule live, which is a blocking INCREASE on a common word,
// so the carve-outs are what keep it usable: `babydoll` is lingerie, `baby blue` is a
// colour, `babylon` is a place, and a `babysitter` is an adult. None names a child.
//
// The separator class is bounded (`{0,3}`) and matches the audit's own age templates —
// an unbounded one here is the ReDoS shape #2722/#2727 were about.
describe('the baby youth noun fires, and its carve-outs hold', () => {
  it.each(['baby, nude', 'a baby girl, nude', 'babies, nude', 'babyface, nude', 'cute baby, nude'])(
    'blocks %s',
    (prompt) => {
      expect(includesInappropriate({ prompt })).toBe('minor');
    }
  );

  it.each([
    // lingerie, joined and spaced
    'babydoll lingerie, nude adult woman',
    'baby doll lingerie, nude adult woman',
    'babydolls, nude adult woman',
    // a colour, joined and spaced
    'babyblue, nude adult woman',
    'baby blue dress, nude adult woman',
    // a place
    'babylon ruins, nude adult woman',
    // an adult profession — joined, spaced, inflected, and inside a LoRA filename
    'babysitter, nude adult woman',
    'baby sitter, nude adult woman',
    'babysitting, nude adult woman',
    'luanababysitter, nude adult woman',
  ])('does not block %s', (prompt) => {
    expect(includesInappropriate({ prompt })).toBe(false);
  });
});
