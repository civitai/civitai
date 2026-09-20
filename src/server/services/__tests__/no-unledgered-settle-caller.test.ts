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
 *   - `THE RELATIONSHIP` matches a guard to a settle by OWNER NAME, so two procedures that
 *     share a name would let one borrow the other's guard. The exact-set ledger and the
 *     per-owner counter are what catch that, not this assertion.
 *   - `depth === 1` is a LEXICAL test, not an executional one. It rejects a settle or a
 *     guard buried in a callback the resolver hands to something else, and it equally
 *     rejects a benign `withRetry(async () => …)` wrapper. The scan cannot tell those
 *     apart; the choice is deliberately the fail-CLOSED one.
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
  if (
    ts.isBinaryExpression(n) &&
    (n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      n.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    return isSettleExportExpr(n.left, b, rel) || isSettleExportExpr(n.right, b, rel);
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
 * Node kinds between a call and its owner that make the call CONDITIONAL — i.e. present in
 * the source but not necessarily executed. `ConditionalExpression` and a short-circuiting
 * `BinaryExpression` are deliberately absent from this list only because they cannot
 * contain a statement; a guard written as `flag && (await guard())` is caught by
 * `isConditionalExpressionLike` below.
 */
const CONDITIONAL_KINDS: ((n: ts.Node) => boolean)[] = [
  ts.isIfStatement,
  ts.isTryStatement,
  ts.isSwitchStatement,
  ts.isForStatement,
  ts.isForOfStatement,
  ts.isForInStatement,
  ts.isWhileStatement,
  ts.isDoStatement,
  ts.isCatchClause,
  ts.isConditionalExpression,
  (n: ts.Node) =>
    ts.isBinaryExpression(n) &&
    [
      ts.SyntaxKind.AmpersandAmpersandToken,
      ts.SyntaxKind.BarBarToken,
      ts.SyntaxKind.QuestionQuestionToken,
    ].includes(n.operatorToken.kind),
];

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
 */
type Attribution = { owner: string; kind: SiteKind; depth: number; conditional: boolean };

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
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isFunctionDeclaration(n) && n.name)
      return { owner: n.name.text, kind: 'function', depth: depth + 1, conditional };
    if (ts.isMethodDeclaration(n) && ts.isIdentifier(n.name))
      return { owner: n.name.text, kind: 'function', depth: depth + 1, conditional };
    if (depth > 0) {
      if (
        ts.isPropertyAssignment(n) &&
        (ts.isIdentifier(n.name) || ts.isStringLiteralLike(n.name))
      ) {
        return {
          owner: n.name.text,
          kind: isTrpcProcedure(n) ? 'trpc-procedure' : 'function',
          depth,
          conditional,
        };
      }
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name))
        return { owner: n.name.text, kind: 'function', depth, conditional };
    }
    if (CONDITIONAL_KINDS.some((is) => is(n as never))) conditional = true;
    if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) depth++;
  }
  return { owner: '<module scope>', kind: 'module-scope', depth, conditional };
}

/** A settle call site, with everything the guard-ordering check compares against. */
type ScanSite = Site & Attribution & { pos: number };
type GuardSite = Attribution & { pos: number };

function scanSource(
  rel: string,
  source: string
): { sites: ScanSite[]; importsModule: boolean; guards: GuardSite[] } {
  const sf = parse(rel, source);
  const bindings = bindingsOf(sf, rel);
  const sites: ScanSite[] = [];
  const guards: GuardSite[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      if (
        (bindings.direct.size > 0 || bindings.namespaces.size > 0) &&
        isSettleCall(node, bindings, rel)
      ) {
        sites.push({ file: rel, ...ownerOf(node), pos: node.getStart(sf) });
      }
      // 🔴 THE GUARD IS MATCHED BY NAME, AND THAT IS FAIL-CLOSED HERE. It is not the thing
      // under test — `no-unguarded-block-bridge-token.test.ts` owns its population; what
      // this file adds is the PER-PROCEDURE ORDERING, which that file does not assert.
      // Every way to defeat the name (rename it, reach it through an alias, call it
      // computed) yields ZERO guards for that procedure and turns `THE RELATIONSHIP` RED,
      // so unlike the #589 family this spelling cannot be walked in the permissive
      // direction.
      if (ts.isIdentifier(node.expression) && node.expression.text === GUARD) {
        guards.push({ ...ownerOf(node), pos: node.getStart(sf) });
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
  guardsByFile: Map<string, { owner: string; pos: number }[]>;
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
  const guardsByFile = new Map<string, { owner: string; pos: number }[]>();
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
      guardsByFile.set(rel, result.guards);
      // The defining module binds its own export; it is not an importer of itself.
      if (result.importsModule && rel !== SETTLE_MODULE) importers.push(rel);
    }
  }
  // 🔴 FROZEN. The memo hands the SAME arrays to five assertions, so one future
  // `sites.sort()` or `.shift()` in any of them would silently corrupt the other four —
  // the classic cost of sharing a cached structure. Freezing makes that a throw.
  repoScanCache = Object.freeze({
    sites: Object.freeze(sites) as ScanSite[],
    importers: Object.freeze(importers.sort()) as string[],
    parsed: Object.freeze(parsed.sort()) as string[],
    guardsByFile,
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

  it('POSITIVE CONTROL — the guard scan attributes a guard call to its procedure', () => {
    const { guards } = scanSource(
      FIXTURE_REL,
      `export const r = router({
  guardedProc: publicProcedure.mutation(async ({ input }) => {
    const claims = await ${GUARD}(input.blockToken);
    return claims;
  }),
});`
    );
    expect(guards.map((g) => g.owner)).toEqual(['guardedProc']);
    expect(guards.map((g) => [g.depth, g.conditional])).toEqual([[1, false]]);
  });

  it('POSITIVE CONTROL — a guard that is PRESENT but does not RUN is not `depth 1, unconditional`', () => {
    // The fail-open D1 shapes: both leave the owner, the count and the source offset
    // exactly where an unguarded-by-position check wants them.
    const { guards } = scanSource(
      FIXTURE_REL,
      `export const r = router({
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
    const { sites, guardsByFile } = scanRepo();
    expect(sites.filter((s) => s.kind !== 'trpc-procedure')).toEqual([]);
    // The settle itself must also be in the procedure's own body: a settle moved into a
    // `setTimeout` callback runs after the response, outside the guarded request
    // lifetime, which is exactly what `CALLER_LEDGER`'s "behind the bridge guard BY
    // CONSTRUCTION" stops meaning.
    expect(sites.filter((s) => s.depth !== 1).map(key)).toEqual([]);
    const unguarded = sites.filter((site) => {
      const guards = guardsByFile.get(site.file) ?? [];
      return !guards.some(
        (g) => g.owner === site.owner && g.depth === 1 && !g.conditional && g.pos < site.pos
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
