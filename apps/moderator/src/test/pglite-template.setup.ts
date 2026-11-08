import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import type { TestProject } from 'vitest/node';

/**
 * Vitest globalSetup: runs initdb ONCE per test run and hands the resulting empty cluster to every
 * worker as a file on disk. `freshPglite()` (./pglite.ts) starts each test's own cluster from it.
 *
 * initdb is ~880 ms of a ~900 ms `PGlite.create()`; loading this dump is ~150 ms. The path, not the
 * bytes, is what crosses to the workers: a provided value is serialised to every worker.
 */
export default async function setup(project: TestProject) {
  // TEMP diagnostic (CI only): sample runner memory every 5s.
  if (process.env.CI) {
    const sample = () => {
      try {
        const out = execSync(
          `free -m | awk '/Mem:/{printf "used=%s avail=%s ", $3, $7}'; ps -eo rss= | awk '{s+=$1} END {printf "rssSum=%dMB ", s/1024}'; ps -eo rss=,args= --sort=-rss | head -6 | awk '{printf "%dMB:%s|", $1/1024, substr($2,1,40)}'; echo; ps -eo args= | grep -c '[v]itest/dist/workers' | sed 's/^/workers=/'; sudo -n dmesg 2>/dev/null | grep -iE 'oom|killed process' | tail -2`,
          { encoding: 'utf-8', shell: '/bin/bash' }
        );
        process.stderr.write(`MEM ${new Date().toISOString().slice(11, 19)} ${out.replace(/\n/g, ' ')}\n`);
      } catch {}
    };
    setInterval(sample, 5000).unref();
  }
  const dir = mkdtempSync(join(tmpdir(), 'moderator-pglite-template-'));
  const file = join(dir, 'cluster.tar');
  const pg = await PGlite.create();
  const dump = await pg.dumpDataDir('none');
  await pg.close();
  writeFileSync(file, Buffer.from(await dump.arrayBuffer()));
  project.provide('pgliteTemplatePath', file);
  return () => rmSync(dir, { recursive: true, force: true });
}

declare module 'vitest' {
  export interface ProvidedContext {
    pgliteTemplatePath: string;
  }
}
