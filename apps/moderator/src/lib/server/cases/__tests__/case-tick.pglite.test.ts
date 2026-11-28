import { describe, expect, it, vi } from 'vitest';
import { processDefinitionSchema } from '@civitai/moderation/process-definition';
import { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { freshPglite } from '../../../../test/pglite';
import { pgliteDialect } from '../../__tests__/abuse-detection-pglite.harness';
import { casesPglite } from './cases-pglite.harness';

vi.mock('../../redis', () => ({ getSysRedis: () => ({}) }));
const { caseTick, CASE_TICK_MAX_GAP_MS, keyValueHeartbeat } = await import('../case-tick');
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
    const notYet = await file('2026-11-21T23:00:00Z');

    const first = await caseTick(deps('2026-11-23T12:00:00Z'));
    expect(first).toEqual({ evaluated: 3, alerted: 2, overdue: 2, unsent: 0 });
    expect(alerts).toHaveLength(1);
    const lines = alerts[0].text.split('\n');
    expect(lines[0]).toContain(lateMinor.publicRef);
    expect(lines[0]).toContain('MINOR');
    expect(lines[1]).toContain(late.publicRef);
    expect(alerts[0].text).not.toContain('claimant@example.com');
    expect(heartbeat()).toMatchObject({ at: '2026-11-23T12:00:00.000Z', evaluated: 3 });

    const second = await caseTick(deps('2026-11-23T12:15:00Z'));
    expect(second).toEqual({ evaluated: 3, alerted: 0, overdue: 2, unsent: 0 });
    expect(alerts).toHaveLength(1);

    const third = await caseTick(deps('2026-11-24T00:00:00Z'));
    expect(third).toEqual({ evaluated: 3, alerted: 1, overdue: 3, unsent: 0 });
    expect(alerts[1].text).toContain(notYet.publicRef);
    const stored = await pg.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM case_event WHERE type = 'clock'"
    );
    expect(stored.rows[0].n).toBe(3);
  });

  it('alerts every clock kind in deadline-first order, at the exact moment it is due', async () => {
    const { pg, file, alerts, deps } = await setup();
    const c = await file('2026-11-21T12:00:00Z');
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
      unsent: 0,
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].text).toContain(counted.publicRef);
  });

  it('keeps the threshold and the heartbeat when the alert fails, and records it unsent once', async () => {
    const { pg, file, deps, heartbeat } = await setup();
    await file('2026-11-20T10:00:00Z');
    const failing = (now: string) => ({
      ...deps(now),
      alert: async () => Promise.reject(Object.assign(new Error('x'), { name: 'NoAlertAddress' })),
    });

    expect(await caseTick(failing('2026-11-23T12:00:00Z'))).toEqual({
      evaluated: 1,
      alerted: 0,
      overdue: 1,
      unsent: 1,
    });
    expect(heartbeat()).toMatchObject({ at: '2026-11-23T12:00:00.000Z', unsent: 1 });
    await caseTick(failing('2026-11-23T12:15:00Z'));
    const events = await pg.query<{ type: string; n: number }>(
      'SELECT type, count(*)::int AS n FROM case_event WHERE type LIKE $1 GROUP BY type ORDER BY type',
      ['clock%']
    );
    expect(events.rows).toEqual([
      { type: 'clock', n: 1 },
      { type: 'clock-alert-unsent', n: 1 },
    ]);
  });

  it('sends a threshold left unsent on the next run that can send, then never again', async () => {
    const { pg, file, alerts, deps } = await setup();
    const late = await file('2026-11-20T10:00:00Z');
    await caseTick({
      ...deps('2026-11-23T12:00:00Z'),
      alert: async () => Promise.reject(new Error('SES down')),
    });

    expect(await caseTick(deps('2026-11-23T12:15:00Z'))).toMatchObject({ alerted: 1, unsent: 0 });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].text).toContain(late.publicRef);
    expect(await caseTick(deps('2026-11-23T12:30:00Z'))).toMatchObject({ alerted: 0 });
    expect(alerts).toHaveLength(1);

    // A later outage records its own unsent event: the once-only rule holds per owed threshold.
    await pg.query(
      "UPDATE case_record SET warn_at = '2026-11-23T12:40:00Z' WHERE public_ref = $1",
      [late.publicRef]
    );
    await pg.query("UPDATE case_record SET due_at = '2026-11-24T00:00:00Z' WHERE public_ref = $1", [
      late.publicRef,
    ]);
    await caseTick({
      ...deps('2026-11-23T12:45:00Z'),
      alert: async () => Promise.reject(new Error('SES down')),
    });
    const unsent = await pg.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM case_event WHERE type = 'clock-alert-unsent'"
    );
    expect(unsent.rows[0].n).toBe(2);
  });

  it('still alerts when the heartbeat cannot be read', async () => {
    const { file, alerts, deps } = await setup();
    const late = await file('2026-11-20T10:00:00Z');
    const d = deps('2026-11-23T12:00:00Z');
    const broken = {
      ...d,
      heartbeat: { ...d.heartbeat, read: () => Promise.reject(new Error('main DB down')) },
    };
    expect(await caseTick(broken)).toMatchObject({ alerted: 1 });
    expect(alerts[0].text).toContain(late.publicRef);
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
    const late = await file('2026-11-20T10:00:00Z');
    await caseTick(deps('2026-11-22T12:00:00Z'));
    const lines = alerts[0].text.split('\n');
    expect(lines[0]).toContain('No clock check completed from 2026-11-22T00:00:00.000Z');
    expect(lines[1]).toContain(late.publicRef);
  });
});

describe('keyValueHeartbeat', () => {
  it('writes the heartbeat to KeyValue and reads it back, replacing the last one', async () => {
    const main = await freshPglite();
    await main.exec('CREATE TABLE "KeyValue" (key text PRIMARY KEY, value jsonb NOT NULL);');
    await main.exec(`INSERT INTO "KeyValue" VALUES ('other-key', '1')`);
    const hb = keyValueHeartbeat(new Kysely<DB>({ dialect: pgliteDialect(main) }));

    expect(await hb.read()).toBeNull();
    await hb.write({
      at: '2026-11-23T08:00:00.000Z',
      evaluated: 2,
      alerted: 1,
      overdue: 1,
      unsent: 0,
    });
    await hb.write({
      at: '2026-11-23T08:15:00.000Z',
      evaluated: 3,
      alerted: 0,
      overdue: 1,
      unsent: 2,
    });
    expect(await hb.read()).toEqual({
      at: '2026-11-23T08:15:00.000Z',
      evaluated: 3,
      alerted: 0,
      overdue: 1,
      unsent: 2,
    });
    const rows = await main.query<{ key: string }>('SELECT key FROM "KeyValue" ORDER BY key');
    expect(rows.rows.map((r) => r.key)).toEqual(['case-tick-heartbeat', 'other-key']);
  });
});
