// App Blocks document store — the MODERATOR takedown surface: a cross-app queue of
// reported shared documents, a read of one document, hide / unhide, and hard delete.
// Served by `apps.mod.docStore.*` (`apps-mod-doc-store.router.ts`, session
// `moderatorProcedure`); no block-token route reaches it.
//
// HOW A CROSS-APP ACTION WORKS UNDER THE STORE'S RLS. The store connects as a
// least-privilege role that row-level security binds, and every transaction is bound to
// ONE (app, namespace). So nothing here spans apps in SQL: the queue enumerates the
// on-platform apps from the main database and asks the store once per app for its first
// `MOD_QUEUE_PER_APP` reported documents, each in its own transaction bound to that app,
// then merges and sorts them in TypeScript and keeps the first `MOD_QUEUE_MAX`. There is
// no paging: when any app or the total was cut off the result says `truncated`. A hide
// or delete names exactly one app and runs in that app's transaction, so it cannot touch
// another app's rows — the module's `$1`/`$2` predicates and RLS each refuse it
// independently. The cost is one transaction per app per queue read (bounded by
// `MOD_APP_CONCURRENCY` at a time).
//
// Only the production namespace is moderated. `dev:<uid>` namespaces are a developer's
// own sandbox, and `rev:` namespaces belong to a pending review.
//
// AUDIT. Every hide, unhide and delete writes an `AppListingModerationEvent` BEFORE it
// changes anything — the same rail and the same order as the per-user storage purge
// (`user-storage-purge.service.ts`): a missing audit row means the action did not run,
// never that it ran unrecorded. The row records a content fingerprint (md5 + size),
// never the document's data. `after` is stamped once the store call returns.
//
// Reading a document is not audited: a shared document is readable by every viewer of
// the app, so a moderator reading it reads nothing private.
import type { Prisma } from '@prisma/client';
import pLimit from 'p-limit';
import { dbRead, dbWrite } from '~/server/db/client';
import type {
  ModeratedDoc,
  ModeratedDocStatus,
  ReportedDocRow,
} from '~/server/services/apps/doc-store';
import { logToAxiom } from '~/server/logging/client';
import { PUBLISHED_NS } from '~/server/services/apps/doc-store';
import { getDocStoreModeration } from '~/server/services/apps/doc-store-moderation.instance';
import { isDocStoreError } from '~/server/services/apps/doc-store.types';
import { syncStoreItem } from '~/server/services/blocks/app-sub-listing-sync';
import { newAppListingModerationEventId } from '~/server/utils/app-block-ids';

/** The namespace moderators act in. */
export const MOD_NS = PUBLISHED_NS;

/** Per-app store transactions in flight at once while building the queue. */
export const MOD_APP_CONCURRENCY = 4;
/** Reported documents read from each app. */
export const MOD_QUEUE_PER_APP = 50;
/** Reported documents returned in total. */
export const MOD_QUEUE_MAX = 200;

export const DOC_STORE_MOD_ACTIONS = {
  hide: 'storage-doc-hide',
  unhide: 'storage-doc-unhide',
  delete: 'storage-doc-delete',
  dismiss: 'storage-doc-dismiss',
} as const;

export class DocStoreModerationError extends Error {
  constructor(readonly kind: 'app_not_found' | 'doc_not_found' | 'version_conflict') {
    super(kind);
    this.name = 'DocStoreModerationError';
  }
}

type AppIdentity = { appBlockId: string; slug: string; appListingId: string | null };

const blockSelect = {
  id: true,
  blockId: true,
  appListing: { select: { id: true, slug: true } },
} as const;

function toIdentity(b: {
  id: string;
  blockId: string;
  appListing: { id: string; slug: string } | null;
}): AppIdentity {
  // For an on-site listing `AppListing.slug` IS `AppBlock.blockId`; the fallback covers
  // a block with no listing row.
  return {
    appBlockId: b.id,
    slug: b.appListing?.slug ?? b.blockId,
    appListingId: b.appListing?.id ?? null,
  };
}

async function resolveApp(appBlockId: string): Promise<AppIdentity> {
  const block = await dbRead.appBlock.findUnique({
    where: { id: appBlockId },
    select: blockSelect,
  });
  if (!block) throw new DocStoreModerationError('app_not_found');
  return toIdentity(block);
}

