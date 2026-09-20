import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Every tRPC procedure on the host↔block postMessage bridge must resolve its claims
 * through `authorizeBlockBridgeToken`, never through `verifyBlockToken` directly.
 *
 * `verifyBlockToken` answers one question — is this a token we signed, not yet expired.
 * It cannot see an uninstall, a toggle-off or a suspended app.
 *
 * 🔴 A BANNED PUBLISHER IS BACK IN SCOPE, AND THE HISTORY MATTERS. This list and
 * the failure message below named a banned publisher while nothing wrote a
 * revocation marker on ban; that was removed on 2026-09-16 because routing a proc
 * through the guard genuinely did NOT contain a ban. As of clawgate #618 it does:
 * `toggleBan` calls `revokeBlockInstancesForPublisher`
 * (`blocks/publisher-ban-revocation.service.ts`), so the marker the guard already
 * checks is now written on ban too, for every live instance of every block the
 * banned user OWNS. Note the narrowness before restating it anywhere: a
 * collaborator seat on somebody else's app is not covered, and containment is on
 * the NEXT bridge call, not mid-request. See `block-scope.middleware.ts` for the
 * three-call-site enumeration.
 *
 * The bridge procs each called it directly and checked none of those, so a revoked install
 * kept driving the bridge — orchestrator polls, workflow cancels, and
 * `publishGenerationOutputs`, which persists public `Image` rows — until the token
 * expired on its own. The REST `withBlockScope` wrapper never had this gap.
 *
 * WHY A GUARD AND NOT A TYPE. Nothing in the type system can require a check that
 * happens INSIDE a resolver. And the realistic regression is not someone deleting the
 * helper — it is the fourteenth bridge proc, written by copying the thirteenth's opening
 * lines, whose reviewer has no reason to know that `await verifyBlockToken(...)` is the
 * one shape that must not appear in this file.
 *
 * A RELATIONSHIP, NOT A COUNT. Two ledgers below, each compared as a SET, each failing in
 * both directions on purpose. A bare count would satisfy both halves of a swap (one proc
 * unguarded, one added) and pin nothing.
 *
 *   `GUARD_CALL_SITE_LEDGER` — who CALLS the guard, by owning procedure or helper.
 *     A site disappears (a proc deleted, renamed, or quietly moved back onto a bare
 *     `verifyBlockToken`) and the set shrinks; a site appears and is not ledgered, so a
 *     new bridge proc gets looked at by whoever adds it rather than inheriting coverage.
 *
 *   `BRIDGE_INPUT_LEDGER` — who TAKES a `blockToken`, i.e. the population that has to
 *     reach the guard at all.
 *
 * 🔴 WHY THE SECOND LEDGER EXISTS, AND WHAT THE FIRST ONE COULD NOT SEE. Until it was
 * added, this file keyed on calls to `authorizeBlockBridgeToken` and on the literal
 * spelling `verifyBlockToken(` — both of which a procedure that verifies NOTHING AT ALL
 * satisfies vacuously. Measured: a proc added to `blocks.router.ts` taking `blockToken`
 * in its input and base64-decoding the JWT payload inline, with no verification of any
 * kind, left this file at 7 passed / 0 failed. A file called
 * `no-unguarded-block-bridge-token` could not see an unguarded bridge token. The second
 * ledger plus `reaches the guard` below is what closes that: the population is derived
 * from the router's `.input(...)` shapes, not from the ledger, so a proc cannot enter the
 * population and stay out of the check.
 *
 * 🔴 AND WHAT THAT LEDGER, AS FIRST WRITTEN, STILL COULD NOT SEE. A population derived
 * from the router only covers procs the derivation can READ, and four things could make a
 * proc unreadable while every assertion stayed green: an `.input()` schema behind a
 * `.extend(…)` / `.merge(…)` / factory call rather than a bare identifier (`unresolved`
 * demanded resolution only for the bare case); a schema chain deeper than the depth cap; a
 * proc chunk cut short by a column-zero line (specifically a column-zero line in the
 * COMMENT-STRIPPED view — a template-literal continuation, not a block-comment body line, which
 * is pinned NOT to cut); and a proc nested in a sub-router. Each is
 * now either closed or ledgered-and-asserted — `schemaIdentifiers`, `truncated`,
 * `every proc chunk keeps its own terminator`, and `PROC_RE`'s indent respectively. The
 * generalisation worth keeping: for a DERIVED population, "this procedure is not in the
 * set" and "this procedure could not be parsed" have to be different outcomes, or the
 * second one hides inside the first.
 *
 * 🔴 WHAT IS STILL OUT OF REACH — do not read this file as wider than it is. Every entry
 * below is a limit that is OPEN, stated because it is open. Where a limit was closed in a
 * later round it was moved out of this list, not softened inside it.
 *   - A bridge proc that carries the token under some other input field name. The
 *     population is derived from the literal field `blockToken`; a `token:` or `jwt:`
 *     field is invisible here. That spelling is the repo's convention across every proc in
 *     `BRIDGE_INPUT_LEDGER` (17 of them, measured 2026-09-19 — the long-quoted "15" was
 *     stale), but it is a convention, not something this test enforces.
 *   - 🔴 A NESTED SCHEMA REFERENCE THE CANDIDATE FILTER REJECTS BEFORE THE WALK EVER RUNS, AND
 *     THIS IS THE WIDEST HOLE ON THE LIST — it is a live fail-OPEN, not a latent shape.
 *     `schemaCarriesBlockToken` only descends into a name for which `definitionText` finds a
 *     `const|let|var` declaration in the same file, or which that file's `import { … } from`
 *     map carries. Anything else is `continue`d: no recursion, so no `null`, so NOTHING in
 *     `unresolved`, `truncated` or `NESTED_UNREADABLE_LEDGER`, and the branch is scored as
 *     carrying no token. The proc then leaves the population with BOTH ledgers silent — the
 *     merged outcome this header forbids two paragraphs above.
 *     MEASURED, and the pair is the whole argument: a proc whose token arrives through a
 *     `function`-declared factory referenced at depth ≥ 1 passed the suite 36/36 SILENTLY;
 *     the byte-identical source with that factory written `const f = () => …` failed 2 tests
 *     naming the proc. One variable, opposite verdicts.
 *     The class is everything the two readers miss: a local `function`, `type`, `interface`,
 *     `class` or `enum` declaration; a default or namespace import (`importMap` parses named
 *     `import { … } from` only); a re-exported declaration (`export … from`, which `importMap`
 *     also does not parse); and a `$`-bearing name.
 *     🔴 THE `$` HOLE IS AT BOTH SITES, NOT JUST THE NESTED ONE — an earlier draft of this entry
 *     blamed only the nested candidate regex (`[A-Za-z_][A-Za-z0-9_]*`, no `$`), which would
 *     have sent someone to widen one character class and believe they had closed it. The DEPTH-0
 *     regex in `schemaIdentifiers` has `$` in its class but a `\b` in front of it, and `$` is
 *     not a word character, so the boundary cannot match before it either. MEASURED:
 *     `schemaIdentifiers('$bridgeInput')` returns `['bridgeInput']` and
 *     `schemaIdentifiers('$a.extend({}))')` returns `['a']`. At depth 0 that mangled name is
 *     then REQUIRED to resolve, so it either reds against a name nobody wrote or — the bad case
 *     — resolves against a DIFFERENT declaration that happens to bear the trimmed name, with
 *     `unresolved` staying empty. Both sites need fixing together, and neither is fixed here:
 *     no `$`-bearing schema exists in the corpus, and widening the classes moves the walk.
 *     Widening `findDefinitionText` to read `function` was tried and BACKED OUT, deliberately:
 *     it closes this and moves no verdict (`procs`, `unresolved` and the nested ledger all
 *     unchanged), but the deeper walk pushes two chains in
 *     `src/server/services/blocks/app-cap-limits.constants.ts` to depth 13, which trips
 *     `truncated` against `MAX_SCHEMA_DEPTH`. With the cap lifted the walk terminates on its
 *     own with nothing truncated, so the fix is viable — it needs a cap change, which is a
 *     separate decision and is not taken here.
 *   - Verification performed in a module this file does not read. Reachability is
 *     computed inside `blocks.router.ts` only: a proc that delegates to an imported
 *     helper which calls the guard reads as UNGUARDED here and will fail. That is
 *     deliberate (fail-closed), but it means the answer is "reaches the guard from within
 *     the router", not "is authorized".
 *   - `verifyBlockToken` reached WITHOUT SPELLING ITS NAME in the router — a computed
 *     member access (`mod['verify' + 'BlockToken']`), or a re-export under a different
 *     name in another module. `DIRECT_CALL_RE`, the import-alias assertion and the wider
 *     `only in prose` assertion are all SPELLING checks on that one identifier, and none
 *     of them can see a name that is never written. What covers that case is not a
 *     spelling check at all — it is `THE RELATIONSHIP`, which asks whether the proc
 *     reaches `authorizeBlockBridgeToken`, and does not care what else it calls.
 *   - Reachability is a TEXTUAL call-graph over the router, so it answers "the guard's
 *     name appears in a body that runs" — not "the guard is awaited on every path". A
 *     call behind a `if (someFlag)` reads as reaching it.
 *   - A tRPC procedure terminated by a METHOD NAME other than `mutation` / `query` /
 *     `subscription`. `attributes every tRPC terminator to a named procedure` is what
 *     backstops `PROC_RE`'s spelling of the BUILDER, and it counts those three names in
 *     either access form (`.mutation(` and `['mutation'](` alike, from the parse) — so the
 *     residue is a future builder METHOD, which would carry a procedure out of the
 *     population and out of the backstop together.
 *   - The VALUE of an option inside a route's `withBlockScope` literal, in the REST
 *     sibling. That file pins the literal's SHAPE so the option is readable; it does not
 *     evaluate `onApprovalLookupFailure: SOME_CONST`.
 *
 * 🔴 WHAT CHANGED IN THE 2026-09-19 SPELLED-GUARD PASS (clawgate #589), because a reader
 * comparing this file to its own history should not have to diff it. Six fail-open spelled
 * guards, each measured GREEN under its own evasion before the repair and RED after:
 *   1. `PROC_RE` pinned the BUILDER's spelling — `evasiveProc: t.procedure` taking a
 *      `blockToken` and guarding nothing passed 22/22. Backstopped by terminator attribution.
 *   2. `GUARD_CALL_RE` ran on RAW chunk text, so commenting out `getMyViewer`'s guard call
 *      and decoding the token instead passed 22/22. `chunks` now carries a normalised slice.
 *   3. `scan(read(GUARD)).direct` counted matching LINES of RAW text, so one prose sentence
 *      writing `verifyBlockToken(blockToken)` let the REAL call be deleted at 22/22. It now
 *      counts CALLS on normalised code.
 *   4. (REST sibling) the opt-out population could not see the option arriving by object
 *      spread; `tip.ts` opted out at 26/26.
 *   5. `RESERVED_WORDS` was unpinned while `MODULE_EXEMPTIONS` was pinned — adding
 *      `'someNewBridgeSchema'` suppressed an identifier at 22/22.
 *   6. `codeLinesOnly` stripped comments and NOT strings, so a `const doc = "status ===
 *      'approved'";` beside a comparison weakened to `!== 'suspended'` passed 22/22.
 * The generalisation: a guard that pins a CONCEPT by matching one SPELLING is walkable by
 * writing the concept another way, and every one of these six was walkable in the fail-OPEN
 * direction while reading as coverage.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const ROUTER = 'src/server/routers/blocks.router.ts';
const GUARD = 'src/server/services/blocks/block-bridge-auth.service.ts';
/** The shared row-lookup + `approved` comparison both halves of the runtime resolve through. */
const APPROVAL_PREDICATE = 'src/server/services/blocks/block-approval.service.ts';
/**
 * Reached by the schema walk, and — measured on the committed router — the one place in the
 * real corpus where it hits a reference it cannot read BELOW depth 0:
 * `import { TokenScope } from './token-scope.constants'`, a RELATIVE specifier
 * `resolveModule` refuses by design. Named once so `NESTED_UNREADABLE_LEDGER` and the control
 * that exercises it cannot drift to two spellings of the same path.
 */
const BLOCK_SCOPE_CONSTANTS = 'src/shared/constants/block-scope.constants.ts';

/**
 * The bridge call sites, by owning procedure. `authorizeBlockBuzzRead` is the router's
 * own buzz self-read helper — it is a call SITE like any other, and the three procs behind
 * it (`getMyBuzzAccounts`, `getMyBuzzTransactions`, `getMyDailyCompensation`) reach the
 * guard through it, which is why they appear in the population ledger below but not here.
 *
 * ⚠️ Named rather than wildcarded: `getMyBuzzBalance` is a `getMyBuzz*` proc that does NOT
 * go through the helper — it calls the guard directly, which is why it is listed here in
 * its own right. A `getMyBuzz*` shorthand gets that exactly backwards in both directions.
 */
const GUARD_CALL_SITE_LEDGER = [
  'authorizeBlockBuzzRead',
  // The router's own post-bridge preamble helper: `previewPostFromApp` and
  // `createPostFromApp` BOTH reach the guard through it (and through nothing
  // else), which is why they appear in the population ledger below but not here
  // — the same shape as `authorizeBlockBuzzRead`. It is a router-local
  // `async function` on purpose: reachability is computed textually INSIDE
  // `blocks.router.ts`, so a preamble living in an imported service would read as
  // UNGUARDED.
  'authorizeBlockPostRequest',
  'cancelAppWorkflow',
  'cancelWorkflow',
  'estimateWorkflow',
  'getImagesByIds',
  'getMyBuzzBalance',
  'getMyViewer',
  'listMyWorkflows',
  'pollWorkflow',
  'publishGenerationOutputs',
  'queryAppWorkflows',
  'submitWorkflow',
  'updateUserSettings',
].sort();

/**
 * THE POPULATION: every procedure in `blocks.router.ts` whose `.input(...)` carries a
 * `blockToken` field — 12 spelled inline in the router, and 3 arriving through schemas
 * imported from `~/server/schema/buzz.schema`: `getMyBuzzAccounts`,
 * `getMyBuzzTransactions` and `getMyDailyCompensation`. (Named, not `getMyBuzz*`: that
 * wildcard excludes `getMyDailyCompensation`, which is one of the three, and includes
 * `getMyBuzzBalance`, which is not — its input is spelled inline.) Derived, not
 * hand-listed: this ledger is the SET the derivation must reproduce, so adding a bridge
 * proc fails here whether or not its author knew this file existed.
 */
const BRIDGE_INPUT_LEDGER = [
  'cancelAppWorkflow',
  'cancelWorkflow',
  'estimateWorkflow',
  'getImagesByIds',
  'getMyBuzzAccounts',
  'getMyBuzzBalance',
  'getMyBuzzTransactions',
  'getMyDailyCompensation',
  'getMyViewer',
  'listMyWorkflows',
  'pollWorkflow',
  // The two halves of the CREATE_POST_FROM_APP bridge. Both take a `blockToken`
  // and both reach the guard via `authorizeBlockPostRequest`, above. They are
  // listed SEPARATELY rather than as a `*PostFromApp` shorthand for the reason
  // the `getMyBuzz*` note gives: a wildcard is a claim about names, and names are
  // not the population.
  'createPostFromApp',
  'previewPostFromApp',
  'publishGenerationOutputs',
  'queryAppWorkflows',
  'submitWorkflow',
  'updateUserSettings',
].sort();

/**
 * `  someProc: publicProcedure` — the router's procedure definitions. The indent is
 * `{2,}`, not `{2}`, so a proc nested inside a sub-router (`sub: router({ … })`, which
 * indents its members by four) is still seen. Pinning two spaces meant a whole sub-router
 * yielded an EMPTY population — every proc in it silently outside the check. There are no
 * sub-routers in `blocks.router.ts` today (measured 2026-09-19: 75 procs, all at two spaces,
 * zero at three or more), so this is a latent shape being closed, not a bug being fixed.
 *
 * 🔴 IT IS STILL A SPELLED GUARD, AND THIS IS WHAT NOW BACKSTOPS IT (clawgate #589,
 * finding 1). The trailing `[A-Za-z0-9_]*[Pp]rocedure` pins the BUILDER'S SPELLING, so this
 * regex does not see the canonical tRPC `t.procedure` (the `.` is outside the character
 * class), a quoted key (`'someProc': publicProcedure`), or a factory
 * (`someProc: makeProcedure()` — no `\b` boundary where it needs one). Any of those leaves
 * the proc out of the DERIVED POPULATION entirely, which is the "scored as carrying no
 * token" outcome `bridgeInputProcs` promises never happens, and the only thing that would
 * have noticed is the `> 50` magnitude control against a measured 75 — blind to a
 * systematic miss of up to ~30%.
 *
 * The regex is NOT widened: every shape that could name a procedure is another spelling, and
 * a rule that matched `  anyKey: anything` would swallow the router's ordinary object
 * literals. What closes it instead is a DERIVED cross-check on a different surface —
 * `attributes every tRPC terminator to a named procedure` — which counts the
 * `.mutation(`/`.query(`/`.subscription(` terminators in the file and requires every one to
 * land inside exactly one chunk this regex opened. A procedure spelled any other way still
 * has to end in one of those, so its terminator either lands in a NEIGHBOURING chunk (giving
 * that chunk two) or in none at all (leaving the totals short). Both go RED.
 */
const PROC_RE = /^ {2,}([A-Za-z0-9_]+):\s*[A-Za-z0-9_]*[Pp]rocedure\b/;
/**
 * A module-scope helper, in EITHER declaration form: `async function someHelper(` or
 * `const someHelper = async (`. The `function`-only version made every proc behind an
 * arrow-function helper read as UNGUARDED — fail-closed and loud, but a false red on a
 * legitimate refactor, and the docstring above promises router-local delegation is covered
 * generally. `blocks.router.ts` has no module-scope arrow helpers today (measured: zero
 * matches for a column-zero `const x = (`), so this too is a latent shape.
 */
const FN_RE =
  /^(?:export )?(?:async )?function ([A-Za-z0-9_]+)|^(?:export )?const ([A-Za-z0-9_]+)\s*=\s*(?:async\s*)?\(/;

/** The declared name from an `FN_RE` match, whichever of its two alternatives matched. */
function fnName(line: string): string | null {
  const m = FN_RE.exec(line);
  return m ? m[1] ?? m[2] ?? null : null;
}

/** A CALL, not a type position — `ReturnType<typeof verifyBlockToken>` must not count. */
const DIRECT_CALL_RE = /\bverifyBlockToken\s*\(/g;
const GUARD_CALL_RE = /\bauthorizeBlockBridgeToken\s*\(/g;

/** How many times `re` (a /g/ regex) matches `text` — CALLS, not lines carrying one. */
function countCalls(re: RegExp, text: string): number {
  return (text.match(re) ?? []).length;
}

/**
 * The owner of each `authorizeBlockBridgeToken(` call in `source`, plus every direct call.
 *
 * 🔴 READS NORMALISED CODE, AND COUNTS CALLS RATHER THAN LINES. Both halves were wrong
 * (clawgate #589, finding 3) and both fail OPEN:
 *
 * (a) It scanned the RAW text, so a COMMENT or a string naming either identifier with an
 * argument list counted as a call. The `keeps the verification in ONE place` assertion below
 * is `direct.length === 1` over `block-bridge-auth.service.ts`, a file that names
 * `verifyBlockToken` four times and counted 1 only because none of the three prose mentions
 * happens to be followed by `(` — the same luck-of-punctuation recorded as instances (3) and
 * (4) on `codeWithLiterals`. One future sentence writing `verifyBlockToken(blockToken)` in
 * prose and the check reads 2 (a false RED); one such sentence PLUS deletion of the real
 * call and it reads 1 with the verification gone (GREEN, and the gate is off). The same
 * applies to `guarded`: a commented-out guard call above a proc that no longer makes one
 * leaves both the call-site ledger and `THE RELATIONSHIP` satisfied.
 *
 * (b) It pushed one entry per matching LINE, so `cond ? verifyBlockToken(a) : verifyBlockToken(b)`
 * scored 1 — two verifications passing a check whose message says "exactly once". The REST
 * sibling had already fixed this on its own predicate count; this copy had not.
 *
 * Line numbers survive the normalisation (`codeWithLiterals` re-emits every newline in place),
 * so the numbers reported here still index the original file.
 */
function scan(source: string): { guarded: string[]; direct: number[] } {
  const lines = stripNonCode(source).split('\n');
  const guarded: string[] = [];
  const direct: number[] = [];

  lines.forEach((line, i) => {
    for (let n = countCalls(DIRECT_CALL_RE, line); n > 0; n--) direct.push(i + 1);
    for (let n = countCalls(GUARD_CALL_RE, line); n > 0; n--) {
      let owner: string | null = null;
      for (let j = i; j >= 0 && owner == null; j--) {
        const proc = PROC_RE.exec(lines[j]);
        owner = proc ? proc[1] : fnName(lines[j]);
      }
      guarded.push(owner ?? `<no owner resolved at line ${i + 1}>`);
    }
  });

  return { guarded, direct };
}

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
 *       Measured 2026-09-19 over 1,724 files under `src/server` and `src/pages`, the lexer's
 *       notion of "what is code" disagreed with the parser's on 858 of them — and that wider
 *       sweep, rather than the 345 these two suites read, is the number actually taken, so
 *       read it as "this is endemic in the corpus", not as a rate for the scanned set.
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
 *   - It PARSES, so a fragment is parsed as a fragment. A ` * …` docblock continuation fed in
 *     isolation is not a comment to a parser any more than it is to a reader — there is no
 *     `/**` open above it — so every comment fixture below is a whole block. One caller
 *     feeds it a fragment ON PURPOSE: `schemaIdentifiers` hands it a single `.input(...)`
 *     argument, which is a complete EXPRESSION and parses as one.
 *     🔴 `unresolved` IS NOT THE TELL FOR THAT, AND THE CLAIM THAT IT WAS POINTED THE WRONG
 *     WAY. An earlier draft here said a fragment the parser could not make sense of would
 *     fill `unresolved` with word-shaped noise. That is the UNDER-strip direction only —
 *     trivia leaking out as code — and it is real. The OVER-strip direction is the mirror
 *     image and `unresolved` is structurally blind to it: over-stripping REMOVES candidates,
 *     so it produces an EMPTY `unresolved`, which is exactly what every assertion in this
 *     file expects to see. What covers it is a control that requires real code to SURVIVE,
 *     which is `an annotated argument KEEPS its schema identifier` below; `unresolved` being
 *     empty against the real router is evidence about under-stripping and nothing else.
 *
 *     🔴 AND THE GAP WAS IN THE EMPTIED VIEW SPECIFICALLY. Stated that precisely because the
 *     first version of this paragraph claimed "the whole suite stayed GREEN at 32/32" for "an
 *     over-strip" without saying WHERE the over-strip was applied — and a reviewer who
 *     implemented the sentence as written, in the shared normaliser, measured a RED and was
 *     right to challenge it. That is this file's own failure mode: a docstring claiming more
 *     than the measurement behind it. The two variants, both blanking the remainder of a
 *     comment's own line, differ only in which function they patch:
 *       - in `stripNonCode` ALONE, leaving `codeWithLiterals` untouched — the pre-change
 *         suite passed 32/32. NOT caught.
 *       - in the SHARED `normaliseSource`, so both views over-strip — the pre-change suite
 *         went red on `the normalisers preserve the line structure exactly`. CAUGHT.
 *     The asymmetry IS the finding, and it is mechanical: that control asserts code after a
 *     same-line block comment survives `codeWithLiterals`, and code BEFORE a line comment
 *     survives `stripNonCode`. So the KEPT view had a survival assertion and the EMPTIED view
 *     had none — which is the hole `an annotated argument KEEPS its schema identifier` fills.
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
    // 🔴 TOKENS TOO, NOT ONLY NODES — AND THIS WAS A LIVE FAIL-OPEN, NOT A TIDY-UP. The walk
    // recurses with `forEachChild`, which visits NODES and skips pure tokens. So a comment
    // whose following token is punctuation — the `.` between two links of a call chain — is
    // leading trivia of nothing this walk ever asked about, and survived normalisation intact.
    //
    // MEASURED, and it is finding (2) of clawgate #589 reopened one position further out: a
    // procedure with `/* await authorizeBlockBridgeToken(input.blockToken) */` on its own line
    // between `.input(...)` and `.mutation(...)`, verifying nothing, was returned by
    // `procsReachingGuard` — while the IDENTICAL comment inside the `.mutation` body was
    // correctly stripped and returned nothing. The position was the only variable. On the real
    // router, 18 of 157 block-comment openers were surviving normalisation this way.
    //
    // A token IS part of the parse, so this keeps the parser as the authority and does not
    // reintroduce the lexer hazards the docstring on `codeWithLiterals` records — in
    // particular a regex literal's `//` is still never mistaken for a comment.
    //
    // 🔴 BOTH HALVES, AND THE TRAILING ONE WAS DELETED ONCE AND RESTORED. What the census says:
    // over the three files these suites read there are 3,782 distinct comment positions, the
    // node-level pair accounts for 3,610, token-level LEADING is the sole source for 172, and
    // token-level TRAILING is the sole source for 0.
    //
    // 🔴 THAT NUMBER IS A FACT ABOUT THREE FILES, NOT A PROPERTY OF THE LANGUAGE, AND READING IT
    // AS THE SECOND IS WHAT REOPENED A FAIL-OPEN. The deletion was justified with "every
    // same-line trailing comment is already reached by the node-level call", which is FALSE:
    // `getLeadingCommentRanges` deliberately skips a comment sharing a line with the code before
    // it, so a same-line comment following a pure TOKEN — `(`, `=`, `.`, `:`, `return` — is
    // trailing trivia of that token and of nothing else. MEASURED with the line deleted, on a
    // procedure carrying a commented-out guard call after `.mutation(`:
    //   `procsReachingGuard` returned the procedure — it verifies nothing and read as GUARDED;
    //   `scan().guarded` returned it too, i.e. the comment registered as a real call SITE;
    //   a comment after `=` in a module-scope helper survived the same way.
    // That is exactly the outcome `scan`'s own docstring says reading normalised code prevents.
    //
    // So the honest state, which is also what this file says twice elsewhere about a latent
    // shape: the trailing half is UN-EXERCISED on today's corpus, not unreachable, and it is kept
    // because closing a latent shape costs nothing. Restoring it is free — 42/42 green, every
    // real-router value identical. `a trailing comment after a pure TOKEN is not a guard call`
    // below is the control, so the next census cannot be read as a licence to delete it again.
    //
    // ⚠️ THE LEAF TEST BELOW IS AN OPTIMISATION, NOT A CORRECTNESS GUARD — measured, because it
    // reads like one. Replacing `getChildCount(sourceFile) === 0` with `true` leaves the suite
    // green and every real-router value identical: `addComments` already dedupes by position, and
    // a non-leaf node's trivia is trivia the node-level call above already collected. It is kept
    // only to avoid re-asking for ranges already gathered.
    for (const child of node.getChildren(sourceFile)) {
      if (child.getChildCount(sourceFile) === 0) {
        addComments(ts.getLeadingCommentRanges(source, child.getFullStart()));
        addComments(ts.getTrailingCommentRanges(source, child.end));
      }
    }
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

/**
 * `status === 'approved'` IN A CODE POSITION, over `codeWithLiterals` output.
 *
 * 🔴 A LITERAL IS GENUINELY REQUIRED HERE — the claim is about the VALUE compared against, so
 * the emptied view cannot express it — and this is what keeps it from being a SPELLED guard
 * anyway: the normaliser renders `'approved'`, `"approved"` and `` `approved` `` identically
 * as `<sentinel>approved<sentinel>`, so the assertion is indifferent to quote style and to
 * padding, while a string that merely CONTAINS the expression cannot produce the sentinels.
 * `the approved comparison is pinned by VALUE, not by quote style` is the control over those
 * spellings.
 *
 * What it cannot see, ALL fail-CLOSED (a correct comparison written this way goes red, which
 * is a false alarm on a legitimate refactor — the blast radius this whole change runs toward
 * rather than away from) and all stated because they are open:
 *   - a comparison against a CONST, `status === APPROVED_STATUS`;
 *   - REVERSED operands, `'approved' === block.status`;
 *   - loose equality, `status == 'approved'`.
 * The cure in each case is to write the comparison the way the predicate writes it today, or
 * to widen this regex deliberately. The controls below pin all three as non-matching, so the
 * list is a fact rather than a recollection.
 */
const APPROVED_COMPARISON_RE = new RegExp(
  `\\bstatus\\s*===\\s*${LITERAL_SENTINEL}approved${LITERAL_SENTINEL}`
);

/**
 * Cached, because the schema walk below asks the same few files for the same identifiers
 * hundreds of times (every word inside every `.input(z.object({…}))` is a candidate). The
 * caches are pure memoisation of file content and of what was parsed out of it — measured
 * on this suite, 7.16s of test time uncached against 1.58s cached.
 */
const fileCache = new Map<string, string | null>();
function readIfPresent(rel: string): string | null {
  if (!fileCache.has(rel)) {
    const abs = path.join(REPO_ROOT, rel);
    fileCache.set(rel, fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null);
  }
  return fileCache.get(rel) ?? null;
}

const definitionCache = new Map<string, string | null>();
const importCache = new Map<string, Map<string, { spec: string; imported: string }>>();

// ---------------------------------------------------------------------------
// The population scan: which procedures TAKE a block token, and do they reach
// the guard. Everything below is text — the router is not importable here (it
// pulls the whole server graph), which is the same reason `scan` above is text.
// ---------------------------------------------------------------------------

/**
 * `text` is the RAW slice; `code` is the same slice with comments removed and string bodies
 * emptied. Both are carried because they answer different questions and the file has been
 * wrong about which is which: the population test deliberately reads the RAW `.input(`
 * argument (a `blockToken` named only in a comment there enters the population, which is the
 * fail-CLOSED direction), while every "does this reach the guard" decision must read `code`
 * or a comment satisfies it.
 */
type Chunk = { name: string; kind: 'proc' | 'fn'; text: string; code: string };

/** The `.mutation(` / `.query(` / `.subscription(` that terminates a tRPC procedure. */
const PROC_TERMINATOR_RE = /\.(mutation|query|subscription)\s*\(/g;

/** The three method names that terminate a tRPC procedure. */
const PROC_TERMINATOR_NAMES = new Set(['mutation', 'query', 'subscription']);

/**
 * The same count, taken from the PARSE rather than from the text — and it sees one shape the
 * regex cannot. `.mutation(` as written is a property access; `['mutation'](` is an ELEMENT
 * access on the identical method, and the normalised text of that is `[\u0000\u0000](`, which
 * matches nothing. MEASURED during clawgate #589's own review: a procedure spelled
 * `evasiveProc: t.procedure.input(...)['mutation'](...)` escaped `PROC_RE` AND the text
 * terminator count together, leaving the file green with an unguarded bridge token — the
 * exact hole the terminator backstop exists to close, reached one spelling further out.
 *
 * Counting both forms structurally is what makes the totals disagree instead. The docstring
 * on `attributes every tRPC terminator to a named procedure` states what remains open.
 */
function astTerminatorCount(source: string, rel: string): number {
  const sourceFile = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true);
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isPropertyAccessExpression(callee) && PROC_TERMINATOR_NAMES.has(callee.name.text)) {
        count++;
      } else if (
        ts.isElementAccessExpression(callee) &&
        ts.isStringLiteralLike(callee.argumentExpression) &&
        PROC_TERMINATOR_NAMES.has(callee.argumentExpression.text)
      ) {
        count++;
      }
    }
    node.forEachChild(visit);
  };
  visit(sourceFile);
  return count;
}

/**
 * Split a module into top-level chunks: one per `  someProc: publicProcedure` and one per
 * module-scope helper (`function someHelper(` or `const someHelper = async (`). A chunk
 * ends at the next chunk, or at the next line that starts in COLUMN ZERO with a letter or
 * `}` — which is `});` closing the router, or a following `const`/`export`/`function`.
 * Everything inside a proc or a function body is indented, so that boundary is the file's
 * own formatting rather than a brace count.
 *
 * 🔴 "COLUMN ZERO" MEANS IN THE COMMENT-STRIPPED VIEW, AND SAYING ONLY "column zero" WAS WRONG
 * IN THE ANSWER IT GAVE. The close test reads `codeWithLiterals` lines, so a column-zero line
 * inside a BLOCK COMMENT does NOT end a chunk, while a column-zero continuation of a template
 * LITERAL does. A reader asking "can a column-zero comment cut my procedure?" must get NO, and
 * four places in this file used to imply YES by naming the column without naming the view.
 *
 * 🔴 THAT BOUNDARY IS A FORMATTING ASSUMPTION, AND IT CAN CUT A PROC SHORT. A line that
 * legitimately starts in column zero INSIDE a proc — the continuation of a multi-line
 * template literal, say — closes the chunk early. If that happens before the proc's
 * `.input(`, the proc drops out of the population silently, which is the same class of
 * hole the second ledger exists to close. It is not left to prose: `every proc chunk keeps
 * its own terminator` below asserts that each chunk still contains the `.mutation(` /
 * `.query(` / `.subscription(` that ends a tRPC procedure, so a truncated chunk goes RED
 * instead of shrinking the population. Measured on the current router: 75 of 75 intact.
 *
 * 🔴 THE NORMALISED SLICE IS TAKEN AT THE SAME LINE INDICES AS THE RAW ONE, which is only
 * sound because `codeWithLiterals` preserves line structure exactly. `preserves the line
 * structure exactly` is the assertion that keeps that true.
 */
function chunks(source: string): Chunk[] {
  const lines = source.split('\n');
  const codeLines = stripNonCode(source).split('\n');
  // Comments gone, literal bodies KEPT — the view the column-zero close test reads, for the
  // reason set out at that test. Distinct from `codeLines`, which empties literal bodies and is
  // what every reachability decision reads.
  const closeLines = codeWithLiterals(source).split('\n');
  const out: Chunk[] = [];
  let open: { name: string; kind: 'proc' | 'fn'; start: number } | null = null;

  const close = (endExclusive: number) => {
    if (!open) return;
    out.push({
      name: open.name,
      kind: open.kind,
      text: lines.slice(open.start, endExclusive).join('\n'),
      code: codeLines.slice(open.start, endExclusive).join('\n'),
    });
    open = null;
  };

  lines.forEach((line, i) => {
    // 🔴 DETECTION READS THE NORMALISED LINE, THE WAY `scan` ALREADY DID. It used to read the
    // RAW one, so a COMMENT or a template-literal line merely SHAPED like a procedure at indent
    // two — `  fooProc: publicProcedure` inside a docblock, or the same text inside a multi-line
    // template — opened a chunk and SPLIT the real procedure it sat inside. The halves then
    // carry a terminator count of two and zero, so `every proc chunk keeps its own terminator`
    // does go red; but its message blames "a line starting in column zero", which is not what
    // happened, and the reader is sent looking for the wrong thing. Latent on today's router —
    // measured, raw and normalised detect the same 75 procedures and the same 56 helpers — so
    // this is a shape being closed, not a bug being fixed, and it costs nothing to close.
    const proc = PROC_RE.exec(codeLines[i] ?? '');
    if (proc) {
      close(i);
      open = { name: proc[1], kind: 'proc', start: i };
      return;
    }
    const fn = fnName(codeLines[i] ?? '');
    if (fn) {
      close(i);
      open = { name: fn, kind: 'fn', start: i };
      return;
    }
    // 🔴 THE CLOSE TEST READS `codeWithLiterals`, WHICH IS THE ONE VIEW THAT ANSWERS BOTH HALVES.
    // The previous round argued this had to stay on the RAW line because "`stripNonCode` EMPTIES
    // literal bodies", so a column-zero template continuation — the exact cut this boundary
    // exists to notice — would stop closing the chunk. That was true of `stripNonCode` and it
    // was the wrong conclusion: the file already has a second normalised view which strips
    // comments AND keeps literal bodies, and it satisfies both requirements at once. Measured on
    // the three views, which is what settles it rather than the argument:
    //   column-zero BLOCK-COMMENT body line  raw: closes  stripNonCode: no   codeWithLiterals: NO
    //   column-zero TEMPLATE continuation    raw: closes  stripNonCode: no   codeWithLiterals: YES
    //
    // The raw version was a false RED reachable from prettier-clean source — prettier does not
    // reindent the body lines of a block comment. Measured: a procedure with a column-zero
    // comment body line between `.input(` and `.mutation(` gave `cutProcChunks: ['realProc']`
    // and `procsReachingGuard: []` for a procedure that calls the guard on the very next line,
    // and the message blamed a column-zero line the committer was entitled to write.
    // `a chunk cut short by a column-zero line is CAUGHT` still pins the template half, and
    // `a column-zero COMMENT body line does not end a procedure` pins this one.
    if (open && /^[A-Za-z}]/.test(closeLines[i] ?? '')) close(i);
  });
  close(lines.length);
  return out;
}

