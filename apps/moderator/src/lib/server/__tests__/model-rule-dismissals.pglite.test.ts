import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshPglite } from '../../../test/pglite';
import { pgliteDialect } from './abuse-detection-pglite.harness';

const { dbHandle } = vi.hoisted(() => ({ dbHandle: { current: null as unknown } }));
vi.mock('../db', () => ({
  get dbRead() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
  get dbWrite() {
    return dbHandle.current;
  },
}));
vi.mock('../cache', () => ({ bustKeyBestEffort: vi.fn(async () => true) }));
vi.mock('../mod-activity', () => ({ recordModActivity: vi.fn(), recordModActivityBatch: vi.fn() }));
vi.mock('../users.service', () => ({ usersByIds: vi.fn(async () => new Map()) }));

const { countNotSubjectDismissalsByRule } = await import('../model-rules.service');

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = [
  '20261016150000_text_scan_hold',
  '20261112120000_text_scan_hold_one_pending',
].map((name) =>
  readFileSync(
    join(
      HERE,
      `../../../../../../packages/civitai-db-schema/prisma/migrations/${name}/migration.sql`
    ),
    'utf-8'
  )
);

let db: PGlite;
let nextId = 1;

const hold = (status: string, meta: unknown, label = 'modelRules') =>
  db.query(
    `INSERT INTO "TextScanHold" ("id","entityType","entityId","label","textHash","status","userId",
       "text","reason","createdAt","updatedAt","meta")
     VALUES ($1,'Model',$1,$2,$3,$4::"TextScanHoldStatus",10,'t','r',now(),now(),$5::jsonb)`,
    [nextId++, label, `h-${nextId}`, status, JSON.stringify(meta)]
  );
const rules = (...ids: number[]) =>
  ids.map((id) => ({ id, subject: `Subject ${id}`, description: '', aliases: [] }));

beforeEach(async () => {
  nextId = 1;
  db = await freshPglite();
  await db.exec(`CREATE TABLE "EntityModeration" ("id" SERIAL PRIMARY KEY, "entityType" TEXT NOT NULL,
    "entityId" INTEGER NOT NULL, "status" TEXT NOT NULL DEFAULT 'Succeeded', "result" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT now())`);
  for (const migration of MIGRATIONS) await db.exec(migration);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

afterEach(async () => {
  await (dbHandle.current as Kysely<unknown> | null)?.destroy();
  dbHandle.current = null;
  await db.close();
});

describe('countNotSubjectDismissalsByRule', () => {
  it('counts dismissed-as-not-this-subject holds per matched rule', async () => {
    await hold('Dismissed', { decision: 'dismiss_not_subject', rules: rules(1, 2) });
    await hold('Dismissed', { decision: 'dismiss_not_subject', rules: rules(2) });
    expect(await countNotSubjectDismissalsByRule()).toEqual({ 1: 1, 2: 2 });
  });

  it('ignores other rulings, other states, other labels and superseded holds', async () => {
    await hold('Dismissed', { decision: 'dismiss_allowed', rules: rules(1) });
    await hold('Dismissed', { decision: 'superseded', rules: rules(1) });
    await hold('Dismissed', { rules: rules(1) });
    await hold('Confirmed', { decision: 'confirm', rules: rules(1) });
    await hold('Pending', { rules: rules(1) });
    await hold('Dismissed', { decision: 'dismiss_not_subject', rules: rules(1) }, 'poi');
    expect(await countNotSubjectDismissalsByRule()).toEqual({});
  });

  it('survives holds whose rules are missing or malformed', async () => {
    await hold('Dismissed', { decision: 'dismiss_not_subject' });
    await hold('Dismissed', { decision: 'dismiss_not_subject', rules: 'x' });
    await hold('Dismissed', { decision: 'dismiss_not_subject', rules: [{ id: 'abc' }, { id: 4 }] });
    expect(await countNotSubjectDismissalsByRule()).toEqual({ 4: 1 });
  });
});
