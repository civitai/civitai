import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * THE SETTLE-CALLER LEDGER — what clawgate #572's decision actually rests on.
 *
 * `settleCustomComfySpend` unwinds a post-paid customComfy reservation from the reserved
 * CEILING down to real accrued cost. It runs only on a TERMINAL OBSERVATION, and its only
 * two production CALLERS are `pollWorkflow` and `cancelWorkflow` — both behind
 * `authorizeBlockBridgeToken`, which #4806 put deliberately ahead of them. That is why a
 * revoked/suspended app strands an in-flight reservation for the rest of the 25h window,
 * and #572 ACCEPTED that rather than carving a hole in the guard or adding a background
 * reconciler. The rationale is recorded next to the function itself, in
 * `src/server/services/blocks/custom-comfy-settle.service.ts`.
 *
 * 🔴 CALLERS ARE NOT OBSERVERS, AND THIS FILE PINS CALLERS. `cancelAppWorkflow` is a THIRD
 * terminal observer in `src/server/routers/blocks.router.ts` that does NOT settle — the
 * router's own comment calls it "the THIRD observer". Its absence from `CALLER_LEDGER`
 * below is therefore CORRECT and is NOT a statement that the settle path is complete. The
 * service comment names that gap; do not read a green run here as covering it.
 *
 * WHY THIS FILE EXISTS. The card's Assumption 1 is *"the two callers above are the only
 * production settle path — re-verify at HEAD; if a third appears, the analysis changes"*.
 * A decision resting on a set that nobody watches decays silently: a third caller can
 * appear (a new terminal observer that does not need the bridge guard at all, in which
 * case option 1 may no longer be the right answer), or one can disappear (a settle path
 * quietly deleted, which strands EVERY reservation on that path, not just revoked ones).
 * Both directions have to be loud. This asserts the SET, so it fails when the set GROWS
 * and when it SHRINKS.
 *
 * WHY IT LIVES IN THE `no-*` LANE rather than beside `custom-comfy-settle.service.test.ts`
 * with the repo's other `*.call-site-ledger.test.ts` files: `test:lint-rules` enumerates
 * ONLY `src/server/services/__tests__/no-*.test.ts`, and #572's acceptance criterion names
 * that project as a gate. Membership there is the point; the trade is that the blocks
 * ledger family is now split across two directories, so an auditor asking "which blocks
 * exports have a caller ledger?" must grep both. Stated so the next person adding one has
 * a tiebreaker instead of two contradicting precedents.
 *
 * A RELATIONSHIP, NOT A SPELLING — for the CALL and IMPORT scans. This repo has just
 * closed six fail-open SPELLED guards (clawgate #589, merged `f213521be0`), every one of
 * which read as coverage while being walkable by writing the same concept another way. So
 * the two ledgers below never grep for a quoted name:
 *
 *   - CALLS are `ts.CallExpression` nodes from the parse, so the identifier written in a
 *     comment, in a string, or in a TYPE position (`typeof settleCustomComfySpend`) is
 *     structurally not a call and cannot satisfy anything.
 *   - The callee is matched against whatever LOCAL NAME the module actually bound, and the
 *     binding set is closed under rebinding — see `bindingsOf`.
 *   - The OWNER of each call is the nearest enclosing named binding taken from the AST,
 *     not a regex over indentation, and whether that owner is a tRPC procedure is decided
 *     by its initializer terminating in `.mutation(` / `.query(` / `.subscription(` —
 *     again in either access form.
 *
 * ⚠️ The exception, named here so the sentence above cannot be read as absolute:
 * `keeps the decision record beside the function it is about` IS a spelling check, on
 * five literals. It is scoped to the comment block attached to the declaration (via
 * `ts.getLeadingCommentRanges`, not a whole-file search), and its trade-off is argued at
 * its own definition.
 *
 * TWO LEDGERS, because one cannot see what the other misses:
 *
 *   `CALLER_LEDGER`  — who CALLS it, by owning procedure. The assumption itself.
 *   `IMPORTER_LEDGER` — which modules BIND the export at all. A module can bind it and
 *     reach it in a shape the call scan does not model, and that file would otherwise
 *     score as having no call sites at all.
 *
 * 🔴 AND THE HOLE THAT USED TO SIT BETWEEN THEM, because it is the reason `bindingsOf` is
 * as long as it is. The importer ledger only fires for a file NOT ALREADY IN IT — and the
 * ledgered file is `blocks.router.ts`, which is exactly where a third settle caller would
 * be written. MEASURED before the fix, each leaving all 15 tests GREEN with a live third
 * caller in that file:
 *   E1  `const settleAlias = settleCustomComfySpend;` then `await settleAlias(…)`
 *   E2  `const { settleCustomComfySpend: s } = await import('…custom-comfy-settle.service');`
 *   E3  `const mod = await import(…); const fn = mod.settleCustomComfySpend;`
 * E1 and E2 were two of the three shapes this docstring CLAIMED the importer ledger
 * covered. E2 is also the router's own idiom — it holds 105 `= await import(` destructures,
 * one of them seventeen lines above the settle call inside `pollWorkflow`. So the default way
 * to write a third caller there was the silent way. `bindingsOf` now closes the binding set
 * under static imports, dynamic imports, destructures and local rebinding, to a fixed
 * point; `POSITIVE CONTROL — a rebound local is still the same call` pins all three.
 *
 * 🔴 WHAT IS STILL OUT OF REACH — stated because it is open, not softened.
 *   - A module reached through a COMPUTED specifier (`await import(BASE + '/custom-comfy'
 *     + '-settle.service')`), or a re-export under an unrelated path. The sweep prefilters
 *     on the module PATH segment `custom-comfy-settle`, which is a spelling — narrower than
 *     the ones #589 removed (it is the import path, not the guarded symbol), but a spelling.
 *     The defining module and every ledgered importer are parsed unconditionally, so the
 *     prefilter cannot quietly drop them.
 *   - Rebinding through something other than a variable declaration — a later assignment
 *     (`let fn; fn = settleCustomComfySpend;`), a function parameter, a class field, an
 *     object property read back out, a destructured array (`const [fn] = [settle]`). The
 *     fixed point walks `VariableDeclaration`s with identifier or object-pattern names
 *     only. `.call` / `.apply` / `Reflect.apply` / `.bind` / `?:` / `??` / `||` ARE
 *     covered — they were not until the round-2 audit produced two live third callers
 *     (`settle.call(null, …)` and a `.bind` alias) with every assertion green.
 *   - 🔴 `bindingsOf` is SCOPE-BLIND: a name learned anywhere in the module is treated as
 *     the settle export everywhere in it. An unrelated function with its own
 *     block-scoped `const` of the same name is therefore scored as a settle site. That is
 *     fail-CLOSED and noisy — it names a function that does not settle — but it is a
 *     false RED, not a miss.
 *   - Reachability is not evaluated FOR THE CALLER LEDGER. A call behind `if (someFlag)`
 *     counts as a call site; the ledger answers "who can call this", not "who does, on
 *     every path". 🔴 That direction is fail-CLOSED for a CALL and fail-OPEN for the
 *     GUARD, which is why `THE RELATIONSHIP` does NOT reuse it: it requires the guard
 *     call to be unconditional and at `depth === 1`. Read those as separate properties —
 *     one sentence about "reachability" covering both is how the fail-open half hid.
 *   - `depth === 1` is a LEXICAL test, not an executional one. It rejects a settle or a
 *     guard buried in a callback the resolver hands to something else, and it equally
 *     rejects a benign `withRetry(async () => …)` wrapper. The scan cannot tell those
 *     apart; the choice is deliberately the fail-CLOSED one.
 *   - FALSE-RED, and the likeliest one to actually be written: wrapping a procedure body in
 *     a RETHROWING `try { … } catch (e) { log(e); throw e; }` marks its guard
 *     `conditional` and turns the ledger red, although enforcement did not change. Same
 *     for splitting a guard from its await (`const p = guard(t); await p;`) and for
 *     `await Promise.resolve(guard(t))` — `isEnforcedCall` follows transparent wrappers
 *     (parens, `as`, `!`, a comma sequence) and a promise chain, but not a promise through
 *     a binding or a call. All noise, not holes.
 *   - `isEnforcedCall` reasons about the CALL SITE, not about what the guard does on
 *     success. A guard that returns a rejected-promise-shaped value rather than throwing,
 *     or that resolves to garbage claims, satisfies it. This file pins that the guard RUNS
 *     and can throw into the procedure; `no-unguarded-block-bridge-token.test.ts` owns
 *     what it checks.
 *
 *   - `guardIsImportedAndUnshadowed` is deliberately over-broad in the same way
 *     `bindingsOf` is: ONE function-local `const authorizeBlockBridgeToken` anywhere in a
 *     file empties that file's ENTIRE guard population and turns the ledger red. TWO
 *     SEPARATE THINGS ARE TRUE OF A NAMESPACE IMPORT and they have been conflated twice:
 *       (a) when it is the file's ONLY import of the guard module it DOES disqualify the
 *           file — the named-import requirement is never satisfied, so even a
 *           bare-identifier call there contributes no guards (measured: 0). Alongside the
 *           named import it changes nothing (measured: 1).
 *       (b) INDEPENDENTLY of that, a guard CALLED through the namespace
 *           (`ns.authorizeBlockBridgeToken(t)`, or the computed form) contributes no
 *           guards even in a file that fully satisfies the requirement, because guard
 *           collection is gated on the callee being a bare identifier. The ledger reddens
 *           that way instead.
 *     Both are fail-closed, and BOTH ARE PINNED by `POSITIVE CONTROL — the two NAMESPACE
 *     facts the header states, measured separately` — (b) with the named import present,
 *     so its zero cannot be (a) in disguise. A round-7 edit declared (b) false while
 *     correcting (a); it is not, and striking it deleted a live limitation from this
 *     list. (b) is a test now rather than a claim, for exactly that reason.
 *   - 🔴 THREE SHAPES STILL SCORE `conditional: false` WHILE THE GUARD MAY NOT RUN, and
 *     they are listed because the conditionality axis has now been "closed" three rounds
 *     running and is not: an OPTIONAL CALL does not evaluate its arguments when its
 *     receiver is nullish (`await helper?.run(await guard(t))`); a GET ACCESSOR body is not
 *     a function boundary to `ownerOf`, which counts only `ArrowFunction` and
 *     `FunctionExpression`, so a guard inside one reads as `depth === 1`; and a LABELLED
 *     BLOCK with an early `break` can skip the guard without any node in
 *     `CONDITIONAL_STATEMENT_KINDS`. All three are fail-OPEN. None appears in
 *     `blocks.router.ts` today, and each is a narrow, deliberate spelling rather than
 *     something a maintainer writes by accident — which is the reason they are recorded
 *     here rather than chased.
 *   - A settle performed by writing the Redis key directly rather than through this
 *     function. That is a different shape entirely and no ledger over this symbol can see
 *     it; `no-hand-typed-redis-key-constants.test.ts` is what covers hand-typed keys.
 *   - Anything outside `ROOTS` below. That used to be `src/` alone, which left `scripts/`
 *     invisible — and `scripts/` uses the same `~/*` alias and does import server services,
 *     so a reconciler dropped in `scripts/oneoffs/` (the very option this decision defers)
 *     would have been silent to BOTH ledgers. `scripts`, `packages` and `apps` are swept
 *     too now; nothing outside `src` binds the export today, so this widened the reach
 *     without moving either ledger.
 *
 * ⚠️ CLAIMS THAT USED TO BE IN THAT LIST AND WERE FALSE, recorded so they are not rewritten.
 * This block is AFTER the list on purpose — an earlier revision put it in the MIDDLE, which
 * left two live limitations sitting under a heading announcing retractions:
 *   - *"`THE RELATIONSHIP` matches a guard by OWNER NAME … the exact-set ledger and the
 *     per-owner counter are what catch that"* — they do not; both enumerate SETTLE sites
 *     and neither records a guard. It now matches on the owner NODE (`ownerId`), so the
 *     limit is gone rather than mitigated.
 *   - *"Every way to defeat the guard's name yields ZERO guards for that procedure"* — a
 *     binding that SHADOWS the name keeps it. `guardIsImportedAndUnshadowed` empties the
 *     guard population for any such file.
 *   - *"`isEnforcedCall` … must not be the receiver of a chained `.catch`/`.then`/`.finally`"*
 *     — that block was INERT (a member-access parent can never also be an await, so the
 *     await requirement already rejected every input it caught), and it was wrong about
 *     `.finally`, which does not swallow a rejection. The chain is now peeled and judged.
 *   - *"`??` / `||` / `&&` … short-circuit"* as a complete list — the ASSIGNMENT forms
 *     `??=` / `||=` / `&&=` short-circuit identically and were missing, which was a live
 *     fail-open.
 *
 * NOT REGRESSION COVERAGE — AN INVARIANT GUARD, LABELLED AS ONE. Nothing at the base
 * commit violates this: the set is already exactly two, which is the fact the decision was
 * made on. It pins that fact so the decision cannot rot, rather than catching a bug that
 * exists today. The controls below are what make it a guard that can actually go red, since
 * the ledger assertion alone has never been watched fail against real code.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');

/**
 * Every root that can hold production TypeScript binding this export. `src` alone was the
 * original scope and is the house convention (`no-unguarded-billable-submit.test.ts` walks
 * it alone too) — it is widened here for the reason in the limits block: `scripts/` resolves
 * the same `~/*` alias, and an out-of-band reconciler is the kind of thing that lands there.
 */
const ROOTS = ['src', 'scripts', 'packages', 'apps'];

const SETTLE_MODULE = 'src/server/services/blocks/custom-comfy-settle.service.ts';
const SETTLE_EXPORT = 'settleCustomComfySpend';
const ROUTER = 'src/server/routers/blocks.router.ts';
const GUARD = 'authorizeBlockBridgeToken';
/** The one module the guard may legitimately come from. See `guardIsImportedAndUnshadowed`. */
const GUARD_MODULE = 'src/server/services/blocks/block-bridge-auth.service.ts';

/** The path segment every importer of the settle service must name. See the limits above. */
const MODULE_PATH_HINT = 'custom-comfy-settle';

type SiteKind = 'trpc-procedure' | 'function' | 'module-scope';
type Site = { file: string; owner: string; kind: SiteKind };

/**
 * THE ASSUMPTION, AS A SET. Compared in BOTH directions: a third caller fails it, and so
 * does losing one. `kind` is carried because "a tRPC procedure named pollWorkflow" and
 * "a plain helper named pollWorkflow" are different facts about the settle path — the
 * first sits behind the bridge guard by construction, the second need not.
 */
const CALLER_LEDGER: Site[] = [
  { file: ROUTER, owner: 'cancelWorkflow', kind: 'trpc-procedure' },
  { file: ROUTER, owner: 'pollWorkflow', kind: 'trpc-procedure' },
];

/**
 * How many settle calls each ledgered owner makes. A bare SET cannot tell "a second settle
 * was added inside `pollWorkflow`" from noise — the exact-array comparison would report it
 * as a duplicate rather than as what it is, and a second settle in one procedure is a real
 * double-refund question (the GET+DEL makes it a no-op today, which is exactly the kind of
 * thing that stops being true quietly).
 */
const CALLS_PER_OWNER: Record<string, number> = { cancelWorkflow: 1, pollWorkflow: 1 };

/** The modules that BIND the export at all — the population the call scan reads from. */
const IMPORTER_LEDGER = [ROUTER];

/**
 * The three method names that terminate a tRPC procedure.
 *
 * ⚠️ A SECOND COPY of this constant and of the dual-access matcher below lives in
 * `src/server/services/__tests__/no-unguarded-block-bridge-token.test.ts`
 * (`PROC_TERMINATOR_NAMES` / `astTerminatorCount`). Copy-per-guard is this directory's
 * convention — 22 test files under `src/` call `ts.createSourceFile`, 5 of them in this
 * directory, and none shares a scanning module — but if
 * tRPC ever gains a fourth terminator, BOTH have to move, and the one that does not fails
 * in the permissive direction (a procedure stops being recognised as a procedure).
 */
const PROC_TERMINATORS = new Set(['mutation', 'query', 'subscription']);

function key(site: Site): string {
  return `${site.file} :: ${site.owner} (${site.kind})`;
}

function parse(rel: string, source: string): ts.SourceFile {
  return ts.createSourceFile(
    rel,
    source,
    ts.ScriptTarget.Latest,
    true,
    /\.(tsx|jsx)$/.test(rel) ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
}

/** `~/server/x` or `./x` -> the repo-relative file that exists, or null. */
function resolveSpec(spec: string, fromRel: string): string | null {
  let base: string;
  if (spec.startsWith('~/')) base = `src/${spec.slice(2)}`;
  else if (spec.startsWith('.'))
    base = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
  else return null;
  for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
    if (fs.existsSync(path.join(REPO_ROOT, candidate))) return candidate;
  }
  return null;
}

/** The module specifier of a static import/export, or of a dynamic `import('…')` call. */
function specifierOf(node: ts.Node): string | null {
  if (
    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
    node.moduleSpecifier &&
    ts.isStringLiteralLike(node.moduleSpecifier)
  ) {
    return node.moduleSpecifier.text;
  }
  if (
    ts.isCallExpression(node) &&
    node.expression.kind === ts.SyntaxKind.ImportKeyword &&
    node.arguments.length > 0 &&
    ts.isStringLiteralLike(node.arguments[0])
  ) {
    return (node.arguments[0] as ts.StringLiteralLike).text;
  }
  return null;
}

type Bindings = {
  /** Local names that hold the `settleCustomComfySpend` FUNCTION. */
  direct: Set<string>;
  /** Local names that hold the settle MODULE namespace. */
  namespaces: Set<string>;
  /** Did this module reference the settle module at all, in any import form? */
  importsModule: boolean;
};

/** `await x` / `(x)` / `x as T` / `x!` — peel the wrappers a binding can hide behind. */
function unwrap(node: ts.Node): ts.Node {
  let n = node;
  for (;;) {
    if (ts.isAwaitExpression(n) || ts.isParenthesizedExpression(n)) n = n.expression;
    else if (ts.isAsExpression(n) || ts.isNonNullExpression(n)) n = n.expression;
    else return n;
  }
}

/** The member name of `x.foo` / `x['foo']`, or null. */
function memberName(node: ts.Node): string | null {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
    return node.argumentExpression.text;
  }
  return null;
}

