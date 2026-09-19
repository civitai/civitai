/**
 * Test-result cache, SHADOW MODE. Records what a content-keyed cache WOULD have skipped, and never
 * skips anything. Every test still runs; this only watches.
 *
 *   vitest run --reporter=default --reporter=scripts/test-cache/reporter.mjs
 *
 * A test file's key is a hash of every first-party module it depends on, plus the inputs that are
 * not imports (lockfile, config, node, platform). A file that passed in full is recorded under its
 * key; a later run whose key matches is one the cache would skip. If that file then FAILS, the key
 * missed a dependency — a false skip, the one outcome that disqualifies the cache.
 *
 * Why the dependency set comes from vite's server-side module graph and not from
 * `diagnostic().importDurations`: measured on a fixture, importDurations recorded a static import
 * and MISSED an `await import()` made inside a test body — a module the test demonstrably loaded.
 * The ssr graph recorded both, cold and warm. It also leaves out the subtree behind a `vi.mock`
 * factory, which never executes, and keeps the mocked module itself, which is the safe direction.
 *
 * 🔴 This file must never change a run's outcome. Everything is wrapped; a failure here is logged
 * and swallowed. It imports node builtins only, because the queue runs it from the primary
 * checkout against whatever worktree the suite belongs to.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';

export const CACHE_FORMAT = 1;

// Inputs every test depends on that no import edge records. Changing any of them invalidates the
// whole cache, which is the correct response to a changed toolchain.
const GLOBAL_INPUTS = ['pnpm-lock.yaml', 'vitest.config.mts', 'tsconfig.json'];

// A test that reads the filesystem or spawns processes has inputs the module graph cannot see — a
// fixture, a scanned source tree, a script's behaviour. The convention guards (`no-*.test.ts`) are
// the largest group: they read source as TEXT. Such files always run. Measured at 243 of 1,880 unit
// files, and 6.5% of modelled worker time, because they are mostly cheap.
const UNCACHEABLE_SOURCE = [
  /\b(?:readFileSync|readFile|readdirSync|readdir|globSync|statSync|existsSync|opendirSync)\b/,
  /\b(?:spawn|spawnSync|execSync|execFileSync|execFile)\(/,
  // A dynamic import whose specifier is not a literal is invisible to static analysis.
  /import\(\s*(?:`[^`]*\$\{|[A-Za-z_$])/,
];

export function sha(data) {
  return createHash('sha256').update(data).digest('hex');
}

/** Repo-relative, forward-slashed, query-stripped — so two worktrees produce the same key. */
export function normaliseId(id, root) {
  const bare = id.split('?')[0].replace(/\\/g, '/');
  const rootFwd = root.replace(/\\/g, '/').replace(/\/$/, '');
  if (bare.toLowerCase().startsWith(rootFwd.toLowerCase() + '/')) return bare.slice(rootFwd.length + 1);
  return bare;
}

/** Dependencies whose identity is the lockfile's job, or that are not files at all. */
export function isCoveredElsewhere(rel) {
  if (!rel.includes('/') && !rel.includes('.')) return true; // node builtins: `fs`, `crypto`
  if (rel.startsWith('node:')) return true;
  if (rel.startsWith('node_modules/') || rel.includes('/node_modules/')) return true;
  return false;
}

export function isUncacheableSource(source) {
  return UNCACHEABLE_SOURCE.some((re) => re.test(source));
}

/** Transitive imports of `id` in one environment's module graph, memoised across a run. */
export function closureOf(graph, id, memo = new Map()) {
  if (memo.has(id)) return memo.get(id);
  const out = new Set();
  const root = graph.getModuleById(id);
  if (!root) {
    memo.set(id, null);
    return null;
  }
  const stack = [root];
  const seen = new Set([root]);
  while (stack.length) {
    const node = stack.pop();
    for (const dep of node.importedModules) {
      if (!dep?.id || seen.has(dep)) continue;
      seen.add(dep);
      out.add(dep.id);
      stack.push(dep);
    }
  }
  memo.set(id, out);
  return out;
}

/** Fully passed: every case ran and passed. A skipped case means part of the file never ran. */
export function fullyPassed(testModule) {
  if (testModule.state() !== 'passed') return false;
  for (const test of testModule.children.allTests()) {
    if (test.result().state !== 'passed') return false;
  }
  return true;
}

function cacheDir(root) {
  if (process.env.CIVITAI_TEST_CACHE_DIR) return process.env.CIVITAI_TEST_CACHE_DIR;
  // The COMMON git dir is shared by every worktree of the repo, which is what makes one tree's
  // green result reusable by another, and it is never inside a checkout's own files.
  const common = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: root })
    .toString()
    .trim();
  return join(isAbsolute(common) ? common : join(root, common), 'civitai-test-cache', `v${CACHE_FORMAT}`);
}

export default class TestCacheShadowReporter {
  onInit(vitest) {
    this.vitest = vitest;
    this.startedAt = Date.now();
  }

  onTestRunEnd(testModules) {
    try {
      this.record(testModules);
    } catch (err) {
      console.error(`[test-cache] shadow recorder failed, run unaffected: ${err?.stack ?? err}`);
    }
  }

