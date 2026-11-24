import { EMAIL_SEND_RECORD_TIMEOUT_MS, type EmailSendRecord } from '@civitai/email';
import { formatClickhouseDateTime64 } from '~/server/clickhouse/datetime';
import { logToAxiom, safeError } from '~/server/logging/client';
import { fetchTimeoutSignal } from '~/server/utils/fetch-timeout';

/**
 * One `send` row per message the transport accepted, in the general email events table. The
 * transport (@civitai/email) calls `recordEmailSend` after every successful send and waits on it
 * at most EMAIL_SEND_RECORD_TIMEOUT_MS; this never throws either. The row carries the send's tags
 * and our own send id (the message's X-Civitai-Send-Id header), never an address.
 */

/** The ClickHouse table (DDL: src/server/clickhouse/migrations/2026-11-24-email-events.sql). */
export const EMAIL_EVENTS_TABLE = 'emailEvents';

/** The ClickHouse row for one send. */
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

/**
 * Writes the send row. With the client's async inserts some failures (the table missing, for one)
 * may never reach the app, so a zero is checked against the table, not the log.
 */
export async function recordEmailSend(r: EmailSendRecord): Promise<void> {
  try {
    const { clickhouse } = await import('~/server/clickhouse/client');
    if (!clickhouse) return;
    await clickhouse.insert({
      table: EMAIL_EVENTS_TABLE,
      values: [emailSendRow(r)],
      format: 'JSONEachRow',
      abort_signal: fetchTimeoutSignal(EMAIL_SEND_RECORD_TIMEOUT_MS),
    });
  } catch (err) {
    logToAxiom({
      type: 'warning',
      name: 'email-events',
      message: 'email send could not be recorded',
      error: safeError(err),
      payload: { template: r.template, mailClass: r.mailClass },
    });
  }
}