/**
 * The first `.input(` argument of a chunk, with the paren balancing done over NORMALISED code
 * and the text returned RAW.
 *
 * 🔴 BOTH HALVES ARE DELIBERATE AND THEY USED TO DISAGREE. The `/\bblockToken\b/` test
 * downstream reads the RAW argument on purpose — a proc whose argument only MENTIONS the
 * field in a comment enters the population and has to reach the guard, which is the
 * fail-CLOSED direction. But the paren BALANCING was reading raw text too, and there an
 * unbalanced `(` inside a comment or a string — `// the token minted by the host (see
 * mintBlockToken`, or `.describe('pick one (or more')` — runs the scan off the end of the
 * chunk and returns `null`. The caller then `continue`d, so the procedure left the population
 * with `procs: []` AND `unresolved: []`: verbatim the outcome this file's own header forbids,
 * *"'this procedure is not in the set' and 'this procedure could not be parsed' have to be
 * different outcomes, or the second one hides inside the first."* Measured: 0 live instances
 * on today's router, so this is a latent shape being closed, like `PROC_RE`'s indent was.
 *
 * Returns `{ raw }` when the argument was read, or `{ unbalanced: true }` when a `.input(`
 * is present but its argument does not close — never a bare null that reads as "no input".
 */
function inputArg(chunk: Chunk): { raw: string } | { unbalanced: true } | null {
  const at = chunk.code.indexOf('.input(');
  if (at < 0) return null;
  let depth = 0;
  for (let i = at + 6; i < chunk.code.length; i++) {
    if (chunk.code[i] === '(') depth++;
    else if (chunk.code[i] === ')' && --depth === 0) {
      // The normalisation preserves LENGTH as well as line structure, so these offsets index
      // the raw slice unchanged — the balance is taken where stray parens cannot exist, and
      // the text is read where the deliberate raw-`blockToken` reading needs it.
      return { raw: chunk.text.slice(at + 7, i) };
    }
  }
  return { unbalanced: true };
}