  record(testModules) {
    if (!testModules.length) return;
    const root = this.vitest.config.root;
    // A name filter runs part of every file, so nothing it passes may be recorded as a whole pass.
    const filtered = Boolean(this.vitest.config.testNamePattern);
    const dir = cacheDir(root);
    mkdirSync(join(dir, 'pass'), { recursive: true });

    const fileHash = new Map();
    const hashFile = (rel) => {
      if (!fileHash.has(rel)) {
        const abs = join(root, rel);
        fileHash.set(rel, existsSync(abs) ? sha(readFileSync(abs)) : null);
      }
      return fileHash.get(rel);
    };

    const globalSalt = sha(
      JSON.stringify([
        CACHE_FORMAT,
        process.version,
        process.platform,
        this.vitest.version,
        GLOBAL_INPUTS.map((f) => [f, hashFile(f)]),
      ])
    );

    const rows = [];
    const memo = new Map();
    for (const m of testModules) {
      const server = m.project.vite;
      const graph = server.environments?.ssr?.moduleGraph;
      const rel = normaliseId(m.moduleId, root);
      const d = m.diagnostic();
      const ms = (d.prepareDuration ?? 0) + (d.setupDuration ?? 0) + (d.collectDuration ?? 0) + (d.duration ?? 0);
      const row = { file: rel, project: m.project.name, ms, passed: fullyPassed(m), key: null, why: null };
      rows.push(row);

      let reason = null;
      const source = hashFile(rel) === null ? null : readFileSync(join(root, rel), 'utf8');
      if (!graph) reason = 'no ssr module graph';
      else if (source === null) reason = 'test file unreadable';
      else if (isUncacheableSource(source)) reason = 'reads fs / spawns / non-literal import';

      const deps = new Set();
      if (!reason) {
        const own = closureOf(graph, m.moduleId, memo);
        if (own === null) reason = 'test file not in module graph';
        else {
          for (const id of own) deps.add(id);
          for (const setup of m.project.config.setupFiles ?? []) {
            const s = closureOf(graph, setup, memo);
            if (s === null) {
              reason = 'setup file not in module graph';
              break;
            }
            deps.add(setup);
            for (const id of s) deps.add(id);
          }
        }
      }

      if (!reason) {
        const parts = [];
        for (const id of deps) {
          const depRel = normaliseId(id, root);
          if (isCoveredElsewhere(depRel)) continue;
          const h = hashFile(depRel);
          if (h === null) {
            reason = `dependency unreadable: ${depRel}`;
            break;
          }
          parts.push(`${depRel}\0${h}`);
        }
        if (!reason) {
          parts.sort();
          row.key = sha([globalSalt, m.project.name, rel, hashFile(rel), ...parts].join('\n'));
          row.deps = parts.length;
        }
      }
      row.why = reason;
    }

    // Look up EVERYTHING before writing anything, so a file cannot "hit" on its own result.
    for (const row of rows) {
      row.wouldSkip = Boolean(row.key && existsSync(join(dir, 'pass', `${row.key}.json`)));
      row.falseSkip = row.wouldSkip && !row.passed;
    }

    if (!filtered) {
      for (const row of rows) {
        if (!row.key || !row.passed || row.wouldSkip) continue;
        const final = join(dir, 'pass', `${row.key}.json`);
        const tmp = `${final}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify({ file: row.file, at: new Date().toISOString(), ms: row.ms }));
        renameSync(tmp, final);
      }
    }

    const summary = {
      at: new Date().toISOString(),
      root,
      head: safeGit(root, ['rev-parse', 'HEAD']),
      dirty: safeGit(root, ['status', '--porcelain']) !== '',
      filtered,
      files: rows.length,
      cacheable: rows.filter((r) => r.key).length,
      wouldSkip: rows.filter((r) => r.wouldSkip).length,
      totalMs: Math.round(rows.reduce((n, r) => n + r.ms, 0)),
      savedMs: Math.round(rows.filter((r) => r.wouldSkip).reduce((n, r) => n + r.ms, 0)),
      falseSkips: rows.filter((r) => r.falseSkip).map((r) => r.file),
      uncacheable: tally(rows.filter((r) => !r.key).map((r) => r.why?.replace(/:.*$/, ''))),
      wallMs: Date.now() - this.startedAt,
    };
    appendFileSync(join(dir, 'shadow-ledger.jsonl'), JSON.stringify(summary) + '\n');
    console.log(
      `[test-cache] shadow: ${summary.wouldSkip}/${summary.files} files would have been skipped ` +
        `(${Math.round((summary.savedMs / Math.max(summary.totalMs, 1)) * 100)}% of worker time); ` +
        `false skips: ${summary.falseSkips.length}`
    );
  }
}

function tally(values) {
  const out = {};
  for (const v of values) out[v ?? 'unknown'] = (out[v ?? 'unknown'] ?? 0) + 1;
  return out;
}

function safeGit(root, args) {
  try {
    return execFileSync('git', args, { cwd: root }).toString().trim();
  } catch {
    return null;
  }
}
