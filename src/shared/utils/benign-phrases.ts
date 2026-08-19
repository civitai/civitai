// Client-safe half of the moderator benign-phrase machinery. The server copy lives in
// `blocklist.service`, which pulls in Prisma and Redis and therefore cannot be imported
// from a component — the search gates run in the browser, so the matcher has to live here.

const escapeRegex = (str: string) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Compile a moderator-managed phrase list into a single whole-word, case-insensitive
// matcher. Whitespace in a phrase is loosened to `[^a-zA-Z0-9]+` so "teen titans" also matches
// "teen  titans" / "teen-titans" / "teen.titans". Zero-width alnum boundaries (matching
// audit.ts) instead of a word boundary, so a phrase whose edge is punctuation still anchors.
// Returns null for an empty list so callers can skip the replace.
//
// 🔴 The separator MUST stay `+`, identical to `prepareWordRegex` in audit-base.ts. This
// matcher exists to shadow that one, and any divergence breaks the whitelist in whichever
// direction the detector is more permissive. A `{1,3}` bound was tried here and reverted: the
// detector matched "emma,,,, stone" while the strip did not, so a whitelisted phrase went
// back to tripping the gate on ordinary prompt punctuation — the exact bug this PR fixes.
//
// The bound was added on the reasoning that unbounded strips more. That instinct is the right
// one to carry on a whitelist, but it has to yield to shadowing — and note what the class is
// NOT: `[^a-zA-Z0-9]` excludes only ASCII alphanumerics, so it happily consumes non-ASCII
// LETTERS. This separator can therefore swallow text that reads as a word.
//
// 🔴 What keeps that NARROW — not closed — is that callers strip the NORMALIZED copy:
// `normalizeText` folds accented Latin to ASCII, and those letters then break the separator
// run themselves. Load-bearing, not tidiness. Move a strip back ahead of `normalizeText` and
// every accented spelling of every detection term becomes swallowable, which is a far larger
// surface than what remains. What remains is scripts NFD cannot fold (CJK, Cyrillic, Greek,
// …), reproduced against the real lists — private note has the input and the counts.
//
// If a bound is ever genuinely wanted, derive it from audit-base.ts rather than restating a
// number, and pin the two matchers agreeing at the boundary.
export function buildBenignPhraseRegex(phrases: string[]): RegExp | null {
  const cleaned = phrases.map((p) => p.trim()).filter((p) => p.length > 0);
  if (!cleaned.length) return null;
  // The separator is CAPTURED so the strip can inspect what it matched — see
  // `stripBenignPhrasesWith`. Capturing changes nothing about what the pattern matches, which
  // is what keeps it identical to `prepareWordRegex`.
  const alternation = cleaned
    .map((p) => escapeRegex(p).replace(/\s+/g, '([^a-zA-Z0-9]+)'))
    .join('|');
  return new RegExp(`(?<![a-zA-Z0-9])(?:${alternation})(?![a-zA-Z0-9])`, 'gi');
}

/**
 * Anything a detection list could hold, not letters specifically. `\p{L}` alone was tried and
 * misses 9 of the 54 entries that survive normalization across the lists — all emoji, which
 * carry no letter. Those are unreachable today only because `auditMetaData` picks that list on
 * `nsfw === false` while every caller passing a stripped prompt sits inside `if (nsfw && …)` —
 * a coincidence between two files that do not reference each other, which either side can
 * close without noticing. `\p{N}` and pictographics cost nothing and make the predicate about
 * CONTENT rather than about letters, which is the property that survives someone adding a new
 * kind of entry to a list.
 *
 * Measured: covers all 54 survivors, and refuses none of the ordinary gaps — including em-dash
 * and ideographic comma, which a "whitespace or ASCII punctuation only" formulation would have
 * wrongly refused, handing back a false positive on `emma—stone`.
 */
const GAP_CONTENT = /[\p{L}\p{N}\p{Extended_Pictographic}]/u;

/**
 * Blank whitelisted phrases, REFUSING any occurrence whose inter-word gap holds content.
 *
 * 🔴 This is the guard that stops a swallow flipping a moderation gate. `[^a-zA-Z0-9]` excludes
 * only ASCII alphanumerics, so anything non-ASCII a detection list holds — letters, digits,
 * emoji — is content to the detector and a separator to this pattern. That matters more than
 * "one term hidden": the nsfw word list GATES the POI and minor sub-checks (`audit.ts` —
 * `if (!nsfw && !includesNsfw(...)) return false`, and every search caller passes no `nsfw`
 * argument), so swallowing the only nsfw signal in an input stops those sub-checks running.
 *
 * Refusing after the match rather than bounding the separator is deliberate: a bound made this
 * matcher disagree with `prepareWordRegex` and handed back the false positives on ordinary
 * punctuation (`emma,,,, stone`). This leaves the pattern identical and only declines an
 * occurrence whose gap holds content — a gap of punctuation or whitespace, which is every
 * ordinary case, still strips.
 */
export function stripBenignPhrasesWith(text: string | undefined, pattern: RegExp | null) {
  if (!text || !pattern) return text ?? '';
  return text.replace(pattern, (...args: unknown[]) => {
    const match = args[0] as string;
    // Drop the trailing `offset` and `whole string` arguments; the rest are the captured gaps.
    const gaps = args.slice(1, -2) as (string | undefined)[];
    const gapHoldsContent = gaps.some((gap) => typeof gap === 'string' && GAP_CONTENT.test(gap));
    return gapHoldsContent ? match : ' ';
  });
}
