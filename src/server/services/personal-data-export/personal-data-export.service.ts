import { Prisma } from '@prisma/client';
import { env } from '~/env/server';
import { clickhouse } from '~/server/clickhouse/client';
import { dbWrite } from '~/server/db/client';
import { pgDbReadLong } from '~/server/db/pgDb';
import {
  personalDataExportBuiltEmail,
  personalDataExportHeldEmail,
  personalDataExportReadyEmail,
  personalDataExportRefusedEmail,
} from '~/server/email/templates/personalDataExport.email';
import { logToAxiom } from '~/server/logging/client';
import { accountHoldSql, getAccountLegalHold } from '~/server/services/legal-hold.service';
import { hasModeratorGrant } from '~/server/services/moderator-grants';
import { getServerStripe } from '~/server/utils/get-server-stripe';
import {
  RELEASE_WINDOW_SECONDS,
  deleteObjects,
  exportObjectKey,
  getExportBucket,
  presignDownload,
  putSmallObject,
  streamArchiveToBucket,
  type ExportBucket,
} from './archive';
import { redactNoteText } from './column-policy';
import { README_LINK_TEXT, fillCoverNote } from './cover-note';
import { csvLine, type Manifest, type ManifestFile } from './output';
import { exportClickhouse, type ClickhouseReader } from './sources/clickhouse';
import { exportWorkflows, type WorkflowCollection } from './sources/mongo';
import { IMAGE_SAFETY_CONDITION, exportPostgres, type PgNote } from './sources/postgres';
import { exportStripe, type StripeReader } from './sources/stripe';

export const EXPORT_STATUSES = [
  'queued',
  'building',
  'built',
  'held',
  'failed',
  'released',
] as const;
export type ExportStatus = (typeof EXPORT_STATUSES)[number];

/** Attempts before an export is marked failed. Each attempt writes a new object key. */
export const MAX_ATTEMPTS = 3;
/** A building row older than this was abandoned by a crashed run: it is retried or failed. */
export const STALE_BUILD_HOURS = 6;

const LOG = 'personal-data-export';

export type ExportRow = {
  id: number;
  userId: number;
  requestedById: number;
  status: ExportStatus;
  attempts: number;
  archiveKey: string | null;
  builtAt: Date | null;
  /** When the export was queued. */
  createdAt: Date;
  /** The help-desk ticket the request came in on, if any. */
  ticketId: number | null;
  /** The date the user asked, YYYY-MM-DD (a DATE read as text, so no time zone can move it). */
  requestedAt: string | null;
};

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e) ?? String(e);
  } catch {
    return String(e);
  }
}

/**
 * Who an export's link goes to, and the only place that decides it.
 *
 * - `built`: the staff member who queued it. Never the account owner: nothing reaches the owner
 *   without a person releasing it.
 * - `release`: the account owner's registered email, read fresh, and only that. Never a ticket's
 *   address, never the requester.
 */
export function exportRecipient(
  stage: 'built' | 'release',
  people: { requester: { email: string | null }; owner: { email: string | null } }
): string | null {
  const email = stage === 'built' ? people.requester.email : people.owner.email;
  return email?.trim() || null;
}

/** Back to queued for another attempt, or failed once the attempts are used. */
/** What the row says about a failed attempt: fixed text, since moderators read the row. */
export type FailureCategory = 'build failed' | 'build abandoned' | 'hold check failed';

export async function recordFailure(
  row: Pick<ExportRow, 'id' | 'attempts'>,
  category: FailureCategory,
  /** The underlying error, for the log and the alert only: it can carry data the row must not. */
  cause?: unknown
) {
  const next: ExportStatus = row.attempts >= MAX_ATTEMPTS ? 'failed' : 'queued';
  // `attempts` pins the attempt: a run recovered as stale must not touch a later attempt's row.
  const moved = await dbWrite.$executeRaw`
    UPDATE "PersonalDataExport" SET status = ${next}, error = ${category}
    WHERE id = ${row.id} AND status = 'building' AND attempts = ${row.attempts}
  `;
  if (next === 'failed' && moved === 1)
    alertFailed(
      row.id,
      row.attempts,
      cause === undefined ? category : `${category}: ${errorMessage(cause)}`
    );
  return next;
}

