import type { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { readWithoutJit } from '@civitai/db/knights';
import {
  createQueueDb,
  IMAGE_GATE_MIGRATION,
  IMAGE_GATE_REVOKES_MIGRATION,
  SKILL_CHECK_GATE_UNREADABLE,
  TABLE_OWNER,
} from '../../test/pglite-kysely';
import { KNIGHTS_APP_ROLE } from '../../test/knights-app-grants';
import { seedImage } from '../../test/seed';
import {
  EXCLUSION_TABLES,
  exclusionCases,
  extraExclusionCases,
} from '../../test/skill-check-exclusions';
import {
  IMAGE_GATE_COLUMNS,
  imageGateColumns,
  imageGateViewSql,
  type ImageGateColumn,
} from './image-gate';

let pg: PGlite;
let db: Kysely<DB>;
let mainAppDb: Kysely<DB>;

beforeAll(async () => {
  ({ pg, db, mainAppDb } = await createQueueDb());
});
afterAll(() => pg.close());
beforeEach(async () => {
  await pg.exec(`TRUNCATE "Image","Post",${EXCLUSION_TABLES} RESTART IDENTITY CASCADE`);
});

type Answers = Record<ImageGateColumn, boolean>;

/** Each column for each image, read from the tables (as the main app's role). */
async function fromTables(ids: number[]): Promise<Map<number, Answers>> {
  const rows = await readWithoutJit(mainAppDb, (q) =>
    q
      .selectFrom('Image as img')
      .innerJoin('Post as p', 'p.id', 'img.postId')
      .select((eb) => [
        'img.id',
        ...IMAGE_GATE_COLUMNS.map((column) =>
          sql<boolean>`COALESCE(${imageGateColumns[column](eb)}, false)`.as(column)
        ),
      ])
      .where('img.id', 'in', ids)
      .execute()
  );
  return new Map(rows.map(({ id, ...answers }) => [id, answers as Answers]));
}

/** Each column for each image, read from `view` as the Knights role. */
async function fromView(ids: number[], view = 'KnightsImageGate'): Promise<Map<number, Answers>> {
  const rows = await sql<{ imageId: number } & Answers>`
    SELECT * FROM ${sql.table(view)} WHERE "imageId" IN (${sql.join(ids)})
  `.execute(db);
  return new Map(rows.rows.map(({ imageId, ...answers }) => [imageId, answers as Answers]));
}

/** Image 1 stays clean; image 2 gets the state `apply` gives it. */
async function seedPair(apply: (id: number) => Promise<unknown>) {
  await seedImage(pg, 1);
  await seedImage(pg, 2);
  await apply(2);
}

/** Ways to put image 2 out of `servable`, the post and source legs among them. */
const servableCases = (): [string, (id: number) => Promise<unknown>][] => [
  ['unrated', (id) => pg.query(`UPDATE "Image" SET "nsfwLevel"=0 WHERE id=$1`, [id])],
  ['rated Blocked', (id) => pg.query(`UPDATE "Image" SET "nsfwLevel"=32 WHERE id=$1`, [id])],
  [
    'waiting on review',
    (id) => pg.query(`UPDATE "Image" SET "needsReview"='poi' WHERE id=$1`, [id]),
  ],
  ['a real person', (id) => pg.query(`UPDATE "Image" SET poi=true WHERE id=$1`, [id])],
  ['a draft post', (id) => pg.query(`UPDATE "Post" SET "publishedAt"=NULL WHERE id=$1`, [id])],
  [
    'a private post',
    (id) => pg.query(`UPDATE "Post" SET availability='Private' WHERE id=$1`, [id]),
  ],
  [
    'a muted uploader',
    async (id) => {
      await pg.query(`INSERT INTO "User" ("id","username","muted") VALUES (44,'m',true)`);
      await pg.query(`UPDATE "Image" SET "userId"=44 WHERE id=$1`, [id]);
    },
  ],
  [
    "an unpublished post's model version",
    async (id) => {
      await pg.query(`INSERT INTO "Model" ("id","status") VALUES (70,'Published')`);
      await pg.query(`INSERT INTO "ModelVersion" ("id","modelId","status") VALUES (71,70,'Draft')`);
      await pg.query(`UPDATE "Post" SET "modelVersionId"=71 WHERE id=$1`, [id]);
    },
  ],
  [
    "a post's model removed for a violation",
    async (id) => {
      await pg.query(`INSERT INTO "Model" ("id","status") VALUES (72,'Published')`);
      await pg.query(
        `INSERT INTO "ModelVersion" ("id","modelId","status") VALUES (73,72,'UnpublishedViolation')`
      );
      await pg.query(`UPDATE "Post" SET "modelVersionId"=73 WHERE id=$1`, [id]);
    },
  ],
];

const allCases = () => [
  ...servableCases(),
  ...exclusionCases(() => pg),
  ...extraExclusionCases(() => pg),
];

describe('"KnightsImageGate"', () => {
  it('is created from exactly the SQL imageGateViewSql generates', () => {
    const migration = readFileSync(IMAGE_GATE_MIGRATION, 'utf8');
    const start = '-- generated: imageGateViewSql\n';
    const end = '\n-- end generated';
    expect(migration.includes(start) && migration.includes(end)).toBe(true);
    expect(migration.slice(migration.indexOf(start) + start.length, migration.indexOf(end))).toBe(
      imageGateViewSql()
    );
  });

  it.each(allCases())('answers as the tables do for an image %s', async (_label, apply) => {
    await seedPair(apply);
    expect(await fromView([1, 2])).toEqual(await fromTables([1, 2]));
  });

  it('answers differently from the tables when a leg is left out (the check above can fail)', async () => {
    const leg = '"img"."tosViolation" = false and ';
    const full = imageGateViewSql();
    expect(full.split(leg).length).toBeGreaterThan(1);
    await pg.exec(`CREATE VIEW "KnightsImageGateMutant" AS ${full.split(leg).join('')};
      GRANT SELECT ON "KnightsImageGateMutant" TO ${KNIGHTS_APP_ROLE};`);
    try {
      await seedPair((id) => pg.query(`UPDATE "Image" SET "tosViolation"=true WHERE id=$1`, [id]));
      expect(await fromView([1, 2], 'KnightsImageGateMutant')).not.toEqual(
        await fromTables([1, 2])
      );
      expect(await fromView([1, 2])).toEqual(await fromTables([1, 2]));
    } finally {
      await pg.exec('DROP VIEW "KnightsImageGateMutant"');
    }
  });

  it('serves a clean image on every column', async () => {
    await seedImage(pg, 1);
    expect((await fromView([1])).get(1)).toEqual({
      servable: true,
      sweepServable: true,
      skillCheckEligible: true,
      skillCheckLasting: true,
    });
  });

  it('never puts an image out of a column for one reason alone, and every column but sweepServable implies servable', async () => {
    const reasonsOut = new Map<ImageGateColumn, Set<string>>(
      IMAGE_GATE_COLUMNS.map((c) => [c, new Set()])
    );
    /** Reasons a skill-check column is out while the image is still servable. */
    const outWhileServable = new Set<string>();
    for (const [label, apply] of allCases()) {
      await pg.exec(`TRUNCATE "Image","Post",${EXCLUSION_TABLES} RESTART IDENTITY CASCADE`);
      await seedPair(apply);
      const answers = (await fromView([2])).get(2);
      if (!answers) throw new Error(`no gate row for the image ${label}`);
      for (const column of IMAGE_GATE_COLUMNS)
        if (!answers[column]) reasonsOut.get(column)?.add(label);
      for (const column of ['skillCheckEligible', 'skillCheckLasting'] as const)
        if (answers[column]) expect(answers.servable).toBe(true);
      if (answers.servable && !answers.skillCheckEligible) outWhileServable.add(label);
      if (answers.servable) expect(answers.sweepServable).toBe(true);
    }
    for (const column of IMAGE_GATE_COLUMNS)
      expect(reasonsOut.get(column)?.size).toBeGreaterThanOrEqual(2);
    // A skill-check column out on a servable image does not narrow to a CSAM or hold reason: many others do the same.
    const csamOrHold = /held-media|reported-image|csam-signal/;
    expect(
      [...outWhileServable].filter((reason) => !csamOrHold.test(reason)).length
    ).toBeGreaterThanOrEqual(5);
  });
});

describe('what the Knights role may do', () => {
  const refused = (statement: string, message = /permission denied for (table|view)/) =>
    expect(sql.raw(statement).execute(db)).rejects.toThrow(message);

  it('reads the gate, and cannot write through it', async () => {
    await seedImage(pg, 1);
    await expect(
      sql.raw('SELECT count(*) FROM "KnightsImageGate"').execute(db)
    ).resolves.toBeTruthy();
    await refused(
      'UPDATE "KnightsImageGate" SET servable = true',
      /cannot update view "KnightsImageGate"/
    );
    await refused('DELETE FROM "KnightsImageGate"', /cannot delete from view "KnightsImageGate"/);
    // Not only a view Postgres cannot write through: the role holds no write privilege on it either.
    const writes = await pg.query<{ any: boolean }>(
      `SELECT has_table_privilege('${KNIGHTS_APP_ROLE}', '"KnightsImageGate"', 'INSERT,UPDATE,DELETE,TRUNCATE') AS any`
    );
    expect(writes.rows[0].any).toBe(false);
  });

  it('cannot read the tables behind it', async () => {
    for (const table of ['CsamReport', 'ScanLabelItem', 'BlockedImage', 'ModelVersion'])
      await refused(`SELECT 1 FROM "${table}" LIMIT 1`);
  });

  it("cannot add a vote partition itself, only through the owner's function", async () => {
    await refused(
      `CREATE TABLE "KnightsVote_2099_01" PARTITION OF "KnightsVote" FOR VALUES FROM ('2099-01-01') TO ('2099-02-01')`,
      /permission denied for schema public/
    );
  });

  it('reads the other columns when the skill-check ones are closed to it', async () => {
    await seedImage(pg, 1);
    await pg.exec(SKILL_CHECK_GATE_UNREADABLE);
    try {
      await expect(
        sql.raw('SELECT servable FROM "KnightsImageGate"').execute(db)
      ).resolves.toBeTruthy();
      await refused('SELECT "skillCheckEligible" FROM "KnightsImageGate"');
    } finally {
      await pg.exec(`GRANT SELECT ON "KnightsImageGate" TO ${KNIGHTS_APP_ROLE}`);
    }
  });

  it('is the only role besides the owner that may read the gate or run the partition function', async () => {
    await pg.exec('CREATE ROLE stranger');
    try {
      for (const statement of [
        'SELECT 1 FROM "KnightsImageGate" LIMIT 1',
        'SELECT public.knights_ensure_vote_partition(2026, 1)',
      ]) {
        await pg.exec('SET ROLE stranger');
        try {
          await expect(pg.query(statement)).rejects.toThrow(/permission denied/);
        } finally {
          await pg.exec('RESET ROLE');
        }
      }
    } finally {
      await pg.exec('DROP ROLE stranger');
    }
  });
});

describe('knights_ensure_vote_partition', () => {
  /** `[year, month]` `n` months from the real one. */
  const month = (n: number): [number, number] => {
    const at = new Date();
    const d = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + n, 1));
    return [d.getUTCFullYear(), d.getUTCMonth() + 1];
  };
  const ensure = ([year, m]: [number, number]) =>
    sql`SELECT public.knights_ensure_vote_partition(${year}::int, ${m}::int)`.execute(db);
  const name = ([year, m]: [number, number]) => `KnightsVote_${year}_${String(m).padStart(2, '0')}`;

  it("creates the month's partition, owned by the table's owner", async () => {
    const target = month(3);
    await pg.exec(`DO $$ BEGIN
      IF to_regclass('"${name(target)}"') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "${name(
      target
    )}")
      THEN DROP TABLE "${name(target)}"; END IF; END $$;`);
    await ensure(target);
    await ensure(target);
    const row = await pg.query<{ owner: string; parent: string }>(
      `SELECT pg_get_userbyid(c.relowner) AS owner, i.inhparent::regclass::text AS parent
       FROM pg_class c JOIN pg_inherits i ON i.inhrelid = c.oid WHERE c.oid = to_regclass($1)`,
      [`"${name(target)}"`]
    );
    expect(row.rows).toEqual([{ owner: TABLE_OWNER, parent: '"KnightsVote"' }]);
  });

  it('takes the previous month through three ahead, and nothing outside them', async () => {
    await expect(ensure(month(-1))).resolves.toBeTruthy();
    await expect(ensure(month(3))).resolves.toBeTruthy();
    await expect(ensure(month(-2))).rejects.toThrow(/outside/);
    await expect(ensure(month(4))).rejects.toThrow(/outside/);
    await expect(ensure([2026, 13])).rejects.toThrow(/no month/);
    await expect(ensure([2026, 0])).rejects.toThrow(/no month/);
  });
});