function isDynamicSettleImport(node: ts.Node, rel: string): boolean {
  const spec = specifierOf(node);
  return spec != null && resolveSpec(spec, rel) === SETTLE_MODULE;
}

/** Does `node` evaluate to the settle MODULE (a namespace binding, or `await import(…)`)? */
function isSettleNamespaceExpr(node: ts.Node, b: Bindings, rel: string): boolean {
  const n = unwrap(node);
  if (ts.isIdentifier(n)) return b.namespaces.has(n.text);
  return isDynamicSettleImport(n, rel);
}

/**
 * Does `node` evaluate to the settle FUNCTION itself?
 *
 * Covers a bare/rebound identifier, a namespace member in either access form, a `.bind(…)`
 * of any of those, and either branch of a `?:` / `??` / `||`. The last three are not
 * rebinding, which is why the fixed point alone did not reach them: `const fn =
 * settleCustomComfySpend.bind(null)` is a `CallExpression` initializer, and
 * `cond ? settle : other` never binds at all.
 */
function isSettleExportExpr(node: ts.Node, b: Bindings, rel: string): boolean {
  const n = unwrap(node);
  if (ts.isIdentifier(n)) return b.direct.has(n.text);
  if (ts.isConditionalExpression(n)) {
    return isSettleExportExpr(n.whenTrue, b, rel) || isSettleExportExpr(n.whenFalse, b, rel);
  }
  if (ts.isBinaryExpression(n)) {
    // A comma sequence evaluates to its RIGHT operand — `(0, settle)(…)`, the classic
    // this-stripping idiom, which is a third-caller shape that reached 21/21 green.
    if (n.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      return isSettleExportExpr(n.right, b, rel);
    }
    if (
      n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      n.operatorToken.kind === ts.SyntaxKind.BarBarToken
    ) {
      return isSettleExportExpr(n.left, b, rel) || isSettleExportExpr(n.right, b, rel);
    }
  }
  const member = memberName(n);
  if (member === SETTLE_EXPORT) {
    const owner = (n as ts.PropertyAccessExpression | ts.ElementAccessExpression).expression;
    return isSettleNamespaceExpr(owner, b, rel);
  }
  // `x.bind(…)` — a bound settle is still the settle.
  if (ts.isCallExpression(n) && memberName(n.expression) === 'bind') {
    const target = (n.expression as ts.PropertyAccessExpression | ts.ElementAccessExpression)
      .expression;
    return isSettleExportExpr(target, b, rel);
  }
  return false;
}

/**
 * Every local name in `rel` that holds the settle export or its module namespace.
 *
 * 🔴 CLOSED UNDER REBINDING, TO A FIXED POINT. Collecting only `ImportDeclaration` bindings
 * was the hole recorded in the header: `const s = settleCustomComfySpend`, a dynamic-import
 * destructure, and `const fn = mod.settleCustomComfySpend` each produced a live third
 * caller that BOTH ledgers scored green. The loop re-runs until no new name is learned, so
 * a chain (`const a = settle; const b = a;`) resolves regardless of declaration order.
 *
 * `import type { … }` is skipped: a type-only binding is erased at runtime and cannot be
 * called, so counting it as `direct` would put a type in the caller population. It still
 * sets `importsModule`, which is the wider set by design.
 */
function bindingsOf(sf: ts.SourceFile, rel: string): Bindings {
  const out: Bindings = { direct: new Set(), namespaces: new Set(), importsModule: false };

  // The defining module calls its own export by its declared name.
  if (rel === SETTLE_MODULE) {
    out.direct.add(SETTLE_EXPORT);
    out.importsModule = true;
  }

  const declarations: ts.VariableDeclaration[] = [];

  const visit = (node: ts.Node): void => {
    const spec = specifierOf(node);
    if (spec != null && resolveSpec(spec, rel) === SETTLE_MODULE) {
      out.importsModule = true;
      if (ts.isImportDeclaration(node) && node.importClause && !node.importClause.isTypeOnly) {
        const clause = node.importClause;
        if (clause.name) out.namespaces.add(clause.name.text); // default import of the module
        const bindings = clause.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) out.namespaces.add(bindings.name.text);
        else if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            if (element.isTypeOnly) continue;
            const imported = (element.propertyName ?? element.name).text;
            if (imported === SETTLE_EXPORT) out.direct.add(element.name.text);
          }
        }
      }
    }
    if (ts.isVariableDeclaration(node) && node.initializer) declarations.push(node);
    node.forEachChild(visit);
  };
  visit(sf);

  for (let changed = true; changed; ) {
    changed = false;
    for (const declaration of declarations) {
      const init = declaration.initializer!;
      const name = declaration.name;
      if (ts.isIdentifier(name)) {
        if (isSettleExportExpr(init, out, rel) && !out.direct.has(name.text)) {
          out.direct.add(name.text);
          changed = true;
        } else if (isSettleNamespaceExpr(init, out, rel) && !out.namespaces.has(name.text)) {
          out.namespaces.add(name.text);
          changed = true;
        }
      } else if (ts.isObjectBindingPattern(name) && isSettleNamespaceExpr(init, out, rel)) {
        for (const element of name.elements) {
          const imported = element.propertyName;
          const importedName =
            imported && (ts.isIdentifier(imported) || ts.isStringLiteralLike(imported))
              ? imported.text
              : ts.isIdentifier(element.name)
              ? element.name.text
              : null;
          if (importedName !== SETTLE_EXPORT || !ts.isIdentifier(element.name)) continue;
          if (!out.direct.has(element.name.text)) {
            out.direct.add(element.name.text);
            changed = true;
          }
        }
      }
    }
  }

  return out;
}

