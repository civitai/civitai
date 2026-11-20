import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Kysely } from 'kysely';
import type { PGlite } from '@electric-sql/pglite';
import type { DB } from '@civitai/db-schema/kysely';
import { mintAccessToken } from '@civitai/db-queries/access-token';
import { processDefinitionSchema } from '@civitai/moderation/process-definition';
import type { CasesDb } from '../cases.db';
import { casesPglite } from './cases-pglite.harness';
import { freshPglite } from '../../../../test/pglite';
import { pgliteDialect } from '../../__tests__/abuse-detection-pglite.harness';

vi.mock('../../redis', () => ({ getSysRedis: () => ({}) }));
const { casePartyView, casePartyAction } = await import('../case-party');
const { fileIntakeCase } = await import('../intake');

const definition = processDefinitionSchema.parse({
  key: 'dmca-notice',
  title: 'DMCA copyright notice',
  mailbox: 'dmca@civitai.com',
  fields: [
    { id: 'urls', label: 'URLs', kind: 'urlList', required: true },
    { id: 'email', label: 'Email', kind: 'email', required: true },
  ],
  states: [
    { id: 'received', label: 'Received' },
    { id: 'suit-filed', label: 'Suit filed', needsReview: true },
    { id: 'closed', label: 'Closed', terminal: true },
  ],
  initialState: 'received',
  publicActions: [
    { id: 'add-info', role: 'claimant', label: 'Add', fields: ['urls'], records: 'info-added' },
    {
      id: 'report-suit',
      role: 'claimant',
      label: 'Suit',
      fields: [],
      records: 'suit-reported',
      moveTo: 'suit-filed',
      from: ['received'],
    },
  ],
});

let pg: PGlite;
let db: CasesDb;
let mainDb: Kysely<DB>;
let versionId: number;
const now = new Date('2026-11-20T16:00:00Z');

beforeEach(async () => {
  ({ pg, db } = await casesPglite());
  const d = await pg.query<{ id: number }>(
    "INSERT INTO process_definition (key) VALUES ('dmca-notice') RETURNING id"
  );
  const v = await pg.query<{ id: number }>(
    'INSERT INTO process_definition_version (definition_id, definition, created_by_id) VALUES ($1, $2, 1) RETURNING id',
    [d.rows[0].id, JSON.stringify(definition)]
  );
  versionId = Number(v.rows[0].id);
  const main = await freshPglite();
  await main.exec(`CREATE TABLE "AccessToken" (
    id serial PRIMARY KEY, "resourceType" text NOT NULL, "resourceId" integer NOT NULL,
    "tokenHash" text NOT NULL UNIQUE, "createdById" integer NOT NULL,
    "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" timestamp(3) NOT NULL, "revokedAt" timestamp(3));`);
  mainDb = new Kysely<DB>({ dialect: pgliteDialect(main) });
});

const deps = () => ({ db, mainDb, rateLimit: () => undefined, now: () => now });
const fileCase = async (urls = ['https://civitai.com/images/7']) => {
  const c = await fileIntakeCase(
    { definition, versionId, values: { urls, email: 'claimant@example.com' }, receivedAt: now },
    { db }
  );
  const token = await mintAccessToken(mainDb, {
    resourceType: 'CaseParty',
    resourceId: c.partyId,
    createdById: -1,
    expiresAt: new Date(now.getTime() + 86_400_000),
  });
  return { ...c, token };
};
const access = (c: { publicRef: string; token: string }) => ({
  publicRef: c.publicRef,
  token: c.token,
  ip: '203.0.113.9',
});

