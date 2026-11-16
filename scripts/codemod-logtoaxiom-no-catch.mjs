#!/usr/bin/env node
// Codemod: strip the dead `.catch(...)` (and a pointless statement-level `await`) from
// `logToAxiom(...)` calls.
//
// WHY: see src/server/services/__tests__/no-logtoaxiom-catch.test.ts, the ratchet that keeps it gone.
//
// WHAT IT CHANGES — an AST transform over the TypeScript compiler's syntax tree, never a regex:
//   1. `X.catch(h)` where X (parentheses skipped) is DIRECTLY a call to `logToAxiom(...)` or
//      `<anything>.logToAxiom(...)`, and `h` only swallows: no argument, `undefined`/`null`/
//      `void 0`/a literal, `noop`, or a function whose body is empty, comment-only, or one of
//      those values. The `.catch(h)` is removed; the call is kept byte for byte.
//   2. `await logToAxiom(...);` as a whole expression statement (its value is discarded) in a
//      non-test file: the `await` is removed. Its value is discarded either way and the call
//      never rejects, so the only thing the await bought was a microtask yield (and, with the
//      AXIOM_AWAIT_UPLOADS=true off-switch, a bounded wait for the Axiom outcome).
// WHAT IT LEAVES (and reports with --report):
//   - a `.catch` on any other promise (`foo().then(...).catch`, `Promise.all([...]).catch`);
//   - a handler that does anything else (logs, rethrows, calls a function): listed as `kept`;
//   - a strip whose deleted text holds a comment OUTSIDE the handler (between the call's `)` and
//     `.catch`, say), which may be about more than the swallow: listed as `kept`. A comment
//     inside a swallowing handler only explains the swallow and is removed with it;
//   - an `await` whose value is used (`const x = await logToAxiom(...)`, `return await ...`),
//     or any `await` in a test file (a test may await to sequence its assertions);
//   - any file under an EXCLUDED path (see FROZEN below).
//
// USAGE (from the repo root, with the workspace's node_modules installed):
//   node scripts/codemod-logtoaxiom-no-catch.mjs --report     # dry run, JSON site list on stdout
//   node scripts/codemod-logtoaxiom-no-catch.mjs --write      # rewrite files in place
// Optional trailing path arguments restrict the run to those files.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ts = require('typescript');

// Paths this codemod must not edit: owned by another team and frozen for automated changes.
// The ratchet's baseline holds whatever residual sites live here.
// Read broadly on purpose: the generator (anything under an `orchestrator` directory or named
// for generation/the generator, plus `orchestrator.router.ts`), the base-model constants, and the
// event-engine-common submodule.
export const FROZEN = [
  /^event-engine-common\//,
  /(^|\/)orchestrator\//,
  /(^|\/)orchestrator\.router\.ts$/,
  /generat(ion|or)/i,
  /(^|\/)src\/shared\/constants\/[^/]*base-?model/i,
];

const SOURCE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
export const isTestPath = (p) =>
  /(^|\/)(__tests__|__mocks__|test|tests|e2e)\//.test(p) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(p);

const unparen = (n) => {
  while (n && ts.isParenthesizedExpression(n)) n = n.expression;
  return n;
};

/** `logToAxiom(...)` or `<expr>.logToAxiom(...)` (optional chaining included). */
export function isLogToAxiomCall(n) {
  n = unparen(n);
  if (!n || !ts.isCallExpression(n)) return false;
  const callee = n.expression;
  if (ts.isIdentifier(callee)) return callee.text === 'logToAxiom';
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text === 'logToAxiom';
  return false;
}

const isSwallowValue = (e) => {
  e = unparen(e);
  if (!e) return true;
  if (ts.isIdentifier(e)) return e.text === 'undefined';
  if (e.kind === ts.SyntaxKind.NullKeyword) return true;
  if (e.kind === ts.SyntaxKind.TrueKeyword || e.kind === ts.SyntaxKind.FalseKeyword) return true;
  if (ts.isNumericLiteral(e) || ts.isStringLiteral(e)) return true;
  if (ts.isVoidExpression(e)) return ts.isNumericLiteral(unparen(e.expression));
  return false;
};

/** A handler that only swallows: returns nothing, or a constant, with no side effect. */
export function isSwallowHandler(h) {
  if (h === undefined) return true;
  h = unparen(h);
  if (ts.isIdentifier(h)) return h.text === 'noop' || h.text === 'undefined';
  if (ts.isArrowFunction(h) || ts.isFunctionExpression(h)) {
    const body = h.body;
    if (ts.isBlock(body)) {
      if (body.statements.length === 0) return true;
      if (body.statements.length === 1) {
        const s = body.statements[0];
        if (ts.isReturnStatement(s)) return isSwallowValue(s.expression);
        if (ts.isExpressionStatement(s)) return isSwallowValue(s.expression);
      }
      return false;
    }
    return isSwallowValue(body);
  }
  return isSwallowValue(h);
}

const hasComment = (text) => /\/\/|\/\*/.test(text);

