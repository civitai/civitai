import { readFileSync } from 'fs';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getEmailSendRecorder, type EmailSendRecord } from '@civitai/email';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import {
  EMAIL_EVENTS_TABLE,
  emailEventRow,
  emailSendRow,
  insertEmailEvents,
  insertEmailSend,
  recordEmailSend,
} from '~/server/email/send-tracking';

const record: EmailSendRecord = {
  sendId: '0b6f3d4e-8f7a-4c1e-9d2b-5a6c7e8f9a0b',
  sentAt: new Date('2026-11-24T10:20:30.456Z'),
  template: 'trainingComplete',
  mailClass: 'transactional',
  campaign: 'c-7',
  variant: 'b',
  userId: 42,
};

// A stand-in ClickHouse client: only `insert` is used.
const fakeClient = () => {
  const insert = vi.fn();
  insert.mockResolvedValue(undefined);
  return { insert, client: { insert } as unknown as Parameters<typeof insertEmailSend>[0] };
};

beforeEach(() => {
  loggingMock.logToAxiom.mockClear();
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

const migration = (file: string) =>
  readFileSync(path.resolve(__dirname, '../../clickhouse/migrations', file), 'utf8');

describe('click and unsubscribe rows', () => {
  const click = {
    event: 'click' as const,
    sendId: '0b6f3d4e-8f7a-4c1e-9d2b-5a6c7e8f9a0b',
    template: 'trainingComplete',
    mailClass: 'transactional' as const,
    campaign: 'c-7',
    variant: 'b',
    userId: 42,
    position: 3,
    userAgent: 'x'.repeat(600),
  };
  const at = new Date('2026-11-25T01:02:03.004Z');

  it("add exactly the click DDL's columns to the table's own", () => {
    const sql = migration('2026-11-25-email-events-click-columns.sql');
    expect(sql).toContain('ALTER TABLE default.emailEvents');
    const added = [...sql.matchAll(/ADD COLUMN IF NOT EXISTS (\w+) /g)].map((m) => m[1]);
    expect(added).toEqual(['position', 'userAgent']);
    expect(Object.keys(emailEventRow(click, at)).sort()).toEqual(
      [...Object.keys(emailSendRow(record)), ...added].sort()
    );
  });

  it('a click row is what the link named, its position and a capped user agent', () => {
    expect(emailEventRow(click, at)).toEqual({
      time: '2026-11-25 01:02:03.004',
      event: 'click',
      sendId: '0b6f3d4e-8f7a-4c1e-9d2b-5a6c7e8f9a0b',
      template: 'trainingComplete',
      mailClass: 'transactional',
      campaign: 'c-7',
      variant: 'b',
      userId: 42,
      position: 3,
      userAgent: 'x'.repeat(512),
    });
  });

  it('an unsubscribe row has no position or user agent; a malformed send id is the nil UUID', () => {
    const row = emailEventRow(
      { ...click, event: 'unsubscribe', sendId: 'junk', mailClass: 'lifecycle', userId: -1 },
      at
    );
    expect(row).toMatchObject({
      event: 'unsubscribe',
      sendId: '00000000-0000-0000-0000-000000000000',
      userId: 0,
      position: 0,
      userAgent: '',
    });
  });

  it('inserts skipping unknown fields (the click DDL unapplied), and never throws', async () => {
    const { insert, client } = fakeClient();
    await insertEmailEvents(client, [click]);
    expect(insert.mock.calls[0][0]).toMatchObject({
      table: 'emailEvents',
      format: 'JSONEachRow',
      clickhouse_settings: { input_format_skip_unknown_fields: 1 },
      abort_signal: expect.any(AbortSignal),
    });
    insert.mockRejectedValueOnce(new Error('boom'));
    await expect(insertEmailEvents(client, [click])).resolves.toBeUndefined();
    expect(loggingMock.logToAxiom).toHaveBeenCalledTimes(1);
  });
});

describe('insertEmailSend', () => {
  it('inserts the one row into emailEvents, with an abort signal', async () => {
    const { insert, client } = fakeClient();
    await insertEmailSend(client, record);
    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert.mock.calls[0][0]).toEqual({
      table: 'emailEvents',
      values: [emailSendRow(record)],
      format: 'JSONEachRow',
      abort_signal: expect.any(AbortSignal),
    });
    expect(loggingMock.logToAxiom).not.toHaveBeenCalled();
  });

  it('never throws: an insert error (the table missing, say) is logged with the tags only', async () => {
    const { insert, client } = fakeClient();
    insert.mockRejectedValueOnce(new Error('Table default.emailEvents does not exist'));
    await expect(insertEmailSend(client, record)).resolves.toBeUndefined();
    expect(loggingMock.logToAxiom).toHaveBeenCalledTimes(1);
    expect(loggingMock.logToAxiom.mock.calls[0][0]).toMatchObject({
      type: 'warning',
      name: 'email-events',
      payload: { template: 'trainingComplete', mailClass: 'transactional' },
    });
  });

  it('does nothing without a ClickHouse client', async () => {
    await expect(insertEmailSend(undefined, record)).resolves.toBeUndefined();
    expect(loggingMock.logToAxiom).not.toHaveBeenCalled();
  });
});

describe('the app transport', () => {
  it('registers recordEmailSend as the recorder of every send', async () => {
    await import('~/server/email/client');
    expect(getEmailSendRecorder()).toBe(recordEmailSend);
  });
});
