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

import { daemonBlockReason, daemonHeldFrom, describePrRows, describePrune } from './worktree.mjs';

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
// dev servers and never about the daemon's own home. These pin the three answers apart — HELD, and
// the two that both used to print nothing: ruled out, and never asked.
const TREE = 'C:\\Dev\\Repos\\work\\worktrees\\mine';
const PRIMARY = 'C:\\Dev\\Repos\\work\\model-share';
const skill = (root) => `${root}\\.claude\\skills\\dev-server`;
const root = (data) => ({ ok: true, data });

check(
  'a daemon whose script is in the tree is the holder',
  daemonHeldFrom(root({ pid: 7, skillDir: skill(TREE), cwd: PRIMARY }), TREE).holder?.reason,
  `its running script: ${skill(TREE)}`
);
// Started by hand from inside the tree: it runs the primary's script and pins by cwd alone. Checking
// only skillDir reports that tree as free while a delete on it cannot succeed.
check(
  'and so is one merely CWD\u2019d there',
  daemonHeldFrom(root({ pid: 7, skillDir: skill(PRIMARY), cwd: TREE }), TREE).holder?.reason,
  `its working directory: ${TREE}`
);
check(
  'a daemon at the primary holds nothing',
  daemonHeldFrom(root({ pid: 7, skillDir: skill(PRIMARY), cwd: PRIMARY }), TREE).holder,
  null
);
check(
  'and that verdict is a checked one',
  daemonHeldFrom(root({ pid: 7, skillDir: skill(PRIMARY), cwd: PRIMARY }), TREE).checked,
  true
);
// The live case on 2026-09-09: pid 46332 predates PR #4641, so `/` answers with a bare pid. No
// holder is reported and none has been ruled out either.
check(
  'a daemon too old to report is NOT ruled out',
  daemonHeldFrom(root({ pid: 46332 }), TREE).checked,
  false
);
check('nor is an unreachable one', daemonHeldFrom({ ok: false }, TREE).checked, false);
// `worktrees/mine1` is a real neighbour of `worktrees/mine` here — git de-duplicates a colliding
// basename that way — so a prefix match would blame the wrong agent's tree.
check(
  'a sibling sharing a path prefix is not this tree',
  daemonHeldFrom(root({ pid: 7, skillDir: skill(`${TREE}1`), cwd: `${TREE}1` }), TREE).holder,
  null
);

check(
  'the holder blocks removal, naming the pid',
  daemonBlockReason(daemonHeldFrom(root({ pid: 7, skillDir: skill(TREE), cwd: PRIMARY }), TREE)),
  `hosts the dev-server daemon (pid 7) - its running script: ${skill(TREE)}`
);
check(
  'a ruled-out daemon blocks nothing',
  daemonBlockReason(daemonHeldFrom(root({ pid: 7, skillDir: skill(PRIMARY), cwd: PRIMARY }), TREE)),
  null
);
// The whole ticket in one assertion: unknown must not read as no.
check(
  'and an unanswered check blocks removal too',
  daemonBlockReason(daemonHeldFrom(root({ pid: 46332 }), TREE))?.includes('NOT ruled out'),
  true
);

console.log(failures ? `\n${failures} FAILURES` : '\nall green');
process.exit(failures ? 1 : 0);
