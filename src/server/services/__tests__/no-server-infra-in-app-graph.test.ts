import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * `_app`'s module graph must not reach server infrastructure.
 *
 * `_app.getInitialProps` runs in the BROWSER on client-side route transitions
 * (`node_modules/next/dist/docs/02-pages/04-api-reference/03-functions/get-initial-props.md`
 * lines 8 and 39). The `if (!request) return initialProps;` early return makes it
 * behaviourally server-only at RUNTIME, but the module graph is still compiled into the
 * client bundle. A `dynamic import()` does not exempt a module either — the chunk is
 * compiled, merely not fetched.
 *
 * That distinction is not intuitive, and getting it wrong is what put a Prisma client and a
 * redis client into the browser graph. Nothing reported it: the leaves were externalised by
 * `serverExternalPackages`, so the build stayed green. Only an `fs/promises` import ever
 * failed loudly enough to notice.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const ENTRY = 'src/pages/_app.tsx';

/**
 * Server infrastructure: modules that open connections, read the server env, or talk to
 * another service. Deliberately a denylist of INFRA rather than a snapshot of the current
 * file list — a snapshot rots into churn, and the invariant we actually care about is
 * "no infra", not "exactly these 1198 files".
 */
const DENIED_PREFIXES = [
  'src/server/db/',
  'src/server/redis/',
  'src/server/flipt/',
  'src/server/logging/',
  'src/env/server.ts',
  'src/env/server-schema.ts',
  'src/utils/logging.ts',
  'packages/civitai-db/',
  'packages/civitai-redis/',
  'packages/civitai-clickhouse/',
  'packages/civitai-axiom/',
  'packages/civitai-telemetry/',
  // Not the whole package: most of @civitai/buzz is pure pricing/limits constants that client
  // code legitimately uses. Only the service transport and its env slice are infra.
  'packages/civitai-buzz/src/client.ts',
  'packages/civitai-buzz/src/env.ts',
];

/**
 * Violations that exist today. Each must be REMOVED from this list when fixed — the second
 * test fails on a stale entry, so the list can shrink but never silently grow. An allowlist
 * that keeps permitting a fixed violation is worse than no guard at all.
 */
const KNOWN_REACHABLE: { file: string; reason: string }[] = [
  {
    file: 'src/server/flipt/client.ts',
    reason:
      'via _app -> [dyn] feature-flags.service. Drops with the feature-flag evaluator move to ~/shared/.',
  },
  {
    file: 'src/env/server.ts',
    reason: 'sole importer in this graph is flipt/client.ts:294; drops with it.',
  },
  {
    file: 'src/env/server-schema.ts',
    reason: 'sole importer is env/server.ts; drops with it.',
  },
  {
    file: 'src/server/logging/client.ts',
    reason:
      'TWO live paths — flipt/client.ts:3 AND audit-slow-log.ts:176 (guarded, deliberate, out of scope). Evicting flipt alone does NOT clear this one.',
  },
  {
    file: 'packages/civitai-axiom/src/client.ts',
    reason: 'via logging/client.ts:7; drops only when logging/client does.',
  },
  {
    file: 'packages/civitai-axiom/src/env.ts',
    reason: 'via civitai-axiom/src/client.ts; drops with it.',
  },
  {
    file: 'packages/civitai-buzz/src/client.ts',
    reason:
      'PRE-EXISTING, invisible until this guard learned to resolve unaliased workspace packages. Static chain: _app -> SignalsProviderStack -> SignalsNotifications -> shared/constants/buzz.constants.ts -> the @civitai/buzz BARREL, which `export * from ./client`. buzz.constants only needs ./account-types. Fix needs an `exports` map on @civitai/buzz (it ships none) so the import can go deep.',
  },
  {
    file: 'packages/civitai-buzz/src/env.ts',
    reason: 'same barrel chain as civitai-buzz/src/client.ts; drops with the same fix.',
  },
];

const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

function readAliasMap(): [string, string][] {
  // tsconfig is JSONC (comments + trailing commas). Use TypeScript's own parser rather than
  // hand-rolled stripping, so a future edit to tsconfig can't quietly yield an empty alias
  // map — which would resolve nothing and make this whole guard vacuously pass.
  const file = path.join(REPO_ROOT, 'tsconfig.json');
  const { config, error } = ts.parseConfigFileTextToJson(file, fs.readFileSync(file, 'utf8'));
  if (error) throw new Error(`could not parse tsconfig.json: ${JSON.stringify(error.messageText)}`);
  const paths = config?.compilerOptions?.paths as Record<string, string[]> | undefined;
  if (!paths || !Object.keys(paths).length)
    throw new Error('tsconfig.json has no compilerOptions.paths');
  return Object.entries(paths).map(([k, v]) => [k, v[0]!]);
}

