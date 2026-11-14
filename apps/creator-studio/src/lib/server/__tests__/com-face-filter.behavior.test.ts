import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

type Fragment = { strings: readonly string[]; values: unknown[] };
type Ident = { ident: string };

// kysely's `sql` tag, rendered to the statement Postgres receives, so the "Customized for civitai.com"
// predicate is run against real rows rather than read as text.
vi.mock('@civitai/db/kysely', () => {
  const render = (f: Fragment, params: unknown[]): string =>
    f.strings.reduce((out, s, i) => {
      if (i === f.values.length) return out + s;
      const v = f.values[i];
      if (v && typeof v === 'object' && 'ident' in v) return out + s + (v as Ident).ident;
      if (v && typeof v === 'object' && 'strings' in v)
        return out + s + render(v as Fragment, params);
      params.push(v);
      return `${out}${s}$${params.length}`;
    }, '');
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => ({
    strings,
    values,
    render: () => {
      const params: unknown[] = [];
      return { text: render({ strings, values }, params), params };
    },
  });
  sql.raw = (text: string): Ident => ({ ident: text });
  sql.lit = (value: number | string): Ident => ({ ident: String(value) });
  sql.join = (parts: Ident[]): Ident => ({ ident: parts.map((p) => p.ident).join(', ') });
  return { sql };
});

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));

const { comFaceReadySql, hasComFaceSql } = await import('../models');

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE "Model" (id int PRIMARY KEY, "sfwName" text, "sfwCoverImageId" int, meta jsonb);
    INSERT INTO "Model" VALUES
      (1, NULL, NULL, NULL),
      (2, 'Safe name', 11, NULL),
      (3, 'Safe name', NULL, '{"comFaceRemoved": {"kind": "cover"}}'),
      (4, 'Safe name', 12, '{"comFaceRemoved": {"kind": "cover"}}'),
      (5, 'Safe name', 13, '{}');
  `);
});

describe('hasComFaceSql', () => {
  it('lists models whose civitai.com face is on, and not ones without a face or with it removed', async () => {
    const where = (hasComFaceSql('"Model"') as unknown as {
      render: () => { text: string; params: unknown[] };
    }).render();
    const { rows } = await db.query<{ id: number }>(
      `select id from "Model" where ${where.text} order by id`,
      where.params
    );
    // 1: no face. 3: a moderator removed it and cleared the cover. 4: removed, then the owner set a new cover.
    expect(rows.map((r) => r.id)).toEqual([2, 4, 5]);
  });
});

describe('comFaceReadySql', () => {
  it('lists mature models with no face where one could be added, and none a lock or flag rules out', async () => {
    const ready = new PGlite();
    await ready.exec(`
      CREATE TABLE "Model" (
        id int PRIMARY KEY, nsfw boolean, "lockedProperties" text[], minor boolean, poi boolean,
        "sfwOnly" boolean, mode text, "sfwName" text, "sfwCoverImageId" int, meta jsonb
      );
      INSERT INTO "Model" VALUES
        (1, true, NULL, false, false, false, NULL, NULL, NULL, NULL),
        (2, false, NULL, false, false, false, NULL, NULL, NULL, NULL),
        (3, true, '{nsfw}', false, false, false, NULL, NULL, NULL, NULL),
        (4, true, '{tags}', false, false, false, NULL, NULL, NULL, NULL),
        (5, true, NULL, true, false, false, NULL, NULL, NULL, NULL),
        (6, true, NULL, false, false, false, 'TakenDown', NULL, NULL, NULL),
        (7, true, NULL, false, false, false, NULL, 'Safe name', 11, NULL),
        (8, true, NULL, false, false, false, NULL, 'Safe name', NULL, '{"comFaceRemoved": {}}'),
        (9, true, NULL, false, false, false, NULL, NULL, NULL, '{"comFaceIntent": {"detected": true}}'),
        (10, true, NULL, false, false, false, NULL, NULL, NULL, '{"comFaceIntent": {"detected": true, "overturnedAt": "x"}}'),
        (11, true, NULL, false, false, false, NULL, NULL, NULL, '{"comFaceIntent": {"detected": false}}');
    `);
    const where = (comFaceReadySql('"Model"') as unknown as {
      render: () => { text: string; params: unknown[] };
    }).render();
    const { rows } = await ready.query<{ id: number }>(
      `select id from "Model" where ${where.text} order by id`,
      where.params
    );
    // 2: not mature. 3: nsfw locked. 5: minor. 6: taken down. 7: has a face. 8 is in: a removed
    // face can be added again. 9: the intent check's detection refuses a face; 10: overturned.
    expect(rows.map((r) => r.id)).toEqual([1, 4, 8, 10, 11]);
    await ready.close();
  });
});