/** Every on-platform app (an off-site listing has no storage), in a stable order. */
async function allApps(): Promise<AppIdentity[]> {
  const blocks = await dbRead.appBlock.findMany({
    where: { externalUrl: null },
    select: blockSelect,
    orderBy: { id: 'asc' },
  });
  return blocks.map(toIdentity);
}

/**
 * The queue order across apps — most reports, then most recently updated, then app,
 * collection and key — the same order each app's rows arrive in (`MOD_QUEUE_ORDER`).
 */
function compareQueue(
  a: { appId: string; row: ReportedDocRow },
  b: { appId: string; row: ReportedDocRow }
): number {
  if (a.row.reports !== b.row.reports) return b.row.reports - a.row.reports;
  const t = b.row.updatedAt.getTime() - a.row.updatedAt.getTime();
  if (t !== 0) return t;
  for (const [x, y] of [
    [a.appId, b.appId],
    [a.row.collection, b.row.collection],
    [a.row.key, b.row.key],
  ]) {
    if (x !== y) return x > y ? -1 : 1;
  }
  return 0;
}

async function usernames(ids: (number | null)[]): Promise<Map<number, string | null>> {
  const unique = [...new Set(ids.filter((id): id is number => id !== null))];
  if (unique.length === 0) return new Map();
  const users = await dbRead.user.findMany({
    where: { id: { in: unique } },
    select: { id: true, username: true },
  });
  return new Map(users.map((u) => [u.id, u.username]));
}

export type ReportedDocItem = {
  appBlockId: string;
  appSlug: string;
  collection: string;
  key: string;
  reports: number;
  createdAt: Date;
  updatedAt: Date;
  author: { kind: ReportedDocRow['authorKind']; userId: number | null; username: string | null };
  hidden: { at: Date; byUserId: number | null; byUsername: string | null } | null;
  sizeBytes: number;
  version: number;
  /** Pass back on an action so it refuses if the document changed since this row was read. */
  revision: number;
};

/**
 * Documents with open reports across every app, most reported first. Not paged: at most
 * `MOD_QUEUE_PER_APP` per app and `MOD_QUEUE_MAX` in total; `truncated` says either cap cut
 * something off. An app whose read fails is skipped and counted in `failedApps` (and logged),
 * so one bad app never hides every other app's reports. `storage_disabled` is not per-app and
 * propagates.
 */
export async function listReportedDocs(input: {
  status: ModeratedDocStatus;
}): Promise<{ items: ReportedDocItem[]; truncated: boolean; failedApps: number }> {
  const apps = await allApps();
  const mod = getDocStoreModeration();
  const limit = pLimit(MOD_APP_CONCURRENCY);
  const perApp = await Promise.all(
    apps.map((app) =>
      limit(async () => {
        try {
          // One more than kept, to know whether this app was cut off.
          const rows = await mod.listReported(app.appBlockId, MOD_NS, {
            status: input.status,
            limit: MOD_QUEUE_PER_APP + 1,
          });
          return {
            failed: false,
            cut: rows.length > MOD_QUEUE_PER_APP,
            rows: rows
              .slice(0, MOD_QUEUE_PER_APP)
              .map((row) => ({ app, appId: app.appBlockId, row })),
          };
        } catch (err) {
          // Storage as a whole being off (no pool, or a role RLS does not bind) is not one
          // app's failure: it surfaces as such, never as "N apps could not be read".
          if (isDocStoreError(err, 'storage_disabled')) throw err;
          logToAxiom(
            {
              type: 'error',
              event: 'doc_store_mod_queue_app_failed',
              appBlockId: app.appBlockId,
              error: err instanceof Error ? err.message : String(err),
            },
            'app-blocks'
          ).catch(() => undefined);
          return { failed: true, cut: false, rows: [] };
        }
      })
    )
  );
  const merged = perApp.flatMap((p) => p.rows).sort(compareQueue);
  const page = merged.slice(0, MOD_QUEUE_MAX);
  const names = await usernames(page.flatMap(({ row }) => [row.authorUid, row.hiddenBy]));
  return {
    items: page.map(({ app, row }) => ({
      appBlockId: app.appBlockId,
      appSlug: app.slug,
      collection: row.collection,
      key: row.key,
      reports: row.reports,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      author: {
        kind: row.authorKind,
        userId: row.authorUid,
        username: row.authorUid === null ? null : names.get(row.authorUid) ?? null,
      },
      hidden: row.hiddenAt
        ? {
            at: row.hiddenAt,
            byUserId: row.hiddenBy,
            byUsername: row.hiddenBy === null ? null : names.get(row.hiddenBy) ?? null,
          }
        : null,
      sizeBytes: row.sizeBytes,
      version: row.version,
      revision: row.revision,
    })),
    truncated: merged.length > MOD_QUEUE_MAX || perApp.some((p) => p.cut),
    failedApps: perApp.filter((p) => p.failed).length,
  };
}

