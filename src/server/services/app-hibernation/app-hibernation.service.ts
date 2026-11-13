import { createHash } from 'node:crypto';
import * as z from 'zod';
import { isAppBlockId } from '@civitai/app-assistant';
import type { SessionUser } from '~/types/session';
import type { ArchiveStore } from '~/utils/app-archive-s3';
import {
  ARCHIVE_GET_TTL_SECONDS,
  ARCHIVE_PUT_TTL_SECONDS,
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
} from '~/server/services/app-hibernation/secrets-envelope';

/**
 * APP HIBERNATE — civitai's half of "Sleeping" apps. The sandbox service archives an app it is
 * about to remove (at the kept-app cap, on the idle expiry, or on the user's request) and asks
 * civitai to keep the archive:
 *
 *   begin   civitai checks the flag and the user's plan limit, builds the object keys itself, and
 *           answers presigned PUTs for the archive and the encrypted `.env*` blob, plus a fresh
 *           data key for that blob (its wrapped copy stays with civitai).
 *   commit  civitai verifies the objects FROM STORAGE (size, then a re-hash; the secrets blob must
 *           also decrypt), checks lineage, upserts the user's row for the app, and only then deletes
 *           what the new row superseded. Its `{ committed: true }` answer is the sandbox service's
 *           receipt: it removes the sandbox only after holding one.
 *
 * The owner lists, wakes (a presigned GET of the archive, the seed the sandbox service restores
 * from) and deletes sleeping apps. Nothing here ever deletes a sleeping app to make room: at the
 * plan limit `begin` refuses, and the sandbox service keeps the app as it is.
 */

/** The largest archive kept: the sandbox service's seed limit, so every archive can be woken. */
export const MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;
/** The largest encrypted `.env*` blob kept. */
export const MAX_SECRETS_BYTES = 1024 * 1024;
/** How long a `begin` is remembered for its `commit` (and for a retried commit). */
export const ATTEMPT_TTL_SECONDS = 24 * 60 * 60;

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

export type HibernationDeps = {
  repo: HibernationRepo;
  attempts: AttemptStore;
  /** `null` when this environment has no archive store. */
  store: ArchiveStore | null;
  /** `null` when the master key is unset or malformed. */
  masterKey: Buffer | null;
  getUser: (userId: number) => Promise<SessionUser | null>;
  isEnabled: (user: SessionUser) => Promise<boolean>;
  limits: (userId: number) => Promise<SleepingAppLimits>;
  now: () => Date;
  /** Best-effort reporting of a step that failed after the outcome was settled. */
  report: (event: string, details: Record<string, unknown>) => void;
};

export type SleepingLimitRefusal = {
  kind: 'apps' | 'bytes';
  limit: number;
  used: number;
};

export type BeginResult =
  | { kind: 'disabled' }
  | { kind: 'not-configured' }
  | { kind: 'limit'; limit: SleepingLimitRefusal }
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
  | { kind: 'mismatch'; reason: string }
  | { kind: 'lineage' }
  | { kind: 'limit'; limit: SleepingLimitRefusal }
  | { kind: 'committed'; sha256: string };

async function enabledFor(deps: HibernationDeps, userId: number): Promise<boolean> {
  const user = await deps.getUser(userId);
  return !!user && (await deps.isEnabled(user));
}

