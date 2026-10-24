import { readFileSync, readdirSync } from 'fs';
import { join, relative, resolve } from 'path';
import { describe, expect, it } from 'vitest';
import { stripSourceComments } from '~/components/AppBlocks/stripSourceComments';

/**
 * T14 SEAM GUARD — who touches `app_listing_red_media`.
 *
 * The table is manual-apply, so every statement against it has to go through the probe in
 * `listing-media-split.service.ts`. That the probe runs, and keeps a surrounding transaction
 * alive while the table is absent, is tested behaviourally in `listing-media-split.pglite.test.ts`;
 * this pins only that no other production module names the table, so a second, unprobed
 * statement cannot appear elsewhere. Pinned by equality, so the set GROWING or SHRINKING fails.
 */

const SRC = resolve(__dirname, '../../../..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const isTestPath = (rel: string) =>
  rel.includes('__tests__') || /\.test\.tsx?$/.test(rel) || /(^|\/)tests\//.test(rel);

const PRODUCTION = walk(SRC)
  .map((full) => ({ rel: relative(SRC, full).replace(/\\/g, '/'), full }))
  .filter(({ rel }) => !isTestPath(rel))
  .map(({ rel, full }) => ({ rel, code: stripSourceComments(readFileSync(full, 'utf8')) }));

const SERVICE = 'server/services/blocks/listing-media-split.service.ts';

describe('app_listing_red_media — the one module that names it', () => {
  it('positive control: the walk reaches the service and reads its SQL', () => {
    expect(PRODUCTION.length).toBeGreaterThan(1000);
    expect(PRODUCTION.find((f) => f.rel === SERVICE)?.code).toMatch(/app_listing_red_media/);
  });

  it('is named by exactly one production module', () => {
    expect(
      PRODUCTION.filter((f) => /app_listing_red_media/.test(f.code)).map((f) => f.rel)
    ).toEqual([SERVICE]);
  });
});
