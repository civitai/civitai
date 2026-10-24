// Compiles one blocklist term into the regex that matches it.
//
// This lives beside the lists because it is part of what a term MEANS: the string an
// author writes is not the pattern that runs. Writing `young girl` matches
// `young-girl` and `young,,,girl`; writing `loli` also matches `l0l1`; and writing a
// `[` anywhere turns leet folding off for the whole entry. An author cannot predict
// any of that from the term alone, so the transform and the vocabulary have to be
// read together.
//
// Two other places apply the same idea and must NOT be folded in here:
//   - `src/shared/utils/benign-phrases.ts` deliberately SHADOWS this, because the
//     strip has to match whatever the detector matches; its separator must stay `+`.
//   - `src/utils/metadata/__tests__/audit-matching-equivalence.test.ts` is a
//     brute-force ORACLE. Pointing it at this function would make it vacuous.
// And one has already drifted: `src/server/utils/moderation-utils.ts` folds
// `a -> [a|@]` as well, which nothing here does.

/**
 * 🔴 `leet` folding is skipped for any term containing `[`, so a carve-out written with
 * a character class silently loses leet coverage for the WHOLE entry. The `tee+n`
 * carve-out in `words-young.json` is bracket-free for that reason.
 *
 * 🔴 A lookahead at the START of a term can only test the start of the word, because the
 * boundary is `(?<![a-zA-Z0-9])`: `(?!eighteen)\w*tee+n\w*` excludes "eighteen" but
 * still matches "xeighteen". Inline (`\w*tee+n(?!...)`) excludes both. Converting
 * between the two forms is a behaviour change, not a refactor.
 */
export function prepareWordRegexBody(word: string, pluralize = false, leet = true) {
  let regexStr = word;
  // A literal space becomes "any run of non-alphanumerics", so a multi-word term
  // survives the punctuation people actually type between tags.
  regexStr = regexStr.replace(/\s+/g, `[^a-zA-Z0-9]+`);
  if (leet && !word.includes('[')) {
    regexStr = regexStr
      .replace(/i/g, '[i|l|1]')
      .replace(/o/g, '[o|0]')
      .replace(/s/g, '[s|z]')
      .replace(/e/g, '[e|3]');
  }
  if (pluralize) regexStr += '[s|z]*';
  return regexStr;
}

/**
 * 🔴 Zero-width boundaries, never consuming `[^a-zA-Z0-9]+` runs. The consuming form
 * backtracks O(n²) over a long non-Latin prompt — one giant non-alnum run — which
 * pinned the API event loop for seconds and was user-triggerable (#2722, #2727). The
 * lookaround is boolean-equivalent and has nothing to backtrack over.
 */
export function prepareWordRegex(word: string, pluralize = false, leet = true) {
  const body = prepareWordRegexBody(word, pluralize, leet);
  return new RegExp(`(?<![a-zA-Z0-9])` + body + `(?![a-zA-Z0-9])`, 'i');
}
