import { createHash, randomBytes } from 'node:crypto';
import * as z from 'zod';
import { isAppBlockId } from '@civitai/app-assistant';
import type { SessionUser } from '~/types/session';
import type { ArchiveStore } from '~/utils/app-archive-s3';
import {
  ARCHIVE_PREFIX,
  ARCHIVE_PUT_TTL_SECONDS,
  ArchiveObjectTooLarge,
  archiveObjectKeys,
  userArchivePrefix,
} from '~/utils/app-archive-s3';
import type { SleepingAppLimits } from '~/server/services/blocks/user-app-caps.service';
import type {
  HibernationRepo,
  HibernationRow,
} from '~/server/services/app-hibernation/hibernation.repo';
import {
  newDataKey,
  openSecrets,
  unwrapDataKey,
  wrapDataKey,
  type MasterKeyring,
} from '~/server/services/app-hibernation/secrets-envelope';

/**
 * APP HIBERNATE — civitai's half of "Sleeping" apps. The sandbox service archives an app it is
 * about to remove (at the kept-app cap, on the idle expiry, or on the user's request) and asks
 * civitai to keep the archive:
 *
 *   begin   civitai checks the flag, the account and the user's plan limit, builds the object keys
 *           itself, and answers presigned PUTs for the archive and the encrypted `.env*` blob, plus
 *           a fresh data key for that blob (its wrapped copy stays with civitai).
 *   commit  civitai COPIES the uploads to keys no presigned URL ever named, verifies the copies
 *           (size, a capped re-hash; the secrets blob must also decrypt), checks the account and
 *           lineage, upserts the user's row for the app, and only then deletes what the new row
 *           superseded and the uploads. Every refusal deletes that attempt's objects. Its
 *           `{ committed: true }` answer is the sandbox service's receipt: it removes the sandbox
 *           only after holding one.
 *   secrets the wake's restore step: the decrypted `.env*` blob, released only against a one-time
 *           WAKE TICKET that civitai minted for a wake the user started ({@link mintWakeTicket}).
 *
 * Listing, waking and deleting sleeping apps from the UI come with the UI.
 *
 * Nothing here ever deletes a sleeping app to make room: at the plan limit `begin` (and `commit`,
 * for bytes) refuses, naming the user's oldest sleeping app so the user can be asked whether to
 * delete it, and the sandbox service keeps the app as it is until they answer.
 */

/** The largest archive kept: the sandbox service's seed limit, so every archive can be woken. */
export const MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;
/** The largest encrypted `.env*` blob kept. */
export const MAX_SECRETS_BYTES = 1024 * 1024;
/** How long a `begin` is remembered for its `commit` (and for a retried commit). */
export const ATTEMPT_TTL_SECONDS = 24 * 60 * 60;
/** How long a wake ticket can be redeemed for the secrets, once. */
export const WAKE_TICKET_TTL_SECONDS = 10 * 60;
/**
 * An archive object no row references is swept once it is this old. Longer than an attempt lives
 * ({@link ATTEMPT_TTL_SECONDS}), so no commit can still be about to record it.
 */
export const ORPHAN_MIN_AGE_MS = 24 * 60 * 60 * 1000;

export const HIBERNATION_REASONS = ['cap', 'retention', 'user'] as const;

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
export const hibernationAppKey = z.string().refine(isAppBlockId, 'not an app key');

export const beginInput = z.object({
  userId: z.number().int().positive(),
  app: hibernationAppKey,
  attemptId: z.uuid(),
  reason: z.enum(HIBERNATION_REASONS).optional(),
});
export type BeginInput = z.infer<typeof beginInput>;

export const commitInput = z.object({
  attemptId: z.uuid(),
  sha256: sha256Hex,
  bytes: z.number().int().positive().max(MAX_ARCHIVE_BYTES),
  excluded: z.array(z.string().max(512)).max(500).default([]),
  lastActivityAt: z.iso.datetime({ offset: true }).nullish(),
  createdAt: z.iso.datetime({ offset: true }).nullish(),
  /** The seed sha the sandbox was created from (`null` for an app that was never woken). */
  sandboxSeedSha: sha256Hex.nullish(),
  secrets: z
    .object({ sha256: sha256Hex, bytes: z.number().int().positive().max(MAX_SECRETS_BYTES) })
    .optional(),
});
export type CommitInput = z.infer<typeof commitInput>;

