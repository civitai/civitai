import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { importGraph, REPO_ROOT, rel, resolveSpecifier } from './import-graph.harness';

/**
 * A `vi.mock` factory must not read a static import that is still unbound when the factory runs.
 *
 * Vitest hoists `vi.mock` above the file's imports and keeps the imports in source order, so the
 * factory runs the first time an import loads the mocked module. If that import sits above the one
 * binding a name the factory reads, the name is in its temporal dead zone and the factory throws.
 * Browser mode reports this only as "Unhandled Rejection: [vitest] There was an error when mocking a
 * module", names no file, and kills the whole run.
 *
 * Fix a report by importing the name inside the factory
 * (`const { makeTrpcProxy } = await import('../../../test/trpcProxyStub')`) or by moving it into
 * `vi.hoisted`.
 *
 * Reads only references evaluated while the factory runs: one inside a nested function runs later,
 * unless the function is called where it is written. Known gap: a callback the factory passes to a
 * call that runs it at once (`[].map(() => x)`) is read as deferred, like `vi.fn(() => x)`.
 * Known gap: a mocked module this resolver cannot place in the graph (a node_modules package) is
 * skipped, since whether an earlier import loads it cannot be read here.
 */

type Finding = string;

const isVitest = (spec: string) =>
  spec === 'vitest' || spec.startsWith('vitest/') || spec.startsWith('@vitest/');

type StaticImport = { index: number; line: number; spec: string; names: string[]; value: boolean };

function staticImports(sf: ts.SourceFile): StaticImport[] {
  const out: StaticImport[] = [];
  sf.statements.forEach((st, index) => {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) return;
    const clause = st.importClause;
    const names: string[] = [];
    if (clause && !clause.isTypeOnly) {
      if (clause.name) names.push(clause.name.text);
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) names.push(bindings.name.text);
      if (bindings && ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) if (!el.isTypeOnly) names.push(el.name.text);
      }
    }
    const line = sf.getLineAndCharacterOfPosition(st.getStart(sf)).line + 1;
    // A side-effect import (`import './x'`) loads its module too.
    out.push({
      index,
      line,
      spec: st.moduleSpecifier.text,
      names,
      value: !clause || names.length > 0,
    });
  });
  return out;
}

const isFunctionLike = (n: ts.Node) =>
  ts.isArrowFunction(n) ||
  ts.isFunctionExpression(n) ||
  ts.isFunctionDeclaration(n) ||
  ts.isMethodDeclaration(n) ||
  ts.isGetAccessorDeclaration(n) ||
  ts.isSetAccessorDeclaration(n);

/** Names the factory declares itself, which shadow an import of the same name. */
function declaredIn(factory: ts.ArrowFunction | ts.FunctionExpression): Set<string> {
  const names = new Set<string>();
  const addBinding = (b: ts.BindingName) => {
    if (ts.isIdentifier(b)) names.add(b.text);
    else for (const el of b.elements) if (!ts.isOmittedExpression(el)) addBinding(el.name);
  };
  const walk = (n: ts.Node) => {
    if ((ts.isClassDeclaration(n) || ts.isFunctionDeclaration(n)) && n.name) names.add(n.name.text);
    // A nested function's own names shadow only inside it, and its body is not read.
    if (n !== factory && isFunctionLike(n)) return;
    if (ts.isVariableDeclaration(n) || ts.isParameter(n)) addBinding(n.name);
    ts.forEachChild(n, walk);
  };
  walk(factory);
  return names;
}

/** Whether `fn` is called where it is written, as an IIFE. */
function isCalledNow(fn: ts.Node): boolean {
  let child = fn;
  let p = fn.parent;
  while (ts.isParenthesizedExpression(p)) {
    child = p;
    p = p.parent;
  }
  return ts.isCallExpression(p) && p.expression === child;
}

