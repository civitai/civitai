// Bundles the registry adapter (src/server/registry-adapter/main.ts) into one CommonJS file,
// dist/registry-adapter.js, run with plain `node` — no tsx at runtime.
//
// What is bundled and what is not:
//   - first-party code, including the `~/*` alias and the workspace packages (`@civitai/*`,
//     whose package entry points are TypeScript source), is bundled;
//   - the root package's npm `dependencies` stay external and load from the installed
//     node_modules at runtime (Prisma's generated client and native modules among them), so the
//     bundle must run from a checkout with production dependencies installed;
//   - anything else a workspace package imports is resolved from that package and bundled.
//
// Run via `pnpm run build:registry-adapter`; start with `pnpm run start:registry-adapter`.
import esbuild from 'esbuild';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

const external = Object.entries(pkg.dependencies ?? {})
  .filter(([, spec]) => !String(spec).startsWith('workspace:'))
  .flatMap(([name]) => [name, `${name}/*`]);

const result = await esbuild.build({
  entryPoints: [path.join(root, 'src/server/registry-adapter/main.ts')],
  outfile: path.join(root, 'dist/registry-adapter.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external,
  tsconfig: path.join(root, 'tsconfig.json'),
  sourcemap: true,
  legalComments: 'none',
  logLevel: 'info',
  metafile: true,
  // Input paths in the metafile are relative to this, which the guard below relies on.
  absWorkingDir: root,
});

// Fail loudly: a test file, or any fixture-mode module (`scripts/registry-adapter-fixture/`),
// must never be part of the production entrypoint.
const forbidden = Object.keys(result.metafile.inputs).filter(
  (input) => /__tests__\//.test(input) || /^scripts\//.test(input)
);
if (forbidden.length > 0) {
  console.error(`build-registry-adapter: refusing inputs:\n  ${forbidden.join('\n  ')}`);
  process.exit(1);
}

// Fail at build, not at startup: every external the bundle loads must load with this Node from
// this checkout's node_modules, the way the bundle loads it: `require` for a `require` call (all
// of them, in this CommonJS bundle, unless code uses `import()`), `import()` for a dynamic import
// the bundle keeps. The list is written next to the bundle, dist/registry-adapter.externals.json,
// and loaded by scripts/registry-adapter-load-check.mjs, which apps/registry-adapter/Dockerfile
// runs a second time against the image's production node_modules (see that script).
//
// This runs wherever `build:registry-adapter` runs, and in the unit-test CI job (shard 1).
const externals = new Map(); // path -> how the bundle loads it
for (const output of Object.values(result.metafile.outputs)) {
  for (const i of output.imports) {
    if (!i.external || i.path.startsWith('node:') || builtinModules.includes(i.path)) continue;
    const how = i.kind === 'dynamic-import' ? 'import' : 'require';
    // Loaded both ways: check both.
    const seen = externals.get(i.path);
    externals.set(i.path, seen && seen !== how ? 'both' : how);
  }
}
const toLoad = [...externals].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
const manifest = path.join(root, 'dist/registry-adapter.externals.json');
writeFileSync(manifest, JSON.stringify(toLoad, null, 2) + '\n');
const load = spawnSync(
  process.execPath,
  [path.join(root, 'scripts/registry-adapter-load-check.mjs'), manifest],
  { cwd: root, stdio: 'inherit' }
);
if (load.status !== 0) {
  console.error(
    `build-registry-adapter: load check failed (${load.error?.message ?? `exit ${load.status}`})`
  );
  process.exit(1);
}
