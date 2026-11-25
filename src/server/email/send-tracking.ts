import { isSendId, type EmailSendRecord } from '@civitai/email';
import type { CustomClickHouseClient } from '@civitai/clickhouse/client';
import { formatClickhouseDateTime64 } from '~/server/clickhouse/datetime';
import { logToAxiom, safeError } from '~/server/logging/client';
import { fetchTimeoutSignal } from '~/server/utils/fetch-timeout';

/**
 * The general email events table: one `send` row per message the transport accepted (the send's
 * tags and our own send id, the message's X-Civitai-Send-Id header), and one `click` or
 * `unsubscribe` row per followed tracked link or lifecycle opt-out. Never an address.
 */

/** How long one insert may run before it is aborted, so a stalled ClickHouse holds no request open. */
export const EMAIL_EVENT_INSERT_TIMEOUT_MS = 2000;

/**
 * The ClickHouse table (DDL: src/server/clickhouse/migrations/2026-11-24-email-events.sql, plus the
 * click columns in 2026-11-25-email-events-click-columns.sql).
 */
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

/** A click on a tracked link, or a lifecycle opt-out: what the signed link (or the send) named. */
export type EmailEvent = {
  event: 'click' | 'unsubscribe';
  sendId: string;
  template: string;
  mailClass: EmailSendRecord['mailClass'];
  campaign: string;
  variant: string;
  userId: number;
  /** click rows: the link's place, 1-based (0 for the digest's 'See all' button); 0 on other rows. */
  position?: number;
  /** click rows: the request's User-Agent. */
  userAgent?: string;
};

const NIL_UUID = '00000000-0000-0000-0000-000000000000';
export const EMAIL_EVENT_USER_AGENT_MAX = 512;

/**
 * The row for a click or an unsubscribe. `position` and `userAgent` come from the click DDL; until
 * it is applied they are skipped on insert (see insertEmailEvents).
 */
export function emailEventRow(e: EmailEvent, at: Date) {
  return {
    time: formatClickhouseDateTime64(at),
    event: e.event,
    sendId: isSendId(e.sendId) ? e.sendId : NIL_UUID,
    template: e.template,
    mailClass: e.mailClass,
    campaign: e.campaign,
    variant: e.variant,
    userId: Number.isInteger(e.userId) && e.userId > 0 && e.userId <= 0xffffffff ? e.userId : 0,
    position:
      e.event === 'click' && Number.isInteger(e.position) && e.position! > 0
        ? Math.min(e.position!, 0xffff)
        : 0,
    userAgent: e.event === 'click' ? (e.userAgent ?? '').slice(0, EMAIL_EVENT_USER_AGENT_MAX) : '',
  };
}

/**
 * Writes click and unsubscribe rows through `client`. Never throws, and waits at most
 * EMAIL_EVENT_INSERT_TIMEOUT_MS: a measurement failure must never fail or stall a redirect or an
 * opt-out. `input_format_skip_unknown_fields` lets the rows land, without `position` and
 * `userAgent`, on a table the click DDL has not reached yet.
 */
export async function insertEmailEvents(client: Inserter | undefined, events: EmailEvent[]) {
  if (!client || events.length === 0) return;
  const at = new Date();
  try {
    await client.insert({
      table: EMAIL_EVENTS_TABLE,
      values: events.map((e) => emailEventRow(e, at)),
      format: 'JSONEachRow',
      clickhouse_settings: { input_format_skip_unknown_fields: 1 },
      abort_signal: fetchTimeoutSignal(EMAIL_EVENT_INSERT_TIMEOUT_MS),
    });
  } catch (err) {
    logToAxiom({
      type: 'warning',
      name: 'email-events',
      message: 'email events could not be recorded',
      error: safeError(err),
      payload: { event: events[0]!.event, template: events[0]!.template, count: events.length },
    });
  }
}

/** insertEmailEvents through the process's ClickHouse client. Never throws. */
export async function recordEmailEvents(events: EmailEvent[]): Promise<void> {
  let client: Inserter | undefined;
  try {
    ({ clickhouse: client } = await import('~/server/clickhouse/client'));
  } catch (err) {
    logToAxiom({
      type: 'warning',
      name: 'email-events',
      message: 'email events could not be recorded',
      error: safeError(err),
    });
    return;
  }
  await insertEmailEvents(client, events);
}
