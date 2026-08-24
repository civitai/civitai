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
  appReservedPorts,
  appSessions,
  primaryCheckout,
} from './daemon.mjs';
import { primaryOf } from './worktree.mjs';

const failures = [];
let checks = 0;

function check(name, actual, expected) {
  checks++;
  if (actual !== expected) {
    failures.push(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
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

if (failures.length) {
  console.error('FAIL');
  for (const f of failures) console.error('  ' + f);
  process.exit(1);
}
console.log(`app-registry selftest: ${checks} checks passed`);
