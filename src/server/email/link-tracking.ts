import { decode as decodeHtml, escape as escapeHtml } from 'he';
import { safeReturnPath } from '@civitai/auth/client';
import { EMAIL_CLICK_PATH, isSendId, MAIL_CLASSES, type MailClass } from '@civitai/email';
import { signEmailLink, verifyEmailLinkSignature } from '~/server/email/link-signing';
import { getBaseUrl } from '~/server/utils/url-helpers';

/**
 * Click-through measurement for every email the main app renders.
 *
 * At send, each same-site link in a template's HTML is rewritten to `EMAIL_CLICK_PATH`, signed with
 * the send id, template, mail class, campaign, variant, recipient and the link's place. The click
 * route records a `click` row from what the link names (never the session: the reader is often
 * signed out) and redirects to the link's own path.
 *
 * Left as they are, by rule rather than by each template's care:
 * - every link of a template that declares `oneTimeTokenLinks` (a sign-in, verification, reset or
 *   invite link carries a single-use token, and a scanner following a redirect must never be what
 *   spends it);
 * - a link off the site, or not http(s) (`mailto:`): the redirect only ever goes to a site path;
 * - a link to one of our own signed endpoints (`NEVER_WRAPPED_PATHS`), which count themselves or
 *   must not count as a click (an unsubscribe link).
 * The plain-text part keeps its links as they are.
 */

// Declared in @civitai/email, whose link tracker accepts only a link rewritten to it.
export { EMAIL_CLICK_PATH };
/** Where a click with a broken or tampered link lands. */
export const EMAIL_CLICK_FALLBACK_PATH = '/';

/**
 * Paths never rewritten: the click route itself, the digest's own click route (its links record in
 * notificationDigestEvents, and in emailEvents when they carry a send id) and the email unsubscribe
 * route. Literal here
 * so this module imports neither route's module; a test pins them to those modules' constants.
 */
export const NEVER_WRAPPED_PATHS = [
  EMAIL_CLICK_PATH,
  '/api/notifications/digest-click',
  '/api/notifications/email-unsubscribe',
] as const;

const MAX_PATH_LENGTH = 2048;
const MAX_TAG_LENGTH = 200;
const MAX_POSITION = 0xffff;
const MAX_USER_ID = 0xffffffff;

/**
 * `to` as a same-site path to redirect to, or null: the shared return-path rule (no scheme, no
 * host, no `//`, backslash or control character, checked again after normalising), plus a length
 * cap. Returns the normalised path.
 */
export function safeSitePath(to: unknown): string | null {
  if (typeof to !== 'string' || to.length > MAX_PATH_LENGTH) return null;
  return safeReturnPath(to);
}

/**
 * The site path a link points at, or null when it points off the site (or is not a usable URL).
 * Accepts a relative path or an absolute url on this site.
 */
export function sitePathOf(url: string | undefined): string | null {
  if (!url) return null;
  const base = new URL(getBaseUrl());
  let parsed: URL;
  try {
    parsed = new URL(url, base);
  } catch {
    return null;
  }
  if (parsed.origin !== base.origin) return null;
  return safeSitePath(`${parsed.pathname}${parsed.search}${parsed.hash}`);
}

/** What one send is, as every tracked link in it carries it. */
export type EmailLinkContext = {
  sendId: string;
  template: string;
  mailClass: MailClass;
  campaign: string;
  variant: string;
  /** The recipient's user id; 0 when the sender did not say. */
  userId: number;
};

export type EmailClick = EmailLinkContext & {
  /** The link's 1-based place among the email's tracked links. */
  position: number;
  /** A same-site path. */
  to: string;
};

// JSON, so no field can run into the next (a campaign or path may contain any separator).
const clickMessage = (c: EmailClick) =>
  `email-click:${JSON.stringify([
    c.sendId,
    c.template,
    c.mailClass,
    c.campaign,
    c.variant,
    c.userId,
    c.position,
    c.to,
  ])}`;

/** The tracked link for one link. Throws when `to` is not a same-site path. */
export function getEmailClickUrl(click: EmailClick) {
  const to = safeSitePath(click.to);
  if (!to) throw new Error('A tracked email link must point at a site path');
  const signed = { ...click, to };
  const params = new URLSearchParams({
    e: signed.sendId,
    k: signed.template,
    m: signed.mailClass,
    c: signed.campaign,
    v: signed.variant,
    u: String(signed.userId),
    p: String(signed.position),
    to,
    s: signEmailLink(clickMessage(signed)),
  });
  return `${getBaseUrl()}${EMAIL_CLICK_PATH}?${params}`;
}

