import { isSendId } from '@civitai/email';
import { formatClickhouseDateTime64 } from '~/server/clickhouse/datetime';
import { safeSitePath, sitePathOf } from '~/server/email/link-tracking';
import { logToAxiom, safeError } from '~/server/logging/client';
import { fetchTimeoutSignal } from '~/server/utils/fetch-timeout';
import { signEmailLink, verifyEmailLinkSignature } from '~/server/email/link-signing';
import { getBaseUrl } from '~/server/utils/url-helpers';

/**
 * Click-through measurement for the weekly missed-notification digest.
 *
 * Every link in a digest goes through `DIGEST_CLICK_PATH`, which records the click against the
 * user and pass named in the link (never the session: the reader is often signed out) and then
 * redirects to the item. Sends, clicks and digest unsubscribes land in one ClickHouse table, so a
 * pass's click-through is one query over it.
 */

/** The ClickHouse table (DDL: src/server/clickhouse/migrations/2026-11-24-notification-digest-events.sql). */
export const DIGEST_EVENTS_TABLE = 'notificationDigestEvents';
export const DIGEST_CLICK_PATH = '/api/notifications/digest-click';
/** The digest's template key (missedNotificationsDigest.email.ts), on its emailEvents rows. */
export const DIGEST_EMAIL_TEMPLATE = 'missedNotificationsDigest';
/** Where a click with a broken link lands. */
export const DIGEST_FALLBACK_PATH = '/user/notifications';
/** The position a click on "See all notifications" records; listed items count from 1. */
export const DIGEST_ALL_POSITION = 0;

/** `to` as a same-site path to redirect to, or null (the email click route's rule). */
export { safeSitePath };

/**
 * The site path a notification's url points at, or null when it points off the site (that link is
 * left as it is, untracked). Accepts a relative path or an absolute url on this site.
 */
export const digestTargetPath = sitePathOf;

export type DigestClick = {
  userId: number;
  /** The pass the email was sent in (`DigestCursor.cycleStartedAt`). */
  cycleStartedAt: Date;
  /** 1-based item position, or `DIGEST_ALL_POSITION` for the "See all notifications" button. */
  position: number;
  /** The listed notification's type; '' for the button. */
  notificationType: string;
  /** A same-site path. */
  to: string;
  /**
   * The email's send id (emailEvents.sendId), so the click is also an emailEvents `click` row.
   * Links in digests sent before it was added carry none, and still verify.
   */
  sendId?: string;
};

// JSON, so no field can run into the next (a type or path may contain any separator). A link with
// a send id signs it as a sixth field; one without signs the five fields it always had.
const clickMessage = (c: DigestClick) =>
  `notification-digest-click:${JSON.stringify([
    c.userId,
    c.cycleStartedAt.getTime(),
    c.position,
    c.notificationType,
    c.to,
    ...(c.sendId === undefined ? [] : [c.sendId]),
  ])}`;

/** The tracked link for one digest link. Throws when `to` is not a same-site path. */
export function getDigestClickUrl(click: DigestClick) {
  const to = safeSitePath(click.to);
  if (!to) throw new Error('A digest link must point at a site path');
  const signed = { ...click, to };
  const params = new URLSearchParams({
    u: String(signed.userId),
    c: String(signed.cycleStartedAt.getTime()),
    p: String(signed.position),
    n: signed.notificationType,
    to,
    ...(signed.sendId === undefined ? {} : { e: signed.sendId }),
    s: signEmailLink(clickMessage(signed)),
  });
  return `${getBaseUrl()}${DIGEST_CLICK_PATH}?${params}`;
}

const positiveInt = (v: unknown, { allowZero = false } = {}) => {
  if (typeof v !== 'string' || !/^\d{1,15}$/.test(v)) return null;
  const n = Number(v);
  return n > 0 || (allowZero && n === 0) ? n : null;
};

/** The click a tracked link names, or null when any part of it is missing, malformed or unsigned. */
export function verifyDigestClick(query: Record<string, unknown>): DigestClick | null {
  const userId = positiveInt(query.u);
  const cycleMs = positiveInt(query.c);
  const position = positiveInt(query.p, { allowZero: true });
  const notificationType = query.n;
  const to = safeSitePath(query.to);
  if (userId === null || cycleMs === null || position === null || to === null) return null;
  if (typeof notificationType !== 'string' || notificationType.length > 100) return null;
  if (typeof query.s !== 'string') return null;
  if (query.e !== undefined && !isSendId(query.e)) return null;
  const click: DigestClick = {
    userId,
    cycleStartedAt: new Date(cycleMs),
    position,
    notificationType,
    to,
    ...(isSendId(query.e) ? { sendId: query.e } : {}),
  };
  // `to` is signed as the link carried it: a link whose path normalises to something else fails.
  if (to !== query.to) return null;
  return verifyEmailLinkSignature(clickMessage(click), query.s) ? click : null;
}

/** The pass an unsubscribe link names (`c`), or null. Unsigned: it can only mislabel the user's own row. */
export function digestCycleParam(v: unknown): Date | null {
  const ms = positiveInt(v);
  return ms === null ? null : new Date(ms);
}

export type DigestEvent =
  | { event: 'send'; userId: number; cycleStartedAt: Date; sentAt: Date; itemCount: number }
  | {
      event: 'click';
      userId: number;
      cycleStartedAt: Date;
      position: number;
      notificationType: string;
      userAgent: string;
    }
  | { event: 'unsubscribe'; userId: number; cycleStartedAt: Date | null };

const EPOCH = new Date(0);

/** The ClickHouse row for one event. Columns an event does not have are zero or ''. */
export function digestEventRow(e: DigestEvent, at: Date) {
  return {
    time: formatClickhouseDateTime64(at),
    event: e.event,
    userId: e.userId,
    cycleStartedAt: formatClickhouseDateTime64(e.cycleStartedAt ?? EPOCH),
    sentAt: formatClickhouseDateTime64(e.event === 'send' ? e.sentAt : EPOCH),
    itemCount: e.event === 'send' ? e.itemCount : 0,
    position: e.event === 'click' ? e.position : 0,
    notificationType: e.event === 'click' ? e.notificationType : '',
    userAgent: e.event === 'click' ? e.userAgent.slice(0, 512) : '',
  };
}

/** How long a click's redirect, an unsubscribe or a page of sends waits on the insert. */
export const DIGEST_EVENTS_INSERT_TIMEOUT_MS = 2000;

/**
 * Writes the events. Never throws, and waits at most `DIGEST_EVENTS_INSERT_TIMEOUT_MS`: a
 * measurement failure must not fail or stall a send, a click's redirect or an unsubscribe. An
 * insert error is logged; with the client's async inserts some failures (the table missing, for
 * one) may never reach the app, so a zero is checked against the table, not the log.
 */
export async function recordDigestEvents(events: DigestEvent[]): Promise<void> {
  if (events.length === 0) return;
  try {
    const { clickhouse } = await import('~/server/clickhouse/client');
    if (!clickhouse) return;
    const at = new Date();
    await clickhouse.insert({
      table: DIGEST_EVENTS_TABLE,
      values: events.map((e) => digestEventRow(e, at)),
      format: 'JSONEachRow',
      abort_signal: fetchTimeoutSignal(DIGEST_EVENTS_INSERT_TIMEOUT_MS),
    });
  } catch (err) {
    logToAxiom({
      type: 'warning',
      name: 'notification-digest',
      message: 'digest events could not be recorded',
      error: safeError(err),
      payload: { count: events.length, event: events[0]?.event },
    });
  }
}
