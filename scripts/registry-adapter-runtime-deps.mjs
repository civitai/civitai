// Copies, out of a pnpm-installed node_modules, only the packages the registry adapter bundle can
// load: the externals it names, and everything those depend on.
//
//   node scripts/registry-adapter-runtime-deps.mjs dist/registry-adapter.externals.json <out-dir>
//
// Run from the root of the install (apps/registry-adapter/Dockerfile runs it in its prod-deps
// stage, on the root package's production install). Writes <out-dir>/node_modules.
//
// The root package's production tree is about 1.5 GB because it carries the whole web app (Next,
// React, the UI libraries); the bundle loads a few dozen of those packages. The manifest is the
// one scripts/build-registry-adapter.mjs writes from esbuild's metafile.
//
// What is copied, keeping pnpm's layout (node_modules/.pnpm/<key>/node_modules/<name>):
//   - every store directory reached from an external through `dependencies`,
//     `optionalDependencies` and `peerDependencies` (pnpm links exactly these beside each
//     package, so a store directory's own links all point inside the copy);
//   - the top-level link of each external (node_modules/<name>);
//   - the entries of pnpm's hidden hoisting directory (node_modules/.pnpm/node_modules) that point
//     into the copy, so a package that requires something it does not declare finds it here the
//     way it does in the full install, as long as that something is in the copy.
// A package that requires an undeclared package outside the copy fails here and not in the full
// install. That is what the runtime-stage load check is for, and why it runs on the copy.
//
// Exits 1 if an external has no installed link, or if any link inside the copy points outside it;
// 2 on bad arguments or an empty manifest.
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
} from 'node:fs';
import path from 'node:path';

const [manifestPath, outDir] = process.argv.slice(2);
if (!manifestPath || !outDir) {
  console.error('usage: node scripts/registry-adapter-runtime-deps.mjs <externals.json> <out-dir>');
  process.exit(2);
}
const externals = JSON.parse(readFileSync(manifestPath, 'utf8'));
if (!Array.isArray(externals) || externals.length === 0) {
  console.error(`registry-adapter-runtime-deps: ${manifestPath} lists no externals`);
  process.exit(2);
}

const nm = path.resolve('node_modules');
const store = path.join(nm, '.pnpm');
const out = path.resolve(outDir, 'node_modules');

/** `@scope/name/sub` -> `@scope/name`; `name/sub` -> `name`. */
const packageName = (spec) =>
  spec
    .split('/')
    .slice(0, spec.startsWith('@') ? 2 : 1)
    .join('/');
/** The store key (`<key>` in .pnpm/<key>/...) a real path lies in, or null. */
const storeKey = (real) =>
  real.startsWith(store + path.sep) ? real.slice(store.length + 1).split(path.sep)[0] : null;

const roots = [...new Set(externals.map(([spec]) => packageName(spec)))].sort();
const keys = new Set();
const queue = [];
for (const name of roots) {
  const link = path.join(nm, name);
  if (!existsSync(link)) {
    console.error(`registry-adapter-runtime-deps: external ${name} is not installed at ${link}`);
    process.exit(1);
  }
  queue.push(realpathSync(link));
}
const visited = new Set();
while (queue.length) {
  const dir = queue.pop();
  if (visited.has(dir)) continue;
  visited.add(dir);
  const key = storeKey(dir);
  if (!key) {
    console.error(`registry-adapter-runtime-deps: ${dir} is not in the pnpm store`);
    process.exit(1);
  }
  keys.add(key);
  const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const deps = { ...pkg.peerDependencies, ...pkg.optionalDependencies, ...pkg.dependencies };
  for (const dep of Object.keys(deps)) {
    const sibling = path.join(store, key, 'node_modules', dep);
    // An optional or peer dependency that is not installed is absent in the full install too.
    if (existsSync(sibling)) queue.push(realpathSync(sibling));
  }
}

for (const key of keys) {
  cpSync(path.join(store, key), path.join(out, '.pnpm', key), {
    recursive: true,
    verbatimSymlinks: true,
  });
}
const copyLink = (from, to) => {
  mkdirSync(path.dirname(to), { recursive: true });
  symlinkSync(readlinkSync(from), to);
};
for (const name of roots) copyLink(path.join(nm, name), path.join(out, name));

/** Every `<dir>/<name>` and `<dir>/@scope/<name>` entry. */
const entries = (dir) =>
  readdirSync(dir).flatMap((e) =>
    e.startsWith('@') ? readdirSync(path.join(dir, e)).map((s) => `${e}/${s}`) : [e]
  );
const hoisted = path.join(store, 'node_modules');
let hoistedCopied = 0;
if (existsSync(hoisted)) {
  for (const name of entries(hoisted)) {
    const from = path.join(hoisted, name);
    let real;
    try {
      real = realpathSync(from);
    } catch {
      continue;
    }
    if (keys.has(storeKey(real))) {
      copyLink(from, path.join(out, '.pnpm', 'node_modules', name));
      hoistedCopied++;
    }
  }
}

// Every link in the copy must resolve inside the copy.
const dangling = [];
const checkLinks = (dir) => {
  for (const name of entries(dir)) {
    const p = path.join(dir, name);
    if (!lstatSync(p).isSymbolicLink()) continue;
    let real;
    try {
      real = realpathSync(p);
    } catch {
      dangling.push(`${p} -> ${readlinkSync(p)}`);
      continue;
    }
    if (!real.startsWith(out + path.sep)) dangling.push(`${p} -> ${real} (outside the copy)`);
  }
};
for (const key of keys) checkLinks(path.join(out, '.pnpm', key, 'node_modules'));
checkLinks(out);
if (existsSync(path.join(out, '.pnpm', 'node_modules')))
  checkLinks(path.join(out, '.pnpm', 'node_modules'));
if (dangling.length) {
  console.error(
    `registry-adapter-runtime-deps: links that do not resolve in the copy:\n  ${dangling.join(
      '\n  '
    )}`
  );
  process.exit(1);
}
console.log(
  `registry-adapter-runtime-deps: ${roots.length} externals -> ${keys.size} store directories, ` +
    `${hoistedCopied} hoisted links, into ${out}`
);
