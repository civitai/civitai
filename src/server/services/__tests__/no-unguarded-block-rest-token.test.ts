import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * The REST counterpart of `no-unguarded-block-bridge-token.test.ts`.
 *
 * `withBlockScope` is the ONE place a Next.js page route may authenticate a block JWT,
 * and since the approved-status gate landed it is also the one place the "is this app
 * still allowed to run" decision is taken for the REST surface. Two regressions would
 * undo that, and neither is something a type can catch:
 *
 *   1. A NEW block REST route that verifies a token ITSELF instead of being wrapped.
 *      That is exactly the shape the bridge bug had — thirteen procedures each calling
 *      `verifyBlockToken` directly and checking nothing else — and a route written by
 *      copying an existing one's *body* rather than its *export* lands there naturally.
 *   2. An EXISTING route quietly exporting its bare `baseHandler`. Eight of the thirteen
 *      routes export `baseHandler` separately for their own unit tests, so the
 *      unwrapped value is right there, in scope, one word away from the export.
 *
 * A THIRD regression lives at the bottom of this file rather than here, because it is
 * about the PREDICATE and not about the wrapper: a second open-coded copy of the
 * approval check appearing somewhere else in the tree. See
 * `the approval predicate is not open-coded a second time`.
 *
 * WHAT THIS FILE IS NOT. It does not verify that the gate WORKS — that is
 * `block-scope.approved-gate.test.ts` (the predicate and its verdicts, including the one
 * that is counted and SERVED rather than refused) and `suspended-app-rest-refusal.test.ts`
 * (two real routes, a real JWT, a suspended app, and the money/write call that must not
 * happen). Read those if you are asking whether a suspended app is refused. This file only
 * pins POPULATIONS and RELATIONSHIPS, and it is written that way on purpose: a structural
 * check that claims behavioural coverage is worse than none, because it stops anyone looking.
 *
 * A RELATIONSHIP, NOT A COUNT, in both ledgers below:
 *
 *   `REST_ROUTE_RATIONALE` — every wrapped route, each with a one-line statement of what
 *     it reaches. The KEY SET must equal the DERIVED set, in both directions, so a new
 *     `withBlockScope` route cannot be added without its author writing down what a
 *     suspended app would otherwise have been able to do through it. That sentence is
 *     the point of the ledger; the test cannot check that it is TRUE, only that someone
 *     had to write one.
 *
 *   `wraps its default export` — the derived population is routes that MENTION
 *     `withBlockScope`; the relationship asserted is that each one's `export default` is
 *     a `withBlockScope(` call. Those are different sets by construction, which is what
 *     makes the check non-vacuous: a route can import the wrapper and still export the
 *     bare handler, and that is the second regression above.
 *
 * 🔴 KNOWN LIMITS, stated because they are open:
 *   - Text, not a call graph. A route that reaches a block token through an imported
 *     helper which verifies it there is invisible here (the bridge file has the same
 *     limit, for the same reason: the alternative is importing the server graph).
 *   - `export default withBlockScope(...)` is matched as a call at the export site. A
 *     route that assigned the wrapped value to a const first and exported the const
 *     would read as UNWRAPPED and fail. That is the fail-closed direction, and no route
 *     is written that way today.
 *   - The population is Next PAGE routes under `src/pages/api`. A block-JWT surface
 *     added somewhere else entirely (an app-router handler, a rewrite) is outside it.
 *   - The VALUE of an option inside a route's `withBlockScope` literal is not evaluated.
 *     `every wrapped route passes an INLINE options object` pins the literal's SHAPE so the
 *     option is READABLE from the route file, and `declaresLookupFailureOptOut` reads the
 *     KEY however it is spelled — bare, quoted or computed — so a declaration written any of
 *     those ways owes a ledger line. What is NOT known is what the VALUE resolves to:
 *     `onApprovalLookupFailure: SOME_CONST` is ledgered without this file being able to say
 *     whether that const is `'serve'`. The type admits only `'serve'`, which is the same
 *     reasoning the identifier-not-value repair already rests on.
 *   - `namesWrapperInCode` and `proseOnlyMentions` remain LINE-WISE and deliberately wide:
 *     a file naming the wrapper inside a string enters the population and is then required
 *     to wrap its default export. That is the fail-CLOSED direction, so it was left alone
 *     when the rest of the file moved to `stripNonCode` in the 2026-09-19 pass.
 *
 * 🔴 WHAT CHANGED IN THAT PASS (clawgate #589), for this file: `codeLinesOnly` — a line
 * filter that could see neither a trailing comment nor a string — became the `codeWithLiterals`
 * / `stripNonCode` pair, and the opt-out population gained a SHAPE assertion on the options
 * object. MEASURED before it: `tip.ts`, the irreversible Buzz transfer, opted out of failing
 * closed via `...SERVE_ON_LOOKUP_FAILURE` spread from another module at 26/26 GREEN (measured
 * 2026-09-19 against the pre-change guard), invisible
 * to the ledger check, the cross-ledger `READ_PUBLIC` check and the hand-written fail-closed
 * list alike, because all three read the same population.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const API_DIR = 'src/pages/api';
const MIDDLEWARE = 'src/server/middleware/block-scope.middleware.ts';

/**
 * 🔴 THE EXPOSURE CLASS OF A WRAPPED ROUTE — an ENUMERATED FIELD, not a word in a sentence.
 *
 * This used to be a prose prefix (`'READ — …'`, `'SPEND — …'`) and the cross-ledger check
 * below read it with `startsWith('READ —')`. That made the check a SPELLED guard on the
 * widest of the three classes, and it was measurably wrong: the opt-out's own docblock
 * (`block-scope.middleware.ts`, `onApprovalLookupFailure`) states the rule as "do NOT add it
 * to a route that spends, writes, OR DISCLOSES ANYTHING SCOPED TO THE VIEWER", and the
 * third clause had no mechanical expression at all. Three routes classified `READ —` are
 * squarely viewer-scoped — `collections/[id]/index.ts` (the viewer's PRIVATE collections
 * when the token carries `collections:read:private`), `collections/index.ts` (the viewer's
 * own collection list) and `tip-allowance.ts` (the live money counter) — so the check
 * admitted them. Measured before this change: adding the opt-in to
 * `collections/[id]/index.ts` with a rationale entry gave 21/21 GREEN.
 *
 * Splitting `READ` into three named values is what closes that clause. The distinction the
 * opt-out actually turns on is "would a caller who is NOT this app already receive this
 * body", so that is the value the check tests, by identity against an enumerated constant
 * rather than by matching a word another sentence can spell.
 */
type RestExposure =
  /** Moves money irreversibly. */
  | 'SPEND'
  /** Mutates state on the viewer's or the app's behalf. */
  | 'WRITE'
  /** Discloses something scoped to the VIEWER — their data, their identity, their counters. */
  | 'READ_VIEWER_SCOPED'
  /** Discloses APP-private state that no other caller can reach, though it names no viewer. */
  | 'READ_APP_SCOPED'
  /** Discloses only what a caller with no block token already receives. The ONLY opt-outable class. */
  | 'READ_PUBLIC';

/**
 * Every page route wrapped by `withBlockScope`, with what a SUSPENDED app would reach
 * through it if the gate in `withBlockScope` were not there. Derived set must match these
 * keys exactly.
 *
 * `exposure` is what the cross-ledger check reads; `why` is the sentence that has to be
 * written by hand and is the actual point of the ledger. The test can check that the two
 * are both present and that `exposure` is one of the enumerated values — it cannot check
 * that either is TRUE.
 *
 * ⚠️ The two `shared-storage` entries are the interesting ones and the reason the
 * rationale is a sentence rather than a checkbox: they were ALREADY refused before the
 * gate existed — not by anything on the REST path, but incidentally, because they
 * delegate to `resolveSharedContext`, which reads `app_blocks.status` itself. They now
 * refuse one step earlier and for the stated reason. Losing that distinction is how a
 * reader concludes the REST surface was already covered.
 */
const REST_ROUTE_RATIONALE: Record<string, { exposure: RestExposure; why: string }> = {
  'src/pages/api/v1/blocks/collections/[id]/follow.ts': {
    exposure: 'WRITE',
    why: 'addContributorToCollection / removeContributorFromCollection, i.e. a suspended app mutating the viewer’s follow graph on their behalf.',
  },
  'src/pages/api/v1/blocks/collections/[id]/index.ts': {
    exposure: 'READ_VIEWER_SCOPED',
    why: 'A single collection plus its items; with collections:read:private on the token that includes the viewer’s PRIVATE collections — it threads `user: subjectUser` into getCollectionItemsByCollectionId, so the body is the viewer’s, not the public one.',
  },
  'src/pages/api/v1/blocks/collections/index.ts': {
    exposure: 'READ_VIEWER_SCOPED',
    why: 'Collection discovery AND the viewer’s own collection list — the second half is viewer data an anonymous caller does not receive.',
  },
  'src/pages/api/v1/blocks/generation-resources.ts': {
    exposure: 'READ_PUBLIC',
    why: 'Public, maturity-clamped resource data. Thinnest gate of the set: no requiredScope, so no scope check and no context binding either.',
  },
  'src/pages/api/v1/blocks/images.ts': {
    exposure: 'READ_PUBLIC',
    why: 'The public, maturity-clamped image catalog. No requiredScope.',
  },
  'src/pages/api/v1/blocks/me.ts': {
    exposure: 'READ_VIEWER_SCOPED',
    why: 'Viewer identity (id, username, status) and the token’s buzzBudget. Gated on the `app-blocks-enabled` Flipt audience, evaluated against the TOKEN subject via the same shared assertAppBlocksEnabledForTokenUser its tRPC twin blocks.getMyViewer calls — a GA posture, not a takedown check. It used to be gated on a hardcoded isModerator literal instead, which the twin never had; that divergence was resolved 2026-09-18 by dropping the literal.',
  },
  'src/pages/api/v1/blocks/models.ts': {
    exposure: 'READ_PUBLIC',
    why: 'The public, maturity-clamped model catalog. No requiredScope.',
  },
  'src/pages/api/v1/blocks/shared-storage/increment.ts': {
    exposure: 'WRITE',
    why: 'A shared counter bump. ALREADY refused before this gate, incidentally: it delegates to resolveSharedContext, which reads app_blocks.status itself.',
  },
  'src/pages/api/v1/blocks/shared-storage/top.ts': {
    exposure: 'READ_APP_SCOPED',
    why: 'Top-N shared counters — app-global KV that no caller outside this app can read, so refusing it DOES remove exposure even though it names no viewer. ALREADY refused before this gate, for the same delegation reason as increment.ts.',
  },
  'src/pages/api/v1/blocks/tip-allowance.ts': {
    exposure: 'READ_VIEWER_SCOPED',
    why: 'A read, but of the money counter: it discloses the viewer’s live { cap, spent, remaining } tip allowance.',
  },
  'src/pages/api/v1/blocks/tip.ts': {
    exposure: 'SPEND',
    why: 'createBuzzTipTransactionHandler, a real irreversible Buzz transfer. The highest-value entry in this table and the reason the gate was added.',
  },
  'src/pages/api/v1/blocks/tools.ts': {
    exposure: 'READ_PUBLIC',
    why: 'GET returns a static in-process tool registry; POST runs a catalog search on the same clamped path models.ts serves.',
  },
  'src/pages/api/v1/models/[id].ts': {
    exposure: 'READ_PUBLIC',
    why: 'Dual-auth. With no block JWT this is a plain PublicEndpoint, so the body a block receives here is byte-for-byte what an unauthenticated caller can already fetch: refusing it removes NO exposure. It inherits the gate to keep one rule in one place.',
  },
};

/** The one exposure class a route may declare `onApprovalLookupFailure` on. */
const OPT_OUTABLE_EXPOSURE: RestExposure = 'READ_PUBLIC';

/** Every wrapped route whose exposure class forbids the opt-out — derived, both directions. */
function mustFailClosedRoutes(): string[] {
  return Object.entries(REST_ROUTE_RATIONALE)
    .filter(([, { exposure }]) => exposure !== OPT_OUTABLE_EXPOSURE)
    .map(([rel]) => rel)
    .sort();
}

/**
 * 🔴 ROUTES THAT OPT OUT OF FAILING CLOSED ON `lookup_failed`, i.e. that serve the request
 * when the approved-status READ ITSELF FAILED (`onApprovalLookupFailure: 'serve'`).
 *
 * WHY THE OPT-OUT EXISTS. The approved-status read is NEW on this surface — before the
 * gate, the catalog routes made no DB read at all. So failing every wrapped route closed
 * does not restore a previous posture, it INTRODUCES a coupling from all 13 to one replica:
 * a blip becomes a fleet-wide, simultaneous 503 for every block at once. On a route where
 * refusing removes no exposure, that is all cost and no benefit — the same argument the
 * `not_found` branch already won, applied to the other verdict that is not a takedown.
 * `not_approved`, which carries 100% of the gate's protective value, is NOT opt-outable.
 *
 * 🔴 WHY THIS IS A DECLARED LEDGER AND NOT DERIVED FROM `requiredScope`. That proxy was
 * tried first and it is WRONG on the most important entry: `src/pages/api/v1/models/[id].ts`
 * DECLARES `requiredScope: 'models:read:self'` and is nevertheless the clearest no-exposure
 * route in the table — it is dual-auth, so an anonymous caller already receives the same
 * body. Meanwhile the four unscoped catalog routes are a WEAKER version of the argument
 * (public, but maturity-clamped per token). "Does this route declare a scope" and "does
 * this route disclose anything a suspended app could not otherwise get" are different
 * questions that merely correlate, so the answer is written down per route rather than
 * inferred from a proxy that inverts on the case that matters most.
 *
 * The set is asserted in BOTH directions below, so a route cannot join or leave it
 * silently, and each entry is CROSS-CHECKED against `REST_ROUTE_RATIONALE` — see
 * `every serve-on-lookup-failure route is READ_PUBLIC in the exposure ledger`, which is
 * what mechanically keeps a SPEND, a WRITE, a viewer-scoped read or an app-scoped read out.
 *
 * ⚠️ The population feeding that check is derived on the bare identifier
 * `onApprovalLookupFailure`, NOT on the value `'serve'` — see `LOOKUP_FAILURE_OPT_OUT_RE`
 * for the merge blocker that repair closed. The only value the type admits is `'serve'`.
 */
const LOOKUP_FAILURE_SERVE_RATIONALE: Record<string, string> = {
  'src/pages/api/v1/blocks/generation-resources.ts':
    'Public, maturity-clamped resource data; no requiredScope, nothing viewer-scoped, nothing written. The clamp rides the token’s own signed claim, not the approval row.',
  'src/pages/api/v1/blocks/images.ts':
    'Public, maturity-clamped image catalog; no requiredScope, nothing viewer-scoped, nothing written.',
  'src/pages/api/v1/blocks/models.ts':
    'Public, maturity-clamped model catalog; no requiredScope, nothing viewer-scoped, nothing written.',
  'src/pages/api/v1/blocks/tools.ts':
    'GET is a static in-process registry; POST is a catalog search on the same clamped path models.ts serves. No requiredScope, nothing viewer-scoped, nothing written.',
  'src/pages/api/v1/models/[id].ts':
    'Dual-auth: the block-JWT branch differs from the anonymous one only in skipping the origin cache — same builder, same arguments, same body. An unauthenticated caller already gets this at 200, so refusing it on a replica blip removes NO exposure and costs a 503.',
};

/**
 * 🔴 ROUTES THAT NAME THE WRAPPER IN PROSE ONLY, i.e. that DECIDED NOT TO USE IT. This
 * ledger exists because the first version of this file had no such concept and flagged
 * `src/pages/api/v1/me.ts` as an unwrapped route — a false positive off a substring
 * match, from a file whose comment explains at length why it is deliberately not wrapped.
 *
 * Deleting the entry would have been the cheap fix and the wrong one. `/api/v1/me` is a
 * real dual-auth route that a reader WILL come to expecting this decision to have been
 * made, and "it never appeared in the population" is not a record of anything. So the
 * decision is recorded here and asserted as a SET, both directions: a route cannot leave
 * this list by being wrapped without the ledger noticing, and a new route cannot join it
 * without someone writing down why.
 */
const DELIBERATELY_UNWRAPPED: Record<string, string> = {
  'src/pages/api/v1/me.ts':
    'NOT a block route. AuthedEndpoint (session cookie / API key / OAuth token). Wrapping it would dead-code the block path — the inner session check 401s before block claims do anything — so blocks use the dedicated /api/v1/blocks/me, which IS wrapped. Nothing here reads a block token, so there is no app to approve.',
};

/** The file extensions Next.js dispatches as an API page. */
const PAGE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs'];

/**
 * Every ledger key and path literal in this file is posix, while `path.join` yields `\` on
 * win32 — so both walks below must normalise or every set comparison here fails off Linux.
 */
const toPosix = (p: string) => p.split(path.sep).join('/');

function walk(relDir: string, out: string[] = []): string[] {
  const abs = path.join(REPO_ROOT, relDir);
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = toPosix(path.join(relDir, entry.name));
    if (entry.isDirectory()) {
      walk(rel, out);
      continue;
    }
    if (PAGE_EXTENSIONS.includes(path.extname(entry.name))) out.push(rel);
  }
  return out;
}