/**
 * 🔴 THE CANONICAL ECMAScript RESERVED WORDS, CONTEXTUAL KEYWORDS AND NON-NAMING GLOBALS —
 * a fact about the LANGUAGE, maintained separately from `RESERVED_WORDS` below so that the
 * suppression set can be checked against something it cannot quietly grow into.
 *
 * WHY IT EXISTS (clawgate #589, finding 5). `MODULE_EXEMPTIONS` was pinned to exactly `['z']`
 * precisely because "the cheap way out of a red `unresolved` will always be to add a name
 * here" — and its NEIGHBOUR, which feeds the same `NON_SCHEMA_WORDS` union and suppresses
 * identically, was pinned by nothing at all. MEASURED before this: adding a plausible schema
 * name (`someNewBridgeSchema`) to `RESERVED_WORDS` left the whole file GREEN — measured
 * 2026-09-19 at 22/22 against the pre-change guard — with that identifier silently excused
 * from resolving forever. The anti-suppression pin was one
 * set away from being decorative.
 *
 * The check below is a SUBSET test, not an exact-set one, and the asymmetry is deliberate:
 * ADDING a name that can bind something is the fail-open direction and must be refused;
 * REMOVING a keyword only makes `schemaIdentifiers` noisier, which is fail-closed and shows
 * up as a red `unresolved` rather than as silence.
 *
 * 🔴 WHAT THIS SET IS NOT, because the name reads wider than the membership. Only the first
 * block is genuinely unbindable: a RESERVED word cannot be declared at all. The contextual
 * keywords (`as`, `async`, `from`, `get`, `let`, `of`, `satisfies`, `set`) and the globals
 * (`globalThis`, `Infinity`, `NaN`, `undefined`) CAN legally name a module-scope binding —
 * `const get = z.object({})` compiles. So roughly a dozen names remain suppressible through
 * this list, and the pin is narrower than "no name that could bind a schema". They are here
 * because `RESERVED_WORDS` needs them and because a schema named `get` or `NaN` is not a
 * shape this corpus produces — a judgement, stated as one rather than dressed as a language
 * fact. The fully mechanical version would reject any member that survives
 * `new Function('var ' + word)`; it is not written because it would evict the twelve names
 * the scan actually needs.
 */
const ECMASCRIPT_NON_NAMING_WORDS = new Set([
  // Reserved words (ECMA-262 §12.7.2), including the strict-mode and future-reserved sets.
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'implements',
  'import',
  'in',
  'instanceof',
  'interface',
  'new',
  'null',
  'package',
  'private',
  'protected',
  'public',
  'return',
  'static',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'yield',
  // Contextual keywords — not reserved, but they never appear in a SCHEMA position.
  'as',
  'async',
  'from',
  'get',
  'let',
  'of',
  'satisfies',
  'set',
  // Global value properties that are not writable bindings a schema could be declared under.
  'globalThis',
  'Infinity',
  'NaN',
  'undefined',
]);

/** Keywords and literals that tokenise as identifiers but can never NAME anything. */
const RESERVED_WORDS = new Set([
  'true',
  'false',
  'null',
  'undefined',
  'NaN',
  'Infinity',
  'async',
  'await',
  'new',
  'typeof',
  'void',
  'return',
  'this',
  'in',
  'of',
  'as',
]);

/**
 * 🔴 REAL BINDINGS this scan declines to follow — the ONLY place an identifier can be
 * excused from resolving. The zod namespace is the BUILDER, not a schema, and it comes
 * from a package `resolveModule` deliberately does not read, so leaving it in would make
 * every inline `z.object(...)` argument report an unresolvable identifier forever.
 *
 * It stays a set of ONE. `the identifier exemption set is exactly the zod namespace` pins
 * that, because the cheap way out of a red `unresolved` will always be to add a name here,
 * and a suppression list is how this ledger stops meaning anything.
 */
const MODULE_EXEMPTIONS = new Set(['z']);

const NON_SCHEMA_WORDS = new Set([...RESERVED_WORDS, ...MODULE_EXEMPTIONS]);

/**
 * The identifiers in an `.input(...)` argument that occupy a SCHEMA position — i.e. the
 * ones that have to resolve to something before this scan can say whether the argument
 * carries a `blockToken`.
 *
 * 🔴 WHY THIS REPLACED `is the whole argument one bare identifier`. The previous rule
 * recorded an unreadable schema ONLY when the entire argument was a bare identifier, so
 * `.input(mysteryBridgeInput)` was loud while `.input(mysteryBridgeInput.extend({ page }))`
 * was silent — the proc vanished from the population with `procs: []` and `unresolved: []`,
 * which is precisely the "scored as carrying no token" outcome the docstring on
 * `bridgeInputProcs` promises never happens. Same for `.input(a.merge(b))`,
 * `.input(makeInput())`, and any schema behind a relative-path or package import.
 *
 * What is dropped, and why each is not a schema reference:
 *   - a member NAME (`.extend`, `.object`, `.min`) — the thing being called ON a schema.
 *     🔴 A SPREAD's OPERAND IS NOT ONE, and treating it as one was a live fail-open: the
 *     member rule is "preceded by a dot", and `...someInput` puts an identifier directly
 *     after a dot. See the lookbehind's own comment in the body;
 *   - an object KEY (`blockToken:`, `page:`) — a field name;
 *   - a parameter bound INSIDE the argument (`.refine((v) => !!v.slug)`, and the multi-parameter
 *     and destructured forms — see the `bound` block in the body) — those names are local;
 *   - a keyword or literal (`z.boolean().default(true)`);
 *   - the zod namespace, per `NON_SCHEMA_WORDS`.
 * Everything else survives and MUST resolve.
 *
 * 🔴 THE JUSTIFICATION THAT USED TO CLOSE THIS PARAGRAPH WAS FALSE, AND IT IS WORTH KNOWING WHY.
 * It read: "An identifier the router neither imports nor declares cannot appear in a valid
 * argument at all, so flagging it is fail-closed." The second clause is right — an unresolvable
 * identifier is reported, never silently dropped, which is the safe direction. The FIRST clause
 * is simply wrong, and it was the load-bearing half: a LAMBDA PARAMETER is an identifier the
 * router neither imports nor declares, and it appears in a perfectly valid argument every time
 * anyone writes `.superRefine((val, ctx) => …)`. Measured on the pre-change code, that argument
 * produced exactly such a flag. So the sentence was not describing a property of valid
 * arguments; it was describing a gap in the `bound` set, and reading it as the former is what
 * let the gap sit there while the paragraph read as a proof.
 * What is actually true: a flagged identifier is REPORTED rather than dropped, so the error is
 * in the fail-closed direction — but "it cannot happen on valid input" is not a claim this
 * function can make, and the `bound` set is the only thing keeping the false reds down.
 *
 * 🔴 KNOWINGLY OPEN — the object-KEY rule drops a schema in a TERNARY, and drops it SILENTLY.
 * "followed by a colon" means "object key", and a conditional puts the interesting operand in
 * exactly that position: `.input(useV2 ? bridgeInputWithToken : legacyInput)` returns
 * `['useV2', 'legacyInput']` and loses `bridgeInputWithToken` entirely. If the two survivors
 * resolve — a local `const` flag does — then `unresolved` stays empty and the procedure is
 * scored as carrying no token, which is the merged outcome this file's header forbids.
 *
 * It is recorded rather than closed because the fix is not a regex. Telling a key from a
 * ternary branch needs the parse, and this function is handed an argument FRAGMENT rather
 * than a module, so the parse is not available at this point without restructuring how
 * `bridgeInputProcs` obtains its arguments. Measured 2026-09-19: ZERO ternary `.input()`
 * arguments in `blocks.router.ts`, so nothing is live — this is a latent shape, stated so it
 * is not mistaken for covered. `the object-key rule drops a ternary branch` below pins the
 * behaviour, so the limit is a checked fact and cannot rot into a false claim of coverage.
 */
function schemaIdentifiers(arg: string): string[] {
  const code = stripNonCode(arg);

  // Parameters bound by an arrow function inside the argument. All the shapes the corpus
  // writes: `v => …`, `(v) => …`, `(val, ctx) => …` and `({ slug }, ctx) => …`.
  //
  // 🔴 THE MULTI-PARAMETER FORMS WERE MISSING, AND THAT MADE THIS A FALSE-RED FACTORY. The old
  // pair of regexes recognised a parenthesised SINGLE parameter and a bare one, so a canonical
  // zod `.superRefine((val, ctx) => …)` bound NEITHER name: `val` and `ctx` came back as schema
  // POSITIONS and were then required to resolve. MEASURED on the pre-change code —
  // `(val, ctx)` yielded `['val', 'ctx']`, `({ slug }, ctx)` yielded `['slug', 'ctx']`, and
  // `(val: Foo, ctx)` yielded `['Foo', 'ctx']` — so any procedure adopting `superRefine` in its
  // `.input()` reddened `unresolved` on ordinary zod. `superRefine` appears in 11 files under
  // `src/server/schema` and 28 under `src/`, so this was a question of when, not whether.
  //
  // 🔴 AND THE PRINTED REMEDY WAS WRONG IN THE DIRECTION THAT DOES DAMAGE. The failure message
  // tells the committer to "teach resolveModule about it; do not exempt the procedure" — but
  // `ctx` is a lambda parameter, so there is nothing to resolve and that instruction cannot be
  // followed. The only exits left were to revert the refinement or to edit this guard, and a
  // guard that trains people to edit it is the failure this whole file is written against.
  //
  // ⚠️ IT BINDS EVERY IDENTIFIER IN THE PARAMETER LIST, INCLUDING ONES THAT ARE NOT BINDINGS —
  // a type annotation's type (`(v: Foo) =>` binds `Foo` as well) and both halves of a renaming
  // destructure (`({ a: b }) =>`). Separating those needs the parse, and this function is handed
  // an argument FRAGMENT. Binding is a SUPPRESSION, so over-binding is the fail-OPEN direction.
  //
  // 🔴 THIS PARAGRAPH USED TO BOUND THAT RADIUS WRONGLY, AND THE OMISSION CAUSED A REAL FLIP. It
  // said "the blast radius is names written inside an arrow's OWN parameter list, where this
  // corpus never spells a schema reference". Both halves of that are true and it still misleads,
  // because what it does NOT say is where the suppression is APPLIED — and the answer was
  // argument-wide, which put the chain OPERAND in range whenever it shared a name with something
  // in the list. So the radius was never limited to the parameter list at all. I wrote that
  // sentence, in the round that corrected the previous over-claiming sentence in this very
  // function; the failure is not the claim being false but the claim being narrower than the
  // mechanism, which is the same shape twice running.
  // The suppression is now POSITIONAL — see `firstArrowAt` below and the note inside the scan
  // loop, which carries the measurements and the one residual case.
  //
  // A default value naming a schema (`(v = someSchema) => …`) is bound and therefore suppressed
  // from the first arrow onward — stated because it is open, not covered.
  const bound = new Set<string>();
  // 🔴 AND WHERE THE SUPPRESSION MAY APPLY, WHICH IS THE HALF THE PREVIOUS ROUND GOT WRONG. See
  // the note below `out` for the flip this caused; `firstArrowAt` is the whole remedy.
  let firstArrowAt = Number.POSITIVE_INFINITY;
  for (const re of [/\(([^()]*)\)\s*=>/g, /(?:^|[^.\w$])([A-Za-z_$][A-Za-z0-9_$]*)\s*=>/g]) {
    for (let m = re.exec(code); m; m = re.exec(code)) {
      firstArrowAt = Math.min(firstArrowAt, m.index);
      for (const name of m[1].match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? []) bound.add(name);
    }
  }

  const out = new Set<string>();
  // `((?<!\.\.)\.\s*)?` — preceded by a single dot, so a member name. `(\s*:)?` — followed by
  // a colon, so an object key. Either match disqualifies the token.
  //
  // 🔴 `(?<!\.\.)` ON THE DOT GROUP ONLY, AND THAT PLACEMENT IS THE WHOLE FIX. A SPREAD's
  // third dot is a dot immediately preceding an identifier, so the member-name rule matched it
  // and dropped the OPERAND. `.input(z.object({ ...someInput.shape, page: z.number() }))`
  // yielded NO identifiers at all, so the procedure left the population with `procs: []` AND
  // `unresolved: []` — verbatim the merged outcome this file's header forbids. MEASURED by
  // adding exactly that procedure, unguarded, to the router: the whole suite passed 32/32.
  //
  // ⚠️ BE EXACT ABOUT WHAT WAS LIVE, because the strong reading is wrong. The SHAPE was live on
  // two procedures — `previewPostFromApp` and `createPostFromApp` both spread
  // `blockPostPayloadShape` into their `.input()` argument — so the drop was exercised against
  // the real corpus rather than only against a synthetic. But NEITHER procedure ever left the
  // population: each also spells a literal `blockToken:` in the same `z.object({…})`, and that
  // literal test short-circuits before identifier resolution is reached. So what was live is
  // the silent drop of the operand, with nothing in `unresolved` to say so; the vanishing
  // procedure was reachable, not reached. Measured after this fix, `blockPostPayloadShape`
  // resolves and carries no `blockToken` (verdict `false`), and `BRIDGE_INPUT_LEDGER` is
  // unchanged — this change moves no committed expected value. (Stated as "unchanged" rather
  // than as a count on purpose: the ledger's own length is the asserted fact, so repeating it
  // here would be a second, unasserted copy of it — see the note on deleted figures above
  // `MAX_SCHEMA_DEPTH`.)
  //
  // `spreadUnknown` in `UNREADABLE` below is the control, and
  // `a spread operand is a schema reference, not a member name` pins the operand surviving.
  //
  // The lookbehind must sit INSIDE the optional group, not in front of the whole pattern. In
  // front, it also rejects the position of the identifier itself — for `...foo`, the two
  // characters before `foo` are `..`, so a leading `(?<!\.\.)` drops `foo` as well and the
  // fix reads as working while changing nothing. Inside, it only ever refuses to CONSUME a
  // spread's dot, which is what leaves the operand to be matched on the next position.
  const re = /((?<!\.\.)\.\s*)?\b([A-Za-z_$][A-Za-z0-9_$]*)\b(\s*:)?/g;
  for (let m = re.exec(code); m; m = re.exec(code)) {
    if (m[1] || m[3]) continue;
    const ident = m[2];
    if (NON_SCHEMA_WORDS.has(ident)) continue;
    // 🔴 SUPPRESSION IS POSITIONAL, NOT ARGUMENT-WIDE, AND THE PREVIOUS ROUND'S VERSION OF THIS
    // LINE FLIPPED A CASE FROM FAIL-CLOSED TO FAIL-OPEN. It read `|| bound.has(ident)`, applied
    // across the WHOLE argument — so when a name inside an arrow's parameter list happened to
    // match the CHAIN OPERAND, the operand was dropped. The operand is indisputably a schema
    // reference, so a noisy red became a silent absence, and with no literal `blockToken` in the
    // raw argument the procedure left the population with BOTH ledgers quiet.
    //
    // MEASURED on that version, and the third row is the control that makes it attributable to
    // the shared NAME rather than to the rule dropping everything:
    //   `mySchema.superRefine((val: z.infer<typeof mySchema>, ctx) => …)`  -> []
    //   `someInput.superRefine((someInput, ctx) => …)`                     -> []
    //   `keptSchema.superRefine((val, ctx) => …)`                          -> ['keptSchema']
    // The first is the realistic one: `z.infer<typeof mySchema>` is ordinary zod.
    //
    // Nothing BEFORE the first arrow can be a reference to that arrow's parameter, so gating the
    // suppression on position keeps the operand while still suppressing the parameter's uses in
    // the list and in the body — which is the only reason `bound` exists.
    //
    // ⚠️ RESIDUAL, DISCLOSED RATHER THAN CLOSED: an operand appearing AFTER the first arrow and
    // sharing a bound name is still suppressed. Measured — `a.refine((b) => !!b).merge(b)` yields
    // `['a']`, dropping the second operand. Closing that needs per-arrow scoping, which needs the
    // parse this function does not have. It is a name COLLISION between a parameter and a later
    // operand; the corpus has none, and this sentence exists so the next reader does not have to
    // discover the boundary by hitting it.
    if (bound.has(ident) && m.index >= firstArrowAt) continue;
    out.add(ident);
  }
  return [...out];
}

/** `importMap` over a repo-relative FILE, memoised. */
function importsOf(file: string): Map<string, { spec: string; imported: string }> {
  let cached = importCache.get(file);
  if (!cached) {
    cached = importMap(readIfPresent(file) ?? '');
    importCache.set(file, cached);
  }
  return cached;
}

/** local name -> { module specifier, imported name }, from `import { a, b as c } from 'm'`. */
function importMap(source: string): Map<string, { spec: string; imported: string }> {
  const out = new Map<string, { spec: string; imported: string }>();
  const re = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
  for (let m = re.exec(source); m; m = re.exec(source)) {
    for (const raw of m[1].split(',')) {
      const part = raw.trim().replace(/^type\s+/, '');
      if (!part) continue;
      const [imported, local] = part.includes(' as ')
        ? part.split(' as ').map((s) => s.trim())
        : [part, part];
      out.set(local, { spec: m[2], imported });
    }
  }
  return out;
}

/** `~/server/schema/buzz.schema` -> the repo-relative file that actually exists. */
function resolveModule(spec: string): string | null {
  if (!spec.startsWith('~/')) return null;
  const base = path.join('src', spec.slice(2));
  for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(path.join(REPO_ROOT, candidate))) return candidate;
  }
  return null;
}

const NEXT_BINDING_RE =
  /^(?:export\s+)?(?:const|let|var|function|async function|type|interface|class|enum)\s/;

/** The source text of `const <ident> = …` in `file`, up to the next top-level binding. */
function definitionText(file: string, ident: string): string | null {
  const key = `${file}#${ident}`;
  if (definitionCache.has(key)) return definitionCache.get(key) ?? null;
  const found = findDefinitionText(file, ident);
  definitionCache.set(key, found);
  return found;
}

function findDefinitionText(file: string, ident: string): string | null {
  const source = readIfPresent(file);
  if (source == null) return null;
  const lines = source.split('\n');
  // 🔴 ESCAPED. `ident` is interpolated into a regex, and `$` is legal in a JavaScript
  // identifier but an ANCHOR in a pattern — so `foo$bar` compiled to "foo, end of input, bar"
  // and could never match its own declaration. The failure is silent and lands in the
  // reassuring direction: `definitionText` returns null, the candidate filter then drops the
  // name, and the reference is skipped without reaching `unreadable`. No `$`-bearing schema
  // exists in this corpus today, so this is latent — but it costs one call to remove, and an
  // unescaped interpolation is a defect whether or not the corpus currently triggers it.
  const escaped = ident.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const start = lines.findIndex((l) =>
    new RegExp(`^(?:export\\s+)?(?:const|let|var)\\s+${escaped}\\b`).test(l)
  );
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && !NEXT_BINDING_RE.test(lines[end])) end++;
  return lines.slice(start, end).join('\n');
}

