import {
  SandboxApiError,
  SandboxSeedNotAppliedError,
  openApp,
  type Sandbox,
  type SandboxClient,
  type SandboxSeed,
  type SandboxSeedResult,
} from './sandbox-client';

/**
 * APP HIBERNATE, as both runners and the page see it. A kept app that went unused (or was the
 * least recently used one when the user needed room) is put to SLEEP: its files are archived by
 * civitai and its sandbox removed. A sleeping app is woken by a seeded create of the same app key
 * (`openApp(client, app, seed)`), the seed carrying civitai's one-time wake `ticket`, so the app's
 * key, and with it its chat on this browser, is unchanged.
 */

/** A sleeping app as civitai lists it to its own user. */
export interface SleepingApp {
  app: string;
  bytes: number;
  lastActivityAt: string | null;
  hibernatedAt: string;
}

/** What civitai hands a wake: the archive's presigned GET, its sha256 and size, and the ticket. */
export interface WakeSeed extends SandboxSeed {
  ticket: string;
}

/**
 * The sleeping apps to show beside the live ones: a LIVE sandbox always wins over a record of the
 * same app key (civitai keeps the record after a wake, until the next sleep replaces it).
 */
export function sleepingNotLive(
  live: readonly Pick<Sandbox, 'app'>[],
  sleeping: readonly SleepingApp[]
): SleepingApp[] {
  const awake = new Set(live.map((s) => s.app));
  return sleeping.filter((s) => !awake.has(s.app));
}

/** Why civitai gave no seed: `changed` (ask again), `not_found`, or none to be had right now. */
export type WakeSeedErrorCode = 'not_found' | 'changed' | 'unavailable';

export class WakeSeedError extends Error {
  constructor(message: string, readonly code: WakeSeedErrorCode) {
    super(message);
    this.name = 'WakeSeedError';
  }
}

/** The sandbox service's answers that mean "fetch a new seed and ticket, then try again". */
const NEW_SEED_CODES = new Set(['stale_record', 'ticket_invalid']);
/** …and "the same seed again, in a moment": civitai could not return the secrets just now. */
const SAME_SEED_CODES = new Set(['secrets_unavailable']);
/** How many creates one wake tries before it gives up. */
export const WAKE_ATTEMPTS = 3;
const SECRETS_RETRY_MS = 1_500;

export interface WakeResult {
  sandbox: Sandbox;
  created: boolean;
  seed?: SandboxSeedResult;
  /** It had already been woken (elsewhere): it was opened as it is, without a seed. */
  alreadyAwake: boolean;
}

/**
 * Wakes `app`: a seed (with its one-time ticket) from `getSeed`, then the seeded create.
 *   - `stale_record` / `ticket_invalid`: the record changed or the ticket went; a NEW seed, again.
 *   - `secrets_unavailable`: civitai could not answer the secrets; the same seed, after a pause.
 *   - `already_exists`: the app was woken elsewhere meanwhile; it is opened as it is.
 * Every other refusal (a cap, `civitai_auth`, a seed the service refused) is thrown as it came,
 * for {@link wakeFailure} to word. At the kept-app cap the service puts the least recently used
 * app to sleep by itself; nothing here decides that.
 */
export async function wakeSleepingApp(
  client: SandboxClient,
  app: string,
  getSeed: (app: string) => Promise<WakeSeed>,
  { pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) } = {}
): Promise<WakeResult> {
  let seed: WakeSeed | null = null;
  let last: unknown = null;
  for (let attempt = 0; attempt < WAKE_ATTEMPTS; attempt++) {
    seed ??= await getSeed(app);
    // Only the seed's own fields: civitai's answer also names the app and when it expires.
    const { url, sha256, bytes, ticket } = seed;
    try {
      return {
        ...(await openApp(client, app, { url, sha256, bytes, ticket })),
        alreadyAwake: false,
      };
    } catch (error) {
      last = error;
      const code = error instanceof SandboxApiError ? error.code : null;
      if (code === 'already_exists') return { ...(await openApp(client, app)), alreadyAwake: true };
      if (code && NEW_SEED_CODES.has(code)) seed = null;
      else if (code && SAME_SEED_CODES.has(code)) await pause(SECRETS_RETRY_MS * (attempt + 1));
      else throw error;
    }
  }
  throw last;
}

/** A kept app the service could not put to sleep, and why (`kept_apps`). */
export interface KeptApp {
  app: string;
  reason: string;
}

const KEPT_REASONS: Record<string, string> = {
  archive_too_large: 'too large to put to sleep',
  archive_unarchivable_name: 'has a file name that cannot be saved',
  archive_app_missing: 'has no app folder to save',
  archive_empty: 'has nothing to save',
};