/** Identifiers the factory reads while it runs, not those inside functions it builds. */
function eagerReads(factory: ts.ArrowFunction | ts.FunctionExpression): Set<string> {
  const names = new Set<string>();
  const own = declaredIn(factory);
  const walk = (n: ts.Node) => {
    // A class's base is read when the class is built, though it parses as a type node.
    if (
      ts.isExpressionWithTypeArguments(n) &&
      ts.isHeritageClause(n.parent) &&
      n.parent.token === ts.SyntaxKind.ExtendsKeyword &&
      ts.isClassLike(n.parent.parent)
    ) {
      walk(n.expression);
      return;
    }
    // A type position reads nothing at run time; a function body runs later unless called here.
    if ((isFunctionLike(n) && !isCalledNow(n)) || ts.isTypeNode(n)) return;
    if (ts.isShorthandPropertyAssignment(n) && !own.has(n.name.text)) names.add(n.name.text);
    if (ts.isIdentifier(n)) {
      const p = n.parent;
      const isKey =
        (ts.isPropertyAccessExpression(p) && p.name === n) ||
        (ts.isPropertyAssignment(p) && p.name === n) ||
        (ts.isBindingElement(p) && p.propertyName === n);
      if (!isKey && !own.has(n.text)) names.add(n.text);
    }
    ts.forEachChild(n, walk);
  };
  ts.forEachChild(factory.body, walk);
  return names;
}

type Mock = { spec: string; factory: ts.ArrowFunction | ts.FunctionExpression | null };

function mocks(sf: ts.SourceFile): Mock[] {
  const out: Mock[] = [];
  const visit = (n: ts.Node) => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      ts.isIdentifier(n.expression.expression) &&
      n.expression.expression.text === 'vi' &&
      n.expression.name.text === 'mock' &&
      n.arguments[0] &&
      ts.isStringLiteral(n.arguments[0])
    ) {
      const fac = n.arguments[1];
      out.push({
        spec: n.arguments[0].text,
        factory: fac && (ts.isArrowFunction(fac) || ts.isFunctionExpression(fac)) ? fac : null,
      });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** Whether loading `from` loads `target`, not walking past modules this file replaces. */
function loads(
  graph: Map<string, string[]>,
  from: string,
  target: string,
  replaced: Set<string>
): boolean {
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length) {
    const file = queue.shift()!;
    if (file === target) return true;
    if (file !== from && replaced.has(file)) continue;
    for (const dep of graph.get(file) ?? []) {
      if (!seen.has(dep)) {
        seen.add(dep);
        queue.push(dep);
      }
    }
  }
  return false;
}

/**
 * The index just past a string, template literal or comment opening at `i`, or `i` itself.
 * Regex literals and template `${}` nesting are not tracked, so a quote inside one desyncs the scan:
 * `mockCallTexts` reparses what it finds, and `mayReadImport` also reads line-leading imports from
 * the raw text, for that reason.
 */
function skipLiteral(source: string, i: number): number {
  const c = source[i];
  if (c === '/' && source[i + 1] === '/') {
    const nl = source.indexOf('\n', i);
    return nl === -1 ? source.length : nl;
  }
  if (c === '/' && source[i + 1] === '*') {
    const close = source.indexOf('*/', i + 2);
    return close === -1 ? source.length : close + 2;
  }
  if (c === "'" || c === '"' || c === '`') {
    let j = i + 1;
    for (; j < source.length && source[j] !== c; j++) if (source[j] === '\\') j++;
    return j + 1;
  }
  return i;
}

/**
 * The bindings text of each `import` statement: from the keyword to the next `;`, with strings and
 * comments dropped, so a module path or a comment cannot match a name. Vitest's own imports are left
 * out: `vi` and friends are bound before any factory runs. A superset is fine; a missed name is not.
 */
