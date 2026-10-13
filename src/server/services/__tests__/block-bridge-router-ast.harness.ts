import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { expect } from 'vitest';

/**
 * An AST reading of `blocks.router.ts`, shared by the guards that derive the bridge procedure
 * population from it. A comment is trivia and a string is a literal, so neither can be read as
 * a call.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
export const ROUTER = 'src/server/routers/blocks.router.ts';
/** The guard whose population is derived from `.input(...)` shapes rather than reachability. */
const SIBLING = 'src/server/services/__tests__/no-unguarded-block-bridge-token.test.ts';

/** The function every bridge procedure must reach. Its call sites are ledgered in `SIBLING`. */
export const GUARD = 'authorizeBlockBridgeToken';

/** Every procedure name declared on the `blocksRouter` object literal, with its initializer node. */
export function routerProcedures(source: ts.SourceFile): Map<string, ts.Node> {
  const procs = new Map<string, ts.Node>();
  let found: ts.ObjectLiteralExpression | null = null;

  const findRouter = (node: ts.Node): void => {
    if (
      found == null &&
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'blocksRouter' &&
      node.initializer != null &&
      ts.isCallExpression(node.initializer) &&
      node.initializer.arguments.length > 0 &&
      ts.isObjectLiteralExpression(node.initializer.arguments[0])
    ) {
      found = node.initializer.arguments[0] as ts.ObjectLiteralExpression;
      return;
    }
    ts.forEachChild(node, findRouter);
  };
  findRouter(source);

  // 🔴 A THROW, NOT A SILENT EMPTY MAP. An unparseable router is the one outcome that would make
  // every assertion built on this vacuously true, so it has to be a different result from "no
  // procedures matched".
  if (found == null)
    throw new Error(`could not locate the blocksRouter object literal in ${ROUTER}`);

  for (const prop of (found as ts.ObjectLiteralExpression).properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const name = ts.isIdentifier(prop.name)
      ? prop.name.text
      : ts.isStringLiteral(prop.name)
      ? prop.name.text
      : null;
    if (name == null) continue;
    procs.set(name, prop.initializer);
  }
  return procs;
}

/**
 * The set of function names CALLED anywhere under `node`.
 *
 * Reads `CallExpression` nodes off the AST, so a comment or a string literal naming a function can
 * never enter this set — the whole class `no-unguarded-block-bridge-token.test.ts` spends 400
 * lines of normalisation defending against. Both access forms are covered: `f(...)` and
 * `obj.f(...)`.
 */
function callees(node: ts.Node): Set<string> {
  const names = new Set<string>();
  const walk = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const target = n.expression;
      if (ts.isIdentifier(target)) names.add(target.text);
      else if (ts.isPropertyAccessExpression(target) && ts.isIdentifier(target.name)) {
        names.add(target.name.text);
      }
    }
    ts.forEachChild(n, walk);
  };
  walk(node);
  return names;
}

/** Module-scope function declarations in the router, by name — the router-local helper layer. */
export function routerHelpers(source: ts.SourceFile): Map<string, ts.Node> {
  const helpers = new Map<string, ts.Node>();
  for (const stmt of source.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name != null) {
      helpers.set(stmt.name.text, stmt);
      continue;
    }
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (
          ts.isIdentifier(decl.name) &&
          decl.initializer != null &&
          (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))
        ) {
          helpers.set(decl.name.text, decl.initializer);
        }
      }
    }
  }
  return helpers;
}

/**
 * Everything a procedure reaches: its own callees, plus the callees of every router-local helper
 * it calls, transitively. Bounded by the helper set, so it terminates on a cycle.
 */
export function reachable(start: ts.Node, helpers: Map<string, ts.Node>): Set<string> {
  const seen = new Set<string>(callees(start));
  const queue = [...seen];
  const expanded = new Set<string>();
  while (queue.length > 0) {
    const name = queue.shift() as string;
    if (expanded.has(name)) continue;
    expanded.add(name);
    const helper = helpers.get(name);
    if (helper == null) continue;
    for (const inner of callees(helper)) {
      if (!seen.has(inner)) {
        seen.add(inner);
        queue.push(inner);
      }
    }
  }
  return seen;
}

