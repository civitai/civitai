import fs from 'fs';
import path from 'path';
import ts from 'typescript';

/**
 * A static, regex-level reading of the repo's import graph, shared by the guards that need one.
 * It follows dynamic `import()` and skips type-only imports, as the bundler and vite do.
 * scripts/test-perf/graph.mjs keeps a second, simpler resolver; a resolution fix here may belong
 * there too.
 */

export const REPO_ROOT = path.resolve(__dirname, '../../../..');

export const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.svelte'];

export function readAliasMap(): [string, string][] {
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

export const ALIASES = readAliasMap();

/**
 * Workspace packages resolved from each `package.json` `exports` map — the real contract, and
 * the only thing that covers deep subpaths. tsconfig aliases only 8 of the 15 packages, so
 * alias-only resolution silently treated `@civitai/auth`, `buzz`, `shared`, `ui`, `email`,
 * `storage` and `db-queries` as external leaves and stopped walking there. That mattered:
 * `@civitai/auth`'s barrel reaches `redis.ts`, which imports `@civitai/redis` — so the
 * invariant held only because call sites happen to spell it `@civitai/auth/client`, something
 * the guard could not see and a one-word edit would undo.
 */
/**
 * An `exports` value is a path, or a conditions object (`{ import, require, default }`).
 * Returning null rather than throwing on an unrecognised shape matters: this runs at module
 * scope, so a throw here fails COLLECTION, and a file that collects nothing reads as a pass.
 */
export type ExportTarget = string | Record<string, unknown> | undefined;

export function exportTargetToPath(target: ExportTarget): string | null {
  if (typeof target === 'string') return target;
  if (!target || typeof target !== 'object') return null;
  // `import` before `default`: this walks SOURCE. The conventional manifest is
  // `{ import: './src/x.ts', default: './dist/x.cjs' }`, and preferring `default` would walk a
  // bundled artifact whose imports are invisible — blindness, dressed as a resolution.
  for (const condition of ['import', 'node', 'default', 'require']) {
    const value = target[condition];
    if (typeof value === 'string') return value;
  }
  return null;
}

export function readWorkspacePackages(): {
  name: string;
  dir: string;
  exports: Record<string, ExportTarget>;
}[] {
  const packagesDir = path.join(REPO_ROOT, 'packages');
  const out: { name: string; dir: string; exports: Record<string, ExportTarget> }[] = [];
  for (const entry of fs.readdirSync(packagesDir)) {
    const manifest = path.join(packagesDir, entry, 'package.json');
    if (!fs.existsSync(manifest)) continue;
    const json = JSON.parse(fs.readFileSync(manifest, 'utf8')) as {
      name?: string;
      exports?: Record<string, ExportTarget>;
    };
    if (!json.name) continue;
    out.push({ name: json.name, dir: path.join(packagesDir, entry), exports: json.exports ?? {} });
  }
  if (!out.length) throw new Error('no workspace packages found under packages/');
  return out;
}

export const WORKSPACE_PACKAGES = readWorkspacePackages();

export function resolveWorkspace(spec: string): string | null {
  for (const pkg of WORKSPACE_PACKAGES) {
    if (spec !== pkg.name && !spec.startsWith(pkg.name + '/')) continue;
    const rest = spec === pkg.name ? '' : spec.slice(pkg.name.length + 1);
    const subpath = rest ? `./${rest}` : '.';

    const exact = exportTargetToPath(pkg.exports[subpath]);
    if (exact) return resolveFile(path.join(pkg.dir, exact));

    // Wildcard keys, longest-prefix-wins per the exports spec. `@civitai/ui` maps
    // `./components/*` at `./src/lib/components/*` — without this the subpath misses the map
    // and the source-layout fallback guesses `src/components/*`, which does not exist, so the
    // module becomes a silent external leaf: the exact blindness this guard exists to prevent.
    let best: string | null = null;
    let bestPrefix = -1;
    for (const [key, value] of Object.entries(pkg.exports)) {
      const star = key.indexOf('*');
      if (star === -1) continue;
      const prefix = key.slice(0, star);
      const suffix = key.slice(star + 1);
      if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue;
      if (prefix.length <= bestPrefix) continue;
      const target = exportTargetToPath(value);
      if (!target) continue;
      best = target.replace('*', subpath.slice(prefix.length, subpath.length - suffix.length));
      bestPrefix = prefix.length;
    }
    // Fall THROUGH when a wildcard matched but its target doesn't exist. Returning here
    // would make a wildcard key strictly worse than no map at all, since the layout
    // fallback below would never get its turn.
    if (best) {
      const resolved = resolveFile(path.join(pkg.dir, best));
      if (resolved) return resolved;
    }

    // Six packages ship no `exports` map at all (buzz, redis, axiom, ...); use their layout.
    return resolveFile(path.join(pkg.dir, 'src', rest || 'index'));
  }
  return null;
}

export function resolveFile(candidate: string): string | null {
  if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  // ESM specifiers name the EMITTED file, so TS/Svelte sources are imported as `./x.js`
  // (and Svelte 5 rune modules as `./x.svelte.js`). Every real `@civitai/ui` subpath in
  // apps/ is spelled that way; without this swap they all resolve to nothing and the
  // package becomes a silent external leaf.
  if (candidate.endsWith('.js')) {
    const stem = candidate.slice(0, -'.js'.length);
    for (const ext of EXTENSIONS) {
      if (fs.existsSync(stem + ext)) return stem + ext;
    }
  }
  for (const ext of EXTENSIONS) {
    if (fs.existsSync(candidate + ext)) return candidate + ext;
  }
  for (const ext of EXTENSIONS) {
    const index = path.join(candidate, 'index' + ext);
    if (fs.existsSync(index)) return index;
  }
  return null;
}

export function resolveSpecifier(spec: string, fromFile: string): string | null {
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

export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * A named-import clause erases entirely when every specifier is type-only. Both spellings
 * count: `import type { A }` and the inline `import { type A, type B }`. Missing the inline
 * form makes a pure type reference look like a value edge, which mis-attributes megabytes
 * of unrelated graph to whichever file happens to use it.
 */
export function isTypeOnlyClause(clause: string): boolean {
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

export type Edge = { spec: string; dynamic: boolean };

export function parseImports(source: string): Edge[] {
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

export const rel = (abs: string) => path.relative(REPO_ROOT, abs).replace(/\\/g, '/');

/**
 * Every file reachable from `entries` (repo-relative), with its resolved first-party imports.
 * `followDynamic: false` keeps only the imports that load with the module.
 */
export function importGraph(
  entries: string[],
  { followDynamic = true } = {}
): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  const queue = entries.map((e) => path.join(REPO_ROOT, e));
  const seen = new Set(queue);
  while (queue.length) {
    const file = queue.shift()!;
    let source = '';
    try {
      source = fs.readFileSync(file, 'utf8');
    } catch {
      graph.set(rel(file), []);
      continue;
    }
    const deps: string[] = [];
    for (const edge of parseImports(source)) {
      if (edge.dynamic && !followDynamic) continue;
      const target = resolveSpecifier(edge.spec, file);
      if (!target) continue;
      deps.push(rel(target));
      if (!seen.has(target)) {
        seen.add(target);
        queue.push(target);
      }
    }
    graph.set(rel(file), deps);
  }
  return graph;
}

/**
 * Every import cycle in `graph`: strongly connected components of two or more modules, each sorted,
 * largest first. Iterative Tarjan: the graph is deep enough to overflow the stack recursively.
 */
export function importCycles(graph: Map<string, string[]>): string[][] {
  let next = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  for (const root of graph.keys()) {
    if (index.has(root)) continue;
    const work: [string, number][] = [[root, 0]];
    while (work.length) {
      const frame = work[work.length - 1]!;
      const [v, i] = frame;
      if (i === 0) {
        index.set(v, next);
        low.set(v, next++);
        stack.push(v);
        onStack.add(v);
      }
      const deps = graph.get(v) ?? [];
      if (i < deps.length) {
        frame[1]++;
        const w = deps[i]!;
        if (!index.has(w)) work.push([w, 0]);
        else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
        continue;
      }
      work.pop();
      if (work.length) {
        const parent = work[work.length - 1]![0];
        low.set(parent, Math.min(low.get(parent)!, low.get(v)!));
      }
      if (low.get(v) === index.get(v)) {
        const scc: string[] = [];
        let w: string;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          scc.push(w);
        } while (w !== v);
        if (scc.length > 1) cycles.push(scc.sort());
      }
    }
  }
  return cycles.sort((a, b) => b.length - a.length || a[0]!.localeCompare(b[0]!));
}

/** The import cycle `file` sits in: every module it reaches that also reaches it back. */
export function cycleContaining(graph: Map<string, string[]>, file: string): string[] {
  const reach = (from: string, edges: (f: string) => string[]) => {
    const seen = new Set([from]);
    const stack = [from];
    while (stack.length) {
      for (const next of edges(stack.pop()!)) {
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
    return seen;
  };
  const reverse = new Map<string, string[]>();
  for (const [from, deps] of graph) {
    for (const dep of deps) reverse.set(dep, [...(reverse.get(dep) ?? []), from]);
  }
  const down = reach(file, (f) => graph.get(f) ?? []);
  const up = reach(file, (f) => reverse.get(f) ?? []);
  return [...down].filter((f) => up.has(f)).sort();
}
