/**
 * App Blocks STAFF PLATFORM UPDATES — Civitai staff (a moderator) pushes a change to someone
 * else's app; the owner's CLI and App Assistant list it and merge it.
 *
 * DELIVERY. The change is ONE commit on its own branch (`platform-update/<id>`) of the app's SOURCE
 * repo (`civitai-apps-src/<slug>`), cut from `main`. Never the build repo: a push there would file
 * a publish request in the owner's name and withdraw the one they have pending.
 *
 * An app with no source repo yet gets one first: a FORK of its build repo (its whole history), so
 * the update branch shares history with an owner's existing checkout of the build repo.
 *
 * THE RECORD IS THE PROOF. Each update is a row in `app_platform_updates` written by the server
 * after the commit landed, carrying the moderator's user id from the session. The commit's author
 * and its `Platform-Update*` trailers are text anyone with push access can write, so nothing here
 * reads them: `verifiedStaff` is true only for a commit that has a row, whose author account is a
 * moderator now, and not banned or deleted ({@link ownerView}). The recorded `commitSha` is what a
 * client merges, never whatever the branch points at later: the branch is ordinary git, the
 * record is the server's.
 *
 * AUDIT. The table is append-only (no delete path exists); every status change records who made
 * it and when, and every write is also logged.
 *
 * ACCESS.
 *   - push / supersede / modList: moderators (`moderatorProcedure` at the router, re-checked here
 *     against the database for push).
 *   - listPending (OPEN updates: pending + conflicted) / verifyCommit / resolve: the app's owner
 *     or an ACCEPTED collaborator, by the same `assertAppEditAccess` gate the CLI's other app
 *     commands use. "No such app" and "not yours" answer the same, so an app id is not an
 *     oracle.
 *
 * 🔴 Dark until migration `20271205140000_app_platform_updates` is applied by hand AND the
 * `app-blocks-platform-updates` flag is on ({@link isPlatformUpdatesEnabled}).
 */

import { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { dbRead, dbWrite } from '~/server/db/client';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { logToAxiom } from '~/server/logging/client';
import { isMissingTableError } from '~/server/services/blocks/app-access.service';
import {
  PLATFORM_AUTHOR,
  PLATFORM_UPDATE_REASON_MAX,
  PlatformUpdatePlanError,
  SOURCE_MAIN_BRANCH,
  isCommitSha,
  normalisePlatformUpdateReason,
  planPlatformUpdateCommit,
  platformUpdateBranch,
  platformUpdateCommitMessage,
  treeFromMap,
  type PlatformUpdateChange,
} from '~/server/services/blocks/app-source-repo.plan';
import { FORGEJO_SOURCE_ORG } from '~/server/services/blocks/forgejo-orgs';
import { newAppPlatformUpdateId } from '~/server/utils/app-block-ids';

export const PLATFORM_UPDATES_FLAG = FLIPT_FEATURE_FLAGS.APP_BLOCKS_PLATFORM_UPDATES;

/** The most file changes one update may carry. */
export const PLATFORM_UPDATE_MAX_CHANGES = 100;
/** The most bytes (decoded) one update may write. */
export const PLATFORM_UPDATE_MAX_BYTES = 8 * 1024 * 1024;

export type PlatformUpdateStatus = 'pending' | 'merged' | 'conflicted' | 'superseded';

export type PlatformUpdatePath = { path: string; operation: 'create' | 'update' | 'delete' };

/** The app's manifest, at the root of its source repo. */
export const MANIFEST_PATH = 'block.manifest.json';

/** The global switch. Off, absent or Flipt unreachable ⇒ off. */
export async function isPlatformUpdatesEnabled(): Promise<boolean> {
  return isFlipt(PLATFORM_UPDATES_FLAG).catch(() => false);
}

const log = (type: 'info' | 'warning' | 'error', message: string, data: Record<string, unknown>) =>
  logToAxiom({ name: 'app-platform-update', type, message, ...data }, 'webhooks');

const unavailable = () =>
  new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Platform updates are not available' });

// ---------------------------------------------------------------------------
// The table (raw SQL; a missing table reads as "off")
// ---------------------------------------------------------------------------

export type UpdateRow = {
  id: string;
  appBlockId: string;
  slug: string;
  staffUserId: number;
  reason: string;
  branch: string;
  baseCommitSha: string;
  commitSha: string;
  paths: PlatformUpdatePath[];
  touchesManifest: boolean;
  status: PlatformUpdateStatus;
  mergeCommitSha: string | null;
  seededSourceRepo: boolean;
  createdAt: Date;
  resolvedAt: Date | null;
  /** The staff account as it is NOW (joined at read time); null when it no longer exists. */
  staffUsername: string | null;
  staffIsModerator: boolean | null;
  staffBannedAt: Date | null;
  staffDeletedAt: Date | null;
};

async function tableAvailable(): Promise<boolean> {
  try {
    await dbWrite.$queryRaw`SELECT 1 FROM "app_platform_updates" LIMIT 1`;
    return true;
  } catch (err) {
    if (isMissingTableError(err)) return false;
    throw err;
  }
}

const ROW_COLUMNS = Prisma.sql`u."id", u."app_block_id" AS "appBlockId", u."slug",
  u."staff_user_id" AS "staffUserId", u."reason", u."branch",
  u."base_commit_sha" AS "baseCommitSha", u."commit_sha" AS "commitSha", u."paths",
  u."touches_manifest" AS "touchesManifest", u."status",
  u."merge_commit_sha" AS "mergeCommitSha", u."seeded_source_repo" AS "seededSourceRepo",
  u."created_at" AS "createdAt", u."resolved_at" AS "resolvedAt",
  s."username" AS "staffUsername", s."isModerator" AS "staffIsModerator",
  s."bannedAt" AS "staffBannedAt", s."deletedAt" AS "staffDeletedAt"`;

type RowFilter =
  | { kind: 'open-for-app'; appBlockId: string }
  | { kind: 'all-for-app'; appBlockId: string }
  | { kind: 'commit'; appBlockId: string; commitSha: string }
  | { kind: 'id'; id: string };

function filterSql(filter: RowFilter): Prisma.Sql {
  switch (filter.kind) {
    case 'id':
      return Prisma.sql`WHERE u."id" = ${filter.id} LIMIT 1`;
    case 'commit':
      return Prisma.sql`WHERE u."app_block_id" = ${filter.appBlockId}
        AND u."commit_sha" = ${filter.commitSha} LIMIT 1`;
    case 'open-for-app':
      return Prisma.sql`WHERE u."app_block_id" = ${filter.appBlockId}
        AND u."status" IN ('pending', 'conflicted')
        ORDER BY u."created_at" ASC, u."id" ASC LIMIT 100`;
    case 'all-for-app':
      return Prisma.sql`WHERE u."app_block_id" = ${filter.appBlockId}
        ORDER BY u."created_at" DESC, u."id" DESC LIMIT 200`;
  }
}

/**
 * Rows matching `filter`, each joined to its staff account as it is NOW; `null` when the table is
 * missing.
 */
export async function readRows(
  filter: RowFilter,
  db: Pick<typeof dbRead, '$queryRaw'> = dbRead
): Promise<UpdateRow[] | null> {
  try {
    return (await db.$queryRaw(
      Prisma.sql`SELECT ${ROW_COLUMNS}
        FROM "app_platform_updates" u LEFT JOIN "User" s ON s."id" = u."staff_user_id"
        ${filterSql(filter)}`
    )) as UpdateRow[];
  } catch (err) {
    if (isMissingTableError(err)) return null;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// The owner-facing shape (the CLI / App Assistant contract)
// ---------------------------------------------------------------------------

export type OwnerPlatformUpdate = {
  id: string;
  branch: string;
  /** The update's commit. A client merges THIS sha, never the branch's tip. */
  commitSha: string;
  /** The parent of `commitSha`: the `main` commit the update's branch was cut from. */
  baseCommitSha: string;
  reason: string;
  /** Every path the update's commit changes, as the server committed it. */
  paths: PlatformUpdatePath[];
  /**
   * The update changes `block.manifest.json` (the app's scopes, permissions and storage
   * declarations) or a storage hook file the manifest declares: what the app may do.
   */
  touchesManifest: boolean;
  status: PlatformUpdateStatus;
  by: { username: string | null; verifiedStaff: boolean };
  /** ISO-8601. */
  createdAt: string;
};

/**
 * 🔴 `verifiedStaff` is derived from the RECORD (this row exists, written by the server for a
 * moderator session) and the author account as it is NOW: a moderator, not banned, not deleted.
 * Never from commit text.
 */
export function ownerView(row: UpdateRow): OwnerPlatformUpdate {
  return {
    id: row.id,
    branch: row.branch,
    commitSha: row.commitSha,
    baseCommitSha: row.baseCommitSha,
    reason: row.reason,
    paths: Array.isArray(row.paths) ? row.paths : [],
    touchesManifest: row.touchesManifest === true,
    status: row.status,
    by: {
      username: row.staffUsername ?? null,
      verifiedStaff: row.staffIsModerator === true && !row.staffBannedAt && !row.staffDeletedAt,
    },
    createdAt: new Date(row.createdAt).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// App resolution and the owner gate
// ---------------------------------------------------------------------------

export type AppRef = { appBlockId?: string; slug?: string };

export type ResolvedApp = { id: string; slug: string; status: string; ownerUserId: number | null };

export async function resolveApp(ref: AppRef): Promise<ResolvedApp | null> {
  const select = { id: true, blockId: true, status: true, app: { select: { userId: true } } };
  const block = ref.appBlockId
    ? await dbRead.appBlock.findUnique({ where: { id: ref.appBlockId }, select })
    : ref.slug
    ? await dbRead.appBlock.findFirst({ where: { blockId: ref.slug }, select })
    : null;
  if (!block) return null;
  return {
    id: block.id,
    slug: block.blockId,
    status: block.status,
    ownerUserId: block.app?.userId ?? null,
  };
}

const APP_NOT_FOUND = () => new TRPCError({ code: 'NOT_FOUND', message: 'App not found' });

/**
 * The app `ref` names, when `userId` may edit it (owner or accepted collaborator). A missing app
 * and one the caller may not edit both throw the same NOT_FOUND.
 */
async function appForOwner(userId: number, ref: AppRef): Promise<ResolvedApp> {
  const app = await resolveApp(ref);
  if (!app) throw APP_NOT_FOUND();
  const { assertAppEditAccess } = await import('~/server/services/blocks/app-access.service');
  try {
    await assertAppEditAccess({ appBlockId: app.id, ownerUserId: app.ownerUserId, userId });
  } catch (err) {
    if (err instanceof TRPCError && err.code === 'FORBIDDEN') throw APP_NOT_FOUND();
    throw err;
  }
  return app;
}

// ---------------------------------------------------------------------------
// Owner API
// ---------------------------------------------------------------------------

/**
 * The app's OPEN updates — `pending` AND `conflicted` — oldest first, each with its `status`.
 * Empty when the table is missing.
 *
 * 🔴 A `conflicted` update stays listed until it is merged or superseded: the client that hit
 * the conflict reported it once, but the owner has not merged it yet, so every later pull must
 * re-print the hand-merge instructions (or retry the merge) and every later submit must still
 * refuse over it. Listing pending only made the update vanish after that one report.
 */
export async function listOpenPlatformUpdates(args: {
  userId: number;
  app: AppRef;
}): Promise<OwnerPlatformUpdate[]> {
  const app = await appForOwner(args.userId, args.app);
  const rows = await readRows({ kind: 'open-for-app', appBlockId: app.id });
  return (rows ?? []).map(ownerView);
}

/**
 * Is `commitSha` a platform update to this app? `verified` is true only when the server has a
 * record of it, the update was not withdrawn (`superseded`), and its author is staff now
 * ({@link ownerView}'s `verifiedStaff`). A commit that merely CLAIMS to be one (its author or
 * `Platform-Update*` trailers) answers `{ verified: false, update: null }`.
 */
export async function verifyPlatformUpdateCommit(args: {
  userId: number;
  app: AppRef;
  commitSha: string;
}): Promise<{ verified: boolean; update: OwnerPlatformUpdate | null }> {
  const app = await appForOwner(args.userId, args.app);
  if (!isCommitSha(args.commitSha)) return { verified: false, update: null };
  const rows = await readRows({ kind: 'commit', appBlockId: app.id, commitSha: args.commitSha });
  const row = rows?.[0];
  if (!row) return { verified: false, update: null };
  const update = ownerView(row);
  return { verified: update.by.verifiedStaff && update.status !== 'superseded', update };
}

export type ResolveOutcome = 'merged' | 'conflicted';

/** Which statuses each owner outcome may move an update from. */
const RESOLVABLE_FROM: Record<ResolveOutcome, PlatformUpdateStatus[]> = {
  merged: ['pending', 'conflicted'],
  conflicted: ['pending'],
};

/**
 * The owner's CLI / App Assistant reports what happened to an update: `merged` (with the merge
 * commit on their `main`) or `conflicted` (it did not apply cleanly; the owner merges by hand, and
 * may report `merged` later). Repeating the outcome the update already has is a no-op.
 */
export async function resolvePlatformUpdate(args: {
  userId: number;
  id: string;
  outcome: ResolveOutcome;
  mergeCommitSha?: string | null;
}): Promise<OwnerPlatformUpdate> {
  // The primary: an update pushed moments ago may not have reached the replica.
  const rows = await readRows({ kind: 'id', id: args.id }, dbWrite);
  if (rows === null) throw unavailable();
  const row = rows[0];
  if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Update not found' });
  // The gate is on the RECORD's app, never one the caller names.
  try {
    await appForOwner(args.userId, { appBlockId: row.appBlockId });
  } catch (err) {
    if (err instanceof TRPCError && err.code === 'NOT_FOUND')
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Update not found' });
    throw err;
  }
  const mergeSha = args.outcome === 'merged' ? args.mergeCommitSha ?? null : null;
  if (args.outcome === 'merged' && (!mergeSha || !isCommitSha(mergeSha)))
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'mergeCommitSha (a full lowercase commit id) is required when outcome is merged',
    });
  if (row.status === args.outcome && (args.outcome !== 'merged' || row.mergeCommitSha === mergeSha))
    return ownerView(row);

  const from = RESOLVABLE_FROM[args.outcome];
  const changed = Number(
    await dbWrite.$executeRaw`UPDATE "app_platform_updates"
        SET "status" = ${args.outcome}, "merge_commit_sha" = ${mergeSha},
            "resolved_by_user_id" = ${args.userId}, "resolved_at" = now(), "updated_at" = now()
      WHERE "id" = ${row.id} AND "status" = ANY(${from})`
  );
  if (changed !== 1)
    throw new TRPCError({
      code: 'CONFLICT',
      message: `This update is already ${row.status} and cannot be marked ${args.outcome}`,
    });
  log('info', 'resolved', {
    updateId: row.id,
    slug: row.slug,
    outcome: args.outcome,
    mergeCommitSha: mergeSha,
    byUserId: args.userId,
  });
  return ownerView({ ...row, status: args.outcome, mergeCommitSha: mergeSha });
}

// ---------------------------------------------------------------------------
// Moderator API
// ---------------------------------------------------------------------------

export type PushPlatformUpdateResult = {
  id: string;
  slug: string;
  branch: string;
  commitSha: string;
  baseCommitSha: string;
  seededSourceRepo: boolean;
  paths: PlatformUpdatePath[];
  touchesManifest: boolean;
};

/**
 * Commit `changes` to a new `platform-update/<id>` branch of the app's source repo (creating the
 * repo first, as a fork of the build repo, when it has none), record the update, and tell the
 * owner. Holds the slug's source-repo writer lock, the one the App Assistant's saves take.
 *
 * Refuses: an account that is not a moderator; a blank or too-long reason; no changes, too many,
 * too large, a path a source repo never holds; an app with neither a source repo nor an approved
 * version; a source repo under the slug that belongs to a different app; `main` moving during the
 * write. Nothing is recorded for a refused push.
 */
export async function pushPlatformUpdate(args: {
  staffUserId: number;
  app: AppRef;
  reason: string;
  changes: PlatformUpdateChange[];
}): Promise<PushPlatformUpdateResult> {
  const reason = normalisePlatformUpdateReason(args.reason);
  if (!reason) throw new TRPCError({ code: 'BAD_REQUEST', message: 'A reason is required' });
  if (reason.length > PLATFORM_UPDATE_REASON_MAX)
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `The reason is longer than ${PLATFORM_UPDATE_REASON_MAX} characters`,
    });
  if (!args.changes.length)
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'An update needs at least one change' });
  if (args.changes.length > PLATFORM_UPDATE_MAX_CHANGES)
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `An update may change at most ${PLATFORM_UPDATE_MAX_CHANGES} files`,
    });
  const bytes = args.changes.reduce(
    (n, c) => n + (c.operation === 'put' ? c.content.byteLength : 0),
    0
  );
  if (bytes > PLATFORM_UPDATE_MAX_BYTES)
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `An update may write at most ${PLATFORM_UPDATE_MAX_BYTES} bytes`,
    });

  // Re-checked against the database, not only the session: the record certifies this account.
  const staff = await dbRead.user.findUnique({
    where: { id: args.staffUserId },
    select: { username: true, isModerator: true },
  });
  if (!staff?.isModerator)
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Only Civitai staff can push updates' });

  const app = await resolveApp(args.app);
  if (!app) throw APP_NOT_FOUND();
  if (typeof app.ownerUserId !== 'number') throw APP_NOT_FOUND();
  if (!(await tableAvailable())) throw unavailable();

  const { withSourceRepoLock } = await import('~/server/services/blocks/app-source-repo.service');
  const result = await withSourceRepoLock(app.slug, () =>
    pushLocked({ ...args, reason, app, ownerUserId: app.ownerUserId!, byUsername: staff.username })
  );
  if (!result)
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'The app’s source repo is busy; try again shortly',
    });

  log('info', 'pushed', {
    updateId: result.id,
    slug: result.slug,
    appBlockId: app.id,
    staffUserId: args.staffUserId,
    commitSha: result.commitSha,
    branch: result.branch,
    seededSourceRepo: result.seededSourceRepo,
    paths: result.paths.length,
  });

  // Best-effort and after the record: an outage costs the notification, never the record.
  try {
    await notifyOwner({
      ownerUserId: app.ownerUserId,
      slug: app.slug,
      updateId: result.id,
      byUsername: staff.username ?? 'Civitai staff',
      reason,
      touchesManifest: result.touchesManifest,
    });
  } catch (err) {
    log('warning', 'owner notification failed', {
      updateId: result.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return result;
}

async function pushLocked(args: {
  staffUserId: number;
  reason: string;
  changes: PlatformUpdateChange[];
  app: ResolvedApp;
  ownerUserId: number;
  byUsername: string | null;
}): Promise<PushPlatformUpdateResult> {
  const { app } = args;
  const repo = await import('~/server/services/blocks/app-source-repo.service');
  const read = await repo.readSourceRepo(app.slug);
  if (!read.available) throw unavailable();

  let row = read.row;
  let seeded = false;
  if (!row) {
    const seed = await repo.seedSourceRepoFromBuildRepoLocked({
      slug: app.slug,
      appBlockId: app.id,
      ownerUserId: args.ownerUserId,
    });
    if (seed.kind === 'no-approved-version')
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'The app has no source repo and no approved version to create one from',
      });
    if (seed.kind === 'unavailable') throw unavailable();
    if (seed.kind === 'refused')
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'The app’s source repo could not be created; try again',
      });
    row = seed.row;
    seeded = seed.kind === 'created';
  }
  // A repo under the slug that is not this app's (someone else's fork or assistant app took the
  // slug before this block existed) is never written for it.
  if ((await repo.sourceRepoGoverningBlockId(row)) !== app.id)
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'The source repo under this slug belongs to a different app',
    });

  const forgejo = await import('~/server/services/blocks/forgejo.service');
  const base = await forgejo.getBranchHead(FORGEJO_SOURCE_ORG, app.slug, SOURCE_MAIN_BRANCH);
  if (!base)
    throw new TRPCError({ code: 'CONFLICT', message: 'The app’s source repo has no main branch' });
  const current = treeFromMap(await forgejo.listRepoTreeAtRef(app.slug, base, FORGEJO_SOURCE_ORG));
  let plan: ReturnType<typeof planPlatformUpdateCommit>;
  try {
    plan = planPlatformUpdateCommit(current, args.changes);
  } catch (err) {
    if (err instanceof PlatformUpdatePlanError)
      throw new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });
    throw err;
  }
  if (!plan.operations.length)
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'The update changes nothing: main already holds every file as given',
    });

  const id = newAppPlatformUpdateId();
  const branch = platformUpdateBranch(id);
  const commit = await forgejo.commitOperations({
    org: FORGEJO_SOURCE_ORG,
    slug: app.slug,
    branch: SOURCE_MAIN_BRANCH,
    newBranch: branch,
    operations: plan.operations,
    message: platformUpdateCommitMessage({
      plan,
      updateId: id,
      byUsername: args.byUsername,
      reason: args.reason,
    }),
    author: PLATFORM_AUTHOR,
  });
  if (commit.kind === 'conflict')
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'The app’s source repo changed while the update was written; try again',
    });

  const paths: PlatformUpdatePath[] = [
    ...plan.added.map((path) => ({ path, operation: 'create' as const })),
    ...plan.updated.map((path) => ({ path, operation: 'update' as const })),
    ...plan.deleted.map((path) => ({ path, operation: 'delete' as const })),
  ];
  const touchesManifest = await updateTouchesManifest({
    slug: app.slug,
    current,
    changedPaths: paths.map((p) => p.path),
  });
  // The commit's ACTUAL parent: `main` may have moved between the read above and the write (the
  // compare-and-set refuses only a change to a file this update touches).
  const parent = await commitParent(app.slug, commit.sha);
  const baseCommitSha = parent ?? base;
  try {
    await dbWrite.$executeRaw`INSERT INTO "app_platform_updates"
        ("id", "app_block_id", "slug", "staff_user_id", "reason", "branch", "base_commit_sha",
         "commit_sha", "paths", "touches_manifest", "seeded_source_repo", "status")
      VALUES (${id}, ${app.id}, ${app.slug}, ${args.staffUserId}, ${args.reason}, ${branch},
              ${baseCommitSha}, ${commit.sha}, ${JSON.stringify(paths)}::jsonb,
              ${touchesManifest}, ${seeded}, 'pending')`;
  } catch (err) {
    // The branch exists but nothing lists it: unrecorded, it is never offered to the owner.
    log('error', 'record failed after commit', {
      updateId: id,
      slug: app.slug,
      branch,
      commitSha: commit.sha,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
  return {
    id,
    slug: app.slug,
    branch,
    commitSha: commit.sha,
    baseCommitSha,
    seededSourceRepo: seeded,
    paths,
    touchesManifest,
  };
}

/** The first parent of `sha` in the slug's source repo; `null` (logged) when it cannot be read. */
async function commitParent(slug: string, sha: string): Promise<string | null> {
  const forgejo = await import('~/server/services/blocks/forgejo.service');
  try {
    return (await forgejo.getCommitParents(FORGEJO_SOURCE_ORG, slug, sha))[0] ?? null;
  } catch (err) {
    log('warning', 'could not read the update commit back; recording main as read', {
      slug,
      commitSha: sha,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * The storage hook files `manifest` declares (`storage.collections.<name>.hook.file`), as repo
 * paths. Read from the RAW declaration, valid or not, as the push path's hook pin does.
 */
async function declaredHookFiles(manifest: unknown): Promise<Set<string>> {
  const { declaredStorageHookCollections } = await import('~/server/services/apps/storage-hooks');
  const files = new Set<string>();
  for (const { raw } of declaredStorageHookCollections(manifest)) {
    const file =
      raw && typeof raw === 'object' && typeof (raw as { file?: unknown }).file === 'string'
        ? (raw as { file: string }).file
        : null;
    if (file) files.add(file.replace(/^\.\//, ''));
  }
  return files;
}

/**
 * Whether the update changes what the app may do: `block.manifest.json` itself (scopes,
 * permissions, storage declarations), or a storage hook file the manifest on `main` declares (the
 * manifest is unchanged in that case, so `main`'s is the branch's). A manifest that cannot be read
 * or parsed answers `true`: the owner is told to look rather than told it is safe.
 */
async function updateTouchesManifest(args: {
  slug: string;
  current: Record<string, string>;
  changedPaths: string[];
}): Promise<boolean> {
  if (args.changedPaths.includes(MANIFEST_PATH)) return true;
  const manifestBlob = args.current[MANIFEST_PATH];
  if (!manifestBlob) return false;
  let manifest: unknown;
  try {
    const forgejo = await import('~/server/services/blocks/forgejo.service');
    const bytes = await forgejo.getBlobContent(args.slug, manifestBlob, FORGEJO_SOURCE_ORG);
    manifest = JSON.parse(bytes.toString('utf8'));
  } catch (err) {
    log('warning', 'could not read the manifest to classify an update', {
      slug: args.slug,
      error: err instanceof Error ? err.message : String(err),
    });
    return true;
  }
  const hooks = await declaredHookFiles(manifest);
  return args.changedPaths.some((p) => hooks.has(p));
}

async function notifyOwner(opts: {
  ownerUserId: number;
  slug: string;
  updateId: string;
  byUsername: string;
  reason: string;
  touchesManifest: boolean;
}): Promise<void> {
  const [{ createNotification }, { NotificationCategory }] = await Promise.all([
    import('~/server/services/notification.service'),
    import('~/server/common/enums'),
  ]);
  await createNotification({
    userId: opts.ownerUserId,
    category: NotificationCategory.System,
    type: 'app-platform-update',
    key: `app-platform-update:${opts.updateId}`,
    details: {
      slug: opts.slug,
      updateId: opts.updateId,
      byUsername: opts.byUsername,
      reason: opts.reason,
      touchesManifest: opts.touchesManifest,
    },
  });
}

/** A moderator withdraws an update that is still pending (or conflicted): `superseded`. */
export async function supersedePlatformUpdate(args: {
  staffUserId: number;
  id: string;
}): Promise<{ id: string; status: 'superseded' }> {
  // The primary: an update pushed moments ago may not have reached the replica.
  const rows = await readRows({ kind: 'id', id: args.id }, dbWrite);
  if (rows === null) throw unavailable();
  const row = rows[0];
  if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Update not found' });
  if (row.status === 'superseded') return { id: row.id, status: 'superseded' };
  const changed = Number(
    await dbWrite.$executeRaw`UPDATE "app_platform_updates"
        SET "status" = 'superseded', "resolved_by_user_id" = ${args.staffUserId},
            "resolved_at" = now(), "updated_at" = now()
      WHERE "id" = ${row.id} AND "status" IN ('pending', 'conflicted')`
  );
  if (changed !== 1)
    throw new TRPCError({ code: 'CONFLICT', message: `This update is already ${row.status}` });
  log('info', 'superseded', { updateId: row.id, slug: row.slug, staffUserId: args.staffUserId });
  return { id: row.id, status: 'superseded' };
}

/** Every update to an app, newest first, for staff. */
export async function listPlatformUpdatesForModerator(args: {
  app: AppRef;
}): Promise<Array<OwnerPlatformUpdate & { staffUserId: number; mergeCommitSha: string | null }>> {
  const app = await resolveApp(args.app);
  if (!app) throw APP_NOT_FOUND();
  const rows = await readRows({ kind: 'all-for-app', appBlockId: app.id });
  return (rows ?? []).map((r) => ({
    ...ownerView(r),
    staffUserId: r.staffUserId,
    mergeCommitSha: r.mergeCommitSha,
  }));
}
