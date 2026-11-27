import { describe, expect, it, vi } from 'vitest';
import { processDefinitionSchema } from '@civitai/moderation/process-definition';
import { casesPglite } from './cases-pglite.harness';

vi.mock('../../redis', () => ({ getSysRedis: () => ({}) }));
const { caseTick, CASE_TICK_MAX_GAP_MS } = await import('../case-tick');
const { fileIntakeCase } = await import('../intake');

const definition = processDefinitionSchema.parse({
  key: 'intimate-image-removal',
  title: 'Removal: intimate images of you',
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
  clocks: [{ id: 'removal', label: 'Removal', hours: 48, startsOn: 'receipt' }],
  publicActions: [],
});

async function setup() {
  const { pg, db } = await casesPglite();
  await pg.query("INSERT INTO process_definition (key) VALUES ('intimate-image-removal')");
  const v = await pg.query<{ id: number }>(
    'INSERT INTO process_definition_version (definition_id, definition, created_by_id) SELECT id, $1, 1 FROM process_definition RETURNING id',
    [JSON.stringify(definition)]
  );
  const versionId = Number(v.rows[0].id);
  const file = (receivedAt: string, minor = false) =>
    fileIntakeCase(
      {
        definition,
        versionId,
        values: { urls: ['https://civitai.com/images/1'], email: 'claimant@example.com', minor },
        receivedAt: new Date(receivedAt),
      },
      { db }
    );
  const alerts: { subject: string; text: string }[] = [];
  let beat: Awaited<ReturnType<Parameters<typeof caseTick>[0]['heartbeat']['read']>> = null;
  const deps = (now: string) => ({
    db,
    now: () => new Date(now),
    alert: async (subject: string, text: string) => void alerts.push({ subject, text }),
    heartbeat: {
      read: async () => beat,
      write: async (b: NonNullable<typeof beat>) => void (beat = b),
    },
  });
  return { pg, file, alerts, deps, heartbeat: () => beat };
}

describe('caseTick', () => {
  it('alerts an overdue case once, minors first, with no contact details', async () => {
    const { file, alerts, deps, heartbeat } = await setup();
    const late = await file('2026-11-20T10:00:00Z');
    const lateMinor = await file('2026-11-20T11:00:00Z', true);
    await file('2026-11-21T23:00:00Z'); // due 11-23T23:00Z, not yet

    const first = await caseTick(deps('2026-11-23T12:00:00Z'));
    expect(first).toEqual({ evaluated: 3, alerted: 2, overdue: 2 });
    expect(alerts).toHaveLength(1);
    const lines = alerts[0].text.split('\n');
    expect(lines[0]).toContain(lateMinor.publicRef);
    expect(lines[0]).toContain('MINOR');
    expect(lines[1]).toContain(late.publicRef);
    expect(alerts[0].text).not.toContain('claimant@example.com');
    expect(heartbeat()).toMatchObject({ at: '2026-11-23T12:00:00.000Z', evaluated: 3 });

    const second = await caseTick(deps('2026-11-23T12:15:00Z'));
    expect(second).toEqual({ evaluated: 3, alerted: 0, overdue: 2 });
    expect(alerts).toHaveLength(1);
  });

  it('skips test, decided and imported cases', async () => {
    const { pg, file, alerts, deps } = await setup();
    const test = await file('2026-11-20T10:00:00Z');
    const decided = await file('2026-11-20T10:00:00Z');
    const imported = await file('2026-11-20T10:00:00Z');
    await pg.query('UPDATE case_record SET is_test = true WHERE public_ref = $1', [test.publicRef]);
    await pg.query('UPDATE case_record SET decided_at = now() WHERE public_ref = $1', [
      decided.publicRef,
    ]);
    await pg.query("UPDATE case_record SET import_batch_id = 'b1' WHERE public_ref = $1", [
      imported.publicRef,
    ]);

    expect(await caseTick(deps('2026-11-23T12:00:00Z'))).toEqual({
      evaluated: 0,
      alerted: 0,
      overdue: 0,
    });
    expect(alerts).toHaveLength(0);
  });

  it('re-alerts on the next run when the alert send failed', async () => {
    const { file, deps } = await setup();
    await file('2026-11-20T10:00:00Z');
    const failing = {
      ...deps('2026-11-23T12:00:00Z'),
      alert: async () => Promise.reject(new Error('SES down')),
    };
    await expect(caseTick(failing)).rejects.toThrow('SES down');

    const sent: string[] = [];
    const ok = {
      ...deps('2026-11-23T12:15:00Z'),
      alert: async (_s: string, t: string) => void sent.push(t),
    };
    expect(await caseTick(ok)).toMatchObject({ alerted: 1 });
    expect(sent).toHaveLength(1);
  });

  it('reports a gap in the schedule even when no case is late', async () => {
    const { alerts, deps } = await setup();
    await caseTick(deps('2026-11-23T08:00:00Z'));
    expect(alerts).toHaveLength(0);
    const later = new Date(Date.parse('2026-11-23T08:00:00Z') + CASE_TICK_MAX_GAP_MS + 60_000);
    await caseTick(deps(later.toISOString()));
    expect(alerts).toHaveLength(1);
    expect(alerts[0].text).toContain('did not run from 2026-11-23T08:00:00.000Z');
  });
});
