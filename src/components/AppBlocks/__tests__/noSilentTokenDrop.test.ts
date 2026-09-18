import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import ts from 'typescript';
import { describe, expect, test } from 'vitest';
import { BRIDGE_NACK_EXEMPT } from '~/components/AppBlocks/bridgeTelemetry';

/**
 * NO HOST MESSAGE HANDLER MAY DROP A CREDENTIAL-LESS REQUEST WITHOUT ANSWERING IT.
 *
 * 🔴 WHY A STRUCTURAL GUARD AND NOT ONLY THE BEHAVIOURAL TESTS. The behavioural
 * suites (`PageBlockHostNoTokenNack.browser.test.tsx`) pin the handlers that exist
 * TODAY. The realistic regression is the THIRTY-SECOND handler, written by copying
 * the thirty-first's opening lines, whose reviewer has no reason to know that
 * `if (!token) return;` is the one shape that must not appear in a message handler
 * — and whose defect is INVISIBLE by construction: nothing errors, nothing logs,
 * the block simply hangs to its SDK timeout class (30s default, 120s workflow,
 * 600s human-in-the-loop). A per-handler test cannot cover a handler nobody has
 * written yet.
 *
 * 🔴 IT WALKS THE TYPESCRIPT AST, AND THAT IS A ROOT-CAUSE FIX RATHER THAN A
 * PREFERENCE. Three earlier revisions of this file hand-rolled the parse, and an
 * adversarial audit found a NEW defect in each one — every finding a parsing bug,
 * none a logic bug:
 *
 *   1. it tested for a response ANYWHERE IN THE ENCLOSING HANDLER, which every
 *      handler's SUCCESS path satisfies with its own `send('<X>_RESULT', …)`;
 *   2. it stripped comments with a REGEX, which ate `cleaned.includes('//')` —
 *      real code inside a string — leaving one `onMessage(` unmatched and a
 *      "handler range" running 71,358 chars to EOF;
 *   3. it fixed that with a character scanner but then sliced the CONTENT out of
 *      the RAW file, so a `// … a nack(…) here would just race the block's own
 *      retry …` comment inside the branch satisfied the response check and a real
 *      silent drop passed. A URL regex (`/^https?:\/\//`) was read as a comment
 *      and blanked the rest of its line; `/['"]/` unbalanced the brackets and
 *      failed CORRECT code.
 *
 * Every one of those is a property of hand-parsing a language, so the fix is to
 * stop: `typescript` is already a dependency, the compiler gives exact nodes, and
 * comments, strings, template literals and regex literals are simply not
 * expressions. The checks below are about AST SHAPE only.
 *
 * Guards OUTSIDE any `onMessage` handler are excluded: the hosts legitimately test
 * `!token` in lifecycle effects (init gating, status escalation), where there is no
 * request to answer.
 *
 * 🔴 WHAT IT DOES NOT CLAIM, STATED WIDER THAN IS COMFORTABLE.
 *   - It checks that a RESPONSE CALL is present and unconditional in the branch,
 *     not that the response is correct, correlated, or accepted by the SDK's
 *     inbound validator. Those are behavioural claims and they live in the browser
 *     suites.
 *   - The population is a test on the identifier `token`. These equally-silent
 *     spellings are NOT in it: `if (token) { …respond… }` with no `else`,
 *     `const t = token; if (!t) return;`, `if (token == null)`, `if (!props.token)`.
 *     A handler written any of those ways passes this file while dropping requests.
 *     Widening the condition match without widening the population walk would be
 *     worse than the gap, so it is named here rather than half-closed.
 */

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
const HOSTS = ['PageBlockHost.tsx', 'IframeHost.tsx'] as const;

function parse(file: string): ts.SourceFile {
  const path = join(REPO_ROOT, 'src', 'components', 'AppBlocks', file);
  return ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TSX
  );
}

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  node.forEachChild((c) => walk(c, visit));
}

type Handler = {
  /** The registered message type, read from the call's string-literal argument. */
  type: string;
  body: ts.Node;
  /** Was the handler an inline function, rather than a reference to one elsewhere? */
  inlineFn: boolean;
};

