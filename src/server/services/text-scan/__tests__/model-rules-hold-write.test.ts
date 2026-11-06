import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

const { syncModelRulesHold, ModelRulesHoldBusyError } = await import(
  '~/server/services/text-scan/actions/model-rules-hold'
);

type HoldRow = Record<string, unknown> & { id: number };

const db = { pg: null as unknown as PGlite };
const MIGRATIONS = ['20261016150000_text_scan_hold', '20261112120000_text_scan_hold_one_pending'];
const migrationSql = (name: string) =>
  readFileSync(
    path.resolve(
      __dirname,
      `../../../../../packages/civitai-db-schema/prisma/migrations/${name}/migration.sql`
    ),
    'utf8'
  );
const asRawSql = (strings: TemplateStringsArray, values: unknown[]) =>
  strings.reduce((acc, part, i) => acc + part + (i < values.length ? `$${i + 1}` : ''), '');
const rows = async () =>
  (await db.pg.query<HoldRow>('SELECT * FROM "TextScanHold" ORDER BY "id"')).rows;

// Only the columns the one-pending migration reads to pick a survivor.
const ENTITY_MODERATION_STUB = `CREATE TABLE "EntityModeration" (
  "id" SERIAL PRIMARY KEY, "entityType" TEXT NOT NULL, "entityId" INT NOT NULL,
  "result" JSONB, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT now())`;

beforeAll(async () => {
  db.pg = await PGlite.create();
  await db.pg.exec(ENTITY_MODERATION_STUB);
  for (const name of MIGRATIONS) await db.pg.exec(migrationSql(name));
});
afterAll(async () => {
  await db.pg.close();
});
beforeEach(async () => {
  vi.clearAllMocks();
  await db.pg.exec('TRUNCATE "TextScanHold" RESTART IDENTITY');
  dbMock.dbWrite.$queryRaw.mockImplementation(
    async (strings: TemplateStringsArray, ...values) =>
      (await db.pg.query(asRawSql(strings, values), values)).rows
  );
  dbMock.dbWrite.$executeRaw.mockImplementation(
    async (strings: TemplateStringsArray, ...values) =>
      (await db.pg.query(asRawSql(strings, values), values)).affectedRows ?? 0
  );
});

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const RULE = { id: 3, subject: 'Example Franchise', description: 'd', aliases: ['Hero One'] };
const detection = (over: Record<string, unknown> = {}) => ({
  userId: 5,
  textHash: 'hash-1',
  text: 'Name\nHero One LoRA',
  reason: 'Example Franchise',
  fields: [{ heading: 'Name', text: 'Hero One LoRA' }],
  matches: [{ ruleId: 3, term: 'Hero One', field: 'Name', fieldIndex: 0, start: 0, end: 8 }],
  rules: [RULE],
  mode: 'shadow' as const,
  applied: false,
  ...over,
});