const ALIASES = readAliasMap();

/**
 * Workspace packages resolved from each `package.json` `exports` map — the real contract, and
 * the only thing that covers deep subpaths. tsconfig aliases only 8 of the 15 packages, so
 * alias-only resolution silently treated `@civitai/auth`, `buzz`, `shared`, `ui`, `email`,
 * `storage` and `db-queries` as external leaves and stopped walking there. That mattered:
 * `@civitai/auth`'s barrel reaches `redis.ts`, which imports `@civitai/redis` — so the
 * invariant held only because call sites happen to spell it `@civitai/auth/client`, something
 * the guard could not see and a one-word edit would undo.
 */
function readWorkspacePackages(): { name: string; dir: string; exports: Record<string, string> }[] {
  const packagesDir = path.join(REPO_ROOT, 'packages');
  const out: { name: string; dir: string; exports: Record<string, string> }[] = [];
  for (const entry of fs.readdirSync(packagesDir)) {
    const manifest = path.join(packagesDir, entry, 'package.json');
    if (!fs.existsSync(manifest)) continue;
    const json = JSON.parse(fs.readFileSync(manifest, 'utf8')) as {
      name?: string;
      exports?: Record<string, string>;
    };
    if (!json.name) continue;
    out.push({ name: json.name, dir: path.join(packagesDir, entry), exports: json.exports ?? {} });
  }
  if (!out.length) throw new Error('no workspace packages found under packages/');
  return out;
}

const WORKSPACE_PACKAGES = readWorkspacePackages();

function resolveWorkspace(spec: string): string | null {
  for (const pkg of WORKSPACE_PACKAGES) {
    if (spec !== pkg.name && !spec.startsWith(pkg.name + '/')) continue;
    const rest = spec === pkg.name ? '' : spec.slice(pkg.name.length + 1);
    const subpath = rest ? `./${rest}` : '.';
    const target = pkg.exports[subpath];
    if (target) return resolveFile(path.join(pkg.dir, target));
    // `@civitai/buzz` ships no exports map at all; fall back to the source layout.
    return resolveFile(path.join(pkg.dir, 'src', rest || 'index'));
  }
  return null;
}

function resolveFile(candidate: string): string | null {
  if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  for (const ext of EXTENSIONS) {
    if (fs.existsSync(candidate + ext)) return candidate + ext;
  }
  for (const ext of EXTENSIONS) {
    const index = path.join(candidate, 'index' + ext);
    if (fs.existsSync(index)) return index;
  }
  return null;
}

function resolveSpecifier(spec: string, fromFile: string): string | null {
  if (spec.startsWith('.')) {
    return resolveFile(path.resolve(path.dirname(fromFile), spec));
  }
  for (const [pattern, target] of ALIASES) {
    if (pattern.endsWith('/*')) {
      const prefix = pattern.slice(0, -1);
      if (spec.startsWith(prefix)) {
        return resolveFile(path.join(REPO_ROOT, target.slice(0, -1) + spec.slice(prefix.length)));
      }
    } else if (spec === pattern) {
      return resolveFile(path.join(REPO_ROOT, target));
    }
  }
  return resolveWorkspace(spec); // null -> node_modules / unresolvable -> external leaf
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * A named-import clause erases entirely when every specifier is type-only. Both spellings
 * count: `import type { A }` and the inline `import { type A, type B }`. Missing the inline
 * form makes a pure type reference look like a value edge, which mis-attributes megabytes
 * of unrelated graph to whichever file happens to use it.
 */
function isTypeOnlyClause(clause: string): boolean {
  if (/^\s*type[\s{*]/.test(clause)) return true;
  const braces = clause.match(/\{([\s\S]*)\}/);
  if (!braces) return false;
  const outside = clause.slice(0, clause.indexOf('{'));
  if (/[A-Za-z_$*]/.test(outside)) return false; // default or namespace binding present
  const specifiers = braces[1]!
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return specifiers.length > 0 && specifiers.every((s) => /^type\s/.test(s));
}

type Edge = { spec: string; dynamic: boolean };

function parseImports(source: string): Edge[] {
  const code = stripComments(source);
  const edges: Edge[] = [];
  let match: RegExpExecArray | null;

  const fromRe = /(?:^|[\n;}])\s*(?:import|export)\s+([\s\S]*?)from\s*['"]([^'"]+)['"]/g;
  while ((match = fromRe.exec(code))) {
    if (!isTypeOnlyClause(match[1]!)) edges.push({ spec: match[2]!, dynamic: false });
  }
  const bareRe = /(?:^|[\n;}])\s*import\s*['"]([^'"]+)['"]/g;
  while ((match = bareRe.exec(code))) edges.push({ spec: match[1]!, dynamic: false });
  const requireRe = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = requireRe.exec(code))) edges.push({ spec: match[1]!, dynamic: false });
  // Followed deliberately: a lazily-fetched chunk is still a compiled chunk.
  const dynamicRe = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = dynamicRe.exec(code))) edges.push({ spec: match[1]!, dynamic: true });

  return edges;
}

