import fs from 'fs';
import path from 'path';
import ts from 'typescript';

/**
 * Static scan behind `no-new-axiom-field.test.ts`: every field path a production `logToAxiom` call
 * writes to the main dataset. Axiom flattens nested objects, so `{ a: { b: 1 } }` is the field
 * `a.b`; a map field's subtree is one field however many keys it holds, so it is not walked.
 * Anything the scan cannot see into is counted as opaque instead of being skipped.
 */

/** The main dataset's map fields: keys under these never add a field. */
export const MAP_FIELDS: ReadonlySet<string> = new Set([
  'payload',
  'error',
  'cause',
  'input',
  'fields.error',
]);

/** What `safeError(e)` returns (`packages/civitai-axiom/src/client.ts`), for a spread of it. */
const SAFE_ERROR_KEYS = [
  'name',
  'message',
  'stack',
  'code',
  'causeMessage',
  'innerName',
  'innerMessage',
  'innerStack',
];

const MAIN_DATASTREAM = 'civitai-prod';

/** Apps whose `logToAxiom` default is a dataset other than the main one. */
const OTHER_DEFAULT_ROOTS = ['apps/notifications/'];

const ROOTS = ['src', 'apps', 'packages'];
const SKIP_DIRS = new Set(['node_modules', '.next', '.svelte-kit', '.turbo', 'dist', 'build']);
const CODE_FILE = /\.(ts|tsx|js|mjs|cjs)$/;
const TEST_FILE = /(\.test\.|\.spec\.|__tests__|__mocks__|(^|\/)tests\/)/;

export type ScanResult = {
  /** Field path -> the call sites (`file:line`) that write it. */
  paths: Map<string, string[]>;
  /** File -> how many spreads, non-literal arguments or passed-around loggers the scan could not see into. */
  opaque: Map<string, number>;
  /** How many calls to the main dataset were scanned. */
  calls: number;
};

function unwrap(e: ts.Expression): ts.Expression {
  while (
    ts.isAsExpression(e) ||
    ts.isParenthesizedExpression(e) ||
    ts.isSatisfiesExpression(e) ||
    ts.isNonNullExpression(e)
  )
    e = e.expression;
  return e;
}

function keyOf(p: ts.ObjectLiteralElementLike): string | null {
  const n = p.name;
  if (!n) return null;
  if (ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNumericLiteral(n)) return n.text;
  if (ts.isComputedPropertyName(n) && ts.isStringLiteral(n.expression)) return n.expression.text;
  return null;
}

function enclosingFunction(n: ts.Node): ts.SignatureDeclaration | undefined {
  for (let c = n.parent; c; c = c.parent) if (ts.isFunctionLike(c)) return c;
  return undefined;
}

function functionName(fn: ts.SignatureDeclaration): string | undefined {
  if (fn.name && ts.isIdentifier(fn.name)) return fn.name.text;
  const p = fn.parent;
  if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
  return undefined;
}

/**
 * The declaration `name` refers to at `at`, by walking out through enclosing blocks and function
 * parameters, so a same-named variable in another function is not picked up.
 */
function resolveLocal(at: ts.Node, name: string): ts.VariableDeclaration | 'param' | undefined {
  for (let c: ts.Node | undefined = at.parent; c; c = c.parent) {
    if (ts.isFunctionLike(c) && c.parameters.some((p) => p.name.getText() === name)) return 'param';
    if (ts.isBlock(c) || ts.isSourceFile(c) || ts.isModuleBlock(c) || ts.isCaseClause(c)) {
      for (const stmt of c.statements) {
        if (!ts.isVariableStatement(stmt)) continue;
        for (const d of stmt.declarationList.declarations)
          if (ts.isIdentifier(d.name) && d.name.text === name) return d;
      }
    }
  }
  return undefined;
}

/** The innermost block holding a declaration, where later writes to that variable can happen. */
function scopeOf(decl: ts.VariableDeclaration): ts.Node {
  for (let c: ts.Node | undefined = decl.parent; c; c = c.parent)
    if (ts.isBlock(c) || ts.isSourceFile(c) || ts.isModuleBlock(c) || ts.isCaseClause(c)) return c;
  return decl.getSourceFile();
}

/** `x.a.b` rooted at identifier `root` -> `a.b`; anything else -> null. */
function memberPath(e: ts.Expression, root: string): string | null | 'computed' {
  const parts: string[] = [];
  let c = e;
  for (;;) {
    if (ts.isPropertyAccessExpression(c)) {
      parts.unshift(c.name.text);
      c = c.expression;
    } else if (ts.isElementAccessExpression(c)) {
      if (!ts.isStringLiteral(c.argumentExpression)) {
        const inner = unwrap(c.expression);
        return ts.isIdentifier(inner) && inner.text === root ? 'computed' : null;
      }
      parts.unshift(c.argumentExpression.text);
      c = c.expression;
    } else break;
  }
  c = unwrap(c);
  return ts.isIdentifier(c) && c.text === root && parts.length ? parts.join('.') : null;
}