/**
 * A request that ended failed is on a response deadline, so it must not go quiet: every path to
 * `failed` raises the same error-level alert the Legal notice uses.
 */
function alertFailed(exportId: number, attempts: number, error: string) {
  logToAxiom({
    type: 'error',
    name: LOG,
    message: `ALERT: personal data export ${exportId} failed after ${attempts} attempt(s)`,
    details: { exportId, attempts, alert: true, error },
  }).catch(() => undefined);
}

/** Builds abandoned mid-run (a crash, an eviction) go back to queued or to failed. */
export async function recoverStaleExports() {
  const stale = await dbWrite.$queryRaw<{ id: number; attempts: number }[]>`
    SELECT id, attempts FROM "PersonalDataExport"
    WHERE status = 'building'
      AND "startedAt" < ${new Date(Date.now() - STALE_BUILD_HOURS * 60 * 60 * 1000)}
  `;
  for (const row of stale) await recordFailure(row, 'build abandoned');
  return stale.length;
}

/** Takes the oldest queued export, marking it building. Safe under concurrent runs. */
export async function claimNextExport(): Promise<ExportRow | null> {
  const [row] = await dbWrite.$queryRaw<ExportRow[]>`
    UPDATE "PersonalDataExport" SET status = 'building', "startedAt" = now(), attempts = attempts + 1
    WHERE id = (
      SELECT id FROM "PersonalDataExport" WHERE status = 'queued'
      ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1
    )
    RETURNING id, "userId", "requestedById", status, attempts, "archiveKey", "builtAt", "createdAt",
      "ticketId", "requestedAt"::text AS "requestedAt"
  `;
  return row ?? null;
}

// Export-only, on top of getAccountLegalHold's legs; not part of the delete-path hold.
function reviewHoldSql(userId: Prisma.Sql) {
  return Prisma.sql`EXISTS (
    SELECT 1 FROM "UserReport" ur JOIN "Report" r ON r.id = ur."reportId"
    WHERE ur."userId" = ${userId}
      AND r.status IN ('Actioned', 'Unactioned')
      AND r.reason IN ('CSAM', 'Automated')
  )`;
}

/**
 * Returns the account's legal-hold reasons, if any: `legs` (`['unconfirmed']` when they cannot be
 * read) and `markerView` (for `accountHoldSql`).
 */
export async function exportHoldReasons(
  userId: number
): Promise<{ legs: string[]; markerView: boolean }> {
  try {
    const hold = await getAccountLegalHold(userId);
    const [safety] = await dbWrite.$queryRaw<{ present: unknown; review: unknown }[]>(
      Prisma.sql`SELECT EXISTS (
        SELECT 1 FROM "Image" WHERE "Image"."userId" = ${userId}::int AND ${Prisma.raw(
        IMAGE_SAFETY_CONDITION
      )}
      ) AS present, ${reviewHoldSql(Prisma.sql`${userId}::int`)} AS review`
    );
    const legs: string[] = [...hold.legs];
    if (safety?.present !== false) legs.push('safety-content');
    if (safety?.review !== false) legs.push('review');
    return { legs, markerView: hold.markerView };
  } catch (e) {
    logToAxiom({
      type: 'error',
      name: LOG,
      message: `hold check failed: ${errorMessage(e)}`,
    }).catch(() => undefined);
    return { legs: ['unconfirmed'], markerView: true };
  }
}

export type ExportDeps = {
  bucket: ExportBucket;
  workflows: WorkflowCollection;
  clickhouse: ClickhouseReader;
  stripe: StripeReader | undefined;
};

/** Everything an export reads that is not the database itself, or why the job cannot run. */
export async function resolveExportDeps(): Promise<ExportDeps | { missing: string[] }> {
  const missing: string[] = [];
  const bucket = getExportBucket();
  if (!bucket) missing.push('PERSONAL_DATA_EXPORT_{ENDPOINT,REGION,BUCKET,KEY,SECRET}');
  if (!env.PERSONAL_DATA_EXPORT_MONGO_URL) missing.push('PERSONAL_DATA_EXPORT_MONGO_URL');
  if (!clickhouse) missing.push('ClickHouse');
  if (missing.length || !bucket || !clickhouse) return { missing };
  const { getWorkflowCollection } = await import('./mongo-client');
  return {
    bucket,
    workflows: await getWorkflowCollection(env.PERSONAL_DATA_EXPORT_MONGO_URL),
    clickhouse: clickhouse as unknown as ClickhouseReader,
    stripe: (await getServerStripe()) as unknown as StripeReader | undefined,
  };
}

