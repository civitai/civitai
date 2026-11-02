import { BLOCKED_IMAGE_RETENTION_DAYS } from '@civitai/shared/job-queue';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { purgeViewerDocuments } from '~/server/services/apps/doc-store-purge';
import type { DocStoreMaintenance } from '~/server/services/apps/doc-store';
import { isDocStoreError } from '~/server/services/apps/doc-store.types';
import { isAccountUnderLegalHold } from '~/server/services/legal-hold.service';
import type { JobContext } from './job';
import { createJob } from './job';

/**
 * APP-DATA REMOVAL FOR DELETED ACCOUNTS — the background half of "Also delete my data in apps"
 * on account deletion (`deleteUser`, `removeAppData`: the self-serve card and the moderator
 * `user.delete` endpoint).
 *
 * The deletion records the request in `User.meta.appDataRemoval = 'requested'`, in the same
 * transaction that deletes the account, so the request exists exactly when the deletion
 * committed. This job wipes each such account's App Blocks document-store data in every app
 * (`purgeViewerDocuments`: private documents, the shared documents they authored, their marks
 * and usage; see `doc-store-purge.ts`), then removes the marker. Without the box nothing is wiped
 * and a restore brings the account back with its app data.
 *
 * GRACE: an account is wiped only once `APP_DATA_REMOVAL_GRACE_DAYS` (the 7 days a grace-deleted
 * account's images are kept) have passed since its deletion. A restore inside the grace drops the
 * request (`restoreUser`), and a legal hold placed inside it keeps the account out for as long
 * as the hold stands.
 *
 * Every check that can stop a wipe is made on the PRIMARY immediately before it and again before
 * every namespace of it (`proceed`): still deleted, still requested, past the grace, not under a
 * legal hold (an unreadable hold counts as a hold). A restore or a hold that lands mid-wipe stops
 * it before the next namespace. Only the worklist comes from the replica: an account it has not
 * caught up on waits for a later run.
 *
 * NEVER STALLS: the worklist is read in keyset pages of (`deletedAt`, id) from a cursor kept
 * between runs, so held and failing accounts are passed over rather than filling every run; the
 * cursor returns to the start after the last page, and they are retried then. Skipped, marker
 * kept: an account under a hold, and one whose wipe failed or left a namespace failed.
 * Idempotent: a wipe only removes what is still there.
 *
 * Optional index (manual migration `20261219120000_user_app_data_removal_idx`) matching the
 * worklist's predicate and order; without it the worklist reads the deleted accounts instead.
 */

/** Days after the deletion before the data goes; the same grace as a grace-deleted account's images. */
export const APP_DATA_REMOVAL_GRACE_DAYS = BLOCKED_IMAGE_RETENTION_DAYS;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Wipes attempted per run at most (successful or failed); a backlog drains over several runs. */
export const APP_DATA_REMOVAL_BATCH = 25;
/** Accounts looked at per run at most, held ones included. */
export const APP_DATA_REMOVAL_SCAN = 200;
const PAGE = 50;

/** `KeyValue` row holding where the next run continues the worklist. */
export const APP_DATA_REMOVAL_CURSOR_KEY = 'remove-deleted-account-app-data-cursor';

/**
 * A worklist position. `deletedAt` is the column's own text form (`::text`), so a round trip
 * through JSON and back into SQL is exact and does not depend on any time zone.
 */
type Cursor = { deletedAt: string; id: number };
const START: Cursor = { deletedAt: '-infinity', id: 0 };

export type RemoveDeletedAccountAppDataResult = {
  /** Accounts carrying the request, past the grace, that the run looked at. */
  scanned: number;
  wiped: number;
  /** Held, or the hold could not be read: left for a later run. */
  held: number;
  /** Restored or put under a hold DURING the wipe: stopped before its next namespace. */
  stopped: number;
  /** The wipe failed or left a namespace failed; retried after the cursor comes round. */
  failed: number;
  /** Rows the wipes removed: documents (private + authored shared) and marks. */
  docs: number;
};

async function readCursor(): Promise<Cursor> {
  const row = await dbWrite.keyValue.findUnique({ where: { key: APP_DATA_REMOVAL_CURSOR_KEY } });
  const v = (row?.value ?? null) as unknown as Partial<Cursor> | null;
  if (v && typeof v.deletedAt === 'string' && Number.isSafeInteger(v.id)) {
    return { deletedAt: v.deletedAt, id: v.id as number };
  }
  return START;
}

async function writeCursor(cursor: Cursor): Promise<void> {
  await dbWrite.keyValue.upsert({
    where: { key: APP_DATA_REMOVAL_CURSOR_KEY },
    create: { key: APP_DATA_REMOVAL_CURSOR_KEY, value: cursor },
    update: { value: cursor },
  });
}

/** The next page of the worklist after `after`, from the replica. */
async function worklistPage(after: Cursor, cutoff: Date, limit: number): Promise<Cursor[]> {
  return dbRead.$queryRaw<Cursor[]>`
    SELECT u.id, u."deletedAt"::text AS "deletedAt" FROM "User" u
    WHERE u.meta->>'appDataRemoval' = 'requested'
      AND u."deletedAt" <= ${cutoff}
      AND (
        u."deletedAt" > ${after.deletedAt}::timestamp(3)
        OR (u."deletedAt" = ${after.deletedAt}::timestamp(3) AND u.id > ${after.id})
      )
    ORDER BY u."deletedAt", u.id
    LIMIT ${limit}
  `;
}