/**
 * Every `onMessage('<TYPE>', <handler>)` registration.
 *
 * 🔴 THE TYPE COMES FROM THE ARGUMENT NODE, never from "the first UPPER_SNAKE
 * token in the call text". The text spelling was satisfiable by a COMMENT, which
 * let a handler inherit another type's NACK exemption — re-opening the hole this
 * file exists to close, through the one exempt key that has no parity test.
 */
function handlers(sf: ts.SourceFile): Handler[] {
  const out: Handler[] = [];
  walk(sf, (n) => {
    if (!ts.isCallExpression(n)) return;
    const callee = n.expression;
    if (!ts.isIdentifier(callee) || callee.text !== 'onMessage') return;
    const [first, second] = n.arguments;
    if (!first || !ts.isStringLiteralLike(first)) return;
    const inlineFn = !!second && (ts.isArrowFunction(second) || ts.isFunctionExpression(second));
    out.push({
      type: first.text,
      body: inlineFn ? (second as ts.FunctionLikeDeclaration) : n,
      inlineFn,
    });
  });
  return out;
}

/** Does this expression test `!token`? */
function testsNotToken(expr: ts.Expression): boolean {
  let found = false;
  walk(expr, (n) => {
    if (
      ts.isPrefixUnaryExpression(n) &&
      n.operator === ts.SyntaxKind.ExclamationToken &&
      ts.isIdentifier(n.operand) &&
      n.operand.text === 'token'
    ) {
      found = true;
    }
  });
  return found;
}

/**
 * A call that puts something on the wire for the block (or, for an exempt type,
 * records the refusal) — matched on the CALLEE NODE, so an aliased indirection
 * (`const count = () => reportNoToken(…); … count();`) does not qualify. That
 * alias is a real bypass shape and it is lint-clean, so the check is deliberately
 * strict: the call must name the helper directly.
 */
function calleeName(call: ts.CallExpression): string | null {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.name)) return e.name.text;
  return null;
}

const RESPONDERS = new Set(['nack', 'send', 'reply']);

/**
 * Is `call` reached UNCONDITIONALLY from `root`?
 *
 * 🔴 THE POINT OF THE WHOLE `REQUEST_TOKEN` PARITY ASSERTION. Every one of these
 * restores the defect while looking ordinary, and a check that only asks "does the
 * branch mention the call" passes all of them:
 *
 *     if (requestId !== undefined) reportNoToken('REQUEST_TOKEN');
 *     requestId !== undefined && reportNoToken('REQUEST_TOKEN');
 *     requestId === undefined ? undefined : reportNoToken('REQUEST_TOKEN');
 *
 * An earlier revision tried to catch this by COUNTING `if (` occurrences before
 * the call. That was both too weak (it saw neither the `&&` nor the ternary) and
 * too strong (it fired on the payload-shape guard every sibling handler opens
 * with, so making REQUEST_TOKEN consistent with its siblings broke the test). The
 * ancestor walk is the property that was actually meant.
 */
function isUnconditionalWithin(call: ts.Node, root: ts.Node): boolean {
  for (let n = call.parent; n && n !== root; n = n.parent) {
    if (ts.isIfStatement(n) || ts.isConditionalExpression(n) || ts.isSwitchStatement(n))
      return false;
    // 🔴 A CALL INSIDE A NESTED FUNCTION IS NOT EXECUTED BY THIS BRANCH — it is
    // merely mentioned by it. That is what let the alias shape survive:
    //   const count = () => reportNoToken('REQUEST_TOKEN');
    //   if (requestId !== undefined) count();
    // The `if` wraps `count()`, not the arrow, so an ancestor walk from the
    // reportNoToken call finds no conditional at all. Measured: SURVIVED a
    // battery in which every other spelling of the same defect went red.
    if (ts.isFunctionLike(n)) return false;
    if (ts.isBinaryExpression(n)) {
      const k = n.operatorToken.kind;
      if (
        k === ts.SyntaxKind.AmpersandAmpersandToken ||
        k === ts.SyntaxKind.BarBarToken ||
        k === ts.SyntaxKind.QuestionQuestionToken
      ) {
        return false;
      }
    }
  }
  return true;
}

type TokenGuard = {
  handler: Handler;
  stmt: ts.IfStatement;
  consequent: ts.Statement;
  /** Is this guard itself nested inside another conditional in the handler? */
  nested: boolean;
};