const EXCLUDED_CATEGORIES: Manifest['excluded'] = [
  {
    category: 'Credentials',
    reason:
      'Passwords, session and sign-in tokens, API keys and similar secrets are not information about you, and returning them would be a security risk.',
  },
  {
    category: "Other people's personal data",
    reason:
      'Other users appear by user id only. Who reported content, and staff names and ids, are not included.',
  },
  {
    category: 'Safety system details',
    reason:
      'Scores, thresholds, matched terms and rule names from automated checks are not included; where an automated check affected you, the category and time are.',
  },
  {
    category: 'Removed content',
    reason:
      'Content removed for violating the Terms of Service is listed as "removed" instead of a link. Some content removed for safety reasons is not listed.',
  },
  {
    category: 'Structured settings and metadata',
    reason:
      'Some structured fields mix your data with system data and are left out; ask us and we will provide what is yours.',
  },
  {
    category: 'Support tickets',
    reason:
      'Support conversations are held in our help desk and are provided separately on request.',
  },
];

function csvNotes(notes: PgNote[]) {
  return (
    csvLine(['table', 'column', 'rowId', 'createdAt', 'note']) +
    notes.map((n) => csvLine([n.table, n.column, n.rowId, n.createdAt, n.text])).join('')
  );
}

async function staffForRedaction() {
  const rows = await dbWrite.$queryRaw<{ id: number; username: string | null }[]>`
    SELECT id, username FROM "User" WHERE "isModerator" = true
  `;
  return {
    ids: rows.map((r) => r.id),
    usernames: rows.map((r) => r.username).filter((u): u is string => !!u),
  };
}

/**
 * Builds one claimed export: the archive streamed into the bucket, the notes file beside it, the row
 * marked built only after the upload has completed, then the requester emailed a link. A held
 * account is refused instead (`refuseHeld`).
 */
