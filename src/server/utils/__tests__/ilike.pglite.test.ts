import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ilikeContains } from '~/server/utils/ilike';

/**
 * The challenge text search audits the query's text, then matches titles with ILIKE. Unescaped,
 * `%` and `_` in the text are wildcards, so the search would match rows the audited text doesn't.
 */
let pg: PGlite;
beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(
    `CREATE TABLE t (title text); INSERT INTO t VALUES ('ab'), ('axb'), ('a_b'), ('a%b'), ('a\\b');`
  );
});
afterAll(() => pg.close());

const matches = async (pattern: string) =>
  (
    await pg.query<{ title: string }>('SELECT title FROM t WHERE title ILIKE $1 ORDER BY title', [
      pattern,
    ])
  ).rows.map((r) => r.title);

describe('ilikeContains', () => {
  it('matches only the literal text, never through a wildcard', async () => {
    expect(await matches(ilikeContains('a_b'))).toEqual(['a_b']);
    expect(await matches(ilikeContains('a%b'))).toEqual(['a%b']);
    expect(await matches(ilikeContains('a\\b'))).toEqual(['a\\b']);
  });

  it('still finds the text anywhere in the title, ignoring case', async () => {
    expect(await matches(ilikeContains('X'))).toEqual(['axb']);
  });

  it('control: the unescaped pattern does match through the wildcard', async () => {
    expect(await matches('%a_b%')).toEqual(['a%b', 'a\\b', 'a_b', 'axb'].sort());
  });
});