describe('syncModelRulesHold', () => {
  it('writes a pending hold carrying the text, hash, matches and rule snapshot', async () => {
    await expect(syncModelRulesHold(7, detection())).resolves.toBe('created');

    const [hold] = await rows();
    expect(hold).toMatchObject({
      entityType: 'Model',
      entityId: 7,
      label: 'modelRules',
      status: 'Pending',
      userId: 5,
      text: 'Name\nHero One LoRA',
      textHash: 'hash-1',
      reason: 'Example Franchise',
      hiddenAt: null,
    });
    expect(hold.meta).toEqual({
      mode: 'shadow',
      fields: [{ heading: 'Name', text: 'Hero One LoRA' }],
      matches: [{ ruleId: 3, term: 'Hero One', field: 'Name', fieldIndex: 0, start: 0, end: 8 }],
      rules: [RULE],
    });
  });

  it('keeps the versions a publish was making public, so a dismissal can publish them', async () => {
    await syncModelRulesHold(7, detection({ mode: 'active', applied: true, versionIds: [11, 12] }));

    const [hold] = await rows();
    expect(hold.meta).toMatchObject({ versionIds: [11, 12] });
  });

  it('marks an applied detection hidden', async () => {
    await syncModelRulesHold(7, detection({ mode: 'active', applied: true }));

    const [hold] = await rows();
    expect(hold.hiddenAt).toBeInstanceOf(Date);
    expect(hold.meta).toMatchObject({ mode: 'active', applied: true });
  });

  it('does not queue a second hold for the same text', async () => {
    await syncModelRulesHold(7, detection());
    await expect(syncModelRulesHold(7, detection())).resolves.toBe('unchanged');
    expect(await rows()).toHaveLength(1);
  });

  it('records a takedown that lands after the same text was held without acting', async () => {
    await syncModelRulesHold(7, detection());
    await expect(syncModelRulesHold(7, detection({ mode: 'active', applied: true }))).resolves.toBe(
      'updated'
    );

    const held = await rows();
    expect(held).toHaveLength(1);
    expect(held[0].hiddenAt).toBeInstanceOf(Date);
    expect(held[0].meta).toMatchObject({ mode: 'active', applied: true });
  });

  it('supersedes the pending hold when the text changes, linking the new one to it', async () => {
    await syncModelRulesHold(7, detection());
    await expect(
      syncModelRulesHold(7, detection({ textHash: 'hash-2', text: 'Name\nHero One LoRA v2' }))
    ).resolves.toBe('created');

    const [old, next] = await rows();
    expect(old).toMatchObject({
      status: 'Dismissed',
      decidedById: null,
      decisionNote: 'superseded by a newer scan of the same content',
    });
    expect(old.decidedAt).toBeInstanceOf(Date);
    expect(old.meta).toMatchObject({ decision: 'superseded', superseded: true });
    expect(next).toMatchObject({ status: 'Pending', textHash: 'hash-2' });
    expect(next.meta).toMatchObject({ kind: 'redetected', priorHoldId: old.id });
  });

  it('closes the pending hold as superseded, with no ruling, when the new text matches nothing', async () => {
    await syncModelRulesHold(7, detection());
    await expect(syncModelRulesHold(7, null)).resolves.toBe('closed');

    const held = await rows();
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ status: 'Dismissed', decidedById: null });
    expect(held[0].meta).toMatchObject({ decision: 'superseded' });
  });

  it('does nothing for clean text when no hold is pending', async () => {
    await expect(syncModelRulesHold(7, null)).resolves.toBe('none');
    expect(await rows()).toEqual([]);
  });

  it('keeps holds of other models apart', async () => {
    await syncModelRulesHold(7, detection());
    await syncModelRulesHold(8, detection());
    await syncModelRulesHold(8, null);

    const held = await rows();
    expect(held.map((h) => [h.entityId, h.status])).toEqual([
      [7, 'Pending'],
      [8, 'Dismissed'],
    ]);
  });

  it('does not hold the text a moderator already ruled on again', async () => {
    await syncModelRulesHold(7, detection());
    await db.pg.query(`UPDATE "TextScanHold" SET "status" = 'Dismissed' WHERE "id" = 1`);

    await expect(syncModelRulesHold(7, detection())).resolves.toBe('skipped');
    expect(await rows()).toHaveLength(1);
  });

  it('holds ruled text again when the detection took the model down', async () => {
    await syncModelRulesHold(7, detection());
    await db.pg.query(`UPDATE "TextScanHold" SET "status" = 'Dismissed' WHERE "id" = 1`);

    await expect(syncModelRulesHold(7, detection({ mode: 'active', applied: true }))).resolves.toBe(
      'created'
    );

    const [, next] = await rows();
    expect(next).toMatchObject({ status: 'Pending', textHash: 'hash-1' });
    expect(next.hiddenAt).toBeInstanceOf(Date);
    expect(next.meta).toMatchObject({ mode: 'active', kind: 'redetected', priorHoldId: 1 });
  });

  it('holds edited text again after a ruling, linked to that ruling', async () => {
    await syncModelRulesHold(7, detection());
    await db.pg.query(`UPDATE "TextScanHold" SET "status" = 'Confirmed' WHERE "id" = 1`);

    await expect(syncModelRulesHold(7, detection({ textHash: 'hash-2' }))).resolves.toBe('created');

    const [, next] = await rows();
    expect(next.meta).toMatchObject({ kind: 'redetected', priorHoldId: 1 });
  });

  it('refuses to replace a hold a moderator is mid-decision on', async () => {
    await syncModelRulesHold(7, detection());
    await db.pg.query(
      `UPDATE "TextScanHold" SET "meta" = "meta" || jsonb_build_object('decisionClaim', jsonb_build_object('at', now()))`
    );

    await expect(syncModelRulesHold(7, detection({ textHash: 'hash-2' }))).rejects.toBeInstanceOf(
      ModelRulesHoldBusyError
    );
    expect(await rows()).toHaveLength(1);
  });

  describe('a training detection', () => {
    const training = (over: Record<string, unknown> = {}) =>
      detection({ source: 'training', ...over });

    it('records its source on the hold', async () => {
      await syncModelRulesHold(7, training());
      const [hold] = await rows();
      expect(hold.meta).toMatchObject({ source: 'training' });
    });

    it('records its source on the hold that replaces an older training hold', async () => {
      await syncModelRulesHold(7, training());
      await syncModelRulesHold(7, training({ textHash: 'hash-2' }));
      const [, next] = await rows();
      expect(next.meta).toMatchObject({ source: 'training', kind: 'redetected' });
    });

    it('leaves a pending hold of a publish alone, which has already taken the model down', async () => {
      await syncModelRulesHold(7, detection({ mode: 'active', applied: true }));
      await expect(syncModelRulesHold(7, training({ textHash: 'hash-2' }))).resolves.toBe(
        'skipped'
      );

      const held = await rows();
      expect(held).toHaveLength(1);
      expect(held[0]).toMatchObject({ status: 'Pending', textHash: 'hash-1' });
    });

    it('closes a stale training hold when its text no longer matches', async () => {
      await syncModelRulesHold(7, training());
      await expect(syncModelRulesHold(7, null, { onlySource: 'training' })).resolves.toBe('closed');
      expect((await rows())[0]).toMatchObject({ status: 'Dismissed' });
    });

    it('does not close the pending hold of a publish when a training check finds nothing', async () => {
      await syncModelRulesHold(7, detection({ mode: 'active', applied: true }));
      await expect(syncModelRulesHold(7, null, { onlySource: 'training' })).resolves.toBe('none');
      expect((await rows())[0]).toMatchObject({ status: 'Pending' });
    });
  });

  it('takes the per-model advisory lock before reading the pending hold', async () => {
    await syncModelRulesHold(7, detection());

    const [strings, ...values] = dbMock.dbWrite.$executeRaw.mock.calls[0];
    expect(strings.join('?')).toContain('pg_advisory_xact_lock');
    expect(values).toContain(7);
  });
});