/** Every `if (…!token…)` guard inside an `onMessage` handler body. */
function tokenGuards(sf: ts.SourceFile): TokenGuard[] {
  const out: TokenGuard[] = [];
  for (const h of handlers(sf)) {
    if (!h.inlineFn) continue;
    walk(h.body, (n) => {
      if (!ts.isIfStatement(n) || !testsNotToken(n.expression)) return;
      out.push({
        handler: h,
        stmt: n,
        consequent: n.thenStatement,
        nested: !isUnconditionalWithin(n, h.body),
      });
    });
  }
  return out;
}

/** Calls of `name` inside `scope`. */
function callsTo(scope: ts.Node, name: string): ts.CallExpression[] {
  const out: ts.CallExpression[] = [];
  walk(scope, (n) => {
    if (ts.isCallExpression(n) && calleeName(n) === name) out.push(n);
  });
  return out;
}

/**
 * Does this branch actually PUT SOMETHING ON THE WIRE when it runs?
 *
 * 🔴 UNCONDITIONALLY, AND NOT FROM INSIDE A NESTED FUNCTION — the same bar the
 * exempt-count path is held to. "The branch mentions `send(`" is a weaker claim
 * than the test's own name ("ANSWERS in its own branch") and is satisfied by a
 * reply parked in a callback that this branch only registers, which is precisely
 * the silent drop with extra steps.
 */
function responds(g: TokenGuard): boolean {
  let ok = false;
  walk(g.consequent, (n) => {
    if (!ts.isCallExpression(n)) return;
    const name = calleeName(n);
    if (name && RESPONDERS.has(name) && isUnconditionalWithin(n, g.consequent)) ok = true;
  });
  return ok;
}

/**
 * The ONE legal way to answer nothing: count the refusal, for a type whose failure
 * reply the SDK's own validator would drop.
 *
 * 🔴 THE EXEMPT TYPE MUST BE THE HANDLER'S OWN, AND THE CALL MUST BE
 * UNCONDITIONAL. Keyed on the bare string, the hatch was wider than its docstring:
 * any handler could buy silence by passing another type's name — the likeliest
 * route being to copy the REQUEST_TOKEN guard and forget to change the argument,
 * which ALSO mislabels the telemetry.
 */
function countsOnlyForExemptType(g: TokenGuard): boolean {
  if (!Object.prototype.hasOwnProperty.call(BRIDGE_NACK_EXEMPT, g.handler.type)) return false;
  return callsTo(g.consequent, 'reportNoToken').some(
    (c) =>
      c.arguments.length === 1 &&
      ts.isStringLiteralLike(c.arguments[0]) &&
      c.arguments[0].text === g.handler.type &&
      isUnconditionalWithin(c, g.consequent)
  );
}

function answersOrIsExempt(g: TokenGuard): boolean {
  return responds(g) || countsOnlyForExemptType(g);
}

function describeGuard(g: TokenGuard, sf: ts.SourceFile): string {
  const { line } = sf.getLineAndCharacterOfPosition(g.stmt.getStart(sf));
  return `${g.handler.type} (line ${line + 1})`;
}