/** Still deleted, still requested and past the grace, on the PRIMARY. */
async function stillRequested(userId: number, cutoff: Date): Promise<boolean> {
  const [row] = await dbWrite.$queryRaw<{ requested: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM "User" u
      WHERE u.id = ${userId}
        AND u."deletedAt" <= ${cutoff}
        AND u.meta->>'appDataRemoval' = 'requested'
    ) AS requested
  `;
  return row?.requested === true;
}

/** Why an account must not be wiped right now, or null when it may be. */
async function blocker(userId: number, cutoff: Date): Promise<'held' | 'withdrawn' | null> {
  // `null` (the hold could not be read) blocks like a hold.
  if ((await isAccountUnderLegalHold(userId)) !== false) return 'held';
  if (!(await stillRequested(userId, cutoff))) return 'withdrawn';
  return null;
}

/** Wipes one account, re-checking it before every namespace, and counts the outcome. */
async function wipeOne(
  id: number,
  cutoff: Date,
  store: DocStoreMaintenance | undefined,
  result: RemoveDeletedAccountAppDataResult
): Promise<void> {
  try {
    const out = await purgeViewerDocuments(id, {
      store,
      proceed: async () => (await blocker(id, cutoff)) === null,
    });
    result.docs += out.namespaces.reduce(
      (sum, ns) => sum + ns.privateDocs + ns.sharedDocs + ns.marks + ns.namespaceRows,
      0
    );
    if (out.stopped) {
      result.stopped += 1;
      return;
    }
    if (out.failures.length > 0) {
      result.failed += 1;
      logToAxiom(
        {
          name: 'remove-deleted-account-app-data',
          type: 'error',
          userId: id,
          message: `${out.failures.length} namespace(s) failed`,
          failures: out.failures.slice(0, 5),
        },
        'webhooks'
      ).catch(() => undefined);
      return;
    }
    // Only while still deleted: a restore that landed during the wipe already dropped it.
    await dbWrite.$executeRaw`
      UPDATE "User" SET meta = meta::jsonb - 'appDataRemoval'
      WHERE id = ${id} AND "deletedAt" IS NOT NULL
    `;
    result.wiped += 1;
  } catch (err) {
    // A disabled store fails every wipe alike; stop and keep every request for later.
    if (isDocStoreError(err, 'storage_disabled')) throw err;
    result.failed += 1;
    logToAxiom(
      {
        name: 'remove-deleted-account-app-data',
        type: 'error',
        userId: id,
        message: err instanceof Error ? err.message : String(err),
      },
      'webhooks'
    ).catch(() => undefined);
  }
}

export async function removeDeletedAccountAppData(
  opts: {
    store?: DocStoreMaintenance;
    now?: Date;
    batch?: number;
    scan?: number;
    jobContext?: Pick<JobContext, 'checkIfCanceled'>;
  } = {}
): Promise<RemoveDeletedAccountAppDataResult> {
  const batch = opts.batch ?? APP_DATA_REMOVAL_BATCH;
  const scan = opts.scan ?? APP_DATA_REMOVAL_SCAN;
  const cutoff = new Date(
    (opts.now ?? new Date()).getTime() - APP_DATA_REMOVAL_GRACE_DAYS * DAY_MS
  );
  const result: RemoveDeletedAccountAppDataResult = {
    scanned: 0,
    wiped: 0,
    held: 0,
    stopped: 0,
    failed: 0,
    docs: 0,
  };
  let cursor = await readCursor();
  try {
    for (;;) {
      const page = await worklistPage(cursor, cutoff, Math.min(PAGE, scan - result.scanned));
      if (page.length === 0) {
        // The end of the worklist: the next run starts again from the oldest deletion.
        cursor = START;
        return result;
      }
      for (const account of page) {
        opts.jobContext?.checkIfCanceled();
        const { id } = account;
        result.scanned += 1;
        const before = await blocker(id, cutoff);
        if (before === 'held') result.held += 1;
        if (before === null) await wipeOne(id, cutoff, opts.store, result);
        // Past this account only once it was handled: a throw (a disabled store, a cancel)
        // leaves the cursor before it, so the next run starts with it.
        cursor = account;
        if (result.wiped + result.failed + result.stopped >= batch || result.scanned >= scan) {
          return result;
        }
      }
    }
  } finally {
    await writeCursor(cursor);
  }
}

/**
 * Every 10 minutes: a request is acted on within minutes of its grace ending. When there is
 * nothing to do a run is one replica read over the requested accounts. FAIL-OPEN like the sibling
 * reapers: an error is logged and the next run retries.
 */
export const removeDeletedAccountAppDataJob = createJob(
  'remove-deleted-account-app-data',
  '*/10 * * * *',
  async (jobContext) => {
    try {
      const result = await removeDeletedAccountAppData({ jobContext });
      if (result.scanned > 0) {
        logToAxiom(
          { name: 'remove-deleted-account-app-data', type: 'info', ...result },
          'webhooks'
        ).catch(() => undefined);
      }
      return result;
    } catch (error) {
      if (isDocStoreError(error, 'storage_disabled')) return { disabled: true as const };
      logToAxiom(
        {
          name: 'remove-deleted-account-app-data',
          type: 'error',
          message: (error as Error)?.message,
          stack: (error as Error)?.stack,
        },
        'webhooks'
      ).catch(() => undefined);
      return { error: true as const };
    }
  }
);
