// Loads every npm package the registry adapter bundle keeps external, the way the bundle loads
// it, from the node_modules that the CURRENT DIRECTORY resolves to:
//
//   node scripts/registry-adapter-load-check.mjs dist/registry-adapter.externals.json
//
// The manifest is written by scripts/build-registry-adapter.mjs next to the bundle: a JSON list
// of [specifier, 'require' | 'import' | 'both'] pairs, read from esbuild's metafile.
//
// Two callers, and they check different trees:
//   - the build script, from the checkout, with whatever node_modules it was built against;
//   - apps/registry-adapter/Dockerfile, from the runtime stage's /app, against the PRODUCTION
//     node_modules the image ships. The builder's full install sits nowhere on that resolution
//     path, so a package that only the dev install provides (or a generated Prisma client the
//     production install dropped) fails here instead of at the container's first start.
//
// `require` for a `require` call, `import()` for a dynamic import the bundle keeps. `require` of
// an ES module package can still fail on that package's own imports (`ERR_UNSUPPORTED_DIR_IMPORT`
// for a directory import, which an ESM resolver refuses). Loaded in a child process, so nothing
// a package does when loaded touches this one. Exits 1 when a package does not load, 2 when the
// manifest is missing, unreadable or empty (a check that can load nothing must not pass).
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const [manifestPath] = process.argv.slice(2);
if (!manifestPath) {
  console.error('usage: node scripts/registry-adapter-load-check.mjs <externals.json>');
  process.exit(2);
}
let toLoad;
try {
  toLoad = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch (err) {
  console.error(`registry-adapter-load-check: cannot read ${manifestPath}: ${err.message}`);
  process.exit(2);
}
if (!Array.isArray(toLoad) || toLoad.length === 0) {
  console.error(`registry-adapter-load-check: ${manifestPath} lists no externals`);
  process.exit(2);
}

const load = spawnSync(
  process.execPath,
  [
    '-e',
    `(async () => {
  const failed = [];
  const note = (name, how, err) =>
    failed.push(name + ' (' + how + '): ' + (err.code ?? '') + ' ' + String(err.message).split('\\n')[0]);
  for (const [name, how] of JSON.parse(process.argv[1])) {
    if (how !== 'import') { try { require(name); } catch (err) { note(name, 'require', err); } }
    if (how !== 'require') { try { await import(name); } catch (err) { note(name, 'import', err); } }
  }
  if (failed.length) { console.error(failed.join('\\n')); process.exit(1); }
  process.exit(0);
})();`,
    JSON.stringify(toLoad),
  ],
  { cwd: process.cwd(), encoding: 'utf8', timeout: 120_000 }
);
if (load.status !== 0) {
  console.error(
    `registry-adapter-load-check: externals that do not load under node ${process.version} ` +
      `from ${process.cwd()}:\n` +
      (load.stderr || load.error?.message || `exit ${load.status}`)
  );
  process.exit(1);
}
const kinds = toLoad.reduce((n, [, how]) => ({ ...n, [how]: (n[how] ?? 0) + 1 }), {});
console.log(
  `registry-adapter-load-check: ${toLoad.length} externals load under node ${process.version} ` +
    `from ${process.cwd()} (${Object.entries(kinds)
      .map(([how, n]) => `${n} by ${how}`)
      .join(', ')})`
);