export const restoreSecretsInput = z.object({
  userId: z.number().int().positive(),
  app: hibernationAppKey,
  /** The archive sha the sandbox was just seeded from: secrets come only from that record. */
  sha256: sha256Hex,
  /** The one-time wake ticket civitai minted for this wake. */
  ticket: z.string().min(16).max(128),
});
export type RestoreSecretsInput = z.infer<typeof restoreSecretsInput>;

/** What `begin` remembers for `commit`. The data key is stored only wrapped. */
export type AttemptRecord = {
  userId: number;
  appKey: string;
  attemptId: string;
  reason: (typeof HIBERNATION_REASONS)[number] | null;
  archiveKey: string;
  secretsKey: string;
  wrappedKey: string;
};

export interface AttemptStore {
  /** Records `rec` unless the attempt exists; answers the stored record either way. */
  claim(rec: AttemptRecord, ttlSeconds: number): Promise<AttemptRecord>;
  get(attemptId: string): Promise<AttemptRecord | null>;
}

/** What a wake ticket releases: one app's secrets, for one archive, for one user. */
export type WakeTicketRecord = { userId: number; app: string; sha256: string };

/** Keyed by the ticket's sha256, so the store never holds a redeemable ticket. */
export interface WakeTicketStore {
  put(ticketHash: string, rec: WakeTicketRecord, ttlSeconds: number): Promise<void>;
  /** Atomically reads AND deletes: a ticket is redeemable once. */
  take(ticketHash: string): Promise<WakeTicketRecord | null>;
}

export type HibernationDeps = {
  repo: HibernationRepo;
  attempts: AttemptStore;
  tickets: WakeTicketStore;
  /** `null` when this environment has no archive store. */
  store: ArchiveStore | null;
  /** `null` when the master keys are unset or malformed. */
  masterKeys: MasterKeyring | null;
  getUser: (userId: number) => Promise<SessionUser | null>;
  isEnabled: (user: SessionUser) => Promise<boolean>;
  limits: (userId: number) => Promise<SleepingAppLimits>;
  now: () => Date;
  /** Best-effort reporting: a step that failed after the outcome was settled, and each release. */
  report: (event: string, details: Record<string, unknown>) => void;
};

export type SleepingLimitRefusal = {
  kind: 'apps' | 'bytes';
  limit: number;
  used: number;
};

/**
 * The sleeping app a limit refusal offers to delete: the user's oldest (earliest hibernated).
 * Only its name and when it went to sleep; nothing is deleted until the user confirms.
 */
export type OldestSleeping = { app: string; hibernatedAt: string };

export type BeginResult =
  | { kind: 'disabled' }
  | { kind: 'not-configured' }
  | { kind: 'account-closed' }
  | { kind: 'limit'; limit: SleepingLimitRefusal; oldest: OldestSleeping | null }
  | { kind: 'attempt-conflict' }
  | {
      kind: 'ok';
      expiresAt: string;
      maxBytes: number;
      archive: { key: string; url: string };
      secrets: { key: string; url: string; dataKey: string; maxBytes: number };
    };

export type CommitResult =
  | { kind: 'disabled' }
  | { kind: 'not-configured' }
  | { kind: 'unknown-attempt' }
  | { kind: 'account-closed' }
  | { kind: 'mismatch'; reason: string }
  | { kind: 'lineage' }
  | { kind: 'limit'; limit: SleepingLimitRefusal; oldest: OldestSleeping | null }
  | { kind: 'committed'; sha256: string };

async function enabledFor(deps: HibernationDeps, userId: number): Promise<boolean> {
  const user = await deps.getUser(userId);
  return !!user && (await deps.isEnabled(user));
}

function configured(
  deps: HibernationDeps
): { store: ArchiveStore; masterKeys: MasterKeyring } | null {
  return deps.store && deps.masterKeys ? { store: deps.store, masterKeys: deps.masterKeys } : null;
}