export type ModeratedDocView = Omit<ModeratedDoc, 'authorUid' | 'hiddenAt' | 'hiddenBy'> & {
  appBlockId: string;
  appSlug: string;
  author: ReportedDocItem['author'];
  hidden: ReportedDocItem['hidden'];
};

async function readDoc(app: AppIdentity, collection: string, key: string): Promise<ModeratedDoc> {
  const doc = await getDocStoreModeration().get(app.appBlockId, MOD_NS, collection, key);
  if (!doc) throw new DocStoreModerationError('doc_not_found');
  return doc;
}

/** One shared document, hidden or not, including its data. */
export async function getModeratedDoc(input: {
  appBlockId: string;
  collection: string;
  key: string;
}): Promise<ModeratedDocView> {
  const app = await resolveApp(input.appBlockId);
  const { authorUid, hiddenAt, hiddenBy, ...doc } = await readDoc(app, input.collection, input.key);
  const names = await usernames([authorUid, hiddenBy]);
  return {
    ...doc,
    appBlockId: app.appBlockId,
    appSlug: app.slug,
    author: {
      kind: doc.authorKind,
      userId: authorUid,
      username: authorUid === null ? null : names.get(authorUid) ?? null,
    },
    hidden: hiddenAt
      ? {
          at: hiddenAt,
          byUserId: hiddenBy,
          byUsername: hiddenBy === null ? null : names.get(hiddenBy) ?? null,
        }
      : null,
  };
}

type ModAction = keyof typeof DOC_STORE_MOD_ACTIONS;

/**
 * Audit row first, then the store call, then the outcome stamp. A store refusal
 * (`DocStoreError`, raised inside the transaction before COMMIT) is recorded as
 * `failed`; any other error as `unknown`, because it may have struck after COMMIT.
 *
 * The action is bound to the snapshot's revision (and to `expectedRevision`, the revision
 * the moderator saw, when given): the store refuses under its row lock if the document changed,
 * so what the audit row describes is exactly what was hidden or deleted.
 */
