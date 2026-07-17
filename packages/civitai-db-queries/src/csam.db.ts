import { type Kysely, type Selectable, type Updateable } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { toJson } from './infra/helpers';

// `CsamReport.type` enum, unwrapped from its `Generated<>` column so this module needs no separate enum import.
type CsamReportTypeValue = Selectable<DB['CsamReport']>['type'];

// A stored CsamReport row (all columns), with the jsonb `details`/`images` left opaque — the moderation
// transport layer (dropped from this package) owns their concrete shapes.
export type CsamReportRow = Selectable<DB['CsamReport']>;

// The `images` jsonb column stores one object per reported image so upload metadata can be appended later.
type CsamReportImageRef = { id: number };

// Insert a CsamReport for an in-app entity (image / generated image / training data). An "internal" report —
// `userId === -1`, Civitai's own trust-and-safety testing — is stored with a null reported user. The legacy
// image pHash/ClickHouse block that some callers ran alongside this insert is a side effect and is NOT ported
// here; this is the pure CsamReport write.
export function createCsamReport(
  db: Kysely<DB>,
  input: {
    reportedById: number;
    userId: number;
    type: CsamReportTypeValue;
    imageIds?: number[];
    details?: unknown;
  }
) {
  const isInternalReport = input.userId === -1;
  const reportedUserId = isInternalReport ? null : input.userId;
  const images: CsamReportImageRef[] = (input.imageIds ?? []).map((id) => ({ id }));

  return db
    .insertInto('CsamReport')
    .values({
      userId: reportedUserId,
      reportedById: input.reportedById,
      type: input.type,
      images: toJson(images),
      // Prisma omitted an undefined `details` so the column default (`{}`) applied; mirror that here.
      ...(input.details !== undefined ? { details: toJson(input.details) } : {}),
    })
    .returningAll()
    .executeTakeFirst();
}

// Drop nil values and empty arrays, mirroring the app's `removeEmpty` (removeEmptyStrings=false) that the
// service applies to the external-report details before storing them.
function removeEmpty<T extends Record<string, unknown>>(obj: T): T {
  return Object.fromEntries(
    Object.entries(obj).filter(
      ([, value]) => value != null && !(Array.isArray(value) && value.length === 0)
    )
  ) as T;
}

// Insert a CsamReport for an externally-hosted link/evidence report. `details` carries the moderator-entered
// external-report fields; empties are stripped before storage. `images` is always empty for this type.
export function createExternalCsamReport(
  db: Kysely<DB>,
  input: {
    reportedById: number;
    userId: number;
    details: Record<string, unknown>;
  }
) {
  return db
    .insertInto('CsamReport')
    .values({
      userId: input.userId,
      reportedById: input.reportedById,
      type: 'ExternalLink',
      details: toJson(removeEmpty(input.details)),
      images: toJson([]),
    })
    .returningAll()
    .executeTakeFirst();
}

export type CsamReportUser = { id: number; username: string | null };
export type CsamReportPagedRow = CsamReportRow & {
  user?: CsamReportUser;
  reportedBy?: CsamReportUser;
};

// A page of CsamReports, newest first, hydrated with the reported user and the reporting user (both resolved
// in one `User` read). Returns the page items plus the total count; the caller does the paging math.
export async function getCsamReportsPaged(
  db: Kysely<DB>,
  { limit, page }: { limit: number; page?: number }
): Promise<{ items: CsamReportPagedRow[]; count: number }> {
  const take = limit > 0 ? limit : undefined;
  const skip = page && take ? (page - 1) * take : undefined;

  let query = db.selectFrom('CsamReport').selectAll().orderBy('createdAt', 'desc');
  if (take !== undefined) query = query.limit(take);
  if (skip !== undefined) query = query.offset(skip);
  const reports = (await query.execute()) as CsamReportRow[];

  const userIds = [
    ...new Set(
      reports
        .flatMap((report) => [report.reportedById, report.userId])
        .filter((id): id is number => id != null)
    ),
  ];
  const users = userIds.length
    ? await db.selectFrom('User').select(['id', 'username']).where('id', 'in', userIds).execute()
    : [];

  const items: CsamReportPagedRow[] = reports.map((report) => ({
    ...report,
    user: users.find((u) => u.id === report.userId),
    reportedBy: users.find((u) => u.id === report.reportedById),
  }));

  const countRow = await db
    .selectFrom('CsamReport')
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .executeTakeFirst();

  return { items, count: Number(countRow?.count ?? 0) };
}