describe('no host handler drops a credential-less request silently', () => {
  test.each(HOSTS)('%s: the AST walk finds the handlers it is meant to', (file) => {
    // POSITIVE CONTROL. Every assertion below is of the form "none of the found
    // guards is bad", which a walk that found NOTHING satisfies vacuously — the
    // single most likely way this file could read as coverage while providing
    // none. `typescript` also parses `.tsx` only when told to, and a wrong
    // ScriptKind yields a tree with no call expressions rather than an error.
    const sf = parse(file);
    const hs = handlers(sf);
    expect(hs.length).toBeGreaterThan(5);
    expect(hs.map((h) => h.type)).toContain('REQUEST_TOKEN');
    expect(tokenGuards(sf).length).toBeGreaterThan(0);
  });

  test.each(HOSTS)('%s: every handler is registered with an INLINE function', (file) => {
    // A handler hoisted into a `useCallback` and passed by reference puts its
    // `!token` guard outside the registration, where `tokenGuards` cannot see it.
    // Refusing the shape keeps the population complete.
    const byRef = handlers(parse(file))
      .filter((h) => !h.inlineFn)
      .map((h) => h.type);
    expect(byRef).toEqual([]);
  });

  test.each(HOSTS)('%s: every in-handler `!token` guard ANSWERS in its own branch', (file) => {
    const sf = parse(file);
    const silent = tokenGuards(sf)
      .filter((g) => !answersOrIsExempt(g))
      .map((g) => describeGuard(g, sf));
    expect(silent).toEqual([]);
  });

  test.each(HOSTS)('%s: no `!token` guard is nested inside another conditional', (file) => {
    // A guard reached only on some other condition is a guard that does not always
    // run. It is also how the `requestId`-gated count kept coming back.
    const sf = parse(file);
    const nested = tokenGuards(sf)
      .filter((g) => g.nested)
      .map((g) => describeGuard(g, sf));
    expect(nested).toEqual([]);
  });

  test('lifecycle `!token` guards OUTSIDE a handler exist and are deliberately excluded', () => {
    // The exclusion is real, so it is asserted rather than assumed: if this count
    // ever reaches zero, the filter has stopped discriminating and the in-handler
    // assertions above are being applied to the whole file by accident.
    const sf = parse('PageBlockHost.tsx');
    let all = 0;
    walk(sf, (n) => {
      if (ts.isIfStatement(n) && testsNotToken(n.expression)) all++;
    });
    expect(all).toBeGreaterThan(tokenGuards(sf).length);
  });

  test('the PageBlockHost population is the size the behavioural suites believe it is', () => {
    // 🔴 A LEDGER, NOT A TASTE CHECK. It fails when the set GROWS (a new handler
    // nobody has looked at) *and* when it SHRINKS (a handler deleted, or its guard
    // moved somewhere this walk does not reach). Either direction means the
    // behavioural coverage and the code have drifted.
    //
    // 🔴 BUMPING THESE NUMBERS IS NOT THE FIX FOR A RED RUN. The `silent` and
    // `nested` assertions above are the ones that carry meaning; this one exists so
    // a human looks. If those two are red, changing these numbers hides a defect.
    const sf = parse('PageBlockHost.tsx');
    const guards = tokenGuards(sf);
    expect(guards).toHaveLength(31);
    // 19 route through the shared `nack` helper (reply + count in one call); 11
    // keep a bespoke error variant that predates it and call `reportNoToken`
    // alongside it; 1 — REQUEST_TOKEN — counts only, because the protocol has no
    // sendable failure reply for it.
    expect(guards.filter((g) => callsTo(g.consequent, 'nack').length > 0)).toHaveLength(19);
    expect(guards.filter((g) => callsTo(g.consequent, 'reportNoToken').length > 0)).toHaveLength(
      12
    );
    // 🔴 EVERY refusal reaches the counter — the relationship the metric's own help
    // text asserts, and the one a partial migration silently breaks.
    expect(
      guards.filter(
        (g) =>
          callsTo(g.consequent, 'nack').length > 0 ||
          callsTo(g.consequent, 'reportNoToken').length > 0
      )
    ).toHaveLength(31);
  });

  test.each(HOSTS)('%s: counts a credential-less REQUEST_TOKEN UNCONDITIONALLY', (file) => {
    // 🔴 THE TWO HOSTS REGISTER THEIR HANDLERS BY HAND AND SHARE NO BRIDGE, and
    // `PageBlockHost`'s own comment says they "MUST STAY IN STEP" — so the step is
    // asserted rather than described. `REQUEST_TOKEN` is the one type whose failure
    // reply the SDK validator would drop, so the count is its ONLY observable; a
    // host that counts it only when a `requestId` happens to be present reports
    // nothing on the requestId-less shape the protocol explicitly allows.
    const sf = parse(file);
    const guards = tokenGuards(sf).filter((g) => g.handler.type === 'REQUEST_TOKEN');
    expect(guards, `${file} has no REQUEST_TOKEN !token guard`).toHaveLength(1);
    const g = guards[0];
    const reports = callsTo(g.consequent, 'reportNoToken').filter(
      (c) =>
        c.arguments.length === 1 &&
        ts.isStringLiteralLike(c.arguments[0]) &&
        c.arguments[0].text === 'REQUEST_TOKEN'
    );
    expect(reports).toHaveLength(1);
    expect(isUnconditionalWithin(reports[0], g.consequent)).toBe(true);
  });
});
