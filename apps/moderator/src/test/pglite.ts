import { existsSync, readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { inject } from 'vitest';

let template: Blob | null | undefined;

function loadTemplate(): Blob | null {
  if (template !== undefined) return template;
  const path = inject('pgliteTemplatePath');
  if (path && existsSync(path)) {
    template = new Blob([readFileSync(path)]);
  } else {
    template = null;
    console.warn(
      '[freshPglite] no cluster template (pglite-template.setup.ts did not run for this project), ' +
        'so every cluster runs its own initdb. Correct, just ~5x slower.'
    );
  }
  return template;
}

/**
 * A brand-new, empty Postgres cluster: what `PGlite.create()` returns, started from the cluster the
 * globalSetup built instead of running initdb again. Every call loads its own copy, so no two tests
 * share a data directory.
 *
 * Takes no options on purpose: the template is built with none, and a cluster loaded from it with
 * different ones (an extension, a database name) would not be the cluster the test asked for. A
 * suite that needs options gets its own template here first.
 */
export async function freshPglite(): Promise<PGlite> {
  const loadDataDir = loadTemplate();
  return loadDataDir ? PGlite.create({ loadDataDir }) : PGlite.create();
}
