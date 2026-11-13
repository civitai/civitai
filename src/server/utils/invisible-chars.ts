/**
 * Characters that render as nothing but sit between two letters. A zero-width space inside a
 * blocked domain is invisible to the reader and defeats a substring match, and unlike the
 * lookalikes `foldConfusables` handles no case or normalisation step removes it.
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
export const INVISIBLE =
  /[\p{Cf}\u034F\u115F\u1160\u17B4\u17B5\u180B-\u180D\u3164\uFE00-\uFE0F\uFFA0\u{E0100}-\u{E01EF}]/gu;