describe('the revoke migration', () => {
  const REVOKES = IMAGE_GATE_REVOKES_MIGRATION;
  const apply = async () => {
    await pg.exec(`SET ROLE ${TABLE_OWNER}`);
    try {
      await pg.exec(readFileSync(REVOKES, 'utf8'));
    } catch (error) {
      // The file's own transaction is left aborted by the failure.
      await pg.exec('ROLLBACK');
      throw error;
    } finally {
      await pg.exec('RESET ROLE');
    }
  };

  it('takes back a direct grant', async () => {
    await pg.exec(`GRANT SELECT ON "CsamReport" TO ${KNIGHTS_APP_ROLE}`);
    await apply();
    await expect(sql.raw('SELECT 1 FROM "CsamReport" LIMIT 1').execute(db)).rejects.toThrow(
      /permission denied/
    );
  });

  it('fails when the role still holds SELECT another way', async () => {
    await pg.exec(`GRANT SELECT ON "CsamReport" TO PUBLIC`);
    try {
      await expect(apply()).rejects.toThrow(/still holds SELECT on CsamReport/);
    } finally {
      await pg.exec(`REVOKE SELECT ON "CsamReport" FROM PUBLIC`);
    }
  });
});

describe('the image gate migration', () => {
  it('refuses to run as a superuser', async () => {
    await expect(pg.exec(readFileSync(IMAGE_GATE_MIGRATION, 'utf8'))).rejects.toThrow(
      /not a superuser/
    );
    await pg.exec('ROLLBACK');
  });
});