/** The plan-limit refusal for a new archive of `appKey`, if any. `bytes` is known only at commit. */
function limitRefusal(
  limits: SleepingAppLimits,
  usage: { apps: number; bytes: number },
  replacesExisting: boolean,
  bytes: number
): SleepingLimitRefusal | null {
  if (!replacesExisting && usage.apps >= limits.apps)
    return { kind: 'apps', limit: limits.apps, used: usage.apps };
  if (usage.bytes + bytes > limits.bytes)
    return { kind: 'bytes', limit: limits.bytes, used: usage.bytes };
  return null;
}

async function oldestOf(
  deps: HibernationDeps,
  userId: number,
  excludeApp: string
): Promise<OldestSleeping | null> {
  const oldest = await deps.repo.oldest(userId, excludeApp);
  return oldest ? { app: oldest.app, hibernatedAt: oldest.hibernatedAt.toISOString() } : null;
}

export async function beginHibernation(
  input: BeginInput,
  deps: HibernationDeps
): Promise<BeginResult> {
  if (!(await enabledFor(deps, input.userId))) return { kind: 'disabled' };
  const cfg = configured(deps);
  if (!cfg) return { kind: 'not-configured' };
  // From the User row, not the session: a cached session can outlive a deletion or a ban.
  if ((await deps.repo.accountState(input.userId)) !== 'active') return { kind: 'account-closed' };

  const [limits, existing, usage] = await Promise.all([
    deps.limits(input.userId),
    deps.repo.get(input.userId, input.app),
    deps.repo.usage(input.userId, input.app),
  ]);
  // At begin the archive's size is unknown: refuse once not even one more byte fits. The refusal
  // names the oldest sleeping app so the user can be offered "delete <name> to continue"; nothing
  // is deleted here or anywhere else without that confirmation.
  const refusal = limitRefusal(limits, usage, !!existing, 1);
  if (refusal)
    return { kind: 'limit', limit: refusal, oldest: await oldestOf(deps, input.userId, input.app) };

  const keys = archiveObjectKeys(input.userId, input.app, input.attemptId);
  const binding = { userId: input.userId, appKey: input.app, attemptId: input.attemptId };
  const fresh = newDataKey();
  const stored = await deps.attempts.claim(
    {
      ...binding,
      reason: input.reason ?? null,
      archiveKey: keys.archive,
      secretsKey: keys.secrets,
      wrappedKey: wrapDataKey(cfg.masterKeys, binding, fresh),
    },
    ATTEMPT_TTL_SECONDS
  );
  // A retried begin gets the same keys back; an attempt id reused for another app is refused.
  if (stored.userId !== input.userId || stored.appKey !== input.app)
    return { kind: 'attempt-conflict' };
  const dataKey = unwrapDataKey(cfg.masterKeys, binding, stored.wrappedKey);

  const [archiveUrl, secretsUrl] = await Promise.all([
    cfg.store.presignPut(stored.archiveKey, ARCHIVE_PUT_TTL_SECONDS),
    cfg.store.presignPut(stored.secretsKey, ARCHIVE_PUT_TTL_SECONDS),
  ]);
  return {
    kind: 'ok',
    expiresAt: new Date(deps.now().getTime() + ARCHIVE_PUT_TTL_SECONDS * 1000).toISOString(),
    maxBytes: MAX_ARCHIVE_BYTES,
    archive: { key: stored.archiveKey, url: archiveUrl },
    secrets: {
      key: stored.secretsKey,
      url: secretsUrl,
      dataKey: dataKey.toString('base64'),
      maxBytes: MAX_SECRETS_BYTES,
    },
  };
}

const sha256Of = (b: Buffer) => createHash('sha256').update(new Uint8Array(b)).digest('hex');

