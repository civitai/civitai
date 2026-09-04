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

// 🔴 EVERY LIVE ASSERTION HERE IS VACUOUS IN THE PRIMARY CHECKOUT, so all of them sit behind one
// guard rather than only the last. Run from the primary, `callerProjectRoot` and `primary.path` are
// the same directory — so a `resolveDaemonHome` reverted to plain `__dirname` returns exactly the
// values these expect and the file prints `all passed` over the bug it exists to catch. Guarding
// only the isInside check (the first version of this file) left the two above it reporting PASS.
//
// The banner at the top of this file is addressed to whoever reverts this function; the primary
// checkout is where they will run it, and it is the one place these cannot fire. So say so loudly
// instead of printing a quiet SKIP among PASSes.
if (resolve(projectRoot).toLowerCase() !== resolve(primary.path).toLowerCase()) {
  check('the daemon home is the primary checkout', home.home, primary.path);
  check('the daemon script comes from the primary', home.skillDir, resolve(primary.path, '.claude/skills/dev-server'));
  check('running from a worktree does NOT pin that worktree', isInside(home.skillDir, projectRoot), false);
} else {
  console.log(
    '\n⚠️  VACUOUS HERE — this run is in the PRIMARY checkout, where a reverted resolveDaemonHome\n' +
      '    returns the same values as a correct one. 3 checks skipped. Re-run from a worktree to\n' +
      '    exercise them; a green run here is not evidence about the fix.\n'
  );
}

// Non-vacuous everywhere, including the primary: `fromPrimary` requires `derived && existsSync`, so
// a revert to `__dirname` cannot satisfy it wherever it is run.
check('and it says so', home.fromPrimary, true);

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

const outsideDir = resolve(tree, '../bar/.claude');

const held = await daemonRunningFrom(tree, reply({ pid: 42, skillDir: resolve(tree, '.claude/skills/dev-server'), cwd: outsideDir }));
check('a daemon whose SCRIPT is in the tree is named', held.holder?.pid, 42);
check('and the message says which handle', held.holder?.reason.startsWith('its running script'), true);
check('and the answer is conclusive', held.checked, true);

// 🔴 THE CASE THE FIRST VERSION OF THIS GOT WRONG. A daemon started by hand from inside a worktree
// runs the PRIMARY's script while holding the worktree open through its working directory alone.
// Testing skillDir only answered "not the holder" here — the same confidently-wrong message this
// whole change exists to remove, reintroduced in a narrower case.
const byCwd = await daemonRunningFrom(tree, reply({ pid: 42, skillDir: outsideDir, cwd: resolve(tree, 'src') }));
check('a daemon holding the tree only by CWD is still named', byCwd.holder?.pid, 42);
check('and the message says it was the cwd', byCwd.holder?.reason.startsWith('its working directory'), true);

const elsewhere = await daemonRunningFrom(tree, reply({ pid: 42, skillDir: outsideDir, cwd: outsideDir }));
check('a daemon outside the tree on BOTH handles is not blamed', elsewhere.holder, null);
check('and THAT answer is conclusive too', elsewhere.checked, true);

// An old daemon reports skillDir but no cwd. It must not throw, and must not be blamed on a missing
// field — `undefined` is not inside anything.
const noCwd = await daemonRunningFrom(tree, reply({ pid: 42, skillDir: outsideDir }));
check('a daemon that reports no cwd is not blamed for it', noCwd.holder, null);

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
