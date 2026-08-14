/**
 * Strip comments and string literals from TypeScript source, so a STRUCTURAL scan over
 * raw file text cannot be satisfied by PROSE.
 *
 * 🔴 WHY THIS IS A SHARED MODULE RATHER THAN A TECHNIQUE COPIED TWICE. It started as a
 * private helper inside `app-access.call-site-ledger.test.ts`, whose header says in as
 * many words that "there is a LOT of prose about ownership in this codebase, and only
 * real code should count as a gate site". Thirty files away, `app-collaborators.
 * client-seam.test.ts` scanned raw text and did NOT strip anything — so a proc counted as
 * WIRED because its name appeared in a JSDoc block. The rule existed and was simply not
 * applied at the second site, which is what a duplicated technique always eventually
 * looks like. One module, both callers.
 *
 * 🔴 STRINGS ARE STRIPPED TOO, which the ledger's original did not do. A scan that only
 * removed comments would still be satisfiable by `const doc = 'trpc.appCollaborators.
 * getAppEarnings'` — the same class of false positive one syntax over. A real call is
 * never inside a string literal, so nothing legitimate is lost.
 *
 * ORDER IS LOAD-BEARING: comments come out FIRST. Prose is full of apostrophes
 * (`the app's`), so stripping strings first would treat a comment's apostrophe as an
 * opening quote and eat live code up to the next one.
 *
 * This is a lexical approximation, not a parser. It is deliberately biased toward
 * REMOVING too much: over-stripping makes a real call invisible and turns the guard RED,
 * which is the safe direction and is caught immediately by the positive controls each
 * caller is required to carry. Under-stripping is the direction that produces a silent
 * vacuous pass.
 */
export function stripCommentsAndStrings(source: string): string {
  return (
    source
      // Block comments (incl. JSDoc). Non-greedy so adjacent blocks stay separate.
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      // Line comments. The `[^:]` guard is the ledger's, and it is there so a `://` inside
      // a URL is not treated as the start of a comment.
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
      // Template literals (may span lines; an interpolation is stripped with them).
      .replace(/`(?:[^`\\]|\\[\s\S])*`/g, ' ')
      // Single- and double-quoted strings. `\n` is excluded so an unterminated quote
      // cannot swallow the rest of the file.
      .replace(/'(?:[^'\\\n]|\\.)*'/g, ' ')
      .replace(/"(?:[^"\\\n]|\\.)*"/g, ' ')
  );
}