const intParam = (v: unknown, min: number, max: number) => {
  if (typeof v !== 'string' || !/^\d{1,10}$/.test(v)) return null;
  const n = Number(v);
  return n >= min && n <= max ? n : null;
};
const tagParam = (v: unknown, { required = false } = {}) =>
  typeof v === 'string' && v.length <= MAX_TAG_LENGTH && (!required || v.length > 0) ? v : null;

/** The click a tracked link names, or null when any part of it is missing, malformed or unsigned. */
export function verifyEmailClick(query: Record<string, unknown>): EmailClick | null {
  const sendId = isSendId(query.e) ? query.e : null;
  const template = tagParam(query.k, { required: true });
  const mailClass = MAIL_CLASSES.find((m) => m === query.m) ?? null;
  const campaign = tagParam(query.c);
  const variant = tagParam(query.v);
  const userId = intParam(query.u, 0, MAX_USER_ID);
  const position = intParam(query.p, 1, MAX_POSITION);
  const to = safeSitePath(query.to);
  if (
    sendId === null ||
    template === null ||
    mailClass === null ||
    campaign === null ||
    variant === null ||
    userId === null ||
    position === null ||
    to === null ||
    typeof query.s !== 'string'
  )
    return null;
  // `to` is signed as the link carried it: a link whose path normalises to something else fails.
  if (to !== query.to) return null;
  const click: EmailClick = {
    sendId,
    template,
    mailClass,
    campaign,
    variant,
    userId,
    position,
    to,
  };
  return verifyEmailLinkSignature(clickMessage(click), query.s) ? click : null;
}

const isNeverWrapped = (path: string) => {
  const pathname = path.split(/[?#]/, 1)[0];
  return (NEVER_WRAPPED_PATHS as readonly string[]).includes(pathname);
};

// An opening <a> tag with a double-quoted href. Templates write every href double-quoted; the
// template ledger test fails on any <a> this pattern would not see.
const ANCHOR_HREF = /(<a\b[^>]*?\shref=")([^"]*)(")/gi;

/** Whether every field of `ctx` is one verifyEmailClick accepts, so a link signed with it works. */
function verifiable(ctx: EmailLinkContext) {
  return (
    isSendId(ctx.sendId) &&
    ctx.template.length > 0 &&
    ctx.template.length <= MAX_TAG_LENGTH &&
    ctx.campaign.length <= MAX_TAG_LENGTH &&
    ctx.variant.length <= MAX_TAG_LENGTH &&
    Number.isInteger(ctx.userId) &&
    ctx.userId >= 0 &&
    ctx.userId <= MAX_USER_ID
  );
}

/**
 * `html` with every trackable link rewritten to its tracked link, numbered in document order from
 * `firstPosition` (1 unless the template reserves lower positions for links it tracks itself). A
 * link that cannot be tracked (off the site, `mailto:`, one of NEVER_WRAPPED_PATHS, or too long to
 * sign) is left exactly as it was, and so is every link when the send's own tags would not verify
 * (an overlong campaign, say): an untracked link still works, a tracked one that fails lands on `/`.
 */
export function trackEmailLinks(html: string, ctx: EmailLinkContext, firstPosition = 1): string {
  if (!verifiable(ctx)) return html;
  let position = firstPosition - 1;
  return html.replace(ANCHOR_HREF, (whole, open: string, href: string, close: string) => {
    const tracked = trackedHref(href, ctx, position + 1);
    if (tracked === null) return whole;
    position++;
    return `${open}${escapeHtml(tracked)}${close}`;
  });
}

/**
 * The tracked link for one href as written in an HTML attribute, at `position`, or null when it
 * cannot be tracked (off the site, `mailto:`, one of NEVER_WRAPPED_PATHS, too long to sign, or
 * past the last position). The one rule trackEmailLinks and trackEmailHrefs both apply.
 */
function trackedHref(href: string, ctx: EmailLinkContext, position: number): string | null {
  // As a browser reads an attribute: a legacy entity with no `;` (`&not`, `&reg`) stays literal.
  const to = sitePathOf(decodeHtml(href, { isAttributeValue: true }));
  if (!to || isNeverWrapped(to) || position > MAX_POSITION) return null;
  return getEmailClickUrl({ ...ctx, position, to });
}

/**
 * trackEmailLinks for another app's email (the moderator app signs nothing itself): `hrefs` as
 * written in its HTML attributes, in document order, each returned as its tracked link (not
 * HTML-escaped) or exactly as given, numbered from 1 among the tracked ones. All come back as given
 * when the send's own tags would not verify.
 */
export function trackEmailHrefs(hrefs: readonly string[], ctx: EmailLinkContext): string[] {
  if (!verifiable(ctx)) return [...hrefs];
  let position = 0;
  return hrefs.map((href) => {
    const tracked = trackedHref(href, ctx, position + 1);
    if (tracked === null) return href;
    position++;
    return tracked;
  });
}
