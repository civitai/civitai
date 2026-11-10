import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { classifyAppSubmitFailure } from '~/shared/constants/app-telemetry.constants';

/**
 * Every refusal the blocks router RETURNS as a failed snapshot must classify to a real reason on
 * `civitai_app_block_submit_failures_total` / `App_Error`, never `other`.
 *
 * The strings are read from the router SOURCE, not re-spelled here: every object literal with
 * `status: 'failed'` is found by AST, and the literal text of its `error` (each branch of a
 * ternary, the leading literal of a `+` chain, the head of a template, and the return expression
 * of a same-file helper it calls) is classified. A new cap message added without a matching
 * classifier arm, or an existing one reworded, turns this red.
 */

const ROUTER = path.resolve(__dirname, '../blocks.router.ts');
const source = ts.createSourceFile(
  ROUTER,
  readFileSync(ROUTER, 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS
);

const localFunctions = new Map<string, ts.FunctionDeclaration>();
source.forEachChild((node) => {
  if (ts.isFunctionDeclaration(node) && node.name) localFunctions.set(node.name.text, node);
});

function unwrap(expr: ts.Expression): ts.Expression {
  let e = expr;
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e)) {
    e = e.expression;
  }
  return e;
}

/** The literal texts an expression can evaluate to (leading literal for concatenations). */
function literalTexts(expr: ts.Expression, seen = new Set<string>()): string[] {
  const e = unwrap(expr);
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return [e.text];
  if (ts.isTemplateExpression(e)) return [e.head.text];
  if (ts.isConditionalExpression(e)) {
    return [...literalTexts(e.whenTrue, seen), ...literalTexts(e.whenFalse, seen)];
  }
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return literalTexts(e.left, seen);
  }
  if (ts.isCallExpression(e) && ts.isIdentifier(e.expression)) {
    const fn = localFunctions.get(e.expression.text);
    if (!fn?.body || seen.has(fn.name!.text)) return [];
    seen.add(fn.name!.text);
    const out: string[] = [];
    fn.body.forEachChild(function visit(n) {
      if (ts.isReturnStatement(n) && n.expression) out.push(...literalTexts(n.expression, seen));
      else if (!ts.isFunctionLike(n)) n.forEachChild(visit);
    });
    return out;
  }
  return [];
}

function isFailedStatus(init: ts.Expression): boolean {
  const e = unwrap(init);
  return ts.isStringLiteral(e) && e.text === 'failed';
}

const refusals: { line: number; text: string }[] = [];
let failedSnapshotsWithError = 0;
source.forEachChild(function visit(node) {
  if (ts.isObjectLiteralExpression(node)) {
    const props = node.properties.filter(ts.isPropertyAssignment);
    const status = props.find((p) => p.name.getText(source) === 'status');
    const error = props.find((p) => p.name.getText(source) === 'error');
    if (status && error && isFailedStatus(status.initializer)) {
      failedSnapshotsWithError += 1;
      const line = source.getLineAndCharacterOfPosition(error.getStart(source)).line + 1;
      for (const text of literalTexts(error.initializer)) refusals.push({ line, text });
    }
  }
  node.forEachChild(visit);
});

describe('blocks router failed-snapshot refusals are classified', () => {
  it('found the router refusals (positive control: the scan is not empty)', () => {
    expect(failedSnapshotsWithError).toBeGreaterThanOrEqual(10);
    const texts = refusals.map((r) => r.text);
    expect(texts.some((t) => t.startsWith('daily Buzz cap reached'))).toBe(true);
    expect(texts.some((t) => t.startsWith('app Buzz limit reached'))).toBe(true);
    expect(texts.some((t) => t.startsWith('generation temporarily unavailable'))).toBe(true);
    // Negative control for the classifier assertion below: a refusal spelling it does not know
    // must come out `other`, or "no unclassified refusals" would be vacuous.
    expect(classifyAppSubmitFailure({ message: 'some brand new refusal' })).toBe('other');
  });

  it('every literal refusal classifies to a reason other than `other`', () => {
    const unclassified = refusals.filter(
      (r) => classifyAppSubmitFailure({ message: r.text }) === 'other'
    );
    expect(unclassified).toEqual([]);
  });

  it('the spend caps are insufficient_buzz and the unavailability is server_error', () => {
    const reasonOf = (prefix: string) => [
      ...new Set(
        refusals
          .filter((r) => r.text.startsWith(prefix))
          .map((r) => classifyAppSubmitFailure({ message: r.text }))
      ),
    ];
    for (const prefix of [
      'daily Buzz cap reached',
      'private-run Buzz cap reached',
      'review run-for-real Buzz cap reached',
      'app Buzz limit reached',
      'app daily spend cap reached',
      'dev tunnel session Buzz cap reached',
      'insufficient buzz budget',
    ]) {
      expect(reasonOf(prefix), prefix).toEqual(['insufficient_buzz']);
    }
    expect(reasonOf('generation temporarily unavailable')).toEqual(['server_error']);
    expect(reasonOf('app generation rate limit reached')).toEqual(['rate_limited']);
  });
});
