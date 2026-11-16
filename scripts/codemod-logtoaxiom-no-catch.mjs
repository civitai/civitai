#!/usr/bin/env node
// Codemod: remove a swallowing `.catch(...)` and a statement-level `await` from `logToAxiom(...)`
// calls. Why both are dead code: src/server/services/__tests__/no-logtoaxiom-catch.test.ts.
// A site whose deleted text holds a comment OUTSIDE the handler is kept, and listed as `kept`.
// Usage: node scripts/codemod-logtoaxiom-no-catch.mjs --report|--write [files...]
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
