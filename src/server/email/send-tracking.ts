import type { EmailSendRecord } from '@civitai/email';
import type { CustomClickHouseClient } from '@civitai/clickhouse/client';
import { formatClickhouseDateTime64 } from '~/server/clickhouse/datetime';
import { logToAxiom, safeError } from '~/server/logging/client';
import { fetchTimeoutSignal } from '~/server/utils/fetch-timeout';

/**
 * One `send` row per message the transport accepted, in the general email events table: the
 * send's tags and our own send id (the message's X-Civitai-Send-Id header), never an address.
 */

/** How long one insert may run before it is aborted, so a stalled ClickHouse holds no request open. */
export const EMAIL_EVENT_INSERT_TIMEOUT_MS = 2000;

/** The ClickHouse table (DDL: src/server/clickhouse/migrations/2026-11-24-email-events.sql). */
export const EMAIL_EVENTS_TABLE = 'emailEvents';

export function emailSendRow(r: EmailSendRecord) {
  return {
    time: formatClickhouseDateTime64(r.sentAt),
    event: 'send',
    sendId: r.sendId,
    template: r.template,
    mailClass: r.mailClass,
    campaign: r.campaign,
    variant: r.variant,
    userId: r.userId,
  };
}

type Inserter = Pick<CustomClickHouseClient, 'insert'>;

// The tags only: the error names a table or a host, never an address.
const logRecordFailure = (err: unknown, r: EmailSendRecord) =>
  logToAxiom({
    type: 'warning',
    name: 'email-events',
    message: 'email send could not be recorded',
    error: safeError(err),
    payload: { template: r.template, mailClass: r.mailClass },
  });

/**
 * Writes the send row through `client` (none: nothing to do). Never throws. With the client's
 * async inserts some failures (the table missing, for one) may never reach the app, so a zero is
 * checked against the table, not the log.
 */
export async function insertEmailSend(client: Inserter | undefined, r: EmailSendRecord) {
  if (!client) return;
  try {
    await client.insert({
      table: EMAIL_EVENTS_TABLE,
      values: [emailSendRow(r)],
      format: 'JSONEachRow',
      abort_signal: fetchTimeoutSignal(EMAIL_EVENT_INSERT_TIMEOUT_MS),
    });
  } catch (err) {
    logRecordFailure(err, r);
  }
}

/** The app's recorder: the send row, through the process's ClickHouse client. Never throws. */
export async function recordEmailSend(r: EmailSendRecord): Promise<void> {
  let client: Inserter | undefined;
  try {
    ({ clickhouse: client } = await import('~/server/clickhouse/client'));
  } catch (err) {
    logRecordFailure(err, r);
    return;
  }
  await insertEmailSend(client, r);
}