/** Verifies the KEPT secrets copy: its size, its hash, and that it decrypts. */
async function verifySecrets(
  store: ArchiveStore,
  masterKeys: MasterKeyring,
  attempt: AttemptRecord,
  keptKey: string,
  claimed: { sha256: string; bytes: number }
): Promise<string | null> {
  if (!(await store.copy(attempt.secretsKey, keptKey))) return 'secrets object missing';
  const head = await store.head(keptKey);
  if (!head) return 'secrets object missing';
  if (head.bytes !== claimed.bytes) return 'secrets size mismatch';
  let sealed: Buffer | null;
  try {
    sealed = await store.read(keptKey, MAX_SECRETS_BYTES + 64);
  } catch (err) {
    if (err instanceof ArchiveObjectTooLarge) return 'secrets too large';
    throw err;
  }
  if (!sealed) return 'secrets object missing';
  if (sha256Of(sealed) !== claimed.sha256) return 'secrets sha256 mismatch';
  try {
    const binding = {
      userId: attempt.userId,
      appKey: attempt.appKey,
      attemptId: attempt.attemptId,
    };
    openSecrets(unwrapDataKey(masterKeys, binding, attempt.wrappedKey), binding, sealed);
  } catch {
    return 'secrets do not decrypt';
  }
  return null;
}

/** Verifies the KEPT archive copy: copy first, then size and a capped re-hash of the copy. */
async function verifyArchive(
  store: ArchiveStore,
  attempt: AttemptRecord,
  keptKey: string,
  claimed: { sha256: string; bytes: number }
): Promise<string | null> {
  // Cheap early refusal on the upload; the copy below is what gets trusted.
  const uploaded = await store.head(attempt.archiveKey);
  if (!uploaded) return 'archive object missing';
  if (uploaded.bytes !== claimed.bytes) return 'archive size mismatch';
  // Verify the COPY, never the upload: the upload's presigned PUT stays valid for its whole TTL,
  // so the upload can change after any check made on it. Nothing can write the kept key.
  if (!(await store.copy(attempt.archiveKey, keptKey))) return 'archive object missing';
  let hashed: { sha256: string; bytes: number } | null;
  try {
    hashed = await store.hash(keptKey, MAX_ARCHIVE_BYTES);
  } catch (err) {
    if (err instanceof ArchiveObjectTooLarge) return 'archive too large';
    throw err;
  }
  if (!hashed) return 'archive object missing';
  if (hashed.sha256 !== claimed.sha256 || hashed.bytes !== claimed.bytes)
    return 'archive sha256 mismatch';
  return null;
}

/** Best-effort delete; a failure is reported, and the orphan sweep is the backstop. */
async function discard(
  store: ArchiveStore,
  keys: string[],
  deps: HibernationDeps,
  context: Record<string, unknown>
) {
  if (keys.length === 0) return;
  try {
    await store.deleteMany(keys);
  } catch (err) {
    deps.report('app-hibernation.discard-failed', {
      ...context,
      keys,
      error: (err as Error)?.message,
    });
  }
}

