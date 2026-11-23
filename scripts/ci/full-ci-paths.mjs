#!/usr/bin/env node
/**
 * Would a workflow's own `paths:` filter have run it for this PR? full-ci.yml asks this before it
 * dispatches a draft-gated workflow on a labelled draft PR, so the label lifts the DRAFT gate and
 * nothing else: a workflow whose filter the PR cannot reach is not dispatched, exactly as its own
 * pull_request run would not have started.
 *
 * Before this, the label dispatched all nine on every labelled draft, unfiltered: a one-line
 * change under src/ started four Go services, the moderator boot and two image builds that no
 * file in the PR could affect.
 *
 * The filter is read from the workflow's own `on:`, from the PR's copy of the file (full-ci.yml
 * checks out the PR's merge commit), so a PR that widens a filter is judged by its widened list:
 *   - `on.pull_request` present: its `paths` / `paths-ignore`. A bare `pull_request:` (null) or
 *     one with neither key has no filter: run.
 *   - no `pull_request` trigger: `on.push`, the same way (a workflow that runs on `main` only
 *     still says which files it reads there).
 *   - neither: no filter to read: run.
 *
 * GitHub's filter semantics (docs: "Filter pattern cheat sheet"), which a bash `[[ == ]]` glob does
 * NOT have (its `*` crosses `/`, so `packages/*\/package.json` would match too much):
 *   `*` any characters but `/`; `**` any characters including `/` (`**\/` also matches no
 *   directory at all); `?` zero or one of the preceding character; `+` one or more of it;
 *   `[...]` a character class; a leading `!` negates. Patterns are applied in order and the last
 *   one that matches a file decides it, so a `!` after a positive excludes, and a positive after
 *   a `!` includes again.
 *   `paths`: run when at least one changed file ends up included.
 *   `paths-ignore`: run when at least one changed file does NOT end up ignored.
 *
 * FAILS OPEN. Anything this cannot read means run: an unreadable `on:`, an empty or unreadable
 * file list (a PR always changes at least one file, so an empty list is a failed lookup), and a
 * list at GitHub's 3000-file cap for the PR files API (files past it are not listed).
 *
 * Usage:  node scripts/ci/full-ci-paths.mjs <changed-files.txt> <on.json>
 *         <changed-files.txt>: one path per line (renames: both names). <on.json>: the
 *         workflow's `on:` as JSON (`yq -o=json '.on' <file>`). Prints `run <reason>` or
 *         `skip <reason>` and exits 0; exits 1 on a usage error (the caller then dispatches).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** GitHub lists at most this many files for a PR; at the cap the list may be incomplete. */
export const FILES_CAP = 3000;

/** One filter pattern (without its `!`) as an anchored RegExp, per the semantics above. */
export function patternToRegExp(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\' && i + 1 < pattern.length) {
      re += escape(pattern[++i]);
    } else if (c === '*') {
      if (pattern[i + 1] === '*') {
        i++;
        if (pattern[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?' || c === '+') {
      // A quantifier on the preceding character. A leading one has nothing to quantify, so it is
      // the literal character.
      re += re === '' ? escape(c) : c;
    } else if (c === '[') {
      const end = pattern.indexOf(']', i + 1);
      if (end === -1) {
        re += '\\[';
      } else {
        re += `[${pattern.slice(i + 1, end).replace(/\\/g, '\\\\')}]`;
        i = end;
      }
    } else {
      re += escape(c);
    }
  }
  return new RegExp(`^${re}$`);
}

function escape(c) {
  return c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/** Is `file` selected by an ordered pattern list? The last matching pattern decides. */
export function selected(file, patterns) {
  let hit = false;
  for (const raw of patterns) {
    const negated = raw.startsWith('!');
    const pattern = negated ? raw.slice(1) : raw;
    if (patternToRegExp(pattern).test(file)) hit = !negated;
  }
  return hit;
}

/**
 * Which trigger's filter applies, from a workflow's `on:` (already parsed). Returns
 * { filter: { paths?: string[], 'paths-ignore'?: string[] } | null, source } where a null
 * filter means "no filter: run".
 */
export function filterOf(on) {
  if (!on || typeof on !== 'object' || Array.isArray(on)) return { filter: null, source: 'on:' };
  for (const source of ['pull_request', 'push']) {
    if (!(source in on)) continue;
    const t = on[source];
    if (!t || typeof t !== 'object') return { filter: null, source };
    if (!Array.isArray(t.paths) && !Array.isArray(t['paths-ignore']))
      return { filter: null, source };
    return { filter: t, source };
  }
  return { filter: null, source: 'on:' };
}

/**
 * Would the workflow run for these changed files? Returns { run, reason }.
 * @param {string[] | null} files  the PR's changed files; null when they could not be read
 * @param {unknown} on             the workflow's `on:`; undefined when it could not be read
 */
export function decide(files, on) {
  if (on === undefined) return { run: true, reason: "could not read the workflow's on: block" };
  if (!files || files.length === 0)
    return { run: true, reason: "could not read the PR's changed files" };
  if (files.length >= FILES_CAP)
    return { run: true, reason: `the PR lists ${files.length} files, GitHub's cap; not filtered` };
  const { filter, source } = filterOf(on);
  if (!filter) return { run: true, reason: `${source} has no paths filter` };
  if (Array.isArray(filter.paths)) {
    const f = files.find((x) => selected(x, filter.paths));
    return f
      ? { run: true, reason: `${f} matches on.${source}.paths` }
      : { run: false, reason: `no changed file matches on.${source}.paths` };
  }
  const f = files.find((x) => !selected(x, filter['paths-ignore']));
  return f
    ? { run: true, reason: `${f} is outside on.${source}.paths-ignore` }
    : { run: false, reason: `every changed file matches on.${source}.paths-ignore` };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [filesPath, onPath] = process.argv.slice(2);
  if (!filesPath || !onPath) {
    console.error('usage: full-ci-paths.mjs <changed-files.txt> <on.json>');
    process.exit(1);
  }
  let files = null;
  try {
    files = readFileSync(filesPath, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    files = null;
  }
  let on;
  try {
    on = JSON.parse(readFileSync(onPath, 'utf8'));
  } catch {
    on = undefined;
  }
  const { run, reason } = decide(files, on);
  console.log(`${run ? 'run' : 'skip'} ${reason}`);
}
