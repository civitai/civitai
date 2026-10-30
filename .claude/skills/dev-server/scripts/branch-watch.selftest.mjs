/**
 * `node .claude/skills/dev-server/scripts/branch-watch.selftest.mjs`
 *
 * The shipped defaults (poll 1000ms, debounce 3000ms) livelocked the branch watcher: it re-armed
 * the debounce on every poll, so the timer could never expire and no switch ever ran. Nothing about
 * that was visible — the session kept serving, kept reporting `switching: false`, and simply
 * reported the branch it started on forever.
 *
 * The last two cases are the regression. They simulate the poll loop against a HEAD that has moved
 * once and then holds still, and assert the switch is scheduled EXACTLY once; a revert makes the
 * count equal the number of polls, which prints as a number, not as a hang.
 */

import { shouldScheduleSwitch } from './daemon.mjs';

let failures = 0;
function check(name, actual, expected) {
  const pass = actual === expected;
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  got=${actual} want=${expected}`);
}

check('unreadable HEAD is not a switch', shouldScheduleSwitch(null, 'main', null), false);
// Not redundant with the row above: with no `!head` guard that one still returns false by accident
// (null !== null), so it pins nothing. This row is the one that fails without the guard — a null
// head would otherwise arm a debounce for a ref the watcher can no longer tell apart from "none".
check('unreadable HEAD while already debouncing', shouldScheduleSwitch(null, 'main', 'feat/x'), false);
check('HEAD unchanged', shouldScheduleSwitch('main', 'main', null), false);
check('HEAD moved, nothing pending', shouldScheduleSwitch('feat/x', 'main', null), true);
check('already debouncing this exact head', shouldScheduleSwitch('feat/x', 'main', 'feat/x'), false);
check('moved AGAIN mid-debounce re-arms', shouldScheduleSwitch('feat/y', 'main', 'feat/x'), true);
check('landed back on the running branch', shouldScheduleSwitch('main', 'main', 'feat/x'), false);

// Drive the poll loop the way the daemon does: `branch` does not move until the switch runs, so a
// guard that ignores `pendingHead` keeps firing and keeps pushing the deadline out of reach.
function pollsUntilSwitch({ polls, intervalMs, debounceMs }) {
  let pendingHead = null;
  let armedAt = null;
  let scheduled = 0;
  let ranAt = null;
  const branch = 'main';

  for (let t = 0; t <= polls * intervalMs; t += intervalMs) {
    if (armedAt !== null && t - armedAt >= debounceMs) {
      ranAt = t;
      break;
    }
    if (shouldScheduleSwitch('feat/x', branch, pendingHead)) {
      pendingHead = 'feat/x';
      armedAt = t; // re-arming resets the deadline, which is the whole bug
      scheduled++;
    }
  }
  return { scheduled, ranAt };
}

const shipped = pollsUntilSwitch({ polls: 20, intervalMs: 1000, debounceMs: 3000 });
check('scheduled exactly once on the shipped defaults', shipped.scheduled, 1);
check('and the switch actually runs', shipped.ranAt, 3000);

// Interval > debounce was the only configuration the old code could ever complete under.
const slowPoll = pollsUntilSwitch({ polls: 20, intervalMs: 5000, debounceMs: 3000 });
check('completes with a slow poll too', slowPoll.ranAt, 5000);

console.log(failures ? `\n${failures} FAILURES` : '\nall green');
process.exit(failures ? 1 : 0);