/**
 * Is this call a call to the settle export, under whatever local name it was bound and by
 * whatever invocation shape? `settle.call(null, …)`, `settle.apply(null, […])` and
 * `Reflect.apply(settle, …)` are invocations, not rebindings — the callee EXPRESSION is
 * `settle.call`, which is not the settle export, so nothing upstream of here sees them.
 */
function isSettleCall(node: ts.CallExpression, bindings: Bindings, rel: string): boolean {
  const callee = node.expression;
  if (isSettleExportExpr(callee, bindings, rel)) return true;
  const method = memberName(callee);
  if (method === 'call' || method === 'apply') {
    const target = (callee as ts.PropertyAccessExpression | ts.ElementAccessExpression).expression;
    if (isSettleExportExpr(target, bindings, rel)) return true;
    // `Reflect.apply(settle, thisArg, args)`
    if (
      ts.isIdentifier(target) &&
      target.text === 'Reflect' &&
      node.arguments.length > 0 &&
      isSettleExportExpr(node.arguments[0], bindings, rel)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Is this object-literal property a tRPC procedure definition — i.e. does its initializer
 * chain terminate in `.mutation(` / `.query(` / `.subscription(`?
 *
 * Both access forms are read. `.mutation(` is a property access; `['mutation'](` is an
 * element access on the identical method, and #589 measured a procedure spelled that way
 * escaping a text-based terminator count entirely.
 */
function isTrpcProcedure(pa: ts.PropertyAssignment): boolean {
  if (!ts.isObjectLiteralExpression(pa.parent)) return false;
  let expr: ts.Node = pa.initializer;
  while (
    ts.isCallExpression(expr) ||
    ts.isPropertyAccessExpression(expr) ||
    ts.isElementAccessExpression(expr)
  ) {
    if (ts.isCallExpression(expr)) {
      const callee = expr.expression;
      const method = memberName(callee);
      if (method != null && PROC_TERMINATORS.has(method)) return true;
      expr = callee;
    } else {
      expr = expr.expression;
    }
  }
  return false;
}

/**
 * STATEMENT forms only — `if` / `try` / `switch` / the loops. NOT `catch`: see the note in
 * the list itself for why that entry was removed (a catch clause is still marked, through
 * its enclosing `TryStatement`). A call anywhere inside one of these is marked conditional
 * WHICHEVER CHILD it sits in.
 *
 * ⚠️ THAT OVER-MARKS EVERY SLOT THAT IS GUARANTEED TO RUN ONCE THE STATEMENT IS ENTERED,
 * DELIBERATELY: an `if` / `while` / `switch` condition, a `switch`'s first `case`
 * expression, a `for…of` or `for…in` iterable, a classic `for`'s initializer and condition,
 * a `do` body, a `finally` block (which runs on EXIT — hence "once entered", not "on
 * entering"), and the `try` BLOCK. All fail-CLOSED false-REDs, taken because no shape in
 * this corpus puts the guard in any of them and a per-slot test is more machinery than the
 * cases are worth. ⚠️ ALL BUT THE `try` BLOCK — both halves of that sentence are false of
 * it: its marking is enforcement rather than noise where the `catch` swallows, a per-slot
 * fixture for it already exists, and the header calls the rethrowing-`try` wrapper the
 * likeliest shape anyone actually writes. See the next paragraph.
 *
 * Slots that do NOT satisfy the criterion and are marked anyway — a `while` / `for` /
 * `for…of` / `for…in` body, an `if`/`else` body, a `case` or `default` body, a CATCH
 * CLAUSE, a NON-FIRST `case` expression (never reached when an earlier case matches), a
 * classic `for`'s incrementor and a `do…while` condition (the last two reached only after
 * an iteration, by normal completion or by `continue`) — are marked correctly, not
 * over-marked. That enumeration is meant to be EXHAUSTIVE over the children of the eight
 * kinds, and an earlier revision of it was not: it said "a loop or branch BODY", which both
 * swallowed the `do` body listed as qualifying two lines above and left the catch clause
 * and the non-first case expression in neither list.
 *
 * 🔴 THE `try` BLOCK IS THE ONE SLOT WHOSE MARKING IS NOT ALWAYS NOISE, and it cuts both
 * ways: where the `catch` SWALLOWS, marking is ENFORCEMENT (that is the statement spelling
 * `isEnforcedCall`'s docstring describes, pinned by the `swallowed` fixture in
 * `POSITIVE CONTROL — a guard that is PRESENT but does not RUN is not 'depth 1,
 * unconditional'`, which is the test that asserts `conditional`); where it RETHROWS it is a
 * false-RED, as the header's limits entry records. Both entries are true, of different
 * `try`s.
 *
 * 🔴 DELIBERATELY NO COUNT, AND NO REVISION HISTORY. A numeral here rotted three times in
 * three rounds, and the paragraph recording THAT then carried a wrong figure of its own.
 * The criterion above is the durable part; a roll-call and a changelog are not, and git
 * holds the history. Add a kind, check the criterion.
 *
 * ⚠️ An earlier revision of THE OPENING SENTENCE asserted that a call in one of these "may
 * not run, whichever child it sits in", which is simply false — and it sat two lines above
 * the paragraph explaining that operand position is exactly what separates a ternary
 * CONDITION from its branches, i.e. it denied a distinction the next paragraph draws.
 *
 * 🔴 THE EXPRESSION FORMS ARE NOT HERE, AND THAT IS THE POINT. `?:` and the short-circuiting
 * operators are conditional for SOME operands and not others — `guard(t) && x` and the
 * CONDITION of a ternary always run — so they live in `SHORT_CIRCUIT_TOKENS` and
 * `crossesConditional` below, which read which operand the call is in.
 *
 * ⚠️ Two earlier revisions of this docstring were wrong about its own list, in opposite
 * directions, which is why it now says what is NOT here as well as what is. The first
 * claimed the expression forms were absent and handled by a helper called
 * `isConditionalExpressionLike` — no such helper has ever existed. The second, written when
 * they genuinely were in the list, said they were "both here"; it was left in place when
 * they were moved out, so it read as a retraction that was itself false. This is the
 * comment a maintainer reads before editing the list, and the list they would edit for a
 * short-circuit operator is no longer this one.
 */
const CONDITIONAL_STATEMENT_KINDS: ((n: ts.Node) => boolean)[] = [
  ts.isIfStatement,
  ts.isTryStatement,
  ts.isSwitchStatement,
  ts.isForStatement,
  ts.isForOfStatement,
  ts.isForInStatement,
  ts.isWhileStatement,
  ts.isDoStatement,
  // 🔴 NO `ts.isCatchClause`. It cannot ever be the SOLE cause — a catch clause is always a
  // child of a `TryStatement`, which the walk also passes through — so the entry was dead
  // code that no fixture could isolate: measured, deleting it left the whole file green
  // while `isTryStatement` still went red on the same input. An unkillable list entry reads
  // as coverage and provides none, which is the thing this file exists to not do.
];

/**
 * 🔴 EVERY SHORT-CIRCUITING OPERATOR, INCLUDING THE ASSIGNMENT FORMS. `??=`, `||=` and
 * `&&=` short-circuit exactly like `??`, `||` and `&&`, and listing only the plain forms
 * was a fail-open: MEASURED, `claims ??= await authorizeBlockBridgeToken(t)` ahead of the
 * settle reported `depth=1 conditional=false enforced=true` and read as GUARDED, while the
 * guard does not run at all when the left operand is already non-nullish. `??=` is house
 * idiom here — 174+ non-test uses under `src/`, including in a router — so this is the
 * likely spelling, not an exotic one.
 */
const SHORT_CIRCUIT_TOKENS = [
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
];

/**
 * Does ascending from `child` into `node` cross a conditional boundary?
 *
 * 🔴 WHICH OPERAND MATTERS. `guard(t) && x` always evaluates the guard; `x && guard(t)`
 * does not. Marking the whole `BinaryExpression` conditional regardless was a false-RED on
 * the first shape and on `(await guard(t)) ?? {}`. Same for `?:`: the CONDITION runs
 * unconditionally, the branches do not.
 */
function crossesConditional(node: ts.Node, child: ts.Node): boolean {
  if (CONDITIONAL_STATEMENT_KINDS.some((is) => is(node))) return true;
  if (ts.isConditionalExpression(node)) return child === node.whenTrue || child === node.whenFalse;
  if (ts.isBinaryExpression(node) && SHORT_CIRCUIT_TOKENS.includes(node.operatorToken.kind)) {
    return child === node.right;
  }
  return false;
}

/**
 * Where a call sits relative to the procedure that owns it.
 *
 * `depth` — function boundaries crossed on the way up. A call directly in the procedure's
 * own resolver body is 1; a call inside a callback the resolver passes to something else
 * (`setTimeout(() => …)`) is 2 or more, which is LEXICALLY inside the procedure but
 * EXECUTIONALLY outside the guarded request lifetime.
 *
 * `conditional` — an `if` / `try` / `switch` / loop / short-circuit intervened, so the call
 * is present in the source but not necessarily executed.
 *
 * 🔴 `ownerId` — the owner NODE's position, which makes the owner IDENTITY rather than a
 * name. Matching a guard to a settle by NAME was a fail-open: `blocks.router.ts` already
 * holds two distinct entities called `cancelWorkflow` (the imported orchestrator helper and
 * the tRPC procedure), so same-name collision is the house idiom here, and MEASURED — a
 * module-scope `async function pollWorkflow(t) { await authorizeBlockBridgeToken(t) }`
 * added anywhere earlier in the file let the real `pollWorkflow` procedure drop its guard
 * entirely at 21/21 green. That is the PR's own mutant G revived through a sibling.
 */
type Attribution = {
  owner: string;
  ownerId: number;
  kind: SiteKind;
  depth: number;
  conditional: boolean;
};

/**
 * The nearest enclosing NAMED PROCEDURE, from the AST. A router-local helper extracted out
 * of `pollWorkflow` therefore reports as that helper and the ledger goes RED — which is
 * the intended outcome: the settle path changed shape and has to be looked at, not
 * silently re-blessed because the two procedures still transitively reach it.
 *
 * 🔴 A `const`/property NAME ONLY COUNTS ONCE A FUNCTION BOUNDARY HAS BEEN CROSSED, and
 * getting that wrong is not theoretical — it shipped in the first draft of this file and
 * `POSITIVE CONTROL — the guard scan attributes a guard call to its procedure` is what
 * caught it. A call in STATEMENT position (`await settleCustomComfySpend(…)`) has the
 * procedure as its nearest named ancestor, but a call in INITIALIZER position
 * (`const claims = await authorizeBlockBridgeToken(…)`) has the variable — so the guard
 * scan attributed every guard call to `claims` rather than to `pollWorkflow`, and
 * `THE RELATIONSHIP` reported both real, correctly-ordered guards as MISSING. That is the
 * fail-CLOSED direction and it was loud; the same confusion in a scan that compared a set
 * would have been silent.
 */
function ownerOf(node: ts.Node): Attribution {
  let depth = 0;
  let conditional = false;
  let child: ts.Node = node;
  for (let n: ts.Node | undefined = node.parent; n; child = n, n = n.parent) {
    if (ts.isFunctionDeclaration(n) && n.name)
      return {
        owner: n.name.text,
        ownerId: n.pos,
        kind: 'function',
        depth: depth + 1,
        conditional,
      };
    if (ts.isMethodDeclaration(n) && ts.isIdentifier(n.name))
      return {
        owner: n.name.text,
        ownerId: n.pos,
        kind: 'function',
        depth: depth + 1,
        conditional,
      };
    if (depth > 0) {
      if (
        ts.isPropertyAssignment(n) &&
        (ts.isIdentifier(n.name) || ts.isStringLiteralLike(n.name))
      ) {
        return {
          owner: n.name.text,
          ownerId: n.pos,
          kind: isTrpcProcedure(n) ? 'trpc-procedure' : 'function',
          depth,
          conditional,
        };
      }
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name))
        return { owner: n.name.text, ownerId: n.pos, kind: 'function', depth, conditional };
    }
    if (crossesConditional(n, child)) conditional = true;
    if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) depth++;
  }
  return { owner: '<module scope>', ownerId: -1, kind: 'module-scope', depth, conditional };
}

