/**
 * The one definition of a test file's cache key, shared by the sequencer (which decides BEFORE a
 * run what to skip) and the reporter (which records AFTER a run what passed). If the two computed
 * a key differently, every lookup would miss — or worse, hit on the wrong thing — so neither
 * computes it itself.
 *
 * A key covers: the test file, every first-party module it depends on, every file or directory it
 * read at runtime, and the inputs nothing else records (lockfile, configs, node, platform, vitest,
 * and this cache's own code). Anything under node_modules is left to the lockfile.
 *
 * Node builtins only: the queue runs the reporter from the primary checkout against any worktree.
 */

import { createHash } from 'node:crypto';
import { isBuiltin } from 'node:module';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CACHE_FORMAT = 2;
export const MODES = ['off', 'shadow', 'on'];
export const RECORDS_PER_TEST = 8;

const HERE = dirname(fileURLToPath(import.meta.url));

// Inputs every test depends on that no import edge or file read records. This cache's own code is
// among them: a fix to how reads are captured must invalidate everything recorded without it.
// `node_modules/.pnpm/lock.yaml` is what pnpm actually INSTALLED, which a rebased tree that skipped
// `pnpm install` does not share with its lockfile. The package.json files carry `exports` maps, and a
// symlinked workspace package resolves through them — the lockfile does not record `exports`.
const GLOBAL_INPUTS = [
  'pnpm-lock.yaml',
  'node_modules/.pnpm/lock.yaml',
  'package.json',
  'vitest.config.mts',
  'tsconfig.json',
];
const WORKSPACE_DIRS = ['packages', 'apps'];
const OWN_CODE = ['core.mjs', 'fs-tracker.mjs', 'sequencer.mjs', 'reporter.mjs'];

