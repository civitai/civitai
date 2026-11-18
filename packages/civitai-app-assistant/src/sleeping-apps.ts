import {
  SandboxApiError,
  SandboxSeedNotAppliedError,
  isRunningLimit,
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
  /** The archive's sha256: a sandbox woken from this record was seeded with it (lineage). */
  sha256: string;
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
/** How many creates one wake tries before it gives up. */
export const WAKE_ATTEMPTS = 3;

export interface WakeResult {
  sandbox: Sandbox;
  created: boolean;
  seed?: SandboxSeedResult;
  /** It had already been woken (elsewhere): it was opened as it is, without a seed. */
  alreadyAwake: boolean;
  /** The archive it was woken from (absent when it was already awake): its lineage. */
  sha256?: string;
}

/**
 * Wakes `app`: a seed (with its one-time ticket) from `getSeed`, then the seeded create.
 *   - `stale_record` / `ticket_invalid`: the record changed or the ticket went; a NEW seed, again.
 *   - `already_exists`: the app was woken elsewhere meanwhile; it is opened as it is.
 * Every other refusal (a cap, `secrets_unavailable`, `civitai_auth`, a seed the service refused)
 * is thrown as it came, for {@link wakeOnlyFailure} to word: the user tries again themselves.
 * At the kept-app cap the service puts the least recently used app to sleep by itself; nothing
 * here decides that.
 */
export async function wakeSleepingApp(
  client: SandboxClient,
  app: string,
  getSeed: (app: string) => Promise<WakeSeed>
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
        sha256,
      };
    } catch (error) {
      last = error;
      const code = error instanceof SandboxApiError ? error.code : null;
      if (code === 'already_exists') return { ...(await openApp(client, app)), alreadyAwake: true };
      if (code && NEW_SEED_CODES.has(code)) seed = null;
      else throw error;
    }
  }
  throw last;
}

/** What {@link startOrWakeApp} starts an app with: the page's and the runner's own. */
export interface StartOrWakeDeps {
  /** A plain (unseeded) open: finds, creates or resumes the app's sandbox (`openApp`). */
  open(app: string): Promise<{ sandbox: Sandbox; created: boolean }>;
  /** Deletes a sandbox: only ever the new, EMPTY one a plain open just made. */
  remove(name: string): Promise<unknown>;
  /** Wakes the app from its sleeping record ({@link wakeSleepingApp}). */
  wake(app: string): Promise<WakeResult>;
  /**
   * Whether `app` has a sleeping record. `fresh`: asked right after a plain open made a new
   * sandbox, so a caller that can read the records again cheaply does (the page); one whose reads
   * are rate-limited answers from the read it has (the runner). Unknown is `false`.
   */
  hasRecord(app: string, opts: { fresh: boolean }): Promise<boolean> | boolean;
}

/**
 * APP HIBERNATE — THE ONE START of an app, on the page (every start: the menu, a pick, an export,
 * a submit, a message sent to a paused app, a reply asked for again) and on the runner (a reply's
 * start, create_app's resume). An app is never made NEW and EMPTY while its real one sleeps:
 *   - LISTED (it has a sandbox, as last listed): a PLAIN open, which resumes it as it is, even
 *     when it has a sleeping record (kept after a wake, as its lineage): no seed, no wake quota.
 *     Only when that open had to CREATE (the sandbox went since it was listed: put to sleep
 *     meanwhile) and a record exists is the empty sandbox it made deleted and the app woken.
 *   - NOT LISTED with a record: woken.
 *   - Otherwise a plain open (a new app).
 * A wake that finds no record any more (`not_found`, deleted meanwhile) is a plain open.
 */
export async function startOrWakeApp(
  app: string,
  listed: boolean,
  deps: StartOrWakeDeps
): Promise<{ sandbox: Sandbox; created: boolean }> {
  if (listed) {
    const opened = await deps.open(app);
    if (!opened.created || !(await deps.hasRecord(app, { fresh: true }))) return opened;
    await deps.remove(opened.sandbox.name);
    return wakeOrOpen(app, deps);
  }
  if (!(await deps.hasRecord(app, { fresh: false }))) return deps.open(app);
  return wakeOrOpen(app, deps);
}

