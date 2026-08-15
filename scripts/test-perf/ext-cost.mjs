#!/usr/bin/env node
/**
 * What each EXTERNAL package costs the unit suite.
 *
 * Externalised deps are never transformed, so no vite-side instrument can see them — but every
 * test file is a fresh process, so each file that reaches a package pays its cold import again.
 * Cost is measured the same way the suite pays it: one `import()` in a brand-new node process.
 *
 * "Every test file is a fresh process" is the load-bearing claim, so it is measured, not assumed:
 * four probe files at `--max-workers=1` report four distinct `process.pid`s. Node's module cache
 * is per process, so it does NOT survive between files and the cost really is per file, not per
 * worker. Do not talk yourself out of this from an absent whole-suite delta, as I did once.
 *
 * What the numbers do NOT support is adding the rows up. The per-package cold times overlap on
 * shared transitive deps — the three `@aws-sdk` rows share core — so cutting one package off a
 * file that still reaches its dependencies through another edge refunds only part of its column.
 * Quote a row, or quote a measured before/after; never quote the total as a saving.
 *
 * Three more things the `suite-s` column is not:
 *
 * - **Not a prediction of wall clock.** It is worker time. Divide by the worker count for a wall
 *   estimate, and expect that to be optimistic, since the files reaching a package are not spread
 *   evenly across workers.
 * - **Not stable under `isolate: false`.** With isolation off a worker builds ONE registry for all
 *   its files, so a package is imported once per worker rather than once per file and the whole
 *   column collapses by roughly the worker count. Rank with this tool under the config you actually
 *   ship.
 * - **Not the whole cost of a package.** It counts import only. A dep whose cost is in what it does
 *   at call time (a client that opens a socket, a parser run per test) does not show up here at all.
 *
 * The absolute milliseconds also move with the OS file cache — `lodash-es` measured 923ms cold and
 * 547ms on a re-run minutes later, `googleapis` 2592ms then 1441ms. The RANKING held across both.
 * Treat a single run's numbers as relative, and re-measure both sides rather than comparing today's
 * figure against one from a previous session.
 *
 * Fan-in comes from `externals.mjs`, which honours `vi.mock` and treats `import()` as lazy. Both
 * corrections matter for ranking: a wholesale mock factory stops the package being loaded at all,
 * and a package reached only through `dynamic(() => import(...))` is never loaded either. A raw
 * grep for the import specifier over-counts on both.
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
