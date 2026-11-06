/**
 * Makes the parity env file satisfy every env schema the production server validates at boot,
 * by READING THOSE SCHEMAS rather than keeping a list of keys here.
 *
 * `make-env.mjs` writes the base file (`.env-example` placeholders plus the job's own stores).
 * This then, with `NODE_ENV=production` (several keys are required only in production):
 *   1. parses the file with the app's `serverSchema`, and for every failing key writes a
 *      syntactically valid DUMMY of the shape the issue asks for — a URL for a URL, a non-empty
 *      string for a min-length string, the first option of an enum — and parses again, until the
 *      schema passes;
 *   2. loads every workspace package's own env loader (`load*Env` in `packages/<pkg>/src/env.ts`)
 *      against the result.
 * It FAILS — rather than guessing — when an issue has a shape it does not know how to satisfy,
 * when a key the job set on purpose is itself rejected, or when a package loader still throws.
 * Every value it writes is a dummy derived from the schema; nothing is read from anywhere else.
 *
 * Usage: NODE_ENV=production pnpm exec tsx scripts/trpc-server/parity/fill-required-env.ts <env-file>
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const envFile = process.argv[2];
if (!envFile) {
  console.error('usage: fill-required-env.ts <env-file>');
  process.exit(2);
}
if (process.env.NODE_ENV !== 'production') {
  console.error('run with NODE_ENV=production: the production-only requirements are the point');
  process.exit(2);
}

/** Keys make-env.mjs sets deliberately; a schema rejecting one of these is a harness bug. */
const OWNED = new Set(
  readFileSync(envFile, 'utf8')
    .split('\n')
    .filter((l) => l.startsWith('# owned: '))
    .flatMap((l) => l.slice('# owned: '.length).split(','))
    .map((k) => k.trim())
    .filter(Boolean)
);

function readEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    env[line.slice(0, line.indexOf('='))] = line.slice(line.indexOf('=') + 1);
  }
  return env;
}

type Issue = {
  code: string;
  path: PropertyKey[];
  expected?: string;
  format?: string;
  values?: unknown[];
  origin?: string;
  minimum?: number | bigint;
  errors?: Issue[][];
  message?: string;
};

/** A dummy value that satisfies one zod (v4) issue, or null when the shape is unknown. */
function dummyFor(issue: Issue): string | null {
  switch (issue.code) {
    case 'invalid_type':
      if (issue.expected === 'string') return 'parity-placeholder';
      if (issue.expected === 'number' || issue.expected === 'int') return '1';
      if (issue.expected === 'boolean') return 'false';
      return null;
    case 'invalid_format':
      if (issue.format === 'url') return 'http://localhost:1';
      if (issue.format === 'email') return 'parity@example.com';
      return null;
    case 'invalid_value':
      return issue.values && issue.values.length > 0 ? String(issue.values[0]) : null;
    case 'too_small':
      if (issue.origin === 'string') return 'x'.repeat(Math.max(1, Number(issue.minimum ?? 1)));
      if (issue.origin === 'number') return String(issue.minimum ?? 1);
      return null;
    case 'invalid_union': {
      // Satisfy the first branch whose issues we can all answer.
      for (const branch of issue.errors ?? []) {
        const values = branch.map(dummyFor);
        if (values.length > 0 && values.every((v) => v !== null)) return values[0];
      }
      return null;
    }
    default:
      return null;
  }
}

const filled = new Map<string, string>();

async function satisfyServerSchema() {
  const env = readEnv();
  Object.assign(process.env, env);
  // Imported AFTER the env is in place: the schema picks prod-only branches at import time.
  const { serverSchema } = await import('../../../src/env/server-schema');

  for (let round = 1; round <= 10; round += 1) {
    const result = serverSchema.safeParse(env);
    if (result.success) {
      console.log(`server schema: passes after ${round - 1} fill round(s)`);
      return env;
    }
    const unknown: string[] = [];
    for (const issue of result.error.issues as Issue[]) {
      const key = String(issue.path[0] ?? '');
      if (!key) {
        unknown.push(`(schema-level) ${issue.code}: ${issue.message}`);
        continue;
      }
      if (OWNED.has(key)) {
        unknown.push(`${key} is set by make-env.mjs and the schema rejects it: ${issue.message}`);
        continue;
      }
      const value = dummyFor(issue);
      if (value === null) {
        unknown.push(`${key}: no dummy for issue ${issue.code} (${issue.message})`);
        continue;
      }
      env[key] = value;
      filled.set(key, value);
    }
    if (unknown.length > 0) {
      console.error('FAIL: the server env schema has requirements this script cannot fill:');
      for (const u of unknown) console.error(`  ${u}`);
      process.exit(1);
    }
  }
  console.error('FAIL: the server env schema still fails after 10 fill rounds');
  process.exit(1);
}

async function checkPackageLoaders(env: Record<string, string>) {
  Object.assign(process.env, env);
  const root = join(__dirname, '../../..');
  const packagesDir = join(root, 'packages');
  let checked = 0;
  const failures: string[] = [];
  for (const pkg of readdirSync(packagesDir)) {
    const file = join(packagesDir, pkg, 'src', 'env.ts');
    if (!existsSync(file)) continue;
    const loaders = [...readFileSync(file, 'utf8').matchAll(/export function (load\w*Env)\(/g)].map(
      (m) => m[1]
    );
    if (loaders.length === 0) continue;
    const mod = await import(pathToFileURL(file).href);
    for (const name of loaders) {
      checked += 1;
      try {
        mod[name]();
      } catch (err) {
        failures.push(`${pkg} ${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  if (checked === 0) {
    console.error('FAIL (cannot observe): found no package env loader to check');
    process.exit(2);
  }
  if (failures.length > 0) {
    console.error('FAIL: a package env loader rejects the parity env:');
    for (const f of failures) console.error(`  ${f}`);
    process.exit(1);
  }
  console.log(`package env loaders: ${checked} pass`);
}

// CommonJS under tsx (the package is not `type: module`), so no top-level await.
async function main() {
  const env = await satisfyServerSchema();
  await checkPackageLoaders(env);

  const lines = readFileSync(envFile, 'utf8').replace(/\n+$/, '').split('\n');
  const present = new Set(
    lines.filter((l) => l.includes('=')).map((l) => l.slice(0, l.indexOf('=')))
  );
  const out = lines.map((l) => {
    const key = l.includes('=') && !l.startsWith('#') ? l.slice(0, l.indexOf('=')) : null;
    return key && filled.has(key) ? `${key}=${filled.get(key)}` : l;
  });
  for (const [key, value] of filled) if (!present.has(key)) out.push(`${key}=${value}`);
  writeFileSync(envFile, `${out.join('\n')}\n`);
  // Names only: every value is a schema-derived dummy, but the log does not need them.
  console.log(`filled ${filled.size} key(s): ${[...filled.keys()].sort().join(', ') || '(none)'}`);
  // Package clients (redis, etc.) may hold handles open; the work is done.
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