function importTexts(source: string): string[] {
  const out: string[] = [];
  // Jumps between quotes, comment openers and the keyword: a per-character walk of every file is
  // most of the scan's time.
  const token = /['"`]|\/[/*]|(?<![\w$.])import(?![\w$])/g;
  for (let m = token.exec(source); m; m = token.exec(source)) {
    if (m[0] !== 'import') {
      token.lastIndex = Math.max(skipLiteral(source, m.index), m.index + 1);
      continue;
    }
    if (/^\s*[(.]/.test(source.slice(m.index + 6, m.index + 40))) continue;
    let text = '';
    let vitest = false;
    let j = m.index;
    while (j < source.length && source[j] !== ';') {
      const next = skipLiteral(source, j);
      if (next === j) {
        text += source[j];
        j++;
      } else {
        const literal = source.slice(j, next);
        if (/^['"](?:vitest(?:\/[^'"]*)?|@vitest\/[^'"]*)['"]$/.test(literal)) vitest = true;
        text += ' ';
        j = next;
      }
    }
    if (!vitest) out.push(text);
    token.lastIndex = j;
  }
  return out;
}

const gap = String.raw`(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*\n)*`;
const mockStart = new RegExp(String.raw`\bvi${gap}(?:\?\.|\.)${gap}mock\b`, 'g');

/**
 * The text of each `vi.mock(...)` call, found by matching brackets past strings, template literals
 * and comments, or null for a generic `vi.mock<…>(` call. A regex literal holding a bracket
 * can end a call early or late; the caller parses the text and falls back on any doubt.
 */
function mockCallTexts(source: string): string[] | null {
  const out: string[] = [];
  for (const match of source.matchAll(mockStart)) {
    let i = match.index + match[0].length;
    while (/\s/.test(source[i] ?? '')) i++;
    // Prose (`vi.mock` in a comment) is followed by a word or punctuation; anything a call could
    // start with but `(` (a generic, a comment, `?.`) sends the file to the whole-file parse.
    if (/[<\/?]/.test(source[i] ?? '')) return null;
    if (source[i] !== '(') continue;
    let depth = 0;
    let end = source.length;
    for (; i < source.length; i++) {
      const c = source[i]!;
      const next = skipLiteral(source, i);
      if (next !== i) {
        i = next - 1;
        continue;
      }
      if (c === '(' || c === '{' || c === '[') depth++;
      else if (c === ')' || c === '}' || c === ']') {
        if (--depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    out.push(source.slice(match.index, end));
  }
  return out;
}

const escapeName = (n: string) => n.replace(/\$/g, '\\$');

/**
 * Whether a factory might read an import: worth parsing the whole file. Parses only the text of each
 * `vi.mock` call, and answers true on any doubt (an odd spelling, or a call text that is not one
 * whole call), so a prefilter mistake costs time, never a finding.
 */
function mayReadImport(source: string): boolean {
  const calls = mockCallTexts(source);
  if (calls === null) return true;
  if (!calls.length) return false;
  const imports = importTexts(source);
  return calls.some((text) => {
    const sf = ts.createSourceFile(
      'call.ts',
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    );
    const diagnostics = (sf as { parseDiagnostics?: unknown[] }).parseDiagnostics ?? [];
    const [statement] = sf.statements;
    const call =
      statement && ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression)
        ? statement.expression
        : null;
    if (diagnostics.length || sf.statements.length !== 1 || !call) return true;
    const factory = call.arguments[1];
    if (!factory || !(ts.isArrowFunction(factory) || ts.isFunctionExpression(factory)))
      return false;
    return [...eagerReads(factory)].some((n) => {
      if (!n) return false;
      const word = new RegExp(String.raw`(^|[^\w$])${escapeName(n)}([^\w$]|$)`, 'u');
      // Also each line-leading import in the raw text, which no literal can desync: a stray quote in
      // a regex literal can swallow an import from the scan above, but not from this.
      const raw = new RegExp(
        String.raw`^[ \t]*import(?![\w$])[^;]*?(?<![\w$])${escapeName(
          n
        )}(?![\w$])[^;]*?\bfrom\s*['"]([^'"]*)['"]`,
        'gmu'
      );
      return (
        imports.some((text) => word.test(text)) ||
        [...source.matchAll(raw)].some((m) => !isVitest(m[1]!))
      );
    });
  });
}

type Analysis = {
  factoriesReadingImports: number;
  /** The earlier imports whose module graph decides a finding. */
  entries: string[];
  judge: (graph: Map<string, string[]>) => Finding[];
};

/** Parses one file; resolves and walks nothing unless a factory reads a static import. */
function analyze(relFile: string, source: string): Analysis {
  const none: Analysis = { factoriesReadingImports: 0, entries: [], judge: () => [] };
  // Cheap text test first: parsing is the scan's cost, and most files cannot match.
  if (!mayReadImport(source)) return none;
  const absFile = path.join(REPO_ROOT, relFile);
  const sf = ts.createSourceFile(relFile, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const imports = staticImports(sf);
  const fileMocks = mocks(sf);

  type Pair = { target: string; imp: StaticImport; name: string };
  const pairs: Pair[] = [];
  let factoriesReadingImports = 0;
  for (const mock of fileMocks) {
    if (!mock.factory) continue;
    const reads = eagerReads(mock.factory);
    const bound = imports.filter(
      (imp) => !isVitest(imp.spec) && imp.names.some((n) => reads.has(n))
    );
    if (bound.length) factoriesReadingImports++;
    if (!bound.length) continue;
    // Resolved only here: probing the disk for every mock in the tree is the scan's cost.
    const target = resolveSpecifier(mock.spec, absFile);
    if (!target) continue;
    for (const imp of bound) {
      pairs.push({
        target: rel(target),
        imp,
        name: imp.names.filter((n) => reads.has(n)).join(', '),
      });
    }
  }
  if (!pairs.length) return { ...none, factoriesReadingImports };

  const resolved = new Map<StaticImport, string | null>();
  const resolve = (imp: StaticImport) => {
    if (!resolved.has(imp)) {
      const r = isVitest(imp.spec) ? null : resolveSpecifier(imp.spec, absFile);
      resolved.set(imp, r ? rel(r) : null);
    }
    return resolved.get(imp)!;
  };
  // The binding import itself counts: the factory fires during its own load.
  const loaders = (imp: StaticImport) =>
    imports.filter((earlier) => earlier.index <= imp.index && earlier.value);
  const entries = new Set<string>();
  for (const { imp } of pairs) {
    for (const earlier of loaders(imp)) {
      const from = resolve(earlier);
      if (from) entries.add(from);
    }
  }

  const judge = (graph: Map<string, string[]>) => {
    const replaced = new Set(
      fileMocks
        .filter((m) => m.factory)
        .map((m) => resolveSpecifier(m.spec, absFile))
        .filter((t): t is string => !!t)
        .map(rel)
    );
    const findings: Finding[] = [];
    for (const { target, imp, name } of pairs) {
      for (const earlier of loaders(imp)) {
        const from = resolve(earlier);
        // A module this file replaces never loads its real imports.
        if (!from || replaced.has(from) || !loads(graph, from, target, replaced)) continue;
        findings.push(
          relFile +
            ': the vi.mock factory for ' +
            target +
            ' reads ' +
            name +
            ' (imported on line ' +
            imp.line +
            "), but the import of '" +
            earlier.spec +
            "' on line " +
            earlier.line +
            ' loads ' +
            target +
            ' first, so ' +
            name +
            ' is still unbound when the factory runs'
        );
        break;
      }
    }
    return findings;
  };
  return { factoriesReadingImports, entries: [...entries], judge };
}

let controlGraph: Map<string, string[]> | undefined;
/** The fixtures below share the control's imports, so they share one graph of them. */
function check(relFile: string, source: string, graph?: Map<string, string[]>): Finding[] {
  controlGraph ??= importGraph(analyze(REPORT_TEST, PRE_FIX).entries, { followDynamic: false });
  return analyze(relFile, source).judge(graph ?? controlGraph);
}

function filesUnder(dir: string, keep: (name: string) => boolean, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') filesUnder(full, keep, out);
    } else if (keep(entry.name)) {
      out.push(rel(full));
    }
  }
  return out;
}

/** Test files, the setup files that mock for every test, and the helpers under test/. */
function scanned(): string[] {
  return [
    ...filesUnder(path.join(REPO_ROOT, 'src'), (n) => /\.test\.tsx?$/.test(n)),
    'src/__tests__/setup.ts',
    ...filesUnder(path.join(REPO_ROOT, 'test'), (n) => /\.tsx?$/.test(n)),
  ];
}

let memo:
  | { graph: Map<string, string[]>; findings: Finding[]; factoriesReadingImports: number }
  | undefined;
/** Built on first use, so a read or parse error fails a named test rather than collection. */
function tree() {
  if (!memo) {
    const analyses = scanned().map((f) =>
      analyze(f, fs.readFileSync(path.join(REPO_ROOT, f), 'utf8'))
    );
    // One graph over the imports that decide a finding, the control's included; one per file is
    // far slower.
    const entries = new Set([...analyses, analyze(REPORT_TEST, PRE_FIX)].flatMap((a) => a.entries));
    const graph = importGraph([...entries], { followDynamic: false });
    memo = {
      graph,
      findings: analyses.flatMap((a) => a.judge(graph)),
      factoriesReadingImports: analyses.reduce((n, a) => n + a.factoriesReadingImports, 0),
    };
  }
  return memo;
}

// Pre-fix ReportProblemButton.browser.test.tsx header (573175a0): the component import on line 5
// loads the mocked ~/utils/trpc before line 8 binds makeTrpcProxy.
const PRE_FIX = [
  "import { Notifications, notifications } from '@mantine/notifications';",
  "import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';",
  "import { page, userEvent } from 'vitest/browser';",
  "import type * as TrpcModule from '~/utils/trpc';",
  "import { ReportProblemButton } from '~/components/Feedback/ReportProblemButton';",
  "import { registerReportProblemButton, showErrorNotification } from '~/utils/notifications';",
  "import { renderWithProviders } from '../../../test/component-setup';",
  "import { makeTrpcProxy } from '../../../test/trpcProxyStub';",
  // Split so the own-module mock ratchet does not count this fixture as a mock of this file.
  'vi' + ".mock('~/utils/trpc', async (importOriginal) => {",
  '  const actual = await importOriginal<typeof TrpcModule>();',
  '  return { ...actual, trpc: makeTrpcProxy({}) };',
  '});',
].join('\n');
// Split so the own-module mock ratchet does not count the fixtures below as mocks of this file.
const V = 'vi';
const REPORT_TEST = 'src/components/Feedback/ReportProblemButton.browser.test.tsx';

describe('vi.mock factories read no import that is still unbound', () => {
  it('reports the factory that killed component shard 1/3 (positive control)', () => {
    const expected = [
      expect.stringContaining("'~/components/Feedback/ReportProblemButton' on line 5"),
    ];
    expect(check(REPORT_TEST, PRE_FIX)).toEqual(expected);
    // The same through the graph the tree scan uses, so a broken shared graph fails here.
    expect(check(REPORT_TEST, PRE_FIX, tree().graph)).toEqual(expected);
  });

  it('passes the same factory once it imports the stub itself', () => {
    const fixed = PRE_FIX.replace(
      "import { makeTrpcProxy } from '../../../test/trpcProxyStub';",
      ''
    ).replace(
      'return { ...actual, trpc: makeTrpcProxy({}) };',
      "const { makeTrpcProxy } = await import('../../../test/trpcProxyStub');\n  return { ...actual, trpc: makeTrpcProxy({}) };"
    );
    expect(fixed).not.toContain("from '../../../test/trpcProxyStub'");
    expect(fixed).toContain("await import('../../../test/trpcProxyStub')");
    expect(check(REPORT_TEST, fixed)).toEqual([]);
  });

  it('ignores a read inside a function the factory builds, which runs later', () => {
    const deferred = PRE_FIX.replace(
      'return { ...actual, trpc: makeTrpcProxy({}) };',
      'return { ...actual, get trpc() { return makeTrpcProxy({}); } };'
    );
    expect(check(REPORT_TEST, deferred)).toEqual([]);
  });

  it('reads a function the factory calls at once, and a class base', () => {
    const iife = PRE_FIX.replace('trpc: makeTrpcProxy({})', 'trpc: (() => makeTrpcProxy({}))()');
    const base = PRE_FIX.replace(
      'return { ...actual, trpc: makeTrpcProxy({}) };',
      'class Trpc extends makeTrpcProxy {}\n  return { ...actual, trpc: Trpc };'
    );
    expect(iife).not.toBe(PRE_FIX);
    expect(base).not.toBe(PRE_FIX);
    expect(check(REPORT_TEST, iife)).toHaveLength(1);
    expect(check(REPORT_TEST, base)).toHaveLength(1);
  });

  it('reports a factory reading a name from the import that loads the mocked module', () => {
    const same = [
      "import { vi } from 'vitest';",
      "import { ReportProblemButton } from '~/components/Feedback/ReportProblemButton';",
      'vi' + ".mock('~/utils/trpc', () => ({ trpc: ReportProblemButton }));",
    ].join('\n');
    expect(check(REPORT_TEST, same)).toHaveLength(1);
  });

  it('does not walk an earlier import this file replaces with a factory', () => {
    const replacedFirst = PRE_FIX.replace(
      "import { renderWithProviders } from '../../../test/component-setup';",
      "import { renderWithProviders } from '../../../test/component-setup';\n" +
        'vi' +
        ".mock('~/components/Feedback/ReportProblemButton', () => ({ ReportProblemButton: null }));"
    );
    expect(replacedFirst).not.toBe(PRE_FIX);
    expect(check(REPORT_TEST, replacedFirst)).toEqual([]);
  });

  // Each is a spelling the prefilter's text checks could miss; the whole-file parse flags every one.
  it.each([
    ['a space before the call', V + ".mock ('./y', () => ({ w: a }));"],
    ['a line break in the call', V + "\n  .mock('./y', () => ({ w: a }));"],
    ['a comment inside the callee', V + " /* c */ . // c\n mock('./y', () => ({ w: a }));"],
    ['a comment before the paren', V + ".mock /* c */ ('./y', () => ({ w: a }));"],
    ['an optional call', V + ".mock?.('./y', () => ({ w: a }));"],
    ['a generic call', V + ".mock<typeof import('./y')>('./y', () => ({ w: a }));"],
    // The regex closes the call's brackets early, so the text read misses `w: a`.
    ['a regex ending the call early', V + ".mock('./y', () => ({ r: /)))/, w: a }));"],
  ])('parses a file with %s', (_, call) => {
    const source = "import { vi } from 'vitest';\nimport { a } from './x';\n" + call;
    expect(mayReadImport(source)).toBe(true);
  });
  it.each([
    ['a comment holding from', "import { z, /* from 'q'; */ a } from './x';", 'a'],
    ['no spaces', "import{a}from'./x';", 'a'],
    ['a comment first', "/* c */ import a from './x';", 'a'],
    ['a binding named type', "import { type } from './x';", 'type'],
    ['a non-ASCII name', "import { é } from './x';", 'é'],
    // A comment first, so only the statement scan (not the line-leading check) can see these two.
    [
      'no semicolons after vitest',
      "import { vi } from 'vitest'\n/* c */ import { a } from './x'",
      'a',
    ],
    ['a vitest-named package', "/* c */ import { a } from 'vitest-browser-react';", 'a'],
    ['a quote in a regex above it', "const r = /'/;\nimport { a } from './x';", 'a'],
  ])('parses a file importing with %s', (_, line, name) => {
    const source =
      "import { vi } from 'vitest';\n" +
      line +
      '\n' +
      V +
      ".mock('./y', () => ({ w: " +
      name +
      ' }));';
    expect(mayReadImport(source)).toBe(true);
  });

  // The other direction, or the prefilter could answer true for everything and only cost time.
  it.each([
    ['reads only a hoisted name', V + ".mock('./y', () => ({ w: mocks.w }));"],
    ['reads only vi', V + ".mock('./y', () => ({ w: vi.fn() }));"],
    ['reads its import only later', V + ".mock('./y', () => ({ w: () => a }));"],
    ['mentions vi.mock in prose', '// ' + V + '.mock is hoisted'],
  ])('skips a file whose factory %s', (_, call) => {
    const source =
      "import { vi } from 'vitest';\nimport { a } from './x';\nconst mocks = vi.hoisted(() => ({ w: 1 }));\n" +
      call;
    expect(mayReadImport(source)).toBe(false);
  });

  // A parser that stopped seeing factories, or a graph with no edges, would pass everything.
  it('reads the factories in the tree, over a graph with edges', () => {
    const { graph, factoriesReadingImports } = tree();
    expect(factoriesReadingImports).toBeGreaterThan(200);
    expect(graph.get('src/components/Feedback/ReportProblemButton.tsx')).toContain(
      'src/utils/trpc.ts'
    );
  });

  it('finds none in src/ or test/', () => {
    expect(tree().findings).toEqual([]);
  });
});
