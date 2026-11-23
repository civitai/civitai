import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { processDefinitionSchema } from '@civitai/moderation/process-definition';
import type { CasesDb } from '../cases.db';
import { casesPglite } from './cases-pglite.harness';

vi.mock('../../redis', () => ({ getSysRedis: () => ({}) }));
const { fileIntakeCase, IntakeRefusedError, addBusinessDays } = await import('../intake');

const def = (
  key = 'dmca-notice',
  clocks: unknown[] = [{ id: 'target', label: 'T', startsOn: 'receipt', hours: 48 }]
) =>
  processDefinitionSchema.parse({
    key,
    title: 'DMCA',
    mailbox: 'dmca@civitai.com',
    fields: [
      { id: 'work', label: 'The work', kind: 'textarea', required: true },
      { id: 'urls', label: 'URLs', kind: 'urlList', required: true },
      { id: 'name', label: 'Name', kind: 'text', required: true },
      { id: 'email', label: 'Email', kind: 'email', required: true },
      { id: 'good-faith', label: 'Good faith', kind: 'checkbox', required: true },
      { id: 'signature', label: 'Signature', kind: 'signature', required: true },
    ],
    states: [{ id: 'received', label: 'Received' }],
    initialState: 'received',
    clocks,
  });
const values = {
  work: 'My drawing',
  urls: ['https://civitai.com/images/7', 'https://example.com/x'],
  name: 'A Person',
  email: 'a@example.com',
  'good-faith': true,
  signature: 'A Person',
};

let pg: PGlite;
let db: CasesDb;
let versionId: number;
beforeEach(async () => {
  ({ pg, db } = await casesPglite());
  const d = await pg.query<{ id: number }>(
    "INSERT INTO process_definition (key) VALUES ('dmca-notice') RETURNING id"
  );
  const v = await pg.query<{ id: number }>(
    "INSERT INTO process_definition_version (definition_id, definition, created_by_id) VALUES ($1, '{}', 1) RETURNING id",
    [d.rows[0].id]
  );
  versionId = Number(v.rows[0].id);
});

describe('fileIntakeCase', () => {
  it('files the record, a target per URL, the party and a received event', async () => {
    const receivedAt = new Date('2026-11-20T10:00:00Z');
    const out = await fileIntakeCase({ definition: def(), versionId, values, receivedAt }, { db });
    expect(out.publicRef).toMatch(/^TD-26-/);
    const rec = (await pg.query<Record<string, unknown>>('SELECT * FROM case_record')).rows[0];
    expect(rec).toMatchObject({ process_key: 'dmca-notice', state: 'received', source: 'form' });
    expect(new Date(rec.due_at as string).toISOString()).toBe('2026-11-22T10:00:00.000Z');
    expect(rec.submitter).toEqual({ name: 'A Person', email: 'a@example.com' });
    expect((rec.statements as { id: string }[]).map((s) => s.id)).toEqual([
      'good-faith',
      'signature',
    ]);
    expect(rec.details).toEqual({ work: 'My drawing', urls: values.urls });
    const targets = (await pg.query('SELECT entity_type, entity_id FROM case_target ORDER BY id'))
      .rows;
    expect(targets).toEqual([
      { entity_type: 'Image', entity_id: 7 },
      { entity_type: null, entity_id: null },
    ]);
    const party = (
      await pg.query<{ role: string; address_hash: string }>(
        'SELECT role, address_hash FROM case_party'
      )
    ).rows[0];
    expect(party.role).toBe('claimant');
    expect(party.address_hash).not.toContain('example.com');
    expect((await pg.query('SELECT type FROM case_event')).rows).toEqual([{ type: 'received' }]);
  });

  it('files a counter-notice as the uploader', async () => {
    await fileIntakeCase({ definition: def('dmca-counter-notice'), versionId, values }, { db });
    expect((await pg.query('SELECT role FROM case_party')).rows).toEqual([{ role: 'uploader' }]);
  });

  it('writes nothing for a refused request', async () => {
    await expect(
      fileIntakeCase(
        { definition: def(), versionId, values: { ...values, 'good-faith': false } },
        { db }
      )
    ).rejects.toBeInstanceOf(IntakeRefusedError);
    expect((await pg.query('SELECT count(*)::int AS n FROM case_record')).rows[0]).toEqual({
      n: 0,
    });
  });
});

describe('addBusinessDays', () => {
  it('skips the weekend', () => {
    // Friday + 1 business day is Monday.
    expect(addBusinessDays(new Date('2026-11-20T12:00:00Z'), 1).toISOString()).toBe(
      '2026-11-23T12:00:00.000Z'
    );
  });
});
