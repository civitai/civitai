import { PGlite } from '@electric-sql/pglite';
import {
  type DatabaseConnection,
  type Dialect,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CommentV3Db } from '~/server/services/commentv3/read.service';
import { getCommentSong } from '~/server/services/commentv3/timed-comments.service';

const dialect = (pg: PGlite): Dialect => {
  const connection: DatabaseConnection = {
    async executeQuery(compiled) {
      const result = await pg.query(compiled.sql, compiled.parameters as unknown[]);
      return { rows: result.rows as never[], numAffectedRows: BigInt(result.affectedRows ?? 0) };
    },
    // eslint-disable-next-line require-yield
    async *streamQuery() {
      throw new Error('not used');
    },
  };
  const noop = async () => undefined;
  return {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => ({
      init: noop,
      acquireConnection: async () => connection,
      beginTransaction: noop,
      commitTransaction: noop,
      rollbackTransaction: noop,
      releaseConnection: noop,
      destroy: noop,
    }),
    createIntrospector: (k) => new PostgresIntrospector(k),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  };
};

let pg: PGlite;
let db: CommentV3Db;
beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE "Image" (id int PRIMARY KEY, type text NOT NULL, metadata jsonb);
    INSERT INTO "Image" VALUES
      (1, 'audio', '{"duration": 180}'),
      (2, 'image', '{"duration": 180}'),
      (3, 'audio', '{}'),
      (4, 'audio', '{"duration": 0}'),
      (5, 'audio', '{"duration": "180"}');
  `);
  db = new Kysely({ dialect: dialect(pg) }) as unknown as CommentV3Db;
});
afterAll(async () => {
  await pg.close();
});

describe('getCommentSong', () => {
  it('reads a song and its stored length', async () => {
    expect(await getCommentSong(db, 1)).toEqual({ durationSec: 180 });
  });

  it('is null for an image that is not a song, and for a missing image', async () => {
    expect(await getCommentSong(db, 2)).toBeNull();
    expect(await getCommentSong(db, 99)).toBeNull();
  });

  it('has no length for a song without a usable stored one', async () => {
    expect(await getCommentSong(db, 3)).toEqual({ durationSec: null });
    expect(await getCommentSong(db, 4)).toEqual({ durationSec: null });
    expect(await getCommentSong(db, 5)).toEqual({ durationSec: null });
  });
});