/** `withBlockScope` named anywhere in the file, comments included (fail-closed wide). */
const MENTIONS_RE = /\bwithBlockScope\b/;
/** `export default withBlockScope(` — the wrapper applied AT the export site. */
const DEFAULT_EXPORT_WRAPPED_RE = /export\s+default\s+withBlockScope\s*\(/;
/**
 * The bare IDENTIFIER, not a call — this is a PROHIBITION, so every route to the verifier
 * must be seen: a direct call, an aliased static import, a dynamic
 * `const { verifyBlockToken: v } = await import(...)` destructure, and a member access on a
 * namespace import. A `\s*\(` form sees only the first of those, which is why the shipped
 * assertion keys on the identifier. Type positions are admitted as offenders deliberately:
 * no page route has business naming this at all.
 */
const DIRECT_VERIFY_RE = /\bverifyBlockToken\b/;

/** How many times `re` (a /g/ regex) matches `text` — CALLS, not lines carrying one. */
function countCalls(re: RegExp, text: string): number {
  return (text.match(re) ?? []).length;
}

/** `resolveRestApprovalVerdict(` — the REST approval predicate, as a CALL. */
const REST_VERDICT_CALL_RE = /\bresolveRestApprovalVerdict\s*\(/g;
/** `resolveAppBlockApprovalVerdict(` — the shared predicate the bridge guard delegates to. */
const SHARED_VERDICT_CALL_RE = /\bresolveAppBlockApprovalVerdict\s*\(/g;
/**
 * 🔴 THE OPT-OUT DECLARATION, DETECTED ON THE BARE IDENTIFIER — NOT ON ITS VALUE.
 *
 * This was `/\bonApprovalLookupFailure\s*:\s*'serve'/` and that was a MERGE BLOCKER: the
 * literal demanded SINGLE quotes, and nothing anywhere else in the stack cares. The runtime
 * check is `opts.onApprovalLookupFailure !== 'serve'` (`block-scope.middleware.ts`), a plain
 * JS string comparison, so `"serve"` is fully active. `tsc` accepts it because the literal
 * TYPE is identical — this is not the `'Serve'` typo class, which is a compile error — and
 * prettier cannot save it either, since formatting is a non-blocking warning on modified
 * files. Measured before this change: adding `onApprovalLookupFailure: "serve",` to
 * `tip.ts` — the irreversible Buzz transfer, the single highest-value entry in the exposure
 * ledger — gave 21/21 GREEN. Not one of the three guards downstream of this regex fired,
 * because ALL of them derive their population from it.
 *
 * So it now matches the IDENTIFIER and says nothing about the value. Any spelling of any
 * value forces a ledger entry, which is the fail-closed direction: a route that mentions
 * this option in code at all must be written down, and the only value the type permits is
 * `'serve'`. A wider quote-class regex would have been the wrong repair — it still
 * enumerates spellings, and the next one (a template literal, a const, a spread) walks past
 * it exactly the same way.
 *
 * Matched on CODE lines only (see `declaresLookupFailureOptOut`), so the option's own
 * docblock in the middleware — and the prose in this file — cannot enter the population.
 */
const LOOKUP_FAILURE_OPT_OUT_RE = /\bonApprovalLookupFailure\b/;

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

/**
 * 🔴 THE LITERAL SENTINEL. A character that cannot be written from INSIDE a TypeScript
 * string literal, used by `codeWithLiterals` below to re-delimit literals so that a spelling
 * check can tell `status === 'approved'` from `"status === 'approved'"`. Writing `\u0000`
 * inside a string puts the six characters `\u0000` in the SOURCE, not a raw NUL, so the
 * sentinel survives as a delimiter no literal body can forge. If a raw one ever appears in a
 * scanned file the normaliser throws rather than normalising into an ambiguous form.
 */
const LITERAL_SENTINEL = '\u0000';

/**
 * 🔴 NORMALISE BEFORE ANY SPELLING CHECK — COMMENTS AND STRINGS BOTH. A `toMatch` over a
 * WHOLE FILE asks "does this text appear anywhere", and a docblock is anywhere, and so is a
 * string literal. Either one makes the assertion satisfiable by something that DESCRIBES the
 * check rather than by the check. Once that happens the test is not weak, it is INERT: it
 * reads as coverage, which stops anyone looking, while the thing it names can be deleted.
 *
 * The COMMENT half has been found FIVE times in this family of guards:
 *   1. `status === 'approved'` — the predicate module's docblock quotes that exact
 *      expression while describing the mint endpoint. MEASURED: weakening the real
 *      comparison to `!== 'suspended'` left the whole-file form GREEN.
 *   2. `appBlock.findUnique` — same file, same shape, fixed alongside it.
 *   3. `resolveAppBlockApprovalVerdict\s*\(` in the bridge file. It happened to be
 *      NON-vacuous only by luck of punctuation: the guard docblock's one occurrence is
 *      followed by a backtick and a newline, which `\s*` cannot bridge to a `(`.
 *   4. The same regex over the same file in the REST sibling, on the identical luck.
 *   5. `THE RELATIONSHIP` in the REST sibling, which read the RAW file: a COMMENTED-OUT
 *      `export default withBlockScope(...)` above a bare `export default baseHandler;` gave
 *      24/24 PASS on a live route with no token verification at all.
 *
 * 🔴 AND THE STRING HALF, WHICH THE LINE-WISE PREDECESSOR (`codeLinesOnly`) COULD NOT SEE AT
 * ALL. It filtered whole comment LINES, so every assertion downstream of it was still
 * satisfiable by a string: `const doc = "status === 'approved'";` satisfied
 * `toMatch(/status === 'approved'/)` exactly as well as the real comparison did, and a
 * trailing `// authorizeBlockBridgeToken(x)` on a line of code survived the filter outright.
 * Both are the fail-OPEN direction. That is clawgate #589 findings (2), (3) and (6).
 *
 * 🔴 WHY THE TypeScript PARSER AND NOT A HAND-ROLLED LEXER. This was first written as a
 * character scanner, and the scanner was MEASURED WRONG on this corpus — the reason it is
 * worth the dependency, given `typescript` is already one and two sibling guards in this
 * directory (`no-unguarded-user-text.test.ts`, `collection-item-count-clamp-wiring.test.ts`)
 * already parse rather than lex. Three live defects, all fail-OPEN, all closed by parsing:
 *
 *   (a) A NESTED TEMPLATE inverts which regions are code. A hand lexer pairs backticks
 *       1-2 and 3-4, so in ``logger.info(`call ${`authorizeBlockBridgeToken(t)`} done`)``
 *       it emits the INNER literal's body as code — a FAKE guard call that satisfies
 *       `THE RELATIONSHIP`, which is finding (2) reached through a literal instead of a
 *       comment. Measured 2026-09-19: 35 nested template literals across 14 files under
 *       `src/pages/api`, so this is an ordinary shape rather than an exotic one.
 *   (b) A REGEX LITERAL desyncs it. `blocks.router.ts` contains `/^https?:\/\//` TWICE:
 *       the `\/\/` yields an adjacent `//`, which a lexer reads as a line comment and
 *       discards the rest of the line. An earlier draft of this docstring claimed "none
 *       appears in the files scanned here" — that claim was false when written.
 *   (c) `${...}` INTERPOLATION is real code, and a lexer swallows it into the literal body.
 *       Measured against the compiler over the 345 files these two suites read, that alone
 *       put the lexer's notion of "what is code" at odds with the parser's on roughly half
 *       of them.
 *
 * WHAT IT PRODUCES. Comments are removed. Every string, template part and regex literal is
 * re-delimited as `<sentinel><body><sentinel>`, so the body is still READABLE (needed to pin
 * the value in `status === 'approved'`) while being unable to impersonate code: the evasion
 * normalises to `const doc = ␀status === 'approved'␀;`, which the sentinel-bearing assertion
 * regex does not match, while the real comparison normalises to `block.status === ␀approved␀`,
 * which it does. `stripNonCode` empties the bodies for checks where a literal's CONTENT is
 * pure noise or an outright hazard.
 *
 * 🔴 LINE STRUCTURE IS PRESERVED EXACTLY — every newline inside a removed comment or a
 * literal body is re-emitted in place, so line N of the result is line N of the input and a
 * line number taken from it indexes the original file. `scan` reports line numbers off this
 * and `chunks` slices raw and normalised lines at the same indices; both are wrong if that
 * stops holding, which is why `preserves the line structure exactly` asserts it.
 *
 * LIMITS, stated because they are real and this docstring must not read wider than the body:
 *   - It PARSES, so it must be given a whole module, not a fragment. A ` * …` docblock
 *     continuation fed in isolation is not a comment to a parser any more than it is to a
 *     reader — there is no `/**` open above it. Every fixture below is a whole block.
 *   - `ts.createSourceFile` is error-TOLERANT: a syntactically invalid module still yields a
 *     tree, and the ranges recovered from it are whatever the parser made of the wreckage.
 *     Every file these suites read also has to compile, so this is not load-bearing here.
 *   - JSX is parsed only when the path says so (`.tsx`/`.jsx` → `ScriptKind.TSX`). A `.ts`
 *     file containing JSX would be mis-parsed, which the repo's own typecheck already forbids.
 */
type TriviaSpans = {
  /** [start, end] of each comment. */
  comments: [number, number][];
  /** [start, end, prefixLen, suffixLen] of each literal; prefix/suffix are its delimiters. */
  literals: [number, number, number, number][];
};

/**
 * The parse is the expensive step, and it answers BOTH modes — so it is taken once per
 * (path, source) and the spans are reused. Measured on the 551 KB router, parsing twice
 * (once for the kept-bodies view, once for the emptied one) roughly doubled this suite's
 * wall time for no additional information.
 */
const triviaCache = new Map<string, TriviaSpans>();

function triviaSpans(source: string, rel: string): TriviaSpans {
  const key = `${rel}\u0001${source}`;
  const cached = triviaCache.get(key);
  if (cached) return cached;
  const spans = scanTrivia(source, rel);
  triviaCache.set(key, spans);
  return spans;
}

function scanTrivia(source: string, rel: string): TriviaSpans {
  const sourceFile = ts.createSourceFile(
    rel,
    source,
    ts.ScriptTarget.Latest,
    true,
    /\.(tsx|jsx)$/.test(rel) ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );

  const literals: TriviaSpans['literals'] = [];
  const comments: TriviaSpans['comments'] = [];
  const seenComment = new Set<number>();

  const addComments = (ranges: ts.CommentRange[] | undefined) => {
    for (const range of ranges ?? []) {
      if (seenComment.has(range.pos)) continue;
      seenComment.add(range.pos);
      comments.push([range.pos, range.end]);
    }
  };

  const visit = (node: ts.Node): void => {
    // 🔴 BOTH KINDS. `getLeadingCommentRanges` deliberately does NOT return a comment that
    // sits on the same line as the code before it — that is TRAILING trivia of the previous
    // token — so collecting only leading ranges leaves every `const x = 1; // …` comment in
    // the output. That is the exact trailing-comment fail-open this normaliser was written
    // to close, reintroduced by reading half the trivia.
    addComments(ts.getLeadingCommentRanges(source, node.getFullStart()));
    addComments(ts.getTrailingCommentRanges(source, node.end));
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isRegularExpressionLiteral(node)
    ) {
      literals.push([node.getStart(sourceFile), node.end, 1, 1]);
    } else if (node.kind === ts.SyntaxKind.TemplateHead) {
      // `` `head${ `` — one backtick in, two characters out.
      literals.push([node.getStart(sourceFile), node.end, 1, 2]);
    } else if (node.kind === ts.SyntaxKind.TemplateMiddle) {
      // `}middle${` — one character in, two out.
      literals.push([node.getStart(sourceFile), node.end, 1, 2]);
    } else if (node.kind === ts.SyntaxKind.TemplateTail) {
      // `` }tail` `` — one in, one out.
      literals.push([node.getStart(sourceFile), node.end, 1, 1]);
    }
    node.forEachChild(visit);
  };
  visit(sourceFile);
  addComments(ts.getLeadingCommentRanges(source, sourceFile.endOfFileToken.getFullStart()));
  addComments(ts.getTrailingCommentRanges(source, source.length));
  return { comments, literals };
}

function normaliseSource(source: string, rel: string, keepLiteralBodies: boolean): string {
  if (source.includes(LITERAL_SENTINEL)) {
    throw new Error(
      'Source carries a raw U+0000, which this scan uses as the literal delimiter. Every ' +
        'spelling assertion downstream would be reading an ambiguous normalisation, so this ' +
        'fails loudly rather than answering.'
    );
  }
  const { comments, literals } = triviaSpans(source, rel);

  // 🔴 SPACES, NOT DELETION — the normalisation is LENGTH-preserving as well as
  // line-preserving, so an offset into the result is the same offset in the original file.
  // That is what lets `inputArg` balance parentheses over the normalised text (where a stray
  // `(` in a comment or a string cannot exist) and then slice the argument out of the RAW
  // text at the identical offsets, keeping the deliberate raw-`blockToken` reading.
  const blanked = (text: string) => text.replace(/[^\n]/g, ' ');
  type Span = { start: number; end: number; render: () => string };
  const spans: Span[] = [
    ...comments.map(([start, end]) => ({
      start,
      end,
      // One space so two tokens a comment separated do not fuse into one identifier.
      render: () => ` ${blanked(source.slice(start + 1, end))}`,
    })),
    ...literals.map(([start, end, pre, suf]) => ({
      start,
      end,
      render: () => {
        const body = source.slice(start + pre, end - suf);
        // Delimiters become the sentinel plus spaces for any extra delimiter characters, so
        // the rendered span is exactly as long as the span it replaces.
        return (
          LITERAL_SENTINEL +
          blanked(source.slice(start + 1, start + pre)) +
          (keepLiteralBodies ? body : blanked(body)) +
          blanked(source.slice(end - suf, end - 1)) +
          LITERAL_SENTINEL
        );
      },
    })),
  ].sort((a, b) => a.start - b.start);

  let out = '';
  let cursor = 0;
  for (const span of spans) {
    if (span.start < cursor) continue; // a comment inside a literal, or vice versa
    out += source.slice(cursor, span.start) + span.render();
    cursor = span.end;
  }
  return out + source.slice(cursor);
}

/**
 * Memoised per (source, mode): the two suites normalise the same handful of files many times
 * over, and parsing is the one part of this that is not free. Keyed on the source TEXT, so a
 * file edited between calls is a different key rather than a stale hit.
 */
const normaliseCache = new Map<string, string>();
function normalised(source: string, rel: string, keepLiteralBodies: boolean): string {
  const key = `${keepLiteralBodies ? 'K' : 'E'}${rel}${source}`;
  let hit = normaliseCache.get(key);
  if (hit === undefined) {
    hit = normaliseSource(source, rel, keepLiteralBodies);
    normaliseCache.set(key, hit);
  }
  return hit;
}

/**
 * Comments removed; string, template and regex literal bodies KEPT but re-delimited. The view
 * for a check that needs a literal's VALUE (`status === 'approved'`), and for a PROHIBITION —
 * a check whose failure direction is "this identifier must not appear" — because a name
 * written inside a string is exactly as reachable as one written outside it
 * (`mod['verifyBlockToken'](t)`), so it must still be seen.
 */
function codeWithLiterals(source: string, rel = 'scanned.ts'): string {
  return normalised(source, rel, true);
}

/**
 * Comments removed; literal bodies EMPTIED. The view for a COUNT and for an identifier scan,
 * where a string is pure noise and an outright hazard: a literal spelling
 * `authorizeBlockBridgeToken(` must not satisfy a reachability check, and a
 * `.describe('…')` argument must not yield English words as candidate schema names.
 *
 * It is the wrong view for pinning a VALUE — `status === 'approved'` and
 * `status === 'suspended'` are the same text here — and the wrong view for a prohibition.
 */
function stripNonCode(source: string, rel = 'scanned.ts'): string {
  return normalised(source, rel, false);
}

/** True when `source` names `withBlockScope` on at least one line that is not a comment. */
function namesWrapperInCode(source: string): boolean {
  return source
    .split('\n')
    .some((line) => MENTIONS_RE.test(line) && !/^\s*(?:\/\/|\*|\/\*)/.test(line));
}

/**
 * True when `source` NAMES the lookup-failure opt-out anywhere outside a comment.
 *
 * 🔴 READS `codeWithLiterals`, WHICH KEEPS LITERAL BODIES, AND THAT IS THE WHOLE POINT. This
 * is a PROHIBITION-shaped probe — its job is to force a ledger entry — so every way the
 * identifier can reach the option must be seen, including the ways that are string literals:
 *
 *     { 'onApprovalLookupFailure': 'serve' }      // a quoted key
 *     { ['onApprovalLookupFailure']: 'serve' }    // a computed key
 *
 * Both type-check (the option is a plain optional property), and the runtime reads
 * `opts.onApprovalLookupFailure !== 'serve'`, a property access that does not care how the
 * key was spelled — so both are fully LIVE. Under the emptied view they vanish, and the route
 * silently leaves the derived population that the ledger check, the cross-ledger
 * `READ_PUBLIC` check and the hand-written fail-closed list ALL read. That is finding 4's
 * fail-open reached through the key instead of the spread, and it is not hypothetical: it was
 * measured on `tip.ts`, the irreversible Buzz transfer, during clawgate #589's own review.
 *
 * The cost of keeping bodies is a route that merely MENTIONS the option in a string being
 * forced into the ledger. That is the fail-CLOSED direction and costs one line to record,
 * which is exactly the trade the identifier-not-value repair already chose.
 */
function declaresLookupFailureOptOut(source: string, rel = 'route.ts'): boolean {
  // A RAW pre-filter before the parse. Sound in one direction only, which is the direction
  // that matters: a name absent from the raw text is absent from every view of it, so this
  // can produce a false POSITIVE (a file mentioning it in a comment, which then gets the full
  // treatment and is correctly rejected) and never a false negative. It exists because the
  // scan is over 341 route files and only a handful name this at all.
  if (!LOOKUP_FAILURE_OPT_OUT_RE.test(source)) return false;
  return LOOKUP_FAILURE_OPT_OUT_RE.test(codeWithLiterals(source, rel));
}

/** Routes under `src/pages/api` that declare `onApprovalLookupFailure` at all, any spelling. */
function lookupFailureServeRoutes(): string[] {
  return walk(API_DIR)
    .filter((rel) => declaresLookupFailureOptOut(read(rel), rel))
    .sort();
}

/**
 * The OPTIONS argument of `export default withBlockScope(handler, <options>)` in `source`,
 * read off normalised code, or `null` when there is no wrapped default export or no second
 * argument. Balanced-delimiter, so a nested object or call in the first argument cannot be
 * mistaken for the argument separator.
 */
function wrappedExportOptionsArg(source: string, rel = 'route.ts'): string | null {
  const code = stripNonCode(source, rel);
  const m = DEFAULT_EXPORT_WRAPPED_RE.exec(code);
  if (!m) return null;
  const open = m.index + m[0].length - 1;
  let depth = 0;
  let end = -1;
  for (let i = open; i < code.length; i++) {
    if (code[i] === '(') depth++;
    else if (code[i] === ')' && --depth === 0) {
      end = i;
      break;
    }
  }
  if (end < 0) return null;
  const args = code.slice(open + 1, end);
  let nesting = 0;
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if (c === '(' || c === '[' || c === '{') nesting++;
    else if (c === ')' || c === ']' || c === '}') nesting--;
    else if (c === ',' && nesting === 0) return args.slice(i + 1).trim();
  }
  return null;
}

/** Routes under `src/pages/api` that USE the wrapper in code — the population. */
function blockScopedRoutes(): string[] {
  return walk(API_DIR)
    .filter((rel) => namesWrapperInCode(read(rel)))
    .sort();
}

/**
 * Routes that name the wrapper ONLY in prose — the deliberate non-users. Derived as the
 * complement so the two ledgers partition the same scan rather than being two
 * independent hand-lists that can both drift.
 */
function proseOnlyMentions(): string[] {
  return walk(API_DIR)
    .filter((rel) => {
      const source = read(rel);
      return MENTIONS_RE.test(source) && !namesWrapperInCode(source);
    })
    .sort();
}

describe('the REST route scan can actually see what it claims to', () => {
  /**
   * A derivation that silently matches nothing passes forever. These run the real
   * regexes over synthetic sources whose answers are known, so a pattern that stops
   * matching — or one that starts matching a type position — is caught here instead of
   * showing up as a reassuring empty result below.
   */
  it('POSITIVE CONTROL — the population regex matches a wrapped route', () => {
    expect(
      MENTIONS_RE.test("export default withBlockScope(baseHandler, { endpoint: 'me' });")
    ).toBe(true);
    expect(MENTIONS_RE.test('export default PublicEndpoint(handler);')).toBe(false);
  });

  it('POSITIVE CONTROL — the wrapped-default regex separates a wrapped export from a bare one', () => {
    const wrapped = [
      "import { withBlockScope } from '~/server/middleware/block-scope.middleware';",
      'export const baseHandler = async () => {};',
      "export default withBlockScope(baseHandler, { endpoint: 'tip' });",
    ].join('\n');
    // 🔴 THE NEGATIVE CONTROL THAT MATTERS: this file MENTIONS the wrapper (it imports
    // it, and its own comment names it) and still exports the bare handler. It is the
    // exact regression the relationship assertion exists for, and a check keyed on
    // "does the file mention withBlockScope" would score it as guarded.
    const bare = [
      "import { withBlockScope } from '~/server/middleware/block-scope.middleware';",
      '// withBlockScope is applied by the caller.',
      'export const baseHandler = async () => {};',
      'export default baseHandler;',
    ].join('\n');

    // Both are IN the population — `bare` names the wrapper on its import line, which is
    // code — so the relationship assertion is what has to separate them.
    expect(namesWrapperInCode(wrapped)).toBe(true);
    expect(namesWrapperInCode(bare)).toBe(true);
    expect(DEFAULT_EXPORT_WRAPPED_RE.test(wrapped)).toBe(true);
    expect(DEFAULT_EXPORT_WRAPPED_RE.test(bare)).toBe(false);
  });

  it('POSITIVE CONTROL — the lookup-failure opt-out regex reads code and ignores prose', () => {
    // A derivation that silently matches nothing ledgers an EMPTY set and passes forever,
    // which would make the both-directions assertion vacuous in the dangerous direction.
    expect(
      declaresLookupFailureOptOut(
        ['export default withBlockScope(h, {', "  onApprovalLookupFailure: 'serve',", '});'].join(
          '\n'
        )
      )
    ).toBe(true);
    // A route that does NOT declare it (the fail-closed default) must stay out.
    expect(
      declaresLookupFailureOptOut("export default withBlockScope(h, { endpoint: 'tip' });")
    ).toBe(false);
    // 🔴 And the case that would quietly inflate the population: the option NAMED in a
    // comment. The middleware's own docblock and this file's prose both do exactly that.
    expect(
      declaresLookupFailureOptOut(
        ["// onApprovalLookupFailure: 'serve' — described, not declared", 'export default h;'].join(
          '\n'
        )
      )
    ).toBe(false);
    expect(
      declaresLookupFailureOptOut(
        [
          '/**',
          " * Set `onApprovalLookupFailure: 'serve'` to opt out.",
          ' */',
          'export default h;',
        ].join('\n')
      )
    ).toBe(false);
  });

  /**
   * 🔴 THE CONTROL FOR THE DEFECT THAT WAS ACTUALLY SHIPPED. The population regex used to
   * pin the VALUE as a single-quoted literal, so every spelling below opted a route in
   * while leaving it out of the derived set — and out of the cross-ledger check, the
   * wrapped-route check and the fail-closed list, all three of which read this population.
   * The runtime compares with `!==`, so each of these is fully ACTIVE.
   */
  it('POSITIVE CONTROL — the opt-out is detected whatever the value is spelled like', () => {
    for (const declaration of [
      "  onApprovalLookupFailure: 'serve',", // the intended spelling
      '  onApprovalLookupFailure: "serve",', // double quotes — tsc-identical, was INVISIBLE
      '  onApprovalLookupFailure: `serve`,', // template literal
      '  onApprovalLookupFailure:SERVE,', // a const, no whitespace
      '  onApprovalLookupFailure   :   "serve" ,', // padded
    ]) {
      expect(
        declaresLookupFailureOptOut(
          ['export default withBlockScope(h, {', declaration, '});'].join('\n')
        ),
        `${declaration.trim()} must be detected — the runtime compares with !==, so it is live`
      ).toBe(true);
    }
  });

  /**
   * 🔴 THE CONTROL FOR THE FAIL-OPEN THAT WAS SHIPPED IN THE RELATIONSHIP CHECK. The
   * wrapped-default scan read the RAW file, so a commented-out wrapper satisfied it while
   * the bare handler was exported. Measured on `blocks/me.ts`: 24/24 PASS with no token
   * verification, no revocation check and no approved-status gate on a live route.
   */
  it('POSITIVE CONTROL — a COMMENTED-OUT wrapped export does not satisfy the relationship', () => {
    const commentedOut = [
      "import { withBlockScope } from '~/server/middleware/block-scope.middleware';",
      'const baseHandler = async () => {};',
      "// export default withBlockScope(baseHandler, { endpoint: 'me' });",
      'export default baseHandler;',
    ].join('\n');
    // It IS in the population — the import line is code — so the relationship is the only
    // thing that can separate it, and it must read the code, not the prose.
    expect(namesWrapperInCode(commentedOut)).toBe(true);
    expect(DEFAULT_EXPORT_WRAPPED_RE.test(commentedOut)).toBe(true); // raw file: FALSE PASS
    expect(DEFAULT_EXPORT_WRAPPED_RE.test(stripNonCode(commentedOut))).toBe(false); // the fix
  });

  it('POSITIVE CONTROL — the one-place predicate check counts CALLS and ignores prose', () => {
    const twoOnOneLine =
      'const v = c ? resolveRestApprovalVerdict(a) : resolveRestApprovalVerdict(b);';
    expect((twoOnOneLine.match(/\bresolveRestApprovalVerdict\s*\(/g) ?? []).length).toBe(2);
    // The line-wise form scored this as 1 — two predicates passing "exactly once".
    expect(
      twoOnOneLine.split('\n').filter((l) => /\bresolveRestApprovalVerdict\s*\(/.test(l)).length
    ).toBe(1);
    // And a prose mention WITH an argument list must not count at all.
    // 🔴 A WHOLE DOCBLOCK, NOT AN ORPHAN LINE. `stripNonCode` is a scanner rather than a
    // line filter, so a ` * …` continuation is only a comment because a `/**` is open above
    // it — a fixture without the opener tests a shape no real file has.
    const prose = [
      '/**',
      ' * resolveRestApprovalVerdict(claims) resolves the verdict.',
      ' */',
      'const x = 1;',
    ].join('\n');
    expect((stripNonCode(prose).match(/\bresolveRestApprovalVerdict\s*\(/g) ?? []).length).toBe(0);
  });

  it('POSITIVE CONTROL — a prose-only mention is NOT in the wrapped population', () => {
    // The `/api/v1/me.ts` shape: the wrapper is named only to explain why it is absent.
    // A population keyed on the raw substring scored this as an unwrapped block route.
    const proseOnly = [
      '// Note: App Blocks do NOT call this route directly. Layering withBlockScope over',
      '// AuthedEndpoint would dead-code the block-token path.',
      'export default AuthedEndpoint(handler);',
    ].join('\n');
    expect(MENTIONS_RE.test(proseOnly)).toBe(true);
    expect(namesWrapperInCode(proseOnly)).toBe(false);
  });

  it('POSITIVE CONTROL — the direct-verify regex is the one the shipped assertion uses', () => {
    // 🔴 THIS CONTROL USED TO PROVE NOTHING ABOUT ANYTHING THAT SHIPS. `DIRECT_VERIFY_RE` was
    // `/\bverifyBlockToken\s*\(/` and was referenced ONLY here, while the real assertion
    // (`no page route verifies a block token itself`) carried its own inline
    // `/\bverifyBlockToken\b/` — two literals, so editing the shipped one could not turn this
    // red. One regex, one place; this now exercises the constant the assertion reads.
    //
    // It is the bare IDENTIFIER, and a type position is therefore an offender BY DESIGN: no
    // page route has business naming the bare verifier in any position, and narrowing to a
    // call is what a dynamic `await import()` destructure walks through.
    expect(DIRECT_VERIFY_RE.test('const claims = await verifyBlockToken(bearer);')).toBe(true);
    expect(DIRECT_VERIFY_RE.test('type C = Awaited<ReturnType<typeof verifyBlockToken>>;')).toBe(
      true
    );
    expect(DIRECT_VERIFY_RE.test("const { verifyBlockToken: v } = await import('~/x');")).toBe(
      true
    );
    // The negative half, or the assertions above pass on a regex that matches anything.
    expect(DIRECT_VERIFY_RE.test('export default withBlockScope(baseHandler, {});')).toBe(false);
  });

  /**
   * 🔴 THE POSITIVE CONTROL FOR THIS FILE'S OWN COPY OF THE NORMALISERS. Every assertion
   * below is filtered through `stripNonCode`, so an identity mutation (`return source;`) on
   * either helper must fail here — the bridge sibling's copy had NO such control and a
   * `return source;` left it green at 21/21, which is exactly what the deliberate
   * duplication makes possible. Both the comment half and the string half are exercised.
   */
  it('POSITIVE CONTROL — the normalisers strip comments, trailing comments and string bodies', () => {
    // Comments, in the shape a real file carries them: a whole block, not an orphan line.
    const docblock = [
      '/**',
      ' * resolveRestApprovalVerdict(claims) resolves the verdict for the REST surface.',
      ' */',
      'const unrelated = 1;',
    ].join('\n');
    expect((stripNonCode(docblock).match(/\bresolveRestApprovalVerdict\s*\(/g) ?? []).length).toBe(
      0
    );
    expect(stripNonCode(docblock)).toMatch(/const unrelated = 1;/);
    // A TRAILING comment on a line of code — invisible to the line-wise predecessor.
    expect(stripNonCode('const x = 1; // resolveRestApprovalVerdict(a)')).not.toMatch(
      /resolveRestApprovalVerdict\(/
    );
    // 🔴 THE STRING HALF. A literal spelling the call must not satisfy or inflate a count.
    // With the line-wise filter this line counted as a call, so a middleware carrying it
    // could DELETE the real call and still report "exactly once".
    expect(
      (
        stripNonCode("const s = 'resolveRestApprovalVerdict(a)';").match(
          /\bresolveRestApprovalVerdict\s*\(/g
        ) ?? []
      ).length
    ).toBe(0);
    // …and a REAL call still counts, or the filter strips everything and the assertions
    // below pass for the wrong reason.
    expect(
      (
        stripNonCode('const v = await resolveRestApprovalVerdict(claims);').match(
          /\bresolveRestApprovalVerdict\s*\(/g
        ) ?? []
      ).length
    ).toBe(1);
    // Line structure is preserved, which `wrappedExportOptionsArg` and every line-indexed
    // read downstream depend on.
    const spanning = ['/* a', ' b */ const c = 1;', 'const d = `e', 'f`;'].join('\n');
    expect(stripNonCode(spanning).split('\n')).toHaveLength(4);
    expect(stripNonCode(spanning).split('\n')[1]).toContain('const c = 1;');
  });

  /**
   * 🔴 THE THREE SPELLINGS THAT DEFEATED AN EARLIER DRAFT OF THIS VERY PASS. Each was
   * measured live on `tip.ts` — the irreversible Buzz transfer and the highest-value entry in
   * the exposure ledger — and each left the route outside the derived population, i.e.
   * outside the ledger check, the cross-ledger `READ_PUBLIC` check AND the hand-written
   * fail-closed list simultaneously, because all three read that one population.
   *
   * The first is the clawgate #589 finding. The second and third are the regression that a
   * careless repair introduced: routing this probe through the body-EMPTYING view made a
   * quoted key invisible, which the line-wise filter it replaced had caught.
   */
  it('POSITIVE CONTROL — the opt-out is detected however the KEY is spelled', () => {
    for (const declaration of [
      "  onApprovalLookupFailure: 'serve',", // a bare key
      "  'onApprovalLookupFailure': 'serve',", // a quoted key — a string literal
      "  ['onApprovalLookupFailure']: 'serve',", // a computed key — also a string literal
      '  "onApprovalLookupFailure": "serve",', // double-quoted key and value
    ]) {
      expect(
        declaresLookupFailureOptOut(
          ['export default withBlockScope(h, {', declaration, '});'].join('\n')
        ),
        `${declaration.trim()} must be detected — the runtime reads the property, so it is live`
      ).toBe(true);
    }
    // The negative half, or the loop above passes on a probe that matches anything.
    expect(
      declaresLookupFailureOptOut("export default withBlockScope(h, { endpoint: 'tip' });")
    ).toBe(false);
  });

  it('POSITIVE CONTROL — a nested template literal cannot smuggle code past the normaliser', () => {
    // A hand-rolled lexer pairs backticks 1-2 and 3-4, which INVERTS the code and literal
    // regions of a nested template and emits the inner body as code. Measured on an earlier
    // draft: a fake `resolveRestApprovalVerdict(...)` written this way counted as a call.
    // Measured 2026-09-19: 35 nested template literals across 14 files under src/pages/api,
    // so this is an ordinary shape rather than an exotic one.
    const nested = ['const m = `outer ${`resolveRestApprovalVerdict(a)`} tail`;'].join('\n');
    expect(countCalls(REST_VERDICT_CALL_RE, stripNonCode(nested))).toBe(0);
    // …and the interpolation of a REAL call is still code, which the lexer also got wrong,
    // in the opposite direction.
    const interpolated = ['const m = `outer ${resolveRestApprovalVerdict(a)} tail`;'].join('\n');
    expect(countCalls(REST_VERDICT_CALL_RE, stripNonCode(interpolated))).toBe(1);
  });

  it('POSITIVE CONTROL — a regex literal does not desync the normaliser', () => {
    // `/^https?:\/\//` puts an adjacent `//` in the source, which a lexer reads as a line
    // comment and then discards the rest of the line. `blocks.router.ts` contains exactly
    // this, twice. Anything after the regex on that line must survive.
    const withRegex = ["const h = raw.replace(/^https?:\\/\\//, '');", 'const after = 1;'].join(
      '\n'
    );
    expect(stripNonCode(withRegex)).toMatch(/const after = 1;/);
    expect(stripNonCode(withRegex).split('\n')).toHaveLength(2);
  });

  it('rejects a source that already carries the literal sentinel', () => {
    // The re-delimiting is unambiguous only while no literal body can contain the delimiter.
    // This file's copy of the guard clause needs its own control, for the same reason the
    // normaliser does: deleting it in one copy must not be silent in the other.
    expect(() => codeWithLiterals(`const x = ${String.fromCharCode(0)};`)).toThrow(/U\+0000/);
    expect(() => stripNonCode(`const x = ${String.fromCharCode(0)};`)).toThrow(/U\+0000/);
    // Reachability: an ordinary source does NOT throw.
    expect(() => codeWithLiterals('const x = 1;')).not.toThrow();
  });

  it('POSITIVE CONTROL — the options-argument reader separates an inline literal from a bundle', () => {
    // The derivation behind `every wrapped route passes an INLINE options object`. A reader
    // that silently returned null for everything would make that check vacuously green.
    const inline = "export default withBlockScope(baseHandler, { endpoint: 'tip' });";
    expect(wrappedExportOptionsArg(inline)?.startsWith('{')).toBe(true);
    expect(wrappedExportOptionsArg(inline)).toMatch(/\bendpoint\b/);
    // A nested call in the FIRST argument must not be mistaken for the separator.
    const nestedFirst = "export default withBlockScope(wrap(h, 1), { endpoint: 'tip' });";
    expect(wrappedExportOptionsArg(nestedFirst)?.startsWith('{')).toBe(true);
    // The two evasions, which must NOT read as an inline literal.
    expect(
      wrappedExportOptionsArg(
        "export default withBlockScope(h, { endpoint: 'tip', ...SERVE_OPTS });"
      )
    ).toContain('...');
    expect(wrappedExportOptionsArg('export default withBlockScope(h, TIP_OPTS);')).toBe('TIP_OPTS');
    // No wrapped default export, and no second argument, are both `null` rather than a throw.
    expect(wrappedExportOptionsArg('export default baseHandler;')).toBeNull();
    expect(wrappedExportOptionsArg('export default withBlockScope(h);')).toBeNull();
  });

  it('the walk reaches real files at every depth the routes actually use', () => {
    const files = walk(API_DIR);
    // A positive control on the walk itself: an empty or shallow walk would make every
    // set comparison below trivially satisfiable by an empty derived set.
    expect(files.length).toBeGreaterThan(100);
    // Two and four segments below `src/pages/api` — `blocks/tip.ts` and
    // `blocks/collections/[id]/follow.ts` — so a depth bug cannot hide a nested route.
    expect(files).toContain('src/pages/api/v1/blocks/tip.ts');
    expect(files).toContain('src/pages/api/v1/blocks/collections/[id]/follow.ts');
  });
});

describe('no unguarded block-REST token verification', () => {
  it('ledgers every withBlockScope route — the population, with a rationale each', () => {
    const derived = blockScopedRoutes();

    expect(
      derived,
      'The set of page routes under src/pages/api that use withBlockScope changed. If you ' +
        'ADDED a block REST route, add it to REST_ROUTE_RATIONALE in this file with a ' +
        'one-line statement of what a SUSPENDED app would reach through it — that sentence ' +
        'is the whole point of the ledger. If one DISAPPEARED it was deleted, renamed, or ' +
        'taken off the wrapper; the last of those is the defect this guard exists for. ' +
        'This fails in both directions on purpose.'
    ).toEqual(Object.keys(REST_ROUTE_RATIONALE).sort());
  });

  it('ledgers the routes that name the wrapper and DECIDED not to use it', () => {
    expect(
      proseOnlyMentions(),
      'A page route names withBlockScope in a comment but nowhere in code. That is either ' +
        'a deliberate non-use — record it in DELIBERATELY_UNWRAPPED with the reason, the ' +
        'way /api/v1/me.ts does — or a route that lost its wrapper and kept the comment, ' +
        'which is the defect. The two are indistinguishable from here, which is why the ' +
        'ledger has to be written by hand.'
    ).toEqual(Object.keys(DELIBERATELY_UNWRAPPED).sort());
  });

  it('every rationale says something — an empty string is not a decision', () => {
    // 🔴 KEYED BY LEDGER, NOT BY ROUTE. These three records overlap: all five
    // LOOKUP_FAILURE_SERVE_RATIONALE keys are ALSO REST_ROUTE_RATIONALE keys, so a merge on
    // the bare route path let the last spread overwrite the first and five exposure
    // rationales — the sentence this file calls the whole point of the ledger — were never
    // checked at all. Measured: emptying `why` on images.ts passed. 13 statements, 8
    // checked. Prefixing the key keeps every one of them.
    const thin = Object.entries({
      ...Object.fromEntries(
        Object.entries(REST_ROUTE_RATIONALE).map(([rel, { why }]) => [`exposure:${rel}`, why])
      ),
      ...Object.fromEntries(
        Object.entries(DELIBERATELY_UNWRAPPED).map(([rel, why]) => [`unwrapped:${rel}`, why])
      ),
      ...Object.fromEntries(
        Object.entries(LOOKUP_FAILURE_SERVE_RATIONALE).map(([rel, why]) => [`optout:${rel}`, why])
      ),
    })
      .filter(([, why]) => why.trim().length < 40)
      .map(([route]) => route);
    expect(
      thin,
      'These ledger entries carry no usable rationale. Say what the route reaches — a ' +
        'read, a write, a spend — not that it is "fine".'
    ).toEqual([]);
  });

  it('every exposure ledger entry declares one of the enumerated classes', () => {
    // The `exposure` field is what the cross-ledger check reads by identity, so a typo'd or
    // invented value must not silently fall outside every comparison. `tsc` already refuses
    // one; this states it as a runtime fact too, since the ledger is data a future edit
    // might widen with `as` or a spread.
    const classes: RestExposure[] = [
      'SPEND',
      'WRITE',
      'READ_VIEWER_SCOPED',
      'READ_APP_SCOPED',
      'READ_PUBLIC',
    ];
    const bad = Object.entries(REST_ROUTE_RATIONALE)
      .filter(([, { exposure }]) => !classes.includes(exposure))
      .map(([rel, { exposure }]) => `${rel}: ${String(exposure)}`);
    expect(bad).toEqual([]);
    // …and the opt-outable class is one of them, so the constant cannot drift out of the union.
    expect(classes).toContain(OPT_OUTABLE_EXPOSURE);
  });

  it('ledgers every route that opts OUT of failing closed on lookup_failed', () => {
    expect(
      lookupFailureServeRoutes(),
      "A route declares `onApprovalLookupFailure: 'serve'` without a ledger entry, or an " +
        'entry names a route that no longer declares it. This option decides what happens ' +
        'when we CANNOT ESTABLISH that an app is allowed to run, so it is not a default a ' +
        'route may acquire quietly: state what a suspended app would obtain through this ' +
        'route that it could not obtain anyway. Failing CLOSED (503) is the default — omit ' +
        'the option entirely unless refusing removes no exposure.'
    ).toEqual(Object.keys(LOOKUP_FAILURE_SERVE_RATIONALE).sort());
  });

  /**
   * 🔴 THE CROSS-LEDGER CHECK, and the reason the opt-out is not just a second hand-list.
   * It ties the declaration to the EXPOSURE ledger that already exists: every route allowed
   * to serve on an unestablished approval status must be classified `READ_PUBLIC`.
   *
   * That is what mechanically keeps the dangerous entries out. `tip.ts` is `SPEND`,
   * `collections/[id]/follow.ts` and `shared-storage/increment.ts` are `WRITE`, so adding
   * the option to any of them fails HERE, on a classification someone already made, rather
   * than depending on a reviewer noticing a new key in a list.
   *
   * 🔴 IT NOW COVERS ALL THREE CLAUSES OF THE RULE THE OPTION'S DOCBLOCK STATES. It used to
   * test `startsWith('READ —')`, which expressed "does not spend" and "does not write" and
   * said NOTHING about "discloses anything scoped to the viewer" — so `collections/index.ts`,
   * `collections/[id]/index.ts` and `tip-allowance.ts` were all admissible. Reading an
   * enumerated `exposure` value instead is what closes it, and it closes it for every route
   * at once rather than for the three that happened to be noticed.
   *
   * ⚠️ STILL A NECESSARY CONDITION, NOT A SUFFICIENT ONE — it can only be as right as the
   * classification in the ledger, which is a human judgement about what a body discloses.
   * What it buys is that the judgement has to be made, spelled as one of five values, and
   * changed deliberately: downgrading a route to `READ_PUBLIC` to get the option is a
   * visible edit to a reviewed line, not the absence of one.
   */
  it('every serve-on-lookup-failure route is READ_PUBLIC in the exposure ledger', () => {
    const notPublicReads = lookupFailureServeRoutes()
      .filter((rel) => REST_ROUTE_RATIONALE[rel]?.exposure !== OPT_OUTABLE_EXPOSURE)
      .map((rel) => `${rel} (${REST_ROUTE_RATIONALE[rel]?.exposure ?? 'UNLEDGERED'})`);
    expect(
      notPublicReads,
      'These routes serve on an unestablished approval status but are not classified ' +
        `${OPT_OUTABLE_EXPOSURE} in REST_ROUTE_RATIONALE. A route that SPENDS, WRITES, ` +
        'discloses viewer-scoped state, or discloses app-private state must fail CLOSED on ' +
        'lookup_failed — drop the option. If the exposure classification is what is wrong, ' +
        'fix that first and say why in its `why` sentence.'
    ).toEqual([]);
  });

  it('every serve-on-lookup-failure route is actually a wrapped route', () => {
    // The option only does anything inside `withBlockScope`. A file declaring it that the
    // wrapper never sees is a misunderstanding worth catching at the point it is written.
    const strays = lookupFailureServeRoutes().filter((rel) => !blockScopedRoutes().includes(rel));
    expect(strays).toEqual([]);
  });

  /**
   * 🔴 THE OPTIONS OBJECT MUST BE READABLE FROM THE ROUTE FILE (clawgate #589, finding 4).
   *
   * `LOOKUP_FAILURE_OPT_OUT_RE` was repaired once already — it used to pin the VALUE as a
   * single-quoted `'serve'`, and `"serve"` walked past it onto `tip.ts` at 21/21 GREEN. The
   * repair moved it to the bare IDENTIFIER, which closes every spelling of the VALUE and
   * NONE of the ways the identifier can be absent from the file while the option is live:
   *
   *     import { SERVE_ON_LOOKUP_FAILURE } from './_shared-opts';
   *     export default withBlockScope(baseHandler, { endpoint: 'tip', ...SERVE_ON_LOOKUP_FAILURE });
   *
   * and the whole-argument form, `withBlockScope(baseHandler, TIP_OPTIONS)`. In both, the
   * route never writes `onApprovalLookupFailure`, so it is outside the derived population —
   * and therefore outside the ledger check, the cross-ledger `READ_PUBLIC` check AND the
   * hand-written fail-closed list, all three of which read that same population. MEASURED
   * before this check, 2026-09-19: the spread form on `tip.ts` — the irreversible Buzz
   * transfer, the highest-value entry in the exposure ledger — passed the pre-change guard
   * whole, 26/26.
   *
   * 🔴 THE REPAIR IS NOT A FOURTH REGEX. Following a spread means resolving an import and
   * reading another module, which is a call graph this file has already declined to build
   * twice, and every such walk has its own next evasion. Instead the SHAPE is pinned: the
   * options argument must be an inline object literal with no spread, so the population scan
   * can read it. That is fail-closed and loud — a route that wants a shared options bundle
   * gets a red naming this assertion, and the answer is to write the option out.
   *
   * ⚠️ WHAT THIS STILL DOES NOT COVER, stated because it is open: the VALUE inside the
   * literal is not evaluated, so `onApprovalLookupFailure: SOME_CONST` is detected as a
   * declaration (correctly — it must be ledgered) but this file cannot say what it resolves
   * to. The type admits only `'serve'`, which is what makes that acceptable rather than a
   * gap, and it is the same reasoning the identifier-not-value repair already rests on.
   */
  it('every wrapped route passes an INLINE options object — a spread or a named bundle hides the opt-out', () => {
    const offenders = blockScopedRoutes()
      .map((rel) => ({ rel, options: wrappedExportOptionsArg(read(rel)) }))
      .filter(
        ({ options }) => options == null || !options.startsWith('{') || options.includes('...')
      )
      // The sentinel stands in for every emptied string body; render it readably, or the
      // failure message arrives as a NUL-bearing blob that tooling reports as binary.
      .map(
        ({ rel, options }) =>
          `${rel}: ${
            options == null
              ? '<no wrapped default export, or no options argument>'
              : options.replace(new RegExp(LITERAL_SENTINEL, 'g'), "'").slice(0, 80)
          }`
      );

    expect(
      offenders,
      'These routes do not pass withBlockScope an inline options object literal. Every ' +
        'check in this file that decides whether a route opted out of failing closed reads ' +
        'the ROUTE FILE for the bare identifier `onApprovalLookupFailure`, so an option ' +
        'arriving by spread (`...SHARED_OPTS`) or as a whole named bundle ' +
        '(`withBlockScope(h, TIP_OPTS)`) is live at runtime and invisible to all of them — ' +
        'including on tip.ts, which SPENDS. Write the options out at the call site. If a ' +
        'shared bundle is genuinely wanted, teaching this file to resolve it is the ' +
        'prerequisite, not an exemption.'
    ).toEqual([]);

    // Report the pair, never the zero: the scan read a real, non-empty population.
    expect(blockScopedRoutes().length).toBeGreaterThan(10);
  });

  /**
   * Stated in the direction a reader will look for it, and HAND-WRITTEN rather than derived:
   * these are the entries whose refusal is the point of the gate. Keeping it a literal list
   * is what makes it a second, independent statement — the assertion after it is what stops
   * the two drifting.
   *
   * ⚠️ It was INCOMPLETE until the exposure classes landed: three routes that must fail
   * closed — `collections/[id]/index.ts`, `collections/index.ts` and `shared-storage/top.ts`
   * — were absent, and since the cross-ledger check above admitted all three, nothing in
   * this file objected to opting any of them in.
   */
  const MUST_FAIL_CLOSED = [
    'src/pages/api/v1/blocks/collections/[id]/follow.ts',
    'src/pages/api/v1/blocks/collections/[id]/index.ts',
    'src/pages/api/v1/blocks/collections/index.ts',
    'src/pages/api/v1/blocks/me.ts',
    'src/pages/api/v1/blocks/shared-storage/increment.ts',
    'src/pages/api/v1/blocks/shared-storage/top.ts',
    'src/pages/api/v1/blocks/tip-allowance.ts',
    'src/pages/api/v1/blocks/tip.ts',
  ];

  it('the money, write and viewer-scoped routes fail CLOSED — the option is absent from all of them', () => {
    for (const rel of MUST_FAIL_CLOSED) {
      expect(declaresLookupFailureOptOut(read(rel)), `${rel} must fail closed`).toBe(false);
    }
  });

  it('the hand-written fail-closed list IS every non-READ_PUBLIC route — both directions', () => {
    // The hand list above is a human statement and the exposure classes are another; this
    // is what keeps them from drifting apart. A new WRITE route that nobody adds to the
    // list fails here, and so does a route quietly reclassified to READ_PUBLIC to get the
    // option — the reclassification has to be paired with removing it from this list, which
    // is the edit a reviewer is looking for.
    expect(
      [...MUST_FAIL_CLOSED].sort(),
      'The hand-written fail-closed list and the routes derived from the exposure ledger ' +
        'disagree. Either a route changed exposure class, or one was added/removed without ' +
        'the other statement being updated.'
    ).toEqual(mustFailClosedRoutes());
  });

  it('THE RELATIONSHIP — every ledgered route WRAPS its default export', () => {
    // 🔴 CODE LINES ONLY, and this file's CENTRAL assertion was fail-OPEN without it. The
    // test used to read the raw file, so a route could satisfy "wraps its default export"
    // with a COMMENTED-OUT wrapper while exporting the bare handler:
    //
    //     // export default withBlockScope(baseHandler, { endpoint: 'me', … });
    //     export default baseHandler;
    //
    // Measured on `blocks/me.ts`: that shape gave 24/24 PASS — no token verification, no
    // revocation check, no approved-status gate, and the guard whose stated purpose is this
    // exact regression said nothing. It is regression #2 from this file's own header, and
    // the same prose-satisfies-a-code-assertion shape as the five instances recorded on
    // `normaliseSource` in the bridge sibling. The population check (`namesWrapperInCode`) already filtered comments; the
    // RELATIONSHIP check did not, so the two halves disagreed about what counts as code.
    const unwrapped = blockScopedRoutes().filter(
      (rel) => !DEFAULT_EXPORT_WRAPPED_RE.test(stripNonCode(read(rel)))
    );

    expect(
      unwrapped,
      'These routes name withBlockScope but do not apply it to their default export, so ' +
        'Next.js dispatches requests straight to the unwrapped handler: no token ' +
        'verification, no revocation check, and no approved-status gate. Most of these ' +
        'files export `baseHandler` separately for their own tests, which is exactly how ' +
        'the bare value ends up one word away from the export.'
    ).toEqual([]);
  });

  it('no page route verifies a block token itself — the wrapper is the only entry point', () => {
    // 🔴 WIDER THAN A CALL CHECK, and deliberately so — the same reasoning as the bridge
    // file's `only in PROSE` assertion. A static import can be aliased and a dynamic
    // `const { verifyBlockToken: v } = await import(...)` defeats both an alias check and
    // a call regex. Pinning the identifier to comment lines only sees all of them.
    // 🔴 NORMALISED, NOT A LEADING-COMMENT REGEX. The line test was
    // `!/^\s*(?:\/\/|\*|\/\*)/`, which drops any line whose FIRST token is a comment — so
    // `/* istanbul ignore next */ const c = await verifyBlockToken(bearer);` was invisible,
    // and this is the ONLY assertion in this file that looks for the bare verifier at all.
    // `codeWithLiterals` removes the comment and leaves the code, and preserves line
    // structure exactly, so the reported numbers still index the original file. Literal
    // bodies are KEPT on purpose: `mod['verifyBlockToken'](t)` must still be an offender.
    const offenders: string[] = [];
    for (const rel of walk(API_DIR)) {
      // Raw pre-filter, per `declaresLookupFailureOptOut`: false positives only.
      if (!DIRECT_VERIFY_RE.test(read(rel))) continue;
      const raw = read(rel).split('\n');
      codeWithLiterals(read(rel), rel)
        .split('\n')
        .forEach((line, i) => {
          if (!DIRECT_VERIFY_RE.test(line)) return;
          offenders.push(`${rel}:${i + 1}: ${(raw[i] ?? line).trim()}`);
        });
    }

    expect(
      offenders,
      'A page route under src/pages/api names verifyBlockToken on a line that is not a ' +
        'comment. A bare verify checks the signature and expiry and NOTHING else — not ' +
        'the install, not the app status — which is precisely the shape the tRPC bridge ' +
        'had before authorizeBlockBridgeToken. Wrap the handler in withBlockScope instead.'
    ).toEqual([]);
  });

  it('the middleware resolves the approval verdict in ONE place', () => {
    // 🔴 SCOPE, STATED NARROWLY ON PURPOSE: this counts calls IN THE MIDDLEWARE, and that
    // is all it claims. It says nothing about a second predicate living in another file —
    // which is a real class, and the ledger test below is what covers it. An earlier
    // version of this file carried only this assertion under the heading "ONE place",
    // which read as a repo-wide claim it could not back; a second copy of the same three
    // steps sat in `block-bridge-auth.service.ts` the whole time, unseen.
    //
    // It is also a SPELLING check: a semantically identical rewrite would fail it, and a
    // call to a WRONG predicate spelled this way would pass it. What pins the behaviour is
    // block-scope.approved-gate.test.ts.
    // 🔴 CODE LINES ONLY, and COUNT THE CALLS, NOT THE LINES — both halves were wrong.
    // (a) The scan read the raw file, and the middleware names this identifier FOUR times
    // (an import, the real call, and two comments). It counted 1 only because none of the
    // comment mentions happens to be followed by `(` — the same luck-of-punctuation the
    // bridge sibling records as its instances (3) and (4). One future sentence writing
    // `resolveRestApprovalVerdict(claims)` in prose flips this to a false RED, and worse:
    // with such a sentence present, DELETING the real call leaves the count at 1 and the
    // gate gone, GREEN. (b) Counting matching LINES means two calls on one line —
    // `cond ? await resolveRestApprovalVerdict(a) : await resolveRestApprovalVerdict(b)` —
    // scored 1, i.e. two predicates passing a check whose message says "exactly once".
    const middleware = stripNonCode(read(MIDDLEWARE));
    const calls = countCalls(REST_VERDICT_CALL_RE, middleware);
    expect(
      calls,
      `${MIDDLEWARE} must call resolveRestApprovalVerdict exactly once. A second call is ` +
        'a second predicate, which is how the thirteen open-coded copies the bridge guard ' +
        'replaced came to disagree with each other.'
    ).toBe(1);
  });
});

/**
 * 🔴 THE REPO-WIDE HALF, and the reason it exists: the middleware check above could not
 * see a second copy of the predicate in another file, and there WAS one —
 * `block-bridge-auth.service.ts` open-coded the same three steps (dev exemption, the
 * `appId_blockId` lookup, `status === 'approved'`) while the middleware check reported
 * "ONE place". The two are now consolidated onto `resolveAppBlockApprovalVerdict`, and
 * this ledger is what makes a THIRD copy visible.
 *
 * WHAT IS DERIVED: every non-test file under the scanned roots that names the
 * `appId_blockId` unique — i.e. that resolves the backing `app_blocks` row directly. That
 * is deliberately WIDER than "takes an approval decision": widening it to the lookup means
 * a new copy is caught at the point it reads the row, before its author has written the
 * comparison, and a site that reads the row for some OTHER purpose costs one ledger line
 * to record. Narrowing it to `status === 'approved'` would let a copy spelled
 * `!== 'approved'`, or one that selects the status and compares it two functions later,
 * through — and those are the shapes a copy actually takes.
 *
 * 🔴 KNOWN LIMITS, stated rather than implied:
 *   - Text, not a call graph, and keyed on the unique's NAME. A lookup that reached the
 *     same row another way — by primary key, through a helper, via a raw query — is
 *     invisible. This catches the copy-the-block-and-edit-it shape, which is the one that
 *     happened, not every conceivable route to the row.
 *   - It cannot tell an approval check from any other use of the row. That is what the
 *     rationale sentence is for, and the test can only check that someone wrote one.
 *   - Scoped to `src/server` and `src/pages`. A lookup somewhere else entirely is outside it.
 */
const BACKING_ROW_SCAN_ROOTS = ['src/server', 'src/pages'];

/** The `app_blocks` compound unique — naming it means resolving the backing row directly. */
const BACKING_ROW_LOOKUP_RE = /\bappId_blockId\b/;

const BACKING_ROW_LOOKUP_LEDGER: Record<string, string> = {
  'src/server/services/blocks/block-approval.service.ts':
    'THE PREDICATE. The one place the row is resolved from token claims and compared against `approved`. Both halves of the runtime — withBlockScope (REST) and assertAppBlockApproved (the tRPC bridge) — resolve their verdict here. Its exemptions are THREE named cases, not the bare `dev` claim (clawgate #571): a signed reviewRunForReal review token, a synthetic id with no backing row, and the owner-dev-tunnel case re-derived from the row owner plus an ACTIVE tunnel. A new approval check belongs in this file or calling it, not beside it.',
  'src/server/routers/apps.router.ts':
    'resolveStorageContext — per-user KV. Reads the row and refuses a non-approved one itself, and is STRICTER than the predicate: it exempts ONLY reviewRunForReal, because per-user KV must resolve to a real Postgres schema and a plain dev token names none. Since clawgate #571 the predicate answers reviewRunForReal first too, so the two now agree about the review sandbox and differ by exactly the owner-dev-tunnel case — correctly, since a suspended app being debugged in its owner tunnel has a page to render but no per-user KV schema to write. Folding this into the predicate would widen an exemption it deliberately does not have.',
  'src/server/routers/apps-shared.router.ts':
    'resolveSharedContext — shared, app-global KV. Same shape, exempts NOTHING: shared storage is cross-user state and run-for-real never grants apps:storage:shared:* at all, so there is no case to exempt. Stricter than both the predicate and resolveStorageContext, for a reason about its target rather than about approval.',
  'src/pages/api/v1/developer/block-manifests.ts':
    'NOT an approval check. The developer manifest-upload path, keyed on an authenticated appId rather than on token claims: it reads the existing row to refuse server-controlled trustTier/renderMode changes, then upserts on the same unique. It gates on trust tier, never on status.',
};

/** Files the walk must skip: test suites are allowed to spell anything. */
function isTestPath(rel: string): boolean {
  return rel.includes('/__tests__/') || /\.test\.tsx?$/.test(rel);
}

function walkSource(relDir: string, out: string[] = []): string[] {
  const abs = path.join(REPO_ROOT, relDir);
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = toPosix(path.join(relDir, entry.name));
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      walkSource(rel, out);
      continue;
    }
    if (!PAGE_EXTENSIONS.includes(path.extname(entry.name))) continue;
    if (isTestPath(rel)) continue;
    out.push(rel);
  }
  return out;
}

/** Non-test source files that resolve the backing `app_blocks` row, on a line of CODE. */
function backingRowLookupSites(): string[] {
  const hits: string[] = [];
  for (const root of BACKING_ROW_SCAN_ROOTS) {
    for (const rel of walkSource(root)) {
      // Raw pre-filter, per `declaresLookupFailureOptOut`: this walk covers ~1,950 files
      // and a handful name the unique, so parsing all of them buys nothing.
      if (!BACKING_ROW_LOOKUP_RE.test(read(rel))) continue;
      // Normalised rather than a leading-comment regex, for the reason given on
      // `no page route verifies a block token itself`: a line opening with a block comment
      // was dropped whole. Literal bodies KEPT — a raw query naming the unique inside a
      // template still resolves the row and still owes a ledger line.
      const names = codeWithLiterals(read(rel), rel)
        .split('\n')
        .some((line) => BACKING_ROW_LOOKUP_RE.test(line));
      if (names) hits.push(rel);
    }
  }
  return hits.sort();
}

describe('the approval predicate is not open-coded a second time', () => {
  it('POSITIVE CONTROL — the lookup regex matches a real lookup and ignores a comment', () => {
    expect(
      BACKING_ROW_LOOKUP_RE.test(
        'where: { appId_blockId: { appId: claims.appId, blockId: claims.blockId } },'
      )
    ).toBe(true);
    expect(BACKING_ROW_LOOKUP_RE.test('select: { status: true },')).toBe(false);
    // The comment filter is the other half: a docblock naming the unique is prose.
    const commentLine = ' * resolved by the same `appId_blockId` unique the siblings use.';
    expect(BACKING_ROW_LOOKUP_RE.test(commentLine)).toBe(true);
    expect(/^\s*(?:\/\/|\*|\/\*)/.test(commentLine)).toBe(true);
  });

  it('POSITIVE CONTROL — the walk reaches both roots, deeply, and skips test files', () => {
    const files = BACKING_ROW_SCAN_ROOTS.flatMap((root) => walkSource(root));
    // An empty or shallow walk would make the set assertion below trivially satisfiable.
    expect(files.length).toBeGreaterThan(500);
    expect(files).toContain('src/server/services/blocks/block-approval.service.ts');
    expect(files).toContain('src/pages/api/v1/blocks/collections/[id]/follow.ts');
    expect(files.filter(isTestPath)).toEqual([]);
  });

  it('LEDGERS every site that resolves the backing app_blocks row', () => {
    expect(
      backingRowLookupSites(),
      'The set of non-test files that resolve an app_blocks row by its (appId, blockId) ' +
        'unique changed. If you ADDED one, add it to BACKING_ROW_LOOKUP_LEDGER with a ' +
        'one-line statement of what it does with the row — and if that is an APPROVAL ' +
        'check, it is a second copy of the predicate: call resolveAppBlockApprovalVerdict ' +
        'instead. If one DISAPPEARED it was deleted, renamed, or consolidated. This fails ' +
        'in both directions on purpose, and it is the only check here that can see a ' +
        'second predicate in another FILE.'
    ).toEqual(Object.keys(BACKING_ROW_LOOKUP_LEDGER).sort());
  });

  it('every ledger entry says what the site does with the row', () => {
    const thin = Object.entries(BACKING_ROW_LOOKUP_LEDGER)
      .filter(([, why]) => why.trim().length < 40)
      .map(([file]) => file);
    expect(
      thin,
      'These entries carry no usable rationale. Say whether the site takes an approval ' +
        'decision, and if it does, why it is not calling the shared predicate.'
    ).toEqual([]);
  });

  /**
   * The consolidation itself, as a standing assertion rather than a moment in history: the
   * bridge guard must resolve its verdict through the predicate and must not resolve the
   * row itself. The ledger above already fails if that file reappears in the derived set —
   * this states the same fact in the direction a reader will look for it, and names the
   * call that has to be there.
   */
  it('the tRPC bridge guard delegates to the predicate instead of re-reading the row', () => {
    // 🔴 CODE LINES ONLY. A whole-file `toMatch` is satisfiable by a DOCBLOCK that merely
    // NAMES the call — and the guard's docblock does name it (`block-bridge-auth.service`
    // line ~138, describing the shared lookup). This assertion was non-vacuous only by
    // luck of punctuation: that mention is followed by a backtick, which `\s*` cannot
    // bridge to a `(`. One future sentence writing `resolveAppBlockApprovalVerdict(claims)`
    // in prose would have re-inerted it silently, and a spelling check its own prose
    // satisfies reads as coverage while providing none. The same shape was found and fixed
    // three other times in this family — see `normaliseSource` in the bridge sibling,
    // which records all five.
    const guard = stripNonCode(read('src/server/services/blocks/block-bridge-auth.service.ts'));
    expect(countCalls(SHARED_VERDICT_CALL_RE, guard)).toBeGreaterThan(0);
    expect(BACKING_ROW_LOOKUP_LEDGER).not.toHaveProperty(
      'src/server/services/blocks/block-bridge-auth.service.ts'
    );
  });
});
