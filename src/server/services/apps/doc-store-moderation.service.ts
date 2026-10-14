// App Blocks document store — the MODERATOR takedown surface: a cross-app queue of
// reported shared documents, a read of one document, hide / unhide, and hard delete.
// Served by `apps.mod.docStore.*` (`apps-mod-doc-store.router.ts`, session
// `moderatorProcedure`); no block-token route reaches it.
//
// HOW A CROSS-APP ACTION WORKS UNDER THE STORE'S RLS. The store connects as a
// least-privilege role that row-level security binds, and every transaction is bound to
// ONE (app, namespace). So nothing here spans apps in SQL: the queue enumerates the
// on-platform apps from the main database and asks the store once per app, each in its
// own transaction bound to that app, then merges the pages in TypeScript on a keyset
// that includes the app id. A hide or delete names exactly one app and runs in that
// app's transaction, so it cannot touch another app's rows — the module's `$1`/`$2`
// predicates and RLS each refuse it independently. The cost is one transaction per app
// per queue page (bounded by `MOD_APP_CONCURRENCY` at a time).
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
  ModeratedDocPosition,
  ModeratedDocSort,
  ModeratedDocStatus,
  ReportedDocRow,
} from '~/server/services/apps/doc-store';
import { getDocStore } from '~/server/services/apps/doc-store.instance';
import { isDocStoreError } from '~/server/services/apps/doc-store.types';
import { newAppListingModerationEventId } from '~/server/utils/app-block-ids';

/** The namespace moderators act in. */
export const MOD_NS = 'prod';

/** Per-app store transactions in flight at once while building a queue page. */
export const MOD_APP_CONCURRENCY = 4;

export const DOC_STORE_MOD_ACTIONS = {
  hide: 'storage-doc-hide',
  unhide: 'storage-doc-unhide',
  delete: 'storage-doc-delete',
} as const;

export class DocStoreModerationError extends Error {
  constructor(
    readonly kind: 'app_not_found' | 'doc_not_found' | 'invalid_cursor' | 'version_conflict'
  ) {
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

// ---------------------------------------------------------------------------
// Cursor: base64url JSON of the last row's keyset position plus the sort it was issued for.
// ---------------------------------------------------------------------------

function encodeCursor(sort: ModeratedDocSort, pos: ModeratedDocPosition): string {
  return Buffer.from(JSON.stringify({ s: sort, ...pos }), 'utf8').toString('base64url');
}

function decodeCursor(sort: ModeratedDocSort, cursor: string): ModeratedDocPosition {
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      v?.s === sort &&
      typeof v.sortValue === 'string' &&
      typeof v.appId === 'string' &&
      typeof v.collection === 'string' &&
      typeof v.key === 'string'
    ) {
      return { sortValue: v.sortValue, appId: v.appId, collection: v.collection, key: v.key };
    }
  } catch {
    // fall through
  }
  throw new DocStoreModerationError('invalid_cursor');
}