async function wakeOrOpen(
  app: string,
  deps: StartOrWakeDeps
): Promise<{ sandbox: Sandbox; created: boolean }> {
  try {
    const woken = await deps.wake(app);
    return { sandbox: woken.sandbox, created: false };
  } catch (error) {
    if (error instanceof WakeSeedError && error.code === 'not_found') return deps.open(app);
    throw error;
  }
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

// The chat shows the user these too (a tool's error), so they are written for them: no tool
// names, ids or service wording. Never parsed back: the card is carried as `limitCard`.
const CONTINUES = 'in the card under the chat; your request then continues automatically.';
export const sleepingLimitMessage = (oldest: string | null) =>
  oldest
    ? `You have as many sleeping apps as you can keep. Delete ${oldest}, your oldest sleeping app, ${CONTINUES}`
    : SLEEPING_FULL;
/** At the sleeping-app limit with no app safe to offer: the user picks one to delete themselves. */
export const SLEEPING_FULL =
  'You have as many sleeping apps as you can keep. Delete a sleeping app you no longer need from the app switcher at the top of the page, then ask again.';
export const keptAppsMessage = (kept: readonly KeptApp[]) =>
  `You already have as many apps as you can keep, and ${kept
    .map((k) => `${k.app} (${keptReason(k.reason)})`)
    .join(', ')} cannot be put to sleep to make room. Choose one to delete ${CONTINUES}`;
/**
 * The card a cap refusal asks the page for: `keep` (pick a kept app to delete) or `sleeping` (the
 * sleeping apps are at their limit: offer to delete the `oldest`, once the user confirms; `null`
 * when the one civitai named is not safe to offer, see {@link safeOldest}).
 */
export type LimitCard = { kind: 'keep' } | { kind: 'sleeping'; oldest: string | null };

/** What is being opened or woken, and the apps awake now: never offered for deletion. */
export interface OfferContext {
  /** The app the refused open or wake was for. */
  app?: string | null;
  /** Every app with a live sandbox now. */
  live?: readonly string[];
  /**
   * The apps or the sleeping apps could not be read (the runner's list past its rate limit, or a
   * list not loaded yet): what is safe to offer is unknown, so NOTHING is offered (fail closed).
   */
  unknown?: boolean;
}

/**
 * 🔴 The oldest sleeping app a limit refusal names, ONLY when deleting it cannot delete what the
 * user is working on. civitai keeps a woken app's record (its sandbox's lineage), so the oldest
 * record can be the very app being woken, or any app awake now: deleting that record deletes its
 * archive, and the wake retried after it finds nothing. Such an `oldest` is `null`: the user is
 * told to delete a sleeping app themselves.
 */
export function safeOldest(oldest: string | null, ctx: OfferContext = {}): string | null {
  if (!oldest || ctx.unknown || oldest === ctx.app || ctx.live?.includes(oldest)) return null;
  return oldest;
}

/** The card for an open's or a wake's refusal at a cap, or `null` for any other failure. */
export function limitCardOfError(error: unknown, ctx: OfferContext = {}): LimitCard | null {
  if (error instanceof SandboxApiError && error.code === 'sleeping_limit')
    return { kind: 'sleeping', oldest: safeOldest(sleepingLimitOldestOf(error), ctx) };
  if (error instanceof SandboxApiError && error.kind === 'limit' && !isRunningLimit(error))
    return { kind: 'keep' };
  return null;
}

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
  if (error.code === 'secrets_unavailable') return WAKE_SECRETS_UNAVAILABLE;
  // civitai_auth, ticket_required, secrets_refused, secrets_invalid: nothing the user can fix.
  if (/^(civitai_|ticket_|secrets_)/.test(error.code)) return WAKE_UNAVAILABLE;
  if (error.code.startsWith('seed_')) return WAKE_RESTORE_FAILED;
  return null;
}
