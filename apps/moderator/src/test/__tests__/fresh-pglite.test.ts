import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, inject, it } from 'vitest';
import { freshPglite } from '../pglite';

let db: PGlite;
beforeEach(async () => {
  db = await freshPglite();
});
afterEach(async () => {
  await db.close();
});

// Order-dependent on purpose: the second case is only meaningful after the first has written.
describe.sequential('freshPglite', () => {
  it('starts from the template the globalSetup built, not a fallback initdb', () => {
    expect(inject('pgliteTemplatePath')).toEqual(expect.any(String));
  });

  it('gives a test a writable cluster', async () => {
    await db.exec(
      `CREATE TABLE "Probe" ("id" INTEGER PRIMARY KEY); INSERT INTO "Probe" VALUES (1);`
    );
    const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM "Probe"`);
    expect(rows[0].n).toBe(1);
  });

  it('gives the next test its own copy, without what the previous test wrote', async () => {
    const { rows } = await db.query<{ t: string | null }>(
      `SELECT to_regclass('"Probe"')::text AS t`
    );
    expect(rows[0].t).toBeNull();
  });
});

describe('pglite clusters in this app', () => {
  // A direct create still works, but pays a full initdb per test: that is what took this app's
  // suite from 3 to 10 minutes in CI.
  it('are all created through freshPglite', () => {
    const src = join(dirname(fileURLToPath(import.meta.url)), '../..');
    const direct = readdirSync(src, { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.ts') && !f.split(sep).join('/').startsWith('test/pglite'))
      .filter((f) => /\bPGlite\.create\(|\bnew PGlite\(/.test(readFileSync(join(src, f), 'utf8')));
    expect(direct).toEqual([]);
  });
});