export async function buildExport(row: ExportRow, deps: ExportDeps) {
  const user = await dbWrite.user.findUnique({
    where: { id: row.userId },
    select: { id: true, username: true, customerId: true },
  });
  if (!user) {
    const moved = await dbWrite.$executeRaw`
      UPDATE "PersonalDataExport" SET status = 'failed', error = 'no such user'
      WHERE id = ${row.id} AND status = 'building'
    `;
    if (moved === 1) alertFailed(row.id, row.attempts, 'no such user');
    return 'failed' as const;
  }

  // A held account's archive is never built: Legal is told instead.
  const before = await exportHoldReasons(user.id);
  // A hold that could not be READ is not a hold: retry rather than build or refuse.
  if (before.legs.includes('unconfirmed')) return recordFailure(row, 'hold check failed');
  if (before.legs.length) return refuseHeld(row, before.legs, building(row), []);

  const takenAt = new Date();
  const archiveKey = exportObjectKey(row.id, 'archive');
  const notes: PgNote[] = [];
  const errors: { source: string; message: string }[] = [];
  const onError = (source: string, e: unknown) => errors.push({ source, message: errorMessage(e) });
  const files: ManifestFile[] = [];
  let manifest: Manifest | undefined;
  let modNotesKey: string | null = null;
  let noteCount = 0;
  let archiveUploaded = false;
  // An upload this attempt will not record is deleted now, not left for the bucket rule: the keys
  // are this attempt's own, and nothing else will ever name them.
  const discard = () =>
    deleteObjects(deps.bucket, [archiveUploaded ? archiveKey : null, modNotesKey]);

  try {
    await streamArchiveToBucket(deps.bucket, archiveKey, async (writer) => {
      await writer.addFile(
        'README.txt',
        fillCoverNote({ username: user.username ?? 'there', link: README_LINK_TEXT, takenAt })
      );

      const pg = await exportPostgres({
        userId: user.id,
        writer,
        connect: () => pgDbReadLong.connect(),
        onNote: (n) => notes.push(n),
        onError,
      });
      files.push(...pg.files);
      noteCount = pg.noteCount;

      const ch = await exportClickhouse({ userId: user.id, writer, ch: deps.clickhouse, onError });
      files.push(...ch.files);

      files.push(await exportWorkflows({ userId: user.id, writer, collection: deps.workflows }));
      files.push(
        ...(await exportStripe({
          customerId: user.customerId,
          writer,
          stripe: deps.stripe,
          onError,
        }))
      );

      manifest = {
        exportId: row.id,
        generatedAt: takenAt.toISOString(),
        files,
        activityCounts: ch.counts,
        excluded: EXCLUDED_CATEGORIES,
        lines: [
          'Activity data (page views, impressions, searches and similar events) is summarized as counts by type in activityCounts. The raw events can be provided on request.',
          'Not included in this archive: files with status "not-included" were too large to read here and need a separate read. Ask us and we will provide them.',
          'Files with status "unavailable" could not be read when this archive was made; ask us and we will provide them.',
          'Files with status "partial" hit a size or time limit; ask us for the rest.',
          'A table with no records for you has rows: 0 and no file.',
          'leftOut, where present, counts records left out because they could not be reliably attributed to you (corrupted in storage).',
        ],
      };
      await writer.addFile('manifest.json', JSON.stringify(manifest, null, 2));
    });
    archiveUploaded = true;

    if (notes.length) {
      const staff = await staffForRedaction();
      modNotesKey = exportObjectKey(row.id, 'notes');
      await putSmallObject(
        deps.bucket,
        modNotesKey,
        csvNotes(notes.map((n) => ({ ...n, text: redactNoteText(n.text, staff) }))),
        'text/csv'
      );
    }
  } catch (e) {
    await discard();
    const status = await recordFailure(row, 'build failed', e);
    logToAxiom({
      type: 'error',
      name: LOG,
      message: `build failed: ${errorMessage(e)}`,
      details: { exportId: row.id, attempt: row.attempts, next: status },
    }).catch(() => undefined);
    return status;
  }

  // Checked again: a hold can land while the archive is built. Then the archive is deleted.
  const { legs: holdReasons } = await exportHoldReasons(user.id);
  if (holdReasons.includes('unconfirmed')) {
    await discard();
    return recordFailure(row, 'hold check failed');
  }
  if (holdReasons.length)
    return refuseHeld(row, holdReasons, building(row), [archiveKey, modNotesKey], deps.bucket);
  const status: ExportStatus = 'built';
  // Staff-only: the row's copy. The archive's manifest carries no note count.
  const summary = manifest && {
    files: manifest.files.map(({ file, rows, status }) => ({ file, rows, status })),
    internalNotes: noteCount,
    errors,
  };
  // Only now, after the upload has completed, does the row say the archive exists. A row that is no
  // longer building at this attempt was recovered as stale while this ran (and maybe claimed again):
  // its record is not ours to write, and the requester is not emailed about an archive it does not name.
  const recorded = await dbWrite.$executeRaw`
    UPDATE "PersonalDataExport"
    SET status = ${status}, "archiveKey" = ${archiveKey}, "modNotesKey" = ${modNotesKey},
        "holdReasons" = ${holdReasons}::text[], manifest = ${JSON.stringify(summary)}::jsonb,
        "builtAt" = ${takenAt}, error = NULL
    WHERE id = ${row.id} AND status = 'building' AND attempts = ${row.attempts}
  `;
  if (recorded !== 1) {
    await discard();
    logToAxiom({
      type: 'warning',
      name: LOG,
      message: 'built after the row stopped building; not recorded or emailed',
      details: { exportId: row.id },
    }).catch(() => undefined);
    return 'failed' as const;
  }
  if (errors.length)
    logToAxiom({
      type: 'warning',
      name: LOG,
      message: 'built with unavailable sources',
      details: { exportId: row.id, errors },
    }).catch(() => undefined);

  await emailRequester(row, user, { archiveKey, modNotesKey }, deps.bucket);
  return status;
}

/** The subject and body lines of the refusal notice Legal's intake reads. */
export function legalRefusalLines(input: {
  userId: number;
  ticketId: number | null;
  requestedAt: string | null;
}) {
  const lines = [
    `user=${input.userId}`,
    `ticket=${input.ticketId ?? 'none'}`,
    `requested=${input.requestedAt ?? 'unknown'}`,
  ];
  return { subject: `DATA-EXPORT-REFUSED ${lines.join(' ')}`, lines };
}

