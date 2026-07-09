// Bundles SharedWorker scripts to public/workers/*.js with esbuild.
//
// Why: Turbopack does not compile `.ts` SharedWorker entry scripts referenced
// via `new SharedWorker(new URL('./worker.ts', import.meta.url))` — it emits the
// raw .ts (dev) or nothing (prod build), so the browser fails with
// "Failed to fetch a worker script". See vercel/next.js#74842.
//
// Fix: pre-bundle each worker to a self-contained classic (IIFE) JS file served
// statically from /public, and instantiate via `new SharedWorker('/workers/x.js')`
// (a static path, not new URL(import.meta.url)) so Turbopack is bypassed entirely.
//
// Run via `pnpm build:workers` (also wired into predev/prebuild).
import esbuild from 'esbuild';
import { config as loadEnv } from 'dotenv';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Load .env so NEXT_PUBLIC_* values are available to inline (mirrors what Next
// does for the main bundle). Optional in CI where they may come from real env.
for (const f of ['.env.local', '.env']) {
  const p = path.join(root, f);
  if (existsSync(p)) loadEnv({ path: p });
}

// Replace every `process.env` reference in the bundle with a literal object.
// The workers import `~/env/client` (t3-env), which reads process.env.NEXT_PUBLIC_*
// and validates on import — there is no `process` in a worker, so we inline the
// public env and skip validation.
const publicEnv = { NODE_ENV: process.env.NODE_ENV ?? 'production', SKIP_ENV_VALIDATION: 'true' };
for (const [k, v] of Object.entries(process.env)) {
  if (k.startsWith('NEXT_PUBLIC_') && v !== undefined) publicEnv[k] = v;
}

const define = { 'process.env': JSON.stringify(publicEnv) };

const workers = [
  { in: 'src/utils/signals/worker.ts', out: 'public/workers/signals.worker.js' },
  { in: 'src/workers/civitai-link.worker.ts', out: 'public/workers/civitai-link.worker.js' },
  { in: 'src/workers/file-hash.worker.ts', out: 'public/workers/file-hash.worker.js' },
];

const watch = process.argv.includes('--watch');

for (const w of workers) {
  const options = {
    entryPoints: [path.join(root, w.in)],
    outfile: path.join(root, w.out),
    bundle: true,
    platform: 'browser',
    format: 'iife', // classic SharedWorker — broadest support, no `type: module` needed
    target: 'es2020',
    define,
    tsconfig: path.join(root, 'tsconfig.json'), // resolves the `~/*` path alias
    legalComments: 'none',
    logLevel: 'info',
  };

  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    console.log(`[build-workers] watching ${w.in}`);
  } else {
    await esbuild.build(options);
    console.log(`[build-workers] built ${w.out}`);
  }
}
