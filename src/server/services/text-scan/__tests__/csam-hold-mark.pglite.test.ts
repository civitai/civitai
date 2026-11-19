import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/** The lead referral, the report choice set after a decision and the "Included in a report" mark, run against Postgres. */

const SCHEMA = `
CREATE TABLE "TextScanHold" (
  "id" SERIAL PRIMARY KEY, "entityType" TEXT NOT NULL, "entityId" INTEGER NOT NULL,
  "label" TEXT NOT NULL, "status" TEXT NOT NULL, "text" TEXT NOT NULL DEFAULT 'held words',
  "textHash" TEXT NOT NULL DEFAULT 'h', "meta" JSONB, "decidedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now()
);
`;

let pg: PGlite;

const { markCsamHoldReported, referCsamHoldToLead, setCsamHoldReportChoice } = await import(
  '~/server/services/text-scan/csam-hold-decision'
);

beforeAll(async () => {
  pg = await PGlite.create();
  await pg.exec(SCHEMA);
});

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  const raw = pgliteRaw(pg);
  dbMock.dbWrite.$queryRaw.mockImplementation(raw.queryRaw as never);
  dbMock.dbWrite.$executeRaw.mockImplementation(raw.executeRaw as never);
  await pg.exec(`DELETE FROM "TextScanHold"`);
});

describe('referCsamHoldToLead', () => {
  const pendingHold = async (status = 'Pending') =>
    (
      await pg.query<{ id: number }>(
        `INSERT INTO "TextScanHold" ("entityType", "entityId", "label", "status", "meta")
         VALUES ('PostText', 1, 'csam', $1, '{"decision":"pending"}') RETURNING id`,
        [status]
      )
    ).rows[0].id;
  const holdRow = async (id: number) =>
    (
      await pg.query<{ status: string; meta: Record<string, unknown>; decidedAt: Date | null }>(
        `SELECT status, meta, "decidedAt" FROM "TextScanHold" WHERE id = $1`,
        [id]
      )
    ).rows[0];

  it('marks a pending hold for lead review and leaves it pending, with no report choice', async () => {
    const id = await pendingHold();
    await referCsamHoldToLead({ holdId: id, textHash: 'h', note: 'unsure', actor: { id: 7 } });
    const row = await holdRow(id);
    expect(row.status).toBe('Pending');
    expect(row.decidedAt).toBeNull();
    expect(row.meta).toMatchObject({
      decision: 'pending',
      needsLeadReview: { by: 7, note: 'unsure' },
    });
    expect(row.meta).not.toHaveProperty('reportChoice');
  });

  it('refuses a decided hold and one whose text changed', async () => {
    const decided = await pendingHold('Confirmed');
    const pending = await pendingHold();
    await expect(
      referCsamHoldToLead({ holdId: decided, textHash: 'h', actor: { id: 7 } })
    ).rejects.toThrow(/already decided, changed or missing/);
    await expect(
      referCsamHoldToLead({ holdId: pending, textHash: 'other', actor: { id: 7 } })
    ).rejects.toThrow(/already decided, changed or missing/);
    expect((await holdRow(pending)).meta).not.toHaveProperty('needsLeadReview');
  });
});

