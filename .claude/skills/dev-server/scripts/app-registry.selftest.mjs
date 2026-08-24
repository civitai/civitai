// Guards for the app registry, the port-reservation math, and the primary-worktree detection.
//
// The registry check is the one the incident asks for: `storage` and `notifications` sat in this
// registry for months and could never start, because neither has a vite.config.ts. Nothing noticed,
// because the only way to find out was to run them and read an error worded as an auth-hub problem.
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';
import {
  APP_REGISTRY,
  appEnvChain,
  appReservedPorts,
  appSessionKey,
  appSessions,
  primaryCheckout,
  primaryResolution,
  withAppAllocation,
} from './daemon.mjs';
import { primaryOf } from './worktree.mjs';
// From the leaf module — the single definition that daemon.mjs and worktree.mjs now both import.
import { samePath, canonicalPath } from './paths.mjs';

const failures = [];
let checks = 0;

function check(name, actual, expected) {
  checks++;
  if (actual !== expected) {
    failures.push(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// First, because it changes what every failure below MEANS. Outside a git repo primaryCheckout
// falls back and the registry checks go red reporting a missing app directory, which sends the
// reader looking for apps/moderator when the real answer is that git could not be asked.
check('primaryCheckout was derived from git, not fallen back', primaryResolution.derived, true);
if (!primaryResolution.derived) {
  console.error(`  (primary fell back to ${primaryCheckout}: ${primaryResolution.error})`);
}

// --- registry invariants ---
const names = Object.keys(APP_REGISTRY);
check('registry is not empty', names.length > 0, true);

for (const [name, spec] of Object.entries(APP_REGISTRY)) {
  const appDir = resolve(primaryCheckout, spec.path);
  check(`${name}: app directory exists`, existsSync(appDir), true);
  // Every registered app is spawned with `vite dev`. One without a vite config cannot start, and the
  // failure surfaces far from the registry entry that caused it.
  check(`${name}: has a vite config`, existsSync(resolve(appDir, 'vite.config.ts')), true);
  check(`${name}: preferredPort is a number`, Number.isInteger(spec.preferredPort), true);
}

const ports = names.map((n) => APP_REGISTRY[n].preferredPort);
check('preferred ports are unique', new Set(ports).size, ports.length);

// --- reservation math ---
// The claim in appReservedPorts' comment is that EVERY OTHER app's preferred port is held back, so
// one app drifting never displaces another from its documented number. Nothing checked it.
for (const name of names) {
  const reserved = appReservedPorts(name);
  check(`${name}: its own preferred port is NOT reserved against it`, reserved.has(APP_REGISTRY[name].preferredPort), false);
  for (const other of names) {
    if (other === name) continue;
    check(
      `${name}: ${other}'s preferred port is held back`,
      reserved.has(APP_REGISTRY[other].preferredPort),
      true
    );
  }
}

// True only because appSessions is empty in a fresh process — this asserts a property of the
// environment alongside one of the function. Inserting a probe on an app's OWN preferred port before
// this point would flip it.
//
// A live app session reserves its port for every app, including itself — that is what stops the main
// app's allocator handing the same number out twice.
const probeName = names[0];
const probeKey = '__selftest__::probe';
const probePort = 59999;
appSessions.set(probeKey, { port: probePort, name: probeName, worktree: '__selftest__' });
try {
  check('a live app session reserves its port', appReservedPorts(probeName).has(probePort), true);
} finally {
  appSessions.delete(probeKey);
}
check('the probe released its reservation', appReservedPorts(probeName).has(probePort), false);

// --- primaryOf ---
// `wt rm` refuses to delete whatever this returns. Run through a worktree's own copy of the CLI it
// used to return that worktree, which offered the real main checkout as removable.
check(
  'primaryOf takes the FIRST entry, not the caller directory',
  primaryOf([{ path: 'C:/a' }, { path: 'C:/b' }], 'C:/b'),
  'C:/a'
);
const empty = mkdtempSync(resolve(tmpdir(), 'primary-of-'));
try {
  check('primaryOf falls back to the resolved argument', primaryOf([], empty), resolve(empty));
} finally {
  rmSync(empty, { recursive: true, force: true });
}

// --- path identity ---
// appSessionKey is what stopped two agents whose shells disagree on drive-letter casing getting two
// vite processes on one worktree. It is pure; the live two-start control that found it is not
// repeatable by the next person, so pin it here too.
const upper = 'C:\\Dev\\Repos\\work\\worktrees\\x';
const lower = 'c:\\dev\\repos\\work\\worktrees\\x';
if (process.platform === 'win32') {
  check('appSessionKey ignores drive-letter casing', appSessionKey(upper, 'moderator'), appSessionKey(lower, 'moderator'));
  check('samePath ignores drive-letter casing', samePath(upper, lower), true);
  // The chain dedupe has to answer path-equality the same way, or the same file lands in it twice.
  check('appEnvChain dedupes across casing', appEnvChain(primaryCheckout.toLowerCase(), names[0]).length, 1);
} else {
  check('samePath is exact off win32', samePath(upper, lower), false);
}
check('samePath still separates genuinely different trees', samePath(upper, upper + 'y'), false);
// The Map key and the comparator have to agree, or appSessionKey and samePath disagree about the
// same two paths — which is the bug this PR fixed in four places.
check('canonicalPath agrees with samePath', canonicalPath(upper) === canonicalPath(lower), samePath(upper, lower));
check('appSessionKey separates apps in one worktree', appSessionKey(upper, 'a') === appSessionKey(upper, 'b'), false);

// --- the allocation lock ---
// Two separate properties, and it is worth being exact about which line buys which, because the
// obvious guess is wrong. The chain surviving a rejection is bought by `lock.then(fn, fn)` — its
// reject arm runs the next callback even when the lock it chained from rejected. Measured: removing
// the reject arm from the TAIL does not deadlock anything.
//
// What the tail's reject arm buys is that a rejected allocation never escapes as an unhandled
// rejection, which in this daemon would be a process-level warning nobody attributes to app starts.
// That is the property with no other guard, so it is asserted directly.
const unhandled = [];
const onUnhandled = (err) => unhandled.push(err);
process.on('unhandledRejection', onUnhandled);

const order = [];
const first = withAppAllocation(async () => {
  order.push('a-start');
  await new Promise((r) => setTimeout(r, 20));
  order.push('a-end');
}).catch(() => order.push('a-rejected'));
const second = withAppAllocation(async () => {
  order.push('b');
  throw new Error('deliberate');
}).catch(() => order.push('b-rejected'));
const third = withAppAllocation(async () => order.push('c'));
await Promise.all([first, second, third]);
check('the lock serialises, it does not interleave', order.join(','), 'a-start,a-end,b,b-rejected,c');
check('a rejected allocation does not wedge the chain', order.includes('c'), true);

// The rejecting call has to be the LAST one, and it has to be given real time to surface. A
// following allocation attaches its own handler to the rejected lock, so a rejection sandwiched
// between two others is handled either way and the check would pass whatever the tail does.
await withAppAllocation(async () => {
  throw new Error('deliberate trailing failure');
}).catch(() => {});
await new Promise((r) => setTimeout(r, 60));
process.off('unhandledRejection', onUnhandled);
check('a trailing rejected allocation does not escape as an unhandled rejection', unhandled.length, 0);

if (failures.length) {
  console.error('FAIL');
  for (const f of failures) console.error('  ' + f);
  process.exit(1);
}
console.log(`app-registry selftest: ${checks} checks passed`);
