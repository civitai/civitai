/**
 * `node .claude/skills/dev-server/scripts/daemon-home.selftest.mjs`
 *
 * ONE daemon serves every worktree, so it must not live inside one.
 *
 * 🔴 TO WHOEVER IS ABOUT TO SIMPLIFY `resolveDaemonHome` BACK TO `__dirname`: that is where it
 * started, and it is why `wt rm` failed EBUSY on whichever tree happened to start the daemon first.
 * The skill directory is committed, so every worktree has a copy of it, and a daemon spawned from
 * one holds that directory open — cwd and running script both — for its entire life. The agent who
 * finishes their PR first is the one who cannot clean up. Observed 2026-09-04: pid 46332 running
 * `daemon.mjs` out of `worktrees/profile-remix-flyout`, pinning a tree whose PR had merged.
 *
 * The failures below name the wrong PATH, not a count, so a revert reads as a path in a worktree
 * where the primary checkout was wanted.
 */

import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, resolve, sep } from 'path';
import { fileURLToPath } from 'url';
import { isInside, resolveDaemonHome, resolvePrimaryCheckout } from './paths.mjs';
import { daemonRunningFrom } from './worktree.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const skillDir = resolve(__dirname, '..');
const projectRoot = resolve(skillDir, '../../..');

let failures = 0;
function check(name, actual, expected) {
  const pass = actual === expected;
  if (!pass) failures++;
  console.log(
    `${pass ? 'PASS' : 'FAIL'}  ${name}\n        got=${JSON.stringify(actual)}\n       want=${JSON.stringify(expected)}`
  );
}

// --- the primary, resolved from wherever this copy of the skill happens to live ---

const primary = resolvePrimaryCheckout(projectRoot);
// First, because it changes what every check below MEANS: outside a git repo the resolution falls
// back to the caller's own root and the assertions would then be comparing a tree to itself.
check('the primary was derived from git, not fallen back', primary.derived, true);
if (!primary.derived) {
  console.error(`  (fell back to ${primary.path}: ${primary.error})`);
}

const gitCommonDir = execFileSync(
  'git',
  ['rev-parse', '--path-format=absolute', '--git-common-dir'],
  { cwd: projectRoot, encoding: 'utf8', windowsHide: true }
).trim();
check('it is the checkout that owns .git', primary.path, resolve(gitCommonDir, '..'));

// --- the whole point: run from a worktree, get the primary ---

const home = resolveDaemonHome(skillDir, projectRoot);
check('the daemon home is the primary checkout', home.home, primary.path);
check('the daemon script comes from the primary', home.skillDir, resolve(primary.path, '.claude/skills/dev-server'));
check('and it says so', home.fromPrimary, true);

// The assertion that actually fails on a revert to `__dirname`, stated as the property rather than
// as a path: run this selftest from a worktree and the home must not be that worktree. In the
// primary checkout the two are legitimately equal, so this can only fail where it can fire.
if (resolve(projectRoot).toLowerCase() !== resolve(primary.path).toLowerCase()) {
  check('running from a worktree does NOT pin that worktree', isInside(home.skillDir, projectRoot), false);
} else {
  console.log('SKIP  running from a worktree does NOT pin that worktree (this IS the primary)');
}

// --- the fallback, which must never leave the caller without a daemon ---

const outside = mkdtempSync(resolve(tmpdir(), 'daemon-home-'));
try {
  const stray = resolveDaemonHome(resolve(outside, '.claude/skills/dev-server'), outside);
  // Outside a repository git answers nothing. A daemon in the caller's own tree is wrong; NO daemon
  // is worse, so the fallback is the caller's tree and `fromPrimary` is what says it is a fallback.
  check('outside a repo it falls back to the caller', stray.home, resolve(outside));
  check('and does not claim the primary', stray.fromPrimary, false);
} finally {
  rmSync(outside, { recursive: true, force: true });
}

// --- isInside, which decides whether `wt rm` blames the daemon ---

const base = resolve('C:' + sep + 'Dev', 'Repos', 'work', 'worktrees', 'foo');
check('a directory is inside itself', isInside(base, base), true);
check('a child is inside', isInside(resolve(base, '.claude/skills'), base), true);
// startsWith would call this a child, and `wt rm foo` would then blame a daemon in `foo-old`.
check('a name-prefixed SIBLING is not', isInside(base + '-old', base), false);
check('a parent is not inside its child', isInside(base, resolve(base, '.claude')), false);
if (process.platform === 'win32') {
  check('drive letter casing does not matter', isInside(base.toLowerCase(), base.toUpperCase()), true);
}

// --- what `wt rm` is allowed to CLAIM about the daemon ---
//
// Three outcomes, not two. "no holder" and "could not tell" print different failure text, because
// the message this replaced asserted a stray shell was to blame in a case where nothing had been
// checked at all. A live paired control covers the first two (a worktree-resident daemon is named;
// a daemon elsewhere is not), but only a fake can produce the third on demand.
const reply = (data) => async () => (data === null ? { ok: false } : { ok: true, data });
const tree = resolve('C:' + sep + 'Dev', 'Repos', 'work', 'worktrees', 'foo');

const held = await daemonRunningFrom(tree, reply({ pid: 42, skillDir: resolve(tree, '.claude/skills/dev-server') }));
check('a daemon inside the tree is named', held.holder?.pid, 42);
check('and the answer is conclusive', held.checked, true);

const elsewhere = await daemonRunningFrom(tree, reply({ pid: 42, skillDir: resolve(tree, '../bar/.claude') }));
check('a daemon outside the tree is not blamed', elsewhere.holder, null);
check('and THAT answer is conclusive too', elsewhere.checked, true);

for (const [name, res] of [
  ['a daemon that is down', reply(null)],
  ['a daemon too old to report skillDir', reply({ pid: 42 })],
]) {
  const unknown = await daemonRunningFrom(tree, res);
  check(`${name} yields no holder`, unknown.holder, null);
  // The one that matters: unknown must not read as innocent.
  check(`${name} does NOT count as checked`, unknown.checked, false);
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