/**
 * 🔴 THE NESTED-UNREADABLE LEDGER — the nested references that resolve to `null`, enumerated so
 * THAT swallow is loud instead of silent.
 *
 * ⚠️ READ THE SCOPE BEFORE TRUSTING IT, because the first version of this sentence claimed the
 * whole class. It said this ledger holds "the references the schema walk CANNOT read", and that
 * is WIDER THAN THE MECHANISM. There are two ways a nested reference goes unread and only one
 * of them arrives here:
 *   - the candidate filter ADMITS the name and the recursion then fails to resolve it — that is
 *     a `null`, and it is ledgered below. LOUD.
 *   - the candidate filter REJECTS the name first (`definitionText` finds no `const|let|var`
 *     declaration AND it is not in this file's `import { … } from` map), so the loop `continue`s
 *     and the recursion never runs. No `null` is ever produced, nothing is ledgered, and the
 *     branch is scored as carrying no token. STILL SILENT — see the `WHAT IS STILL OUT OF REACH`
 *     entry in this file's header, which states the shapes that fall into it.
 * So this ledger makes the `null` swallow loud. It does not make the `continue` swallow loud,
 * and no part of this file currently does.
 *
 * `schemaCarriesBlockToken` returns `null` for a reference it cannot resolve. At DEPTH 0 that
 * null reaches `unresolved`, which is asserted empty — the loud path. Deeper in the descent it
 * used to be DISCARDED: the candidate loop kept only a `true`, so a `null` from a nested
 * reference was indistinguishable from a `false`, and the branch was scored "no token here"
 * without anybody reading it. Two docstrings claimed coverage that was only ever depth-0.
 *
 * Rather than force those nulls into `unresolved` — which would need `resolveModule` taught
 * about relative paths AND `definitionText` taught about `enum`/`type` declarations, both
 * changes to the walk's reach rather than to its reporting — they are ledgered here and
 * compared as a SET, failing in BOTH directions like `GUARD_CALL_SITE_LEDGER` does. A new
 * unreadable nested reference fails this test and gets looked at by whoever introduced it;
 * one disappearing fails it too, so the ledger cannot quietly stop meaning anything.
 *
 * 🔴 THIS MECHANISM IS ELECTIVE, AND IT IS NOT WHAT CLOSED THE FINDING THAT PROMPTED IT. The
 * finding was that two docstrings claimed coverage the code only had at depth 0, and narrowing
 * those two docstrings closed it on its own. The ledger is an ADDITION on top of that, taken
 * because a recorded limit beats a described one — not because anything required it. Read the
 * next paragraph before extending it.
 *
 * 🔴 AND IT CARRIES A FALSE-RED SURFACE, priced rather than hidden. `resolveModule` accepts `~/`
 * specifiers only, so ANY relative or package import whose local name is referenced inside a
 * definition body the walk descends into adds an entry — and a new entry reds
 * `ledgers every procedure that TAKES a block token`, the real-router test, with a message
 * about a declaration that may have nothing to do with the change the author made. That is a
 * genuine cost: the trip is not caused by the committer's own code. Today's surface is narrow,
 * and deliberately not quoted as a figure here (see the note on deleted figures above
 * `MAX_SCHEMA_DEPTH`) — it depends on which files the walk actually descends into, which is a
 * much smaller set than the router's import closure, so any number written down would be a
 * bound rather than a measurement and would rot like the last one did. If this starts tripping
 * on unrelated changes, the fix is to teach `resolveModule` to reach those specifiers, or to
 * delete the mechanism and keep the narrowed docstrings — NOT to grow the ledger.
 *
 * THE SINGLE LIVE ENTRY, and why it is unreadable — stated exactly, because a looser reading
 * of it is wrong in the reassuring direction. `block-scope.constants.ts` does
 * `import { TokenScope } from './token-scope.constants'`, and `resolveModule` resolves `~/`
 * specifiers ONLY, so the relative one is refused by design. Following it would not help
 * either: that file is a re-export shim (`export * from '@civitai/auth/token-scope'`) and the
 * declaration is `export const TokenScope = {…}` in a workspace package this scan does not
 * read. 🔴 NOTE WHAT THAT RULES OUT — it is a `const`, not a `type`, so the tempting argument
 * "a type declaration can never carry a `blockToken` anyway" does NOT apply here. Whether this
 * reference carries one is precisely the question the scan cannot answer, which is the reason
 * it is ledgered rather than dismissed.
 *
 * The judgement that it does not is a HUMAN one, stated as such: `TokenScope` is an OAuth
 * scope bitmask (`{ None: 0, UserRead: 1 << 0, … }`) rather than a zod schema, and it contains
 * no occurrence of `blockToken`. What the ledger contributes is not that assurance — it is
 * that the discard path is EXERCISED against the real corpus, so the limit is a measured fact
 * instead of a paragraph.
 */
const NESTED_UNREADABLE_LEDGER = [
  `${BLOCK_SCOPE_CONSTANTS}#BLOCK_SCOPE_TO_OAUTH_BIT -> #TokenScope`,
].sort();

/**
 * Does `ident`, resolved from `file`, define a `blockToken` field — following imports and
 * same-file references? Returns `null` when the definition could NOT be located.
 *
 * 🔴 WHAT THE CALLER DOES WITH THAT NULL DEPENDS ON DEPTH, AND THIS DOCSTRING USED TO SAY
 * OTHERWISE. At depth 0 — the identifiers `schemaIdentifiers` hands `bridgeInputProcs` — the
 * null reaches `unresolved` and the suite treats it as a failure, because an unresolvable
 * schema is exactly the silent hole this scan exists to not have. DEEPER, inside the recursive
 * descent below, it does NOT: the candidate loop can only act on a `true`, so a nested null is
 * recorded in `unreadable` and the branch continues as if it were `false`. That recording is
 * what makes it visible; see `NESTED_UNREADABLE_LEDGER` above for why it is a ledger rather
 * than an `unresolved` entry.
 *
 * 🔴 DEPTH. The cap is `MAX_SCHEMA_DEPTH`, and hitting it returns `false` — i.e. "no token
 * here" for a branch nobody actually read, which is the same silent scoring `unresolved`
 * exists to prevent. So a truncation is RECORDED in `truncated` and asserted empty, rather
 * than described as a blind spot in prose.
 *
 * The wording before this one — "the real corpus resolves every `.input()` identifier within
 * 2" — was false, and the cap it justified was load-bearing on the committed tree, not
 * hypothetically: lowering it to 5 does truncate real chains here, in
 * `src/shared/constants/block-scope.constants.ts` and
 * `src/server/services/blocks/app-cap-limits.constants.ts`. No verdict moves when it does —
 * none of those definitions carries a `blockToken` — but nothing used to say so out loud.
 * MEASURED: the walk terminates on its own at DEPTH 8. The cap is 12, for headroom over that,
 * and `truncated` is what tells you when a chain outgrows it.
 *
 * 🔴 EVERY OTHER FIGURE THAT USED TO BE HERE IS DELETED — INCLUDING THE ONES THAT REPLACED THE
 * WRONG ONE, WHICH IS THE PART WORTH READING. This paragraph once asserted "800 resolution
 * calls". That did not reproduce at any granularity, and the epitaph written for it was that it
 * "read as a measurement, justified nothing, and was wrong by roughly 7x". The first repair
 * then swapped that one wrong number for EIGHT freshly measured ones — the same defect class
 * with eight times the surface — and conceded as much in its own wording, calling them
 * "decoration with a date on it, not a checked fact". Nothing in this file asserts any of them:
 * every numeric assertion here is a `toBeGreaterThan` floor, a `toBe` count of 0 or 1, or a
 * `toHaveLength`, and not one reads a walk-size figure. So they are deleted rather than
 * re-sourced, and `depth 8` is the single exception because it is the only one that JUSTIFIES
 * something — the constant directly below. If you need a walk size, measure it at the time; an
 * unasserted number in this docstring has already rotted once and nothing here can stop it
 * rotting again.
 */
const MAX_SCHEMA_DEPTH = 12;

/**
 * A fixture for `resolves a declaration whose name contains $` below, and nothing else reads it.
 * It exists to BE FOUND: `findDefinitionText` interpolates an identifier into a RegExp, `$` is
 * legal in a JavaScript identifier but an anchor in a pattern, and this file is the only place
 * that can hold a `$`-bearing declaration without adding a fixture module to the repo. The
 * corpus has no such name today, which is exactly why the escaping had no witness.
 */
const dollar$Fixture = 'found by name, never by value';

function schemaCarriesBlockToken(
  ident: string,
  file: string,
  seen = new Set<string>(),
  depth = 0,
  truncated: string[] = [],
  /** Nested references that resolved to NEITHER true nor false. See the ledger above. */
  unreadable: string[] = []
): boolean | null {
  const key = `${file}#${ident}`;
  if (depth > MAX_SCHEMA_DEPTH) {
    truncated.push(`${key} @ depth ${depth}`);
    return false;
  }
  if (seen.has(key)) return false;
  seen.add(key);

  const def = definitionText(file, ident);
  if (def == null) {
    const imported = importsOf(file).get(ident);
    if (!imported) return null;
    const target = resolveModule(imported.spec);
    if (!target) return null;
    // A null from here propagates to THIS call's own caller, which records it if that caller
    // is the candidate loop below, or surfaces it in `unresolved` if it is depth 0. So it is
    // deliberately not recorded twice.
    return schemaCarriesBlockToken(
      imported.imported,
      target,
      seen,
      depth + 1,
      truncated,
      unreadable
    );
  }

  if (/\bblockToken\b/.test(def)) return true;

  const localImports = importsOf(file);
  for (const other of new Set(def.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) ?? [])) {
    if (other === ident) continue;
    if (definitionText(file, other) == null && !localImports.has(other)) continue;
    const nested = schemaCarriesBlockToken(other, file, seen, depth + 1, truncated, unreadable);
    // 🔴 A NULL IS NOT A FALSE, AND CONTINUING AS IF IT WERE IS WHAT USED TO BE SILENT. The
    // loop can only act on a `true`, so the branch does carry on either way — but the null is
    // RECORDED first, which is the difference between a stated limit and a hidden one.
    if (nested === null) unreadable.push(`${key} -> #${other}`);
    if (nested === true) return true;
  }
  return false;
}

/**
 * The procedures whose input carries a block token, plus every `.input()` identifier whose
 * definition could not be read. Both `unresolved` and `truncated` are asserted EMPTY: a
 * schema we cannot read is indistinguishable from a schema with no `blockToken` in it, and
 * silently scoring it as "not a bridge proc" is how a population check quietly stops
 * covering things.
 *
 * 🔴 `unresolved` IS DEPTH-0 ONLY, AND THIS DOCSTRING USED TO READ AS THOUGH IT WERE THE WHOLE
 * WALK. It carries the identifiers `schemaIdentifiers` returned for an argument — the top of
 * each chain. A reference the walk could not read DEEPER than that never reached here: the
 * recursive descent could act only on a `true`, so a nested `null` was scored as `false` and
 * `unresolved` stayed empty. `const wrapperInput = packageBridgeInput.extend({…})`, with the
 * inner identifier behind an `@civitai/*` or relative import, is the shape — it resolved to
 * "no token here". Those nulls now arrive in `unreadableNested` and are compared against
 * `NESTED_UNREADABLE_LEDGER`. The test named
 * "depth-0 nulls reach unresolved, deeper ones reach the nested ledger" pins both halves, so
 * neither claim can rot into the other.
 *
 * 🔴 THE RULE IS NOW THE ARGUMENT'S SCHEMA POSITIONS, NOT ITS SHAPE. Every identifier
 * `schemaIdentifiers` returns has to resolve, whatever the argument looks like around it.
 * The earlier rule only demanded resolution when the WHOLE argument was a bare identifier,
 * which made the ledger's own promise false for every other shape — see that function's
 * docstring for the measured escape.
 *
 * Note the ORDER: the literal-`blockToken` test runs against the RAW argument, before any
 * comment stripping. A proc whose argument only MENTIONS the field in a comment therefore
 * enters the population and has to reach the guard. That is deliberate — the error is in
 * the fail-closed direction, and narrowing it would trade a harmless false member for a
 * chance of a silent absent one.
 */
function bridgeInputProcs(
  routerFile: string,
  source: string
): { procs: string[]; unresolved: string[]; truncated: string[]; unreadableNested: string[] } {
  const procs: string[] = [];
  const unresolved: string[] = [];
  const truncated: string[] = [];
  const unreadableNested: string[] = [];

  for (const chunk of chunks(source)) {
    if (chunk.kind !== 'proc') continue;
    const found = inputArg(chunk);
    if (found == null) continue;
    if ('unbalanced' in found) {
      // A `.input(` whose argument does not close. Reported, never silently skipped — the
      // two outcomes "no token here" and "could not be read" must not merge.
      unresolved.push(`${chunk.name} -> <unbalanced .input( argument>`);
      continue;
    }
    const arg = found.raw;
    if (/\bblockToken\b/.test(arg)) {
      procs.push(chunk.name);
      continue;
    }
    let carries = false;
    for (const ident of schemaIdentifiers(arg)) {
      const verdict = schemaCarriesBlockToken(
        ident,
        routerFile,
        new Set(),
        0,
        truncated,
        unreadableNested
      );
      if (verdict === true) {
        carries = true;
        break;
      }
      if (verdict === null) unresolved.push(`${chunk.name} -> ${ident}`);
    }
    if (carries) procs.push(chunk.name);
  }
  // Deduped and sorted: the same nested reference is reachable from several top-level
  // identifiers, and the ledger is a SET of what the walk cannot read, not a visit count.
  return {
    procs: procs.sort(),
    unresolved,
    truncated,
    unreadableNested: [...new Set(unreadableNested)].sort(),
  };
}

/**
 * Module-scope helpers in `source` that reach the guard, to a fixpoint — so a proc
 * delegating to a helper that delegates to `authorizeBlockBuzzRead` still counts.
 *
 * 🔴 READS `chunk.code`, NOT `chunk.text` (clawgate #589, finding 2). This and
 * `procsReachingGuard` below decide the file's CENTRAL question — does a proc that takes a
 * block token reach the guard — and both ran `GUARD_CALL_RE` over the RAW slice, so a
 * comment was an answer. The walk that shuts:
 *
 *     someProc: publicProcedure
 *       .input(z.object({ blockToken: z.string() }))
 *       .mutation(async ({ input }) => {
 *         // const claims = await authorizeBlockBridgeToken(input.blockToken);
 *         return decodeSomehow(input.blockToken);
 *       }),
 *
 * That proc is in the population, reads as REACHING the guard, and verifies nothing. It is
 * the identical shape that gave the REST sibling 24/24 PASS on a live unwrapped route, in
 * the file whose own docblock had already recorded that defect for its neighbour.
 */
function guardedHelpers(source: string): Set<string> {
  const fns = chunks(source).filter((c) => c.kind === 'fn');
  const reached = new Set<string>();
  for (let changed = true; changed; ) {
    changed = false;
    for (const fn of fns) {
      if (reached.has(fn.name)) continue;
      const calls =
        countCalls(GUARD_CALL_RE, fn.code) > 0 ||
        [...reached].some((h) => new RegExp(`\\b${h}\\s*\\(`).test(fn.code));
      if (calls) {
        reached.add(fn.name);
        changed = true;
      }
    }
  }
  return reached;
}

/**
 * Procedure chunks that lost their tRPC terminator, i.e. were CUT SHORT by a line starting in
 * column zero — of the COMMENT-STRIPPED view, so a template continuation cuts and a block-comment
 * body line does not — inside the procedure body. Every tRPC procedure ends in one of the three
 * terminators, so their absence is a cheap structural proof that a chunk did not survive.
 *
 * 🔴 ONE PREDICATE, ONE PLACE, AND THAT IS LOAD-BEARING HERE. Two callers ask this question —
 * `keeps every proc chunk intact` over the real router, where the answer must be empty, and
 * `a chunk cut short by a column-zero line is CAUGHT` over synthetics, where it must not be.
 * Open-coding it at both sites would leave the control testing a COPY of the guard: the copy
 * could go red on a mutation the real assertion sails through, which is precisely the
 * reassurance a control is supposed to make impossible.
 */
function cutProcChunks(source: string): string[] {
  return chunks(source)
    .filter((c) => c.kind === 'proc')
    .filter((c) => countCalls(PROC_TERMINATOR_RE, c.code) === 0)
    .map((c) => c.name);
}

/** Procedures in `source` that reach `authorizeBlockBridgeToken`, directly or via a helper. */
function procsReachingGuard(source: string): string[] {
  const helpers = guardedHelpers(source);
  return chunks(source)
    .filter(
      (c) =>
        c.kind === 'proc' &&
        (countCalls(GUARD_CALL_RE, c.code) > 0 ||
          [...helpers].some((h) => new RegExp(`\\b${h}\\s*\\(`).test(c.code)))
    )
    .map((c) => c.name)
    .sort();
}