export async function commitHibernation(
  input: CommitInput,
  deps: HibernationDeps
): Promise<CommitResult> {
  const attempt = await deps.attempts.get(input.attemptId);
  if (!attempt) return { kind: 'unknown-attempt' };
  if (!(await enabledFor(deps, attempt.userId))) return { kind: 'disabled' };
  const cfg = configured(deps);
  if (!cfg) return { kind: 'not-configured' };

  const kept = archiveObjectKeys(attempt.userId, attempt.appKey, attempt.attemptId);
  const context = { userId: attempt.userId, app: attempt.appKey, attemptId: attempt.attemptId };
  const uploads = [attempt.archiveKey, attempt.secretsKey];
  const all = [...uploads, kept.keptArchive, kept.keptSecrets];
  const refuse = async (result: CommitResult): Promise<CommitResult> => {
    await discard(cfg.store, all, deps, context);
    return result;
  };

  // A retry of a commit that already landed: answer from the row, before touching storage (the
  // uploads were deleted when it landed).
  const already = await deps.repo.get(attempt.userId, attempt.appKey);
  if (already && already.objectKey === kept.keptArchive) {
    if (already.sha256 === input.sha256) return { kind: 'committed', sha256: input.sha256 };
    await discard(cfg.store, uploads, deps, context);
    return { kind: 'mismatch', reason: 'attempt already committed' };
  }

  if ((await deps.repo.accountState(attempt.userId)) !== 'active')
    return refuse({ kind: 'account-closed' });

  // 1. Copy and verify before anything is written.
  const badArchive = await verifyArchive(cfg.store, attempt, kept.keptArchive, input);
  if (badArchive) return refuse({ kind: 'mismatch', reason: badArchive });
  if (input.secrets) {
    const bad = await verifySecrets(
      cfg.store,
      cfg.masterKeys,
      attempt,
      kept.keptSecrets,
      input.secrets
    );
    if (bad) return refuse({ kind: 'mismatch', reason: bad });
  }

  const limits = await deps.limits(attempt.userId);
  const row: HibernationRow = {
    userId: attempt.userId,
    appKey: attempt.appKey,
    attemptId: attempt.attemptId,
    objectKey: kept.keptArchive,
    sha256: input.sha256,
    bytes: input.bytes,
    excluded: input.excluded,
    secretsObjectKey: input.secrets ? kept.keptSecrets : null,
    secretsSha256: input.secrets?.sha256 ?? null,
    secretsBytes: input.secrets?.bytes ?? null,
    secretsWrappedKey: input.secrets ? attempt.wrappedKey : null,
    reason: attempt.reason,
    appCreatedAt: input.createdAt ? new Date(input.createdAt) : null,
    lastActivityAt: input.lastActivityAt ? new Date(input.lastActivityAt) : null,
    hibernatedAt: deps.now(),
  };

  // 2. Account, lineage and upsert, serialised per user and against an account deletion.
  // `superseded` is set only when this commit wrote the row.
  type Outcome = { result: CommitResult; superseded?: string[] };
  const outcome = await deps.repo.commit<Outcome>(
    attempt.userId,
    attempt.appKey,
    (existing, usage, account) => {
      if (account !== 'active') return { result: { result: { kind: 'account-closed' } } };
      if (existing && existing.objectKey === kept.keptArchive) {
        // A concurrent retry landed first. Idempotent only for the same content.
        return existing.sha256 === input.sha256
          ? { result: { result: { kind: 'committed', sha256: input.sha256 } } }
          : { result: { result: { kind: 'mismatch', reason: 'attempt already committed' } } };
      }
      // The live app must have been woken from the record it replaces, or it is a different app
      // that happens to share the key, and overwriting the record would lose the sleeping one.
      if (existing && input.sandboxSeedSha !== existing.sha256)
        return { result: { result: { kind: 'lineage' } } };
      const refusal = limitRefusal(limits, usage, !!existing, input.bytes);
      if (refusal) return { result: { result: { kind: 'limit', limit: refusal, oldest: null } } };
      const superseded = existing
        ? [existing.objectKey, existing.secretsObjectKey].filter(
            (k): k is string => !!k && k !== row.objectKey && k !== row.secretsObjectKey
          )
        : [];
      return {
        write: row,
        result: { result: { kind: 'committed', sha256: input.sha256 }, superseded },
      };
    }
  );

  const result = outcome.result;
  if (result.kind === 'committed') {
    // 3. Only now delete what the new row superseded, the uploads, and an unused secrets copy.
    const toDelete = [
      ...(outcome.superseded ?? []),
      ...(outcome.superseded ? uploads : []),
      ...(outcome.superseded && !input.secrets ? [kept.keptSecrets] : []),
    ];
    await discard(cfg.store, toDelete, deps, context);
    return result;
  }
  if (result.kind === 'mismatch') {
    // Our kept keys are the row's: delete only the uploads.
    await discard(cfg.store, uploads, deps, context);
    return result;
  }
  if (result.kind === 'limit')
    return refuse({ ...result, oldest: await oldestOf(deps, attempt.userId, attempt.appKey) });
  return refuse(result);
}

/**
 * The decrypted `.env*` blob of a sleeping app's record: read from storage, checked against the
 * row's sha256, then unwrapped and decrypted. Throws when any of that fails.
 */
