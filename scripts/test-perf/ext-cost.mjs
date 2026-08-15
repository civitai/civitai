#!/usr/bin/env node
/**
 * What each EXTERNAL package costs the unit suite.
 *
 * Externalised deps are never transformed, so no vite-side instrument can see them — but every
 * test file is a fresh process, so each file that reaches a package pays its cold import again.
 * Cost is measured the same way the suite pays it: one `import()` in a brand-new node process.
 *
 * Reads the fan-in counts from `externals.mjs --top 200` (path in argv[2]).
 */
import { readFileSync } from 'fs';
import { spawn } from 'child_process';

const listPath = process.argv[2] ?? '.test-perf/externals.txt';
const rows = readFileSync(listPath, 'utf8')
  .split('\n')
  .slice(1)
  .map((l) => l.trim().match(/^(\d+)\s+(\S+)$/))
  .filter(Boolean)
  .map((m) => [Number(m[1]), m[2]])
  .filter(([, p]) => /^[@a-z]/.test(p))
  .slice(0, Number(process.env.EXT_LIMIT ?? 60));

const coldImportMs = (pkg) =>
  new Promise((res) => {
    const p = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const t=performance.now();await import(${JSON.stringify(pkg)});console.log(Math.round(performance.now()-t))`,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] }
    );
    let s = '';
    p.stdout.on('data', (d) => (s += d));
    p.on('close', () => res(Number(s.trim())));
  });

const out = [];
for (const [tests, pkg] of rows) {
  const ms = await coldImportMs(pkg);
  if (Number.isFinite(ms)) out.push({ pkg, tests, ms, total: Math.round((tests * ms) / 1000) });
}
out.sort((a, b) => b.total - a.total);
console.log('package'.padEnd(34) + 'tests'.padStart(6) + 'cold-ms'.padStart(9) + 'suite-s'.padStart(9));
for (const o of out.slice(0, Number(process.env.EXT_TOP ?? 25)))
  console.log(
    o.pkg.padEnd(34) + String(o.tests).padStart(6) + String(o.ms).padStart(9) + String(o.total).padStart(9)
  );
console.log('\nattributable total: ' + out.reduce((a, o) => a + o.total, 0) + 's over ' + out.length + ' packages');
