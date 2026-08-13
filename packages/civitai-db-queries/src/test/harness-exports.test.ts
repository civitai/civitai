import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as publicSubpath from './compile-harness';
import * as internal from './harness';

/**
 * What the package's public `./test-harness` subpath is allowed to expose, and what it is allowed
 * to IMPORT.
 *
 * `explainHarness` and `testDbUrl` resolve a connection string and fall back to
 * `process.env.DATABASE_URL` — a real environment's WRITER in any checkout that has one. The
 * Kysely/Prisma parity suite deliberately refuses that fallback (it demands
 * `KYSELY_PARITY_DATABASE_URL`, because it writes fixtures), and that refusal is only a real
 * property if nothing else the suite imports can reach `DATABASE_URL` either. So the subpath
 * exports the offline compile-only harness and nothing else.
 *
 * "And nothing else" is two separate claims, and this file asserts both, because an export ledger
 * on its own does not imply the second:
 *
 *   1. the EXPORT NAMES of the public module, and the package's whole `exports` map;
 *   2. the IMPORT GRAPH reachable from the public module — an exact ledger of first-party files
 *      plus third-party packages, and a scan of every first-party file in it for pool/connection
 *      string tokens. Without (2), adding `process.env.DATABASE_URL` to the body of
 *      `compileHarness` changes no export name and no subpath, so (1) alone stays green.
 *
 * The walk is a SUPERSET of what runs: it follows `import type` too, which TypeScript erases. That
 * is deliberate — telling an erased import from a live one needs a real TS parse, and the coarser
 * walk is the stricter guarantee. It is not a claim about third-party code: `kysely` is ledgered by
 * name (so `pg` cannot slip into the graph) but its own sources are not scanned.
 */
const PUBLIC_SUBPATH_EXPORTS = ['compileHarness'];

// The helpers that must stay package-internal, asserted below to actually EXIST. Without this the
// exclusion above is unfalsifiable: a test that lists what is absent passes just as well when the
// excluded names were never real.
const MUST_STAY_INTERNAL = ['explainHarness', 'testDbUrl'];

const here = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = resolve(here, '../..');
const REPO_ROOT = resolve(PACKAGE_DIR, '../..');
const rel = (absolute: string) => relative(REPO_ROOT, absolute).replace(/\\/g, '/');

const COMPILE_HARNESS = resolve(here, 'compile-harness.ts');
const DB_BACKED_HARNESS = resolve(here, 'harness.ts');

const packageJson = JSON.parse(readFileSync(resolve(PACKAGE_DIR, 'package.json'), 'utf-8')) as {
  exports: Record<string, string>;
};

// The package's whole `exports` map, not one entry of it. The previous version of this file
// asserted `exports['./test-harness']` alone, which left the obvious hole open: adding a SECOND
// subpath aimed at `./src/test/harness.ts` re-exposed `explainHarness` and `testDbUrl` across the
// package boundary and every assertion still passed. Against the whole map that mutant now fails
// here, and again in the reachability test at the bottom, which reads the map off disk.
const PACKAGE_EXPORTS = {
  '.': './src/index.ts',
  './model': './src/model.db.ts',
  './tag': './src/tag.db.ts',
  './test-harness': './src/test/compile-harness.ts',
};

// Every first-party file reachable from `./src/test/compile-harness.ts`, repo-root-relative.
const PUBLIC_GRAPH_FILES = [
  'packages/civitai-db-queries/src/infra/updated-at-plugin.ts',
  'packages/civitai-db-queries/src/test/compile-harness.ts',
  'packages/civitai-db-schema/src/kysely/enums.ts',
  'packages/civitai-db-schema/src/kysely/types.ts',
  'packages/civitai-db-schema/src/kysely/updated-at-tables.ts',
];

// ...and every third-party package it reaches. `pg` being absent here is the point: the offline
// harness compiles SQL with kysely's PostgresQueryCompiler and executes it against DummyDriver, so
// no driver is involved.
const PUBLIC_GRAPH_PACKAGES = ['kysely'];

