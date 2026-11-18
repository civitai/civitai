import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CasesDb } from '../cases.db';
import { casesPglite } from './cases-pglite.harness';

const redis = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), del: vi.fn() }));
vi.mock('../../redis', () => ({ getSysRedis: () => redis }));

const { hashAddress, sendBatch, sendNotice, MAX_CONSECUTIVE_FAILURES } = await import(
  '../send-notice'
);
const { readBrake } = await import('../brake');
const {
  batchCounts,
  exportState,
  exportUnsent,
  importBatch,
  resolveSending,
  retireNotice,
  withdrawNotice,
  importSentJsonl,
  undoImport,
  ImportRefusedError,
} = await import('../backlog-import');
const { batchPreview } = await import('../cases.service');
const { acquireRunLock, releaseRunLock, renewRunLock, runLockKey } = await import('../run-lock');

/** Redis for the run lock: SET NX and the two compare scripts, with expiry done by hand. */
function fakeLockRedis() {
  const store = new Map<string, string>();
  return {
    store,
    set: async (k: string, v: string, o?: { NX?: boolean }) => {
      if (o?.NX && store.has(k)) return null;
      store.set(k, v);
      return 'OK';
    },
    get: async (k: string) => store.get(k) ?? null,
    eval: async (
      script: string,
      { keys, arguments: args }: { keys: string[]; arguments: string[] }
    ) => {
      const guarded = script.includes('== ARGV[1]');
      if (guarded && store.get(keys[0]) !== args[0]) return 0;
      if (script.includes("'del'")) store.delete(keys[0]);
      return 1;
    },
  };
}
type SendDeps = import('../send-notice').SendDeps;

let pg: PGlite;
let db: CasesDb;
const send = vi.fn();
const alert = vi.fn();
const pauseSends = vi.fn();

const deps = (over: Partial<SendDeps> = {}): SendDeps => ({
  db,
  send,
  sleep: async () => undefined,
  readBrake: async () => ({ paused: false }),
  pauseSends,
  lockdownOk: async () => true,
  holdsLock: async () => true,
  alert,
  from: 'Notices <notices@example.test>',
  replyTo: 'inbox@example.test',
  hourlyCeiling: 400,
  ...over,
});

const input = (batchId = 'backlog-test') => ({
  batchId,
  processKey: 'backlog-2026-11',
  expected: { T4: 2, C1: 1 },
  cases: [
    {
      receivedAt: '2026-11-16T00:00:00Z',
      state: 'Actioned',
      submitter: { email: 'claimant@example.test' },
      targets: [
        { key: 1, url: 'https://example.test/m/1', state: 'Removed' as const },
        { key: 2, url: 'https://example.test/m/2', state: 'Removed' as const },
      ],
      notices: [
        {
          target: 1,
          noticeId: 'T4',
          recipientRole: 'uploader' as const,
          to: 'up1@example.test',
          subject: 'S1',
          body: 'B1 <x>',
        },
        {
          target: 2,
          noticeId: 'T4',
          recipientRole: 'uploader' as const,
          to: 'up2@example.test',
          subject: 'S2',
          body: 'B2',
        },
        {
          target: 0,
          noticeId: 'C1',
          recipientRole: 'claimant' as const,
          to: 'claimant@example.test',
          subject: 'S3',
          body: 'B3',
        },
      ],
    },
  ],
});

const notices = () => db.selectFrom('case_notice').selectAll().orderBy('id').execute();

beforeEach(async () => {
  ({ pg, db } = await casesPglite());
  send.mockReset().mockImplementation(async () => ({ messageId: `<${Math.random()}@relay>` }));
  alert.mockReset();
  pauseSends.mockReset().mockResolvedValue(undefined);
  alert.mockResolvedValue(undefined);
  redis.get.mockReset();
});
afterEach(async () => {
  await pg.close();
});