export async function decryptRowSecrets(
  row: HibernationRow,
  store: ArchiveStore,
  masterKeys: MasterKeyring
): Promise<Buffer | null> {
  if (!row.secretsObjectKey || !row.secretsWrappedKey || !row.secretsSha256) return null;
  const sealed = await store.read(row.secretsObjectKey, MAX_SECRETS_BYTES + 64);
  if (!sealed) throw new Error('secrets object missing');
  if (sha256Of(sealed) !== row.secretsSha256)
    throw new Error('secrets object does not match its record');
  const binding = { userId: row.userId, appKey: row.appKey, attemptId: row.attemptId };
  return openSecrets(unwrapDataKey(masterKeys, binding, row.secretsWrappedKey), binding, sealed);
}

const ticketHash = (ticket: string) => createHash('sha256').update(ticket).digest('hex');

export type MintWakeTicketResult =
  | { kind: 'disabled' }
  | { kind: 'not-found' }
  | { kind: 'ok'; ticket: string; sha256: string; expiresAt: string };

/**
 * A one-time ticket releasing one sleeping app's secrets to the sandbox service, for the archive
 * the wake restores. Mint it ONLY when the user themselves starts a wake (the wake procedure, which
 * arrives with the UI); the ticket goes to the sandbox service with the seed and is redeemed once,
 * within {@link WAKE_TICKET_TTL_SECONDS}, by `/api/internal/app-hibernation/secrets`.
 */
export async function mintWakeTicket(
  userId: number,
  app: string,
  deps: HibernationDeps
): Promise<MintWakeTicketResult> {
  if (!(await enabledFor(deps, userId))) return { kind: 'disabled' };
  const row = await deps.repo.get(userId, app);
  if (!row) return { kind: 'not-found' };
  const ticket = randomBytes(32).toString('base64url');
  await deps.tickets.put(
    ticketHash(ticket),
    { userId, app, sha256: row.sha256 },
    WAKE_TICKET_TTL_SECONDS
  );
  return {
    kind: 'ok',
    ticket,
    sha256: row.sha256,
    expiresAt: new Date(deps.now().getTime() + WAKE_TICKET_TTL_SECONDS * 1000).toISOString(),
  };
}

export type RestoreSecretsResult =
  | { kind: 'disabled' }
  | { kind: 'not-configured' }
  | { kind: 'ticket' }
  | { kind: 'not-found' }
  | { kind: 'stale' }
  | { kind: 'ok'; secrets: string | null };

/**
 * The wake's restore step (the sandbox service, after the seed landed): the decrypted `.env*`
 * blob of the record whose archive sha256 the sandbox was seeded from, against a wake ticket.
 * The ticket is consumed first, whatever follows: missing, expired, already used, or minted for
 * another user, app or archive all answer `ticket`. A record replaced since then answers `stale`,
 * so secrets from one archive never land on another's files. Every release is reported (user and
 * app only, never the content).
 */
export async function restoreSleepingAppSecrets(
  input: RestoreSecretsInput,
  deps: HibernationDeps
): Promise<RestoreSecretsResult> {
  if (!(await enabledFor(deps, input.userId))) return { kind: 'disabled' };
  const cfg = configured(deps);
  if (!cfg) return { kind: 'not-configured' };
  const granted = await deps.tickets.take(ticketHash(input.ticket));
  if (
    !granted ||
    granted.userId !== input.userId ||
    granted.app !== input.app ||
    granted.sha256 !== input.sha256
  )
    return { kind: 'ticket' };
  const row = await deps.repo.get(input.userId, input.app);
  if (!row) return { kind: 'not-found' };
  if (row.sha256 !== input.sha256) return { kind: 'stale' };
  const plain = await decryptRowSecrets(row, cfg.store, cfg.masterKeys);
  deps.report('app-hibernation.secrets-released', {
    userId: input.userId,
    app: input.app,
    hadSecrets: !!plain,
  });
  return { kind: 'ok', secrets: plain ? plain.toString('base64') : null };
}

type AccountDeletionDeps = Pick<HibernationDeps, 'repo' | 'store'> & {
  isMissingTable: (err: unknown) => boolean;
};

