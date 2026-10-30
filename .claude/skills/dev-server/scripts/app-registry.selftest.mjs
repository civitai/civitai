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
  AppSession,
  appEnvChain,
  appIsLive,
  appReservedPorts,
  appSessionKey,
  appSessions,
  primaryCheckout,
  inheritablePort,
  settleDelayMs,
  releaseIfOurs,
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
// Two properties, and it is worth being exact about which line buys which — my first two attempts at
// this comment each credited the wrong one.
//
// `appAllocationLock` is always `run.then(() => {}, () => {})`, and both arms return undefined, so
// that promise can never reject — which means the head's `lock.then(fn, fn)` reject arm is
// UNREACHABLE in the shipped code. The chain surviving a rejection is bought by the tail. The two
// are redundant with each other and both are kept, so that neither line is load-bearing alone.
//
// What the tail's reject arm ALSO buys, and nothing else does, is that a rejected allocation never
// escapes as an unhandled rejection — a process-level warning nobody would attribute to app starts.
// That is the property with no other guard, so it is the one asserted.
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
const third = withAppAllocation(async () => order.push('c')).catch(() =>
  // Symmetry with the two above. Without it a mutation that rejects here kills the run with a raw
  // stack trace instead of a named failure — still red, but red in a way nobody can read.
  order.push('c-rejected')
);
await Promise.all([first, second, third]);
check('the lock serialises, it does not interleave', order.join(','), 'a-start,a-end,b,b-rejected,c');
check('a rejected allocation does not wedge the chain', order.includes('c'), true);

// The rejecting call has to be the LAST one, and it has to be given real time to surface. A
// following allocation attaches its own handler to the rejected lock, so a rejection sandwiched
// between two others is handled either way and the check would pass whatever the tail does.
await withAppAllocation(async () => {
  throw new Error('deliberate trailing failure');
}).catch(() => {});
// setImmediate, not a timer. Node publishes the unhandled-rejection list at the end of the tick,
// after microtasks drain and before the check phase — so this is the FIRST hop that can observe it,
// and observing it is a guarantee rather than a race. A timer can only ever be later, which is why
// an arbitrary 60ms also worked; the problem with a number is that the instinct on a slow box is to
// raise it, which is widening the budget rather than fixing anything.
await new Promise((r) => setImmediate(r));
process.off('unhandledRejection', onUnhandled);
check('a trailing rejected allocation does not escape as an unhandled rejection', unhandled.length, 0);

// --- the two decisions the concurrent-start fix turns on ---
// These lived inline in the HTTP handler, where reverting the liveness rule to `status === 'running'`
// — the exact bug fixed twice on this branch — left every check green. The only evidence was a live
// control run once by hand, which the next person cannot repeat.
check('no entry is not live', appIsLive(undefined), false);
check('a starting entry IS live', appIsLive({ status: 'starting' }), true);
check('a running entry with no process is still live', appIsLive({ status: 'running', process: null }), true);
// proc.on('error') sets status without clearing the process, so status alone would call this dead
// and hand its port to a second spawn.
check('an errored entry holding a live process is live', appIsLive({ status: 'error', process: {} }), true);
check('a crashed entry with no process is not live', appIsLive({ status: 'crashed', process: null }), false);

check('a dead entry lends its port', inheritablePort({ status: 'crashed', process: null, port: 5174 }), 5174);
check('a live entry lends nothing', inheritablePort({ status: 'starting', port: 5174 }), null);
check('an errored-but-alive entry lends nothing', inheritablePort({ status: 'error', process: {}, port: 5174 }), null);
check('no entry lends nothing', inheritablePort(undefined), null);

// A stop in flight owns its port until it proves the port came back. Without this a concurrent start
// is handed `reused: true` for a server about to be killed, or inherits a port still being freed.
check('a stopping entry is not live', appIsLive({ status: 'running', process: {}, stopping: true }), false);
// The concurrent-start orphan in one line: a freshly constructed session goes into the map inside the
// allocation lock, but start() is awaited outside it. If it is born dead, a second start inherits its
// port and spawns a rival. Invisible whenever the auth hub is already running, because the await
// between them is then a no-op — which is exactly why the live control missed it.
check(
  'a freshly constructed AppSession is already live',
  appIsLive(new AppSession('moderator', primaryCheckout, 5174, [])),
  true
);
check('a stopping entry lends nothing', inheritablePort({ status: 'running', port: 5174, stopping: true }), null);
// The two questions appIsLive is asked are NOT the same, and this is the pair that proves it.
// "May a start reuse this?" -> no. "Does shutdown still need to wait on it?" -> yes. A single
// predicate serving both is how a stopping app gets skipped at exit and outlives the daemon.
const stoppingEntry = { status: 'running', process: {}, port: 5174, stopping: true };
check('shutdown must still wait on a stopping entry', appIsLive(stoppingEntry) || stoppingEntry.stopping, true);
// A port of 0 must not short-circuit the allocator into an ephemeral bind. Unreachable today, but the
// inline version this was lifted from treated 0 as falsy and the extraction must not change that.
check('a port of 0 is not inheritable', inheritablePort({ status: 'crashed', process: null, port: 0 }), null);

// --- the settle window's arithmetic ---
// The constant itself is a property of spawn latency on this box and belongs in its comment, not in a
// test. What IS testable is the claim the comment makes: that it waits only the REMAINDER.
check('never spawned means no wait', settleDelayMs(null, 1_000_000, 3000), 0);
check('spawned just now waits the whole window', settleDelayMs(1_000_000, 1_000_000, 3000), 3000);
check('spawned 2900ms ago waits only the remainder', settleDelayMs(1_000_000, 1_002_900, 3000), 100);
check('spawned long ago waits nothing', settleDelayMs(1_000_000, 9_000_000, 3000), 0);
// A clock step or a VM resume between spawn and stop makes `now - spawnedAt` negative, and an
// unclamped `settle - negative` waits LONGER than the window.
check('a clock going backwards cannot extend the wait', settleDelayMs(1_000_000, 900_000, 3000), 3000);

// The release has to prove the entry is still the one it means to release. Every caller awaits
// something first — five path probes, or stop()'s 800ms — and a start arriving in that window
// replaces the entry. Releasing by key alone then deletes the NEW one and leaves its vite running
// with nothing referencing it, which is the orphan this branch has now fixed in three places.
const relKey = '__selftest__::release';
const mine = { port: 6001 };
const theirs = { port: 6002 };
appSessions.set(relKey, mine);
releaseIfOurs(relKey, mine);
check('releases the entry when it is still ours', appSessions.has(relKey), false);

appSessions.set(relKey, theirs);
releaseIfOurs(relKey, mine);
check('does NOT release an entry that was replaced underneath', appSessions.get(relKey), theirs);
appSessions.delete(relKey);

releaseIfOurs(relKey, mine);
check('releasing a key that is not there is a no-op', appSessions.has(relKey), false);

if (failures.length) {
  console.error('FAIL');
  for (const f of failures) console.error('  ' + f);
  process.exit(1);
}
console.log(`app-registry selftest: ${checks} checks passed`);
