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
    const { pg, file, alerts, deps, heartbeat } = await setup();
    const late = await file('2026-11-20T10:00:00Z');
    const lateMinor = await file('2026-11-20T11:00:00Z', true);
    const notYet = await file('2026-11-21T23:00:00Z'); // due 11-23T23:00Z

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

    const third = await caseTick(deps('2026-11-24T00:00:00Z'));
    expect(third).toEqual({ evaluated: 3, alerted: 1, overdue: 3 });
    expect(alerts[1].text).toContain(notYet.publicRef);
    const stored = await pg.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM case_event WHERE type = 'clock'"
    );
    expect(stored.rows[0].n).toBe(3);
  });

  it('alerts every clock kind in deadline-first order, at the exact moment it is due', async () => {
    const { pg, file, alerts, deps } = await setup();
    const c = await file('2026-11-21T12:00:00Z'); // due 11-23T12:00Z
    await pg.query(
      "UPDATE case_record SET warn_at = '2026-11-23T06:00:00Z', restore_earliest_at = '2026-11-23T11:00:00Z', restore_latest_at = '2026-11-23T11:30:00Z' WHERE public_ref = $1",
      [c.publicRef]
    );

    expect(await caseTick(deps('2026-11-23T11:59:59Z'))).toMatchObject({ alerted: 3, overdue: 0 });
    expect(await caseTick(deps('2026-11-23T12:00:00Z'))).toMatchObject({ alerted: 1, overdue: 1 });
    expect(alerts[0].text.split('\n').map((l) => l.split(' is ')[1].split(':')[0])).toEqual([
      'near its deadline',
      'past its latest restore date',
      'open for restore',
    ]);
    expect(alerts[1].text).toContain('past its deadline');
    expect(alerts.map((a) => a.text).join('\n')).not.toMatch(
      /claimant@example\.com|civitai\.com\/images/
    );
  });

  it('skips test, decided and imported cases', async () => {
    const { pg, file, alerts, deps } = await setup();
    const test = await file('2026-11-20T10:00:00Z');
    const decided = await file('2026-11-20T10:00:00Z');
    const imported = await file('2026-11-20T10:00:00Z');
    const counted = await file('2026-11-20T10:00:00Z');
    const closedByParty = await file('2026-11-20T10:00:00Z');
    await pg.query("UPDATE case_record SET state = 'closed' WHERE public_ref = $1", [
      closedByParty.publicRef,
    ]);
    const undone = await file('2026-11-20T10:00:00Z');
    await pg.query(
      "UPDATE case_record SET source = 'import', state = 'Undone' WHERE public_ref = $1",
      [undone.publicRef]
    );
    await pg.query('UPDATE case_record SET is_test = true WHERE public_ref = $1', [test.publicRef]);
    await pg.query('UPDATE case_record SET decided_at = now() WHERE public_ref = $1', [
      decided.publicRef,
    ]);
    await pg.query("UPDATE case_record SET import_batch_id = 'b1' WHERE public_ref = $1", [
      imported.publicRef,
    ]);

    expect(await caseTick(deps('2026-11-23T12:00:00Z'))).toEqual({
      evaluated: 1,
      alerted: 1,
      overdue: 1,
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].text).toContain(counted.publicRef);
  });

  it('re-alerts on the next run when the alert send failed', async () => {
    const { file, deps, heartbeat } = await setup();
    await file('2026-11-20T10:00:00Z');
    const failing = {
      ...deps('2026-11-23T12:00:00Z'),
      alert: async () => Promise.reject(new Error('SES down')),
    };
    await expect(caseTick(failing)).rejects.toThrow('SES down');
    expect(heartbeat()).toBeNull();

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
    const start = Date.parse('2026-11-23T08:00:00Z');
    await caseTick(deps(new Date(start).toISOString()));
    const justUnder = start + CASE_TICK_MAX_GAP_MS - 60_000;
    await caseTick(deps(new Date(justUnder).toISOString()));
    expect(alerts).toHaveLength(0);
    await caseTick(deps(new Date(justUnder + CASE_TICK_MAX_GAP_MS + 60_000).toISOString()));
    expect(alerts).toHaveLength(1);
    expect(alerts[0].subject).toBe('Takedown clocks: no clock check completed for over 2 hours');
    expect(alerts[0].text).toContain(
      `No clock check completed from ${new Date(justUnder).toISOString()}`
    );
  });

  it('does not call an already-overdue case "near its deadline"', async () => {
    const { pg, file, alerts, deps } = await setup();
    const c = await file('2026-11-20T10:00:00Z');
    await pg.query(
      "UPDATE case_record SET warn_at = '2026-11-22T00:00:00Z' WHERE public_ref = $1",
      [c.publicRef]
    );
    expect(await caseTick(deps('2026-11-23T12:00:00Z'))).toMatchObject({ alerted: 1 });
    expect(alerts[0].text).toContain('past its deadline');
    expect(alerts[0].text).not.toContain('near its deadline');
  });

  it('puts the gap note first when a gap and a late case come together', async () => {
    const { file, alerts, deps } = await setup();
    await caseTick(deps('2026-11-22T00:00:00Z'));
    const late = await file('2026-11-20T10:00:00Z'); // due 11-22T10:00Z
    await caseTick(deps('2026-11-22T12:00:00Z'));
    const lines = alerts[0].text.split('\n');
    expect(lines[0]).toContain('No clock check completed from 2026-11-22T00:00:00.000Z');
    expect(lines[1]).toContain(late.publicRef);
  });
});