describe('the bridge scan can actually see what it claims to', () => {
  /**
   * A ledger test that silently matches nothing passes forever. These two run the real
   * `scan` over a synthetic source whose answers are known, so a regex that stops
   * matching — or one that starts matching a type position — is caught here rather than
   * showing up as a reassuring empty result below.
   */
  it('finds a guarded site and attributes it to its procedure', () => {
    const { guarded, direct } = scan(
      [
        'export const r = router({',
        '  somethingElse: publicProcedure.query(async () => 1),',
        '  myBridgeProc: publicProcedure',
        '    .mutation(async ({ input }) => {',
        '      const claims = await authorizeBlockBridgeToken(input.blockToken);',
        '      return claims;',
        '    }),',
        '});',
      ].join('\n')
    );
    expect(guarded).toEqual(['myBridgeProc']);
    expect(direct).toEqual([]);
  });

  it('flags a direct call and ignores a type position', () => {
    const { direct } = scan(
      [
        'type C = NonNullable<Awaited<ReturnType<typeof verifyBlockToken>>>;',
        'const claims = await verifyBlockToken(input.blockToken);',
      ].join('\n')
    );
    expect(direct).toEqual([2]);
  });

  /**
   * The population scan's own controls. The negative one is the whole point of the second
   * ledger: the synthetic `unguardedProc` below is the exact shape that used to pass this
   * file 7/7, so if `procsReachingGuard` ever starts including it, this fails here rather
   * than in production.
   */
  const SYNTHETIC = [
    'async function helperThatGuards(blockToken: string) {',
    '  return authorizeBlockBridgeToken(blockToken);',
    '}',
    '',
    'async function helperThatDelegates(blockToken: string) {',
    '  return helperThatGuards(blockToken);',
    '}',
    '',
    'export const r = router({',
    '  noToken: publicProcedure.input(z.object({ id: z.number() })).query(async () => 1),',
    '  directlyGuarded: publicProcedure',
    '    .input(z.object({ blockToken: z.string().min(1) }))',
    '    .mutation(async ({ input }) => authorizeBlockBridgeToken(input.blockToken)),',
    '  guardedViaHelper: publicProcedure',
    '    .input(z.object({ blockToken: z.string().min(1) }))',
    '    .mutation(async ({ input }) => helperThatDelegates(input.blockToken)),',
    '  unguardedProc: publicProcedure',
    '    .input(z.object({ blockToken: z.string().min(1) }))',
    '    .mutation(async ({ input }) => {',
    "      const [, payload] = input.blockToken.split('.');",
    "      return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));",
    '    }),',
    '});',
  ].join('\n');

  it('POSITIVE CONTROL — finds the procs that take a blockToken, whatever they do with it', () => {
    const { procs, unresolved } = bridgeInputProcs(ROUTER, SYNTHETIC);
    expect(procs).toEqual(['directlyGuarded', 'guardedViaHelper', 'unguardedProc']);
    expect(unresolved).toEqual([]);
  });

  it('NEGATIVE CONTROL — a proc that verifies nothing does NOT read as reaching the guard', () => {
    // Two claims in one: the transitive helper chain IS followed (so the check does not
    // fail-closed on every delegation), and the unguarded proc is NOT swept up by it.
    expect(procsReachingGuard(SYNTHETIC)).toEqual(['directlyGuarded', 'guardedViaHelper']);
  });

  /**
   * 🔴 THE POSITIVE CONTROL FOR `unresolved`, AND WHY ITS ABSENCE WAS THE REAL DEFECT.
   * Every other control in this file asserts `unresolved` is EMPTY, and an empty result is
   * indistinguishable from a probe wired to nothing — so the ledger could be, and was,
   * structurally unable to report anything for four of the five argument shapes it claimed
   * to cover, while reading green. This feeds four arguments whose schema CANNOT be read
   * and requires the count to move off zero for each of them, separately, so a future
   * narrowing shows up here instead of as a reassuring blank.
   *
   * `mysteryBridgeInput` / `otherInput` / `makeBridgeInput` are resolved against the REAL
   * router, which neither declares nor imports them — the same position a schema behind an
   * `@civitai/*` package or a relative path is in.
   *
   * 🔴 `spreadUnknown` AND `bareSpreadUnknown` ARE THE FIFTH AND SIXTH SHAPES, AND THEY WERE
   * MISSING WHILE THE LIST READ AS EXHAUSTIVE. `schemaIdentifiers`' member-name rule is
   * "preceded by a dot", and a SPREAD's third dot is a dot immediately preceding an identifier
   * — so the operand was dropped and the procedure left the population with `procs: []` AND
   * `unresolved: []`. Both forms are here because a `.shape`-shaped search sees only the first:
   * the router's own two live spreads are of a BARE identifier (`...blockPostPayloadShape`).
   * Neither of those two procedures was actually scored as tokenless — each also spells a
   * literal `blockToken:`, which short-circuits first — so what was live was the silent drop,
   * not a vanished procedure. See the lookbehind's comment in `schemaIdentifiers`.
   */
  const UNREADABLE = [
    'export const r = router({',
    '  bareUnknown: publicProcedure',
    '    .input(mysteryBridgeInput)',
    '    .mutation(async () => 1),',
    '  extendedUnknown: publicProcedure',
    '    .input(mysteryBridgeInput.extend({ page: z.number().optional() }))',
    '    .mutation(async () => 1),',
    '  mergedUnknown: publicProcedure',
    '    .input(mysteryBridgeInput.merge(otherInput))',
    '    .mutation(async () => 1),',
    '  factoryUnknown: publicProcedure',
    '    .input(makeBridgeInput())',
    '    .mutation(async () => 1),',
    '  spreadUnknown: publicProcedure',
    '    .input(z.object({ ...mysteryBridgeInput.shape, page: z.number().optional() }))',
    '    .mutation(async () => 1),',
    '  bareSpreadUnknown: publicProcedure',
    '    .input(z.object({ ...otherInput, page: z.number().optional() }))',
    '    .mutation(async () => 1),',
    '});',
  ].join('\n');

  it('POSITIVE CONTROL — an unreadable schema moves `unresolved` off zero, in EVERY argument shape', () => {
    const { procs, unresolved } = bridgeInputProcs(ROUTER, UNREADABLE);

    // None of them can be scored as carrying a token — that is the whole point: a proc
    // this scan cannot read must not quietly leave the population.
    expect(procs).toEqual([]);
    expect([...unresolved].sort()).toEqual([
      'bareSpreadUnknown -> otherInput',
      'bareUnknown -> mysteryBridgeInput',
      'extendedUnknown -> mysteryBridgeInput',
      'factoryUnknown -> makeBridgeInput',
      'mergedUnknown -> mysteryBridgeInput',
      'mergedUnknown -> otherInput',
      'spreadUnknown -> mysteryBridgeInput',
    ]);
    // Report the pair, never the zero alone: 7 here, 0 against the real router below.
    expect(unresolved.length).toBeGreaterThan(0);
  });

  it('a spread operand is a schema reference, not a member name', () => {
    // 🔴 THE REGRESSION PIN FOR THE `(?<!\.\.)` LOOKBEHIND. Without it the member-name rule
    // ("preceded by a dot") swallowed a spread's third dot and dropped the OPERAND, so a
    // token-carrying schema left the population with BOTH ledgers silent. This asserts the
    // operand survives while the member name after it is still dropped — the two halves have
    // to hold together, or a regex that simply stopped dropping member names would pass.
    expect(
      schemaIdentifiers('z.object({ ...getMyBuzzAccountsInput.shape, page: z.number() })')
    ).toEqual(['getMyBuzzAccountsInput']);
    // The bare-identifier spread form, which a `.shape`-shaped search does not see and which
    // is the form the real router uses.
    expect(
      schemaIdentifiers('z.object({ blockToken: z.string().min(1), ...blockPostPayloadShape })')
    ).toEqual(['blockPostPayloadShape']);
    // The member-name rule still holds either side of the change: `extend` is dropped, the
    // receiver is not. A lookbehind placed in front of the WHOLE pattern instead of inside
    // the dot group drops the operand too — this pair is what separates the two placements.
    expect(schemaIdentifiers('getMyBuzzAccountsInput.extend({ page: z.number() })')).toEqual([
      'getMyBuzzAccountsInput',
    ]);
    // …and end to end: the procedure is scored as carrying the token it carries.
    const spread = [
      'export const r = router({',
      '  spreadProc: publicProcedure',
      '    .input(z.object({ ...getMyBuzzAccountsInput.shape, page: z.number() }))',
      '    .mutation(async ({ input }) => authorizeBlockBridgeToken(input.blockToken)),',
      '});',
    ].join('\n');
    const { procs, unresolved } = bridgeInputProcs(ROUTER, spread);
    expect(
      procs,
      'A spread operand resolving to a schema that carries a blockToken must put its ' +
        'procedure IN the population. Empty here means the operand was dropped as a member ' +
        'name — and with `unresolved` empty too, that is the merged outcome this file forbids.'
    ).toEqual(['spreadProc']);
    expect(unresolved).toEqual([]);
  });

  it('NEGATIVE CONTROL — prose and field names inside an inline z.object are NOT schema identifiers', () => {
    // The other half of the same claim. `schemaIdentifiers` has to be narrow enough that
    // an ordinary annotated inline argument yields nothing, or `unresolved` fills with
    // English words and gets switched off again. Measured on the router with neither
    // half in place: 990 proc→identifier pairs across 38 procs, all unresolvable.
    const arg = [
      'z.object({',
      '  // The blockToken the host minted — see mintBlockToken, which is not a schema.',
      "  blockToken: z.string().min(1).describe('a token, aka someOtherSchema'),",
      '  page: z.number().optional(),',
      '})',
      '  .refine((v) => !!v.page, { message: `page is required` })',
    ].join('\n');
    expect(schemaIdentifiers(arg)).toEqual([]);
  });

  it('binds EVERY arrow parameter, not just a lone one — a multi-arg refinement is not a schema', () => {
    // 🔴 THE FALSE-RED PIN. The `bound` set used to recognise `(v) => …` and `v => …` only, so
    // the canonical zod `.superRefine((val, ctx) => …)` bound neither name and both came back
    // as schema positions that then had to RESOLVE. That reds `unresolved` for a procedure
    // whose author wrote ordinary zod, and the printed remedy — "teach resolveModule about it"
    // — cannot be followed for a lambda parameter, leaving "edit the guard" as the only exit.
    // `superRefine` appears in 11 files under `src/server/schema`; this was a matter of time.
    for (const arg of [
      'z.object({ id: z.number() }).superRefine((val, ctx) => ctx.addIssue({}))',
      'z.object({ id: z.number() }).superRefine(({ slug }, ctx) => ctx.addIssue({}))',
      'z.object({ id: z.number() }).superRefine((val: Foo, ctx) => ctx.addIssue({}))',
      'z.object({ id: z.number() }).refine((v) => !!v.id)',
      'z.object({ id: z.number() }).refine((v, extra) => !!v.id)',
    ]) {
      expect(
        schemaIdentifiers(arg),
        `${arg}\nEvery name here is a lambda parameter or a zod member. A non-empty result ` +
          'means one of them is about to be required to resolve, which is a false red on ' +
          'ordinary zod — and one the committer cannot act on, because there is nothing to ' +
          'resolve.'
      ).toEqual([]);
    }
    // 🔴 THE NEGATIVE HALF, or the loop above is satisfied by binding EVERYTHING. A real schema
    // reference standing beside a multi-parameter refinement must still survive, and the
    // parameters beside it must still be dropped — both in one assertion.
    expect(
      schemaIdentifiers('mysteryBridgeInput.superRefine((val, ctx) => ctx.addIssue({}))'),
      'The schema operand must survive while the lambda parameters are dropped. Empty here ' +
        'means the binding rule now swallows real schema references — the fail-OPEN direction.'
    ).toEqual(['mysteryBridgeInput']);
    // …and end to end, because the cost being fixed was a red on the real-router test.
    const refined = [
      'export const r = router({',
      '  refinedProc: publicProcedure',
      '    .input(z.object({ blockToken: z.string() }).superRefine((val, ctx) => ctx.addIssue({})))',
      '    .mutation(async ({ input }) => authorizeBlockBridgeToken(input.blockToken)),',
      '});',
    ].join('\n');
    const { procs, unresolved } = bridgeInputProcs(ROUTER, refined);
    expect(procs).toEqual(['refinedProc']);
    expect(unresolved).toEqual([]);
  });

  it('detects procedures on NORMALISED lines — text shaped like a proc inside trivia cannot split one', () => {
    // 🔴 `chunks` used to run `PROC_RE` and `fnName` over the RAW line while `scan` ran them
    // over the normalised one. So a COMMENT or a TEMPLATE-LITERAL line that merely LOOKS like
    // `  someProc: publicProcedure` opened a chunk and cut the real procedure it sat inside.
    // The halves then carry two terminators and zero, so the integrity check does go red — but
    // its message blames "a line starting in column zero", which is not what happened, and the
    // reader is sent hunting for the wrong thing. Latent on today's router (raw and normalised
    // detect the same 75 procs and 56 helpers), so this is a shape closed, not a bug fixed.
    for (const [label, decoy] of [
      ['block comment', ['    /*', '  decoyProc: publicProcedure', '    */']],
      ['template literal', ['    .describe(`', '  decoyProc: publicProcedure', '    `)']],
    ] as const) {
      const source = [
        'export const r = router({',
        '  realProc: publicProcedure',
        '    .input(z.object({ blockToken: z.string().min(1) }))',
        ...decoy,
        '    .mutation(async ({ input }) => authorizeBlockBridgeToken(input.blockToken)),',
        '});',
      ].join('\n');
      expect(
        chunks(source)
          .filter((c) => c.kind === 'proc')
          .map((c) => c.name),
        `${label}: a procedure-shaped line inside trivia must not open a chunk. Seeing ` +
          '`decoyProc` here means detection is reading raw lines again, and `realProc` has ' +
          'just been split in half.'
      ).toEqual(['realProc']);
      // …and the consequences the split would have had, asserted rather than described.
      expect(cutProcChunks(source), `${label}: the real proc must keep its terminator`).toEqual([]);
      expect(bridgeInputProcs(ROUTER, source).procs).toEqual(['realProc']);
      expect(procsReachingGuard(source)).toEqual(['realProc']);
    }
  });

  it('resolves a declaration whose name contains `$` — the identifier is escaped into the regex', () => {
    // 🔴 `findDefinitionText` interpolates `ident` into a RegExp. `$` is legal in a JavaScript
    // identifier and an ANCHOR in a pattern, so an unescaped `dollar$Fixture` compiled to
    // "dollar, end of input, Fixture" and could never match its own declaration. The failure is
    // silent AND lands in the reassuring direction: `definitionText` returns null, the candidate
    // filter then drops the name, and the reference is skipped without reaching `unreadable`.
    // 🔴 DERIVED FROM `__filename`, NOT HARDCODED, AND THE CONTROLS RUN FIRST. Both of those are
    // corrections. A hardcoded repo-relative path to this very file breaks on a rename, and it
    // breaks in the worst way: the FIRST assertion would fail claiming `$` is acting as an
    // anchor, which is not the cause, while the control that would have disambiguated it sat
    // after the failure and never ran. Ordering the controls first means an unreadable path
    // reports itself as an unreadable path.
    const SELF = path.relative(REPO_ROOT, __filename);
    // Positive control: the reader can read this file at all.
    // 🔴 ASSERTED AS A BOOLEAN, because `toMatch` on a `null` throws "expects to receive a
    // string, but got object" and DISCARDS the custom message — so the one failure this control
    // exists to explain would have printed the least explanatory error in the file. Measured by
    // pointing `SELF` at a path that does not exist.
    expect(
      definitionText(SELF, 'MAX_SCHEMA_DEPTH') !== null,
      `Could not read ${SELF}, so nothing below is about escaping — this file has been renamed ` +
        'or moved and the derivation of SELF from __filename is what to look at.'
    ).toBe(true);
    // Negative control: it does not answer for every name it is asked about.
    expect(definitionText(SELF, 'notDeclaredAnywhereInThisFile')).toBeNull();
    // …and only now the claim itself, with the same null-safety for the same reason.
    const found = definitionText(SELF, 'dollar$Fixture');
    expect(
      found !== null,
      'A `$`-bearing declaration was not found in the file that declares it, and the controls ' +
        'above have already shown the file is readable. The identifier is reaching the RegExp ' +
        'unescaped, so `$` is acting as an anchor and can never match.'
    ).toBe(true);
    expect(found).toMatch(/dollar\$Fixture/);
    // Reading the declaration's own VALUE back proves the slice is the right one, and is what
    // makes the fixture a used binding rather than a lint warning.
    expect(found).toContain(dollar$Fixture);
  });

  it('a parameter name colliding with the chain operand does NOT suppress the operand', () => {
    // 🔴 THE FAIL-OPEN THIS PINS WAS INTRODUCED BY THE FIX IN THE ROUND BEFORE IT, which is the
    // reason it gets its own test rather than a line in the one above. `bound` suppresses by
    // NAME; applying it across the whole argument meant that when a name inside an arrow's
    // parameter list matched the CHAIN OPERAND, the operand — indisputably a schema reference —
    // was dropped. A noisy red became a silent absence, and with no literal `blockToken` in the
    // raw argument the procedure left the population with both ledgers quiet.
    expect(
      schemaIdentifiers(
        'mySchema.superRefine((val: z.infer<typeof mySchema>, ctx) => ctx.addIssue({}))'
      ),
      'The annotation mentions the operand. `z.infer<typeof X>` is ordinary zod, so this is the ' +
        'realistic shape: an empty result means the operand was suppressed by its own ' +
        'parameter list and the procedure is about to be scored as carrying no token.'
    ).toEqual(['mySchema']);
    expect(
      schemaIdentifiers('someInput.superRefine((someInput, ctx) => ctx.addIssue({}))'),
      'A parameter that shadows the operand must not delete the operand.'
    ).toEqual(['someInput']);
    // 🔴 THE CONTROL THAT MAKES THE TWO ABOVE ATTRIBUTABLE. Same shape, no shared name — so a
    // failure above is about the COLLISION and not about the rule having stopped working.
    expect(schemaIdentifiers('keptSchema.superRefine((val, ctx) => ctx.addIssue({}))')).toEqual([
      'keptSchema',
    ]);
    // …and the suppression still has to WORK, or this test is satisfied by deleting it: a
    // parameter's uses inside the list and the body must still be dropped.
    expect(
      schemaIdentifiers('z.object({ id: z.number() }).superRefine((val, ctx) => ctx.addIssue({}))')
    ).toEqual([]);
    // End to end, the loud outcome: unreadable, and SAID so, rather than silently absent.
    const collide = [
      'export const r = router({',
      '  collideProc: publicProcedure',
      '    .input(bridgeTokenInput.superRefine((bridgeTokenInput, ctx) => ctx.addIssue({})))',
      '    .mutation(async () => 1),',
      '});',
    ].join('\n');
    const r = bridgeInputProcs(ROUTER, collide);
    expect(r.procs).toEqual([]);
    expect(
      r.unresolved,
      'With the operand suppressed this was `procs: []` AND `unresolved: []` — the merged ' +
        "outcome this file's header forbids. It must be reported instead."
    ).toEqual(['collideProc -> bridgeTokenInput']);
    // 🔴 THE DISCLOSED RESIDUAL, PINNED AS A FACT rather than described — same convention as
    // `the object-key rule drops a ternary branch`. An operand appearing AFTER the first arrow
    // and sharing a bound name is still suppressed, because closing that needs per-arrow scoping
    // and therefore the parse. The day someone fixes it, this goes red and points at the
    // docstring that has to stop saying the limit exists.
    expect(schemaIdentifiers('a.refine((b) => !!b).merge(b)')).toEqual(['a']);
  });

  it('POSITIVE CONTROL — an annotated argument KEEPS its schema identifier (the OVER-strip direction)', () => {
    // 🔴 THE DIRECTION NOTHING HERE COVERED, AND THE ONE THE DOCSTRING GOT BACKWARDS. Every
    // other normaliser control asks whether trivia can IMPERSONATE code (under-strip). This
    // asks the mirror question — can real code be REMOVED with it — and `unresolved` cannot
    // answer that one: over-stripping deletes candidates, so it yields an EMPTY `unresolved`,
    // which is what every assertion in this file already expects. The two shapes that used to
    // stand in for this both pass under ANY amount of over-stripping: the inline-`z.object`
    // control asserts `schemaIdentifiers(arg)` is `[]`, and `UNREADABLE` carries no comment
    // and no string, so it never exercises the removal at all.
    //
    // MEASURED before this control existed, and stated with the mutation site named because
    // the first draft of this comment did not name it: an over-strip applied to
    // `stripNonCode` ALONE — blanking the remainder of a comment's own line, with
    // `codeWithLiterals` left untouched — left the pre-change suite GREEN at 32 passed / 32.
    // The SAME over-strip applied to the shared `normaliseSource` instead is CAUGHT at base,
    // by `the normalisers preserve the line structure exactly`. The emptied view is the half
    // that had no survival assertion; see the LIMITS block on `stripNonCode` for the pair.
    //
    // The fixture carries all three things at once — a comment, a string, and an imported
    // identifier — and the comment and the string each name a DIFFERENT schema-shaped word, so
    // one assertion pins both directions: the code identifier must survive, and neither
    // trivia word may appear beside it.
    const arg = [
      '/* minted into commentOnlySchema by mintBlockToken (see notes */ mysteryBridgeInput.extend({',
      "  page: z.number().describe('aka stringOnlySchema (1-based'),",
      '})',
    ].join('\n');
    expect(
      schemaIdentifiers(arg),
      'The schema identifier must SURVIVE normalisation while the comment’s and the ' +
        'string’s own words must not appear. An empty array here is the over-strip ' +
        'failure: the identifier was removed with the trivia, so its procedure leaves the ' +
        'population with `procs` AND `unresolved` both silent.'
    ).toEqual(['mysteryBridgeInput']);

    // The same claim on the normaliser directly, so a failure above is attributable.
    const code = stripNonCode('/* commentOnlySchema */ mysteryBridgeInput.extend({})');
    expect(code, 'code sharing a line with a comment must survive').toMatch(
      /\bmysteryBridgeInput\b/
    );
    expect(code, 'a comment’s words must not survive').not.toMatch(/\bcommentOnlySchema\b/);

    // …and end to end through the population scan: the identifier has to REACH `unresolved`
    // rather than be dropped. This is the assertion an over-strip turns into an empty list.
    const annotated = [
      'export const r = router({',
      '  annotatedProc: publicProcedure',
      '    .input(',
      '      /* minted into commentOnlySchema (see notes */ mysteryBridgeInput.extend({',
      "        page: z.number().describe('aka stringOnlySchema (1-based'),",
      '      })',
      '    )',
      '    .mutation(async () => 1),',
      '});',
    ].join('\n');
    const { procs, unresolved } = bridgeInputProcs(ROUTER, annotated);
    expect(procs).toEqual([]);
    expect(
      unresolved,
      'An annotated argument’s unreadable schema must still be REPORTED. Empty here ' +
        'means the identifier was over-stripped away before it could be resolved.'
    ).toEqual(['annotatedProc -> mysteryBridgeInput']);
  });

  it('the identifier exemption set is exactly the zod namespace', () => {
    // Keywords can never name anything, so they are not exemptions. `MODULE_EXEMPTIONS` is
    // the list of REAL bindings this scan declines to follow, and it must stay at one:
    // the cheap way out of a red `unresolved` will always be to add a name to it.
    expect([...MODULE_EXEMPTIONS]).toEqual(['z']);
    expect([...RESERVED_WORDS].filter((w) => MODULE_EXEMPTIONS.has(w))).toEqual([]);
  });

  /**
   * 🔴 THE OTHER HALF OF THE ANTI-SUPPRESSION PIN (clawgate #589, finding 5). The test above
   * pins `MODULE_EXEMPTIONS` at exactly one name, on the stated reasoning that "the cheap way
   * out of a red `unresolved` will always be to add a name here". Its neighbour feeds the
   * SAME `NON_SCHEMA_WORDS` union, suppresses identically, and was pinned by nothing —
   * disjointness from a one-element set is not a pin. MEASURED before this check: adding
   * `'someNewBridgeSchema'` to `RESERVED_WORDS` left the file GREEN — measured 2026-09-19
   * at 22/22 against the pre-change guard — with that identifier excused from ever resolving.
   *
   * Asserted as a SUBSET of a LANGUAGE fact rather than as an exact spelled list, so this is
   * not itself a spelled guard: any name that could bind a schema fails, whatever it is
   * called, and the evasion has to be an obviously-wrong edit to a list titled "ECMAScript".
   * Removal is deliberately NOT asserted — dropping a keyword only makes `schemaIdentifiers`
   * noisier, which surfaces as a red `unresolved`, the fail-closed direction.
   */
  it('every suppressed word is a language keyword, not a name that could bind a schema', () => {
    const notKeywords = [...RESERVED_WORDS].filter((w) => !ECMASCRIPT_NON_NAMING_WORDS.has(w));
    expect(
      notKeywords,
      'RESERVED_WORDS carries a word that is NOT an ECMAScript reserved word, contextual ' +
        'keyword or non-naming global — so it is a name something could be declared under, ' +
        'and putting it here excuses that identifier from ever resolving. If `unresolved` ' +
        'is red, teach resolveModule to read the schema; do not suppress the name. If the ' +
        'word really is a keyword this list has missed, add it to ' +
        'ECMASCRIPT_NON_NAMING_WORDS — a separate, language-level edit.'
    ).toEqual([]);
    // Positive control: the canonical list is real and actually covers the live set, so an
    // empty `notKeywords` is a fact about the membership rather than about an empty input.
    expect(RESERVED_WORDS.size).toBeGreaterThan(10);
    expect(ECMASCRIPT_NON_NAMING_WORDS.has('someNewBridgeSchema')).toBe(false);
    expect(ECMASCRIPT_NON_NAMING_WORDS.has('typeof')).toBe(true);
  });

  it('follows a router-local helper declared as an arrow const, not just a `function`', () => {
    // FN_RE used to match `function` declarations only, so every proc behind
    // `const helper = async (…) => …` read as UNGUARDED — fail-closed, but a false red on
    // a legitimate refactor, and wider than the docstring admits.
    const source = [
      'const arrowGuard = async (blockToken: string) => {',
      '  return authorizeBlockBridgeToken(blockToken);',
      '};',
      '',
      'export const r = router({',
      '  viaArrow: publicProcedure',
      '    .input(z.object({ blockToken: z.string().min(1) }))',
      '    .mutation(async ({ input }) => arrowGuard(input.blockToken)),',
      '  stillUnguarded: publicProcedure',
      '    .input(z.object({ blockToken: z.string().min(1) }))',
      '    .mutation(async ({ input }) => input.blockToken.length),',
      '});',
    ].join('\n');
    expect(procsReachingGuard(source)).toEqual(['viaArrow']);
  });

  it('sees a procedure nested in a sub-router, not only one at two-space indent', () => {
    // PROC_RE used to pin a two-space indent, so `sub: router({ … })` yielded an EMPTY
    // population — every proc inside it outside the check, with nothing going red.
    const source = [
      'export const r = router({',
      '  sub: router({',
      '    nestedBridgeProc: publicProcedure',
      '      .input(z.object({ blockToken: z.string().min(1) }))',
      '      .mutation(async ({ input }) => authorizeBlockBridgeToken(input.blockToken)),',
      '  }),',
      '});',
    ].join('\n');
    const { procs } = bridgeInputProcs(ROUTER, source);
    expect(procs).toEqual(['nestedBridgeProc']);
    expect(procsReachingGuard(source)).toEqual(['nestedBridgeProc']);
  });

  it('resolves an imported schema, not just an inline z.object', () => {
    // `getMyBuzzAccounts`, `getMyBuzzTransactions` and `getMyDailyCompensation` carry their
    // token through a schema imported from
    // `~/server/schema/buzz.schema`. If import resolution silently broke, the population
    // would shrink by exactly those three and the ledger below would go red with no clue
    // why — so pin the resolution itself.
    expect(schemaCarriesBlockToken('getMyBuzzTransactionsInput', ROUTER)).toBe(true);
    expect(schemaCarriesBlockToken('getMyBuzzAccountsInput', ROUTER)).toBe(true);
    expect(schemaCarriesBlockToken('getMyDailyCompensationInput', ROUTER)).toBe(true);
    // A schema that genuinely has no block token must come back false, not true — a
    // resolver that answered `true` for everything would satisfy the three above.
    expect(schemaCarriesBlockToken('getAppDetailSchema', ROUTER)).toBe(false);
  });

  it('depth-0 nulls reach `unresolved`, deeper ones reach the nested ledger', () => {
    // 🔴 THIS PINS AN ASYMMETRY, AND HALF OF IT IS A GAP RATHER THAN A GUARANTEE — the same
    // reason `the object-key rule drops a ternary branch` is asserted below. Two docstrings
    // used to describe `unresolved` as though it covered the whole walk; it covers the TOP of
    // each chain. Asserting both halves means neither claim can rot into the other, and the
    // day the descent learns to report a nested null as `unresolved`, this test goes red and
    // points at the prose that has to stop saying otherwise.
    //
    // (a) DEPTH 0 — an identifier `schemaIdentifiers` returned, unreadable, IS reported.
    const wrapper = [
      'export const r = router({',
      '  wrapped: publicProcedure',
      '    .input(wrapperInput.extend({ page: z.number() }))',
      '    .mutation(async () => 1),',
      '});',
    ].join('\n');
    const depth0 = bridgeInputProcs(ROUTER, wrapper);
    expect(depth0.procs).toEqual([]);
    expect(depth0.unresolved).toEqual(['wrapped -> wrapperInput']);
    expect(depth0.unreadableNested).toEqual([]);

    // (b) DEEPER — a reference the walk cannot read is still scored `false`, i.e. "no token
    // here", but it is RECORDED rather than discarded. Taken from the real corpus because
    // that is where the shape lives: `definitionText` finds the outer const, and its body
    // references an identifier imported by a RELATIVE specifier that `resolveModule` refuses.
    const unreadable: string[] = [];
    const verdict = schemaCarriesBlockToken(
      'BLOCK_SCOPE_TO_OAUTH_BIT',
      BLOCK_SCOPE_CONSTANTS,
      new Set(),
      0,
      [],
      unreadable
    );
    expect(
      verdict,
      'The nested null is still scored as `false`. That is the OPEN limit this test pins: ' +
        'change it to report and the docstrings on schemaCarriesBlockToken and ' +
        'bridgeInputProcs both have to stop saying coverage is depth-0.'
    ).toBe(false);
    expect(
      unreadable,
      'A nested reference the walk could not read must be RECORDED. Empty here means the ' +
        'null was discarded again, which is the silent scoring this ledger exists to end.'
    ).toEqual([`${BLOCK_SCOPE_CONSTANTS}#BLOCK_SCOPE_TO_OAUTH_BIT -> #TokenScope`]);
  });
});