function configured(deps: HibernationDeps): { store: ArchiveStore; masterKey: Buffer } | null {
  return deps.store && deps.masterKey ? { store: deps.store, masterKey: deps.masterKey } : null;
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

export async function beginHibernation(
  input: BeginInput,
  deps: HibernationDeps
): Promise<BeginResult> {
  if (!(await enabledFor(deps, input.userId))) return { kind: 'disabled' };
  const cfg = configured(deps);
  if (!cfg) return { kind: 'not-configured' };

  const [limits, existing, usage] = await Promise.all([
    deps.limits(input.userId),
    deps.repo.get(input.userId, input.app),
    deps.repo.usage(input.userId, input.app),
  ]);
  // At begin the archive's size is unknown: refuse once not even one more byte fits.
  const refusal = limitRefusal(limits, usage, !!existing, 1);
  if (refusal) return { kind: 'limit', limit: refusal };

  const keys = archiveObjectKeys(input.userId, input.app, input.attemptId);
  const binding = { userId: input.userId, appKey: input.app, attemptId: input.attemptId };
  const fresh = newDataKey();
  const stored = await deps.attempts.claim(
    {
      ...binding,
      reason: input.reason ?? null,
      archiveKey: keys.archive,
      secretsKey: keys.secrets,
      wrappedKey: wrapDataKey(cfg.masterKey, binding, fresh),
    },
    ATTEMPT_TTL_SECONDS
  );
  // A retried begin gets the same keys back; an attempt id reused for another app is refused.
  if (stored.userId !== input.userId || stored.appKey !== input.app)
    return { kind: 'attempt-conflict' };
  const dataKey = unwrapDataKey(cfg.masterKey, binding, stored.wrappedKey);

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

/** Verifies the secrets blob in storage: its size, its hash, and that it decrypts. */
async function verifySecrets(
  store: ArchiveStore,
  masterKey: Buffer,
  attempt: AttemptRecord,
  claimed: { sha256: string; bytes: number }
): Promise<string | null> {
  const head = await store.head(attempt.secretsKey);
  if (!head) return 'secrets object missing';
  if (head.bytes !== claimed.bytes) return 'secrets size mismatch';
  const sealed = await store.read(attempt.secretsKey, MAX_SECRETS_BYTES + 64);
  if (!sealed) return 'secrets object missing';
  if (createHash('sha256').update(new Uint8Array(sealed)).digest('hex') !== claimed.sha256)
    return 'secrets sha256 mismatch';
  try {
    const binding = {
      userId: attempt.userId,
      appKey: attempt.appKey,
      attemptId: attempt.attemptId,
    };
    openSecrets(unwrapDataKey(masterKey, binding, attempt.wrappedKey), binding, sealed);
  } catch {
    return 'secrets do not decrypt';
  }
  return null;
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

  // 1. Verify FROM STORAGE before anything is written: HEAD for the size, then a re-hash.
  const head = await cfg.store.head(attempt.archiveKey);
  if (!head) return { kind: 'mismatch', reason: 'archive object missing' };
  if (head.bytes !== input.bytes) return { kind: 'mismatch', reason: 'archive size mismatch' };
  const hashed = await cfg.store.hash(attempt.archiveKey);
  if (!hashed) return { kind: 'mismatch', reason: 'archive object missing' };
  if (hashed.sha256 !== input.sha256 || hashed.bytes !== input.bytes)
    return { kind: 'mismatch', reason: 'archive sha256 mismatch' };
  if (input.secrets) {
    const bad = await verifySecrets(cfg.store, cfg.masterKey, attempt, input.secrets);
    if (bad) return { kind: 'mismatch', reason: bad };
  }

  const limits = await deps.limits(attempt.userId);
  const row: HibernationRow = {
    userId: attempt.userId,
    appKey: attempt.appKey,
    attemptId: attempt.attemptId,
    objectKey: attempt.archiveKey,
    sha256: input.sha256,
    bytes: input.bytes,
    excluded: input.excluded,
    secretsObjectKey: input.secrets ? attempt.secretsKey : null,
    secretsSha256: input.secrets?.sha256 ?? null,
    secretsBytes: input.secrets?.bytes ?? null,
    secretsWrappedKey: input.secrets ? attempt.wrappedKey : null,
    reason: attempt.reason,
    appCreatedAt: input.createdAt ? new Date(input.createdAt) : null,
    lastActivityAt: input.lastActivityAt ? new Date(input.lastActivityAt) : null,
    hibernatedAt: deps.now(),
  };

  // 2. Lineage and upsert, serialised per user.
  // `superseded` is set only when this commit wrote the row.
  type Outcome = { result: CommitResult; superseded?: string[] };
  const outcome = await deps.repo.commit<Outcome>(
    attempt.userId,
    attempt.appKey,
    (existing, usage) => {
      if (existing && existing.objectKey === attempt.archiveKey) {
        // This attempt already committed: a retry. Idempotent only for the same content.
        return existing.sha256 === input.sha256
          ? { result: { result: { kind: 'committed', sha256: input.sha256 } } }
          : { result: { result: { kind: 'mismatch', reason: 'attempt already committed' } } };
      }
      // The live app must have been woken from the record it replaces, or it is a different app
      // that happens to share the key, and overwriting the record would lose the sleeping one.
      if (existing && input.sandboxSeedSha !== existing.sha256)
        return { result: { result: { kind: 'lineage' } } };
      const refusal = limitRefusal(limits, usage, !!existing, input.bytes);
      if (refusal) return { result: { result: { kind: 'limit', limit: refusal } } };
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

  // 3. Only now delete what the new row superseded (and an unused secrets upload).
  if (outcome.superseded) {
    const unused = input.secrets ? [] : [attempt.secretsKey];
    const toDelete = [...outcome.superseded, ...unused];
    if (toDelete.length > 0) {
      try {
        await cfg.store.deleteMany(toDelete);
      } catch (err) {
        // The row is committed; an object left behind is only an orphan, never a lost app.
        deps.report('app-hibernation.superseded-delete-failed', {
          userId: attempt.userId,
          app: attempt.appKey,
          keys: toDelete,
          error: (err as Error)?.message,
        });
      }
    }
  }
  return outcome.result;
}

export type SleepingApp = {
  app: string;
  status: 'Sleeping';
  bytes: number;
  sha256: string;
  hasSecrets: boolean;
  appCreatedAt: Date | null;
  lastActivityAt: Date | null;
  hibernatedAt: Date;
};

const toSleepingApp = (row: HibernationRow): SleepingApp => ({
  app: row.appKey,
  status: 'Sleeping',
  bytes: row.bytes,
  sha256: row.sha256,
  hasSecrets: !!row.secretsObjectKey,
  appCreatedAt: row.appCreatedAt,
  lastActivityAt: row.lastActivityAt,
  hibernatedAt: row.hibernatedAt,
});

export async function listSleepingApps(userId: number, deps: HibernationDeps) {
  return (await deps.repo.list(userId)).map(toSleepingApp);
}

export type WakeSeed = {
  app: string;
  url: string;
  sha256: string;
  bytes: number;
  expiresAt: string;
  /** Whether the sandbox service should restore `.env*` (`/api/internal/app-hibernation/secrets`). */
  hasSecrets: boolean;
};

/** The seed a wake restores from, or `null` when the user has no sleeping app under that key. */
export async function getWakeSeed(
  userId: number,
  app: string,
  deps: HibernationDeps
): Promise<WakeSeed | null | 'not-configured'> {
  const cfg = configured(deps);
  if (!cfg) return 'not-configured';
  const row = await deps.repo.get(userId, app);
  if (!row) return null;
  return {
    app: row.appKey,
    url: await cfg.store.presignGet(row.objectKey, ARCHIVE_GET_TTL_SECONDS),
    sha256: row.sha256,
    bytes: row.bytes,
    expiresAt: new Date(deps.now().getTime() + ARCHIVE_GET_TTL_SECONDS * 1000).toISOString(),
    hasSecrets: !!row.secretsObjectKey,
  };
}

/**
 * The decrypted `.env*` blob of a sleeping app's record: read from storage, checked against the
 * row's sha256, then unwrapped and decrypted. Throws when any of that fails.
 */
export async function decryptRowSecrets(
  row: HibernationRow,
  store: ArchiveStore,
  masterKey: Buffer
): Promise<Buffer | null> {
  if (!row.secretsObjectKey || !row.secretsWrappedKey || !row.secretsSha256) return null;
  const sealed = await store.read(row.secretsObjectKey, MAX_SECRETS_BYTES + 64);
  if (!sealed) throw new Error('secrets object missing');
  if (createHash('sha256').update(new Uint8Array(sealed)).digest('hex') !== row.secretsSha256)
    throw new Error('secrets object does not match its record');
  const binding = { userId: row.userId, appKey: row.appKey, attemptId: row.attemptId };
  return openSecrets(unwrapDataKey(masterKey, binding, row.secretsWrappedKey), binding, sealed);
}

export type RestoreSecretsResult =
  | { kind: 'disabled' }
  | { kind: 'not-configured' }
  | { kind: 'not-found' }
  | { kind: 'stale' }
  | { kind: 'ok'; secrets: string | null };

/**
 * The wake's restore step (the sandbox service, after the seed landed): the decrypted `.env*`
 * blob of the record whose archive sha256 the sandbox was seeded from. A record replaced since
 * then answers `stale`, so secrets from one archive never land on another's files.
 */
export async function restoreSleepingAppSecrets(
  input: RestoreSecretsInput,
  deps: HibernationDeps
): Promise<RestoreSecretsResult> {
  if (!(await enabledFor(deps, input.userId))) return { kind: 'disabled' };
  const cfg = configured(deps);
  if (!cfg) return { kind: 'not-configured' };
  const row = await deps.repo.get(input.userId, input.app);
  if (!row) return { kind: 'not-found' };
  if (row.sha256 !== input.sha256) return { kind: 'stale' };
  const plain = await decryptRowSecrets(row, cfg.store, cfg.masterKey);
  return { kind: 'ok', secrets: plain ? plain.toString('base64') : null };
}

/** Deletes one sleeping app: the row first, then its objects. */
export async function deleteSleepingApp(
  userId: number,
  app: string,
  deps: HibernationDeps
): Promise<{ deleted: boolean }> {
  const row = await deps.repo.remove(userId, app);
  if (!row) return { deleted: false };
  const keys = [row.objectKey, row.secretsObjectKey].filter((k): k is string => !!k);
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
  return { deleted: true };
}

/**
 * ACCOUNT DELETION: every sleeping app of the user goes, rows and objects, including any object
 * under the user's prefix that no row names (an attempt that never committed). Not behind the
 * flag: what was stored while it was on must still go. A ban does not call this; banned users
 * keep their sleeping apps. Throws when the store cannot be emptied, so the caller records it.
 */
export async function deleteSleepingAppsForAccount(
  userId: number,
  deps: Pick<HibernationDeps, 'repo' | 'store'> & {
    isMissingTable: (err: unknown) => boolean;
  }
): Promise<{ rows: number; objects: number }> {
  let rows: HibernationRow[] = [];
  try {
    rows = await deps.repo.removeAll(userId);
  } catch (err) {
    if (!deps.isMissingTable(err)) throw err;
  }
  if (!deps.store) return { rows: rows.length, objects: 0 };
  const listed = await deps.store.list(userArchivePrefix(userId));
  const keys = [
    ...new Set([
      ...rows.flatMap((r) => [r.objectKey, r.secretsObjectKey].filter((k): k is string => !!k)),
      ...listed,
    ]),
  ];
  if (keys.length > 0) await deps.store.deleteMany(keys);
  return { rows: rows.length, objects: keys.length };
}