/**
 * A held row's Legal notice, tracked in its `error`: pending until the send lands, then cleared.
 * A failed send is retried on later ticks; a send that landed but reported failure can repeat, but
 * none is lost.
 */
const LEGAL_NOTICE_PENDING = 'legal notice pending';
/** Fixed text only: moderators read the row, and a mail error can carry addresses. It goes to the log. */
const legalNoticeFailed = (failures: number) => `legal notice failed (${failures})`;
/** Failed sends of one notice before every further failure also raises an alert naming the row. */
export const LEGAL_NOTICE_ALERT_AFTER = 3;

type LegalNoticeRow = Pick<ExportRow, 'id' | 'userId' | 'ticketId' | 'requestedAt'>;

async function sendLegalNotice(row: LegalNoticeRow, failuresSoFar: number) {
  const { subject, lines } = legalRefusalLines(row);
  try {
    await personalDataExportRefusedEmail.send({
      to: env.PERSONAL_DATA_EXPORT_LEGAL_EMAIL,
      subject,
      lines,
    });
  } catch (e) {
    const failures = failuresSoFar + 1;
    await dbWrite.$executeRaw`
      UPDATE "PersonalDataExport" SET error = ${legalNoticeFailed(failures)}
      WHERE id = ${row.id} AND status = 'held'
    `.catch(() => undefined);
    logToAxiom({
      type: 'error',
      name: LOG,
      message:
        failures >= LEGAL_NOTICE_ALERT_AFTER
          ? `ALERT: Legal refusal notice for export ${row.id} still unsent after ${failures} tries`
          : `Legal refusal notice failed: ${errorMessage(e)}`,
      details: {
        exportId: row.id,
        failures,
        alert: failures >= LEGAL_NOTICE_ALERT_AFTER,
        error: errorMessage(e),
      },
    }).catch(() => undefined);
    return false;
  }
  // Sent: mark it, so no later tick sends it again. If this write fails, a later tick resends.
  await dbWrite.$executeRaw`
    UPDATE "PersonalDataExport" SET error = NULL
    WHERE id = ${row.id} AND status = 'held' AND error LIKE 'legal notice%'
  `.catch((e: unknown) =>
    logToAxiom({
      type: 'error',
      name: LOG,
      message: `Legal notice sent but not marked: ${errorMessage(e)}`,
      details: { exportId: row.id },
    }).catch(() => undefined)
  );
  return true;
}

/** Resends every held export's Legal notice that has not landed yet. Runs at the start of each tick. */
export async function retryLegalNotices() {
  const owed = await dbWrite.$queryRaw<(LegalNoticeRow & { error: string })[]>`
    SELECT id, "userId", "ticketId", "requestedAt"::text AS "requestedAt", error
    FROM "PersonalDataExport"
    WHERE status = 'held' AND error LIKE 'legal notice%'
    ORDER BY id
    LIMIT 20
  `;
  let sent = 0;
  for (const row of owed) {
    const failures = Number(/^legal notice failed \((\d+)\)/.exec(row.error)?.[1] ?? 0);
    if (await sendLegalNotice(row, failures)) sent++;
  }
  return { owed: owed.length, sent };
}

/** The state a refusal moves the row out of: this build attempt, or a built archive at release. */
type HeldFrom = { status: 'building'; attempts: number } | { status: 'built' };
const building = (row: ExportRow): HeldFrom => ({ status: 'building', attempts: row.attempts });

/**
 * A held account: no archive (any already uploaded is deleted), one notice to Legal, and the
 * requesting moderator told only that it is being routed to Legal. The same path whether the hold is
 * found before the build, during it, or at release. The row is kept, as held, with both keys cleared.
 *
 * The guarded UPDATE runs first and only its winner deletes and emails, so a retry or a second press
 * racing this one cannot send Legal a second notice.
 */
