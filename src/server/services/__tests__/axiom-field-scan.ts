import fs from 'fs';
import path from 'path';
import ts from 'typescript';

/**
 * Static scan behind `no-new-axiom-field.test.ts`: every field path a production `logToAxiom` call
 * writes to the main dataset. Axiom flattens nested objects, so `{ a: { b: 1 } }` is the field
 * `a.b`; a map field's subtree is one field however many keys it holds, so it is not walked.
 */

/** The main dataset's map fields: keys under these never add a field. */
export const MAP_FIELDS: ReadonlySet<string> = new Set([
  'payload',
  'error',
  'cause',
  'input',
  'fields.error',
]);

const MAIN_DATASTREAM = 'civitai-prod';

/** Files that forward a caller's datastream (the package and the per-app shims): not call sites. */
const FORWARDING_FILES: ReadonlySet<string> = new Set([
  'packages/civitai-axiom/src/client.ts',
  'apps/auth/src/lib/server/axiom.ts',
  'apps/knights/src/lib/server/axiom.ts',
  'apps/moderator/src/lib/server/axiom.ts',
  'apps/notifications/src/lib/server/clients/axiom.ts',
]);

/** Apps whose `logToAxiom` default is a dataset other than the main one. */
const OTHER_DEFAULT_ROOTS = ['apps/notifications/'];

const ROOTS = ['src', 'apps', 'packages'];
const SKIP_DIRS = new Set(['node_modules', '.next', '.svelte-kit', '.turbo', 'dist', 'build']);
const CODE_FILE = /\.(ts|tsx|js|mjs|cjs)$/;
const TEST_FILE = /(\.test\.|\.spec\.|__tests__|__mocks__|(^|\/)tests\/)/;

export type ScanResult = {
  /** Field path -> the call sites (`file:line`) that write it. */
  paths: Map<string, string[]>;
  /** File -> how many object spreads or non-literal arguments the scan could not see into. */
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

function isLogCall(n: ts.Node): n is ts.CallExpression {
  if (!ts.isCallExpression(n)) return false;
  const e = n.expression;
  if (ts.isIdentifier(e)) return e.text === 'logToAxiom';
  return ts.isPropertyAccessExpression(e) && e.name.text === 'logToAxiom';
}

function constInitializer(sf: ts.SourceFile, name: string): ts.Expression | undefined {
  let found: ts.Expression | undefined;
  const visit = (n: ts.Node) => {
    if (!found && ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name)
      found = n.initializer;
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

function datastreamOf(sf: ts.SourceFile, call: ts.CallExpression, defaultStream: string) {
  const arg = call.arguments[1];
  if (!arg) return defaultStream;
  const e = unwrap(arg);
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
  if (ts.isIdentifier(e)) {
    const init = constInitializer(sf, e.text);
    if (init && ts.isStringLiteral(unwrap(init))) return (unwrap(init) as ts.StringLiteral).text;
  }
  // Not statically known: count it as the main dataset, so it is scanned rather than skipped.
  return MAIN_DATASTREAM;
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

/** Scan one file's source. `file` is repo-relative with forward slashes. */
export function scanSource(file: string, text: string, into?: ScanResult): ScanResult {
  const out = into ?? { paths: new Map(), opaque: new Map(), calls: 0 };
  if (FORWARDING_FILES.has(file) || !text.includes('logToAxiom')) return out;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const defaultStream = OTHER_DEFAULT_ROOTS.some((r) => file.startsWith(r))
    ? 'other'
    : MAIN_DATASTREAM;

  const addPath = (p: string, line: number) => {
    const at = `${file}:${line}`;
    const list = out.paths.get(p);
    if (list) list.push(at);
    else out.paths.set(p, [at]);
  };
  const addOpaque = () => out.opaque.set(file, (out.opaque.get(file) ?? 0) + 1);
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

  // `onSpread` decides what a spread means; returning false marks it opaque.
  const walk = (
    obj: ts.ObjectLiteralExpression,
    prefix: string,
    line: number,
    onSpread: (s: ts.SpreadAssignment, prefix: string) => boolean
  ) => {
    for (const prop of obj.properties) {
      if (ts.isSpreadAssignment(prop)) {
        if (!onSpread(prop, prefix)) addOpaque();
        continue;
      }
      const key = keyOf(prop);
      if (key === null) {
        addOpaque();
        continue;
      }
      const full = prefix ? `${prefix}.${key}` : key;
      if (MAP_FIELDS.has(full)) continue;
      const value = ts.isPropertyAssignment(prop) ? unwrap(prop.initializer) : undefined;
      if (value && ts.isObjectLiteralExpression(value)) walk(value, full, line, onSpread);
      else addPath(full, line);
    }
  };

  const calls: ts.CallExpression[] = [];
  const collect = (n: ts.Node) => {
    if (isLogCall(n)) calls.push(n);
    ts.forEachChild(n, collect);
  };
  collect(sf);

  for (const call of calls) {
    if (datastreamOf(sf, call, defaultStream) !== MAIN_DATASTREAM) continue;
    out.calls++;
    const first = call.arguments[0];
    if (!first) continue;
    let arg = unwrap(first);
    if (ts.isIdentifier(arg)) {
      const init = constInitializer(sf, arg.text);
      if (init && ts.isObjectLiteralExpression(unwrap(init))) arg = unwrap(init);
    }
    if (!ts.isObjectLiteralExpression(arg)) {
      addOpaque();
      continue;
    }
    const fn = enclosingFunction(call);
    const name = fn && functionName(fn);
    // A wrapper (`const log = (data) => logToAxiom({ name: 'x', ...data })`): the spread parameter's
    // keys come from the wrapper's callers in this file, so walk their object-literal arguments.
    const onWrapperSpread = (spread: ts.SpreadAssignment, prefix: string): boolean => {
      const target = unwrap(spread.expression);
      if (!fn || !name || !ts.isIdentifier(target)) return false;
      const index = fn.parameters.findIndex(
        (p) => ts.isIdentifier(p.name) && p.name.text === target.text
      );
      if (index === -1) return false;
      let resolved = false;
      const visit = (n: ts.Node) => {
        if (
          ts.isCallExpression(n) &&
          ((ts.isIdentifier(n.expression) && n.expression.text === name) ||
            (ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === name))
        ) {
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