/** Scan one file's source. `file` is repo-relative with forward slashes. */
export function scanSource(file: string, text: string, into?: ScanResult): ScanResult {
  const out = into ?? { paths: new Map(), opaque: new Map(), calls: 0 };
  if (!text.includes('logToAxiom')) return out;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const defaultStream = OTHER_DEFAULT_ROOTS.some((r) => file.startsWith(r))
    ? 'other'
    : MAIN_DATASTREAM;

  const addPath = (p: string, line: number) => {
    if ([...MAP_FIELDS].some((m) => p === m || p.startsWith(`${m}.`))) return;
    const at = `${file}:${line}`;
    const list = out.paths.get(p);
    if (list) list.push(at);
    else out.paths.set(p, [at]);
  };
  const addOpaque = () => out.opaque.set(file, (out.opaque.get(file) ?? 0) + 1);
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const join = (prefix: string, key: string) => (prefix ? `${prefix}.${key}` : key);

  // `import { logToAxiom as log }` makes `log(...)` a call too.
  const logNames = new Set(['logToAxiom']);
  sf.forEachChild((n) => {
    if (!ts.isImportDeclaration(n) || !n.importClause?.namedBindings) return;
    const b = n.importClause.namedBindings;
    if (ts.isNamedImports(b))
      for (const s of b.elements)
        if ((s.propertyName ?? s.name).text === 'logToAxiom') logNames.add(s.name.text);
  });
  const isLogCall = (n: ts.Node): n is ts.CallExpression => {
    if (!ts.isCallExpression(n)) return false;
    const e = unwrap(n.expression);
    if (ts.isIdentifier(e)) return logNames.has(e.text);
    return ts.isPropertyAccessExpression(e) && e.name.text === 'logToAxiom';
  };

  const datastreamOf = (call: ts.CallExpression) => {
    const arg = call.arguments[1];
    if (!arg) return defaultStream;
    const e = unwrap(arg);
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
    if (ts.isIdentifier(e)) {
      const d = resolveLocal(call, e.text);
      const init = d && d !== 'param' && d.initializer && unwrap(d.initializer);
      if (init && ts.isStringLiteral(init)) return init.text;
    }
    // Not statically known: count it as the main dataset, so it is scanned rather than skipped.
    return MAIN_DATASTREAM;
  };

  type OnSpread = (s: ts.SpreadAssignment, prefix: string) => boolean;

  const walkValue = (
    v: ts.Expression,
    full: string,
    line: number,
    onSpread: OnSpread,
    leafDone = { done: false }
  ) => {
    v = unwrap(v);
    if (ts.isObjectLiteralExpression(v)) return walk(v, full, line, onSpread);
    // `cond ? { a } : { b }`, `x && { a }`, `x ?? { a }`: walk every object branch.
    if (ts.isConditionalExpression(v)) {
      walkValue(v.whenTrue, full, line, onSpread, leafDone);
      walkValue(v.whenFalse, full, line, onSpread, leafDone);
      return;
    }
    if (
      ts.isBinaryExpression(v) &&
      [
        ts.SyntaxKind.AmpersandAmpersandToken,
        ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.QuestionQuestionToken,
      ].includes(v.operatorToken.kind)
    ) {
      if (v.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken)
        walkValue(v.left, full, line, onSpread, leafDone);
      walkValue(v.right, full, line, onSpread, leafDone);
      return;
    }
    if (!leafDone.done) {
      leafDone.done = true;
      addPath(full, line);
    }
  };

  // `onSpread` decides what a spread means; returning false marks it opaque.
  const walk = (
    obj: ts.ObjectLiteralExpression,
    prefix: string,
    line: number,
    onSpread: OnSpread
  ): void => {
    for (const prop of obj.properties) {
      if (ts.isSpreadAssignment(prop)) {
        const s = unwrap(prop.expression);
        if (
          ts.isCallExpression(s) &&
          ts.isIdentifier(unwrap(s.expression)) &&
          (unwrap(s.expression) as ts.Identifier).text === 'safeError'
        ) {
          for (const k of SAFE_ERROR_KEYS) addPath(join(prefix, k), line);
        } else if (!onSpread(prop, prefix)) addOpaque();
        continue;
      }
      const key = keyOf(prop);
      if (key === null) {
        addOpaque();
        continue;
      }
      const full = join(prefix, key);
      if (MAP_FIELDS.has(full)) continue;
      if (ts.isPropertyAssignment(prop)) walkValue(prop.initializer, full, line, onSpread);
      else addPath(full, line);
    }
  };

  /** Keys written onto `decl`'s object after it is declared: `x.k = v`, `x['k'] = v`, `Object.assign(x, …)`. */
  const walkLaterWrites = (decl: ts.VariableDeclaration, onSpread: OnSpread) => {
    const name = (decl.name as ts.Identifier).text;
    const visit = (n: ts.Node) => {
      if (
        ts.isBinaryExpression(n) &&
        n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        n.pos > decl.end
      ) {
        const p = memberPath(n.left, name);
        if (p === 'computed') addOpaque();
        else if (p) walkValue(n.right, p, lineOf(n), onSpread);
      }
      if (ts.isCallExpression(n) && n.expression.getText(sf) === 'Object.assign') {
        const [target, ...sources] = n.arguments;
        const t = target && unwrap(target);
        if (t && ts.isIdentifier(t) && t.text === name) {
          for (const s of sources) {
            const u = unwrap(s);
            if (ts.isObjectLiteralExpression(u)) walk(u, '', lineOf(n), onSpread);
            else addOpaque();
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(scopeOf(decl));
  };

  const calls: ts.CallExpression[] = [];
  const collect = (n: ts.Node) => {
    if (isLogCall(n)) calls.push(n);
    else if (ts.isIdentifier(n) && logNames.has(n.text)) checkValueUse(n);
    else if (ts.isPropertyAccessExpression(n) && n.name.text === 'logToAxiom') checkValueUse(n);
    ts.forEachChild(n, collect);
  };
  /**
   * The logger used as a value (`deps.log = logToAxiom`, `{ logToAxiom }`, `run(logToAxiom)`): the
   * calls it ends up making are not visible here, so the use itself is opaque.
   */
  const checkValueUse = (n: ts.Identifier | ts.PropertyAccessExpression) => {
    const p = n.parent;
    if (ts.isCallExpression(p) && unwrap(p.expression) === n) return;
    if (ts.isParenthesizedExpression(p) || ts.isNonNullExpression(p)) return;
    if (ts.isIdentifier(n)) {
      if (ts.isPropertyAccessExpression(p) && p.name === n) return; // handled at the access
      if (ts.isImportSpecifier(p) || ts.isExportSpecifier(p) || ts.isImportClause(p)) return;
      if ((ts.isFunctionDeclaration(p) || ts.isVariableDeclaration(p)) && p.name === n) return;
      if ((ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p)) && p.name === n) return;
      if (ts.isPropertySignature(p) || ts.isTypeQueryNode(p) || ts.isQualifiedName(p)) return;
    }
    addOpaque();
  };
  collect(sf);

  for (const call of calls) {
    if (datastreamOf(call) !== MAIN_DATASTREAM) continue;
    const fn = enclosingFunction(call);
    const name = fn && functionName(fn);
    // Inside a shim's own `logToAxiom`, a spread of its parameter is the caller's data, and every
    // caller is scanned as a call of its own; only keys the shim adds are new here.
    const forwarding = name !== undefined && logNames.has(name);
    const params = new Set(fn ? fn.parameters.map((p) => p.name.getText(sf)) : []);
    out.calls++;
    const first = call.arguments[0];
    if (!first) continue;
    let arg = unwrap(first);
    if (forwarding && ts.isIdentifier(arg) && params.has(arg.text)) continue;
    let declared: ts.VariableDeclaration | undefined;
    if (ts.isIdentifier(arg)) {
      const d = resolveLocal(call, arg.text);
      const init = d && d !== 'param' && d.initializer && unwrap(d.initializer);
      if (d && d !== 'param' && init && ts.isObjectLiteralExpression(init)) {
        arg = init;
        declared = d;
      }
    }
    if (!ts.isObjectLiteralExpression(arg)) {
      addOpaque();
      continue;
    }
    // A wrapper (`const log = (data) => logToAxiom({ name: 'x', ...data })`): the spread parameter's
    // keys come from the wrapper's callers in this file, so walk their object-literal arguments.
    const onWrapperSpread: OnSpread = (spread, prefix) => {
      const target = unwrap(spread.expression);
      if (!fn || !ts.isIdentifier(target)) return false;
      const index = fn.parameters.findIndex(
        (p) => ts.isIdentifier(p.name) && p.name.text === target.text
      );
      if (index === -1) return false;
      if (forwarding) return true;
      if (!name) return false;
      let resolved = false;
      const visit = (n: ts.Node) => {
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name) {
          const a = n.arguments[index] && unwrap(n.arguments[index]);
          if (a && ts.isObjectLiteralExpression(a)) {
            resolved = true;
            walk(a, prefix, lineOf(n), () => false);
          } else if (a) addOpaque();
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
      return resolved;
    };
    walk(arg, '', lineOf(call), onWrapperSpread);
    if (declared) walkLaterWrites(declared, onWrapperSpread);
  }
  return out;
}

function walkFiles(root: string, dir: string, acc: string[]) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(root, full, acc);
    else if (CODE_FILE.test(entry.name))
      acc.push(path.relative(root, full).split(path.sep).join('/'));
  }
}

/** Scan the repo's production code. */
export function scanRepo(root: string): ScanResult {
  const files: string[] = [];
  for (const r of ROOTS) walkFiles(root, path.join(root, r), files);
  const out: ScanResult = { paths: new Map(), opaque: new Map(), calls: 0 };
  for (const file of files.sort()) {
    if (TEST_FILE.test(file)) continue;
    scanSource(file, fs.readFileSync(path.join(root, file), 'utf8'), out);
  }
  return out;
}
