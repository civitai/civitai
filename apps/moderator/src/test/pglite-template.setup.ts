import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