async function refuseHeld(
  row: Pick<
    ExportRow,
    'id' | 'userId' | 'requestedById' | 'createdAt' | 'ticketId' | 'requestedAt'
  >,
  holdReasons: string[],
  from: HeldFrom,
  uploaded: (string | null)[],
  bucket?: ExportBucket
) {
  // The row says the Legal notice is owed from the moment it is held, so a crash before the send
  // leaves it to be retried rather than lost.
  const recorded =
    from.status === 'building'
      ? await dbWrite.$executeRaw`
          UPDATE "PersonalDataExport"
          SET status = 'held', "holdReasons" = ${holdReasons}::text[], "archiveKey" = NULL,
              "modNotesKey" = NULL, error = ${LEGAL_NOTICE_PENDING}
          WHERE id = ${row.id} AND status = 'building' AND attempts = ${from.attempts}
        `
      : await dbWrite.$executeRaw`
          UPDATE "PersonalDataExport"
          SET status = 'held', "holdReasons" = ${holdReasons}::text[], "archiveKey" = NULL,
              "modNotesKey" = NULL, error = ${LEGAL_NOTICE_PENDING}
          WHERE id = ${row.id} AND status = 'built'
        `;
  // A build attempt's uploads have keys of their own, so they go even when the row has moved on. At
  // release they are the row's, and a lost claim can mean a racing press just released them: keep them.
  if (bucket && (recorded === 1 || from.status === 'building'))
    await deleteObjects(bucket, uploaded);
  if (recorded !== 1) return 'failed' as const;
  logToAxiom({
    type: 'info',
    name: LOG,
    message: 'export refused: account under a hold',
    details: {
      exportId: row.id,
      userId: row.userId,
      requestedById: row.requestedById,
      queuedAt: row.createdAt,
      at: from.status === 'built' ? 'release' : 'build',
    },
  }).catch(() => undefined);

  await sendLegalNotice(row, 0);
  // The requester is told the same thing whether or not the Legal notice has gone yet.
  try {
    const requester = await dbWrite.user.findUnique({
      where: { id: row.requestedById },
      select: { email: true },
    });
    if (requester?.email)
      await personalDataExportHeldEmail.send({ to: requester.email, exportId: row.id });
  } catch (e) {
    logToAxiom({
      type: 'error',
      name: LOG,
      message: `held notice to the requester failed: ${errorMessage(e)}`,
      details: { exportId: row.id },
    }).catch(() => undefined);
  }
  return 'held' as const;
}

async function emailRequester(
  row: ExportRow,
  user: { id: number; username: string | null },
  built: { archiveKey: string; modNotesKey: string | null },
  bucket: ExportBucket
) {
  try {
    const requester = await dbWrite.user.findUnique({
      where: { id: row.requestedById },
      select: {
        email: true,
        isModerator: true,
        deletedAt: true,
        bannedAt: true,
        roles: { select: { role: true } },
      },
    });
    // A build can finish hours after it was queued: the link goes only to someone who may still
    // queue exports. Otherwise the row says why, and another holder can take it over.
    const mayQueue =
      !!requester?.isModerator &&
      !requester.deletedAt &&
      !requester.bannedAt &&
      (await hasModeratorGrant(
        { roles: requester.roles.map((r) => r.role) },
        'user.personalDataExport.queue'
      ));
    if (!mayQueue) throw new RequesterNotSent('the requester may no longer queue exports');
    const to = exportRecipient('built', {
      requester: { email: requester?.email ?? null },
      owner: { email: null },
    });
    if (!to) throw new RequesterNotSent('the requester has no email');
    const archive = await presignDownload(bucket, built.archiveKey, `civitai-data-${row.id}.zip`);
    const notes = built.modNotesKey
      ? await presignDownload(bucket, built.modNotesKey, `internal-notes-${row.id}.csv`)
      : null;
    await personalDataExportBuiltEmail.send({
      to,
      exportId: row.id,
      userId: user.id,
      username: user.username,
      archiveLink: archive.url,
      notesLink: notes?.url ?? null,
      expiresAt: archive.expiresAt,
    });
    await dbWrite.$executeRaw`
      UPDATE "PersonalDataExport" SET "sentAt" = now(), "linkExpiresAt" = ${archive.expiresAt}
      WHERE id = ${row.id}
    `;
  } catch (e) {
    // The archive is built and recorded; only the notice failed. The row says so in fixed text (our
    // own reason, or none): moderators read it, and a mail error can carry addresses. The log has it.
    const onRow =
      e instanceof RequesterNotSent
        ? `built; requester email failed: ${e.message}`
        : 'built; requester email failed';
    await dbWrite.$executeRaw`
      UPDATE "PersonalDataExport" SET error = ${onRow}
      WHERE id = ${row.id}
    `;
    logToAxiom({
      type: 'error',
      name: LOG,
      message: `requester email failed: ${errorMessage(e)}`,
      details: { exportId: row.id, error: errorMessage(e) },
    }).catch(() => undefined);
  }
}