/** The promise methods `isEnforcedCall` peels before judging. Only some of them swallow. */
const PROMISE_CHAIN_METHODS = ['then', 'catch', 'finally'];

/**
 * Does this call's REJECTION reach its caller? — i.e. is the guard actually enforcing?
 *
 * 🔴 THE ROUND-3 FAIL-OPEN, AND IT IS THE SAME DEFECT THE ROUND-2 FIX CLOSED, ONE SPELLING
 * OUT. Round 2 closed the STATEMENT spelling of guard-swallowing (`try { guard } catch {}`
 * → `conditional`). It did not close the EXPRESSION spelling of identical semantics, and
 * `.catch()` is exactly what someone reaches for on a noisy guard. MEASURED on the real
 * router, each leaving 21/21 green with the settle reachable and nothing enforcing:
 *   `await authorizeBlockBridgeToken(t).catch(() => ({} as never))`
 *   `await authorizeBlockBridgeToken(t).then(c => c, () => ({}))`
 *   `void authorizeBlockBridgeToken(t);`  /  a bare, un-awaited `authorizeBlockBridgeToken(t);`
 * The first two swallow the rejection; the last two never wait for it, so the settle runs
 * before the guard can have thrown. A position check cannot see any of them, because the
 * call sits exactly where an enforcing guard would.
 *
 * THE RULE, as the body implements it: the call must be `await`ed (or `return`ed, which
 * propagates the rejection to the caller just as well), and any promise chain on it must
 * not SWALLOW — `.catch(…)` does, `.then(…)` does when given an onRejected (or a spread
 * that might be one), `.finally(…)` never does.
 *
 * ⚠️ An earlier revision of this paragraph said the call "must not be the receiver of a
 * `.catch` / `.then` / `.finally`" AT ALL. That is no longer the rule — a one-argument
 * `.then` and a `.finally` are enforcing — and the earlier BODY that implemented it was
 * INERT anyway (a member-access parent can never also be an await, so the await
 * requirement already rejected everything the clause caught).
 *
 * KNOWN FALSE-REDS, all fail-closed and stated: splitting the call from its await
 * (`const p = guard(t); const claims = await p;`) or putting it through a call
 * (`await Promise.resolve(guard(t))`) reads as unenforced — the scan follows transparent
 * wrappers and a promise chain, not a promise through a binding or a call. And a
 * RETHROWING `.catch(e => { throw e })` reads as swallowing, the expression twin of the
 * rethrowing `try/catch` already listed in the header's limits.
 */
function isEnforcedCall(node: ts.CallExpression): boolean {
  let current: ts.Node = node;
  let parent: ts.Node | undefined = current.parent;
  let swallowed = false;

  for (;;) {
    // Transparent wrappers, matching what `unwrap` peels on the settle side. An `as` cast
    // or a `!` between the call and its await used to read as unenforced.
    while (
      parent &&
      (ts.isParenthesizedExpression(parent) ||
        ts.isAsExpression(parent) ||
        ts.isNonNullExpression(parent) ||
        // `await (noop(), guard(t))` — a comma sequence evaluates to its right operand.
        (ts.isBinaryExpression(parent) &&
          parent.operatorToken.kind === ts.SyntaxKind.CommaToken &&
          parent.right === current))
    ) {
      current = parent;
      parent = parent.parent;
    }

    // 🔴 PEEL A PROMISE CHAIN AND JUDGE IT, rather than refusing at the sight of one. The
    // previous revision returned `false` on any `.catch`/`.then`/`.finally` receiver — which
    // was INERT, because a member-access parent can never also be an await or a return, so
    // the fall-through already returned `false` for every input it caught. Measured:
    // deleting the whole block left 25/25 green, and the two controls written to exercise
    // it were passing for the other rule's reason. It also mis-scored `.finally`, which does
    // NOT swallow a rejection, as unenforced.
    if (
      parent &&
      (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
      parent.expression === current
    ) {
      const method = memberName(parent);
      const call = parent.parent;
      if (
        method != null &&
        PROMISE_CHAIN_METHODS.includes(method) &&
        call &&
        ts.isCallExpression(call) &&
        call.expression === parent
      ) {
        // `.catch(…)` swallows unless it rethrows — treated as swallowing either way,
        // which is fail-CLOSED (a rethrowing `.catch` reads as unenforced; see the limits
        // list). `.then(onOk, onErr)` swallows only when it is given an onRejected;
        // a one-argument `.then` propagates the rejection and `.finally` never swallows.
        // 🔴 A SPREAD IS ONE ARGUMENT NODE, so an arity test alone let
        // `.then(...handlers)` — which may carry an onRejected — score as enforcing.
        if (method === 'catch') swallowed = true;
        if (
          method === 'then' &&
          (call.arguments.length >= 2 || call.arguments.some(ts.isSpreadElement))
        ) {
          swallowed = true;
        }
        current = call;
        parent = call.parent;
        continue;
      }
      return false; // some other member access — the value is used, not awaited
    }
    break;
  }

  if (swallowed) return false;
  return !!parent && (ts.isAwaitExpression(parent) || ts.isReturnStatement(parent));
}

/** A settle call site, with everything the guard-ordering check compares against. */
type ScanSite = Site & Attribution & { pos: number };
type GuardSite = Attribution & { pos: number; enforced: boolean };

/**
 * Is `GUARD` in this module the imported one, and only the imported one?
 *
 * The guard is matched by NAME (see `scanSource`), so anything else bound to that name
 * would be counted as a guard. Two independent conditions, each pinned by its own control:
 *
 *   `importedFromGuardModule` — the name is imported, AND the module it comes from
 *     resolves to `GUARD_MODULE`. ⚠️ The previous revision checked only that SOME named
 *     import bound the name and never read the specifier at all, contradicting this very
 *     docstring. MEASURED: `import { verifyBlockToken as authorizeBlockBridgeToken } from
 *     '…/block-token-access.service'` and an import from a package that does not resolve
 *     both scored as a live guard. The settle side has resolved rigorously since round 1
 *     (`resolveSpec(...) === SETTLE_MODULE`, with its own wrong-module control); this is
 *     the same standard, applied to the other half.
 *   `!shadowed` — no `const`/`let`/`var`/`function` DECLARATION of that name anywhere in
 *     the module. With the import requirement above, a MODULE-SCOPE shadow cannot coexist
 *     (TypeScript rejects the duplicate identifier), so what this actually covers is a
 *     NESTED, block-scoped one in a file that does import the guard. ⚠️ Read that list
 *     literally. A `catch (e)` binding IS detected (TypeScript models it as a
 *     `VariableDeclaration`, so the existing CHECK catches it — no fixture exercises it —
 *     and an earlier revision of this sentence claimed the opposite). A PARAMETER, a
 *     `class` declaration, a local `enum` and a BINDING ELEMENT are NOT; of those only the
 *     parameter and the binding element are callable, so only they can substitute for the
 *     guard.
 *     🔴 AND THE BINDING ELEMENT IS THE ONE THAT MATTERS, so it gets no all-clear: a
 *     procedure-local `const { authorizeBlockBridgeToken } = await import('…something
 *     else');` leaves this helper returning true — the file's top-level import is still
 *     there — and the call still matches by identifier, so a completely different function
 *     is accepted as the guard. That is the router's own idiom (105 `= await import(`
 *     destructures, per the header), which is precisely why `bindingsOf` learned to follow
 *     it on the SETTLE side. The guard side does not, and that is open.
 *
 * A file failing either has its guard population treated as EMPTY, which turns
 * `THE RELATIONSHIP` red rather than quietly accepting the substitute. Note the
 * over-breadth, same shape as `bindingsOf`'s scope-blindness: ONE function-local `const`
 * of that name anywhere in `blocks.router.ts` empties the guard population for the whole
 * file. Fail-closed and loud.
 */
function guardIsImportedAndUnshadowed(sf: ts.SourceFile, rel: string): boolean {
  let importedFromGuardModule = false;
  let shadowed = false;
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && node.importClause && !node.importClause.isTypeOnly) {
      const spec = specifierOf(node);
      const fromGuardModule = spec != null && resolveSpec(spec, rel) === GUARD_MODULE;
      const bindings = node.importClause.namedBindings;
      if (fromGuardModule && bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          // The LOCAL name is what `scanSource` matches, and the IMPORTED name has to be
          // the guard — an alias in either direction is not this function.
          if (
            !element.isTypeOnly &&
            element.name.text === GUARD &&
            (element.propertyName ?? element.name).text === GUARD
          ) {
            importedFromGuardModule = true;
          }
        }
      }
    }
    if (
      (ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      node.name.text === GUARD
    ) {
      shadowed = true;
    }
    node.forEachChild(visit);
  };
  visit(sf);
  return importedFromGuardModule && !shadowed;
}

