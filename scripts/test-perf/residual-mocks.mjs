#!/usr/bin/env node
/**
 * Which files in a list STILL mock a canonical shared module directly.
 *
 *   node scripts/test-perf/residual-mocks.mjs .test-perf/pilot.txt
 *
 * The number that matters when reading a `--no-isolate` pilot: a single hold-out freezes
 * its mock shape into every consumer module in its worker, so a partially-migrated set
 * measures the hold-outs, not the system.
 */
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const listPath = process.argv[2] ?? '.test-perf/pilot.txt';
const files = readFileSync(path.resolve(repoRoot, listPath), 'utf8')
  .split('\n')
  .map((s) => s.trim())
  .filter(Boolean);

const SPECIFIERS = ['~/server/db/client', '~/server/redis/client', '~/server/logging/client'];
const pattern = (spec) =>
  new RegExp(String.raw`vi\.mock\(\s*['"\`]` + spec.replace(/[/~]/g, (c) => `\\${c}`) + String.raw`['"\`]`);

const residual = {};
for (const spec of SPECIFIERS) residual[spec] = [];
for (const file of files) {
  const src = readFileSync(path.resolve(repoRoot, file), 'utf8');
  for (const spec of SPECIFIERS) if (pattern(spec).test(src)) residual[spec].push(file);
}

for (const spec of SPECIFIERS) console.log(`${String(residual[spec].length).padStart(4)}  ${spec}`);
writeFileSync(path.resolve(repoRoot, '.test-perf/residual-mocks.json'), JSON.stringify(residual, null, 2));
console.log(`\n${files.length} files scanned -> .test-perf/residual-mocks.json`);
