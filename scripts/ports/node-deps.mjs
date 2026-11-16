// The Node half of a port's dependencies: the repo source files the endpoint's handler transitively
// imports at runtime, computed in CI by scripts/ports/touched.mjs (not stored). Parse-only
// (ts.createSourceFile); nothing is type-checked. Imports resolve against the files git tracks, so
// an untracked or ignored file on disk (a local build output, a stray copy) never enters the graph.
//
// The entry file is walked from the entry SYMBOL, not the whole file: a router module imports every
// procedure's handler, so only the imports the symbol (and the top-level declarations it reaches)
// names are followed out of it. Every file after that is followed whole. Type-only imports are
// skipped: they cannot change what the endpoint does at runtime.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const TRAVERSED = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const CANDIDATE_SUFFIXES = [
  '',
  '.ts',
  '.tsx',
  '.mts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '/index.ts',
  '/index.tsx',
  '/index.js',
  '/index.mjs',
];

const toPosix = (p) => p.split(path.sep).join('/');

/** tsconfig `compilerOptions.paths` of `<root>/tsconfig.json`, as `{ pattern, targets }[]`. */
export function loadPathAliases(root) {
  const file = path.join(root, 'tsconfig.json');
  if (!existsSync(file)) return [];
  const { config, error } = ts.readConfigFile(file, ts.sys.readFile);
  if (error)
    throw new Error(`tsconfig.json: ${ts.flattenDiagnosticMessageText(error.messageText)}`);
  const opts = config.compilerOptions ?? {};
  const base = opts.baseUrl ?? '.';
  return Object.entries(opts.paths ?? {}).map(([pattern, targets]) => ({
    pattern,
    targets: targets.map((t) => toPosix(path.join(base, t))),
  }));
}

/** The repo-relative files git tracks under `root` (index, not disk). */
export function trackedFiles(root) {
  const out = execFileSync('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 256 << 20,
  });
  return new Set(out.split('\0').filter(Boolean));
}

function probe(tracked, relBase) {
  for (const suffix of CANDIDATE_SUFFIXES) {
    const rel = toPosix(path.normalize(relBase + suffix));
    if (tracked.has(rel)) return rel;
  }
  // ESM-style `./x.js` written for a `./x.ts` source.
  const m = /^(.*)\.(m?js|cjs|jsx)$/.exec(relBase);
  if (m) {
    for (const ext of ['.ts', '.tsx', '.mts', '.cts']) {
      const rel = toPosix(path.normalize(m[1] + ext));
      if (tracked.has(rel)) return rel;
    }
  }
  return null;
}

/** Submodule paths from `<root>/.gitmodules`. */
export function loadSubmodules(root) {
  const file = path.join(root, '.gitmodules');
  if (!existsSync(file)) return [];
  return [...readFileSync(file, 'utf8').matchAll(/^\s*path\s*=\s*(.+?)\s*$/gm)].map((m) => m[1]);
}

/**
 * Resolve an import specifier written in `fromRel` (repo-relative), against `tracked` (the set of
 * repo-relative files git tracks).
 * Returns `{ kind: 'file', path }`, `{ kind: 'submodule', path }` (the submodule's root: its
 * files are not this repo's, and a checkout may not have them, so its pin is the dependency),
 * `{ kind: 'external' }` (a package, not followed) or `{ kind: 'unresolved' }` (relative or
 * aliased, and no file matches: the graph would be wrong).
 * Siblings: src/server/services/__tests__/import-graph.harness.ts and scripts/test-perf/graph.mjs
 * (resolveSpecifier). This one differs by resolving against git-tracked files only and reading no
 * package `exports` maps; mirror a resolution fix across all three where it applies.
 */
export function resolveSpecifier(tracked, fromRel, spec, aliases, submodules = []) {
  const inSubmodule = (rel) => submodules.find((s) => rel === s || rel.startsWith(`${s}/`));
  if (spec.startsWith('.') || spec.startsWith('/')) {
    const relBase = spec.startsWith('/')
      ? spec.slice(1)
      : toPosix(path.join(path.dirname(fromRel), spec));
    const sub = inSubmodule(toPosix(path.normalize(relBase)));
    if (sub) return { kind: 'submodule', path: sub };
    const hit = probe(tracked, relBase);
    return hit ? { kind: 'file', path: hit } : { kind: 'unresolved' };
  }
  for (const { pattern, targets } of aliases) {
    const star = pattern.indexOf('*');
    let rest;
    if (star === -1) {
      if (spec !== pattern) continue;
      rest = '';
    } else {
      const pre = pattern.slice(0, star);
      const post = pattern.slice(star + 1);
      if (!spec.startsWith(pre) || !spec.endsWith(post) || spec.length < pre.length + post.length)
        continue;
      rest = spec.slice(pre.length, spec.length - post.length);
    }
    for (const t of targets) {
      const target = toPosix(path.normalize(t.replace('*', rest)));
      const sub = inSubmodule(target);
      if (sub) return { kind: 'submodule', path: sub };
      const hit = probe(tracked, target);
      if (hit) return { kind: 'file', path: hit };
    }
    return { kind: 'unresolved' };
  }
  return { kind: 'external' };
}

