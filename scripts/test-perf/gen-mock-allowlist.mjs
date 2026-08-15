#!/usr/bin/env node
/**
 * Regenerate src/__tests__/mocks/direct-mock-allowlist.json — the files that still mock a
 * canonical shared module directly.
 *
 *   node scripts/test-perf/gen-mock-allowlist.mjs
 *
 * 🔴 Regenerating is only legitimate after MIGRATING files, never to make the guard pass.
 * The list may shrink; a run that would grow it exits non-zero and writes nothing, because
 * a grown list means a new direct mock was added and that is precisely what the guard
 * exists to stop.
 */
import { readFileSync, writeFileSync, existsSync, globSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(repoRoot, 'src/__tests__/mocks/direct-mock-allowlist.json');

const SPECIFIERS = ['~/server/db/client', '~/server/redis/client', '~/server/logging/client'];
const pattern = (spec) => new RegExp(`vi\\.mock\\(\\s*['"\`]${spec.replace(/[/~]/g, (c) => `\\${c}`)}['"\`]`);

const files = globSync('src/**/*.test.ts', { cwd: repoRoot })
  .map((f) => f.replace(/\\/g, '/'))
  .filter((f) => !f.startsWith('src/__tests__/mocks/'))
  .filter((f) => {
    const src = readFileSync(path.join(repoRoot, f), 'utf8');
    return SPECIFIERS.some((s) => pattern(s).test(src));
  })
  .sort();

const previous = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')).files : null;
if (previous && files.length > previous.length) {
  const added = files.filter((f) => !previous.includes(f));
  console.error(`Refusing to grow the allowlist (${previous.length} -> ${files.length}). New direct mocks:`);
  for (const f of added) console.error(`  ${f}`);
  process.exit(1);
}

writeFileSync(OUT, `${JSON.stringify({ files }, null, 2)}\n`);
console.log(
  previous
    ? `allowlist ${previous.length} -> ${files.length} (${previous.length - files.length} migrated)`
    : `allowlist seeded with ${files.length} files`
);