function scanSource(
  rel: string,
  source: string
): { sites: ScanSite[]; importsModule: boolean; guards: GuardSite[] } {
  const sf = parse(rel, source);
  const bindings = bindingsOf(sf, rel);
  const sites: ScanSite[] = [];
  const guards: GuardSite[] = [];
  const guardUsable = guardIsImportedAndUnshadowed(sf, rel);

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      if (
        (bindings.direct.size > 0 || bindings.namespaces.size > 0) &&
        isSettleCall(node, bindings, rel)
      ) {
        sites.push({ file: rel, ...ownerOf(node), pos: node.getStart(sf) });
      }
      // 🔴 THE GUARD IS MATCHED BY NAME, AND HERE IS EXACTLY WHY THAT IS FAIL-CLOSED. It is
      // not the thing under test — `no-unguarded-block-bridge-token.test.ts` owns its
      // population; what this file adds is the PER-PROCEDURE ORDERING, which that file does
      // not assert. Renaming the guard, aliasing it, or calling it computed all yield ZERO
      // guards for that procedure and turn `THE RELATIONSHIP` RED.
      //
      // ⚠️ An earlier revision claimed that made the spelling unwalkable in the permissive
      // direction. It did not: a module-local binding that SHADOWS the name keeps the name
      // and yields a hit. `guardIsImportedAndUnshadowed` is what closes that, by emptying
      // the whole guard population for such a file.
      if (guardUsable && ts.isIdentifier(node.expression) && node.expression.text === GUARD) {
        guards.push({ ...ownerOf(node), pos: node.getStart(sf), enforced: isEnforcedCall(node) });
      }
    }
    node.forEachChild(visit);
  };
  visit(sf);
  return { sites, importsModule: bindings.importsModule, guards };
}

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!['__tests__', 'node_modules', 'dist', 'build', '.next'].includes(entry.name)) {
        walk(full, out);
      }
    } else if (full.endsWith('.ts') || full.endsWith('.tsx')) out.push(full);
  }
  return out;
}

type RepoScan = {
  sites: ScanSite[];
  importers: string[];
  parsed: string[];
  /**
   * A plain frozen record rather than a `Map`, so the freeze below actually reaches it.
   * A `Map` inside a frozen object is still fully mutable — `.set(…)` and
   * `.get(f)!.push(…)` both succeed — and these are the arrays `THE RELATIONSHIP` reads,
   * i.e. the one field the freeze was supposed to protect was the one it did not.
   */
  guardsByFile: Record<string, readonly GuardSite[]>;
};

/**
 * 🔴 Called from INSIDE the tests, never at module scope. Thrown from a `describe` body
 * this would be a COLLECTION failure: the file contributes zero tests, the suite's
 * failure count does not move, and the guard is silently absent from every full run.
 *
 * Memoised because five assertions ask the same question and the walk is the only part of
 * this that is not free. Keyed on nothing — the tree does not change mid-run.
 */
let repoScanCache: RepoScan | null = null;
function scanRepo(): RepoScan {
  if (repoScanCache) return repoScanCache;
  const sites: ScanSite[] = [];
  const importers: string[] = [];
  const parsed: string[] = [];
  const guardsByFile: Record<string, readonly GuardSite[]> = {};
  // The defining module and every ledgered importer are parsed unconditionally, so the
  // PATH prefilter can never quietly drop the files the ledgers are about — it is only an
  // optimisation over everything else.
  const always = new Set([SETTLE_MODULE, ...IMPORTER_LEDGER]);
  for (const root of ROOTS) {
    for (const abs of walk(path.join(REPO_ROOT, root))) {
      const rel = path.relative(REPO_ROOT, abs).split(path.sep).join('/');
      const source = fs.readFileSync(abs, 'utf8');
      if (!always.has(rel) && !source.includes(MODULE_PATH_HINT)) continue;
      parsed.push(rel);
      const result = scanSource(rel, source);
      sites.push(...result.sites);
      guardsByFile[rel] = Object.freeze(result.guards);
      // The defining module binds its own export; it is not an importer of itself.
      if (result.importsModule && rel !== SETTLE_MODULE) importers.push(rel);
    }
  }
  // 🔴 FROZEN, ALL THE WAY DOWN. The memo hands the SAME arrays to five assertions, so one
  // future `sites.sort()` or `.shift()` in any of them would silently corrupt the other
  // four — the classic cost of sharing a cached structure. Freezing makes that a throw.
  // Each `guardsByFile` array is frozen at insertion, above: freezing only the outer object
  // would have left exactly the arrays `THE RELATIONSHIP` reads mutable.
  repoScanCache = Object.freeze({
    sites: Object.freeze(sites) as ScanSite[],
    importers: Object.freeze(importers.sort()) as string[],
    parsed: Object.freeze(parsed.sort()) as string[],
    guardsByFile: Object.freeze(guardsByFile),
  }) as RepoScan;
  return repoScanCache;
}

// ---------------------------------------------------------------------------
// Can the scan see what it claims to? Every assertion below is a control on the
// INSTRUMENT, run against synthetic sources, so that the ledger assertions after
// them are readings rather than claims.
// ---------------------------------------------------------------------------

const FIXTURE_REL = 'src/server/routers/fixture.router.ts';
const SETTLE_SPEC = '~/server/services/blocks/custom-comfy-settle.service';
/**
 * A real module that is NOT the settle service, for the wrong-module control. Asserted to
 * exist by that control: if it were renamed, `resolveSpec` would return null and the
 * control would pass because RESOLUTION failed rather than because the module differed —
 * green for the wrong reason.
 */
const OTHER_SPEC = '~/server/services/blocks/app-spend-cap.service';

