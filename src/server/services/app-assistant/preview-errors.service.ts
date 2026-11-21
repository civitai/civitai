import * as z from 'zod';
import {
  APP_ACTIVITY_WINDOW_MS,
  PREVIEW_ERROR_SOURCES,
  errorCount,
  foldErrors,
  sameError,
  type ErrorActivity,
  type PreviewErrorSource,
} from '@civitai/app-assistant';
import { decodeRedisString } from '~/server/redis/buffer-decode';
import { REDIS_KEYS, redis } from '~/server/redis/client';
import { getActiveDevTunnel } from '~/server/services/blocks/dev-tunnel.service';
import { boundedClusterCall as bounded } from '~/server/utils/cluster-window-count';

/**
 * The errors an app's own code reported in its LIVE DEV PREVIEW, kept for App Assistant's
 * app-activity read (`app-activity.service.ts`) and nothing else.
 *
 * Written only by the dev-tunnel host (`DevTunnelBlockHost` → `POST /api/apps/dev/preview-errors`),
 * and only while the caller has a live dev tunnel of that app (`getActiveDevTunnel`, which is
 * keyed by user and checks the session is theirs): a production block has no dev tunnel, so
 * nothing it posts is kept. Stored per (user, app) as a capped list, newest first, with a 2 h TTL.
 *
 * The same error repeated back to back (`sameError`: a loop) is ONE entry with a count and its first
 * and last times, folded as it is written: at the SDK's 20 a minute, unfolded repeats filled the list
 * in about ten minutes and pushed out the first error, usually the root cause.
 *
 * The text is the app's own output, so it is redacted (anything token- or key-shaped) and capped
 * again here; the client's caps are not trusted.
 */

/** Entries kept per (user, app), newest first. */
export const PREVIEW_ERRORS_MAX_ENTRIES = 200;
/** How long the list lives after its last write, in seconds: the activity read's window. */
export const PREVIEW_ERRORS_TTL_SECONDS = APP_ACTIVITY_WINDOW_MS / 1000;
/** Reports one POST may carry. */
export const PREVIEW_ERRORS_BATCH_MAX = 20;
export const PREVIEW_ERROR_MESSAGE_MAX = 2_000;
export const PREVIEW_ERROR_STACK_MAX = 4_000;

/** The SDK's `BLOCK_ERROR` contract; every field but `message` is optional (older SDKs). */
export const previewErrorReportSchema = z.object({
  message: z.string().min(1).max(20_000),
  fatal: z.boolean().optional(),
  source: z.string().max(40).optional(),
  stack: z.string().max(40_000).optional(),
  at: z.number().optional(),
});
export type PreviewErrorReport = z.infer<typeof previewErrorReportSchema>;

export const REDACTED = '[redacted]';

/**
 * Removes what looks like a credential from text an app reported: JWTs, `Bearer <token>`,
 * `sk-`-style API keys, and the value of a token-like query parameter (`?token=`, `?dev=`, …).
 * Shape-based, so it also catches a credential the app was never meant to hold.
 */