describe('importBatch', () => {
  it('stores each approved message verbatim as a pending notice', async () => {
    await expect(importBatch(input(), { actorId: 1, db })).resolves.toEqual({
      cases: 1,
      notices: 3,
    });
    const rows = await notices();
    expect(rows.map((r) => [r.notice_id, r.status, r.body_snapshot])).toEqual([
      ['T4', 'pending', 'B1 <x>'],
      ['T4', 'pending', 'B2'],
      ['C1', 'pending', 'B3'],
    ]);
    expect(rows[0].address_hash).toBe(hashAddress('up1@example.test'));
  });

  it('refuses a second import of the same batch and leaves the first as it was', async () => {
    await importBatch(input(), { actorId: 1, db });
    await expect(importBatch(input(), { actorId: 1, db })).rejects.toBeInstanceOf(
      ImportRefusedError
    );
    expect(await notices()).toHaveLength(3);
  });
});

describe('sendNotice', () => {
  beforeEach(async () => {
    await importBatch(input(), { actorId: 1, db });
  });

  it('sends a row once: a second claim of a claimed row gets nothing', async () => {
    const [first] = await notices();
    expect(await sendNotice(first.id, deps())).toBe('sent');
    expect(await sendNotice(first.id, deps())).toBe('not-claimable');
    expect(send).toHaveBeenCalledTimes(1);
    const [after] = await notices();
    expect(after.status).toBe('sent');
    expect(after.message_id).toMatch(/@relay>$/);
  });

  it('sends the snapshot from notices@ with the Reply-To', async () => {
    const [first] = await notices();
    await sendNotice(first.id, deps());
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'up1@example.test',
        from: 'Notices <notices@example.test>',
        replyTo: 'inbox@example.test',
        subject: 'S1',
        text: 'B1 <x>',
        html: expect.stringContaining('B1 &lt;x&gt;'),
      })
    );
  });

  it('claims and sends nothing while the brake is on', async () => {
    const [first] = await notices();
    const outcome = await sendNotice(
      first.id,
      deps({ readBrake: async () => ({ paused: true, by: 1, at: '', reason: 'test' }) })
    );
    expect(outcome).toBe('paused');
    expect(send).not.toHaveBeenCalled();
    expect((await notices())[0].status).toBe('pending');
  });

  it('pauses sends and alerts at the hourly ceiling', async () => {
    const [first, second] = await notices();
    await sendNotice(first.id, deps({ hourlyCeiling: 1 }));
    expect(await sendNotice(second.id, deps({ hourlyCeiling: 1 }))).toBe('ceiling');
    expect(pauseSends).toHaveBeenCalledWith('system', expect.stringContaining('ceiling'));
    expect(alert).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('records a failure by code, never by message, and lets the row be retried', async () => {
    send.mockRejectedValueOnce(
      Object.assign(new Error('550 up1@example.test mailbox unavailable'), { responseCode: 550 })
    );
    const [first] = await notices();
    expect(await sendNotice(first.id, deps())).toBe('failed');
    const [row] = await notices();
    expect(row.error).toBe('Error:550');
    expect(row.error).not.toContain('@');
    expect(await sendNotice(first.id, deps())).toBe('sent');
  });

  it('claims nothing while the read-only role can reach the case tables', async () => {
    const [first] = await notices();
    expect(await sendNotice(first.id, deps({ lockdownOk: async () => false }))).toBe('blocked');
    expect(send).not.toHaveBeenCalled();
    expect((await notices())[0].status).toBe('pending');
  });

  it('leaves a send that may have been delivered as sending, never retried, and pauses sends', async () => {
    // A timeout after DATA: no SMTP reply, so the relay may have accepted it.
    send.mockRejectedValueOnce(Object.assign(new Error('Timeout'), { code: 'ETIMEDOUT' }));
    const [first] = await notices();
    expect(await sendNotice(first.id, deps())).toBe('unknown');
    const [row] = await notices();
    expect(row.status).toBe('sending');
    expect(row.error).toMatch(/^Unknown:/);
    expect(pauseSends).toHaveBeenCalledWith('system', expect.stringContaining('may or may not'));
    expect(await sendNotice(first.id, deps())).toBe('not-claimable');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('does not mark a delivered message failed when recording it as sent fails', async () => {
    const [first] = await notices();
    send.mockImplementationOnce(async () => {
      // The row moves under the sender between the send and the `sent` write.
      await db.deleteFrom('case_notice').where('id', '=', first.id).execute();
      return { messageId: '<x@relay>' };
    });
    expect(await sendNotice(first.id, deps())).toBe('unknown');
    expect(pauseSends).toHaveBeenCalledWith('system', expect.stringContaining('message <x@relay>'));
  });

  it('refuses to send to an address that no longer matches its hash', async () => {
    const [first] = await notices();
    await db
      .updateTable('case_notice')
      .set({ recipient_address: 'other@example.test' })
      .where('id', '=', first.id)
      .execute();
    expect(await sendNotice(first.id, deps())).toBe('unsendable');
    expect(send).not.toHaveBeenCalled();
    expect((await notices())[0].error).toBe('AddressHashMismatch');
  });
});

describe('the brake', () => {
  it('reads as paused when Redis cannot be read', async () => {
    redis.get.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect((await readBrake()).paused).toBe(true);
  });

  it('reads as running only when the key is absent', async () => {
    redis.get.mockResolvedValueOnce(null);
    expect((await readBrake()).paused).toBe(false);
    redis.get.mockResolvedValueOnce(JSON.stringify({ by: 1, at: 'now', reason: 'x' }));
    expect((await readBrake()).paused).toBe(true);
  });
});

describe('the batch', () => {
  beforeEach(async () => {
    await importBatch(input(), { actorId: 1, db });
  });

  it('sends every pending row and stops at the brake', async () => {
    let calls = 0;
    const brake = async () =>
      ++calls > 2
        ? { paused: true as const, by: 1, at: '', reason: 'x' }
        : { paused: false as const };
    const result = await sendBatch('backlog-test', deps({ readBrake: brake }));
    expect(result).toEqual({
      counts: {
        sent: 2,
        failed: 0,
        unsendable: 0,
        unknown: 0,
        paused: 1,
        ceiling: 0,
        blocked: 0,
        'not-claimable': 0,
      },
      stoppedBy: 'paused',
    });
  });

  it('stops and pauses sends after repeated rejections by the relay', async () => {
    send.mockRejectedValue(Object.assign(new Error('554 rejected'), { responseCode: 554 }));
    const result = await sendBatch('backlog-test', deps());
    // The batch holds exactly MAX_CONSECUTIVE_FAILURES notices.
    expect(result.counts.failed).toBe(MAX_CONSECUTIVE_FAILURES);
    expect(result.stoppedBy).toBe('failures');
    expect(pauseSends).toHaveBeenCalledWith('system', expect.stringContaining('refused'));
  });

  it('does not count rows that failed before toward the stop, so a re-run reaches the rest', async () => {
    await db.updateTable('case_notice').set({ status: 'failed', error: 'Error:550' }).execute();
    send.mockRejectedValue(Object.assign(new Error('550 rejected'), { responseCode: 550 }));
    const result = await sendBatch('backlog-test', deps());
    expect(result.stoppedBy).toBeUndefined();
    expect(result.counts.failed).toBe(3);
    expect(pauseSends).not.toHaveBeenCalled();
  });

  it('retires a failed notice for good: never sent, exported or counted again', async () => {
    const [first] = await notices();
    await expect(retireNotice('backlog-test', first.id, { actorId: 1, db })).rejects.toThrow(
      /not a failed notice/
    );
    send.mockRejectedValueOnce(Object.assign(new Error('550'), { responseCode: 550 }));
    expect(await sendNotice(first.id, deps())).toBe('failed');
    await retireNotice('backlog-test', first.id, { actorId: 4, db });
    expect(await sendNotice(first.id, deps())).toBe('not-claimable');
    expect(
      (await exportUnsent('backlog-test', { actorId: 1, db })).map((r) => r.rowId)
    ).not.toContain(first.id);
    const [event] = await db
      .selectFrom('case_event')
      .select(['actor_id', 'data'])
      .where('type', '=', 'notice_retired')
      .execute();
    expect(event).toMatchObject({ actor_id: 4, data: { previousError: 'Error:550' } });
  });

  it('withdraws a pending notice: never sent or exported, and no longer owed', async () => {
    const rows = await notices();
    const t4 = rows.filter((r) => r.notice_id === 'T4');
    await withdrawNotice('backlog-test', t4[0].id, 'target restored', { actorId: 5, db });
    expect(await sendNotice(t4[0].id, deps())).toBe('not-claimable');
    expect(
      (await exportUnsent('backlog-test', { actorId: 1, db })).map((r) => r.rowId)
    ).not.toContain(t4[0].id);
    await importSentJsonl('backlog-test', '', { actorId: 1, db });
    await sendBatch('backlog-test', deps());
    const counts = await batchCounts('backlog-test', { db });
    expect(counts.find((c) => c.noticeId === 'T4')).toMatchObject({
      expected: 2,
      sent: 1,
      dropped: 1,
      failed: 0,
      done: true,
    });
    const [event] = await db
      .selectFrom('case_event')
      .select(['actor_id', 'data'])
      .where('type', '=', 'notice_withdrawn')
      .execute();
    expect(event).toMatchObject({ actor_id: 5, data: { reason: 'target restored' } });
  });

  it('refuses to withdraw a notice a send has already claimed or sent', async () => {
    const [first, second] = await notices();
    await db
      .updateTable('case_notice')
      .set({ status: 'sending' })
      .where('id', '=', first.id)
      .execute();
    await expect(withdrawNotice('backlog-test', first.id, 'x', { actorId: 1, db })).rejects.toThrow(
      /not a pending notice/
    );
    await sendNotice(second.id, deps());
    await expect(
      withdrawNotice('backlog-test', second.id, 'x', { actorId: 1, db })
    ).rejects.toThrow(/not a pending notice/);
  });

  it('refuses to withdraw while the batch is out with the fallback sender, and allows it after', async () => {
    const [first] = await notices();
    await exportUnsent('backlog-test', { actorId: 1, db });
    await expect(withdrawNotice('backlog-test', first.id, 'x', { actorId: 1, db })).rejects.toThrow(
      /out with the fallback sender/
    );
    expect((await notices())[0]).toMatchObject({ status: 'pending', error: null });
    await importSentJsonl('backlog-test', '', { actorId: 1, db });
    await expect(
      withdrawNotice('backlog-test', first.id, 'x', { actorId: 1, db })
    ).resolves.toEqual({ rowId: first.id });
  });

  it('withdraws only a row of the batch it names', async () => {
    await importBatch(input('backlog-other'), { actorId: 1, db });
    const other = (await notices()).at(-1)!;
    await expect(withdrawNotice('backlog-test', other.id, 'x', { actorId: 1, db })).rejects.toThrow(
      /not a pending notice of batch backlog-test/
    );
    expect((await notices()).at(-1)).toMatchObject({ id: other.id, status: 'pending' });
  });

  it('never retries an erased row, and does not count it as a relay refusal', async () => {
    const [first] = await notices();
    await db
      .updateTable('case_notice')
      .set({ body_snapshot: null })
      .where('id', '=', first.id)
      .execute();
    expect(await sendNotice(first.id, deps())).toBe('unsendable');
    expect(await sendNotice(first.id, deps())).toBe('not-claimable');
  });

  it('stops the batch at the first send that may have been delivered', async () => {
    send.mockRejectedValueOnce(new Error('socket hang up'));
    const result = await sendBatch('backlog-test', deps());
    expect(result).toMatchObject({ stoppedBy: 'unknown', counts: { unknown: 1, sent: 0 } });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('stops claiming once its run lock expires, so an export that takes the lock cannot overlap', async () => {
    const redis = fakeLockRedis();
    const asLock = redis as unknown as Parameters<typeof acquireRunLock>[0];
    const run = (await acquireRunLock(asLock, 'backlog-test'))!;
    send.mockImplementation(async () => {
      // The first row is slow enough for the lock to expire; an export then takes it.
      redis.store.delete(runLockKey('backlog-test'));
      expect(await acquireRunLock(asLock, 'backlog-test')).toBeTruthy();
      return { messageId: '<a@relay>' };
    });
    const result = await sendBatch(
      'backlog-test',
      deps({ holdsLock: () => renewRunLock(asLock, 'backlog-test', run) })
    );
    expect(result).toMatchObject({ stoppedBy: 'lost-lock', counts: { sent: 1 } });
    expect(send).toHaveBeenCalledTimes(1);
    expect(pauseSends).toHaveBeenCalledWith('system', expect.stringContaining('lost its run lock'));
    // The run's release leaves the export's lock alone.
    await releaseRunLock(asLock, 'backlog-test', run);
    expect(redis.store.has(runLockKey('backlog-test'))).toBe(true);
  });

  it('counts against the stated expected numbers, and a type with no expected count is never done', async () => {
    let counts = await batchCounts('backlog-test', { db });
    expect(counts.map((c) => [c.noticeId, c.expected, c.pending, c.done])).toEqual([
      ['C1', 1, 1, false],
      ['T4', 2, 2, false],
    ]);
    await sendBatch('backlog-test', deps());
    counts = await batchCounts('backlog-test', { db });
    expect(counts.every((c) => c.done)).toBe(true);

    await db
      .updateTable('process_definition_version')
      .set({ definition: JSON.stringify({ expected: { T4: 2 } }) })
      .execute();
    counts = await batchCounts('backlog-test', { db });
    expect(counts.find((c) => c.noticeId === 'C1')).toMatchObject({ expected: null, done: false });
  });

  it('reads 0 of N, not done, for a batch that was never imported', async () => {
    expect(await batchCounts('never-imported', { db })).toEqual([]);
  });

  it('undoes an unsent batch completely, and refuses once anything has been sent', async () => {
    await expect(undoImport('backlog-test', { actorId: 1, db })).resolves.toEqual({ cases: 1 });
    expect(await notices()).toHaveLength(0);
    expect(await db.selectFrom('process_definition').selectAll().execute()).toHaveLength(0);

    await importBatch(input(), { actorId: 1, db });
    const [first] = await notices();
    await sendNotice(first.id, deps());
    await expect(undoImport('backlog-test', { actorId: 1, db })).rejects.toBeInstanceOf(
      ImportRefusedError
    );
    expect(await notices()).toHaveLength(3);
  });

  it('refuses to undo a batch with a notice mid-send', async () => {
    const [first] = await notices();
    await db
      .updateTable('case_notice')
      .set({ status: 'sending' })
      .where('id', '=', first.id)
      .execute();
    await expect(undoImport('backlog-test', { actorId: 1, db })).rejects.toBeInstanceOf(
      ImportRefusedError
    );
    expect(await notices()).toHaveLength(3);
  });

  it('holds the batch while it is out with the fallback, until its sent.jsonl comes back', async () => {
    expect(await exportState('backlog-test', { db })).toBe('never');
    await exportUnsent('backlog-test', { actorId: 1, db });
    expect(await exportState('backlog-test', { db })).toBe('outstanding');
    await importSentJsonl('backlog-test', '', { actorId: 1, db });
    expect(await exportState('backlog-test', { db })).toBe('closed');
  });

  it('lets a person resolve a stopped send, never one still in flight', async () => {
    const [first, second] = await notices();
    await expect(
      resolveSending('backlog-test', first.id, 'sent', { actorId: 1, db })
    ).rejects.toThrow(/not a stopped send/);
    // Claimed just now and still in flight: not resolvable yet.
    await db
      .updateTable('case_notice')
      .set({ status: 'sending', attempted_at: new Date() })
      .where('id', 'in', [first.id, second.id])
      .execute();
    await expect(
      resolveSending('backlog-test', first.id, 'failed', { actorId: 1, db })
    ).rejects.toThrow(/not a stopped send/);

    // An ambiguous send leaves an error on the row: resolvable at once.
    await db
      .updateTable('case_notice')
      .set({ error: 'Unknown:Error' })
      .where('id', '=', first.id)
      .execute();
    await resolveSending('backlog-test', first.id, 'failed', { actorId: 3, db });
    expect(await sendNotice(first.id, deps())).toBe('sent');

    // Older than the stale window: resolvable as delivered, and never sent again.
    await db
      .updateTable('case_notice')
      .set({ attempted_at: new Date(Date.now() - 11 * 60 * 1000) })
      .where('id', '=', second.id)
      .execute();
    await resolveSending('backlog-test', second.id, 'sent', { actorId: 3, db });
    expect(await sendNotice(second.id, deps())).toBe('not-claimable');
    const events = await db
      .selectFrom('case_event')
      .select(['actor_id', 'data'])
      .where('type', '=', 'notice_resolved')
      .execute();
    expect(events.map((e) => [e.actor_id, (e.data as { outcome: string }).outcome])).toEqual([
      [3, 'failed'],
      [3, 'sent'],
    ]);
  });

  it('rolls back an export whose run lock lapsed: nothing recorded, no rows handed out', async () => {
    const redis = fakeLockRedis();
    const asLock = redis as unknown as Parameters<typeof acquireRunLock>[0];
    const token = (await acquireRunLock(asLock, 'backlog-test'))!;
    const holdsLock = async () => {
      // The export ran past its TTL and a send took the batch.
      redis.store.delete(runLockKey('backlog-test'));
      await acquireRunLock(asLock, 'backlog-test');
      return renewRunLock(asLock, 'backlog-test', token);
    };
    await expect(
      exportUnsent('backlog-test', { actorId: 1, holdsLock, db })
    ).rejects.toBeInstanceOf(ImportRefusedError);
    expect(await exportState('backlog-test', { db })).toBe('never');

    // While it still holds the lock, the same export goes through.
    const held = (await acquireRunLock(asLock, 'other'))!;
    redis.store.set(runLockKey('backlog-test'), held);
    const rows = await exportUnsent('backlog-test', {
      actorId: 1,
      holdsLock: () => renewRunLock(asLock, 'backlog-test', held),
      db,
    });
    expect(rows).toHaveLength(3);
    expect(await exportState('backlog-test', { db })).toBe('outstanding');
  });

  it('refuses to undo a batch that was ever exported for the fallback', async () => {
    await exportUnsent('backlog-test', { actorId: 1, db });
    await expect(undoImport('backlog-test', { actorId: 1, db })).rejects.toThrow(/exported/);
    await importSentJsonl('backlog-test', '', { actorId: 1, db });
    await expect(undoImport('backlog-test', { actorId: 1, db })).rejects.toThrow(/exported/);
    expect(await notices()).toHaveLength(3);
  });

  it('keeps every pii_read event through an undo, on a case emptied of personal data', async () => {
    await batchPreview('backlog-test', { actorId: 7, db });
    const reads = () =>
      db
        .selectFrom('case_event')
        .select(['case_id', 'actor_id'])
        .where('type', '=', 'pii_read')
        .execute();
    const before = await reads();
    expect(before).toHaveLength(1);
    await undoImport('backlog-test', { actorId: 1, db });
    expect(await reads()).toEqual(before);
    const [kept] = await db.selectFrom('case_record').selectAll().execute();
    expect(kept).toMatchObject({ state: 'Undone', import_batch_id: null, submitter: {} });
    expect(await batchCounts('backlog-test', { db })).toEqual([]);
  });

  it('exports unsent rows without addresses, and takes back only those the fallback sent', async () => {
    const [first] = await notices();
    await sendNotice(first.id, deps());
    const unsent = await exportUnsent('backlog-test', { actorId: 1, db });
    expect(unsent).toHaveLength(2);
    expect(JSON.stringify(unsent)).not.toContain('@example.test');

    const jsonl = [first.id, unsent[0].rowId]
      .map((rowId) =>
        JSON.stringify({ rowId, messageId: 'ticket-1', sentAt: '2026-11-26T00:00:00Z' })
      )
      .join('\n');
    const result = await importSentJsonl('backlog-test', jsonl, { actorId: 1, db });
    expect(result).toEqual({ updated: [unsent[0].rowId], refused: [first.id] });
    const rows = await notices();
    expect(rows.find((r) => r.id === first.id)?.message_id).not.toBe('ticket-1');
  });
});
