#!/usr/bin/env node
/**
 * GitHub's `on.pull_request.paths` / `paths-ignore` filter, evaluated outside GitHub: would a
 * pull_request run of a workflow start, given the PR's changed files?
 *
 * full-ci.yml uses it (`decide`) to dispatch a workflow only when the PR's own run of it would
 * start and would be stopped by the draft gate the label lifts: on a draft PR, when a changed
 * file passes the workflow's filter (a dispatch is never path-filtered, so without this it ran
 * suites on PRs that cannot affect them); on a ready PR, never. The filter is read from the
 * workflow file itself, so the list lives in one place. assert-apps-paths-filter.mjs uses the
 * glob matcher for the same reason.
 *
 * GitHub's rules, as documented under "Filter pattern cheat sheet" and "paths":
 *   - `*` matches any characters but `/`; `**` matches any characters; a `**` followed by `/`
 *     also matches zero directories (`docs/**\/*.md` matches `docs/a.md`).
 *   - `paths`: the run starts when some changed file matches. Patterns are read in order, and
 *     the last one that matches a file decides it: a `!pattern` excludes, a plain one includes.
 *   - `paths-ignore`: the run starts unless every changed file is ignored (same ordering rule,
 *     a `!pattern` un-ignores).
 *   - no filter: the run starts.
 * Not supported here: `?`, `+`, `[]`, `{}` (no workflow in this repo uses them). Such a pattern
 * throws, and every caller treats a throw as "it would run".
 *
 * The workflow file is read by a small YAML reader for this one block, not a YAML library: the
 * job that calls it installs no packages. It understands block lists of plain or quoted scalars
 * (an `&anchor` on the key is allowed) and throws on anything else; a test checks it against a
 * full YAML parser on every workflow in `.github/workflows`.
 *
 * Usage:  node scripts/ci/github-paths-filter.mjs --draft <true|false> --changed <file> <workflow.yml>...
 *   <file> holds one changed path per line (the PR files API's `filename`, and
 *   `previous_filename` for a rename). `--draft false` skips every workflow (see `decide`).
 *   Prints one line per workflow:
 *     <workflow path> TAB run|skip TAB <reason>
 *   Any error for a workflow (unreadable file, unsupported YAML or glob) prints `run` with the
 *   error as the reason; an unreadable or empty changed-file list prints `run` for every one.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The PR files API lists at most this many files. A list this long may be cut short, so a
 * decision made from it could miss the one file that matches: every workflow runs.
 */
export const MAX_LISTED_FILES = 3000;