// What stays uncacheable even with file reads tracked: a child process reads what it likes, and a
// dynamic import whose specifier is computed is invisible to the module graph. 19 files, 0.7% of
// modelled worker time, measured 2026-09-19.
const ALWAYS_RUN_SOURCE = [
  // IMPORTING a process or thread module, not calling one by name: a call pattern cannot see
  // `cp.execSync(` or a destructured alias, and `exec(` matched every `regex.exec(` in the repo —
  // measured: src/__tests__/setup.ts tripped it and nothing was cacheable at all.
  // The module NAME anywhere as a string, not a particular import syntax: review found
  // `createRequire(...)('child_process')`, `process.getBuiltinModule('node:child_process')` and
  // `from"node:child_process"` (no space) all walking past syntax-specific patterns.
  /['"`](?:node:)?(?:child_process|worker_threads|cluster)['"`]/,
  // Wrappers that spawn for you. None is a direct dependency today; this keeps one from arriving
  // unnoticed, since node_modules is never scanned.
  /['"`](?:execa|cross-spawn|tinyexec|nano-spawn|zx)['"`]/,
  // Comments allowed between `import(` and the specifier: `import(/* @vite-ignore */ file)` is the
  // form this repo actually uses, and the first version of this pattern let it through.
  /import\(\s*(?:\/\*[\s\S]*?\*\/\s*)*(?:`[^`]*\$\{|[A-Za-z_$])/,
  // A glob's result changes when a MATCHING file is added anywhere, and a pattern is not a path
  // whose state can be fingerprinted.
  /\b(?:globSync|glob|globby|fastGlob|fg)\(|from ['"](?:fast-glob|globby|glob|tinyglobby)['"]/,
];

export function mode(env = process.env) {
  if (env.CI) return 'off';
  const m = env.CIVITAI_TEST_CACHE;
  return MODES.includes(m) ? m : 'off';
}

export const sha = (data) => createHash('sha256').update(data).digest('hex');

export function toRel(id, root) {
  let p = String(id);
  if (p.startsWith('file://')) p = fileURLToPath(p);
  p = p.split('?')[0].replace(/\\/g, '/');
  const r = root.replace(/\\/g, '/').replace(/\/$/, '');
  if (p.toLowerCase().startsWith(r.toLowerCase() + '/')) return p.slice(r.length + 1);
  return isAbsolute(p) || /^[A-Za-z]:\//.test(p) ? null : p;
}

/** A dependency the lockfile already covers, or that is not a file in this repo at all. */
export function isCoveredElsewhere(rel) {
  if (rel === null) return true;
  // `isBuiltin`, not "has no slash and no dot": that heuristic also matched a top-level directory
  // like `src`, which the convention guards list — dropping the one read that sees a new file.
  if (isBuiltin(rel)) return true;
  if (rel.startsWith('node:')) return true;
  if (rel.startsWith('node_modules/') || rel.includes('/node_modules/')) return true;
  if (rel.startsWith('.git/')) return true;
  return false;
}

export function alwaysRuns(source) {
  return ALWAYS_RUN_SOURCE.some((re) => re.test(source));
}

const RESOLVABLE_EXTS = ['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'json'];

/**
 * Paths whose APPEARANCE would change what an import of `rel` resolves to. `./foo` resolving to
 * `foo/index.ts` is overtaken by a new `foo.ts`; `foo.ts` is overtaken by an extension ahead of it.
 * Neither edits a file already in the dependency list, so without these the key cannot see it.
 * Only these siblings, not the whole directory: a listing would invalidate every test near any
 * new file.
 */
export function shadowCandidates(rel) {
  const m = /^(.*?)([^/]+)\.([^./]+)$/.exec(rel);
  if (!m) return [];
  const [, dir, name, ext] = m;
  if (!RESOLVABLE_EXTS.includes(ext)) return [];
  const out = RESOLVABLE_EXTS.filter((e) => e !== ext).map((e) => `${dir}${name}.${e}`);
  if (name === 'index' && dir) {
    const parent = dir.replace(/\/$/, '');
    for (const e of RESOLVABLE_EXTS) out.push(`${parent}.${e}`);
  }
  return out;
}

/** Transitive imports in one vite environment's module graph. null when the root is absent. */
export function closureOf(graph, id) {
  const root = graph.getModuleById(id);
  if (!root) return null;
  const out = new Set();
  const seen = new Set([root]);
  const stack = [root];
  while (stack.length) {
    for (const dep of stack.pop().importedModules) {
      if (!dep?.id || seen.has(dep)) continue;
      seen.add(dep);
      out.add(dep.id);
      stack.push(dep);
    }
  }
  return out;
}

/**
 * What a path looks like right now, as a string that changes exactly when the path does: a file's
 * content hash, a directory's sorted listing, or its absence. A directory counts because a test
 * that lists one (every convention guard does) depends on which files are in it.
 */
export function makeFingerprinter(root) {
  const memo = new Map();
  return (rel) => {
    if (memo.has(rel)) return memo.get(rel);
    const abs = join(root, rel);
    let fp;
    try {
      const st = statSync(abs);
      fp = st.isDirectory() ? `dir:${sha(listTree(abs).join('\n'))}` : `file:${sha(readFileSync(abs))}`;
    } catch {
      fp = 'missing';
    }
    memo.set(rel, fp);
    return fp;
  };
}

/**
 * A directory's whole subtree, not its top level: `readdirSync(dir, { recursive: true })` is one
 * recorded call, and a file added three levels down changes what it returns.
 */
function listTree(abs) {
  const out = [];
  const walk = (d, prefix) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      out.push(e.isDirectory() ? `${rel}/` : rel);
      if (e.isDirectory()) walk(join(d, e.name), rel);
    }
  };
  walk(abs, '');
  return out.sort();
}

function workspaceManifests(root) {
  const out = [];
  for (const ws of WORKSPACE_DIRS) {
    let names = [];
    try {
      names = readdirSync(join(root, ws));
    } catch {
      continue;
    }
    for (const n of names.sort()) out.push(`${ws}/${n}/package.json`);
  }
  return out;
}

export function globalSalt(root, vitestVersion, fingerprint = makeFingerprinter(root)) {
  const own = OWN_CODE.map((f) => {
    try {
      return `${f}:${sha(readFileSync(join(HERE, f)))}`;
    } catch {
      return `${f}:missing`;
    }
  });
  return sha(
    JSON.stringify([
      CACHE_FORMAT,
      process.version,
      process.platform,
      vitestVersion,
      GLOBAL_INPUTS.map((f) => [f, fingerprint(f)]),
      workspaceManifests(root).map((f) => [f, fingerprint(f)]),
      own,
    ])
  );
}

/** The key. `entries` is every repo-relative path the file depends on; order does not matter. */
export function keyFor({ salt, project, testRel, entries, fingerprint }) {
  const deps = [...new Set(entries)].filter((rel) => !isCoveredElsewhere(rel)).sort();
  const parts = deps.map((rel) => `${rel}\0${fingerprint(rel)}`);
  // Only the shadow candidates that EXIST, so the common case (none) adds nothing to fingerprint.
  const shadows = [...new Set(deps.flatMap(shadowCandidates))]
    .filter((rel) => fingerprint(rel) !== 'missing')
    .sort();
  return sha([salt, project, testRel, fingerprint(testRel), ...parts, '--shadows--', ...shadows].join('\n'));
}

/**
 * Whether `rel` was modified at or after `sinceMs`. A directory counts as modified when any
 * directory in its subtree was — that is what moves when a file is added, removed or renamed.
 * Used to refuse recording a pass whose inputs changed while the run was in flight: the key is
 * computed from disk at the END of a run, and an agent editing during a queued suite would
 * otherwise have its edit recorded as the version that passed. Measured by review: exactly that.
 */
export function changedSince(root, rel, sinceMs) {
  const abs = join(root, rel);
  let st;
  try {
    st = statSync(abs);
  } catch {
    // Absent now. If it was deleted or renamed DURING the run, the test ran with it and the key
    // would record its absence — review confirmed that as a false skip. Removing a file moves its
    // directory's mtime, so ask the directory.
    const parent = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '.';
    try {
      const p = statSync(join(root, parent));
      return p.mtimeMs >= sinceMs || p.ctimeMs >= sinceMs;
    } catch {
      return true;
    }
  }
  if (st.mtimeMs >= sinceMs || st.ctimeMs >= sinceMs) return true;
  if (!st.isDirectory()) return false;
  for (const e of readdirSync(abs, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name === 'node_modules' || e.name === '.git') continue;
    if (changedSince(root, `${rel}/${e.name}`, sinceMs)) return true;
  }
  return false;
}

export const identity = (project, testRel) => sha(`${project}\0${testRel}`);

// ------------------------------------------------------------------------------------------ store

export function cacheDir(root) {
  if (process.env.CIVITAI_TEST_CACHE_DIR) return process.env.CIVITAI_TEST_CACHE_DIR;
  // The COMMON git dir is shared by every worktree, so one tree's green result is reusable by
  // another, and it is never inside a checkout's own files.
  const common = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: root })
    .toString()
    .trim();
  return join(isAbsolute(common) ? common : join(root, common), 'civitai-test-cache', `v${CACHE_FORMAT}`);
}

/**
 * Every recorded pass for one test file, newest first. More than one so two worktrees on different
 * versions of the same code can BOTH stay fast, instead of evicting each other's record.
 */
export function recordsFor(dir, project, testRel) {
  const d = join(dir, 'rec', identity(project, testRel));
  if (!existsSync(d)) return [];
  const out = [];
  for (const name of readdirSync(d)) {
    if (!name.endsWith('.json')) continue;
    try {
      out.push({ ...JSON.parse(readFileSync(join(d, name), 'utf8')), mtime: statSync(join(d, name)).mtimeMs });
    } catch {
      /* a half-written or foreign file is not a record */
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

export function writeRecord(dir, project, testRel, record) {
  const d = join(dir, 'rec', identity(project, testRel));
  mkdirSync(d, { recursive: true });
  const final = join(d, `${record.key}.json`);
  const tmp = `${final}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(record));
  renameSync(tmp, final);
  const all = readdirSync(d).filter((n) => n.endsWith('.json'));
  if (all.length > RECORDS_PER_TEST) {
    const byAge = all
      .map((n) => ({ n, t: statSync(join(d, n)).mtimeMs }))
      .sort((a, b) => a.t - b.t);
    for (const { n } of byAge.slice(0, all.length - RECORDS_PER_TEST)) rmSync(join(d, n), { force: true });
  }
}

export const trippedPath = (dir) => join(dir, 'TRIPPED.json');

/** A marker that exists but cannot be parsed still means tripped — the safe reading of a half-write. */
export function tripped(dir) {
  const p = trippedPath(dir);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return { at: 'unknown (marker unreadable)', falseSkips: [] };
  }
}

export function writeTripped(dir, body) {
  const p = trippedPath(dir);
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(body, null, 2));
  try {
    renameSync(tmp, p);
  } catch {
    // Renaming over an existing marker can EPERM on Windows. Already tripped is still tripped;
    // write in place rather than abort before the offending records are forgotten.
    writeFileSync(p, JSON.stringify(body, null, 2));
    rmSync(tmp, { force: true });
  }
}

/** Every record of a file — used on a false skip, so clearing TRIPPED cannot revive the same skip. */
export function forget(dir, project, testRel) {
  rmSync(join(dir, 'rec', identity(project, testRel)), { recursive: true, force: true });
}
