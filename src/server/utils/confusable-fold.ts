import { resolveConfusablesTransformer } from 'obscenity';
import { INVISIBLE } from '~/server/utils/invisible-chars';

const confusable = resolveConfusablesTransformer().transform;

/**
 * Just the invisible strip, for a caller that must keep case and spelling \u2014 e.g. text handed to
 * detectors that do their own normalisation. Same class as `foldConfusables` uses, so the two
 * cannot disagree about what renders as nothing.
 */
export function stripInvisible(value: string) {
  return value.replace(INVISIBLE, '');
}

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
