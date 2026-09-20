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

// Named once because TWO rules need the same list, and a second copy is how the bare-specifier
// exclusion below silently stopped agreeing with the pattern it is supposed to defer to.
const SPAWN_WRAPPERS = ['execa', 'cross-spawn', 'tinyexec', 'nano-spawn', 'zx'];

// What stays uncacheable even with file reads tracked: a child process reads what it likes, and a
// dynamic import whose specifier is computed is invisible to the module graph. 19 files, 0.7% of
// modelled worker time, measured 2026-09-19.
const ALWAYS_RUN_SOURCE = [
  // IMPORTING a process or thread module, not calling one by name: a call pattern cannot see
  // `cp.execSync(` or a destructured alias, and `exec(` matched every `regex.exec(` in the repo —
  // measured: src/__tests__/setup.ts tripped it and nothing was cacheable at all.
  // The module name in any IMPORT-SHAPED position: `from`, `import(`, `require(`,
  // `getBuiltinModule(`, or a call on a call (`createRequire(...)('child_process')`). Review found
  // each of those walking past a narrower pattern. NOT the bare quoted word: `'cluster'` is an
  // ordinary value in this repo's Redis and telemetry code, which every test's setup reaches —
  // measured, that made 1880 of 1880 unit tests uncacheable.
  /(?:\bfrom|\bimport\s*\(|\brequire\s*\(|\bgetBuiltinModule\s*\(|\)\s*\()\s*['"`](?:node:)?(?:child_process|worker_threads|cluster)['"`]/,
  // Wrappers that spawn for you. None is a direct dependency today; this keeps one from arriving
  // unnoticed, since node_modules is never scanned.
  new RegExp(String.raw`['"\x60](?:${SPAWN_WRAPPERS.join('|')})['"\x60]`),
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
  if (p.startsWith('file://')) {
    // 🔴 `fileURLToPath` is PLATFORM-DEPENDENT, and that is what made this function's own
    // test red on every PR: on Windows `file:///C:/x` yields `C:\x`, but on POSIX it yields
    // `/C:/x` — a leading slash the drive-letter comparisons below cannot see past, so the
    // path stopped matching `root` and `isAbsolute` returned null instead of the relative
    // path. Normalising restores the drive-letter shape those comparisons expect —
    // the `r.toLowerCase()` prefix test and the `/^[A-Za-z]:\//` guard — whichever
    // platform resolved the URL.
    //
    // 🔴 Scoped to THIS branch deliberately. Applied to every id it would also rewrite a
    // genuinely POSIX path whose first segment is a letter and a colon: measured,
    // `toRel('/C:/notes/x.md', '/C:')` returned 'notes/x.md' before and null after. Only a
    // `file://` id can carry the platform artefact, so only a `file://` id needs the repair,
    // and confining it here leaves every non-URL input byte-for-byte as it was.
    // 🔴 And it THROWS rather than returning the other platform's spelling: on Windows a POSIX
    // `file:///home/u/x.ts` is `ERR_INVALID_FILE_URL_PATH`, which took this file's own POSIX
    // invariant test red on every Windows run of `main`. The URL's pathname is the same string
    // `fileURLToPath` would have produced on the host that wrote it, so fall back to it.
    try {
      p = fileURLToPath(p);
    } catch (err) {
      // ONLY the cross-platform spelling. Any other failure is a malformed id, and swallowing it
      // would turn a refused record into a record written without that dependency — the false-skip
      // shape. A URL this host cannot name cannot be a local file, so it lands as null below.
      if (err?.code !== 'ERR_INVALID_FILE_URL_PATH') throw err;
      const { pathname } = new URL(p);
      // Node refuses an ENCODED separator under the same error code, and decoding one here would
      // silently name a different file. Let it throw instead: the reporter records nothing, which
      // is the safe direction.
      if (/%2f|%5c/i.test(pathname)) throw err;
      p = decodeURIComponent(pathname);
    }
    p = p.replace(/^\/([A-Za-z]:)/, '$1');
  }
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
  // A vite virtual module is not a file on disk, so fingerprinting it yields `missing` and the
  // reporter reads that as a module deleted mid-run. Measured 2026-09-19: every happy-dom test
  // depends on `__vite-browser-external:crypto`, and all 44 of them fell out of the cache this
  // way. A `\0` prefix, a plugin scheme and vite's browser shims are all ids no path can name.
  if (rel.startsWith('\0') || /^[A-Za-z_][A-Za-z\d_+.-]*:/.test(rel)) return true;
  if (rel.startsWith('node_modules/') || rel.includes('/node_modules/')) return true;
  if (rel.startsWith('.git/')) return true;
  return false;
}

/**
 * A computed import whose literal head is a BARE package specifier — `dayjs/locale/${tag}.js` —
 * resolves under node_modules whatever it computes, and the lockfile already covers that. Three
 * heads are deliberately not bare: `@civitai/*` is a workspace symlink into `packages/`, a head
 * carrying a `:` can be `node:${mod}` (a builtin, and one of them spawns), and `./` or `~/` is
 * first-party source. Measured 2026-09-19: `src/hooks/useDateLocale.ts` is the repo's only such
 * site, and it alone made 44 test files uncacheable.
 */
const BARE_COMPUTED_IMPORT = new RegExp(
  String.raw`import\(\s*(?:/\*[\s\S]*?\*/\s*)*\x60(?!@civitai/|(?:${SPAWN_WRAPPERS.join(
    '|'
  )})[/\x60])` + String.raw`[A-Za-z@][^\x60$:]*(\$\{[^\x60]*)\x60\s*\)`,
  'g'
);

export function alwaysRuns(source) {
  // The interpolated EXPRESSION is kept, only the import call around it goes. Dropping the whole
  // call would erase a spawn inside it — `` import(`dayjs/${require('child_process') ? a : b}.js`) ``
  // read as cacheable, which is the one thing the patterns below exist to catch.
  return ALWAYS_RUN_SOURCE.some((re) => re.test(source.replace(BARE_COMPUTED_IMPORT, '$1')));
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
      fp = st.isDirectory()
        ? `dir:${sha(listTree(abs).join('\n'))}`
        : `file:${sha(readFileSync(abs))}`;
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
  return sha(
    [salt, project, testRel, fingerprint(testRel), ...parts, '--shadows--', ...shadows].join('\n')
  );
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
    // would record its absence — review confirmed that as a false skip. A removal moves the mtime of
    // the NEAREST SURVIVING ancestor, so ask that one. Not "parent missing means changed": every
    // test probes `__snapshots__/<file>.snap` in a directory that usually never existed, and that
    // reading refused every record in the repo.
    let parent = rel;
    for (;;) {
      parent = parent.includes('/') ? parent.slice(0, parent.lastIndexOf('/')) : '.';
      try {
        const p = statSync(join(root, parent));
        return p.mtimeMs >= sinceMs || p.ctimeMs >= sinceMs;
      } catch {
        if (parent === '.') return true;
      }
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
  return join(
    isAbsolute(common) ? common : join(root, common),
    'civitai-test-cache',
    `v${CACHE_FORMAT}`
  );
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
      out.push({
        ...JSON.parse(readFileSync(join(d, name), 'utf8')),
        mtime: statSync(join(d, name)).mtimeMs,
      });
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
    for (const { n } of byAge.slice(0, all.length - RECORDS_PER_TEST))
      rmSync(join(d, n), { force: true });
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
