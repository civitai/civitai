/**
 * Shared primitives for SOURCE-TEXT structural guards over a tRPC router.
 *
 * Several `no-*.test.ts` guards answer the same two questions about
 * `blocks.router.ts` — "which declaration encloses this offset?" and "does THAT
 * declaration's body contain X?" — because the call sites they police live
 * inside a ~9,000-line router whose handlers cannot be invoked without the whole
 * orchestrator + auth stack. Each had rolled its own copy.
 *
 * 🔴 THE COPIES WERE NOT MERELY UNTIDY — THEY MADE A GUARD'S OWN CLAIM FALSE.
 * `no-direct-block-budget-claim-read.test.ts` states that its split "is the same
 * discriminator `no-divergent-author-fee-base.test.ts` ledgers each site's role
 * with, so a quote that moved between them is red in BOTH files". Two
 * independent regexes cannot support that sentence: the first person to fix one
 * leaves the other wrong, and the two guards then disagree about which paths
 * exist while both stay green. One module, one discriminator, one fix site.
 *
 * NOT a `.test.ts` file and not under a guard directory, so it is collected by no
 * project and counted by no ratchet — `no-lint-rules-script-drift` enumerates
 * `src/server/services/__tests__/no-*.test.ts`, which this is not, and neither
 * guard file moves.
 */

/**
 * THE MONEY PRIMITIVES a router region may contain — the complete set of calls
 * that move or commit a viewer's Buzz on the App Blocks generation paths.
 *
 * 🔴 IT IS THE *RESERVATION* PRIMITIVES THAT MAKE THIS LIST A GUARD RATHER THAN A
 * GESTURE, AND THEY WERE MISSING. The list carried only `chargeBlockAuthorFee(`
 * and `reserveAppSpend(`, so a mutant inserting
 * `await reserveBlockBuzzSpendForClaims(claims, userId, 999);` into the
 * DISCLOSING `estimateStepWorkflow` region SURVIVED the whole battery — 821/821
 * green, with the test literally named "a DISCLOSING quote reserves nothing and
 * charges nothing" reporting ✓. `reserveDevSessionBuzz(` survived identically.
 * A guard whose name says "reserves nothing" while its body knows only two of
 * four reservation primitives reads as coverage and provides none.
 *
 * The list is the one the divergence ledger already names as the three
 * reservations the folded fee must be taken with, plus the charge. Both guards
 * that classify a quote site read it from HERE so the two cannot drift: a
 * primitive added to one copy and not the other is exactly how a region check
 * goes quietly blind.
 *
 * ⚠️ IT DESCRIBES WHAT A ROUTER REGION CAN CONTAIN, NOT EVERY WAY MONEY MOVES.
 * `accrueBlockAuthorFee` is deliberately absent: it is called by
 * `chargeBlockAuthorFee` INSIDE the service, so no router region can contain it
 * and a marker for it would assert something this corpus cannot see.
 */
export const MONEY_MARKERS = [
  'chargeBlockAuthorFee(',
  'reserveAppSpend(',
  'reserveBlockBuzzSpendForClaims(',
  'reserveDevSessionBuzz(',
] as const;

export type QuoteRole = 'reserving' | 'disclosing';

/** Which of the money primitives `region` actually contains, in list order. */
export function moneyMarkersIn(region: string): string[] {
  return MONEY_MARKERS.filter((marker) => region.includes(marker));
}

/**
 * The role a region's own CONTENT implies — `'reserving'` when it contains every
 * money primitive, `'disclosing'` when it contains none, and `null` when it is
 * MIXED and therefore classifies as neither.
 *
 * 🔴 THIS IS THE STRUCTURAL ANSWER, AND IT EXISTS BECAUSE THE OTHER ONE WAS
 * SPELLED. `no-direct-block-budget-claim-read.test.ts` split the same population
 * with `owner.startsWith('submit')` / `'estimate'` — a classification by what a
 * function is CALLED. A reserving quote grown inside any `estimate*`-named
 * function is then scored DISCLOSING and silently dropped from the comparison it
 * was supposed to be on one side of; the guard's "neither bucket" assertion
 * catches a name matching no prefix, never a name matching the WRONG one. What a
 * path does is readable from the path; asking its name instead is a guess that
 * an attacker, or an ordinary refactor, controls.
 *
 * `null` (mixed) is a REAL answer and callers must fail on it rather than
 * defaulting: a region holding one reservation and no charge is neither a quote
 * that moves money correctly nor one that moves none.
 */