/** Why a kept app cannot sleep, in the user's words. */
export const keptReason = (reason: string) => KEPT_REASONS[reason] ?? 'cannot be saved right now';

/** The kept apps a `kept_apps` refusal names; `null` when it is not one. */
export function keptAppsOf(error: unknown): KeptApp[] | null {
  if (!(error instanceof SandboxApiError) || error.code !== 'kept_apps') return null;
  const kept = error.details?.kept;
  if (!Array.isArray(kept)) return null;
  const out: KeptApp[] = [];
  for (const k of kept) {
    const app = (k as { app?: unknown } | null)?.app;
    const reason = (k as { reason?: unknown } | null)?.reason;
    if (typeof app === 'string' && app && typeof reason === 'string') out.push({ app, reason });
  }
  return out.length > 0 ? out : null;
}

/** The oldest sleeping app a `sleeping_limit` refusal names; `null` when it is not one. */
export function sleepingLimitOldestOf(error: unknown): string | null {
  if (!(error instanceof SandboxApiError) || error.code !== 'sleeping_limit') return null;
  const app = (error.details?.oldest as { app?: unknown } | null | undefined)?.app;
  return typeof app === 'string' && app ? app : null;
}

// The chat shows the user these too (a tool's thrown error), so they are written for them:
// no tool names, ids or service wording.
const CONTINUES = 'in the card under the chat; your request then continues automatically.';
export const sleepingLimitMessage = (oldest: string) =>
  `You have as many sleeping apps as you can keep. Delete ${oldest}, your oldest sleeping app, ${CONTINUES}`;
export const keptAppsMessage = (kept: readonly KeptApp[]) =>
  `You already have as many apps as you can keep, and ${kept
    .map((k) => `${k.app} (${keptReason(k.reason)})`)
    .join(', ')} cannot be put to sleep to make room. Choose one to delete ${CONTINUES}`;
const SLEEPING_LIMIT_MESSAGE = new RegExp(
  `^You have as many sleeping apps as you can keep\\. Delete ([a-z][a-z0-9-]*[a-z0-9]), your oldest sleeping app, ${escapeRegExp(
    CONTINUES
  )}$`
);
const KEPT_APPS_MESSAGE = new RegExp(
  `^You already have as many apps as you can keep, and .+ cannot be put to sleep to make room\\. Choose one to delete ${escapeRegExp(
    CONTINUES
  )}$`
);
function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The oldest app named by a {@link sleepingLimitMessage}, or `null`. */
export const sleepingLimitMessageOldest = (message: string) =>
  SLEEPING_LIMIT_MESSAGE.exec(message)?.[1] ?? null;
/** Whether `message` is a {@link keptAppsMessage}. */
export const isKeptAppsMessage = (message: string) => KEPT_APPS_MESSAGE.test(message);

export const WAKE_CHANGING =
  'The app was changing at the same moment, so it was not woken. Try again.';
export const WAKE_SECRETS_UNAVAILABLE =
  'The app’s saved settings could not be fetched just now, so it was not woken. Try again in a moment.';
export const WAKE_UNAVAILABLE = 'Waking apps is unavailable right now. Try again later.';
export const WAKE_NOT_FOUND = 'There is no sleeping app by that name any more.';
export const WAKE_RESTORE_FAILED =
  'The app’s saved copy could not be restored, so it was not woken. Try again in a moment.';

/**
 * What the user may read about a failed wake, or `null` for a failure any open can have (a cap,
 * the running app, a concurrent change, the service unreachable), which the caller words as it
 * words an open's.
 */
export function wakeOnlyFailure(error: unknown): string | null {
  if (error instanceof WakeSeedError)
    return error.code === 'not_found'
      ? WAKE_NOT_FOUND
      : error.code === 'changed'
      ? WAKE_CHANGING
      : WAKE_UNAVAILABLE;
  if (error instanceof SandboxSeedNotAppliedError) return WAKE_RESTORE_FAILED;
  if (!(error instanceof SandboxApiError) || !error.code) return null;
  if (NEW_SEED_CODES.has(error.code)) return WAKE_CHANGING;
  if (SAME_SEED_CODES.has(error.code)) return WAKE_SECRETS_UNAVAILABLE;
  // civitai_auth, ticket_required, secrets_refused, secrets_invalid: nothing the user can fix.
  if (/^(civitai_|ticket_|secrets_)/.test(error.code)) return WAKE_UNAVAILABLE;
  if (error.code.startsWith('seed_')) return WAKE_RESTORE_FAILED;
  return null;
}