/** Descending on `(sortValue, appId, collection, key)` — the order each per-app page is in. */
function compareDesc(a: ModeratedDocPosition, b: ModeratedDocPosition): number {
  const av = BigInt(a.sortValue);
  const bv = BigInt(b.sortValue);
  if (av !== bv) return av > bv ? -1 : 1;
  for (const f of ['appId', 'collection', 'key'] as const) {
    if (a[f] !== b[f]) return a[f] > b[f] ? -1 : 1;
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
  lastReportedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  author: { kind: ReportedDocRow['authorKind']; userId: number | null; username: string | null };
  hidden: { at: Date; byUserId: number | null; byUsername: string | null } | null;
  sizeBytes: number;
  /** Pass back on an action so it refuses if the document changed since this row was read. */
  version: number;
};

/**
 * Reported shared documents across apps (or one app), most-reported or most recently
 * reported first, keyset-paginated across apps.
 */
export async function listReportedDocs(input: {
  appBlockId?: string;
  status: ModeratedDocStatus;
  sort: ModeratedDocSort;
  limit: number;
  cursor?: string;
}): Promise<{ items: ReportedDocItem[]; nextCursor: string | null }> {
  const after = input.cursor ? decodeCursor(input.sort, input.cursor) : undefined;
  const apps = input.appBlockId ? [await resolveApp(input.appBlockId)] : await allApps();
  const store = getDocStore();
  // Each app's page holds at most `limit + 1` rows after the cursor, so the merged top
  // `limit` is exact and one extra row in the union means there is a next page.
  const limit = pLimit(MOD_APP_CONCURRENCY);
  const perApp = await Promise.all(
    apps.map((app) =>
      limit(async () =>
        (
          await store.moderation.listReported(app.appBlockId, MOD_NS, {
            sort: input.sort,
            status: input.status,
            after,
            limit: input.limit + 1,
          })
        ).map((row) => ({ app, row, pos: { ...row, appId: app.appBlockId } }))
      )
    )
  );
  const merged = perApp.flat().sort((a, b) => compareDesc(a.pos, b.pos));
  const page = merged.slice(0, input.limit);
  const names = await usernames(page.flatMap(({ row }) => [row.authorUid, row.hiddenBy]));
  const last = page[page.length - 1];
  return {
    items: page.map(({ app, row }) => ({
      appBlockId: app.appBlockId,
      appSlug: app.slug,
      collection: row.collection,
      key: row.key,
      reports: row.reports,
      lastReportedAt: row.lastReportedAt,
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
    })),
    nextCursor:
      merged.length > input.limit && last
        ? encodeCursor(input.sort, {
            sortValue: last.pos.sortValue,
            appId: last.pos.appId,
            collection: last.pos.collection,
            key: last.pos.key,
          })
        : null,
  };
}

export type ModeratedDocView = Omit<ModeratedDoc, 'authorUid' | 'hiddenAt' | 'hiddenBy'> & {
  appBlockId: string;
  appSlug: string;
  author: ReportedDocItem['author'];
  hidden: ReportedDocItem['hidden'];
};

async function readDoc(app: AppIdentity, collection: string, key: string): Promise<ModeratedDoc> {
  const doc = await getDocStore().moderation.get(app.appBlockId, MOD_NS, collection, key);
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
 * The action is bound to the snapshot's version (and to `expectedVersion`, the version the
 * moderator saw, when given): the store refuses under its row lock if the document changed,
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
    expectedVersion?: number;
  },
  run: (ifVersion: number) => Promise<T>
): Promise<T & { auditEventId: string }> {
  const { app, collection, key } = args;
  // The snapshot is what the moderator acted on; a missing or changed document refuses the
  // action before any audit row exists.
  const before = await readDoc(app, collection, key);
  if (args.expectedVersion !== undefined && args.expectedVersion !== before.version) {
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
        reports: before.reports,
        hiddenAt: before.hiddenAt?.toISOString() ?? null,
        hiddenBy: before.hiddenBy,
        version: before.version,
        sizeBytes: before.sizeBytes,
        dataMd5: before.dataMd5,
      } as Prisma.InputJsonValue,
    },
  });
  let result: T;
  try {
    result = await run(before.version);
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
  version?: number;
}) {
  const app = await resolveApp(input.appBlockId);
  return audited(
    { ...input, app, action: input.hidden ? 'hide' : 'unhide', expectedVersion: input.version },
    async (ifVersion) =>
      getDocStore().moderation.setHidden(
        app.appBlockId,
        MOD_NS,
        input.collection,
        input.key,
        input.hidden,
        input.actorUserId,
        { ifVersion }
      )
  );
}

/** Hard-delete one shared document (irreversible). */
export async function deleteModeratedDoc(input: {
  actorUserId: number;
  appBlockId: string;
  collection: string;
  key: string;
  reason: string;
  version?: number;
}) {
  const app = await resolveApp(input.appBlockId);
  return audited(
    { ...input, app, action: 'delete', expectedVersion: input.version },
    async (ifVersion) =>
      getDocStore().moderation.delete(app.appBlockId, MOD_NS, input.collection, input.key, {
        ifVersion,
      })
  );
}