// Dashboard queue counts: reports still to be sent, sent-but-unarchived, and archived-but-content-not-removed.
export async function getCsamReportStats(
  db: Kysely<DB>
): Promise<{ unreported: number; unarchived: number; unremoved: number }> {
  const [unreported, unarchived, unremoved] = await Promise.all([
    db
      .selectFrom('CsamReport')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('reportSentAt', 'is', null)
      .executeTakeFirst(),
    db
      .selectFrom('CsamReport')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('reportSentAt', 'is not', null)
      .where('archivedAt', 'is', null)
      .executeTakeFirst(),
    db
      .selectFrom('CsamReport')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('reportSentAt', 'is not', null)
      .where('archivedAt', 'is not', null)
      .where('userId', 'is not', null)
      .where('contentRemovedAt', 'is', null)
      .executeTakeFirst(),
  ]);

  return {
    unreported: Number(unreported?.count ?? 0),
    unarchived: Number(unarchived?.count ?? 0),
    unremoved: Number(unremoved?.count ?? 0),
  };
}

// Queue read: reports awaiting submission to NCMEC (not yet sent).
export function getCsamsToReport(db: Kysely<DB>) {
  return db
    .selectFrom('CsamReport')
    .selectAll()
    .where('reportSentAt', 'is', null)
    .execute() as Promise<CsamReportRow[]>;
}

// Queue read: reports already sent but whose evidence has not yet been archived.
export function getCsamsToArchive(db: Kysely<DB>) {
  return db
    .selectFrom('CsamReport')
    .selectAll()
    .where('reportSentAt', 'is not', null)
    .where('archivedAt', 'is', null)
    .execute() as Promise<CsamReportRow[]>;
}

// Queue read: archived reports (with a known user) whose on-platform content still needs removal.
export function getCsamsToRemoveContent(db: Kysely<DB>) {
  return db
    .selectFrom('CsamReport')
    .selectAll()
    .where('reportSentAt', 'is not', null)
    .where('archivedAt', 'is not', null)
    .where('userId', 'is not', null)
    .where('contentRemovedAt', 'is', null)
    .execute() as Promise<CsamReportRow[]>;
}

// Generic single-CsamReport update by id. CsamReport has no `@updatedAt` column, so nothing is auto-stamped —
// pass every column to set (including a timestamp like `archivedAt`) explicitly. Prefer this over a narrow
// single-column setter; keep a named function only for a multi-column semantic transition or one needing a
// jsonb/CASE/proc expression. Returns the updated row.
export function updateCsamReport(
  db: Kysely<DB>,
  input: Updateable<DB['CsamReport']> & { id: number }
) {
  const { id, ...data } = input;
  return db
    .updateTable('CsamReport')
    .set(data)
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirst();
}

// The status-UPDATE core of `processCsamReport`: stamp the NCMEC-assigned report id and mark the report sent.
// Kept as a named setter: `reportId` + `reportSentAt` are one semantic "mark sent" transition (the NCMEC id is
// never assigned without simultaneously marking the report sent), not a single meaningful column plus a
// timestamp bump. The NCMEC build/submit/upload transport and the per-image `details` merge are side effects
// kept with the caller; this only persists the outcome.
export function setCsamReportSent(db: Kysely<DB>, input: { id: number; reportId: number }) {
  return db
    .updateTable('CsamReport')
    .set({ reportId: input.reportId, reportSentAt: new Date() })
    .where('id', '=', input.id)
    .execute();
}
