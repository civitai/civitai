#!/usr/bin/env node
/**
 * Decides, for a pull request, which app suites in `.github/workflows/apps.yml` can be left out
 * of the run because nothing they read changed. Only the apps in SCOPED_APPS are ever left out;
 * every other app always runs whenever the workflow runs.
 *
 * Why only those: the workflow's own `paths:` filter already keeps the whole job off PRs that
 * touch no app input. Inside the job, one suite is most of the time (moderator was 937 s of
 * ~1,110 s summed per-file time on 2026-10-31), so it is the one worth scoping on its own.
 *
 * An app is left out only when EVERY changed file is inside a workspace member (a directory
 * under `apps/` or `packages/` with a package.json) that the app does not read. Anything else
 * runs it:
 *   - a file outside `apps/` and `packages/` (lockfile, root package.json, root vitest config,
 *     CI scripts, the workflow): those are inputs every suite shares, which is why the workflow
 *     filter lists them;
 *   - a file under `apps/` or `packages/` that is not inside any member (a loose file);
 *   - a file in a member the app reads.
 *
 * What an app "reads" is derived from the code, transitively, the same way
 * `assert-apps-paths-filter.mjs` derives the workflow filter, so a new dependency is picked up
 * without anyone editing a list:
 *   1. its package.json `workspace:` dependencies (all dependency fields);
 *   2. every `@scope/name` specifier its source imports that names a workspace member, declared
 *      or not;
 *   3. every `../`-style path literal in its files that resolves into another member (a test
 *      that reads `packages/<x>/prisma/migrations/...` by path).
 * and then the same three for every member found, until nothing new turns up.
 *
 * Push and dispatch runs are never scoped: `main` gets the full verdict on every commit.
 * Anything this cannot work out (no git, no parent commit) runs everything.
 *
 * Usage (CI):  node scripts/ci/app-suite-scope.mjs [--out app-suite-scope.json]
 *   Reads GITHUB_EVENT_NAME. On `pull_request` the changed files are `git diff HEAD^1 HEAD`:
 *   the checkout is the PR's merge commit, whose first parent is the base it merges into.
 *   Writes `vitest_args` (and `skipped`) to GITHUB_OUTPUT and the decision to `--out`, which
 *   `assert-workspace-suites-ran.mjs --scope` re-checks.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Apps whose suite a PR may leave out. Each must have a `test.name` of `app:<dir>`. */
export const SCOPED_APPS = ['moderator'];

const WORKSPACE_ROOTS = ['apps', 'packages'];
const SKIP_DIR = new Set(['node_modules', '.svelte-kit', 'dist', 'build', '.turbo']);
const SCANNED_FILE = /\.((c|m)?(t|j)sx?|svelte|json)$/;

/** Every workspace member under apps/ and packages/: name -> repo-relative dir. */
export function workspaceMembers(root) {
  const byName = new Map();
  for (const top of WORKSPACE_ROOTS) {
    if (!existsSync(join(root, top))) continue;
    for (const e of readdirSync(join(root, top), { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const dir = `${top}/${e.name}`;
      const pkgPath = join(root, dir, 'package.json');
      if (!existsSync(pkgPath)) continue;
      const name = JSON.parse(readFileSync(pkgPath, 'utf8')).name;
      if (typeof name === 'string') byName.set(name, dir);
    }
  }
  return byName;
}

function* walk(root, dir) {
  for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
    const rel = posix.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIR.has(e.name)) yield* walk(root, rel);
    } else if (SCANNED_FILE.test(e.name)) {
      yield rel;
    }
  }
}

/** The member dir a repo-relative path falls in, or null. */
function memberOf(path, memberDirs) {
  for (const dir of memberDirs) if (path === dir || path.startsWith(`${dir}/`)) return dir;
  return null;
}