export function redactSecrets(text: string): string {
  return (
    text
      // A JWT: three base64url segments, the first a JSON header (`eyJ`).
      .replace(/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g, REDACTED)
      // `Bearer <token>` in a header echoed into an error.
      .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`)
      // `sk-…`, `sk_live_…`, `pk_test_…`, `rk-…` style API keys.
      .replace(/\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{16,}/g, REDACTED)
      // A credential in a URL's query: the dev tunnel's own entry token travels as `?dev=`.
      .replace(
        /([?&](?:token|access_token|id_token|refresh_token|api_key|apikey|key|secret|password|dev|auth)=)[^&#\s"'<>]+/gi,
        `$1${REDACTED}`
      )
  );
}

const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max)}… (cut)`;

/** What a direct preview's session host is replaced with in what is kept. */
const PREVIEW_HOST_PLACEHOLDER = '[preview]';

/**
 * The shortest piece of a session label, cut at the end of a report, that is still taken for it:
 * 8 base32 characters (40 bits) never match by chance.
 */
const MIN_CUT_LABEL = 8;

/**
 * `text` with `host` (any case) replaced by the placeholder. The host's first label alone is the
 * credential, so the match is on the label, with whatever of the domain follows it. The SDK caps a
 * report's message and stack by cutting their END, which can fall inside the label: a trailing
 * start of the label (at least `MIN_CUT_LABEL` characters) is replaced too.
 */
function hideHost(text: string, host: string | null): string {
  const label = host?.split('.')[0]?.toLowerCase();
  if (!label) return text;
  const escape = (part: string) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`${escape(label)}(?:\\.[a-z0-9-]+)*`, 'gi');
  const hidden = text.replace(pattern, PREVIEW_HOST_PLACEHOLDER);
  const tail = hidden.toLowerCase();
  for (let cut = label.length - 1; cut >= MIN_CUT_LABEL; cut--)
    if (tail.endsWith(label.slice(0, cut)))
      return hidden.slice(0, hidden.length - cut) + PREVIEW_HOST_PLACEHOLDER;
  return hidden;
}

/**
 * A report as stored: redacted, capped, its time clamped into the window ending now. `hiddenHost`:
 * a direct preview's session host, a bearer credential the app's own URLs and stack traces name; it
 * is replaced before anything is kept.
 */
export function sanitizePreviewError(
  report: PreviewErrorReport,
  now: number,
  hiddenHost: string | null = null
): ErrorActivity {
  const source: PreviewErrorSource = (PREVIEW_ERROR_SOURCES as readonly string[]).includes(
    report.source ?? ''
  )
    ? (report.source as PreviewErrorSource)
    : 'reported';
  const earliest = now - APP_ACTIVITY_WINDOW_MS;
  const at =
    report.at === undefined || !Number.isFinite(report.at)
      ? now
      : Math.min(now, Math.max(earliest, report.at));
  return {
    kind: 'error',
    at: new Date(at).toISOString(),
    source,
    fatal: report.fatal === true,
    message: clip(redactSecrets(hideHost(report.message, hiddenHost)), PREVIEW_ERROR_MESSAGE_MAX),
    stack: report.stack
      ? clip(redactSecrets(hideHost(report.stack, hiddenHost)), PREVIEW_ERROR_STACK_MAX)
      : null,
  };
}

export function previewErrorsKey(userId: number, blockId: string) {
  return `${REDIS_KEYS.BLOCKS.DEV_PREVIEW_ERRORS}:${userId}:${blockId}` as const;
}

/** Back-to-back repeats in `entries` (oldest first) folded into one entry each. */
function foldRepeats(entries: ErrorActivity[]): ErrorActivity[] {
  const out: ErrorActivity[] = [];
  for (const entry of entries) {
    const last = out[out.length - 1];
    if (last && sameError(last, entry)) out[out.length - 1] = foldErrors(last, entry);
    else out.push(entry);
  }
  return out;
}

/**
 * Keeps `reports` for the caller's live dev preview of `blockId`. `not-found` (nothing written)
 * when the caller has no live dev tunnel of that app: not theirs, not a dev session, or gone.
 */
export async function storePreviewErrors({
  userId,
  blockId,
  reports,
  now = Date.now(),
}: {
  userId: number;
  blockId: string;
  reports: PreviewErrorReport[];
  now?: number;
}): Promise<{ status: 'stored'; stored: number } | { status: 'not-found' }> {
  const tunnel = await getActiveDevTunnel(userId, blockId);
  if (!tunnel) return { status: 'not-found' };
  const hiddenHost = tunnel.transport === 'direct' ? tunnel.host : null;
  const entries = foldRepeats(
    reports
      .slice(0, PREVIEW_ERRORS_BATCH_MAX)
      .map((report) => sanitizePreviewError(report, now, hiddenHost))
      // Oldest pushed first, so the newest ends up at the head of the list.
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  );
  if (entries.length === 0) return { status: 'stored', stored: 0 };
  const key = previewErrorsKey(userId, blockId);

  // The oldest of this batch repeats the newest kept entry: that entry is replaced by the fold.
  const [headRaw] =
    (await bounded('storePreviewErrors', () => redis.lRange<string | Buffer>(key, 0, 0))) ?? [];
  const head = headRaw === undefined ? null : parseStored(headRaw);
  const replacesHead = !!head && sameError(head, entries[0]!);
  if (head && replacesHead) entries[0] = foldErrors(head, entries[0]!);

  const pipeline = redis.multi();
  if (replacesHead) pipeline.lPopCount(key, 1);
  pipeline.lPush(
    key,
    entries.map((entry) => JSON.stringify(entry))
  );
  pipeline.lTrim(key, 0, PREVIEW_ERRORS_MAX_ENTRIES - 1);
  pipeline.expire(key, PREVIEW_ERRORS_TTL_SECONDS);
  const replies: unknown = await bounded('storePreviewErrors', () => pipeline.exec());

  // Another write pushed between the read and the replace, so the pop took ITS entry: it goes back
  // (readers order by time, so its place in the list does not matter). The entry this meant to
  // replace then stays beside its fold, its count read twice until it ages out: rarer, and cheaper,
  // than losing an entry.
  if (replacesHead) {
    const popped: unknown = Array.isArray(replies) ? replies[0] : undefined;
    const kept = decodeRedisString(headRaw);
    const others = (Array.isArray(popped) ? popped : [])
      .map((raw: unknown) =>
        typeof raw === 'string' || Buffer.isBuffer(raw) ? decodeRedisString(raw) : null
      )
      .filter((raw): raw is string => typeof raw === 'string' && raw !== kept);
    if (others.length > 0) {
      const putBack = redis.multi();
      putBack.lPush(key, others);
      putBack.expire(key, PREVIEW_ERRORS_TTL_SECONDS);
      await bounded('storePreviewErrors', () => putBack.exec());
    }
  }
  return { status: 'stored', stored: entries.length };
}

/** A stored entry, or null when it does not read as one (never trusted to be well-formed). */
function parseStored(raw: string | Buffer): ErrorActivity | null {
  const text = decodeRedisString(raw);
  if (typeof text !== 'string') return null;
  try {
    const value = JSON.parse(text) as Partial<ErrorActivity>;
    if (typeof value.message !== 'string' || typeof value.at !== 'string') return null;
    const count = typeof value.count === 'number' ? errorCount(value as ErrorActivity) : 1;
    return {
      kind: 'error',
      at: value.at,
      ...(count > 1
        ? {
            ...(typeof value.firstAt === 'string' ? { firstAt: value.firstAt } : {}),
            count,
          }
        : {}),
      source: (PREVIEW_ERROR_SOURCES as readonly string[]).includes(value.source ?? '')
        ? (value.source as PreviewErrorSource)
        : 'reported',
      fatal: value.fatal === true,
      message: value.message,
      stack: typeof value.stack === 'string' ? value.stack : null,
    };
  } catch {
    return null;
  }
}

/** The errors kept for this user's preview of `blockId`, newest first. */
export async function readPreviewErrors({
  userId,
  blockId,
}: {
  userId: number;
  blockId: string;
}): Promise<ErrorActivity[]> {
  const raw = await bounded('readPreviewErrors', () =>
    redis.lRange<string | Buffer>(
      previewErrorsKey(userId, blockId),
      0,
      PREVIEW_ERRORS_MAX_ENTRIES - 1
    )
  );
  return (raw ?? []).map(parseStored).filter((entry): entry is ErrorActivity => entry !== null);
}
