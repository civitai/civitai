/**
 * `node .claude/skills/dev-server/scripts/worktree.selftest.mjs`
 *
 * Two reporting defects that made `wt stale` and `wt rm` say the same thing about different
 * situations (868kwae7j, 868kwae5h):
 *
 * - every non-merged branch printed `no merged PR`, so an open PR, a draft, a closed-unmerged PR and
 *   a branch nobody ever opened a PR for were indistinguishable — and that is the line a person reads
 *   before deleting a tree.
 * - `git worktree prune` is repo-wide, so its `-v` output named registrations this command had
 *   nothing to do with. Printed raw, it read as work `wt rm <path>` had just done.
 *
 * A revert fails on the label text, not on a count, so the failing line names the wrong string.
 */

import {
  daemonAnswer,
  daemonBlockReason,
  daemonHeldFrom,
  describePrRows,
  describePrune,
  keepReasons,
  partitionStale,
} from './worktree.mjs';

let failures = 0;
function check(name, actual, expected) {
  const pass = actual === expected;
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}\n        got=${JSON.stringify(actual)}\n       want=${JSON.stringify(expected)}`);
}

check('merged PR', describePrRows([{ number: 4321, state: 'MERGED' }]).label, 'PR #4321 merged');
check('merged PR carries the number', describePrRows([{ number: 4321, state: 'MERGED' }]).merged, 4321);

// The four cases that used to collapse into one string. Each must differ from the others.
check('open PR', describePrRows([{ number: 99, state: 'OPEN', isDraft: false }]).label, 'PR #99 still OPEN');
check('draft PR', describePrRows([{ number: 99, state: 'OPEN', isDraft: true }]).label, 'PR #99 still OPEN (draft)');
check('closed unmerged', describePrRows([{ number: 12, state: 'CLOSED' }]).label, 'PR #12 closed WITHOUT merging');
check('gh found none', describePrRows([]).label, 'gh found no PR for this branch');
// `gh` flips accounts on this box and an unprivileged account answers []. The empty case must not
// claim no PR EXISTS, because deleting a tree on the strength of that is the expensive mistake.
check('and it does not claim none exists', describePrRows([]).label.includes('no PR for'), true);
check('a row with no number', describePrRows([{ state: 'CLOSED' }]).label, 'PR of unknown number closed WITHOUT merging');
check('gh returned a non-array', describePrRows(null).label, 'PR state unknown (gh returned unparseable JSON)');

// None of the four may be treated as removable.
for (const rows of [
  [{ number: 99, state: 'OPEN', isDraft: false }],
  [{ number: 99, state: 'OPEN', isDraft: true }],
  [{ number: 12, state: 'CLOSED' }],
  [],
]) {
  check(`not removable: ${JSON.stringify(rows)}`, describePrRows(rows).merged, null);
}

// A merged row wins even when an older closed PR for the same branch comes back first.
check(
  'merged wins over a closed sibling',
  describePrRows([{ number: 12, state: 'CLOSED' }, { number: 13, state: 'MERGED' }]).label,
  'PR #13 merged'
);

// Every prune line below is git's real wording, captured from `git worktree prune -n -v` in a
// scratch repo on 2026-08-25. `worktree.c` emits `Removing worktrees/<admin>: <reason>` and nothing
// else, so a test of any other shape is a test of a branch no input reaches.
const ADMIN = 'C:\\Dev\\Repos\\work\\model-share\\.git\\worktrees\\mine1';
const REASON = 'gitdir file points to non-existent location';
const PRUNE = [`Removing worktrees/mine1: ${REASON}`, `Removing worktrees/mine: ${REASON}`].join('\n');

const pruned = describePrune(PRUNE, ADMIN);
check('the target is not marked collateral', pruned[0], `pruned: Removing worktrees/mine1: ${REASON}`);
check(
  'somebody else\u2019s tree IS marked collateral',
  pruned[1],
  `pruned (ALSO, not your target): Removing worktrees/mine: ${REASON}`
);
check('and the count is stated', pruned[2], 'note: 1 of those registration(s) were stale before this command ran - prune is repo-wide');
check('no collateral note when there is none', describePrune(`Removing worktrees/mine1: ${REASON}`, ADMIN).length, 1);

// The finding this pair exists for: `git worktree add` de-duplicates a colliding BASENAME by
// appending a digit, so two live trees both called `mine` register as `mine` and `mine1`. Matching
// on the worktree's basename cannot tell them apart, and marks one agent's tree as the other's.
check(
  'the sibling that shares a basename is collateral',
  describePrune(`Removing worktrees/mine: ${REASON}`, ADMIN)[0],
  `pruned (ALSO, not your target): Removing worktrees/mine: ${REASON}`
);
check(
  'and matching runs on the ADMIN name, not the path',
  describePrune(`Removing worktrees/mine1: ${REASON}`, 'C:/anywhere/else/.git/worktrees/mine1')[0],
  `pruned: Removing worktrees/mine1: ${REASON}`
);

// On a case-sensitive filesystem `Mine` and `mine` are two different trees, and both sides here are
// git's own spelling of one directory, so the comparison must not fold case.
check(
  'a tree differing only in case is somebody else\u2019s',
  describePrune(`Removing worktrees/mine1: ${REASON}`, 'C:/x/.git/worktrees/Mine1')[0],
  `pruned (ALSO, not your target): Removing worktrees/mine1: ${REASON}`
);

// Unattributable rather than guessed: a line is never credited to the target on a hunch.
check(
  'no admin name means no attribution',
  describePrune(`Removing worktrees/mine1: ${REASON}`, null)[0],
  `pruned (could not tell whose): Removing worktrees/mine1: ${REASON}`
);
check(
  'and that is called out',
  describePrune(`Removing worktrees/mine1: ${REASON}`, null)[1],
  'note: 1 line(s) could not be attributed - prune is repo-wide, so do not read them as this removal'
);
check(
  'a line in some other shape is not credited either',
  describePrune('Something git has never printed', ADMIN)[0],
  'pruned (could not tell whose): Something git has never printed'
);
check('empty prune output says so', describePrune('', ADMIN)[0], 'pruned: no stale worktree registrations');

// 868kzk7pf: `wt stale` called a tree safe while the daemon ran out of it, because it asked about
// dev servers and never about the daemon's own home. HELD, ruled out, and never asked — the last
// two used to print the same nothing.
const TREE = 'C:/Dev/Repos/work/worktrees/mine';
const PRIMARY = 'C:/Dev/Repos/work/model-share';
const skill = (root) => `${root}/.claude/skills/dev-server`;
const root = (data) => ({ ok: true, status: 200, data });
const AT_PRIMARY = root({ pid: 7, skillDir: skill(PRIMARY), cwd: PRIMARY });
const IN_TREE = root({ pid: 7, skillDir: skill(TREE), cwd: PRIMARY });
const TOO_OLD = root({ pid: 46332 });
const DOWN = { ok: false, status: 0 };
const ERRORING = { ok: false, status: 500 };

check(
  'a daemon whose script is in the tree is the holder',
  daemonHeldFrom(IN_TREE, TREE).holder?.reason,
  `its running script: ${skill(TREE)}`
);
// Started by hand from inside the tree: it runs the primary's script and pins by cwd alone.
check(
  'and so is one merely CWD’d there',
  daemonHeldFrom(root({ pid: 7, skillDir: skill(PRIMARY), cwd: TREE }), TREE).holder?.reason,
  `its working directory: ${TREE}`
);
check('a daemon at the primary holds nothing', daemonHeldFrom(AT_PRIMARY, TREE).holder, null);
check('and that verdict is a checked one', daemonHeldFrom(AT_PRIMARY, TREE).checked, true);
// The live case on 2026-09-09: pid 46332 predates PR #4641, so `/` answers with a bare pid.
check('a daemon too old to report is NOT ruled out', daemonHeldFrom(TOO_OLD, TREE).checked, false);
check('and it IS running', daemonHeldFrom(TOO_OLD, TREE).reachable, true);
// The one unknown that rules itself out: a daemon that does not answer is not running, and a daemon
// that is not running holds no directory. Without this a box with no daemon clears no tree, ever.
check('a daemon that never answered is not running', daemonHeldFrom(DOWN, TREE).reachable, false);
// A path prefix is not a path segment: without segment-wise matching, a daemon in `…/mine1` reads
// as holding `…/mine` and blames the wrong agent's tree.
check(
  'a sibling sharing a path prefix is not this tree',
  daemonHeldFrom(root({ pid: 7, skillDir: skill(`${TREE}1`), cwd: `${TREE}1` }), TREE).holder,
  null
);

check(
  'the holder blocks removal, naming the pid',
  daemonBlockReason(daemonHeldFrom(IN_TREE, TREE)),
  `hosts the dev-server daemon (pid 7) - its running script: ${skill(TREE)}`
);
check('a ruled-out daemon blocks nothing', daemonBlockReason(daemonHeldFrom(AT_PRIMARY, TREE)), null);
check(
  'and an unanswered check blocks removal too',
  daemonBlockReason(daemonHeldFrom(TOO_OLD, TREE))?.includes('NOT ruled out'),
  true
);
check('but a daemon that is down blocks nothing', daemonBlockReason(daemonHeldFrom(DOWN, TREE)), null);
// `reachable` turns on the transport, not on `ok`. A live daemon that 500s on `/` — one session's
// status throwing is enough — arrives as ok:false too, and reading that as "no daemon is running"
// hands back the same confidently-wrong verdict from a rarer cause.
check('a daemon that answered 500 IS running', daemonHeldFrom(ERRORING, TREE).reachable, true);
check(
  'so it blocks removal like any other silent one',
  daemonBlockReason(daemonHeldFrom(ERRORING, TREE))?.includes('NOT ruled out'),
  true
);

// The decision `wt stale` prints, over rows `inspect` would have built. Without these the filter and
// the banner condition are covered by nothing — swapping `every` for `some` at the banner, or
// dropping the daemon term from the filter, both stay green on the helpers alone.
const row = (over) => ({
  path: TREE,
  branch: 'feat/mine',
  isPrimary: false,
  mergedPr: 4321,
  prLabel: 'PR #4321 merged',
  dirty: 0,
  sessions: [],
  daemon: daemonHeldFrom(AT_PRIMARY, TREE),
  ...over,
});
const PRIME = row({ path: PRIMARY, isPrimary: true, daemon: daemonHeldFrom(AT_PRIMARY, PRIMARY) });

check('a merged, clean, unheld tree is offered', partitionStale([PRIME, row({})], daemonAnswer(AT_PRIMARY)).removable.length, 1);
check(
  'the same tree is NOT offered when the daemon lives in it',
  partitionStale([PRIME, row({ daemon: daemonHeldFrom(IN_TREE, TREE) })], daemonAnswer(IN_TREE)).removable.length,
  0
);
check(
  'nor when no running daemon would say',
  partitionStale([PRIME, row({ daemon: daemonHeldFrom(TOO_OLD, TREE) })], daemonAnswer(TOO_OLD)).removable.length,
  0
);
// The regression this pair exists for: a down daemon must not zero the command.
check(
  'but a down daemon offers it as before',
  partitionStale([PRIME, row({ daemon: daemonHeldFrom(DOWN, TREE) })], daemonAnswer(DOWN)).removable.length,
  1
);
check(
  'and the primary is never a candidate',
  partitionStale([PRIME, row({})], daemonAnswer(AT_PRIMARY)).candidates.length,
  1
);

// The banner is one fact about the daemon, so it fires only when NO row could be cleared of it —
// never for a single held tree, which is named on its own row instead.
check(
  'the banner fires when nothing could be asked',
  partitionStale([PRIME, row({ daemon: daemonHeldFrom(TOO_OLD, TREE) })], daemonAnswer(TOO_OLD)).daemonUnasked,
  true
);
check(
  'but not for a daemon that answered and named one tree',
  partitionStale([PRIME, row({ daemon: daemonHeldFrom(IN_TREE, TREE) })], daemonAnswer(IN_TREE)).daemonUnasked,
  false
);
check('nor when the daemon answered and there is nothing to judge', partitionStale([PRIME], daemonAnswer(AT_PRIMARY)).daemonUnasked, false);
// Read from the daemon, not tallied out of the rows: a box holding only the primary checkout has no
// candidates to tally, and used to print no banner while `wt rm` refused on that same daemon.
check(
  'the banner still fires with no candidate trees at all',
  partitionStale([PRIME], daemonAnswer(TOO_OLD)).daemonUnasked,
  true
);

check(
  'a held tree says so, with the pid',
  keepReasons(row({ daemon: daemonHeldFrom(IN_TREE, TREE) }), false)[0],
  `hosts the dev-server daemon (pid 7) - its running script: ${skill(TREE)}`
);
check(
  'and defers to the banner when there is one',
  keepReasons(row({ daemon: daemonHeldFrom(TOO_OLD, TREE) }), true).join('; '),
  'daemon NOT ruled out (see above)'
);
// Every other reason survives alongside it; the daemon term is added, not substituted.
check(
  'the other reasons are still all there',
  keepReasons(row({ dirty: 3, mergedPr: null, prLabel: 'PR #9 still OPEN', sessions: [{ id: 'a', port: 3001 }], daemon: daemonHeldFrom(IN_TREE, TREE) }), false).length,
  4
);

console.log(failures ? `\n${failures} FAILURES` : '\nall green');
process.exit(failures ? 1 : 0);