describe('markCsamHoldReported', () => {
  const hold = async (status: string, label = 'csam', reportChoice = 'imagery') =>
    (
      await pg.query<{ id: number }>(
        `INSERT INTO "TextScanHold" ("entityType", "entityId", "label", "status", "meta")
         VALUES ('ChatMessage', 1, $2, $1, jsonb_build_object('decision', 'remove', 'reportChoice', $3::text))
         RETURNING id`,
        [status, label, reportChoice]
      )
    ).rows[0].id;
  const meta = async (id: number) =>
    (
      await pg.query<{ meta: Record<string, unknown> }>(
        `SELECT meta FROM "TextScanHold" WHERE id = $1`,
        [id]
      )
    ).rows[0].meta;

  it('records who marked a confirmed hold included in a report, and keeps the decision', async () => {
    const id = await hold('Confirmed');
    await markCsamHoldReported({ holdId: id, actor: { id: 7 } });
    expect(await meta(id)).toMatchObject({
      decision: 'remove',
      reportChoice: 'imagery',
      reportIncluded: { by: 7 },
    });
  });

  it('refuses a pending hold, a non-csam hold, a "none" choice and a second mark', async () => {
    const pending = await hold('Pending');
    const other = await hold('Confirmed', 'minor');
    const none = await hold('Confirmed', 'csam', 'none');
    const marked = await hold('Confirmed');
    await markCsamHoldReported({ holdId: marked, actor: { id: 7 } });
    for (const id of [pending, other, none, marked])
      await expect(markCsamHoldReported({ holdId: id, actor: { id: 8 } })).rejects.toThrow(
        /not confirmed with a reportable choice, already marked or missing/
      );
    for (const id of [pending, other, none])
      expect(await meta(id)).not.toHaveProperty('reportIncluded');
    expect(await meta(marked)).toMatchObject({ reportIncluded: { by: 7 } });
  });

  it('takes a mark back, keeping the decision, and refuses an unmarked hold', async () => {
    const id = await hold('Confirmed');
    await markCsamHoldReported({ holdId: id, actor: { id: 7 } });
    await markCsamHoldReported({ holdId: id, included: false, actor: { id: 8 } });
    expect(await meta(id)).toEqual({ decision: 'remove', reportChoice: 'imagery' });
    await expect(
      markCsamHoldReported({ holdId: id, included: false, actor: { id: 8 } })
    ).rejects.toThrow(/not marked or missing/);
  });
});

describe('setCsamHoldReportChoice', () => {
  const hold = async (status: string, meta: Record<string, unknown>, label = 'csam') =>
    (
      await pg.query<{ id: number }>(
        `INSERT INTO "TextScanHold" ("entityType", "entityId", "label", "status", "meta")
         VALUES ('ChatMessage', 1, $2, $1, $3::jsonb) RETURNING id`,
        [status, label, JSON.stringify(meta)]
      )
    ).rows[0].id;
  const meta = async (id: number) =>
    (
      await pg.query<{ meta: Record<string, unknown> }>(
        `SELECT meta FROM "TextScanHold" WHERE id = $1`,
        [id]
      )
    ).rows[0].meta;
  const batched = { decision: 'remove', reviewedDecision: false };

  it('records the choice and who set it, after which the hold can be marked included', async () => {
    const id = await hold('Confirmed', batched);
    await expect(markCsamHoldReported({ holdId: id, actor: { id: 7 } })).rejects.toThrow(
      /not confirmed with a reportable choice/
    );
    await setCsamHoldReportChoice({ holdId: id, reportChoice: 'imagery', actor: { id: 7 } });
    await markCsamHoldReported({ holdId: id, actor: { id: 8 } });
    expect(await meta(id)).toMatchObject({
      ...batched,
      reportChoice: 'imagery',
      reportChoiceSet: { by: 7, at: expect.any(String) },
      reportIncluded: { by: 8 },
    });
  });

  it('refuses a hold that has a choice, a pending hold and a non-csam hold, changing none', async () => {
    const chosen = await hold('Confirmed', { ...batched, reportChoice: 'none' });
    const pending = await hold('Pending', { decision: 'pending' });
    const other = await hold('Confirmed', batched, 'minor');
    for (const id of [chosen, pending, other])
      await expect(
        setCsamHoldReportChoice({ holdId: id, reportChoice: 'imagery', actor: { id: 7 } })
      ).rejects.toThrow(/already has a report choice, or missing/);
    expect(await meta(chosen)).toEqual({ ...batched, reportChoice: 'none' });
    for (const id of [pending, other]) expect(await meta(id)).not.toHaveProperty('reportChoice');
  });
});
