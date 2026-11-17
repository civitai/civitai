import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CasesDb } from '../cases.db';
import { casesPglite } from './cases-pglite.harness';

const redis = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), del: vi.fn() }));
vi.mock('../../redis', () => ({ getSysRedis: () => redis }));

const { hashAddress, sendBatch, sendNotice } = await import('../send-notice');
const { readBrake } = await import('../brake');
const { batchCounts, exportUnsent, importBatch, importSentJsonl, undoImport, ImportRefusedError } =
  await import('../backlog-import');
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
  pauseSends.mockReset();
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

  it('refuses to send to an address that no longer matches its hash', async () => {
    const [first] = await notices();
    await db
      .updateTable('case_notice')
      .set({ recipient_address: 'other@example.test' })
      .where('id', '=', first.id)
      .execute();
    expect(await sendNotice(first.id, deps())).toBe('failed');
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
      counts: { sent: 2, failed: 0, paused: 1, ceiling: 0, 'not-claimable': 0 },
      stoppedBy: 'paused',
    });
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
    await expect(undoImport('backlog-test', { db })).resolves.toEqual({ cases: 1 });
    expect(await notices()).toHaveLength(0);
    expect(await db.selectFrom('process_definition').selectAll().execute()).toHaveLength(0);

    await importBatch(input(), { actorId: 1, db });
    const [first] = await notices();
    await sendNotice(first.id, deps());
    await expect(undoImport('backlog-test', { db })).rejects.toBeInstanceOf(ImportRefusedError);
    expect(await notices()).toHaveLength(3);
  });

  it('exports unsent rows without addresses, and takes back only those the fallback sent', async () => {
    const [first] = await notices();
    await sendNotice(first.id, deps());
    const unsent = await exportUnsent('backlog-test', { db });
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