describe('"KnightsImageGate" on a file another image row shares', () => {
  const OUT: Answers = {
    servable: false,
    sweepServable: false,
    skillCheckEligible: false,
    skillCheckLasting: false,
  };

  /** Image 2 is clean; image 3 is on image 2's stored url and gets the state `apply` gives it. */
  async function seedSharedFile(apply: (id: number) => Promise<unknown>) {
    await seedImage(pg, 2);
    await seedImage(pg, 3);
    await pg.query(`UPDATE "Image" SET url='key-2' WHERE id=3`);
    await apply(3);
  }

  const heldSiblings: [string, (id: number) => Promise<unknown>][] = [
    [
      'in the CSAM queue',
      (id) => pg.query(`UPDATE "Image" SET "needsReview"='csam' WHERE id=$1`, [id]),
    ],
    [
      'blocked as CSAM',
      (id) => pg.query(`UPDATE "Image" SET "blockedFor"='CSAM' WHERE id=$1`, [id]),
    ],
    [
      'listed on a CsamReport',
      (id) =>
        pg.query(
          `INSERT INTO "CsamReport" ("images") VALUES (jsonb_build_array(jsonb_build_object('id',$1::int)))`,
          [id]
        ),
    ],
  ];

  it.each(heldSiblings)(
    'puts an image out of every column when a row on its file is %s',
    async (_l, apply) => {
      await seedSharedFile(apply);
      expect((await fromView([2])).get(2)).toEqual(OUT);
      expect((await fromTables([2])).get(2)).toEqual(OUT);
    }
  );

  it('keeps serving an image whose file a clean row shares, or whose held neighbour is on another file', async () => {
    await seedSharedFile(async () => undefined);
    await seedImage(pg, 4);
    await pg.query(`UPDATE "Image" SET "needsReview"='csam' WHERE id=4`);
    for (const answers of [await fromView([2, 3]), await fromTables([2, 3])]) {
      expect(answers.get(2)?.servable).toBe(true);
      expect(answers.get(3)?.servable).toBe(true);
    }
  });

  it('keeps serving an image whose file a row by a reported owner shares: only item-level states carry over', async () => {
    await seedSharedFile(async (id) => {
      await pg.query(`INSERT INTO "CsamReport" ("userId") VALUES (45)`);
      await pg.query(`UPDATE "Image" SET "userId"=45 WHERE id=$1`, [id]);
    });
    for (const answers of [await fromView([2, 3]), await fromTables([2, 3])]) {
      expect(answers.get(3)?.servable).toBe(false);
      expect(answers.get(2)?.servable).toBe(true);
    }
  });

  it('answers differently without the shared-file leg (the cases above can fail)', async () => {
    const full = imageGateViewSql();
    const leg = 'WHERE sf_i.url = img.url';
    expect(full.split(leg).length - 1).toBe(IMAGE_GATE_COLUMNS.length);
    const mutant = full.split(leg).join(`WHERE false AND sf_i.url = img.url`);
    await pg.exec(`CREATE VIEW "KnightsImageGateMutant" AS ${mutant};
      GRANT SELECT ON "KnightsImageGateMutant" TO ${KNIGHTS_APP_ROLE};`);
    try {
      await seedSharedFile((id) =>
        pg.query(`UPDATE "Image" SET "blockedFor"='CSAM' WHERE id=$1`, [id])
      );
      expect((await fromView([2], 'KnightsImageGateMutant')).get(2)?.servable).toBe(true);
      expect((await fromView([2])).get(2)?.servable).toBe(false);
    } finally {
      await pg.exec('DROP VIEW "KnightsImageGateMutant"');
    }
  });
});
