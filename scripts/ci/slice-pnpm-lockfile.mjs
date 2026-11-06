// Writes a pnpm-lock.yaml containing only what the given workspace importers
// (and the workspace packages they link to) transitively install, so a
// vulnerability scan of the result covers those packages and not the whole repo.
// Usage: node scripts/ci/slice-pnpm-lockfile.mjs [--prod] <out> <importer> [<importer>...]
// --prod follows only dependencies and optionalDependencies, so devDependencies (and what only
// they pull in) are left out.
// Needs the `yaml` package resolvable (NODE_PATH or node_modules).
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const YAML = require('yaml');

const args = process.argv.slice(2);
const prod = args.includes('--prod');
const [out, ...roots] = args.filter((a) => a !== '--prod');
if (!out || roots.length === 0) {
  console.error('usage: slice-pnpm-lockfile.mjs [--prod] <out> <importer> [<importer>...]');
  process.exit(2);
}

const lock = YAML.parse(readFileSync('pnpm-lock.yaml', 'utf8'));
const snapshots = lock.snapshots ?? {};
const packages = lock.packages ?? {};

const importers = {};
const keys = new Set();
const queue = [];

// `name@1.2.3(peer@4)` -> `name@1.2.3`
const stripPeers = (s) => s.replace(/\(.*$/, '');

function addDep(name, version) {
  if (version.startsWith('link:')) return;
  // plain: `1.2.3(peers)` is keyed `name@1.2.3(peers)`; an alias is already `real@1.2.3`
  const key = snapshots[`${name}@${version}`] ? `${name}@${version}` : version;
  if (!keys.has(key)) {
    keys.add(key);
    queue.push(key);
  }
}

function addImporter(id) {
  if (importers[id]) return;
  const imp = lock.importers?.[id];
  if (!imp) throw new Error(`importer not in lockfile: ${id}`);
  importers[id] = imp;
  for (const group of prod
    ? ['dependencies', 'optionalDependencies']
    : ['dependencies', 'devDependencies', 'optionalDependencies']) {
    for (const [name, dep] of Object.entries(imp[group] ?? {})) {
      if (dep.version.startsWith('link:')) {
        addImporter(path.posix.normalize(path.posix.join(id, dep.version.slice(5))));
      } else {
        addDep(name, dep.version);
      }
    }
  }
}

roots.forEach(addImporter);

while (queue.length) {
  const key = queue.pop();
  const snap = snapshots[key];
  if (!snap) throw new Error(`snapshot missing for ${key}`);
  for (const group of ['dependencies', 'optionalDependencies']) {
    for (const [name, version] of Object.entries(snap[group] ?? {})) addDep(name, version);
  }
}

const sliced = {
  lockfileVersion: lock.lockfileVersion,
  importers,
  packages: {},
  snapshots: {},
};
for (const key of keys) {
  sliced.snapshots[key] = snapshots[key];
  const pkgKey = stripPeers(key);
  if (!packages[pkgKey]) throw new Error(`packages entry missing for ${pkgKey}`);
  sliced.packages[pkgKey] = packages[pkgKey];
}
writeFileSync(out, YAML.stringify(sliced));
console.log(
  `${Object.keys(importers).length} importers, ${
    Object.keys(sliced.packages).length
  } packages -> ${out}`
);