/** GitHub `paths` glob (without a leading `!`) -> RegExp. Throws on syntax not handled here. */
export function globToRegExp(pattern) {
  if (/[?[\]{}!+]/.test(pattern)) {
    throw new Error(`unsupported glob syntax in "${pattern}" (only * and ** are handled here)`);
  }
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i++;
      }
    } else if (c === '*') {
      re += '[^/]*';
    } else {
      re += c.replace(/[.^$|()\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

/** Does `file` match the ordered pattern list, `!` negations included (last match wins)? */
export function matchesPatterns(file, patterns) {
  let matched = false;
  for (const p of patterns) {
    const negated = p.startsWith('!');
    if (globToRegExp(negated ? p.slice(1) : p).test(file)) matched = !negated;
  }
  return matched;
}

/**
 * @typedef {{ kind: 'none' } | { kind: 'paths' | 'paths-ignore'; patterns: string[] }} Filter
 */

/**
 * Would a pull_request run start for these changed files? Throws on an unsupported pattern.
 * @param {Filter} filter
 * @param {string[]} files
 */
export function wouldRun(filter, files) {
  if (filter.kind === 'none') return true;
  if (filter.kind === 'paths') return files.some((f) => matchesPatterns(f, filter.patterns));
  return files.some((f) => !matchesPatterns(f, filter.patterns));
}

const indentOf = (line) => line.length - line.trimStart().length;
const isBlankOrComment = (line) => /^\s*(#.*)?$/.test(line);

/** One YAML scalar as a list item or key value: plain, 'single' or "double" (no escapes). */
function scalar(text, where) {
  const t = text.trim();
  if (t.startsWith("'")) {
    const m = /^'((?:[^']|'')*)'\s*(#.*)?$/.exec(t);
    if (!m) throw new Error(`unreadable single-quoted scalar at ${where}`);
    return m[1].replace(/''/g, "'");
  }
  if (t.startsWith('"')) {
    const m = /^"([^"\\]*)"\s*(#.*)?$/.exec(t);
    if (!m) throw new Error(`unreadable double-quoted scalar at ${where}`);
    return m[1];
  }
  if (/^[&*!|>@`[{]/.test(t)) throw new Error(`unsupported YAML value "${t}" at ${where}`);
  const plain = t.replace(/\s+#.*$/, '');
  if (plain === '' || /:(\s|$)/.test(plain)) throw new Error(`unsupported item "${t}" at ${where}`);
  return plain;
}

/**
 * The block under `key:` among the children of `lines[start..end)` at indent `indent`.
 * Returns the key's line index, or -1. Throws if the key is given an inline value other than
 * an anchor or a comment.
 */
function findKey(lines, start, end, indent, key) {
  for (let i = start; i < end; i++) {
    const line = lines[i];
    if (isBlankOrComment(line) || indentOf(line) !== indent) continue;
    const m = /^\s*(?:'([^']*)'|"([^"]*)"|([^\s'"#:][^:#]*?))\s*:(.*)$/.exec(line);
    if (!m) continue;
    const name = m[1] ?? m[2] ?? m[3];
    if (name !== key) continue;
    return i;
  }
  return -1;
}

/** End (exclusive) of the block of children under the key on line `i`. */
function blockEnd(lines, i) {
  const indent = indentOf(lines[i]);
  let j = i + 1;
  for (; j < lines.length; j++) {
    if (isBlankOrComment(lines[j])) continue;
    if (indentOf(lines[j]) <= indent && !lines[j].trimStart().startsWith('- ')) break;
    if (indentOf(lines[j]) < indent) break;
  }
  return j;
}

/** The inline part after `key:` on line `i`, with an `&anchor` and a comment allowed. */
function inlineValue(line) {
  const after = line.slice(line.indexOf(':') + 1).trim();
  return after
    .replace(/^&[\w-]+\s*/, '')
    .replace(/^#.*$/, '')
    .trim();
}

/** First child indent of the block starting after line `i`, or -1 if it has none. */
function childIndent(lines, i, end) {
  for (let j = i + 1; j < end; j++) if (!isBlankOrComment(lines[j])) return indentOf(lines[j]);
  return -1;
}

/**
 * The `on.pull_request` path filter of a workflow file's text. Throws on YAML this reader does
 * not handle (tabs, flow lists, aliases, both `paths` and `paths-ignore`).
 * @param {string} text
 * @returns {Filter}
 */
export function readPullRequestFilter(text) {
  const lines = text.split(/\r?\n/);
  if (lines.some((l) => /^\s*\t/.test(l))) throw new Error('tab indentation is not supported');
  const on = findKey(lines, 0, lines.length, 0, 'on');
  if (on === -1) throw new Error('no top-level `on:` key');
  const onInline = inlineValue(lines[on]);
  if (onInline !== '') {
    // `on: pull_request` / `on: [push, pull_request]`: no filter is possible inline.
    return { kind: 'none' };
  }
  const onEnd = blockEnd(lines, on);
  const onChild = childIndent(lines, on, onEnd);
  if (onChild <= 0) throw new Error('`on:` has no children');
  const pr = findKey(lines, on + 1, onEnd, onChild, 'pull_request');
  if (pr === -1) return { kind: 'none' };
  const prInline = inlineValue(lines[pr]);
  if (prInline !== '' && prInline !== 'null' && prInline !== '~' && prInline !== '{}') {
    throw new Error(`unsupported inline value for pull_request: "${prInline}"`);
  }
  const prEnd = blockEnd(lines, pr);
  const prChild = childIndent(lines, pr, prEnd);
  if (prChild <= onChild) return { kind: 'none' };
  const found = ['paths', 'paths-ignore']
    .map((key) => ({ key, i: findKey(lines, pr + 1, prEnd, prChild, key) }))
    .filter((k) => k.i !== -1);
  if (found.length === 0) return { kind: 'none' };
  if (found.length > 1) throw new Error('both paths and paths-ignore are set');
  const { key, i } = found[0];
  if (inlineValue(lines[i]) !== '') {
    throw new Error(`unsupported inline value for ${key}: "${inlineValue(lines[i])}"`);
  }
  const patterns = [];
  const keyIndent = indentOf(lines[i]);
  for (let j = i + 1; j < lines.length; j++) {
    const line = lines[j];
    if (isBlankOrComment(line)) continue;
    const item = /^(\s*)- (.*)$/.exec(line);
    if (!item || item[1].length < keyIndent) break;
    patterns.push(scalar(item[2], `line ${j + 1}`));
  }
  if (patterns.length === 0) throw new Error(`${key} has no list items`);
  return { kind: /** @type {'paths' | 'paths-ignore'} */ (key), patterns };
}

export const NOT_DRAFT_REASON =
  'the PR is not a draft, so its own run of this workflow on this commit is not draft-gated';

/**
 * Should full-ci.yml dispatch this workflow? Never throws: an error means `run`.
 *
 * `draft` is the PR's draft flag as the event payload gives it (`'true'` / `'false'`). Only an
 * exact `'false'` skips on that ground: the label changes nothing in the workflows full-ci.yml
 * dispatches but their draft gate, so on a ready PR their own PR run on this commit already runs
 * (or skips by its paths filter) the same jobs, on the merge commit rather than the branch head
 * (and apps.yml's run with its PR-only moderator scoping). Anything else is treated as a draft
 * and goes to the paths filter.
 *
 * @param {string} text the workflow file's contents
 * @param {string[]} files changed files
 * @param {{ draft?: string }} [pr]
 * @returns {{ run: boolean; reason: string }}
 */
export function decide(text, files, pr = {}) {
  if (pr.draft === 'false') return { run: false, reason: NOT_DRAFT_REASON };
  try {
    if (files.length === 0) return { run: true, reason: 'no changed files listed; failing open' };
    if (files.length >= MAX_LISTED_FILES) {
      return {
        run: true,
        reason: `${files.length} changed files, list may be cut short; failing open`,
      };
    }
    const filter = readPullRequestFilter(text);
    if (filter.kind === 'none') return { run: true, reason: 'no pull_request paths filter' };
    return wouldRun(filter, files)
      ? { run: true, reason: `a changed file passes its pull_request ${filter.kind} filter` }
      : { run: false, reason: `no changed file passes its pull_request ${filter.kind} filter` };
  } catch (err) {
    return {
      run: true,
      reason: `filter check failed (${err instanceof Error ? err.message : err}); failing open`,
    };
  }
}

/** `--name value` from argv, and argv without it. */
function takeFlag(argv, name) {
  const at = argv.indexOf(name);
  if (at === -1) return { value: undefined, rest: argv };
  return { value: argv[at + 1], rest: argv.filter((_, k) => k !== at && k !== at + 1) };
}

function main(args) {
  const { value: draft, rest: afterDraft } = takeFlag(args, '--draft');
  const { value: changedPath, rest: workflows } = takeFlag(afterDraft, '--changed');
  let files = [];
  let listError = '';
  if (!changedPath) listError = 'no --changed file given';
  else {
    try {
      files = readFileSync(changedPath, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
    } catch (err) {
      listError = `changed-file list unreadable (${err instanceof Error ? err.message : err})`;
    }
  }
  for (const wf of workflows) {
    let result;
    if (draft === 'false') result = decide('', [], { draft });
    else if (listError) result = { run: true, reason: `${listError}; failing open` };
    else {
      try {
        result = decide(readFileSync(wf, 'utf8'), files, { draft });
      } catch (err) {
        result = {
          run: true,
          reason: `workflow unreadable (${err instanceof Error ? err.message : err}); failing open`,
        };
      }
    }
    process.stdout.write(
      `${wf}\t${result.run ? 'run' : 'skip'}\t${result.reason.replace(/[\t\n]/g, ' ')}\n`
    );
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main(process.argv.slice(2));