/**
 * ACCOUNT DELETION: every sleeping app of the user goes. OBJECTS FIRST (everything under the
 * user's prefix, recorded or not), THEN the rows, so a failure part-way leaves the rows in place:
 * they are the durable record that the deletion is unfinished, and {@link sweepOrphanedArchives}
 * retries every deleted account that still has rows. Throws on any failure, so the caller logs it.
 * Not behind the flag: what was stored while it was on must still go. A ban does not call this;
 * banned users keep their sleeping apps.
 */
export async function deleteSleepingAppsForAccount(
  userId: number,
  deps: AccountDeletionDeps
): Promise<{ rows: number; objects: number }> {
  let objects = 0;
  if (deps.store) {
    const listed = (await deps.store.list(userArchivePrefix(userId))).map((o) => o.key);
    if (listed.length > 0) await deps.store.deleteMany(listed);
    objects = listed.length;
  } else {
    // No store to empty here: keep the rows (the record) rather than orphan their objects.
    let held = 0;
    try {
      held = (await deps.repo.usage(userId, '')).apps;
    } catch (err) {
      if (!deps.isMissingTable(err)) throw err;
    }
    if (held > 0)
      throw new Error('archive store not configured; sleeping-app rows kept for a retry');
  }
  let rows = 0;
  try {
    rows = (await deps.repo.removeAll(userId)).length;
  } catch (err) {
    if (!deps.isMissingTable(err)) throw err;
  }
  return { rows, objects };
}

export type SweepResult = {
  /** Deleted accounts whose sleeping apps this run removed (a retry of a failed deletion step). */
  accountsRetried: number[];
  accountsFailed: number[];
  /** Objects older than {@link ORPHAN_MIN_AGE_MS} that no row references. */
  orphans: string[];
  dryRun: boolean;
};

/**
 * ORPHAN SWEEP (exported for the job that will run it): uploads of attempts that never committed,
 * kept copies whose superseding delete failed, and the leftovers of a failed account-deletion
 * step. Two passes:
 *   1. every deleted account that still has rows gets {@link deleteSleepingAppsForAccount} again;
 *   2. every object under the archives prefix older than {@link ORPHAN_MIN_AGE_MS} that NO row
 *      references is deleted. A referenced key is never touched, whatever its age; an unreadable
 *      reference set aborts the run (it throws) rather than deleting blind.
 * `dryRun` reports what it would do and changes nothing.
 */
export async function sweepOrphanedArchives(
  deps: Pick<HibernationDeps, 'repo' | 'store' | 'now' | 'report'> & {
    isMissingTable: (err: unknown) => boolean;
  },
  opts: { dryRun?: boolean; accountBatch?: number } = {}
): Promise<SweepResult> {
  const dryRun = opts.dryRun ?? false;
  const result: SweepResult = { accountsRetried: [], accountsFailed: [], orphans: [], dryRun };
  if (!deps.store) return result;

  for (const userId of await deps.repo.deletedAccountsWithRows(opts.accountBatch ?? 100)) {
    if (dryRun) {
      result.accountsRetried.push(userId);
      continue;
    }
    try {
      await deleteSleepingAppsForAccount(userId, deps);
      result.accountsRetried.push(userId);
    } catch (err) {
      result.accountsFailed.push(userId);
      deps.report('app-hibernation.account-retry-failed', {
        userId,
        error: (err as Error)?.message,
      });
    }
  }

  const cutoff = deps.now().getTime() - ORPHAN_MIN_AGE_MS;
  const old = (await deps.store.list(ARCHIVE_PREFIX))
    .filter((o) => o.lastModified.getTime() <= cutoff)
    .map((o) => o.key);
  for (let i = 0; i < old.length; i += 1000) {
    const batch = old.slice(i, i + 1000);
    const referenced = await deps.repo.referencedKeys(batch);
    const orphans = batch.filter((k) => !referenced.has(k));
    if (orphans.length > 0 && !dryRun) await deps.store.deleteMany(orphans);
    result.orphans.push(...orphans);
  }
  return result;
}