export function structuralQuoteRole(region: string): QuoteRole | null {
  const found = moneyMarkersIn(region).length;
  if (found === MONEY_MARKERS.length) return 'reserving';
  if (found === 0) return 'disclosing';
  return null;
}

/**
 * A declaration this walk recognises: a module-level `async function name(` or a
 * two-space-indented `  name: <anything>Procedure`.
 *
 * 🔴 `\w+Procedure`, NOT `(?:public|protected)Procedure`. `blocks.router.ts` also
 * declares `moderatorProcedure` and `appDeveloperProcedure` handlers — measured,
 * 147 of 189 two-space keys were uncaptured by the narrow form — so an offset
 * inside one of those resolved to the PREVIOUS public/protected procedure and a
 * region swallowed every declaration up to the next one it happened to know.
 * That silently attributes a call site to a path it is not in, which is the one
 * failure mode a structural ledger cannot survive.
 */
const DECL = /^(?:async function (\w+)\(| {2}(\w+): \w+Procedure)/gm;

export type SourceDecl = { name: string; at: number };

/** Every declaration in `source`, in file order, with its offset. */
export function sourceDecls(source: string): SourceDecl[] {
  DECL.lastIndex = 0;
  const decls: SourceDecl[] = [];
  for (;;) {
    const m = DECL.exec(source);
    if (!m) break;
    decls.push({ name: m[1] ?? m[2], at: m.index });
  }
  return decls;
}

/** The nearest declaration enclosing `offset`, or `'<module scope>'`. */
export function enclosingDecl(source: string, offset: number): string {
  let name = '<module scope>';
  for (const d of sourceDecls(source)) {
    if (d.at >= offset) break;
    name = d.name;
  }
  return name;
}

/**
 * `source` sliced into one region per declaration, keyed by name. A region runs
 * from its own declaration to the next, so "does THIS path reserve / charge?" is
 * answerable by substring instead of by eye.
 */
export function declRegions(source: string): Map<string, string> {
  const decls = sourceDecls(source);
  const regions = new Map<string, string>();
  decls.forEach((d, i) => {
    regions.set(d.name, source.slice(d.at, decls[i + 1]?.at ?? source.length));
  });
  return regions;
}

/**
 * Blank every comment, preserving byte offsets and newlines so an offset-keyed
 * walk over the result still lines up with the original.
 *
 * 🔴 A STRUCTURAL GUARD THAT READS RAW SOURCE IS WALKABLE BY A COMMENT, IN BOTH
 * DIRECTIONS, AND BOTH WERE DEMONSTRATED ON THIS ROUTER:
 *   · FAIL-OPEN — commenting a call out (`// await chargeBlockAuthorFee({`)
 *     leaves every guard that looks for it GREEN, while the fee is still quoted,
 *     still folded into the reservation and still shown to the viewer, and is
 *     never debited or accrued. Four guards naming that exact property survived
 *     it, including an `await`-adjacency check whose 6-byte lookbehind matches
 *     `// await ` just as well as `await `.
 *   · FAIL-CLOSED — prose in a docblock that merely MENTIONS `chargeBlockAuthorFee(`
 *     turns a region check red with no behaviour change at all. The router's own
 *     new docblocks discuss these functions by name inside the estimate regions.
 *
 * A backslash always consumes the next character in every context, so an escaped
 * slash inside a regex literal cannot be mistaken for a line comment — the
 * fail-OPEN direction, handled rather than assumed. String literals are skipped
 * whole so a `//` inside a URL is not treated as a comment.
 *
 * 🔴 CALLERS MUST STILL ASSERT A POSITIVE CONTROL. A stripper that ate real code
 * would make every guard vacuously green, so each consumer re-asserts that the
 * call sites it governs are still FOUND after stripping.
 */
export function blankComments(source: string): string {
  const out = source.split('');
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let j = from; j < to && j < out.length; j += 1) {
      if (out[j] !== '\n') out[j] = ' ';
    }
  };
  while (i < source.length) {
    const c = source[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      i += 1;
      while (i < source.length) {
        if (source[i] === '\\') i += 2;
        else if (source[i] === quote) {
          i += 1;
          break;
        } else i += 1;
      }
      continue;
    }
    if (c === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i);
      blank(i, end === -1 ? source.length : end);
      i = end === -1 ? source.length : end;
      continue;
    }
    if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    i += 1;
  }
  return out.join('');
}