function parse(root, rel) {
  const text = readFileSync(path.join(root, rel), 'utf8');
  const kind = rel.endsWith('x') ? ts.ScriptKind.TSX : undefined;
  return ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, kind);
}

const stringArg = (call) => {
  const a = call.arguments[0];
  return a && (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) ? a.text : null;
};

/** Module specifiers a file needs at runtime (type-only imports and re-exports excluded). */
export function runtimeImports(sf) {
  const out = [];
  const visit = (node) => {
    if (ts.isImportDeclaration(node)) {
      const c = node.importClause;
      const typeOnly =
        c &&
        (c.isTypeOnly ||
          (!c.name &&
            c.namedBindings &&
            ts.isNamedImports(c.namedBindings) &&
            c.namedBindings.elements.length > 0 &&
            c.namedBindings.elements.every((e) => e.isTypeOnly)));
      if (!typeOnly) out.push(node.moduleSpecifier.text);
      return;
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const typeOnly =
        node.isTypeOnly ||
        (node.exportClause &&
          ts.isNamedExports(node.exportClause) &&
          node.exportClause.elements.length > 0 &&
          node.exportClause.elements.every((e) => e.isTypeOnly));
      if (!typeOnly) out.push(node.moduleSpecifier.text);
      return;
    }
    if (
      ts.isImportEqualsDeclaration(node) &&
      !node.isTypeOnly &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      out.push(node.moduleReference.expression.text);
      return;
    }
    if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if (isDynamicImport || isRequire) {
        const s = stringArg(node);
        if (s !== null) out.push(s);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

const hasModifier = (node, kind) => (ts.getModifiers?.(node) ?? []).some((m) => m.kind === kind);

function bindingNames(name, out = []) {
  if (ts.isIdentifier(name)) out.push(name.text);
  else for (const el of name.elements) if (!ts.isOmittedExpression(el)) bindingNames(el.name, out);
  return out;
}

/** name -> top-level declaration node, for the value declarations an entry can reach. */
function topLevelDeclarations(sf) {
  const decls = new Map();
  for (const st of sf.statements) {
    if (
      (ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isEnumDeclaration(st)) &&
      st.name
    )
      decls.set(st.name.text, st);
    else if (ts.isVariableStatement(st))
      for (const d of st.declarationList.declarations)
        for (const n of bindingNames(d.name)) decls.set(n, d);
  }
  return decls;
}

/** local name -> { spec, typeOnly } for every import binding in the file. */
function importBindings(sf) {
  const map = new Map();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !st.importClause) continue;
    const c = st.importClause;
    const spec = st.moduleSpecifier.text;
    if (c.name) map.set(c.name.text, { spec, typeOnly: c.isTypeOnly });
    if (c.namedBindings && ts.isNamespaceImport(c.namedBindings))
      map.set(c.namedBindings.name.text, { spec, typeOnly: c.isTypeOnly });
    else if (c.namedBindings)
      for (const e of c.namedBindings.elements)
        map.set(e.name.text, { spec, typeOnly: c.isTypeOnly || e.isTypeOnly });
  }
  return map;
}

function propertyNamed(obj, name) {
  return obj.properties.find(
    (p) =>
      (ts.isPropertyAssignment(p) ||
        ts.isShorthandPropertyAssignment(p) ||
        ts.isMethodDeclaration(p)) &&
      p.name &&
      (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) &&
      p.name.text === name
  );
}

function objectLiteralOf(expr) {
  let e = expr;
  while (
    e &&
    (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression?.(e))
  )
    e = e.expression;
  if (!e) return null;
  if (ts.isObjectLiteralExpression(e)) return e;
  // `router({ ... })`, `t.router({ ... })`
  if (ts.isCallExpression(e) && e.arguments[0] && ts.isObjectLiteralExpression(e.arguments[0]))
    return e.arguments[0];
  return null;
}

/**
 * An overloaded function is several declarations (signatures, then the implementation, the one
 * with a body). The marker goes above the first, where a reader meets the function; its code is
 * the implementation's.
 */
function overloadGroup(decls) {
  return { markerNode: decls[0], bodyNode: decls.find((d) => d.body) ?? decls[0] };
}

/**
 * Locate an entry symbol. `default` is the default export; `a.b.c` is property `b` (then `c`) of
 * the object literal top-level `a` is initialised with (directly, or as the first argument of a
 * call such as `router({...})`); a bare name is that top-level declaration.
 * Returns `{ markerNode, bodyNode }`: where a marker goes, and what the symbol's code is.
 */
export function findEntryNode(sf, symbol) {
  if (symbol === 'default') {
    const fns = [];
    for (const st of sf.statements) {
      if (ts.isExportAssignment(st) && !st.isExportEquals) return { markerNode: st, bodyNode: st };
      if (
        (ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) &&
        hasModifier(st, ts.SyntaxKind.ExportKeyword) &&
        hasModifier(st, ts.SyntaxKind.DefaultKeyword)
      ) {
        if (ts.isClassDeclaration(st)) return { markerNode: st, bodyNode: st };
        fns.push(st);
      }
    }
    return fns.length ? overloadGroup(fns) : null;
  }
  const [head, ...rest] = symbol.split('.');
  const fns = sf.statements.filter((st) => ts.isFunctionDeclaration(st) && st.name?.text === head);
  if (fns.length) return rest.length ? null : overloadGroup(fns);
  let found = null;
  for (const st of sf.statements) {
    if (ts.isClassDeclaration(st) && st.name?.text === head) found = { stmt: st, init: null };
    else if (ts.isVariableStatement(st))
      for (const d of st.declarationList.declarations)
        if (ts.isIdentifier(d.name) && d.name.text === head)
          found = { stmt: st, init: d.initializer };
    if (found) break;
  }
  if (!found) return null;
  if (rest.length === 0) return { markerNode: found.stmt, bodyNode: found.stmt };
  let expr = found.init;
  let prop = null;
  for (const name of rest) {
    const obj = objectLiteralOf(expr);
    if (!obj) return null;
    prop = propertyNamed(obj, name);
    if (!prop) return null;
    expr = ts.isPropertyAssignment(prop) ? prop.initializer : null;
  }
  return { markerNode: prop, bodyNode: prop };
}

/** Specifiers the entry symbol reaches: its own imports plus those of the top-level declarations it names. */
function entrySpecifiers(sf, bodyNode) {
  const imports = importBindings(sf);
  const decls = topLevelDeclarations(sf);
  const specs = new Set();
  const seen = new Set();
  const visit = (node) => {
    if (ts.isIdentifier(node)) {
      const name = node.text;
      const imp = imports.get(name);
      if (imp && !imp.typeOnly) specs.add(imp.spec);
      const decl = decls.get(name);
      if (decl && !seen.has(decl)) {
        seen.add(decl);
        visit(decl);
      }
    }
    ts.forEachChild(node, visit);
  };
  seen.add(bodyNode);
  visit(bodyNode);
  for (const decl of seen) for (const s of runtimeImportsWithin(decl)) specs.add(s);
  return [...specs];
}

function runtimeImportsWithin(node) {
  const out = [];
  const visit = (n) => {
    if (ts.isCallExpression(n)) {
      const isDynamicImport = n.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(n.expression) && n.expression.text === 'require';
      if (isDynamicImport || isRequire) {
        const s = stringArg(n);
        if (s !== null) out.push(s);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

/**
 * Repo-relative files the entry reaches at runtime, sorted, the entry file included.
 * Throws on a missing entry symbol or on a relative/aliased import that resolves to no tracked file.
 * `aliases`, `submodules` and `tracked` default to what `root` holds; pass them to share the work
 * across several entries in one tree.
 */
export function computeNodeDeps(
  root,
  entry,
  {
    aliases = loadPathAliases(root),
    submodules = loadSubmodules(root),
    tracked = trackedFiles(root),
  } = {}
) {
  const entrySf = parse(root, entry.file);
  const found = findEntryNode(entrySf, entry.symbol);
  if (!found) throw new Error(`${entry.file}: symbol \`${entry.symbol}\` not found`);

  const deps = new Set([entry.file]);
  const unresolved = [];
  const queue = [];
  const enqueue = (fromRel, spec) => {
    const r = resolveSpecifier(tracked, fromRel, spec, aliases, submodules);
    if (r.kind === 'unresolved') unresolved.push(`${fromRel}: '${spec}'`);
    if (r.kind === 'submodule') deps.add(r.path);
    if (r.kind !== 'file' || r.path.includes('node_modules/') || deps.has(r.path)) return;
    deps.add(r.path);
    if (TRAVERSED.test(r.path) && !r.path.endsWith('.d.ts')) queue.push(r.path);
  };
  for (const spec of entrySpecifiers(entrySf, found.bodyNode)) enqueue(entry.file, spec);
  while (queue.length) {
    const rel = queue.shift();
    for (const spec of runtimeImports(parse(root, rel))) enqueue(rel, spec);
  }
  if (unresolved.length)
    throw new Error(
      `unresolved imports reached from ${entry.file}#${entry.symbol}:\n  ${unresolved.join('\n  ')}`
    );
  return [...deps].sort();
}