/** A built link this code chose not to send: its message is fixed text, safe to put on the row. */
class RequesterNotSent extends Error {}

export type ReleaseResult =
  | { ok: true; userId: number; expiresAt: Date }
  | {
      ok: false;
      reason:
        | 'not-found'
        | 'not-releasable'
        | 'expired'
        | 'held'
        | 'unconfirmed'
        | 'no-email'
        | 'unconfigured';
    };

/**
 * Sends the account owner the cover note and a fresh download link. Re-checks every hold and reads
 * the owner's email again at the moment of sending; the archive's own build-time check is not
 * trusted for this. The internal notes file is never sent from here.
 */
export async function releaseExport({
  exportId,
  actorId,
  bucket = getExportBucket(),
  now = new Date(),
}: {
  exportId: number;
  actorId: number;
  bucket?: ExportBucket | null;
  now?: Date;
}): Promise<ReleaseResult> {
  if (!bucket) return { ok: false, reason: 'unconfigured' };
  const row = await dbWrite.personalDataExport.findUnique({
    where: { id: exportId },
    select: { id: true, userId: true, status: true, archiveKey: true, builtAt: true },
  });
  if (!row) return { ok: false, reason: 'not-found' };
  // A held export is never released here, even once its hold ends: Legal releases those by hand.
  if (row.status !== 'built' || !row.archiveKey || !row.builtAt)
    return { ok: false, reason: 'not-releasable' };
  if (now.getTime() - row.builtAt.getTime() > RELEASE_WINDOW_SECONDS * 1000)
    return { ok: false, reason: 'expired' };

  const { legs: holdReasons, markerView } = await exportHoldReasons(row.userId);
  // A hold that could not be READ is not a hold: refuse this press, write nothing, let it be retried.
  if (holdReasons.includes('unconfirmed')) return { ok: false, reason: 'unconfirmed' };
  if (holdReasons.length) {
    // Refused exactly as at build time: archive and notes deleted, Legal told once. This read is the
    // only one on the release path that names the notes object, and only so it can be deleted.
    const stored = await dbWrite.personalDataExport.findUnique({
      where: { id: row.id },
      select: {
        requestedById: true,
        createdAt: true,
        ticketId: true,
        requestedAt: true,
        modNotesKey: true,
      },
    });
    if (!stored) return { ok: false, reason: 'not-found' };
    const refused = await refuseHeld(
      {
        id: row.id,
        userId: row.userId,
        requestedById: stored.requestedById,
        createdAt: stored.createdAt,
        ticketId: stored.ticketId,
        // A DATE comes back as UTC midnight, so its ISO date is the stored date.
        requestedAt: stored.requestedAt?.toISOString().slice(0, 10) ?? null,
      },
      holdReasons,
      { status: 'built' },
      [row.archiveKey, stored.modNotesKey],
      bucket
    );
    return { ok: false, reason: refused === 'held' ? 'held' : 'not-releasable' };
  }

  const owner = await dbWrite.user.findUnique({
    where: { id: row.userId },
    select: { email: true, username: true, deletedAt: true },
  });
  const to =
    owner && !owner.deletedAt
      ? exportRecipient('release', { requester: { email: null }, owner: { email: owner.email } })
      : null;
  if (!to) return { ok: false, reason: 'no-email' };

  // Claim the release before sending, so two presses cannot both send.
  const claimed = await dbWrite.$executeRaw`
    UPDATE "PersonalDataExport"
    SET status = 'released', "releasedAt" = ${now}, "releasedById" = ${actorId}, "holdReasons" = '{}',
        error = NULL
    WHERE id = ${row.id} AND status = 'built'
      AND NOT ${accountHoldSql(Prisma.sql`${row.userId}::int`, markerView)}
      AND NOT EXISTS (
        SELECT 1 FROM "Image" WHERE "Image"."userId" = ${row.userId}::int
          AND ${Prisma.raw(IMAGE_SAFETY_CONDITION)}
      )
      AND NOT ${reviewHoldSql(Prisma.sql`${row.userId}::int`)}
  `;
  if (claimed !== 1) return { ok: false, reason: 'not-releasable' };

  let link: { url: string; expiresAt: Date };
  try {
    link = await presignDownload(bucket, row.archiveKey, `civitai-data.zip`);
    await personalDataExportReadyEmail.send({
      to,
      username: owner?.username ?? 'there',
      link: link.url,
      takenAt: row.builtAt,
    });
  } catch (e) {
    // Not sent: put it back so it can be released again. Fixed text on the row; the error is logged.
    await dbWrite.$executeRaw`
      UPDATE "PersonalDataExport"
      SET status = 'built', "releasedAt" = NULL, "releasedById" = NULL,
          error = 'release email failed'
      WHERE id = ${row.id} AND status = 'released'
    `;
    logToAxiom({
      type: 'error',
      name: LOG,
      message: `release email failed: ${errorMessage(e)}`,
      details: { exportId: row.id, error: errorMessage(e) },
    }).catch(() => undefined);
    throw e;
  }
  // Sent. A failure from here on must not put the row back, or a second press would send again.
  await dbWrite.$executeRaw`
    UPDATE "PersonalDataExport" SET "linkExpiresAt" = ${link.expiresAt} WHERE id = ${row.id}
  `.catch((e: unknown) =>
    logToAxiom({
      type: 'error',
      name: LOG,
      message: `release recorded without expiry: ${errorMessage(e)}`,
    }).catch(() => undefined)
  );
  return { ok: true, userId: row.userId, expiresAt: link.expiresAt };
}

