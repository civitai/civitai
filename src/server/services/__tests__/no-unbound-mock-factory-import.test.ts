import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { importGraph, REPO_ROOT, rel, resolveSpecifier } from './import-graph.harness';

/**
 * A \`vi.mock\` factory must not read a static import that is still unbound when the factory runs.
 *
 * Vitest hoists \`vi.mock\` above the file's imports and keeps the imports in source order, so the
 * factory runs the first time an import loads the mocked module. If that import sits above the one
 * binding a name the factory reads, the name is in its temporal dead zone and the factory throws.
 * Browser mode reports this only as "Unhandled Rejection: [vitest] There was an error when mocking a
 * module", names no file, and kills the whole run (it took down component shard 1/3 on main).
 *
 * Fix a report by importing the name inside the factory
 * (\`const { makeTrpcProxy } = await import('../../../test/trpcProxyStub')\`) or by moving it into
 * \`vi.hoisted\`.
 *
 * Reads only references evaluated while the factory runs: one inside a nested function runs later.
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
    // A side-effect import (\`import './x'\`) loads its module too.
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
    if (ts.isVariableDeclaration(n) || ts.isParameter(n)) addBinding(n.name);
    if ((ts.isClassDeclaration(n) || ts.isFunctionDeclaration(n)) && n.name) names.add(n.name.text);
    ts.forEachChild(n, walk);
  };
  walk(factory);
  return names;
}

/** Identifiers the factory reads while it runs, not those inside functions it builds. */
function eagerReads(factory: ts.ArrowFunction | ts.FunctionExpression): Set<string> {
  const names = new Set<string>();
  const own = declaredIn(factory);
  const walk = (n: ts.Node) => {
    // A type position reads nothing at run time.
    if (isFunctionLike(n) || ts.isTypeNode(n)) return;
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

type Mock = { target: string; factory: ts.ArrowFunction | ts.FunctionExpression | null };

function mocks(sf: ts.SourceFile, absFile: string): Mock[] {
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
      const target = resolveSpecifier(n.arguments[0].text, absFile);
      const fac = n.arguments[1];
      if (target) {
        out.push({
          target: rel(target),
          factory: fac && (ts.isArrowFunction(fac) || ts.isFunctionExpression(fac)) ? fac : null,
        });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** Whether loading \`from\` loads \`target\`, not walking past modules this file replaces. */
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

type Checked = { findings: Finding[]; factoriesReadingImports: number };

function check(relFile: string, source: string, graph?: Map<string, string[]>): Checked {
  const absFile = path.join(REPO_ROOT, relFile);
  const sf = ts.createSourceFile(relFile, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const imports = staticImports(sf);
  const fileMocks = mocks(sf, absFile);
  const replaced = new Set(fileMocks.filter((m) => m.factory).map((m) => m.target));
  const resolved = new Map(
    imports.map((imp) => {
      const r = isVitest(imp.spec) ? null : resolveSpecifier(imp.spec, absFile);
      return [imp, r ? rel(r) : null] as const;
    })
  );
  const g =
    graph ??
    importGraph(
      [...resolved.values()].filter((x): x is string => !!x),
      { followDynamic: false }
    );

  const findings: Finding[] = [];
  let factoriesReadingImports = 0;
  for (const mock of fileMocks) {
    if (!mock.factory) continue;
    const reads = eagerReads(mock.factory);
    const bound = imports.filter(
      (imp) => !isVitest(imp.spec) && imp.names.some((n) => reads.has(n))
    );
    if (bound.length) factoriesReadingImports++;
    for (const imp of bound) {
      for (const earlier of imports) {
        if (earlier.index >= imp.index || !earlier.value) continue;
        const from = resolved.get(earlier);
        if (!from || !loads(g, from, mock.target, replaced)) continue;
        const name = imp.names.filter((n) => reads.has(n)).join(', ');
        findings.push(
          relFile +
            ': the vi.mock factory for ' +
            mock.target +
            ' reads ' +
            name +
            ' (imported on line ' +
            imp.line +
            "), but the import of '" +
            earlier.spec +
            "' on line " +
            earlier.line +
            ' loads ' +
            mock.target +
            ' first, so ' +
            name +
            ' is still unbound when the factory runs'
        );
        break;
      }
    }
  }
  return { findings, factoriesReadingImports };
}

function testFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') testFiles(full, out);
    } else if (/\.test\.tsx?$/.test(entry.name)) {
      out.push(rel(full));
    }
  }
  return out;
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
const REPORT_TEST = 'src/components/Feedback/ReportProblemButton.browser.test.tsx';

describe('vi.mock factories read no import that is still unbound', () => {
  it('reports the factory that killed component shard 1/3 (positive control)', () => {
    const { findings } = check(REPORT_TEST, PRE_FIX);
    expect(findings).toEqual([
      expect.stringContaining("'~/components/Feedback/ReportProblemButton' on line 5"),
    ]);
  });

  it('passes the same factory once it imports the stub itself', () => {
    const fixed = PRE_FIX.replace(
      "import { makeTrpcProxy } from '../../../test/trpcProxyStub';",
      ''
    ).replace(
      'return { ...actual, trpc: makeTrpcProxy({}) };',
      "const { makeTrpcProxy } = await import('../../../test/trpcProxyStub');\n  return { ...actual, trpc: makeTrpcProxy({}) };"
    );
    expect(check(REPORT_TEST, fixed).findings).toEqual([]);
  });

  it('ignores a read inside a function the factory builds, which runs later', () => {
    const deferred = PRE_FIX.replace(
      'return { ...actual, trpc: makeTrpcProxy({}) };',
      'return { ...actual, get trpc() { return makeTrpcProxy({}); } };'
    );
    expect(check(REPORT_TEST, deferred).findings).toEqual([]);
  });

  const files = [
    ...testFiles(path.join(REPO_ROOT, 'src')),
    ...testFiles(path.join(REPO_ROOT, 'test')),
  ];
  const sources = new Map(files.map((f) => [f, fs.readFileSync(path.join(REPO_ROOT, f), 'utf8')]));
  // One graph for every file: built per file, the walk costs minutes.
  const graph = importGraph(files, { followDynamic: false });
  const results = files.map((f) => check(f, sources.get(f)!, graph));

  // A parser or resolver that stopped working would read no factory and pass everything.
  it('reads the factories in the tree', () => {
    expect(results.reduce((n, r) => n + r.factoriesReadingImports, 0)).toBeGreaterThan(150);
  });

  it('finds none in src/ or test/', () => {
    expect(results.flatMap((r) => r.findings)).toEqual([]);
  });
});