describe('no unguarded block-bridge token verification', () => {
  it('routes every bridge call site through the guard, and exactly the ledgered ones', () => {
    const { guarded } = scan(read(ROUTER));

    expect(
      [...guarded].sort(),
      'The set of bridge procedures resolving claims through authorizeBlockBridgeToken ' +
        'changed. If you ADDED a bridge proc, add it to GUARD_CALL_SITE_LEDGER in this ' +
        'file. If one DISAPPEARED, it was deleted, renamed, or put back on a bare ' +
        'verifyBlockToken — the last of those is the defect this guard exists for. This ' +
        'fails in both directions on purpose.'
    ).toEqual(GUARD_CALL_SITE_LEDGER);
  });

  it('names each site once — a duplicate would hide a shrink behind a growth', () => {
    const { guarded } = scan(read(ROUTER));
    expect([...new Set(guarded)].length).toBe(guarded.length);
  });

  it('ledgers every procedure that TAKES a block token — the population, not the call sites', () => {
    const { procs, unresolved, truncated, unreadableNested } = bridgeInputProcs(
      ROUTER,
      read(ROUTER)
    );

    expect(
      unreadableNested,
      'The set of references the schema walk cannot read BELOW depth 0 changed. Each one is ' +
        'scored as carrying no blockToken without anybody having read it, so the set is ' +
        'ledgered in NESTED_UNREADABLE_LEDGER and compared in both directions. If you ADDED ' +
        'one, note that this scan CANNOT tell you whether it carries a blockToken — that is ' +
        'what unreadable means — so go and read the declaration yourself before ledgering ' +
        'it. If one DISAPPEARED the walk got wider, which is good: drop it from the ledger. ' +
        'Do NOT widen the ledger to silence a reference you have not read: teach ' +
        'resolveModule or definitionText to reach it instead.'
    ).toEqual(NESTED_UNREADABLE_LEDGER);

    expect(
      unresolved,
      "An identifier in a procedure's .input(...) argument could not be resolved to a " +
        'definition, so this scan cannot say whether it carries a blockToken. An ' +
        'unreadable schema scores the same as one with no token in it, which is how a ' +
        'population check stops covering things without going red. This covers ANY shape ' +
        'of argument — a bare schema, a .extend(...)/.merge(...) chain, a factory call — ' +
        'not only the bare-identifier case. Listed as proc -> ident.\n' +
        'WHICH FIX APPLIES DEPENDS ON WHY IT FAILED, and the previous wording named only ' +
        'one cause, which sent people to the wrong function: (a) the specifier is relative ' +
        'or a package path, so resolveModule refused it — teach resolveModule; (b) the ' +
        'specifier resolved but the DECLARATION is re-exported (`export ... from`), which ' +
        'importMap does not parse because it reads `import ... from` only — teach importMap, ' +
        'NOT resolveModule, which already succeeded; (c) the declaration is not a ' +
        'const/let/var (a function, type, interface, class or enum) — teach ' +
        'findDefinitionText; (d) it is NOT A SCHEMA REFERENCE AT ALL but part of an arrow ' +
        'function that `bound` failed to bind, in which case there is nothing to resolve and ' +
        'none of the three readers above owns it. Two known shapes, and they need DIFFERENT ' +
        'fixes — an earlier version of this message said "widen `bound`" for both, which is ' +
        'provably wrong for the second:\n' +
        '  (d1) a default value containing a call, `(x, y = z.string()) => ...`, reports `x` ' +
        'and `y`. The names ARE parameters, so widening the parameter-list regex to balance a ' +
        'nested `()` does fix it.\n' +
        '  (d2) a RETURN-TYPE annotation, `(v): v is Foo => ...`, reports `v` and `is`. ' +
        'Widening the parameter-list regex CANNOT fix this: the list is just `v`, and `is` ' +
        'sits between the `)` and the `=>`, which is not a parameter list at all. Measured — a ' +
        'balanced-paren widening captures `v` and leaves `is`. The fix is to cover that ' +
        'region: bind the names in `) : ... =>`, or skip it. Do NOT reach for a suppression ' +
        'set instead: `is` is absent from RESERVED_WORDS, and adding it reds ' +
        '`every suppressed word is a language keyword`, whose remedy points at ' +
        'ECMASCRIPT_NON_NAMING_WORDS where `is` would be a false entry — `const is = ' +
        'z.object({})` is legal TypeScript.\n' +
        'So: identify which of (a)-(d) you are looking at FIRST. An earlier version of this ' +
        'message enumerated only (a)-(c) and closed with "in every case, fix the READER", ' +
        'which is what stops the next reader looking for a fourth cause. Whichever it is, fix ' +
        'the READER; do not exempt the procedure and do not add the name to a suppression set.'
    ).toEqual([]);

    expect(
      truncated,
      `A schema chain outgrew MAX_SCHEMA_DEPTH (${MAX_SCHEMA_DEPTH}), so the walk gave up ` +
        'and scored that branch as carrying no blockToken — a verdict nobody read. Raise ' +
        'the cap, or shorten the chain. Listed as file#ident @ depth.'
    ).toEqual([]);

    expect(
      procs,
      'The set of procedures in blocks.router.ts whose input carries a blockToken ' +
        'changed. If you ADDED a bridge procedure, add it to BRIDGE_INPUT_LEDGER — and ' +
        'note that the next assertion requires it to reach authorizeBlockBridgeToken. ' +
        'If one DISAPPEARED it was deleted or renamed. Both directions fail on purpose.'
    ).toEqual(BRIDGE_INPUT_LEDGER);
  });

  it('THE RELATIONSHIP — every procedure taking a block token reaches the guard', () => {
    const source = read(ROUTER);
    const { procs } = bridgeInputProcs(ROUTER, source);
    const reaching = new Set(procsReachingGuard(source));
    const unguarded = procs.filter((p) => !reaching.has(p));

    expect(
      unguarded,
      'These procedures accept a blockToken and never reach authorizeBlockBridgeToken — ' +
        'not directly and not through a router-local helper. Whatever they do with the ' +
        'token instead (decode it, trust it, verify it by some other name), the install ' +
        'is not being checked: a revoked install and a suspended app both still drive ' +
        'them until the token expires on its own. Resolve claims through ' +
        'authorizeBlockBridgeToken. If the verification genuinely lives in an imported ' +
        'module, this scan cannot see it — say so here and widen the scan, do not exempt ' +
        'the procedure.'
    ).toEqual([]);
  });

  it('keeps every proc chunk intact — a truncated chunk would shrink the population silently', () => {
    // `chunks` ends a chunk at the next COLUMN-ZERO letter or `}` in the COMMENT-STRIPPED view
    // (`codeWithLiterals`), which is the router's own formatting, not a brace count. A line that
    // legitimately starts in column zero inside a proc — a multi-line template literal's
    // continuation — cuts the chunk short, and if that lands before `.input(` the proc leaves
    // the population with nothing going red. A column-zero line inside a BLOCK COMMENT does NOT
    // cut, which is why the view has to be named here and not just the column. Every tRPC
    // procedure ends in one of these three terminators, so their presence is a cheap structural
    // proof that no chunk was cut.
    const procChunks = chunks(read(ROUTER)).filter((c) => c.kind === 'proc');
    // The SAME predicate the synthetic control below exercises — see `cutProcChunks`.
    const truncated = cutProcChunks(read(ROUTER));

    expect(
      truncated,
      'These procedure chunks do not contain the .mutation( / .query( / .subscription( ' +
        'that terminates a tRPC procedure, which means the chunk was cut short — almost ' +
        'certainly by a line starting in column zero inside the procedure body, most likely a ' +
        'multi-line TEMPLATE LITERAL continuation. Note what it is NOT: a column-zero line ' +
        'inside a block COMMENT cannot do this, because the boundary is measured on the ' +
        'comment-stripped view. Anything after the cut, .input( included, is invisible to the ' +
        'population scan.'
    ).toEqual([]);
    // Positive control on the same read: the scan found procedures at all.
    expect(procChunks.length).toBeGreaterThan(50);
  });

  /**
   * 🔴 THE COMMITTED CONTROL FOR THE ASSERTION ABOVE, WHICH HAD NONE. `> 50` against 75 is a
   * real positive control for the COUNT — it proves the scan found procedures at all — but it
   * says nothing about the FAILURE MODE, and a guard nobody has watched fail is a claim about
   * its own regex. The truncation had been reproduced by hand and the result written into a
   * review; that is not a test, and a review does not run again next week.
   *
   * WHY A SYNTHETIC AND NOT THE REAL ROUTER. The real router is 75 of 75 intact, which is the
   * whole point of the assertion above — so the only way to exercise the red path is to build
   * the cut. Both shapes are built here because they harm the population differently and only
   * one of them leaves any other trace:
   *
   *   (a) the cut lands BEFORE `.input(` — `inputArg` finds no `.input(` at all, the caller
   *       `continue`s, and the procedure leaves the population with `procs` AND `unresolved`
   *       BOTH EMPTY. Nothing else in this file can see that. It is the merged outcome the
   *       header forbids, and the terminator count is the only witness.
   *   (b) the cut lands INSIDE `.input(` — the argument no longer closes, so this one also
   *       surfaces as an `<unbalanced .input( argument>`. Asserted too, so the two shapes
   *       cannot be confused for one another.
   *
   * The cutting line is a column-zero continuation of a multi-line template literal, which is
   * legal TypeScript and formats exactly this way — `chunks` ends a chunk at the next
   * column-zero letter or `}` in the COMMENT-STRIPPED view, which is the router's formatting
   * rather than a brace count. The view is the load-bearing half of that sentence: a template
   * continuation survives comment-stripping and cuts, a block-comment body line does not and is
   * pinned NOT to cut by `a column-zero COMMENT body line does not end a procedure`.
   */
  it('POSITIVE CONTROL — a chunk cut short by a column-zero line is CAUGHT, not silently dropped', () => {
    // (a) cut BEFORE `.input(` — the silent case.
    const cutBeforeInput = [
      'export const r = router({',
      '  cutProc: publicProcedure',
      '    .use(withAudit(`audit note line one',
      'column-zero continuation`))',
      '    .input(z.object({ blockToken: z.string().min(1) }))',
      '    .mutation(async ({ input }) => authorizeBlockBridgeToken(input.blockToken)),',
      '  intactProc: publicProcedure.query(async () => 1),',
      '});',
    ].join('\n');
    expect(
      cutProcChunks(cutBeforeInput),
      'A procedure chunk cut before its terminator must be REPORTED. Empty here means the ' +
        'assertion above would stay green while a bridge procedure left the population.'
    ).toEqual(['cutProc']);
    // …and the harm it is standing in for: the population is silent in BOTH directions.
    const harmed = bridgeInputProcs(ROUTER, cutBeforeInput);
    expect(harmed.procs).toEqual([]);
    expect(harmed.unresolved).toEqual([]);

    // (b) cut INSIDE `.input(` — caught here AND by the unbalanced-argument report.
    const cutInsideInput = [
      'export const r = router({',
      '  cutProc: publicProcedure',
      '    .input(z.object({ blockToken: z.string().describe(`note line one',
      'column-zero continuation`) }))',
      '    .mutation(async ({ input }) => authorizeBlockBridgeToken(input.blockToken)),',
      '  intactProc: publicProcedure.query(async () => 1),',
      '});',
    ].join('\n');
    expect(cutProcChunks(cutInsideInput)).toEqual(['cutProc']);
    expect(bridgeInputProcs(ROUTER, cutInsideInput).unresolved).toEqual([
      'cutProc -> <unbalanced .input( argument>',
    ]);

    // 🔴 THE NEGATIVE CONTROL, without which the two positives above are satisfied by a
    // predicate that flags every chunk. The SAME sources with the template moved to an
    // indented continuation — the only difference — must yield NOTHING, and `intactProc` must
    // be absent from every list above rather than merely unmentioned.
    const notCut = cutBeforeInput.replace(
      '\ncolumn-zero continuation`))',
      '\n      indented continuation`))'
    );
    expect(notCut).not.toEqual(cutBeforeInput);
    expect(
      cutProcChunks(notCut),
      'Indenting the continuation is the only change, so a non-empty list here means the ' +
        'predicate flags intact chunks and the positives above prove nothing.'
    ).toEqual([]);
    expect(bridgeInputProcs(ROUTER, notCut).procs).toEqual(['cutProc']);
  });

  it('a column-zero COMMENT body line does not end a procedure', () => {
    // 🔴 THE OTHER SIDE OF THE SAME BOUNDARY, and a false RED reachable from prettier-clean
    // source: prettier does not reindent the body lines of a block comment, so a committer may
    // legitimately leave one in column zero. While the close test read RAW lines, that ended the
    // chunk — `cutProcChunks` returned the procedure and `procsReachingGuard` returned nothing,
    // for a procedure whose very next line calls the guard. The message then blamed a column-zero
    // line, which the committer was entitled to write and could not act on.
    //
    // The pair matters: this asserts a comment body line does NOT close, while
    // `a chunk cut short by a column-zero line is CAUGHT` asserts a template continuation DOES.
    // Only `codeWithLiterals` answers both — comments stripped, literal bodies kept — so a
    // change to either of the other two views breaks exactly one of these two tests.
    const withComment = [
      'export const r = router({',
      '  realProc: publicProcedure',
      '    .input(z.object({ blockToken: z.string().min(1) }))',
      '    /*',
      'Foo bar — a block-comment body line left in column zero by the formatter.',
      '    */',
      '    .mutation(async ({ input }) => authorizeBlockBridgeToken(input.blockToken)),',
      '});',
    ].join('\n');
    expect(
      cutProcChunks(withComment),
      'A column-zero line inside a COMMENT must not end the chunk. Returning the procedure ' +
        'here is a false red on source the formatter produces, and its message names a cause ' +
        'the committer cannot act on.'
    ).toEqual([]);
    // …and the procedure is still scored correctly on both ledgers, which is what the false red
    // was costing: it reported the guard as unreachable from a proc that calls it.
    expect(bridgeInputProcs(ROUTER, withComment).procs).toEqual(['realProc']);
    expect(procsReachingGuard(withComment)).toEqual(['realProc']);
  });

  /**
   * 🔴 THE BACKSTOP FOR `PROC_RE`'s SPELLING (clawgate #589, finding 1), and the converse of
   * the assertion above. That one asks "does every chunk we opened keep its terminator"; this
   * asks "does every terminator in the file belong to a chunk we opened" — which is the
   * direction a procedure spelled some other way escapes through.
   *
   * `PROC_RE` pins the builder as `*[Pp]rocedure`, so `t.procedure`, `'quoted': publicProcedure`
   * and `makeProcedure()` all fall out of the population root. MEASURED before this check:
   * adding a proc spelled `evasiveProc: t.procedure` with a `blockToken` input and NO guard
   * call left the whole file GREEN — it was not in the population, so nothing required it to
   * reach the guard, and the only magnitude control (`> 50` against 75) could not see one
   * missing proc or twenty.
   *
   * WHY THIS SEES IT. A tRPC procedure ends in exactly one `.mutation(` / `.query(` /
   * `.subscription(` whatever its builder is spelled like. `chunks` runs a chunk on until the
   * NEXT one opens, so an unrecognised procedure's body is absorbed into its predecessor:
   * that chunk then holds two terminators. If it has no predecessor the terminator is
   * attributed to nothing and the totals disagree. Both are asserted, because either alone
   * misses a case.
   *
   * ⚠️ WHAT IT STILL CANNOT SEE, stated because it is open, and stated NARROWLY because an
   * earlier draft of this paragraph was measurably too generous. It claimed "tRPC has exactly
   * these three, so this is a claim about tRPC rather than about text" — and it was a claim
   * about TEXT: `['mutation'](` is one of those three methods reached by a computed access,
   * and it walked straight through. `astTerminatorCount` now counts both the dotted and the
   * computed form from the parse, so what remains is narrower and genuinely about tRPC:
   *   - A procedure terminated by some OTHER METHOD NAME. The three names are hard-coded, so
   *     a future builder method would carry a procedure out of the population and out of this
   *     backstop together. That is an assumption about tRPC's API, not about spelling.
   *   - A terminator reached through a name this file cannot resolve — `const m = 'mutation';
   *     …[m](…)`. The parse gives the access, not the value of a variable.
   *   - A bridge procedure defined in another FILE and spread into this router. Reachability
   *     is computed inside `blocks.router.ts` only, which the header already states.
   * A legitimate `.query(`/`.mutation(` called on something else inside a procedure body
   * would produce a FALSE RED here. There are none today (measured: 75 terminators, 75 proc
   * chunks, one each) and the fix is to hoist that call, which is the fail-closed direction.
   */
  it('attributes every tRPC terminator to a named procedure — a proc spelled another way cannot hide', () => {
    const source = read(ROUTER);
    const procChunks = chunks(source).filter((c) => c.kind === 'proc');
    // Counted from the PARSE, so a computed `['mutation'](` is counted too — see
    // `astTerminatorCount`. The per-chunk count below stays textual; between them, an
    // unrecognised procedure either doubles a chunk or moves the total, and both are asserted.
    const fileTerminators = astTerminatorCount(source, ROUTER);

    const notExactlyOne = procChunks
      .map((c) => ({ name: c.name, n: countCalls(PROC_TERMINATOR_RE, c.code) }))
      .filter(({ n }) => n !== 1)
      .map(({ name, n }) => `${name}: ${n}`);

    expect(
      notExactlyOne,
      'A procedure chunk holds a number of tRPC terminators other than one. TWO means a ' +
        'procedure PROC_RE did not recognise was absorbed into this one — check for a ' +
        'builder spelled something other than `<x>Procedure` (`t.procedure`, a quoted key, ' +
        'a factory call): it is outside the derived population, so nothing requires it to ' +
        'reach authorizeBlockBridgeToken. ZERO means the chunk was cut short. Listed as ' +
        'proc: count.'
    ).toEqual([]);

    expect(
      fileTerminators,
      `${ROUTER} contains ${fileTerminators} tRPC terminators but only ` +
        `${procChunks.length} are attributed to a named procedure. A terminator belonging ` +
        'to no chunk is a procedure defined before the first one PROC_RE recognises, or ' +
        'outside the router object entirely — either way it is outside the population.'
    ).toBe(procChunks.length);

    // Report the pair, never a bare equality: both sides must be a real number of procedures.
    expect(fileTerminators).toBeGreaterThan(50);
  });

  it('mentions verifyBlockToken in the router only in PROSE — no code path spells it', () => {
    // 🔴 WIDER THAN THE IMPORT ASSERTION BELOW, AND DELIBERATELY SO. `importMap` parses
    // static `import { … } from '…'` only, so it cannot see
    // `const { verifyBlockToken: vbt } = await import('~/server/middleware/…')` — an idiom
    // this router uses 89 times for other modules. That defeats the alias check AND
    // DIRECT_CALL_RE at once. Rather than add a third spelling regex per import syntax,
    // pin the fact that the identifier appears in `blocks.router.ts` in COMMENTS ONLY.
    //
    // A code line carrying a trailing comment that names it would fail here. That is a
    // false red, and the cure is to reword the comment — cheap, and the alternative is a
    // check that can be walked by writing the import on a commented line.
    // 🔴 NORMALISED, NOT A LEADING-COMMENT REGEX. The old filter dropped any line whose
    // FIRST token opens a comment, so `/* eslint-disable-next-line */ const c = await
    // verifyBlockToken(t);` was invisible to the assertion that calls itself the one that
    // sees all four reachability routes. `codeWithLiterals` removes comments wherever they
    // sit and preserves line structure exactly, so the numbers still index the raw file —
    // and it KEEPS literal bodies, which is required here: `mod['verifyBlockToken'](t)` is a
    // live call whose identifier lives inside a string.
    const rawLines = read(ROUTER).split('\n');
    const offenders = codeWithLiterals(read(ROUTER), ROUTER)
      .split('\n')
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => /\bverifyBlockToken\b/.test(line))
      .map(({ line, n }) => `${n}: ${(rawLines[n - 1] ?? line).trim()}`);

    expect(
      offenders,
      `${ROUTER} names verifyBlockToken on a line that is not a comment. The bridge's only ` +
        'entry point is authorizeBlockBridgeToken: a static import, a dynamic ' +
        '`await import()` destructure, a member access on a namespace import and a direct ' +
        'call are all reachable this way, and this is the one assertion that sees all four.'
    ).toEqual([]);
  });

  it('does not let an import alias hide the bare verify — the router may not import it at all', () => {
    // DIRECT_CALL_RE is a spelling check, so `import { verifyBlockToken as verify }` walks
    // through it. This pins the structural fact instead: the router has no business
    // importing the bare verifier under any local name.
    //
    // ⚠️ SCOPE, because the name of this test reads wider than it is: `importMap` parses
    // STATIC `import { … } from '…'` declarations and nothing else. A dynamic
    // `const { verifyBlockToken: vbt } = await import(…)` is invisible to it. That case is
    // covered — by `mentions verifyBlockToken in the router only in PROSE` above, which
    // works line-wise and needs no import syntax at all — not by this assertion.
    const local = [...importMap(read(ROUTER))].filter(
      ([, binding]) => binding.imported === 'verifyBlockToken'
    );
    expect(
      local.map(([name]) => name),
      `${ROUTER} must not import verifyBlockToken, aliased or not. The bridge's only ` +
        'entry point is authorizeBlockBridgeToken; an import of the bare verifier is ' +
        'either a direct call the spelling check would catch, or an aliased one it would ' +
        'not.'
    ).toEqual([]);
  });

  it('leaves no direct verifyBlockToken call in the router', () => {
    const { direct } = scan(read(ROUTER));

    expect(
      direct,
      `${ROUTER} must not call verifyBlockToken directly — a bare verify checks the ` +
        'signature and expiry and nothing else, so it honours a revoked install and a ' +
        'suspended app for a whole token lifetime. Call authorizeBlockBridgeToken instead ' +
        '(lines listed are 1-based).'
    ).toEqual([]);
  });

  it('keeps the verification in ONE place — the guard calls it exactly once', () => {
    const { direct } = scan(read(GUARD));
    expect(
      direct.length,
      `${GUARD} must call verifyBlockToken exactly ONCE, and this counts CALLS on lines of ` +
        'CODE — a mention in a comment or inside a string counts for nothing. MORE than one ' +
        'is a second predicate, which is how the thirteen open-coded copies this replaced ' +
        'came to disagree with each other. ZERO is worse and is the reason the comment and ' +
        'string filtering exists: with a prose mention present, the raw scan read 1 while ' +
        'the real call had been deleted and the bridge verified nothing at all.'
    ).toBe(1);
  });

  /**
   * 🔴 THE POSITIVE CONTROL FOR THE NORMALISERS, AND WHY ITS ABSENCE WAS A REAL GAP.
   *
   * Every spelling assertion in the test below is filtered through one of these two, and they
   * are the ONLY thing standing between those assertions and prose — or a string — satisfying
   * them: this file's own docblocks name both `BlockRevocation.isRevoked` and
   * `resolveAppBlockApprovalVerdict`, and the predicate module's docblock quotes
   * `status === 'approved'` verbatim while describing the mint endpoint.
   *
   * Measured on the line-wise predecessor: replacing its body with `return source;` left the
   * whole file GREEN (21/21 when #4818 measured it; the file was 22 tests by 2026-09-19). The REST sibling's copy IS controlled — the same mutation
   * fails there — but the helper is deliberately DUPLICATED rather than shared (see its
   * docblock), which is precisely what makes that control non-transferable. A guard whose own
   * filter can be deleted without complaint is the shape this family keeps producing, so each
   * copy needs its own control.
   *
   * Criterion: an identity mutation (`return source;`) on EITHER helper must fail at least
   * one assertion here. Both are exercised on a comment, a trailing comment, a string, and a
   * line of real code, so neither can be reduced to a pass-through unnoticed.
   */
  it('POSITIVE CONTROL — the normalisers strip comments AND re-delimit strings', () => {
    // (a) COMMENTS. The exact shapes the assertion below would otherwise be satisfied by.
    // 🔴 WHOLE BLOCKS, NOT ORPHAN LINES. Unlike the line-wise predecessor this is a real
    // scanner, so a ` * …` docblock continuation is only a comment because a `/**` is open
    // above it — feeding it one line in isolation is not the shape it ever sees, and a
    // control built that way would be testing a fiction rather than the corpus.
    expect(codeWithLiterals("// expect(guard).toMatch(/status === 'approved'/)").trim()).toBe('');
    const docblock = [
      '/**',
      ' * resolveAppBlockApprovalVerdict(claims) resolves the verdict, and',
      ' * BlockRevocation.isRevoked(claims.blockInstanceId, claims.sub) checks the marker.',
      ' */',
      'const unrelated = 1;',
    ].join('\n');
    expect(countCalls(/\bresolveAppBlockApprovalVerdict\s*\(/g, stripNonCode(docblock))).toBe(0);
    expect(stripNonCode(docblock)).not.toMatch(/BlockRevocation\.isRevoked\(/);
    expect(stripNonCode(docblock)).toMatch(/const unrelated = 1;/);
    expect(
      codeWithLiterals('/* BlockRevocation.isRevoked(claims.blockInstanceId, claims.sub) */').trim()
    ).toBe('');
    // 🔴 A TRAILING comment on a line of CODE, which the line-wise predecessor let through
    // whole. This is the half that made `procsReachingGuard` satisfiable by a comment.
    expect(
      countCalls(GUARD_CALL_RE, stripNonCode('const x = 1; // authorizeBlockBridgeToken(tok)'))
    ).toBe(0);
    // …and a real call still counts, or the filter would strip everything and the assertions
    // below would fail for the wrong reason rather than pass for the right one.
    expect(
      countCalls(GUARD_CALL_RE, stripNonCode('const c = await authorizeBlockBridgeToken(tok);'))
    ).toBe(1);

    // (b) STRINGS. `codeWithLiterals` keeps the body READABLE but re-delimited, so an
    // expression written inside a string can no longer impersonate the expression.
    const real = codeWithLiterals("if (block.status === 'approved') return 'ok';");
    const faked = codeWithLiterals('const doc = "status === \'approved\'";');
    expect(real).toMatch(APPROVED_COMPARISON_RE);
    expect(
      faked,
      'A string literal spelling the comparison must NOT satisfy the comparison assertion'
    ).not.toMatch(APPROVED_COMPARISON_RE);
    // And the naive form — what the assertion looked like before — matches BOTH, which is
    // the fail-open this closes. Reported as a pair so the negative above is not read alone.
    expect(/status === 'approved'/.test('const doc = "status === \'approved\'";')).toBe(true);

    // (c) `stripNonCode` empties the body, so a string CANNOT inflate a count either.
    expect(
      countCalls(GUARD_CALL_RE, stripNonCode("const s = 'authorizeBlockBridgeToken(x)';"))
    ).toBe(0);
    expect(countCalls(PROC_TERMINATOR_RE, stripNonCode("const s = 'a .query( b';"))).toBe(0);
  });

  it('POSITIVE CONTROL — the normalisers preserve the line structure exactly', () => {
    // `scan` reports line numbers off the normalised text and `chunks` slices raw and
    // normalised lines at the SAME indices. Both are wrong the moment a normaliser adds or
    // drops a line, and neither would say so — the numbers would simply be off by however
    // many lines a docblock or a template literal spans.
    const source = [
      'const a = 1;',
      '/* a block comment',
      '   spanning three',
      '   lines */ const b = 2;',
      'const t = `a template',
      'over two lines`;',
      'const c = 3; // trailing',
    ].join('\n');
    const lineCount = source.split('\n').length;
    expect(codeWithLiterals(source).split('\n')).toHaveLength(lineCount);
    expect(stripNonCode(source).split('\n')).toHaveLength(lineCount);
    // 🔴 AND LENGTH, WHICH IS NOW LOAD-BEARING TOO. `inputArg` balances parentheses over the
    // normalised text and then slices the argument out of the RAW text at the SAME offsets;
    // that is only sound while every replaced span is exactly as long as what it replaced.
    // Nothing else would notice it drifting — the slice would simply be the wrong substring.
    expect(codeWithLiterals(source)).toHaveLength(source.length);
    expect(stripNonCode(source)).toHaveLength(source.length);
    // …and the code that FOLLOWED each removed span is still on its own original line.
    expect(codeWithLiterals(source).split('\n')[3]).toContain('const b = 2;');
    expect(stripNonCode(source).split('\n')[6]).toContain('const c = 3;');
  });

  it('the approved comparison is pinned by VALUE, not by quote style', () => {
    // 🔴 THE CONTROL OVER PLAUSIBLE SPELLINGS, because the assertion it backs is one of the
    // two places in this file where a literal is genuinely required. Every quote style the
    // language admits must satisfy it — `tsc` accepts all three and the runtime compares
    // with `===`, so a guard that pinned one of them would be the `'serve'` defect again
    // (the REST sibling's `LOOKUP_FAILURE_OPT_OUT_RE`, which shipped exactly that).
    for (const spelling of [
      "if (block.status === 'approved') return 'ok';", // single quotes
      'if (block.status === "approved") return "ok";', // double quotes
      'if (block.status === `approved`) return `ok`;', // template literal
      "if (block.status   ===   'approved') return 'ok';", // padded
    ]) {
      expect(codeWithLiterals(spelling), `${spelling} must satisfy the comparison`).toMatch(
        APPROVED_COMPARISON_RE
      );
    }
    // …and the NEGATIVE half, or the loop above would pass on a regex that matches anything:
    // a different value, and the comparison written inside a string, must both fail.
    expect(codeWithLiterals("if (block.status === 'suspended') return 'ok';")).not.toMatch(
      APPROVED_COMPARISON_RE
    );
    expect(codeWithLiterals('const doc = "status === \'approved\'";')).not.toMatch(
      APPROVED_COMPARISON_RE
    );
    // The three documented fail-CLOSED limits, pinned so the docstring's admission is a
    // checked fact rather than a recollection. Each of these is a CORRECT comparison that
    // this assertion nevertheless rejects; that is the false-red cost, stated in full.
    for (const notSeen of [
      'if (block.status === APPROVED_STATUS) return 1;', // a const, not an inline literal
      "if ('approved' === block.status) return 1;", // reversed operands
      "if (block.status == 'approved') return 1;", // loose equality
    ]) {
      expect(codeWithLiterals(notSeen), `${notSeen} is a documented limit`).not.toMatch(
        APPROVED_COMPARISON_RE
      );
    }
  });

  it('the object-key rule drops a ternary branch — a stated limit, pinned as a fact', () => {
    // 🔴 THIS ASSERTS A GAP, NOT A GUARANTEE. `schemaIdentifiers` disqualifies a token
    // followed by a colon as an object key, and a conditional puts a schema in exactly that
    // position. The identifier is DROPPED rather than reported unresolved, which is the
    // merged outcome this file's header forbids — recorded on `schemaIdentifiers` as
    // knowingly open because separating a key from a ternary branch needs the parse, and
    // this function is handed an argument fragment.
    //
    // Pinning it means the day someone fixes it, this test goes red and points at the
    // docstring that has to stop saying the limit exists. That is the whole reason to assert
    // a gap rather than describe one.
    expect(schemaIdentifiers('useV2 ? bridgeInputWithToken : legacyInput')).toEqual([
      'useV2',
      'legacyInput',
    ]);
    // The population is unaffected TODAY, and that is the measurement that makes the limit
    // latent rather than live: zero ternary `.input()` arguments in the real router.
    const ternaries = chunks(read(ROUTER))
      .filter((c) => c.kind === 'proc')
      .filter((c) => /\.input\(\s*[A-Za-z_$][A-Za-z0-9_$]*\s*\?/.test(c.code))
      .map((c) => c.name);
    expect(
      ternaries,
      'A procedure now passes a ternary to .input(). schemaIdentifiers drops the branch after ' +
        'the colon SILENTLY, so this procedure may be scored as carrying no blockToken with ' +
        'nothing in `unresolved` to say so. Hoist the schema to a const, or teach ' +
        'schemaIdentifiers to parse.'
    ).toEqual([]);
  });

  /**
   * 🔴 THE THREE SHAPES A HAND-ROLLED LEXER GOT WRONG, each measured on the earlier draft of
   * this pass and each fail-OPEN. They are controls on the PARSER being the thing that
   * answers, so a future "simplification" back to a character scanner goes red here rather
   * than quietly reopening them.
   */
  it('POSITIVE CONTROL — a nested template cannot smuggle a fake guard call past the normaliser', () => {
    // A lexer pairs backticks 1-2 and 3-4, so the INNER literal's body comes out as code.
    // Measured: `procsReachingGuard` returned the proc, i.e. a procedure that verifies
    // nothing read as reaching the guard — finding (2) reached through a literal instead of
    // a comment, and not exotic: measured 2026-09-19, 35 nested template literals across 14
    // files under src/pages/api.
    const nested = [
      'export const r = router({',
      '  evilProc: publicProcedure',
      '    .input(z.object({ blockToken: z.string().min(1) }))',
      '    .mutation(async ({ input }) => {',
      '      logger.info(`bridge ${`authorizeBlockBridgeToken(input.blockToken)`} done`);',
      '      return input.blockToken.length;',
      '    }),',
      '});',
    ].join('\n');
    expect(bridgeInputProcs(ROUTER, nested).procs).toEqual(['evilProc']);
    expect(
      procsReachingGuard(nested),
      'a guard call written inside a nested template literal is not a guard call'
    ).toEqual([]);

    // The mirror image, which the lexer ALSO got wrong: a real call inside a `${}`
    // interpolation IS code, and swallowing it read as not reaching the guard.
    const interpolated = nested.replace(
      '`bridge ${`authorizeBlockBridgeToken(input.blockToken)`} done`',
      '`bridge ${authorizeBlockBridgeToken(input.blockToken)} done`'
    );
    expect(procsReachingGuard(interpolated)).toEqual(['evilProc']);
  });

  it('POSITIVE CONTROL — a commented-out guard call is stripped BETWEEN CHAINED CALLS too', () => {
    // 🔴 THE POSITION WAS THE WHOLE BUG, AND IT WAS LIVE. `scanTrivia` recursed with
    // `forEachChild`, which visits NODES and skips pure tokens — so a comment whose next token
    // is the `.` joining two links of a call chain was leading trivia of nothing the walk asked
    // about, and survived normalisation. That is clawgate #589 finding (2) — a guard call
    // satisfied by a COMMENT — reopened one position further out, and the comparison below is
    // what makes it unarguable: the identical comment inside the `.mutation` body was stripped
    // correctly the whole time. On the real router, 18 of 157 block-comment openers survived.
    const chained = (comment: string) =>
      [
        'export const r = router({',
        '  evasiveProc: publicProcedure',
        '    .input(z.object({ blockToken: z.string().min(1) }))',
        `    ${comment}`,
        '    .mutation(async ({ input }) => input.blockToken.length),',
        '});',
      ].join('\n');

    for (const comment of [
      '/* await authorizeBlockBridgeToken(input.blockToken) */',
      '// await authorizeBlockBridgeToken(input.blockToken)',
    ]) {
      const source = chained(comment);
      // It IS in the population — it takes a blockToken — which is what makes the next
      // assertion the one that matters.
      expect(bridgeInputProcs(ROUTER, source).procs).toEqual(['evasiveProc']);
      expect(
        procsReachingGuard(source),
        `${comment}\nA guard call written in a COMMENT between two chained calls is not a ` +
          'guard call. Returning the procedure here means a proc that verifies nothing reads ' +
          'as reaching the guard — the exact shape this normaliser exists to close.'
      ).toEqual([]);
    }

    // The mirror image, so the fix is not "blank everything in that position": a REAL guard
    // CALL between the chained links still counts. Note it must be a call — `GUARD_CALL_RE`
    // requires the `(`, so passing the guard by REFERENCE (`withAudit(authorizeBlockBridgeToken)`)
    // correctly counts for nothing, which is how this fixture was wrong on its first draft.
    const real = chained('.use(authorizeBlockBridgeToken(ctx))');
    expect(procsReachingGuard(real)).toEqual(['evasiveProc']);
  });

  it('a trailing comment after a pure TOKEN is not a guard call', () => {
    // 🔴 THIS EXISTS BECAUSE THE LINE IT PINS WAS DELETED ONCE, ON A CENSUS THAT WAS CORRECT AND
    // AN INFERENCE THAT WAS NOT. The census said token-level TRAILING was the sole source for 0
    // of 3,782 comment positions across the three files these suites read; that was read as
    // "every same-line trailing comment is already reached by the node-level call", which is
    // false. `getLeadingCommentRanges` deliberately skips a comment sharing a line with the code
    // before it, so a same-line comment following a pure TOKEN — `(`, `=`, `.`, `:`, `return` —
    // is trailing trivia of that token and of nothing else. Un-exercised on this corpus is not
    // unreachable, and the suite could not tell the difference: deleting the line was 42/42 green.
    //
    // Both manifestations are asserted, because they fail through different assertions: the proc
    // reads as REACHING the guard, and the comment also registers as a real call SITE.
    const commentedGuard = 'await authorizeBlockBridgeToken(input.blockToken)';
    const afterOpenParen = [
      'export const r = router({',
      '  evasiveProc: publicProcedure',
      '    .input(z.object({ blockToken: z.string().min(1) }))',
      `    .mutation( // ${commentedGuard}`,
      '      async ({ input }) => input.blockToken.length',
      '    ),',
      '});',
    ].join('\n');
    expect(
      countCalls(GUARD_CALL_RE, stripNonCode(afterOpenParen)),
      'A comment following `(` on the same line survived normalisation. It is trailing trivia ' +
        'of a TOKEN, which `getLeadingCommentRanges` does not report and no node-level call ' +
        'reaches — so the token-level trailing collection is the only thing that sees it.'
    ).toBe(0);
    expect(
      procsReachingGuard(afterOpenParen),
      'A procedure whose only mention of the guard is a COMMENT must not read as reaching it. ' +
        'This is the outcome `scan` reads normalised code to prevent.'
    ).toEqual([]);
    expect(
      scan(afterOpenParen).guarded,
      'A commented-out guard call must not register as a call SITE either — that would put a ' +
        'phantom entry into GUARD_CALL_SITE_LEDGER.'
    ).toEqual([]);

    // The same shape one token over: after `=` in a module-scope helper.
    const afterEquals = [
      `const helper = // ${commentedGuard}`,
      '  async (t: string) => t.length;',
      'export const r = router({',
      '  evasiveProc: publicProcedure',
      '    .input(z.object({ blockToken: z.string().min(1) }))',
      '    .mutation(async ({ input }) => helper(input.blockToken)),',
      '});',
    ].join('\n');
    expect(countCalls(GUARD_CALL_RE, stripNonCode(afterEquals))).toBe(0);
    expect(scan(afterEquals).guarded).toEqual([]);

    // 🔴 THE CONTROL, so none of the above is satisfied by a normaliser that blanks everything:
    // a REAL guard call in the very same position still counts.
    const realCall = [
      'export const r = router({',
      '  guardedProc: publicProcedure',
      '    .input(z.object({ blockToken: z.string().min(1) }))',
      '    .mutation(async ({ input }) => authorizeBlockBridgeToken(input.blockToken)),',
      '});',
    ].join('\n');
    expect(countCalls(GUARD_CALL_RE, stripNonCode(realCall))).toBe(1);
    expect(procsReachingGuard(realCall)).toEqual(['guardedProc']);
  });

  it('POSITIVE CONTROL — a regex literal does not desync the normaliser', () => {
    // `/^https?:\/\//` puts an adjacent `//` in the source, which a lexer takes as a line
    // comment and then discards the rest of the line. `blocks.router.ts` contains exactly
    // this shape, TWICE — so the earlier docstring's claim that no regex literal appears in
    // the scanned files was false when it was written.
    const withRegex = [
      "const host = raw.replace(/^https?:\\/\\//, '').replace(/\\/$/, '');",
      'const afterTheRegex = 1;',
    ].join('\n');
    expect(stripNonCode(withRegex)).toMatch(/const afterTheRegex = 1;/);
    expect(stripNonCode(withRegex).split('\n')).toHaveLength(2);
    // A regex body is a literal body, so it cannot satisfy a call check either.
    expect(
      countCalls(GUARD_CALL_RE, stripNonCode('const r = /authorizeBlockBridgeToken\\(/;'))
    ).toBe(0);
  });

  it('POSITIVE CONTROL — the terminator count sees a COMPUTED access, not only a dotted one', () => {
    const dotted = [
      'export const r = router({',
      '  a: publicProcedure.query(async () => 1),',
      '});',
    ].join('\n');
    const computed = [
      'export const r = router({',
      "  a: publicProcedure['query'](async () => 1),",
      '});',
    ].join('\n');
    // The textual regex sees the first and not the second — which is the walk.
    expect(countCalls(PROC_TERMINATOR_RE, stripNonCode(dotted))).toBe(1);
    expect(countCalls(PROC_TERMINATOR_RE, stripNonCode(computed))).toBe(0);
    // The parse sees both, which is what makes the totals disagree when a procedure spelled
    // some other way carries its terminator out of the population.
    expect(astTerminatorCount(dotted, ROUTER)).toBe(1);
    expect(astTerminatorCount(computed, ROUTER)).toBe(1);
    // And a call that is NOT a terminator must not be counted, or the equality above is
    // satisfied by a probe that counts everything.
    expect(astTerminatorCount('const x = db.findMany({});', ROUTER)).toBe(0);
  });

  it('POSITIVE CONTROL — an unbalanced `.input(` argument is REPORTED, not silently skipped', () => {
    // The paren balance used to run over RAW text, so a stray `(` inside a comment or a
    // string ran it off the end of the chunk and the procedure left the population with
    // `procs: []` AND `unresolved: []` — the merged outcome this file's header forbids.
    const sneaky = [
      'export const r = router({',
      '  sneakyProc: publicProcedure',
      '    .input(',
      '      z.object({',
      '        // the token minted by the host (see mintBlockToken',
      '        blockToken: z.string().min(1),',
      '      })',
      '    )',
      '    .mutation(async ({ input }) => input.blockToken.length),',
      '});',
    ].join('\n');
    const { procs, unresolved } = bridgeInputProcs(ROUTER, sneaky);
    // The comment's unbalanced paren is gone before balancing, so the argument reads cleanly
    // and the proc stays in the population where it belongs.
    expect(procs).toEqual(['sneakyProc']);
    expect(unresolved).toEqual([]);
    // …and a genuinely unclosed argument moves `unresolved` off zero rather than vanishing.
    const truncated = [
      'export const r = router({',
      '  brokenProc: publicProcedure',
      '    .input(z.object({ blockToken: z.string()',
      '    .mutation(async () => 1),',
      '});',
    ].join('\n');
    const broken = bridgeInputProcs(ROUTER, truncated);
    expect(broken.procs).toEqual([]);
    expect(broken.unresolved).toEqual(['brokenProc -> <unbalanced .input( argument>']);
  });

  it('rejects a source that already carries the literal sentinel', () => {
    // The re-delimiting above is only unambiguous while no literal body can contain the
    // delimiter. A raw U+0000 in a scanned file breaks that, so the helper refuses rather
    // than answering — the fail-closed-and-loud direction. Written with a code point rather
    // than a raw byte, for the same reason this file may not contain one.
    expect(() => codeWithLiterals(`const x = ${String.fromCharCode(0)};`)).toThrow(/U\+0000/);
    // Positive control on the guard's reachability: an ordinary source does NOT throw.
    expect(() => codeWithLiterals('const x = 1;')).not.toThrow();
  });

  it('still SPELLS the two checks the guard exists for', () => {
    const guard = read(GUARD);
    // 🔴 THIS IS A SPELLING CHECK, NOT A BEHAVIOURAL ONE — it asserts these strings are
    // still present, and that is ALL it can see. It is walkable in both directions: a
    // semantically identical rewrite FAILS it while the behaviour is intact, and a
    // comparison against the WRONG value spelled this way PASSES it. So it cannot certify
    // either check is correct — it only catches one dropped wholesale while everything
    // still type-checks.
    //
    // What actually pins the behaviour is
    // `src/server/routers/__tests__/blocks.router.bridgeTokenGuard.test.ts`. If you are
    // tempted to read this test as coverage, read that file instead.
    //
    // 🔴 THIS CHECK'S STATED REASON WAS FALSE, AND NO ESTABLISHED REASON HAS REPLACED IT.
    // Read that literally — it is a finding, not a placeholder. The original text said the
    // behavioural pin lives in "a different vitest project, which is why this cheap presence
    // check exists at all", so a reader deciding whether to delete this test was deciding on a
    // false premise. Project `unit` includes `src/**/*.test.ts` (`vitest.config.mts`), BOTH
    // files match it, and measured, `--project unit` over the two collects them in one run.
    //
    // 🔴 I AM THE SECOND WRITER OF THIS PARAGRAPH AND THE FIRST REPLACEMENT WAS ALSO WRONG.
    // Recorded so a third does not quietly appear. That draft claimed the split was "about what
    // each can SEE" — that the sibling only reds when behaviour changes, while this one catches
    // a check "dropped wholesale even if no test happened to exercise the path it covered".
    // Measured against the sibling: it exercises BOTH paths behaviourally, with two tests for a
    // revoked `blockInstanceId` and two for a non-approved `app_blocks` row. So the "no test
    // exercises it" half is false. Reaching for a second rationale under the pressure of having
    // none is how a guard accumulates successive justifications and keeps no real one.
    //
    // So the reason is OPEN, deliberately left that way, and what would settle it is a
    // MEASUREMENT rather than an argument: break each spelled check in
    // `src/server/services/blocks/block-bridge-auth.service.ts` and see whether the sibling
    // already goes red WITHOUT this test present —
    //   1. remove the `BlockRevocation.isRevoked(...)` call;
    //   2. remove the `resolveAppBlockApprovalVerdict(...)` delegation;
    //   3. drop that call's second argument (`claims.sub`), which type-checks because the
    //      parameter is optional by design — the case the note below calls the dangerous one.
    // Red on all three means this test is subsumed and should be DELETED, not re-justified.
    // That decision belongs to whoever owns the merge; it is named here so the next reader
    // inherits a mechanical question instead of a rationale to believe.
    // 🔴 NORMALISED, on EVERY assertion in this test — see `codeWithLiterals`. These used to
    // read the WHOLE file, which is satisfiable by prose: this very file's docblocks name
    // both `BlockRevocation.isRevoked` and `resolveAppBlockApprovalVerdict`. Identifier
    // presence uses `stripNonCode`, which EMPTIES string bodies, so a
    // `const doc = 'resolveAppBlockApprovalVerdict(claims)';` cannot satisfy one either —
    // the line-wise predecessor filtered comments and let every string through.
    const guardCode = stripNonCode(guard);
    // 🔴 BOTH ARGUMENTS. The second — the token's own `sub` — is what selects the
    // SUBJECT-SCOPED ban keyspace, and without it a ban on `page_ephemeral-<slug>` either
    // misses the banned holder or (in the global form this replaced) 403s every OTHER
    // author holding the same developer-chosen slug. Dropping it type-checks, because the
    // parameter is optional by design so a caller that lacks a subject degrades rather
    // than breaks.
    expect(guardCode).toMatch(
      /BlockRevocation\.isRevoked\(\s*claims\.blockInstanceId\s*,\s*claims\.sub\s*\)/
    );
    // 🔴 THE APPROVAL CHECK IS NO LONGER SPELLED IN THIS FILE. The row lookup and the
    // `approved` comparison moved to the shared predicate `resolveAppBlockApprovalVerdict`
    // (`block-approval.service.ts`), which the REST gate resolves through as well, so
    // neither half of the runtime can drift on WHICH row is read or WHAT counts as
    // approved. What this file must still spell is that the guard DELEGATES to it; what
    // the predicate module must still spell is the lookup itself. Both halves are asserted,
    // because either one alone passes while the check is gone: the delegation without the
    // predicate is a call to nothing, and the predicate without the delegation is dead code.
    expect(guardCode).toMatch(/\bresolveAppBlockApprovalVerdict\s*\(/);
    // 🔴 The same filter, for the reason it was FIRST written: a whole-file `toMatch` for
    // `status === 'approved'` PASSES on the predicate module's own docblock, which quotes
    // that exact expression while describing the mint endpoint. Measured: weakening the
    // real comparison to `!== 'suspended'` left the whole-file form GREEN. A spelling
    // check that its own prose satisfies is not weak, it is inert.
    const predicateSource = read(APPROVAL_PREDICATE);
    // Identifier presence: string bodies EMPTIED, so neither a comment nor a
    // `const s = 'appBlock.findUnique';` can stand in for the lookup.
    // 🔴 ASSERTED AS A BOOLEAN WITH A MESSAGE, not as `toMatch` over the normalised file:
    // a failing `toMatch` prints the whole haystack, which here is a normalised module
    // carrying the literal sentinel — an unreadable diff on the one assertion whose failure
    // means the approval check is gone. The verdict is what matters; the message says which.
    expect(
      /\bappBlock\.findUnique\b/.test(stripNonCode(predicateSource)),
      `${APPROVAL_PREDICATE} no longer resolves the app_blocks row with appBlock.findUnique ` +
        'on a line of code. Both halves of the runtime resolve their approval verdict ' +
        'through this module, so the lookup disappearing means neither reads the row. A ' +
        'mention in a comment or inside a string does NOT satisfy this.'
    ).toBe(true);
    // 🔴 THE ONE ASSERTION THAT NEEDS THE LITERAL'S VALUE, so it cannot use the emptied view
    // (clawgate #589, finding 6). `codeLinesOnly` stripped comments and NOTHING else, so
    // `const doc = "status === 'approved'";` anywhere in the predicate module satisfied this
    // exactly as well as the real comparison did — and with such a line present, weakening
    // the real comparison to `!== 'suspended'` stays GREEN, which is the whole failure this
    // assertion was written to prevent, reintroduced through a different spelling of
    // "anywhere". `codeWithLiterals` re-delimits every literal with a sentinel no literal
    // body can contain, so the comparison is pinned in a CODE position: real code normalises
    // to `status === ␀approved␀`, the faked string to `␀status === 'approved'␀`.
    expect(
      APPROVED_COMPARISON_RE.test(codeWithLiterals(predicateSource)),
      `${APPROVAL_PREDICATE} no longer compares the row's status against 'approved' in a ` +
        'CODE position. This is the comparison the whole approved-status gate reduces to, ' +
        'on both the bridge and the REST surface. Note what does NOT satisfy it and used ' +
        'to: the expression written inside a STRING (`const doc = "status === \'approved\'"`) ' +
        'or in a comment. Note also what legitimately does not: a comparison against a ' +
        'const rather than an inline literal — inline it, or widen this check deliberately.'
    ).toBe(true);
  });

  /**
   * 🔴 THE DIVERGENCE THAT CONSOLIDATION MUST NOT SWALLOW, pinned where a reader of the
   * bridge will meet it.
   *
   * The bridge and the REST gate share the predicate and deliberately DISAGREE on what a
   * missing row means: the bridge answers `NOT_FOUND`, the REST wrapper serves the request
   * and only counts it. A "cleanup" that routed the bridge through the REST policy helper
   * (`resolveRestApprovalVerdict`) would look like more consolidation and would silently
   * change two things at once — the missing-row response, and what an unreachable replica
   * does (that helper swallows the error into a `lookup_failed` verdict, where this path
   * lets it propagate).
   *
   * ⚠️ WHAT THIS CAN SEE: that the guard file does not name the REST policy helper. It is
   * a spelling check like the one above and inherits every limit of one. The BEHAVIOUR it
   * protects — `NOT_FOUND` on a missing row — is pinned in
   * `src/server/routers/__tests__/blocks.router.bridgeTokenGuard.test.ts`, which is the file
   * to change if this ever becomes a decision rather than an accident. (Same vitest project
   * as this one — see the note on `still SPELLS the two checks the guard exists for`.)
   */
  it('does NOT route the bridge through the REST policy wrapper — the two differ on a missing row', () => {
    // Normalised for the same reason as `only in PROSE` above: a line opening with a block
    // comment used to be dropped whole, and literal bodies are kept because a name reached
    // through a string is still reached.
    const rawGuardLines = read(GUARD).split('\n');
    const offenders = codeWithLiterals(read(GUARD), GUARD)
      .split('\n')
      .map((line, i) => [line, i + 1] as const)
      .filter(([line]) => /\bresolveRestApprovalVerdict\b/.test(line))
      .map(([, n]) => `${GUARD}:${n}: ${(rawGuardLines[n - 1] ?? '').trim()}`);

    expect(
      offenders,
      `${GUARD} names resolveRestApprovalVerdict in code. That helper carries the REST ` +
        "policy, not the bridge's: it SERVES a missing row (the bridge answers NOT_FOUND) " +
        'and converts a failed read into a lookup_failed verdict (the bridge lets it ' +
        'propagate). Resolve through resolveAppBlockApprovalVerdict and map the verdict here.'
    ).toEqual([]);
  });
});