const isCatchOnLogToAxiom = (node) =>
  ts.isCallExpression(node) &&
  ts.isPropertyAccessExpression(node.expression) &&
  node.expression.name.text === 'catch' &&
  isLogToAxiomCall(node.expression.expression);

/**
 * Decide one `logToAxiom(...).catch(h)` site. A comment INSIDE a swallowing handler only
 * explains the swallow and goes with it; a comment anywhere else in the deleted text (between
 * the call's `)` and `.catch`, or before the handler) is something else, so that site is kept.
 */
function decideCatch(text, node) {
  const inner = node.expression.expression;
  const handler = node.arguments[0];
  if (node.arguments.length > 1 || !isSwallowHandler(handler)) {
    return { action: 'kept', reason: 'handler does more than swallow' };
  }
  const outside = handler
    ? text.slice(inner.getEnd(), handler.getStart()) + text.slice(handler.getEnd(), node.getEnd())
    : text.slice(inner.getEnd(), node.getEnd());
  if (hasComment(outside)) return { action: 'kept', reason: 'a comment sits outside the handler' };
  return { action: 'strip', edit: { start: inner.getEnd(), end: node.getEnd(), text: '' } };
}

/** Analyse one file. Returns { edits: [{start,end,text}], sites: [...] }. */
export function analyse(fileName, text) {
  const kind = /\.tsx$|\.jsx$/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const test = isTestPath(fileName);
  const edits = [];
  const sites = [];
  const line = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;

  const visit = (node) => {
    // 1. `.catch` directly on a logToAxiom call.
    if (isCatchOnLogToAxiom(node)) {
      const handler = node.arguments[0];
      const decision = decideCatch(text, node);
      const site = {
        file: fileName,
        line: line(node.getStart()),
        kind: 'catch',
        handler: handler ? handler.getText(sf).replace(/\s+/g, ' ').slice(0, 160) : '',
        action: decision.action,
      };
      if (decision.reason) site.reason = decision.reason;
      if (decision.edit) edits.push(decision.edit);
      sites.push(site);
    }

    // 2. `await logToAxiom(...);` (after a strip) as a whole expression statement.
    if (ts.isAwaitExpression(node)) {
      let target = unparen(node.expression);
      // Look through a `.catch` this run strips, so `await logToAxiom(x).catch(() => {});` loses
      // both. (Decided here, not read back from `edits`: the await is visited before its child.)
      if (isCatchOnLogToAxiom(target) && decideCatch(text, target).action === 'strip') {
        target = unparen(target.expression.expression);
      }
      if (isLogToAxiomCall(target)) {
        const site = { file: fileName, line: line(node.getStart()), kind: 'await' };
        const between = text.slice(node.getStart(), node.expression.getStart());
        if (test) {
          site.action = 'kept';
          site.reason = 'test file';
        } else if (!ts.isExpressionStatement(node.parent)) {
          site.action = 'kept';
          site.reason = `value used (${ts.SyntaxKind[node.parent.kind]})`;
        } else if (!/^await\s+$/.test(between)) {
          site.action = 'kept';
          site.reason = 'a comment sits between await and the call';
        } else {
          site.action = 'strip';
          edits.push({ start: node.getStart(), end: node.expression.getStart(), text: '' });
        }
        sites.push(site);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { edits, sites };
}

export function applyEdits(text, edits) {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let out = text;
  for (const e of sorted) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

function main() {
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const report = args.includes('--report');
  if (write === report) {
    console.error('usage: codemod-logtoaxiom-no-catch.mjs (--report | --write) [files...]');
    process.exit(2);
  }
  const explicit = args.filter((a) => !a.startsWith('--'));
  const files = (
    explicit.length
      ? explicit
      : execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 1 << 28 })
          .split('\0')
          .filter(Boolean)
  ).filter((p) => SOURCE_EXT.test(p) && !p.includes('node_modules/') && !p.endsWith('.d.ts'));

  const all = [];
  let changed = 0;
  for (const p of files) {
    let text;
    try {
      text = readFileSync(p, 'utf8');
    } catch {
      continue;
    }
    if (!text.includes('logToAxiom')) continue;
    const frozen = FROZEN.some((re) => re.test(p));
    const { edits, sites } = analyse(p, text);
    for (const s of sites) {
      if (frozen) {
        s.action = 'frozen';
        delete s.reason;
      }
      all.push(s);
    }
    if (write && !frozen && edits.length) {
      writeFileSync(p, applyEdits(text, edits));
      changed++;
    }
  }
  if (report) process.stdout.write(JSON.stringify(all, null, 1) + '\n');
  const tally = {};
  for (const s of all) tally[`${s.kind}:${s.action}`] = (tally[`${s.kind}:${s.action}`] ?? 0) + 1;
  console.error(JSON.stringify({ files: files.length, changed, tally }));
}

if (path.resolve(process.argv[1] ?? '') === path.resolve(new URL(import.meta.url).pathname)) main();
