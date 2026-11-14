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
import { readFileSync } from 'node:fs';
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

// Fail at build, not at startup: every external the bundle requires must load with this Node
// from this checkout's node_modules. `require` of an ES module package can still fail on that
// package's own imports (`ERR_UNSUPPORTED_DIR_IMPORT` for a directory import, which an ESM
// resolver refuses), and the bundle would then crash on its first line. Checked in a child
// process, so nothing a package does when loaded touches this one.
const externals = [
  ...new Set(
    Object.values(result.metafile.outputs).flatMap((output) =>
      output.imports
        .filter(
          (i) => i.external && !i.path.startsWith('node:') && !builtinModules.includes(i.path)
        )
        .map((i) => i.path)
    )
  ),
].sort();
const load = spawnSync(
  process.execPath,
  [
    '-e',
    `const failed = [];
for (const name of JSON.parse(process.argv[1])) {
  try { require(name); } catch (err) { failed.push(name + ': ' + (err.code ?? '') + ' ' + String(err.message).split('\\n')[0]); }
}
if (failed.length) { console.error(failed.join('\\n')); process.exit(1); }
process.exit(0);`,
    JSON.stringify(externals),
  ],
  { cwd: root, encoding: 'utf8', timeout: 120_000 }
);
if (load.status !== 0) {
  console.error(
    `build-registry-adapter: externals that do not load under node ${process.version}:\n` +
      (load.stderr || load.error?.message || `exit ${load.status}`)
  );
  process.exit(1);
}
console.log(
  `build-registry-adapter: ${externals.length} externals load under node ${process.version}`
);