describe('casePartyView', () => {
  it("shows the party its case and its role's actions, and no one's contact details", async () => {
    const c = await fileCase();
    const view = await casePartyView(access(c), deps());
    expect(view).toMatchObject({
      publicRef: c.publicRef,
      state: { id: 'received', terminal: false },
      items: [{ url: 'https://civitai.com/images/7' }],
    });
    expect(view.actions.map((a) => a.id)).toEqual(['add-info', 'report-suit']);
    expect(JSON.stringify(view)).not.toContain('claimant@example.com');
  });

  it("refuses one case's token on another case's reference", async () => {
    const a = await fileCase();
    const b = await fileCase();
    await expect(
      casePartyView({ ...access(a), publicRef: b.publicRef }, deps())
    ).rejects.toMatchObject({
      status: 404,
    });
  });

  it('refuses a revoked token', async () => {
    const c = await fileCase();
    await mainDb.updateTable('AccessToken').set({ revokedAt: new Date() }).execute();
    await expect(casePartyView(access(c), deps())).rejects.toMatchObject({ status: 404 });
  });

  it('shows a party who did not file the case only the items uploaded by its account', async () => {
    const c = await fileCase(['https://civitai.com/images/7', 'https://civitai.com/images/8']);
    await pg.query("UPDATE case_target SET uploader_user_id = 55 WHERE url LIKE '%/8'");
    const up = await pg.query<{ id: number }>(
      "INSERT INTO case_party (case_id, role, user_id) VALUES ($1, 'uploader', 55) RETURNING id",
      [c.caseId]
    );
    const token = await mintAccessToken(mainDb, {
      resourceType: 'CaseParty',
      resourceId: Number(up.rows[0].id),
      createdById: -1,
      expiresAt: new Date(now.getTime() + 86_400_000),
    });
    const view = await casePartyView({ ...access(c), token }, deps());
    expect(view.items.map((i) => i.url)).toEqual(['https://civitai.com/images/8']);
    expect(JSON.stringify(view)).not.toContain('claimant@example.com');
    expect(view.actions).toEqual([]);
  });
});

describe('casePartyAction', () => {
  const act = (
    c: { publicRef: string; token: string },
    actionId: string,
    values = {},
    submissionId: string = crypto.randomUUID()
  ) => casePartyAction({ ...access(c), actionId, values, submissionId }, deps());

  it('records the action at the time of the call and moves the case', async () => {
    const c = await fileCase();
    expect(await act(c, 'report-suit')).toEqual({ recorded: 'suit-reported', state: 'suit-filed' });
    const ev = await pg.query<{ type: string; at: string }>(
      "SELECT type, at FROM case_event WHERE type = 'suit-reported'"
    );
    expect(new Date(ev.rows[0].at).toISOString()).toBe(now.toISOString());
    expect((await pg.query('SELECT state FROM case_record')).rows).toEqual([
      { state: 'suit-filed' },
    ]);
  });

  it('adds only items the case does not already have', async () => {
    const c = await fileCase();
    await act(c, 'add-info', {
      urls: ['https://civitai.com/images/7', 'https://civitai.com/images/9'],
    });
    const urls = (await pg.query<{ url: string }>('SELECT url FROM case_target ORDER BY id')).rows;
    expect(urls.map((u) => u.url)).toEqual([
      'https://civitai.com/images/7',
      'https://civitai.com/images/9',
    ]);
  });

  it("refuses a field outside the action, another role's action, and a closed case", async () => {
    const c = await fileCase();
    await expect(
      act(c, 'add-info', { urls: ['https://civitai.com/images/9'], email: 'x@example.com' })
    ).rejects.toMatchObject({ status: 400 });
    await expect(act(c, 'counter')).rejects.toMatchObject({ status: 403 });
    await pg.query("UPDATE case_record SET state = 'closed'");
    await expect(act(c, 'report-suit')).rejects.toMatchObject({ status: 409 });
    expect(
      (await pg.query("SELECT count(*)::int AS n FROM case_event WHERE type <> 'received'")).rows
    ).toEqual([{ n: 0 }]);
  });

  it('records a retried filing once', async () => {
    const c = await fileCase();
    const id = crypto.randomUUID();
    await act(c, 'add-info', { urls: ['https://civitai.com/images/9'] }, id);
    await act(c, 'add-info', { urls: ['https://civitai.com/images/9'] }, id);
    expect(
      (await pg.query("SELECT count(*)::int AS n FROM case_event WHERE type = 'info-added'")).rows
    ).toEqual([{ n: 1 }]);
  });

  it('refuses an action outside the states it is open in, and stops offering it', async () => {
    const c = await fileCase();
    await act(c, 'report-suit');
    await expect(act(c, 'report-suit')).rejects.toMatchObject({ status: 409 });
    const view = await casePartyView(access(c), deps());
    expect(view.actions.map((a) => a.id)).toEqual(['add-info']);
  });
});
