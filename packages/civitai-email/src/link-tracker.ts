// Click tracking for an app that cannot sign the main app's tracked links itself (the moderator
// app): at render, the links of one email are sent to the main app's internal route, which returns
// each same-site one as its signed click redirect (/api/email/click) and every other one unchanged.
// The main app's signing key never leaves it. A failed, slow or malformed answer sends the email
// with its links as they were: tracking never blocks or fails a send.
import type { MailClass } from './client';

/** The main app's route that signs another app's links. */
export const EMAIL_LINKS_INTERNAL_PATH = '/api/internal/email-links';
/** The main app's click redirect: the only path a link may come back rewritten to. */
export const EMAIL_CLICK_PATH = '/api/email/click';
/** How long the call may run before the email goes out with its links as they were. */
export const LINK_TRACKER_TIMEOUT_MS = 2000;
/**
 * After a call times out or cannot connect, the next calls are skipped (their links go out as
 * written) for this long, so a run of sends (a bulk appeal action) waits out one timeout, not one
 * each.
 */
export const LINK_TRACKER_PAUSE_MS = 30_000;
/** At most this many links in one call; the route refuses more. */
export const EMAIL_LINKS_MAX = 50;
/** The longest href sent; the route refuses longer. */
export const EMAIL_LINK_MAX_LENGTH = 2048;

/** What one send is, as each of its tracked links carries it. Never an address. */
export interface EmailLinkSend {
  sendId: string;
  template: string;
  mailClass: MailClass;
  campaign: string;
  variant: string;
  /** The recipient's user id; 0 when the sender does not know it. */
  userId: number;
}

/**
 * Given a send and its hrefs (as written in the HTML attribute, in document order), the same
 * number of hrefs back, each tracked or as it was. Never throws or rejects.
 */
export type EmailLinkTracker = (send: EmailLinkSend, hrefs: string[]) => Promise<string[]>;

export interface RemoteLinkTrackerOptions {
  /** The main app's base URL, e.g. https://civitai.com. */
  baseUrl: string;
  /** The service credential the route accepts, sent as the Bearer. */
  token: string;
  /** Told why a call's links went out untracked (a status or an error name). Never an address. */
  onError?: (reason: string) => void;
  timeoutMs?: number;
  pauseMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

const isClickUrl = (value: string) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.pathname === EMAIL_CLICK_PATH;
  } catch {
    return false;
  }
};

/**
 * The tracker, or null when either the base URL or the token is missing (no link is tracked, and
 * nothing is sent anywhere).
 */
export function createRemoteLinkTracker({
  baseUrl,
  token,
  onError,
  timeoutMs = LINK_TRACKER_TIMEOUT_MS,
  pauseMs = LINK_TRACKER_PAUSE_MS,
  fetch: fetchImpl = globalThis.fetch,
  now = Date.now,
}: RemoteLinkTrackerOptions): EmailLinkTracker | null {
  const base = baseUrl?.trim().replace(/\/+$/, '');
  if (!base || !token?.trim()) return null;
  const url = `${base}${EMAIL_LINKS_INTERNAL_PATH}`;
  let pausedUntil = 0;
  return async (send, hrefs) => {
    if (!hrefs.length || now() < pausedUntil) return hrefs;
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ...send, links: hrefs }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        onError?.(`status ${res.status}`);
        return hrefs;
      }
      const links = ((await res.json()) as { links?: unknown } | null)?.links;
      // The answer is taken whole or not at all: one entry out of place would put a link's
      // signature on another link's text.
      if (
        !Array.isArray(links) ||
        links.length !== hrefs.length ||
        !links.every((l, i) => typeof l === 'string' && (l === hrefs[i] || isClickUrl(l)))
      ) {
        onError?.('malformed answer');
        return hrefs;
      }
      return links as string[];
    } catch (err) {
      const reason = (err as Error)?.name ?? 'error';
      // A timeout or a failed connection: the main app is slow or unreachable, so stop asking for
      // a while. A refusal or a bad answer comes back fast and pauses nothing.
      if (reason === 'TimeoutError' || reason === 'TypeError') pausedUntil = now() + pauseMs;
      onError?.(reason);
      return hrefs;
    }
  };
}

let _tracker: EmailLinkTracker | null = null;

/** Sets the tracker every createEmail send's links go through (null: links are sent as written). */
export function setEmailLinkTracker(tracker: EmailLinkTracker | null) {
  _tracker = tracker;
}

export function getEmailLinkTracker(): EmailLinkTracker | null {
  return _tracker;
}

// An opening <a> tag with a double-quoted href, the same pattern the main app's own link
// tracking rewrites.
const ANCHOR_HREF = /(<a\b[^>]*?\shref=")([^"]*)(")/gi;
// Only a web link is ever sent: never a mailto: (an address) or any other scheme.
const WEB_HREF = /^(?:https?:\/\/|\/)/i;

const escapeAttribute = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const isSent = (href: string) => WEB_HREF.test(href) && href.length <= EMAIL_LINK_MAX_LENGTH;

/** The hrefs in `html` that would be sent to the tracker, in document order. */
export function trackableHrefs(html: string): string[] {
  return [...html.matchAll(ANCHOR_HREF)]
    .map((m) => m[2]!)
    .filter(isSent)
    .slice(0, EMAIL_LINKS_MAX);
}

/**
 * `html` with its links put through `tracker`: each one it returns rewritten is replaced, every
 * other link (and all of them, on any failure) stays exactly as written. The main app decides which
 * links are trackable; this only decides which are ever sent to it (web links, none with an
 * address).
 */
export async function trackLinksVia(
  tracker: EmailLinkTracker,
  html: string,
  send: EmailLinkSend
): Promise<string> {
  const hrefs = trackableHrefs(html);
  if (!hrefs.length) return html;
  let tracked: string[];
  try {
    tracked = await tracker(send, hrefs);
  } catch {
    return html;
  }
  if (!Array.isArray(tracked) || tracked.length !== hrefs.length) return html;
  let next = 0;
  return html.replace(ANCHOR_HREF, (whole, open: string, href: string, close: string) => {
    // The same walk trackableHrefs took, so the nth sent href gets the nth answer.
    if (!isSent(href) || next >= hrefs.length) return whole;
    const out = tracked[next++]!;
    return out === href ? whole : `${open}${escapeAttribute(out)}${close}`;
  });
}
