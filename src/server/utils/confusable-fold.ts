import { resolveConfusablesTransformer } from 'obscenity';

const confusable = resolveConfusablesTransformer().transform;

/**
 * Characters that render as nothing but sit between two letters. A zero-width space inside a
 * blocked domain is invisible to the reader and defeats a substring match, and unlike the
 * lookalikes below no case or normalisation step removes it.
 *
 * `\p{Cf}` rather than a hand-written list, because a hand-written list is a normaliser with a
 * hole in it and the hole is invisible: an earlier enumeration here missed the Unicode tag block
 * (`U+E0020`-`U+E007F`), the musical format controls and 143 others, every one of them invisible
 * and legal between two letters. The explicit additions are the invisibles that are NOT `Cf` —
 * Hangul fillers (`Lo`), the combining grapheme joiner and BOTH variation selector blocks — the
 * supplement at `U+E0100`-`U+E01EF` is `Mn` too, and is the same bypass one block over from the
 * tag characters. Verified a strict superset of what it replaced over every non-surrogate code
 * point.
 *
 * Written as escapes on purpose: spelled literally, this class is a run of characters that
 * renders as an empty pair of brackets, and nobody can review or edit it.
 */
const INVISIBLE =
  /[\p{Cf}\u034F\u115F\u1160\u17B4\u17B5\u180B-\u180D\u3164\uFE00-\uFE0F\uFFA0\u{E0100}-\u{E01EF}]/gu;

/**
 * Text as a blocklist should see it: one spelling per glyph, whatever alphabet it was typed in.
 *
 * 19 of the 90 live `MessagePattern` entries are non-ASCII, and several are Unicode skins of an
 * entry that is ALSO on the list in ASCII. Moderators were adding one row per alphabet by hand
 * because the matcher compared raw code points.
 *
 * Three steps, because each covers a class the others miss (measured over 8 samples drawn from
 * the live list):
 *
 * - NFKC folds the mathematical alphanumerics and the fullwidth forms. Obscenity's map leaves
 *   two characters of the bold-math sample behind on its own.
 * - The invisible strip covers zero-width and bidi characters, which survive both other steps.
 * - Obscenity's confusables map folds the small-caps block and the Cyrillic/Greek lookalikes,
 *   which NFKC deliberately does not touch — they are distinct letters, not compatibility forms.
 *
 * **Fold both sides.** Folding only the content leaves those 19 entries unmatchable, which is
 * worse than not folding at all: the guard would look stronger and enforce less.
 */
export function foldConfusables(value: string) {
  const pre = value.normalize('NFKC').replace(INVISIBLE, '');

  let out = '';
  for (const char of pre) {
    const folded = confusable(char.codePointAt(0) as number);
    if (folded !== undefined) out += String.fromCodePoint(folded);
  }

  return out.toLowerCase();
}