/**
 * Source with comments blanked out, string and template literals kept.
 *
 * Necessary in both directions. The token scan below would otherwise fire on the docblocks that
 * DESCRIBE the hazard — this file and `compile-harness.ts` both spell `DATABASE_URL` in prose — and
 * the specifier scan would otherwise follow a commented-out import.
 */
function stripComments(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const char = source[i];
    const next = source[i + 1];
    if (char === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (char === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      out += char;
      i++;
      while (i < source.length) {
        if (source[i] === '\\') {
          out += source[i] + (source[i + 1] ?? '');
          i += 2;
          continue;
        }
        out += source[i];
        const closed = source[i] === char;
        i++;
        if (closed) break;
      }
      continue;
    }
    out += char;
    i++;
  }
  return out;
}

// Module specifiers of one file. The `from` forms are anchored at the start of a line and may not
// cross a `;` or `=`, so a `from "Table"` inside a multi-line `sql` template is not mistaken for an
// import. Under-collection cannot pass silently: the graph is asserted as an EXACT ledger, so a
// missed edge shrinks the set and fails.
function moduleSpecifiers(source: string): string[] {
  const code = stripComments(source);
  const found: string[] = [];
  const patterns = [
    /^(?:import|export)\s[^;=]*?\bfrom\s*['"]([^'"]+)['"]/gm,
    /^import\s*['"]([^'"]+)['"]/gm,
    /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) for (const match of code.matchAll(pattern)) found.push(match[1]);
  return [...new Set(found)];
}

type Resolved = { kind: 'first-party'; file: string } | { kind: 'third-party'; pkg: string };

/**
 * Resolve one specifier. THROWS on anything it cannot resolve rather than skipping it — an edge
 * quietly dropped is an unwalked subtree, which is how this kind of guard becomes vacuous.
 */
function resolveSpecifier(fromFile: string, specifier: string): Resolved {
  if (specifier.startsWith('.')) {
    const base = resolve(dirname(fromFile), specifier);
    for (const candidate of [base, `${base}.ts`, `${base}/index.ts`])
      if (existsSync(candidate) && statSync(candidate).isFile())
        return { kind: 'first-party', file: candidate };
    throw new Error(`cannot resolve "${specifier}" from ${rel(fromFile)}`);
  }
  if (specifier.startsWith('@civitai/')) {
    const [, name, ...subpath] = specifier.split('/');
    const packageDir = resolve(REPO_ROOT, 'packages', `civitai-${name}`);
    const manifest = resolve(packageDir, 'package.json');
    if (!existsSync(manifest))
      throw new Error(`cannot resolve "${specifier}" from ${rel(fromFile)}: no ${rel(manifest)}`);
    const map = (
      JSON.parse(readFileSync(manifest, 'utf-8')) as { exports?: Record<string, string> }
    ).exports;
    const key = subpath.length ? `./${subpath.join('/')}` : '.';
    const target = map?.[key];
    if (typeof target !== 'string')
      throw new Error(
        `cannot resolve "${specifier}" from ${rel(
          fromFile
        )}: @civitai/${name} has no "${key}" export`
      );
    return { kind: 'first-party', file: resolve(packageDir, target) };
  }
  const pkg = specifier.startsWith('@')
    ? specifier.split('/').slice(0, 2).join('/')
    : specifier.split('/')[0];
  return { kind: 'third-party', pkg };
}

function importGraph(entry: string): { files: string[]; packages: string[] } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop() as string;
    if (files.has(file)) continue;
    files.add(file);
    for (const specifier of moduleSpecifiers(readFileSync(file, 'utf-8'))) {
      const resolved = resolveSpecifier(file, specifier);
      if (resolved.kind === 'third-party') packages.add(resolved.pkg);
      else if (!files.has(resolved.file)) queue.push(resolved.file);
    }
  }
  return { files: [...files].map(rel).sort(), packages: [...packages].sort() };
}

