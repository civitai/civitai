/**
 * THE BLOCK-TOKEN SUBJECT FORMAT — one spelling, for both the write side and the read
 * side, in a module with NO imports.
 *
 * A block token's `sub` is `user:<id>` for an authenticated subject and the literal
 * `anon` otherwise. That is a wire format shared by parties that must never disagree: the
 * MINT stamps it, the VERIFIER validates it, the revocation writer builds a key from it,
 * and the approval guard compares an app's owner against it. If any two of those spell it
 * differently the failure is silent in the dangerous direction — a marker that refuses
 * nobody, or an owner locked out of their own app — because every one of them is
 * individually correct and only the PAIR is wrong.
 *
 * 🔴 WHY A ZERO-IMPORT LEAF RATHER THAN A HOME IN ONE OF THE CONSUMERS. Every consumer is
 * a module some other consumer already imports, so whichever one owned this would create
 * a cycle for the rest — `block-scope.middleware` statically imports
 * `blocks/block-approval.service`, so the approval guard cannot import the parser back
 * out of the middleware. Worse, three of the candidate homes are wholesale-`vi.mock`ed
 * across the suite (`block-revocation.service` in twelve files, exporting only
 * `BlockRevocation`), so an import from there resolves to `undefined` in exactly the
 * suites that run the real guard — a green test over a broken comparison. A leaf nobody
 * mocks is the only shape that avoids both. Same reasoning, and the same shape, as
 * `block-token-lifetimes.ts`.
 *
 * 🔴 HISTORY, BECAUSE THE UNIQUENESS CLAIM HAS ALREADY BEEN FALSE ONCE.
 * `subjectForUserId` used to live in `block-revocation.service.ts` under a docblock
 * reading "THE ONE PLACE this format is written on the WRITE side". It was not: the mint
 * in `block-token.service.ts` open-coded the same template, and clawgate #571's approval
 * guard added a third. Each copy was pinned by its OWN hand-typed literal rather than to
 * the others, so the suite could not see them diverge — changing the mint's encoding
 * would have left the approval guard's tests green (they hand-type `sub: 'user:42'`
 * beside `app: { userId: 42 }`, i.e. they prove the template matches itself) while
 * production refused every owner-dev-tunnel token. Consolidating here is what makes the
 * mint and the guard produce the same string BY CONSTRUCTION rather than by coincidence,
 * which is a property no additional test could have bought.
 *
 * A new spelling of this format belongs in this file, not beside its call site.
 */

/**
 * The canonical authenticated-subject shape. Leading-zero, empty and oversized ids are
 * all rejected, so a `sub` that passes this can be compared as a STRING against
 * {@link subjectForUserId}'s output without a parse step and without numeric coercion.
 */
export const USER_SUB_RE = /^user:[1-9][0-9]{0,11}$/;

/** The literal anonymous subject. Never equal to any {@link subjectForUserId} output. */
export const ANON_SUBJECT = 'anon';

/** Every `sub` a token we signed may legitimately carry. */
export function isValidSubject(sub: string): boolean {
  return sub === ANON_SUBJECT || USER_SUB_RE.test(sub);
}

/**
 * The token `sub` a given userId mints as.
 *
 * Callers that hold a userId and want to know whether it is the token's subject should
 * compare FORWARD — `claims.sub === subjectForUserId(id)` — rather than parsing the
 * claim. `verifyBlockToken` has already run {@link isValidSubject}, so by the time any
 * guard sees `sub` it is `anon` or a canonical `user:<id>`, which makes the forward
 * comparison exactly equivalent to parsing and one step shorter.
 */
export function subjectForUserId(userId: number): string {
  return `user:${userId}`;
}
