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

import { describePrRows, describePrune } from './worktree.mjs';

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

console.log(failures ? `\n${failures} FAILURES` : '\nall green');
process.exit(failures ? 1 : 0);