const rel = (abs: string) => path.relative(REPO_ROOT, abs).replace(/\\/g, '/');

/**
 * Breadth-first so a reported chain is the SHORTEST one, and `visited` bounds the walk to
 * one visit per file — the import graph has cycles, and an unbounded walk would hang rather
 * than fail.
 */
function walkGraph() {
  const entryAbs = path.join(REPO_ROOT, ENTRY);
  const parent = new Map<string, { from: string; dynamic: boolean } | null>([[entryAbs, null]]);
  const queue = [entryAbs];
  const parsed = new Map<string, Edge[]>();

  while (queue.length) {
    const file = queue.shift()!;
    let edges = parsed.get(file);
    if (!edges) {
      let source = '';
      try {
        source = fs.readFileSync(file, 'utf8');
      } catch {
        continue; // unreadable -> leaf
      }
      edges = parseImports(source);
      parsed.set(file, edges);
    }
    for (const edge of edges) {
      const target = resolveSpecifier(edge.spec, file);
      if (!target || parent.has(target)) continue;
      parent.set(target, { from: file, dynamic: edge.dynamic });
      queue.push(target);
    }
  }

  const chainTo = (abs: string) => {
    const hops: string[] = [];
    let cursor: string | null = abs;
    while (cursor) {
      const link = parent.get(cursor);
      hops.push(rel(cursor) + (link?.dynamic ? '   [dynamic import]' : ''));
      cursor = link ? link.from : null;
    }
    return hops.reverse();
  };

  return { reachable: new Set([...parent.keys()].map(rel)), chainTo, parent };
}

const { reachable, chainTo } = walkGraph();
const isDenied = (file: string) => DENIED_PREFIXES.some((p) => file === p || file.startsWith(p));
const known = new Set(KNOWN_REACHABLE.map((k) => k.file));

function formatViolation(file: string): string {
  const chain = chainTo(path.join(REPO_ROOT, file));
  const lines = chain.map((hop, i) => (i === 0 ? `    ${hop}` : `      -> ${hop}`));
  return `  ${file}\n${lines.join('\n')}`;
}

describe('no server infrastructure in the _app client graph', () => {
  it('walks a non-trivial graph', () => {
    // Guards the guard: an alias-resolution or entry-path breakage would empty the graph and
    // make every assertion below pass vacuously.
    expect(reachable.size).toBeGreaterThan(1000);
  });

  it('does not reach server infrastructure', () => {
    const violations = [...reachable].filter((f) => isDenied(f) && !known.has(f)).sort();
    if (violations.length) {
      throw new Error(
        `${violations.length} server-infrastructure module(s) reachable from ${ENTRY}.\n\n` +
          `A dynamic import() does NOT exempt a module — the chunk is still compiled into the\n` +
          `client bundle. Move the work behind an API route, or import the value from ~/shared/.\n\n` +
          violations.map(formatViolation).join('\n\n') +
          `\n`
      );
    }
  });

  it('has no stale KNOWN_REACHABLE entries', () => {
    const fixed = KNOWN_REACHABLE.filter((k) => !reachable.has(k.file));
    if (fixed.length) {
      throw new Error(
        `${fixed.length} KNOWN_REACHABLE entr(ies) are no longer reachable — delete them from\n` +
          `${path.basename(
            __filename
          )} so the guard tightens instead of silently re-permitting them:\n\n` +
          fixed.map((k) => `  ${k.file}\n    (${k.reason})`).join('\n\n') +
          `\n`
      );
    }
  });
});
