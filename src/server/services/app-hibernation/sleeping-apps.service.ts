import {
  WAKE_TICKET_TTL_SECONDS,
  mintWakeTicket,
  type HibernationDeps,
} from '~/server/services/app-hibernation/app-hibernation.service';
import type { HibernationRow } from '~/server/services/app-hibernation/hibernation.repo';

/**
 * APP HIBERNATE — what the signed-in user does with their OWN sleeping apps: list them, wake one
 * (the seed the sandbox service restores from, with a one-time wake ticket), delete one. Every
 * function acts on the `userId` its caller passes, which must be the signed-in user's own id: the
 * page's tRPC procedures (`app-hibernation.router.ts`) and the server runner's routes
 * (`sleeping-apps-route.ts`, the user its run grant names). The `app-hibernate` flag is checked by
 * those callers; {@link getWakeSeed} also checks it again through {@link mintWakeTicket}.
 */

/** A sleeping app as the user's own clients see it: never an object key, hash of secrets or key. */
export type SleepingApp = {
  app: string;
  bytes: number;
  appCreatedAt: string | null;
  lastActivityAt: string | null;
  hibernatedAt: string;
};

const iso = (d: Date | null) => (d ? d.toISOString() : null);

const toSleepingApp = (row: HibernationRow): SleepingApp => ({
  app: row.appKey,
  bytes: row.bytes,
  appCreatedAt: iso(row.appCreatedAt),
  lastActivityAt: iso(row.lastActivityAt),
  hibernatedAt: row.hibernatedAt.toISOString(),
});

/** The user's sleeping apps, most recently put to sleep first. */
export async function listSleepingApps(
  userId: number,
  deps: Pick<HibernationDeps, 'repo'>
): Promise<SleepingApp[]> {
  return (await deps.repo.list(userId)).map(toSleepingApp);
}

/**
 * What a wake sends the sandbox service as its seed: a presigned GET of the archive, its sha256
 * and size, and the one-time `ticket` the sandbox service redeems for the app's `.env*` files.
 * The URL and the ticket expire together.
 */
export type WakeSeed = {
  app: string;
  url: string;
  sha256: string;
  bytes: number;
  ticket: string;
  expiresAt: string;
};

export type WakeSeedResult =
  | { kind: 'disabled' }
  | { kind: 'not-configured' }
  | { kind: 'account-closed' }
  | { kind: 'not-found' }
  /** The record changed on every try (a commit landing at the same moment): ask again. */
  | { kind: 'changed' }
  | { kind: 'ok'; seed: WakeSeed };

/** A ticket and the row it was minted for can disagree only if a commit lands in between. */
const WAKE_SEED_TRIES = 2;

/**
 * The seed for waking one of the user's sleeping apps. The ticket is minted HERE only (and by the
 * runner route, for the run's own user): {@link mintWakeTicket} binds it to the record's sha256, and
 * the presigned GET is of that same record, so the sandbox service's download check and its
 * secrets redemption agree on one archive. A commit landing between the two reads is retried once,
 * then answered `changed`.
 */
export async function getWakeSeed(
  userId: number,
  app: string,
  deps: HibernationDeps
): Promise<WakeSeedResult> {
  // No public endpoint, no seed: nothing is minted for a wake that could never download.
  if (!deps.store?.canPresign || !deps.masterKeys) return { kind: 'not-configured' };
  const store = deps.store;
  for (let i = 0; i < WAKE_SEED_TRIES; i++) {
    const minted = await mintWakeTicket(userId, app, deps);
    if (minted.kind !== 'ok') return minted;
    const row = await deps.repo.get(userId, app);
    if (!row) return { kind: 'not-found' };
    if (row.sha256 !== minted.sha256) continue;
    return {
      kind: 'ok',
      seed: {
        app,
        url: await store.presignGet(row.objectKey, WAKE_TICKET_TTL_SECONDS),
        sha256: row.sha256,
        bytes: row.bytes,
        ticket: minted.ticket,
        expiresAt: minted.expiresAt,
      },
    };
  }
  return { kind: 'changed' };
}

export type DeleteSleepingAppResult = { kind: 'not-found' } | { kind: 'deleted'; app: string };

/**
 * Deletes one sleeping app for good: its row (under the per-user lock commits take), then its
 * archive and secrets objects. A failed object delete is reported and left to the orphan sweep: no
 * row references the objects any more, so the sweep removes them.
 */
export async function deleteSleepingApp(
  userId: number,
  app: string,
  deps: Pick<HibernationDeps, 'repo' | 'store' | 'report'>,
  why: 'user' | 'limit' = 'user'
): Promise<DeleteSleepingAppResult> {
  const row = await deps.repo.remove(userId, app);
  if (!row) return { kind: 'not-found' };
  const keys = [row.objectKey, row.secretsObjectKey].filter((k): k is string => !!k);
  deps.report('app-hibernation.deleted', { userId, app, why });
  if (deps.store) {
    try {
      await deps.store.deleteMany(keys);
    } catch (err) {
      deps.report('app-hibernation.delete-objects-failed', {
        userId,
        app,
        keys,
        error: (err as Error)?.message,
      });
    }
  }
  return { kind: 'deleted', app };
}