// Tokens that mean a module can name a database or hold a socket. `pg` itself is caught by the
// package ledger, not here.
const CONNECTION_TOKENS: Array<[label: string, pattern: RegExp]> = [
  ['DATABASE_URL', /DATABASE_URL/],
  ['connectionString', /\bconnectionString\b/],
  ['new Pool', /\bnew\s+Pool\b/],
  ['PostgresDialect', /\bPostgresDialect\b/],
  ['createKyselyClients', /\bcreateKyselyClients\b/],
];

// `<file>: <token>, <token>` for each first-party file in the graph that names one.
function connectionOffenders(files: string[]): string[] {
  return files.flatMap((file) => {
    const code = stripComments(readFileSync(resolve(REPO_ROOT, file), 'utf-8'));
    const hits = CONNECTION_TOKENS.filter(([, pattern]) => pattern.test(code)).map(
      ([label]) => label
    );
    return hits.length ? [`${file}: ${hits.join(', ')}`] : [];
  });
}

describe('the ./test-harness subpath cannot reach DATABASE_URL', () => {
  it('exports exactly the offline compile harness', () => {
    expect(Object.keys(publicSubpath).sort()).toEqual(PUBLIC_SUBPATH_EXPORTS);
  });

  it('routes every subpath in the exports map at a module that is allowed there', () => {
    expect(packageJson.exports).toEqual(PACKAGE_EXPORTS);
  });

  it('keeps the DB-reaching helpers internal — and they exist, so the exclusion is real', () => {
    // Positive control on the exclusion: these are importable package-internally...
    expect(Object.keys(internal).sort()).toEqual(
      [...MUST_STAY_INTERNAL, ...PUBLIC_SUBPATH_EXPORTS].sort()
    );
    // ...and absent from the public module.
    for (const name of MUST_STAY_INTERNAL) expect(Object.keys(publicSubpath)).not.toContain(name);
  });

  // POSITIVE CONTROL for the two assertions that follow. A walker that resolves nothing, or a token
  // scan that matches nothing, would certify every module in the repo as clean. Pointed at the
  // DB-backed harness — one relative hop and one cross-package hop away from a real pool — both
  // must fire. This runs FIRST so a broken instrument cannot be read as a clean result.
  it('the walk and the token scan can both see a real pool (control: the DB-backed harness)', () => {
    const control = importGraph(DB_BACKED_HARNESS);

    // The cross-package hop: `@civitai/db/kysely` resolved through that package's exports map.
    expect(control.files).toContain('packages/civitai-db/src/kysely.ts');
    expect(control.packages).toContain('pg');

    const offenders = connectionOffenders(control.files);
    expect(offenders).toContain(
      'packages/civitai-db/src/kysely.ts: connectionString, new Pool, PostgresDialect, createKyselyClients'
    );
    expect(offenders).toContain(
      'packages/civitai-db-queries/src/test/harness.ts: DATABASE_URL, connectionString, createKyselyClients'
    );
  });

  it('imports exactly these modules, transitively', () => {
    const graph = importGraph(COMPILE_HARNESS);
    expect(graph.files).toEqual(PUBLIC_GRAPH_FILES);
    expect(graph.packages).toEqual(PUBLIC_GRAPH_PACKAGES);
  });

  // Driven off the manifest ON DISK, not off `PACKAGE_EXPORTS`. The ledger above is the only thing
  // that notices a subpath being ADDED, but a ledger is satisfied by whoever updates it; this is the
  // PROPERTY, and reading the real map is what makes it hold for a subpath nobody listed here.
  it('no module reachable from any exported subpath names a pool or a connection string', () => {
    const reachable = new Set<string>();
    for (const target of Object.values(packageJson.exports))
      for (const file of importGraph(resolve(PACKAGE_DIR, target)).files) reachable.add(file);

    // Control on THIS test's own reach: the whole public graph is in scope, so a walk that
    // collapsed to the entry files alone would be visible here.
    expect([...reachable].sort()).toEqual(expect.arrayContaining(PUBLIC_GRAPH_FILES));
    expect(connectionOffenders([...reachable].sort())).toEqual([]);
  });
});