describe('the settle-caller scan can see what it claims to', () => {
  it('POSITIVE CONTROL — resolves a tRPC procedure caller, and names it', () => {
    const { sites } = scanSource(
      FIXTURE_REL,
      `import { settleCustomComfySpend } from '${SETTLE_SPEC}';
export const r = router({
  pollThing: publicProcedure.input(schema).mutation(async ({ input }) => {
    await settleCustomComfySpend({ workflowId: input.id, actualCost: 0 });
  }),
});`
    );
    expect(sites.map(key)).toEqual([`${FIXTURE_REL} :: pollThing (trpc-procedure)`]);
  });

  it('POSITIVE CONTROL — a THIRD caller is visible, so growth cannot be silent', () => {
    const { sites } = scanSource(
      FIXTURE_REL,
      `import { settleCustomComfySpend } from '${SETTLE_SPEC}';
export const r = router({
  pollThing: publicProcedure.mutation(async () => {
    await settleCustomComfySpend({ workflowId: 'a', actualCost: 0 });
  }),
  reconcileThing: publicProcedure.mutation(async () => {
    await settleCustomComfySpend({ workflowId: 'b', actualCost: 0 });
  }),
});
export async function backgroundReconciler() {
  await settleCustomComfySpend({ workflowId: 'c', actualCost: 0 });
}`
    );
    expect(sites.map(key).sort()).toEqual([
      `${FIXTURE_REL} :: backgroundReconciler (function)`,
      `${FIXTURE_REL} :: pollThing (trpc-procedure)`,
      `${FIXTURE_REL} :: reconcileThing (trpc-procedure)`,
    ]);
  });

  it('POSITIVE CONTROL — a REBOUND local is still the same call (E1/E2/E3)', () => {
    // The three shapes measured GREEN before `bindingsOf` closed under rebinding. E2 is
    // the router's own idiom, which is what made this the likely spelling rather than an
    // exotic one.
    const { sites } = scanSource(
      FIXTURE_REL,
      `import { settleCustomComfySpend } from '${SETTLE_SPEC}';
const settleAlias = settleCustomComfySpend;
export const r = router({
  e1Proc: publicProcedure.mutation(async () => {
    await settleAlias({ workflowId: 'a', actualCost: 0 });
  }),
  e2Proc: publicProcedure.mutation(async () => {
    const { settleCustomComfySpend: s } = await import('${SETTLE_SPEC}');
    await s({ workflowId: 'b', actualCost: 0 });
  }),
});
export async function e3Reconciler() {
  const mod = await import('${SETTLE_SPEC}');
  const fn = mod.settleCustomComfySpend;
  await fn({ workflowId: 'c', actualCost: 0 });
}
export async function e4Inline() {
  await (await import('${SETTLE_SPEC}')).settleCustomComfySpend({ workflowId: 'd', actualCost: 0 });
}`
    );
    expect(sites.map(key).sort()).toEqual([
      `${FIXTURE_REL} :: e1Proc (trpc-procedure)`,
      `${FIXTURE_REL} :: e2Proc (trpc-procedure)`,
      `${FIXTURE_REL} :: e3Reconciler (function)`,
      `${FIXTURE_REL} :: e4Inline (function)`,
    ]);
  });

  it('resolves a rebinding CHAIN regardless of declaration order', () => {
    const { sites } = scanSource(
      FIXTURE_REL,
      `import { settleCustomComfySpend } from '${SETTLE_SPEC}';
export async function usesC() {
  await c({ workflowId: 'a', actualCost: 0 });
}
const c = b;
const b = a;
const a = settleCustomComfySpend;`
    );
    expect(sites.map(key)).toEqual([`${FIXTURE_REL} :: usesC (function)`]);
  });

  it('follows an ALIASED import — the match is on the binding, not on the spelling', () => {
    const { sites } = scanSource(
      FIXTURE_REL,
      `import { settleCustomComfySpend as settleIt } from '${SETTLE_SPEC}';
export async function terminalObserver() {
  await settleIt({ workflowId: 'a', actualCost: 0 });
}`
    );
    expect(sites.map(key)).toEqual([`${FIXTURE_REL} :: terminalObserver (function)`]);
  });

  it('follows a NAMESPACE import in BOTH access forms — dotted and computed', () => {
    const { sites } = scanSource(
      FIXTURE_REL,
      `import * as settleMod from '${SETTLE_SPEC}';
export async function dotted() {
  await settleMod.settleCustomComfySpend({ workflowId: 'a', actualCost: 0 });
}
export async function computed() {
  await settleMod['settleCustomComfySpend']({ workflowId: 'b', actualCost: 0 });
}`
    );
    expect(sites.map(key).sort()).toEqual([
      `${FIXTURE_REL} :: computed (function)`,
      `${FIXTURE_REL} :: dotted (function)`,
    ]);
  });

  it('sees a procedure terminated by a COMPUTED method access, not only a dotted one', () => {
    const { sites } = scanSource(
      FIXTURE_REL,
      `import { settleCustomComfySpend } from '${SETTLE_SPEC}';
export const r = router({
  evasiveProc: publicProcedure.input(schema)['mutation'](async () => {
    await settleCustomComfySpend({ workflowId: 'a', actualCost: 0 });
  }),
});`
    );
    expect(sites.map(key)).toEqual([`${FIXTURE_REL} :: evasiveProc (trpc-procedure)`]);
  });

  it('NEGATIVE CONTROL — a comment, a string and a TYPE position are not calls', () => {
    const { sites } = scanSource(
      FIXTURE_REL,
      `import { settleCustomComfySpend } from '${SETTLE_SPEC}';
// This proc used to call settleCustomComfySpend({ workflowId, actualCost }) here.
const doc = "await settleCustomComfySpend({ workflowId: 'a', actualCost: 0 })";
type Settle = typeof settleCustomComfySpend;
export const r = router({
  pollThing: publicProcedure.mutation(async () => {
    /* settleCustomComfySpend({ workflowId: 'a', actualCost: 0 }) */
    return doc as unknown as Settle;
  }),
});`
    );
    expect(sites).toEqual([]);
  });

  it('NEGATIVE CONTROL — a type-only import binds nothing callable', () => {
    const result = scanSource(
      FIXTURE_REL,
      `import type { settleCustomComfySpend } from '${SETTLE_SPEC}';
export type S = typeof settleCustomComfySpend;`
    );
    expect(result.sites).toEqual([]);
    // It still counts as touching the module — the importer ledger is deliberately the
    // wider set, so a type-only reference shows up there rather than nowhere.
    expect(result.importsModule).toBe(true);
  });

  it('NEGATIVE CONTROL — a same-named export from a DIFFERENT module is not this one', () => {
    // The control discriminates on RESOLVED PATH, so the other module has to resolve.
    // Without this the control would pass because resolution failed — green for the
    // wrong reason, one rename away.
    expect(resolveSpec(OTHER_SPEC, FIXTURE_REL)).not.toBeNull();
    expect(resolveSpec(OTHER_SPEC, FIXTURE_REL)).not.toBe(SETTLE_MODULE);
    const { sites, importsModule } = scanSource(
      FIXTURE_REL,
      `import { settleCustomComfySpend } from '${OTHER_SPEC}';
const rebound = settleCustomComfySpend;
export async function impostor() {
  await rebound({ workflowId: 'a', actualCost: 0 });
}`
    );
    expect(sites).toEqual([]);
    expect(importsModule).toBe(false);
  });

  it('POSITIVE CONTROL — the importer scan sees a DYNAMIC import', () => {
    const { importsModule } = scanSource(
      FIXTURE_REL,
      `export async function lazy() {
  const mod = await import('${SETTLE_SPEC}');
  await mod.settleCustomComfySpend({ workflowId: 'a', actualCost: 0 });
}`
    );
    expect(importsModule).toBe(true);
  });

  it('POSITIVE CONTROL — invocation shapes that are not rebindings are still calls', () => {
    // `.call` / `.apply` / `Reflect.apply` are invocations, and `.bind` produces a value
    // through a CallExpression rather than a binding — so the rebinding fixed point alone
    // reached none of them. Each of these was a live third settle caller that the
    // round-2 audit measured GREEN before this.
    const { sites } = scanSource(
      FIXTURE_REL,
      `import { settleCustomComfySpend } from '${SETTLE_SPEC}';
const bound = settleCustomComfySpend.bind(null);
export async function viaCall() {
  await settleCustomComfySpend.call(null, { workflowId: 'a', actualCost: 0 });
}
export async function viaApply() {
  await settleCustomComfySpend.apply(null, [{ workflowId: 'b', actualCost: 0 }]);
}
export async function viaReflect() {
  await Reflect.apply(settleCustomComfySpend, null, [{ workflowId: 'c', actualCost: 0 }]);
}
export async function viaBind() {
  await bound({ workflowId: 'd', actualCost: 0 });
}
export async function viaTernary(useNew: boolean) {
  const fn = useNew ? settleCustomComfySpend : settleCustomComfySpend;
  await fn({ workflowId: 'e', actualCost: 0 });
}`
    );
    expect(sites.map((s) => s.owner).sort()).toEqual([
      'viaApply',
      'viaBind',
      'viaCall',
      'viaReflect',
      'viaTernary',
    ]);
  });

  it('POSITIVE CONTROL — the remaining value-producing shapes: `??`, `||`, comma', () => {
    // `??` and `||` shipped in round 2 with no killing mutation of their own; the comma
    // sequence (`(0, settle)(…)`, the classic this-stripping idiom) was a live third-caller
    // shape measured at 21/21 green in round 3.
    const { sites } = scanSource(
      FIXTURE_REL,
      `import { settleCustomComfySpend } from '${SETTLE_SPEC}';
export async function viaNullish(override?: typeof settleCustomComfySpend) {
  await (override ?? settleCustomComfySpend)({ workflowId: 'a', actualCost: 0 });
}
export async function viaOr(override?: typeof settleCustomComfySpend) {
  await (override || settleCustomComfySpend)({ workflowId: 'b', actualCost: 0 });
}
export async function viaComma() {
  await (0, settleCustomComfySpend)({ workflowId: 'c', actualCost: 0 });
}`
    );
    expect(sites.map((s) => s.owner).sort()).toEqual(['viaComma', 'viaNullish', 'viaOr']);
  });

  it('POSITIVE CONTROL — the guard scan attributes a guard call to its procedure', () => {
    const { guards } = scanSource(
      FIXTURE_REL,
      `import { ${GUARD} } from '~/server/services/blocks/block-bridge-auth.service';
export const r = router({
  guardedProc: publicProcedure.mutation(async ({ input }) => {
    const claims = await ${GUARD}(input.blockToken);
    return claims;
  }),
});`
    );
    expect(guards.map((g) => g.owner)).toEqual(['guardedProc']);
    expect(guards.map((g) => [g.depth, g.conditional, g.enforced])).toEqual([[1, false, true]]);
  });

  it('POSITIVE CONTROL — a guard whose REJECTION cannot reach the caller is not `enforced`', () => {
    // The round-3 fail-open family. Every one of these sits exactly where an enforcing
    // guard sits — same owner, same depth, unconditional, earlier than the settle — so
    // position and conditionality cannot separate them from the real thing.
    const { guards } = scanSource(
      FIXTURE_REL,
      `import { ${GUARD} } from '~/server/services/blocks/block-bridge-auth.service';
export const r = router({
  swallowedByCatch: publicProcedure.mutation(async ({ input }) => {
    const claims = await ${GUARD}(input.blockToken).catch(() => ({}));
    return claims;
  }),
  swallowedByThen: publicProcedure.mutation(async ({ input }) => {
    const claims = await ${GUARD}(input.blockToken).then((c) => c, () => ({}));
    return claims;
  }),
  neverAwaited: publicProcedure.mutation(async ({ input }) => {
    void ${GUARD}(input.blockToken);
    return null;
  }),
  bareStatement: publicProcedure.mutation(async ({ input }) => {
    ${GUARD}(input.blockToken);
    return null;
  }),
  enforced: publicProcedure.mutation(async ({ input }) => {
    const claims = await ${GUARD}(input.blockToken);
    return claims;
  }),
  enforcedByReturn: publicProcedure.mutation(async ({ input }) => {
    return ${GUARD}(input.blockToken);
  }),
});`
    );
    expect(guards.map((g) => `${g.owner}=${g.enforced}`).sort()).toEqual([
      'bareStatement=false',
      'enforced=true',
      'enforcedByReturn=true',
      'neverAwaited=false',
      'swallowedByCatch=false',
      'swallowedByThen=false',
    ]);
  });

  it('POSITIVE CONTROL — EVERY conditional node kind is pinned, one fixture each', () => {
    // 🔴 WITHOUT THIS, MOST OF THE LIST WAS DECORATION. Measured before it existed: 7 of
    // the 9 entries in `CONDITIONAL_STATEMENT_KINDS` could each be DELETED with the whole
    // file still green — only `isIfStatement` and `isTryStatement` were pinned. That is
    // the fail-OPEN direction: a guard inside a `switch` case, any loop body, or a `catch`
    // block would have scored unconditional and satisfied `THE RELATIONSHIP`.
    //
    // The `do` body is here too, and its marking is a deliberate FALSE-RED rather than a
    // hazard — it runs at least once, so it is one of the slots the list's docstring says
    // are over-marked. Pinning it stops that over-marking being removed by accident while
    // the docstring still claims it.
    const { guards } = scanSource(
      FIXTURE_REL,
      `import { ${GUARD} } from '~/server/services/blocks/block-bridge-auth.service';
export const r = router({
  inIf: publicProcedure.mutation(async ({ input }) => {
    if (cond) { return await ${GUARD}(input.blockToken); }
    return null;
  }),
  inSwitch: publicProcedure.mutation(async ({ input }) => {
    switch (input.mode) { case 'a': return await ${GUARD}(input.blockToken); default: return null; }
  }),
  inFor: publicProcedure.mutation(async ({ input }) => {
    for (let i = 0; i < n; i++) { return await ${GUARD}(input.blockToken); }
    return null;
  }),
  inForOf: publicProcedure.mutation(async ({ input }) => {
    for (const x of list) { return await ${GUARD}(input.blockToken); }
    return null;
  }),
  inForIn: publicProcedure.mutation(async ({ input }) => {
    for (const k in obj) { return await ${GUARD}(input.blockToken); }
    return null;
  }),
  inWhile: publicProcedure.mutation(async ({ input }) => {
    while (cond) { return await ${GUARD}(input.blockToken); }
    return null;
  }),
  inDoBody: publicProcedure.mutation(async ({ input }) => {
    do { return await ${GUARD}(input.blockToken); } while (cond);
  }),
  // Pins isTryStatement, not a catch-clause entry - see the list for why there is none.
  inCatch: publicProcedure.mutation(async ({ input }) => {
    try { return null; } catch { return await ${GUARD}(input.blockToken); }
  }),
});`
    );
    expect(guards.map((g) => `${g.owner}=${g.conditional}`).sort()).toEqual([
      'inCatch=true',
      'inDoBody=true',
      'inFor=true',
      'inForIn=true',
      'inForOf=true',
      'inIf=true',
      'inSwitch=true',
      'inWhile=true',
    ]);
  });

  it('POSITIVE CONTROL — the SLOT-level claims the kinds docstring makes', () => {
    // The kind-level control above pins one fixture per `CONDITIONAL_STATEMENT_KINDS`
    // ENTRY, never per SLOT. These two are slot-level, and they earn their place for
    // DIFFERENT reasons — stated separately because an earlier version of this comment
    // claimed they both "pin the CLASSIFICATION the docstring asserts, so a future
    // per-slot test cannot silently disagree with it", and that was measurably false:
    // `crossesConditional` is slot-BLIND for statement kinds, so every slot of a listed
    // kind yields `true` and BOTH assertions stay green if you swap the two
    // classifications in the prose.
    //
    //   `forIncrementor` — a REAL unique kill, in the FAIL-OPEN direction. Measured: a
    //     slot-aware `for` arm (`return child === node.statement`) leaves the kind-level
    //     `inFor` fixture green and turns this one red. That refactor would stop marking
    //     the incrementor, so a guard there — reached only after an iteration — would
    //     score unconditional.
    //   `firstCaseExpr` — the same role as the `do` body pin above: it locks in an
    //     over-marking the docstring calls a false-RED, so the over-marking cannot be
    //     removed while the docstring still claims it. It has NO reachable unique killing
    //     mutant — expressing it would need `CaseBlock`-level descent state that
    //     `crossesConditional(node, child)` cannot carry — and it is here as a ratchet,
    //     not as a discriminator. Said plainly rather than dressed up as coverage.
    const { guards } = scanSource(
      FIXTURE_REL,
      `import { ${GUARD} } from '~/server/services/blocks/block-bridge-auth.service';
export const r = router({
  firstCaseExpr: publicProcedure.mutation(async ({ input }) => {
    switch (input.mode) { default: return null; case await ${GUARD}(input.blockToken): return 'a'; }
  }),
  forIncrementor: publicProcedure.mutation(async ({ input }) => {
    for (let i = 0; i < n; i = await ${GUARD}(input.blockToken)) { noop(); }
    return null;
  }),
});`
    );
    expect(guards.map((g) => `${g.owner}=${g.conditional}`).sort()).toEqual([
      'firstCaseExpr=true',
      'forIncrementor=true',
    ]);
  });

  it('POSITIVE CONTROL — a SHORT-CIRCUIT ASSIGNMENT to the guard is conditional', () => {
    // `??=` / `||=` / `&&=` short-circuit exactly like their plain counterparts, and the
    // guard written this way is awaited, lexically first, at depth 1, in the right owner —
    // so every other condition is satisfied while the guard may not run at all. Measured
    // `conditional=false enforced=true` before the fix.
    const { guards } = scanSource(
      FIXTURE_REL,
      `import { ${GUARD} } from '~/server/services/blocks/block-bridge-auth.service';
export const r = router({
  nullishAssign: publicProcedure.mutation(async ({ input }) => {
    let claims = cache.get(input.blockToken);
    claims ??= await ${GUARD}(input.blockToken);
    return claims;
  }),
  orAssign: publicProcedure.mutation(async ({ input }) => {
    let claims = cache.get(input.blockToken);
    claims ||= await ${GUARD}(input.blockToken);
    return claims;
  }),
  andAssign: publicProcedure.mutation(async ({ input }) => {
    let claims = cache.get(input.blockToken);
    claims &&= await ${GUARD}(input.blockToken);
    return claims;
  }),
});`
    );
    expect(guards.map((g) => `${g.owner}=${g.conditional}`).sort()).toEqual([
      'andAssign=true',
      'nullishAssign=true',
      'orAssign=true',
    ]);
    expect(guards.filter((g) => g.depth === 1 && !g.conditional)).toEqual([]);
  });

  it('NEGATIVE CONTROL — the LEFT operand of a short-circuit is NOT conditional', () => {
    // The mirror image, and the reason `crossesConditional` reads which operand the call
    // sits in rather than marking the whole `BinaryExpression`: `guard(t) && x` always
    // evaluates the guard, and so does the CONDITION of a ternary.
    const { guards } = scanSource(
      FIXTURE_REL,
      `import { ${GUARD} } from '~/server/services/blocks/block-bridge-auth.service';
export const r = router({
  leftOperand: publicProcedure.mutation(async ({ input }) => {
    const claims = (await ${GUARD}(input.blockToken)) ?? {};
    return claims;
  }),
  ternaryCondition: publicProcedure.mutation(async ({ input }) => {
    return (await ${GUARD}(input.blockToken)) ? 'a' : 'b';
  }),
  rightOperand: publicProcedure.mutation(async ({ input }) => {
    const claims = cache.get(input.blockToken) ?? (await ${GUARD}(input.blockToken));
    return claims;
  }),
  rightOfOr: publicProcedure.mutation(async ({ input }) => {
    const claims = cache.get(input.blockToken) || (await ${GUARD}(input.blockToken));
    return claims;
  }),
  rightOfAnd: publicProcedure.mutation(async ({ input }) => {
    const claims = cache.get(input.blockToken) && (await ${GUARD}(input.blockToken));
    return claims;
  }),
  rightOfPlainBinary: publicProcedure.mutation(async ({ input }) => {
    // A non-short-circuiting binary always evaluates both operands - this is what pins
    // the token test itself; without it every binary's right operand would be marked.
    const ok = cached !== (await ${GUARD}(input.blockToken));
    return ok;
  }),
  ternaryBranch: publicProcedure.mutation(async ({ input }) => {
    const claims = cached ? cached : await ${GUARD}(input.blockToken);
    return claims;
  }),
  ternaryWhenTrue: publicProcedure.mutation(async ({ input }) => {
    const claims = force ? await ${GUARD}(input.blockToken) : cached;
    return claims;
  }),
});`
    );
    // 🔴 ALL THREE POSITIONS OF THE TERNARY RULE, AND IT TOOK TWO GOES. Pinning only the
    // CONDITION left the `whenTrue`/`whenFalse` clause unkilled — replacing it wholesale
    // with `return false` kept the file green, because the condition case satisfies that
    // mutant too. Adding only a `whenFalse` fixture then left the `whenTrue ||` half
    // unkilled, which is the FAIL-OPEN direction and the more idiomatic spelling:
    // `force ? await guard(t) : cached` would have scored unconditional. Both branch
    // positions are fixtures now, so each half of the clause dies on its own.
    // 🔴 EVERY TOKEN IN `SHORT_CIRCUIT_TOKENS` HAS A FIXTURE. Measured before `||` and
    // `&&` were added: deleting either token left the file green — i.e. the two plain
    // spellings the constant's own docstring says it exists for were the two the suite
    // could not see. Fail-OPEN.
    expect(guards.map((g) => `${g.owner}=${g.conditional}`).sort()).toEqual([
      'leftOperand=false',
      'rightOfAnd=true',
      'rightOfOr=true',
      'rightOfPlainBinary=false',
      'rightOperand=true',
      'ternaryBranch=true',
      'ternaryCondition=false',
      'ternaryWhenTrue=true',
    ]);
  });

  it('POSITIVE CONTROL — a promise CHAIN is peeled and judged, not refused on sight', () => {
    // `.catch` always swallows; `.then` swallows only with a second (onRejected) argument;
    // `.finally` never does. An earlier revision refused at the sight of any of the three,
    // which was INERT (a member-access parent can never also be an await) and wrong about
    // `.finally`. Transparent wrappers — parens, `as`, `!`, a comma sequence — are peeled
    // the same way `unwrap` peels them on the settle side.
    const { guards } = scanSource(
      FIXTURE_REL,
      `import { ${GUARD} } from '~/server/services/blocks/block-bridge-auth.service';
export const r = router({
  chainCatch: publicProcedure.mutation(async ({ input }) => {
    return await ${GUARD}(input.blockToken).catch(() => ({}));
  }),
  chainThenTwoArgs: publicProcedure.mutation(async ({ input }) => {
    return await ${GUARD}(input.blockToken).then((c) => c, () => ({}));
  }),
  chainThenOneArg: publicProcedure.mutation(async ({ input }) => {
    return await ${GUARD}(input.blockToken).then((c) => c);
  }),
  chainThenSpread: publicProcedure.mutation(async ({ input }) => {
    return await ${GUARD}(input.blockToken).then(...handlers);
  }),
  chainFinally: publicProcedure.mutation(async ({ input }) => {
    return await ${GUARD}(input.blockToken).finally(() => {});
  }),
  computedCatch: publicProcedure.mutation(async ({ input }) => {
    return await ${GUARD}(input.blockToken)['catch'](() => ({}));
  }),
  throughCast: publicProcedure.mutation(async ({ input }) => {
    return await (${GUARD}(input.blockToken) as never);
  }),
  throughNonNull: publicProcedure.mutation(async ({ input }) => {
    return await ${GUARD}(input.blockToken)!;
  }),
  throughComma: publicProcedure.mutation(async ({ input }) => {
    return await (noop(), ${GUARD}(input.blockToken));
  }),
  usedNotAwaited: publicProcedure.mutation(async ({ input }) => {
    return ${GUARD}(input.blockToken).constructor;
  }),
});`
    );
    expect(guards.map((g) => `${g.owner}=${g.enforced}`).sort()).toEqual([
      'chainCatch=false',
      'chainFinally=true',
      'chainThenOneArg=true',
      // 🔴 A SPREAD IS ONE ARGUMENT NODE, so an arity test alone scored this as enforcing
      // while `handlers` may carry an onRejected. Measured: without the spread check the
      // whole file stayed green.
      'chainThenSpread=false',
      'chainThenTwoArgs=false',
      'computedCatch=false',
      'throughCast=true',
      'throughComma=true',
      'throughNonNull=true',
      'usedNotAwaited=false',
    ]);
  });

  it('NEGATIVE CONTROL — the guard must come from the GUARD MODULE, under its own name', () => {
    // Each of these binds the local name `authorizeBlockBridgeToken` and would have been
    // counted as a live guard: an unrelated export aliased onto the name, and an import
    // whose specifier does not resolve at all.
    expect(resolveSpec('~/server/services/blocks/block-bridge-auth.service', FIXTURE_REL)).toBe(
      GUARD_MODULE
    );
    expect(resolveSpec('~/server/services/blocks/block-token-access.service', FIXTURE_REL)).toBe(
      'src/server/services/blocks/block-token-access.service.ts'
    );
    const aliasedImpostor = scanSource(
      FIXTURE_REL,
      `import { verifyBlockToken as ${GUARD} } from '~/server/services/blocks/block-token-access.service';
export const r = router({
  p: publicProcedure.mutation(async ({ input }) => {
    return await ${GUARD}(input.blockToken);
  }),
});`
    );
    expect(aliasedImpostor.guards).toEqual([]);
    const unresolvable = scanSource(
      FIXTURE_REL,
      `import { ${GUARD} } from 'some-package-that-does-not-resolve';
export const r = router({
  p: publicProcedure.mutation(async ({ input }) => {
    return await ${GUARD}(input.blockToken);
  }),
});`
    );
    expect(unresolvable.guards).toEqual([]);
    // 🔴 THE THIRD CASE, WHICH THE FIRST TWO CANNOT PIN: the module is RIGHT and the
    // imported name is WRONG — a name that is NOT the guard, imported from the guard's
    // own module and aliased onto the guard's name. (That module exports exactly one
    // symbol today, so the imported name here is deliberately one that does not exist;
    // the scan never checks that it does, and the point is the alias, not the export.)
    // Measured: without this, deleting the imported-name comparison left 29/29.
    const aliasedWithinGuardModule = scanSource(
      FIXTURE_REL,
      `import { resolveAppBlockApprovalVerdict as ${GUARD} } from '~/server/services/blocks/block-bridge-auth.service';
export const r = router({
  p: publicProcedure.mutation(async ({ input }) => {
    return await ${GUARD}(input.blockToken);
  }),
});`
    );
    expect(aliasedWithinGuardModule.guards).toEqual([]);
  });

  it('POSITIVE CONTROL — the two NAMESPACE facts the header states, measured separately', () => {
    // Both are fail-CLOSED limitations the header records, and the settle side's namespace
    // behaviour is pinned by a test while the guard side's was prose only — which matters
    // because the plausible future edit is exactly the one `bindingsOf` already made on the
    // settle side (teach the scan to follow namespaces), and it would silently falsify the
    // header with nothing red.
    const NS_IMPORT = `import * as auth from '~/server/services/blocks/block-bridge-auth.service';`;
    const NAMED_IMPORT = `import { ${GUARD} } from '~/server/services/blocks/block-bridge-auth.service';`;
    const proc = (body: string) => `export const r = router({
  p: publicProcedure.mutation(async ({ input }) => {
${body}
  }),
});`;
    // (a) A namespace import as the file's ONLY guard-module import disqualifies the file:
    //     the named-import requirement is never satisfied, so even a bare-identifier call
    //     contributes nothing.
    expect(
      scanSource(
        FIXTURE_REL,
        `${NS_IMPORT}\n${proc(`    return await ${GUARD}(input.blockToken);`)}`
      ).guards
    ).toEqual([]);
    // …and alongside the named import it changes nothing.
    expect(
      scanSource(
        FIXTURE_REL,
        `${NAMED_IMPORT}\n${NS_IMPORT}\n${proc(`    return await ${GUARD}(input.blockToken);`)}`
      ).guards.map((g) => g.owner)
    ).toEqual(['p']);
    // (b) INDEPENDENTLY of (a): a guard CALLED through a namespace contributes no guards
    //     even in a file that fully qualifies — collection is gated on a bare-identifier
    //     callee. The named import is present here, so this zero is not (a) in disguise.
    expect(
      scanSource(
        FIXTURE_REL,
        `${NAMED_IMPORT}\n${NS_IMPORT}\n${proc(
          `    return await auth.${GUARD}(input.blockToken);`
        )}`
      ).guards
    ).toEqual([]);
    expect(
      scanSource(
        FIXTURE_REL,
        `${NAMED_IMPORT}\n${NS_IMPORT}\n${proc(
          `    return await auth['${GUARD}'](input.blockToken);`
        )}`
      ).guards
    ).toEqual([]);
  });

  it('POSITIVE CONTROL — a SHADOWED guard name empties the guard population for that file', () => {
    // Keeping the name is the one evasion the by-name match could not see: the module
    // declares its own `authorizeBlockBridgeToken` and every call resolves to that.
    //
    // 🔴 THE FIXTURE IMPORTS THE REAL GUARD TOO, AND THAT IS THE POINT. An earlier version
    // declared the shadow and imported NOTHING, so it falsified BOTH clauses at once and
    // neither was individually pinned — measured, `return imported;` and `return !shadowed;`
    // each SURVIVED at 25/25. A module-scope shadow cannot coexist with the import (TS
    // rejects the duplicate identifier), so the case that can actually occur, and the one
    // this now pins, is a NESTED shadow in a file that does import the guard.
    const shadowed = scanSource(
      FIXTURE_REL,
      `import { ${GUARD} } from '~/server/services/blocks/block-bridge-auth.service';
export const r = router({
  p: publicProcedure.mutation(async ({ input }) => {
    const ${GUARD} = async (_t: string) => ({ scopes: [] });
    const claims = await ${GUARD}(input.blockToken);
    return claims;
  }),
});`
    );
    expect(shadowed.guards).toEqual([]);
    // …and the same file with a real import and no shadow does yield the guard.
    const clean = scanSource(
      FIXTURE_REL,
      `import { ${GUARD} } from '~/server/services/blocks/block-bridge-auth.service';
export const r = router({
  p: publicProcedure.mutation(async ({ input }) => {
    const claims = await ${GUARD}(input.blockToken);
    return claims;
  }),
});`
    );
    expect(clean.guards.map((g) => g.owner)).toEqual(['p']);
  });

  it('POSITIVE CONTROL — a same-named SIBLING does not lend its guard (owner identity)', () => {
    // `blocks.router.ts` already holds two distinct `cancelWorkflow` entities, so this is
    // the house idiom rather than a contrivance. Measured at 21/21 green before `ownerId`.
    const { sites, guards } = scanSource(
      FIXTURE_REL,
      `import { settleCustomComfySpend } from '${SETTLE_SPEC}';
import { ${GUARD} } from '~/server/services/blocks/block-bridge-auth.service';
async function pollThing(t: string) {
  const claims = await ${GUARD}(t);
  return claims;
}
export const r = router({
  pollThing: publicProcedure.mutation(async ({ input }) => {
    await settleCustomComfySpend({ workflowId: input.id, actualCost: 0 });
    return pollThing(input.blockToken);
  }),
});`
    );
    expect(sites).toHaveLength(1);
    expect(guards).toHaveLength(1);
    // Same NAME on both sides…
    expect(guards[0].owner).toBe(sites[0].owner);
    // …and the predicate `THE RELATIONSHIP` uses still finds nothing, because the owner
    // NODES differ.
    expect(guards[0].ownerId).not.toBe(sites[0].ownerId);
    expect(
      guards.some(
        (g) =>
          g.ownerId === sites[0].ownerId &&
          g.depth === 1 &&
          !g.conditional &&
          g.enforced &&
          g.pos < sites[0].pos
      )
    ).toBe(false);
  });

  it('POSITIVE CONTROL — a guard that is PRESENT but does not RUN is not `depth 1, unconditional`', () => {
    // The fail-open D1 shapes: both leave the owner, the count and the source offset
    // exactly where an unguarded-by-position check wants them.
    const { guards } = scanSource(
      FIXTURE_REL,
      `import { ${GUARD} } from '~/server/services/blocks/block-bridge-auth.service';
export const r = router({
  behindIf: publicProcedure.mutation(async ({ input }) => {
    if (someFlag) { const claims = await ${GUARD}(input.blockToken); return claims; }
    return null;
  }),
  swallowed: publicProcedure.mutation(async ({ input }) => {
    let claims;
    try { claims = await ${GUARD}(input.blockToken); } catch { claims = {}; }
    return claims;
  }),
  deferred: publicProcedure.mutation(async ({ input }) => {
    setTimeout(() => { void ${GUARD}(input.blockToken); }, 0);
    return null;
  }),
});`
    );
    expect(
      guards.map((g) => `${g.owner} depth=${g.depth} conditional=${g.conditional}`).sort()
    ).toEqual([
      'behindIf depth=1 conditional=true',
      'deferred depth=2 conditional=false',
      'swallowed depth=1 conditional=true',
    ]);
    // …and none of them satisfies the predicate `THE RELATIONSHIP` uses.
    expect(guards.filter((g) => g.depth === 1 && !g.conditional)).toEqual([]);
  });

  it('POSITIVE CONTROL — a settle DEFERRED out of the request lifetime is depth > 1', () => {
    const { sites } = scanSource(
      FIXTURE_REL,
      `import { settleCustomComfySpend } from '${SETTLE_SPEC}';
export const r = router({
  deferredSettle: publicProcedure.mutation(async ({ input }) => {
    setTimeout(() => { void settleCustomComfySpend({ workflowId: input.id, actualCost: 0 }); }, 60000);
    return null;
  }),
});`
    );
    expect(sites.map((s) => `${s.owner} depth=${s.depth}`)).toEqual(['deferredSettle depth=2']);
  });

  it('POSITIVE CONTROL — the real sweep reaches every root and the ledgered files', () => {
    const { sites, parsed } = scanRepo();
    // A zero here would be indistinguishable from a scan wired to nothing.
    expect(sites.length).toBeGreaterThan(0);
    expect(parsed).toContain(ROUTER);
    expect(parsed).toContain(SETTLE_MODULE);
    // Every root must actually contain files, or a typo silently removes a whole tree
    // from the sweep while every assertion stays green.
    for (const root of ROOTS) {
      expect(walk(path.join(REPO_ROOT, root)).length, `${root}/ swept no files`).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// The ledgers.
// ---------------------------------------------------------------------------

describe('customComfy settle-caller ledger (clawgate #572, option 1)', () => {
  it('has exactly the ledgered production call sites — fails on a GROWTH or a SHRINK', () => {
    const { sites } = scanRepo();
    expect(sites.map(key).sort()).toEqual(CALLER_LEDGER.map(key).sort());
  });

  it('makes exactly the ledgered NUMBER of settle calls per owner', () => {
    const { sites } = scanRepo();
    const counts: Record<string, number> = {};
    for (const site of sites) counts[site.owner] = (counts[site.owner] ?? 0) + 1;
    expect(counts).toEqual(CALLS_PER_OWNER);
  });

  it('THE RELATIONSHIP — each settle call is UNCONDITIONALLY guarded first, in its OWN procedure', () => {
    // The 25h window is accepted BECAUSE the settle path runs only inside guarded bridge
    // procedures. A caller that is not one, or one whose guard no longer runs first, is a
    // different decision rather than a smaller one.
    //
    // 🔴 THIS IS THE PER-PROCEDURE ORDERING CLAIM, AND NOTHING ELSE IN THE REPO ASSERTS
    // IT. `no-unguarded-block-bridge-token.test.ts` pins the guard's POPULATION — which
    // procs reach it — never that it is awaited before anything in particular. An earlier
    // draft here cited that file as covering the ordering, and asserted only
    // `guardCallCount >= settleSiteCount` — a module-WIDE count (14 guard call
    // expressions in the router today) against a site count of 2, so it survived any
    // deletion that left two guard calls anywhere in the file. Measured: removing the
    // guard from `cancelWorkflow` alone, and separately moving it to AFTER the settle,
    // both stayed GREEN under that assertion and both go RED under this one.
    //
    // 🔴 AND THREE CONDITIONS, NOT ONE, BECAUSE A POSITION COMPARISON ALONE IS FAIL-OPEN.
    // A guard that is PRESENT but does not RUN satisfies an offset check: measured on the
    // real router, wrapping `pollWorkflow`'s existing guard in `if (someFlag) { … }`, or
    // in a `try { … } catch { claims = {} }`, left the owner and the count unchanged and
    // the whole file GREEN while the settle stayed reachable with no enforced guard.
    // Note the shape, because the header's reachability bullet is written about the
    // CALLER ledger where the identical property is fail-CLOSED ("a call behind
    // `if (someFlag)` counts as a call site"). For the GUARD it inverts. So:
    //   `depth === 1`      — the call is in the procedure's own resolver body, not in a
    //                        callback it hands to something else that runs later;
    //   `!conditional`     — no `if` / `try` / `switch` / loop / short-circuit between the
    //                        guard call and the procedure;
    //   `g.pos < site.pos` — and it is lexically first.
    //
    // 🔴 AND TWO MORE THE ROUND-3 AUDIT ADDED, both of which had revived a mutant this
    // file already listed as RED:
    //   `g.enforced`       — the guard is AWAITED (or returned) and its rejection is not
    //                        swallowed by a chained `.catch` / `.then` / `.finally`. See
    //                        `isEnforcedCall`: `.catch(() => ({}))` and a bare un-awaited
    //                        call both sit exactly where an enforcing guard would, so the
    //                        three conditions above cannot tell them apart.
    //   `g.ownerId === site.ownerId` — the SAME procedure NODE, not merely the same NAME.
    //                        `blocks.router.ts` already contains two distinct entities
    //                        called `cancelWorkflow`, so a same-named sibling declared
    //                        anywhere earlier in the file was lending the real procedure
    //                        its guard.
    const { sites, guardsByFile } = scanRepo();
    expect(sites.filter((s) => s.kind !== 'trpc-procedure')).toEqual([]);
    // The settle itself must also be in the procedure's own body: a settle moved into a
    // `setTimeout` callback runs after the response, outside the guarded request
    // lifetime, which is exactly what `CALLER_LEDGER`'s "behind the bridge guard BY
    // CONSTRUCTION" stops meaning.
    expect(sites.filter((s) => s.depth !== 1).map(key)).toEqual([]);
    const unguarded = sites.filter((site) => {
      const guards = guardsByFile[site.file] ?? [];
      return !guards.some(
        (g) =>
          g.ownerId === site.ownerId &&
          g.depth === 1 &&
          !g.conditional &&
          g.enforced &&
          g.pos < site.pos
      );
    });
    expect(unguarded.map(key)).toEqual([]);
  });

  it('has exactly the ledgered importers — a binding the call scan cannot model still fails', () => {
    const { importers } = scanRepo();
    expect(importers).toEqual([...IMPORTER_LEDGER].sort());
  });

  it('keeps the decision record beside the function it is about', () => {
    // A deliberately coarse pin, and a SPELLING one — the exception the header names.
    // Asserting the whole prose would make every reword a failure; asserting nothing lets
    // the record be deleted while the ledgers above still pass and read as coverage. What
    // makes the name true rather than approximate is the SCOPE: the literals must appear
    // in the comment block ATTACHED TO THE DECLARATION, so moving the record to the module
    // header or to another file fails, which a whole-file `toContain` would not notice.
    const source = fs.readFileSync(path.join(REPO_ROOT, SETTLE_MODULE), 'utf8');
    const sf = parse(SETTLE_MODULE, source);
    let record: string | null = null;
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === SETTLE_EXPORT && record == null) {
        const ranges = ts.getLeadingCommentRanges(source, node.getFullStart()) ?? [];
        record = ranges.map((r) => source.slice(r.pos, r.end)).join('\n');
      }
      node.forEachChild(visit);
    };
    visit(sf);
    expect(record, `no leading comment found on ${SETTLE_EXPORT}`).not.toBeNull();
    expect(record).toContain('clawgate #572');
    expect(record).toContain('KNOWINGLY UNADDRESSED');
    // The two harms the decision accepts. Named separately because the per-user daily cap
    // is the larger one and is the half a later summariser is most likely to trim.
    expect(record).toContain('CONSENT BUDGET');
    expect(record).toMatch(/PER-USER DAILY/);
    // The third observer, so a green ledger above is not read as "the settle path is
    // complete" — see the header.
    expect(record).toContain('cancelAppWorkflow');
  });
});
