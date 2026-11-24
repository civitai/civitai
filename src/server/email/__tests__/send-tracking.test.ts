import { readFileSync } from 'fs';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CivitaiEmail from '@civitai/email';
import type { EmailSendRecord } from '@civitai/email';

const h = vi.hoisted(() => ({
  insert: vi.fn(),
  log: vi.fn(),
  clickhouse: true,
}));
vi.mock('~/server/clickhouse/client', () => ({
  get clickhouse() {
    return h.clickhouse ? { insert: h.insert } : undefined;
  },
}));
vi.mock('~/server/logging/client', () => ({
  logToAxiom: h.log,
  safeError: (e: unknown) => String(e),
}));
vi.mock('~/server/utils/fetch-timeout', () => ({
  fetchTimeoutSignal: (ms: number) => ({ timeoutMs: ms }),
}));

const { EMAIL_EVENTS_TABLE, emailSendRow, recordEmailSend } = await import(
  '~/server/email/send-tracking'
);

const record: EmailSendRecord = {
  sendId: '0b6f3d4e-8f7a-4c1e-9d2b-5a6c7e8f9a0b',
  sentAt: new Date('2026-11-24T10:20:30.456Z'),
  template: 'trainingComplete',
  mailClass: 'transactional',
  campaign: 'c-7',
  variant: 'b',
  userId: 42,
};

beforeEach(() => {
  h.insert.mockReset();
  h.insert.mockResolvedValue(undefined);
  h.log.mockReset();
  h.clickhouse = true;
});

// A row key the table lacks fails the whole insert inside a swallowed catch, so the two are pinned.
describe('emailEvents row and DDL', () => {
  it('writes exactly the columns the table declares', () => {
    const sql = readFileSync(
      path.resolve(__dirname, '../../clickhouse/migrations/2026-11-24-email-events.sql'),
      'utf8'
    );
    const open = `${EMAIL_EVENTS_TABLE}\n(`;
    expect(sql).toContain(`CREATE TABLE IF NOT EXISTS default.${open}`);
    const columns = sql
      .slice(sql.indexOf(open) + open.length, sql.indexOf('\n)\nENGINE'))
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('--'))
      .map((l) => l.split(/\s+/)[0]);
    expect(columns).toEqual([
      'time',
      'event',
      'sendId',
      'template',
      'mailClass',
      'campaign',
      'variant',
      'userId',
    ]);
    expect(Object.keys(emailSendRow(record)).sort()).toEqual([...columns].sort());
  });

  it('a send row is the tags, the send id and the time, and no address', () => {
    expect(emailSendRow(record)).toEqual({
      time: '2026-11-24 10:20:30.456',
      event: 'send',
      sendId: '0b6f3d4e-8f7a-4c1e-9d2b-5a6c7e8f9a0b',
      template: 'trainingComplete',
      mailClass: 'transactional',
      campaign: 'c-7',
      variant: 'b',
      userId: 42,
    });
  });
});

describe('recordEmailSend', () => {
  it('inserts the one row into emailEvents, bounded by the send-record timeout', async () => {
    await recordEmailSend(record);
    expect(h.insert).toHaveBeenCalledTimes(1);
    expect(h.insert.mock.calls[0][0]).toEqual({
      table: 'emailEvents',
      values: [emailSendRow(record)],
      format: 'JSONEachRow',
      abort_signal: { timeoutMs: 2000 },
    });
    expect(h.log).not.toHaveBeenCalled();
  });

  it('never throws: an insert error (the table missing, say) is logged with the tags only', async () => {
    h.insert.mockRejectedValueOnce(new Error('Table default.emailEvents does not exist'));
    await expect(recordEmailSend(record)).resolves.toBeUndefined();
    expect(h.log).toHaveBeenCalledTimes(1);
    expect(h.log.mock.calls[0][0]).toMatchObject({
      type: 'warning',
      name: 'email-events',
      payload: { template: 'trainingComplete', mailClass: 'transactional' },
    });
  });

  it('does nothing without a ClickHouse client', async () => {
    h.clickhouse = false;
    await recordEmailSend(record);
    expect(h.insert).not.toHaveBeenCalled();
    expect(h.log).not.toHaveBeenCalled();
  });
});

describe('the app transport', () => {
  it('registers recordEmailSend as the recorder of every send', async () => {
    const setEmailSendRecorder = vi.fn();
    vi.doMock('@civitai/email', async (importOriginal) => ({
      ...(await importOriginal<typeof CivitaiEmail>()),
      setEmailSendRecorder,
    }));
    vi.doMock('~/env/server', () => ({ env: { IS_BUILD: false } }));
    await import('~/server/email/client');
    expect(setEmailSendRecorder).toHaveBeenCalledTimes(1);
    expect(setEmailSendRecorder).toHaveBeenCalledWith(recordEmailSend);
  });
});
