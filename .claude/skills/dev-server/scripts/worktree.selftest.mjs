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
check('no PR at all', describePrRows([]).label, 'no PR opened for this branch');
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

const TARGET = 'C:\\Dev\\Repos\\work\\worktrees\\mine';
const PRUNE = [
  'Removing worktrees/mine: gitdir file points to non-existent location',
  'Removing worktrees/somebody-else: gitdir file points to non-existent location',
].join('\n');

const pruned = describePrune(PRUNE, TARGET);
check('the target is not marked collateral', pruned[0], 'pruned: Removing worktrees/mine: gitdir file points to non-existent location');
check(
  'somebody else\u2019s tree IS marked collateral',
  pruned[1],
  'pruned (ALSO, not your target): Removing worktrees/somebody-else: gitdir file points to non-existent location'
);
check('and the count is stated', pruned[2], 'note: 1 of those registration(s) were stale before this command ran - prune is repo-wide');
check('no collateral note when there is none', describePrune('Removing worktrees/mine: x', TARGET).length, 1);
check('empty prune output says so', describePrune('', TARGET)[0], 'pruned: no stale worktree registrations');

console.log(failures ? `\n${failures} FAILURES` : '\nall green');
process.exit(failures ? 1 : 0);
