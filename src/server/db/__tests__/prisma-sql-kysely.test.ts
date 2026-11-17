import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { fromPrismaSql, queryPrismaSql } from '~/server/db/prisma-sql-kysely';
import { fakeKysely, templateOf } from '~/test-utils/kysely-raw-fake';

/**
 * `queryPrismaSql` moves a hot raw read off the Prisma engine on the promise that the database
 * receives the SAME statement: identical text, identical parameters in identical order. Pinned here
 * against what Prisma itself would send (`statement.text` / `statement.values`), across the shapes
 * the ported reads use: nested fragments, `Prisma.join`, `Prisma.raw`, `Prisma.empty`, arrays,
 * NULL-ish values and a repeated value.
 */

const USER = 4101;
const IMAGE_IDS = [4201, 4202, 4203];
const AFTER = new Date('2026-11-01T02:03:04.005Z');

const owner = (alias: string) => Prisma.sql`${Prisma.raw(`"${alias}"`)}."userId" = ${USER}`;
const statement = Prisma.sql`
  SELECT i.id, ${Prisma.sql`NULL::boolean`} AS "visibleSignedOut"
  FROM "Image" i
  WHERE ${Prisma.join([Prisma.sql`i.id = ANY(${IMAGE_IDS}::int[])`, owner('i')], ' AND ')}
    AND i."postId" IN (${Prisma.join([7, 8])})
    AND i."createdAt" > ${AFTER} ${Prisma.empty}
    AND (i."userId" = ${undefined} OR i."userId" = ${null} OR i."userId" = ${USER})
`;

describe('fromPrismaSql', () => {
  const compiled = fromPrismaSql(statement).compile(fakeKysely(async () => []));

  it('compiles to exactly the text Prisma sends', () => {
    expect(compiled.sql).toBe(statement.text);
    // A control on the control: the text really carries the nested and joined pieces.
    expect(compiled.sql).toContain('"i"."userId" = $2');
    expect(compiled.sql).toContain('IN ($3,$4)');
  });

  it('binds exactly the values Prisma binds, in order', () => {
    expect(compiled.parameters).toEqual(statement.values);
    expect(compiled.parameters).toEqual([IMAGE_IDS, USER, 7, 8, AFTER, undefined, null, USER]);
  });
});

describe('queryPrismaSql', () => {
  it('runs the statement once and returns its rows as they come', async () => {
    const rows = [{ id: IMAGE_IDS[0], visibleSignedOut: null }];
    const handler = vi.fn(async () => rows);

    await expect(queryPrismaSql(fakeKysely(handler), statement)).resolves.toBe(rows);

    expect(handler).toHaveBeenCalledTimes(1);
    const [strings, ...values] = handler.mock.calls[0] as unknown as [string[], ...unknown[]];
    expect(Prisma.sql(strings, ...(values as never[])).text).toBe(statement.text);
    expect(values).toEqual(statement.values);
  });

  it('rejects with the client error, so a caller can fall back', async () => {
    const failing = fakeKysely(async () => {
      throw new Error('replica error');
    });
    await expect(queryPrismaSql(failing, statement)).rejects.toThrow('replica error');
  });
});

describe('templateOf (the fake itself)', () => {
  it('refuses a statement whose placeholders do not line up with its parameters', () => {
    expect(() => templateOf({ sql: 'SELECT $2', parameters: [1], query: {} } as never)).toThrow(
      /placeholders/
    );
    expect(() => templateOf({ sql: 'SELECT $1, $2', parameters: [1], query: {} } as never)).toThrow(
      /placeholders/
    );
    expect(templateOf({ sql: 'SELECT $1, $2', parameters: [1, 2], query: {} } as never)).toEqual([
      ['SELECT ', ', ', ''],
      1,
      2,
    ]);
  });
});