/** Member dirs that `dir` reads directly, each with the reason. */
function directInputs(root, dir, byName) {
  const memberDirs = [...byName.values()];
  const found = new Map();
  const add = (target, why) => target !== dir && !found.has(target) && found.set(target, why);

  const pkg = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'));
  for (const field of [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ]) {
    for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
      if (String(spec).startsWith('workspace:') && byName.has(name)) {
        add(byName.get(name), `${dir}/package.json ${field}`);
      }
    }
  }

  for (const file of walk(root, dir)) {
    const text = readFileSync(join(root, file), 'utf8');
    for (const m of text.matchAll(/['"`](@[\w.-]+\/[\w.-]+)(?:\/[^'"`]*)?['"`]/g)) {
      if (byName.has(m[1])) add(byName.get(m[1]), `${file} names ${m[1]}`);
    }
    for (const m of text.matchAll(/['"`]((?:\.\.\/)+[^'"`$\s]*)/g)) {
      const target = posix.normalize(posix.join(posix.dirname(file), m[1]));
      const member = memberOf(target, memberDirs);
      if (member) add(member, `${file} reads ${m[1]}`);
    }
  }
  return found;
}

/** Every member dir `appDir` reads, transitively, mapped to why. Includes `appDir` itself. */
export function appInputs(root, appDir, byName = workspaceMembers(root)) {
  const inputs = new Map([[appDir, 'the app itself']]);
  const queue = [appDir];
  while (queue.length > 0) {
    const dir = queue.shift();
    for (const [target, why] of directInputs(root, dir, byName)) {
      if (inputs.has(target)) continue;
      inputs.set(target, why);
      queue.push(target);
    }
  }
  return inputs;
}

/**
 * For each scoped app: `{ run, reason }`. `run` is false only when every changed file lies in a
 * member the app does not read. An empty change list runs everything (nothing to reason from).
 */
export function decide(root, changed, apps = SCOPED_APPS) {
  const byName = workspaceMembers(root);
  const memberDirs = [...byName.values()];
  const out = {};
  for (const app of apps) {
    const appDir = `apps/${app}`;
    if (!existsSync(join(root, appDir, 'package.json'))) {
      out[app] = { run: true, reason: `${appDir} is not a workspace member` };
      continue;
    }
    if (changed.length === 0) {
      out[app] = { run: true, reason: 'no changed files to reason from' };
      continue;
    }
    const inputs = appInputs(root, appDir, byName);
    let decision = null;
    for (const file of changed) {
      const member = memberOf(file, memberDirs);
      if (!member) {
        decision = { run: true, reason: `${file} is outside every app and package` };
        break;
      }
      if (inputs.has(member)) {
        decision = { run: true, reason: `${file} is in ${member} (${inputs.get(member)})` };
        break;
      }
    }
    out[app] = decision ?? {
      run: false,
      reason: `none of the ${changed.length} changed file(s) is in the ${inputs.size} member(s) it reads`,
    };
  }
  return out;
}

/**
 * Re-checks a scope file before the suites ledger accepts a skip, so a suite missing from the run
 * is excused only when it was left out on purpose, for a reason that still holds. Returns the
 * problems; empty means every declared skip is sound.
 *
 * @param {string} root repo root
 * @param {{ event: string, changed: string[], skipped: string[] }} scope what the scope step wrote
 * @param {Iterable<string>} ranApps app dirs that appear in the run's report
 * @param {string | undefined} eventName the event this job runs for, read independently
 */
export function checkDeclaredSkips(root, scope, ranApps, eventName) {
  const skipped = scope.skipped ?? [];
  if (skipped.length === 0) return [];
  const problems = [];
  const ran = new Set(ranApps);
  for (const app of skipped) {
    if (!SCOPED_APPS.includes(app)) problems.push(`${app} is not an app a PR may leave out`);
  }
  if (scope.event !== 'pull_request' || eventName !== 'pull_request') {
    problems.push(
      `suites were left out on a "${eventName}" run (scope says "${scope.event}"): only ` +
        'pull_request runs are scoped'
    );
  }
  const recomputed = Object.entries(decide(root, scope.changed ?? []))
    .filter(([, d]) => !d.run)
    .map(([app]) => app)
    .sort();
  if (recomputed.join(',') !== [...skipped].sort().join(',')) {
    problems.push(
      `the scope file left out [${skipped.join(', ')}] but its own changed files leave out ` +
        `[${recomputed.join(', ')}]`
    );
  }
  for (const app of skipped) {
    if (ran.has(app)) {
      problems.push(
        `${app} was declared left out but ran: the --project selection did not leave it out, so the ` +
          'skip mechanism is not doing what this job believes'
      );
    }
  }
  return problems;
}

/**
 * The `--project` arguments that select every app suite except the skipped ones.
 *
 * Nothing skipped gives `--project=app:*`, which is what the job ran before this script existed.
 * Otherwise every app is named, because vitest 4.1 cannot subtract: with `app:*` and
 * `!app:moderator` both given, a project is kept when ANY pattern matches it, so `app:*` keeps
 * moderator (`matchesProjectFilter` is a `some`; the `!` form only removes browser projects).
 * The names come from disk, so a new app is selected without an edit here; one whose `test.name`
 * is not `app:<dir>` is not, and the suites ledger fails on it as MISSING.
 */
export function vitestProjectArgs(root, skipped) {
  if (skipped.length === 0) return ['--project=app:*'];
  return readdirSync(join(root, 'apps'), { withFileTypes: true })
    .filter((e) => e.isDirectory() && !skipped.includes(e.name))
    .filter((e) =>
      ['vitest.config.ts', 'vitest.config.mts'].some((f) =>
        existsSync(join(root, 'apps', e.name, f))
      )
    )
    .map((e) => `--project=app:${e.name}`)
    .sort();
}

function changedFiles(root) {
  const out = execFileSync('git', ['diff', '--name-only', 'HEAD^1', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  });
  return out.split('\n').filter(Boolean);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const outIdx = process.argv.indexOf('--out');
  const outPath = outIdx > -1 ? process.argv[outIdx + 1] : null;
  const event = process.env.GITHUB_EVENT_NAME ?? '';

  let changed = [];
  let skipped = [];
  if (event !== 'pull_request') {
    console.log(`event "${event || '(none)'}": every app suite runs`);
  } else {
    try {
      changed = changedFiles(root);
    } catch (error) {
      console.log(`could not list the PR's changed files (${error.message}); every suite runs`);
    }
    for (const [app, { run, reason }] of Object.entries(decide(root, changed))) {
      console.log(`app:${app}: ${run ? 'runs' : 'SKIPPED'}: ${reason}`);
      if (!run) skipped.push(app);
    }
  }

  const args = vitestProjectArgs(root, skipped).join(' ');
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `vitest_args=${args}\nskipped=${skipped.join(',')}\n`
    );
  }
  if (outPath) writeFileSync(outPath, JSON.stringify({ event, changed, skipped }, null, 2));
  console.log(`vitest_args: ${args}`);
}
