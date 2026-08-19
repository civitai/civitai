// Client-safe half of the moderator benign-phrase machinery. The server copy lives in
// `blocklist.service`, which pulls in Prisma and Redis and therefore cannot be imported
// from a component — the search gates run in the browser, so the matcher has to live here.

const escapeRegex = (str: string) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Compile a moderator-managed phrase list into a single whole-word, case-insensitive
// matcher. Whitespace in a phrase is loosened to `[^a-zA-Z0-9]+` so "teen titans" also matches
// "teen  titans" / "teen-titans" / "teen.titans". Zero-width alnum boundaries (matching
// audit.ts) instead of a word boundary so a phrase whose edge is punctuation still anchors. Returns null
// for an empty list so callers can skip the replace.
//
// 🔴 The separator MUST stay `+`, identical to `prepareWordRegex` in audit-base.ts. This
// matcher exists to shadow that one, and any divergence breaks the whitelist in whichever
// direction the detector is more permissive. A `{1,3}` bound was tried here and reverted: the
// detector matched "emma,,,, stone" while the strip did not, so a whitelisted phrase went
// back to tripping the gate on ordinary prompt punctuation — the exact bug this PR fixes.
//
// The bound was added on the reasoning that unbounded strips more, which is the right instinct
// on a whitelist and the wrong conclusion here: `[^a-zA-Z0-9]+` cannot cross an alphanumeric
// character, so it can only ever consume punctuation and whitespace, never a word the next
// check needed to read. If a bound is ever genuinely wanted, derive it from audit-base.ts
// rather than restating a number, and pin the two matchers agreeing at the boundary.
export function buildBenignPhraseRegex(phrases: string[]): RegExp | null {
  const cleaned = phrases.map((p) => p.trim()).filter((p) => p.length > 0);
  if (!cleaned.length) return null;
  const alternation = cleaned.map((p) => escapeRegex(p).replace(/\s+/g, '[^a-zA-Z0-9]+')).join('|');
  return new RegExp(`(?<![a-zA-Z0-9])(?:${alternation})(?![a-zA-Z0-9])`, 'gi');
}

/** Synchronous counterpart to the server's `stripBenignPhrases`, for an already-fetched list. */
export function stripBenignPhrasesWith(text: string | undefined, pattern: RegExp | null) {
  if (!text || !pattern) return text ?? '';
  return text.replace(pattern, ' ');
}