export function read(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

export function parse(text: string, rel = ROUTER): ts.SourceFile {
  return ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/** The sibling's `BRIDGE_INPUT_LEDGER`, read out of its source — the input-shape derivation. */
export function siblingInputLedger(): string[] {
  const text = read(SIBLING);
  const marker = 'const BRIDGE_INPUT_LEDGER = [';
  const start = text.indexOf(marker);
  expect(
    start,
    `${SIBLING} no longer declares BRIDGE_INPUT_LEDGER — this cross-check is blind`
  ).toBeGreaterThan(-1);
  // 🔴 BOUND THE END TO THE FIRST COLUMN-ZERO `]`, NOT TO THE NEXT `].sort()`. Searching for
  // `].sort()` walks PAST this ledger when the sibling stops spelling it that way and lands on
  // some later array hundreds of lines on — the slice then spans unrelated code and the regex
  // below harvests ~90 "names". The carefully-worded failure message never fires, and whoever
  // hits it is told the sibling ledger has 90 entries and goes looking in the wrong file. It
  // still fails closed either way; the point is that it failed closed while REPORTING SOMETHING
  // FALSE, which is worse than a blunt error.
  const end = text.indexOf('\n]', start);
  expect(end, `${SIBLING}'s BRIDGE_INPUT_LEDGER is not a closed array literal`).toBeGreaterThan(
    start
  );
  const body = text.slice(start + marker.length, end);
  // Entry lines only: `  'name',`. A comment line inside the array cannot match, because the
  // pattern requires the quote to open the line's first non-space character.
  const names = [...body.matchAll(/^\s*'([A-Za-z0-9_]+)',/gm)].map((m) => m[1]).sort();
  // A MAGNITUDE CONTROL on the harvest itself, so a slice that ran away is reported as a broken
  // parse rather than compared as a population.
  expect(
    names.length,
    `harvested ${names.length} names from ${SIBLING}'s BRIDGE_INPUT_LEDGER — that is not a ledger, it is a runaway slice`
  ).toBeLessThan(40);
  expect(names.length).toBeGreaterThan(5);
  return names;
}

/** The router-local tRPC middleware that authorizes a viewer-bound bridge procedure. */
export const VIEWER_MIDDLEWARE = 'authorizeBlockBridgeViewer';

export type BridgeProcAuth = {
  /** `.use(authorizeBlockBridgeViewer(…))` calls in the procedure's builder chain. */
  middlewareUses: number;
  /** Reaches the guard from its own body or a router-local helper other than the middleware. */
  inline: boolean;
  /** Every middleware use has an `.input(…)` earlier in the chain. */
  inputPrecedesUse: boolean;
  /** `blockToken` identifiers outside the `.input(…)` argument. */
  blockTokenReads: number;
};

/** Parentheses, `as`, `satisfies` and `!` wrap an expression without changing what it calls. */
function unwrap(node: ts.Expression): ts.Expression {
  let inner = node;
  while (
    ts.isParenthesizedExpression(inner) ||
    ts.isAsExpression(inner) ||
    ts.isSatisfiesExpression(inner) ||
    ts.isNonNullExpression(inner)
  ) {
    inner = inner.expression;
  }
  return inner;
}

/** The method a call invokes, in either access form: `x.use(…)` or `x['use'](…)`. */
function methodName(call: ts.CallExpression): string | null {
  const target = unwrap(call.expression);
  if (ts.isPropertyAccessExpression(target)) return target.name.text;
  if (ts.isElementAccessExpression(target) && ts.isStringLiteralLike(target.argumentExpression)) {
    return target.argumentExpression.text;
  }
  return null;
}

/** The object a method call is made on: `x` in `x.use(…)`. */
function receiver(call: ts.CallExpression): ts.Expression | null {
  const target = unwrap(call.expression);
  return ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)
    ? unwrap(target.expression)
    : null;
}

/** A `.use(…)` whose argument is a call to the middleware factory, type arguments or not. */
function isMiddlewareUse(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node) || methodName(node) !== 'use') return false;
  return node.arguments.some((arg) => {
    const inner = unwrap(arg);
    if (!ts.isCallExpression(inner)) return false;
    const callee = unwrap(inner.expression);
    return ts.isIdentifier(callee) && callee.text === VIEWER_MIDDLEWARE;
  });
}

function hasInputEarlierInChain(use: ts.CallExpression): boolean {
  for (let link = receiver(use); link != null && ts.isCallExpression(link); link = receiver(link)) {
    if (methodName(link) === 'input') return true;
  }
  return false;
}

function countBlockTokenReads(node: ts.Node): number {
  let count = 0;
  const walk = (n: ts.Node, inInputArg: boolean): void => {
    if (ts.isIdentifier(n) && n.text === 'blockToken' && !inInputArg) count++;
    if (ts.isCallExpression(n) && methodName(n) === 'input') {
      walk(n.expression, inInputArg);
      for (const arg of n.arguments) walk(arg, true);
      return;
    }
    ts.forEachChild(n, (child) => walk(child, inInputArg));
  };
  walk(node, false);
  return count;
}

/**
 * How each `blocksRouter` procedure reaches the guard. A procedure that reaches it by neither
 * route is absent, so compare the keys against a population derived some other way.
 */
export function bridgeProcAuth(text: string): Map<string, BridgeProcAuth> {
  const source = parse(text);
  const helpers = routerHelpers(source);
  if (!helpers.has(VIEWER_MIDDLEWARE)) {
    throw new Error(`${ROUTER} no longer declares ${VIEWER_MIDDLEWARE} at module scope`);
  }
  const inlineHelpers = new Map(helpers);
  inlineHelpers.delete(VIEWER_MIDDLEWARE);

  const out = new Map<string, BridgeProcAuth>();
  for (const [name, node] of routerProcedures(source)) {
    const uses: ts.CallExpression[] = [];
    const collect = (n: ts.Node): void => {
      if (isMiddlewareUse(n)) uses.push(n);
      ts.forEachChild(n, collect);
    };
    collect(node);
    const inline = reachable(node, inlineHelpers).has(GUARD);
    if (uses.length === 0 && !inline) continue;
    out.set(name, {
      middlewareUses: uses.length,
      inline,
      inputPrecedesUse: uses.every(hasInputEarlierInChain),
      blockTokenReads: countBlockTokenReads(node),
    });
  }
  return out;
}

/** How many times the middleware's own body calls the guard. */
export function guardCallsInMiddleware(text: string): number {
  const middleware = routerHelpers(parse(text)).get(VIEWER_MIDDLEWARE);
  if (middleware == null) return 0;
  let count = 0;
  const walk = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const callee = unwrap(n.expression);
      if (ts.isIdentifier(callee) && callee.text === GUARD) count++;
    }
    ts.forEachChild(n, walk);
  };
  walk(middleware);
  return count;
}
