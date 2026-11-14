import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';

/** The dispute job's own selection SQL against PGlite: which appeals it may judge. Ids are invented. */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const mocks = vi.hoisted(() => ({ verdict: vi.fn(), resolve: vi.fn() }));
vi.mock('~/server/services/model-sfw-face.service', () => ({
  checkComFaceIntentVerdict: mocks.verdict,
  getOwnTriggerWords: vi.fn(async () => []),
}));
vi.mock('~/server/services/lock-review.service', () => ({
  resolveLockReviewAppeal: mocks.resolve,
}));

const { processComFaceIntentDisputes } = await import(
  '~/server/services/model-com-face-intent-dispute.service'
);

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TYPE "AppealStatus" AS ENUM ('Pending', 'Approved', 'Rejected', 'Void');
    CREATE TABLE "Model" (
      id int PRIMARY KEY, "userId" int NOT NULL, name text NOT NULL, description text,
      "lockedProperties" text[], meta jsonb
    );
    CREATE TABLE "Appeal" (
      id int PRIMARY KEY, "userId" int NOT NULL, "entityType" text NOT NULL, "entityId" int NOT NULL,
      status "AppealStatus" NOT NULL DEFAULT 'Pending', category text, context jsonb,
      "createdAt" timestamp(3) NOT NULL DEFAULT now()
    );
  `);
  const raw = pgliteRaw(db);
  dbMock.dbWrite.$queryRaw.mockImplementation(raw.queryRaw as never);
  dbMock.dbWrite.$executeRaw.mockImplementation(raw.executeRaw as never);
});
afterAll(() => db.close());

const dispute = { kind: 'lock-review', locks: ['nsfw'], dispute: 'comFaceIntent' };

beforeEach(async () => {
  vi.clearAllMocks();
  // A verdict the job cannot use, so each selected appeal is only stamped with a retry count.
  mocks.verdict.mockResolvedValue({ status: 'unavailable' });
  await db.exec(`DELETE FROM "Appeal"; DELETE FROM "Model";`);
  for (const id of [1, 2, 3, 4, 5, 6])
    await db.query(
      `INSERT INTO "Model" (id, "userId", name, "lockedProperties", meta) VALUES ($1, 9, 'n', '{nsfw}', '{}')`,
      [id]
    );
  const appeal = (
    id: number,
    context: unknown,
    status = 'Pending',
    category: string | null = null
  ) =>
    db.query(
      `INSERT INTO "Appeal" (id, "userId", "entityType", "entityId", status, category, context)
       VALUES ($1, 9, 'Model', $1, $2, $3, $4)`,
      [id, status, category, context]
    );
  await appeal(1, dispute);
  await appeal(2, { ...dispute, locks: ['nsfw', 'tags'] });
  await appeal(3, { ...dispute, autoReview: 'upheld' });
  await appeal(4, { kind: 'lock-review', locks: ['nsfw'] });
  await appeal(5, dispute, 'Rejected');
  await appeal(6, dispute, 'Pending', 'other');
});

const judged = () => mocks.verdict.mock.calls.length;
const retried = async () =>
  (
    await db.query<{ id: number }>(
      `SELECT id FROM "Appeal" WHERE context ? 'autoReviewAttempts' ORDER BY id`
    )
  ).rows.map((r) => r.id);

describe('the dispute job selection', () => {
  it('judges only a pending, nsfw-only, tagged dispute not judged before', async () => {
    await processComFaceIntentDisputes();

    expect(judged()).toBe(1);
    expect(await retried()).toEqual([1]);
  });

  it('marks a judged dispute so the next run skips it', async () => {
    mocks.verdict.mockResolvedValue({ status: 'detected', reason: 'r' });
    await processComFaceIntentDisputes();
    vi.clearAllMocks();
    await processComFaceIntentDisputes();
    expect(judged()).toBe(0);
  });
});
