import { describe, expect, it, vi } from 'vitest';
import { processDefinitionSchema } from '@civitai/moderation/process-definition';
import { casesPglite } from './cases-pglite.harness';

vi.mock('../../redis', () => ({ getSysRedis: () => ({}) }));
const { listFiledCases } = await import('../cases.service');
const { fileIntakeCase } = await import('../intake');

const definition = processDefinitionSchema.parse({
  key: 'likeness-claim',
  title: 'Likeness claim',
  mailbox: 'digital-likeness@civitai.com',
  fields: [
    { id: 'urls', label: 'URLs', kind: 'urlList', required: true },
    { id: 'email', label: 'Email', kind: 'email', required: true },
    { id: 'minor', label: 'Minor', kind: 'checkbox', required: false },
  ],
  states: [
    { id: 'received', label: 'Received' },
    { id: 'closed', label: 'Closed', terminal: true },
  ],
  initialState: 'received',
  clocks: [{ id: 'response', label: 'Response', hours: 72, startsOn: 'receipt' }],
  publicActions: [],
});

describe('listFiledCases', () => {
  it('lists form-filed cases, minor-flagged first, with no contact details', async () => {
    const { pg, db } = await casesPglite();
    await pg.query("INSERT INTO process_definition (key) VALUES ('likeness-claim')");
    const v = await pg.query<{ id: number }>(
      'INSERT INTO process_definition_version (definition_id, definition, created_by_id) SELECT id, $1, 1 FROM process_definition RETURNING id',
      [JSON.stringify(definition)]
    );
    const versionId = Number(v.rows[0].id);
    const file = (minor: boolean, at: string) =>
      fileIntakeCase(
        {
          definition,
          versionId,
          values: { urls: ['https://civitai.com/images/1'], email: 'claimant@example.com', minor },
          receivedAt: new Date(at),
        },
        { db }
      );
    const plain = await file(false, '2026-11-20T10:00:00Z');
    const minor = await file(true, '2026-11-20T12:00:00Z');
    const imported = await file(true, '2026-11-20T09:00:00Z');
    await pg.query("UPDATE case_record SET import_batch_id = 'b1' WHERE public_ref = $1", [
      imported.publicRef,
    ]);

    const rows = await listFiledCases({ db });
    expect(rows.map((r) => r.publicRef)).toEqual([minor.publicRef, plain.publicRef]);
    expect(rows[0]).toMatchObject({ title: 'Likeness claim', state: 'received', minor: true });
    expect(new Date(rows[1].dueAt as unknown as string).toISOString()).toBe(
      '2026-11-23T10:00:00.000Z'
    );
    expect(JSON.stringify(rows)).not.toContain('claimant@example.com');
  });
});