async function audited<T extends Record<string, unknown>>(
  args: {
    action: ModAction;
    actorUserId: number;
    reason: string;
    app: AppIdentity;
    collection: string;
    key: string;
    expectedRevision?: number;
  },
  run: (ifRevision: number) => Promise<T>,
  /** Awaited once the action has applied, with the snapshot it acted on. */
  applied?: (before: ModeratedDoc) => Promise<void>
): Promise<T & { auditEventId: string }> {
  const { app, collection, key } = args;
  // The snapshot is what the moderator acted on; a missing or changed document refuses the
  // action before any audit row exists.
  const before = await readDoc(app, collection, key);
  if (args.expectedRevision !== undefined && args.expectedRevision !== before.revision) {
    throw new DocStoreModerationError('version_conflict');
  }
  const id = newAppListingModerationEventId();
  await dbWrite.appListingModerationEvent.create({
    data: {
      id,
      appListingId: app.appListingId,
      slug: app.slug,
      action: DOC_STORE_MOD_ACTIONS[args.action],
      actorUserId: args.actorUserId,
      reason: args.reason,
      detail: `${args.action} shared document ${collection}/${key} in ${app.slug}`,
      before: {
        appBlockId: app.appBlockId,
        ns: MOD_NS,
        collection,
        key,
        authorKind: before.authorKind,
        authorUserId: before.authorUid,
        // Open reports (after any dismissal) and every report ever filed.
        reports: before.reports,
        reportsTotal: before.marks.report ?? 0,
        hiddenAt: before.hiddenAt?.toISOString() ?? null,
        hiddenBy: before.hiddenBy,
        version: before.version,
        revision: before.revision,
        sizeBytes: before.sizeBytes,
        dataMd5: before.dataMd5,
        reportsDismissedAt: before.reportsDismissedAt?.toISOString() ?? null,
      } as Prisma.InputJsonValue,
    },
  });
  let result: T;
  try {
    result = await run(before.revision);
  } catch (err) {
    await dbWrite.appListingModerationEvent
      .update({
        where: { id },
        data: {
          after: {
            outcome: isDocStoreError(err) ? 'failed' : 'unknown',
            error: err instanceof Error ? err.message : String(err),
            failedAt: new Date().toISOString(),
          } as Prisma.InputJsonValue,
        },
      })
      .catch(() => undefined);
    if (isDocStoreError(err, 'not_found')) throw new DocStoreModerationError('doc_not_found');
    if (isDocStoreError(err, 'version_conflict')) {
      throw new DocStoreModerationError('version_conflict');
    }
    throw err;
  }
  // Best-effort: the action has happened; failing here would report that it had not.
  await dbWrite.appListingModerationEvent
    .update({
      where: { id },
      data: {
        after: {
          outcome: 'applied',
          ...result,
          completedAt: new Date().toISOString(),
        } as Prisma.InputJsonValue,
      },
    })
    .catch(() => undefined);
  await applied?.(before);
  return { ...result, auditEventId: id };
}

/** Hide or unhide one shared document (reversible). */
export async function setModeratedDocHidden(input: {
  actorUserId: number;
  appBlockId: string;
  collection: string;
  key: string;
  hidden: boolean;
  reason: string;
  revision?: number;
}) {
  const app = await resolveApp(input.appBlockId);
  return audited(
    { ...input, app, action: input.hidden ? 'hide' : 'unhide', expectedRevision: input.revision },
    async (ifRevision) =>
      getDocStoreModeration().setHidden(
        app.appBlockId,
        MOD_NS,
        input.collection,
        input.key,
        input.hidden,
        input.actorUserId,
        { ifRevision }
      ),
    // Unhide leaves the card as it is: a moderator restores it from the store queue, which
    // re-checks that the item is live.
    input.hidden ? (before) => hideStoreCard(app.appBlockId, before, input.actorUserId) : undefined
  );
}

/** Hard-delete one shared document (irreversible). */
export async function deleteModeratedDoc(input: {
  actorUserId: number;
  appBlockId: string;
  collection: string;
  key: string;
  reason: string;
  revision?: number;
}) {
  const app = await resolveApp(input.appBlockId);
  return audited(
    { ...input, app, action: 'delete', expectedRevision: input.revision },
    async (ifRevision) =>
      getDocStoreModeration().delete(app.appBlockId, MOD_NS, input.collection, input.key, {
        ifRevision,
      }),
    (before) => hideStoreCard(app.appBlockId, before, input.actorUserId)
  );
}

/**
 * Hides the card of the item the document is: its author's card for the key, also when the
 * document was already hidden. The same key in another collection may be another author's
 * item, so the author is part of the match; a document no user authored backs no card.
 */
async function hideStoreCard(
  appBlockId: string,
  doc: ModeratedDoc,
  moderatorId: number
): Promise<void> {
  if (doc.authorKind !== 'user' || doc.authorUid == null) return;
  await syncStoreItem({
    appBlockId,
    itemKey: doc.key,
    change: 'hidden',
    authorUserId: doc.authorUid,
    moderatorId,
  });
}

/** Dismiss the open reports on a document reviewed and kept; later reports re-open it. */
export async function dismissModeratedDocReports(input: {
  actorUserId: number;
  appBlockId: string;
  collection: string;
  key: string;
  reason: string;
  revision?: number;
}) {
  const app = await resolveApp(input.appBlockId);
  return audited(
    { ...input, app, action: 'dismiss', expectedRevision: input.revision },
    async (ifRevision) =>
      getDocStoreModeration().dismissReports(app.appBlockId, MOD_NS, input.collection, input.key, {
        ifRevision,
      })
  );
}
