import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  ingestionAfterScanErrorSql,
  ingestionAfterVerdictSql,
  ingestionKeptAfterVerdict,
} from '~/server/common/image-visibility';

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM
      ('Pending','Scanned','Error','Blocked','NotFound','PendingManualAssignment','Rescan');
    CREATE TABLE "Image" (id int PRIMARY KEY, ingestion "ImageIngestionStatus" NOT NULL);
  `);
});

// Runs the real fragment the scan pipeline's UPDATE uses, against a row in each starting state.
async function run(current: string, fragment: Prisma.Sql) {
  await db.exec(`DELETE FROM "Image"; INSERT INTO "Image" VALUES (1, '${current}')`);
  const sql = Prisma.sql`UPDATE "Image" SET ingestion = ${fragment} WHERE id = 1 RETURNING ingestion::text AS ingestion`;
  const r = await db.query(sql.text, sql.values as unknown[]);
  return (r.rows[0] as { ingestion: string }).ingestion;
}
const after = (current: string, verdict: string) => run(current, ingestionAfterVerdictSql(verdict));
const afterError = (current: string) => run(current, ingestionAfterScanErrorSql());

// A hidden image (original gone) is kept off public reads by ingestion = NotFound. Do not delete
// these to "simplify" the scan UPDATE: a stale clean result would republish it. The rows come from
// the lost-original hide run; the guard must be live before that run is applied.
describe('scan verdict vs a NotFound image', () => {
  it('a clean verdict does not lift NotFound to Scanned', async () => {
    expect(await after('NotFound', 'Scanned')).toBe('NotFound');
  });

  it('a Blocked verdict still lands on a NotFound image', async () => {
    expect(await after('NotFound', 'Blocked')).toBe('Blocked');
  });

  it.each(['Pending', 'Rescan', 'Error', 'Scanned'])(
    'a clean verdict still scans a %s image (a requested rescan recovers normally)',
    async (state) => {
      expect(await after(state, 'Scanned')).toBe('Scanned');
    }
  );

  it('a failed scan does not replace NotFound with Error (Error + a locked rating would publish it)', async () => {
    expect(await afterError('NotFound')).toBe('NotFound');
    expect(await afterError('Pending')).toBe('Error');
    expect(await afterError('Scanned')).toBe('Error');
  });

  it('reports a Blocked verdict as Blocked even for a NotFound image', () => {
    expect(ingestionKeptAfterVerdict('NotFound', 'Blocked' as any)).toBe('Blocked');
    expect(ingestionKeptAfterVerdict('NotFound', 'Scanned' as any)).toBe('NotFound');
    expect(ingestionKeptAfterVerdict('Rescan', 'Scanned' as any)).toBe('Scanned');
  });
});