async function countQueued() {
  const rows = await dbWrite.$queryRaw<{ n: number }[]>(
    Prisma.sql`SELECT count(*)::int AS n FROM "PersonalDataExport" WHERE status = 'queued'`
  );
  return rows[0]?.n ?? 0;
}

function safeErrorLabel(e: unknown): string {
  if (!(e instanceof Error)) return 'unknown error';
  const code = (e as { code?: unknown }).code;
  return typeof code === 'string' || typeof code === 'number' ? `${e.name} (${code})` : e.name;
}

/** One job tick: recover abandoned builds, then build queued exports one at a time. */
export async function runPersonalDataExports({
  maxPerRun = 1,
  resolveDeps = resolveExportDeps,
  build = buildExport,
}: {
  maxPerRun?: number;
  /** For tests: the bucket, Mongo and ClickHouse a run uses, and the build itself. */
  resolveDeps?: typeof resolveExportDeps;
  build?: typeof buildExport;
} = {}) {
  await recoverStaleExports();
  // Needs no bucket, so it runs even while the export is unconfigured, and never blocks a build.
  await retryLegalNotices().catch((e: unknown) =>
    logToAxiom({
      type: 'error',
      name: LOG,
      message: `Legal notice retry failed: ${errorMessage(e)}`,
    }).catch(() => undefined)
  );
  let deps: Awaited<ReturnType<typeof resolveExportDeps>>;
  try {
    deps = await resolveDeps();
  } catch (e) {
    // Name and code only: a driver error can quote the connection string, which has credentials.
    const queued = await countQueued();
    logToAxiom({
      type: 'error',
      name: LOG,
      message: `deps failed, ${queued} export(s) waiting: ${safeErrorLabel(e)}`,
    }).catch(() => undefined);
    return { built: 0, skipped: 'deps-failed' as const };
  }
  if ('missing' in deps) {
    const queued = await dbWrite.$queryRaw<{ n: number }[]>(
      Prisma.sql`SELECT count(*)::int AS n FROM "PersonalDataExport" WHERE status = 'queued'`
    );
    if (queued[0]?.n)
      logToAxiom({
        type: 'error',
        name: LOG,
        message: `not configured, ${queued[0].n} export(s) waiting: ${deps.missing.join(', ')}`,
      }).catch(() => undefined);
    return { built: 0, skipped: 'unconfigured' as const };
  }
  let built = 0;
  for (let i = 0; i < maxPerRun; i++) {
    const row = await claimNextExport();
    if (!row) break;
    try {
      await build(row, deps);
    } catch (e) {
      // Anything buildExport did not handle itself: never leave the row building until it goes stale.
      await recordFailure(row, 'build failed', e).catch(() => undefined);
      logToAxiom({
        type: 'error',
        name: LOG,
        message: errorMessage(e),
        details: { exportId: row.id },
      }).catch(() => undefined);
    }
    built++;
  }
  return { built };
}
