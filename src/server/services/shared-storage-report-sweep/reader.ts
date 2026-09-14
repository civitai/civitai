import { appsDb } from '~/server/db/appsDb';
import { dbRead } from '~/server/db/client';
import { appSchemaIdent, sanitizeAppSlug } from '~/server/utils/apps-slug';

/**
 * The read port for the shared-storage report sweep.
 *
 * 🔴 THIS IS THE WHOLE DATABASE SURFACE OF THE SWEEP, AND IT IS READ-ONLY BY CONSTRUCTION. The run
 * gets one method that returns rows; it holds no pool, no client and no statement it could turn into
 * a write. That is the "nothing here actions anything" guarantee expressed as reachability rather
 * than as a flag or a comment.
 */
export type SharedReportReader = {
  listUserReports(args: { since: Date; until: Date; limit: number }): Promise<SharedReportScan>;
  /**
   * Which of these accounts are moderators — the half of the mod-row test that a user cannot spell.
   *
   * A set rather than a predicate so the run makes ONE query for the whole scan instead of one per
   * row, and so an empty input costs no query at all.
   */
  listModeratorIds(userIds: number[]): Promise<Set<number>>;
};

/** One `shared_kv_reports` row, joined to the metadata of the row it concerns. */
export type SharedReportRow = {
  id: string;
  slug: string;
  appBlockId: string | null;
  key: string;
  reporterUserId: number;
  reason: string | null;
  createdAt: Date;
  /** `null` when the reported `shared_kv` row no longer exists (purged or withdrawn). */
  authorUserId: number | null;
  hidden: boolean;
};

export type SharedReportScan = {
  rows: SharedReportRow[];
  /** How many app schemas were actually queried — the denominator behind "found nothing". */
  appsScanned: number;
  /** Apps whose query threw. Counted, not swallowed: one broken app must not lose the whole run. */
  appsFailed: number;
  /** True when the scan budget was reached, i.e. rows exist that this run did not read. */
  truncated: boolean;
};

/**
 * The per-app SELECT.
 *
 * 🔴 IT DOES NOT NAME `value`, AND IT MUST NEVER NAME IT. `shared_kv.value` is the reported CONTENT —
 * the title/body a user wrote and another user flagged. Everything this sweep produces ends up on the
 * moderator abuse board, which is a wider-audience surface than the app's own moderation view, so the
 * content stays in the apps database and the board gets metadata plus the REPORTER's words. Leaving
 * the column out of the query is the structural half of that guarantee; `report.ts` having nowhere to
 * put it is the other half. The `__tests__` beside this file pin this query text.
 *
 * `LEFT JOIN`, not `JOIN`: a report deliberately outlives the row it concerns (the provisioner
 * declines to FK `shared_kv_reports.key` for exactly that reason), so an inner join would silently
 * drop every report whose row a moderator already purged — and report them as "none found".
 *
 * 🔴 THREE THINGS WRITE `shared_kv_reports`, AND ONLY ONE OF THEM IS A USER REPORT. Getting this
 * wrong is not a missing row, it is the board filling with entries a moderator already dealt with:
 *
 *   1. the USER-report path            — `key` set, reporter = the reporting user, reason = free text
 *   2. the auto content-safety path    — `key IS NULL`, reporter = the BLOCKED WRITER, `auto:<cat>`
 *   3. `apps.mod.purgeSharedRow`       — `key` set, reporter = THE ACTING MODERATOR, `mod:<action>`
 *
 * (2) is excluded structurally by `key IS NOT NULL` — note that it DOES carry a reporter id, so
 * `reporter_user_id IS NOT NULL` alone would not have caught it.
 *
 * (3) shares both of those columns with a real user report, so the table alone cannot separate them.
 * The `mod:` prefix is excluded here — but 🔴 A PREFIX ON A USER-SUPPLIED STRING IS WALKABLE: the
 * reason on path (1) is the reporter's own free text, so anyone could type `mod:purge` and drop
 * their own report out of this sweep, which is an evasion of the exact surface this job exists to
 * provide. So the prefix is only HALF the test — `run.ts` also requires the reporter to actually BE
 * a moderator before discarding the row, and a non-moderator cannot satisfy that half. A moderator
 * filing a genuine user report writes an ordinary reason and is kept by the first half.
 */
export function buildUserReportQuery(schemaIdent: string): string {
  return `
    SELECT r.id                      AS id,
           r.key                     AS key,
           r.reporter_user_id        AS reporter_user_id,
           r.reason                  AS reason,
           r.created_at              AS created_at,
           s.author_user_id          AS author_user_id,
           (s.hidden_at IS NOT NULL) AS hidden
      FROM ${schemaIdent}.shared_kv_reports r
      LEFT JOIN ${schemaIdent}.shared_kv s ON s.key = r.key
     WHERE r.reporter_user_id IS NOT NULL
       AND r.key IS NOT NULL
       AND r.created_at >= $1
       AND r.created_at <  $2
     ORDER BY r.created_at ASC
     LIMIT $3`;
}

/**
 * The reason prefix `apps.mod.purgeSharedRow` stamps on the audit row it files.
 *
 * Exported because it is a COUPLING to another file, not a local detail: if that call site ever
 * changes its prefix, this sweep silently starts publishing moderator actions to the board as user
 * reports. `__tests__/job-wiring.test.ts` pins the pair against the router's source.
 */
export const MOD_ACTION_REASON_PREFIX = 'mod:';

export type AppIdentity = { slug: string; appBlockId: string; schemaIdent: string };

/**
 * The apps this sweep has to look in.
 *
 * Derived from the APPROVED AppBlock rows rather than from `information_schema` alone, because the
 * board wants the `apb_<ulid>` id and the slug, and a schema name only carries the slug. The schema
 * list is then intersected with what actually exists in the apps database: storage is provisioned at
 * approval time, so an approved block can legitimately have no schema yet, and querying it would
 * raise `42P01` per app per run.
 *
 * 🔴 A SIDE EFFECT WORTH NAMING, BECAUSE IT IS LOAD-BEARING AND NOT OBVIOUS: the mod review sandbox
 * gets its own `apprev_<publishRequestId>` schema with the SAME tables, and a moderator running an
 * unapproved app "for real" can file reports in it. Those must never reach the board — they are
 * scribbles on a disposable preview, not abuse. They cannot, because every name here is built as
 * `app_${slug}` and the `apprev_` prefix can never alias an `app_` one (see `apps-slug.ts`: an
 * `app_<slug>` schema always has `_` at index 3). So the exclusion is by construction rather than by
 * a filter someone could drop — but it is invisible unless said out loud.
 */
export async function listSharedStorageApps(): Promise<AppIdentity[]> {
  if (!appsDb) return [];

  const blocks = await dbRead.appBlock.findMany({
    where: { status: 'approved' },
    select: { id: true, blockId: true },
  });

  // Two blockIds can sanitise to one slug (`a.b` and `a_b`), and they would share a storage schema.
  // First wins, deterministically, so the run is stable across invocations rather than reporting the
  // same rows under a different app id each day.
  const bySlug = new Map<string, AppIdentity>();
  for (const block of blocks) {
    const slug = sanitizeAppSlug(block.blockId);
    if (!slug || bySlug.has(slug)) continue;
    bySlug.set(slug, { slug, appBlockId: block.id, schemaIdent: appSchemaIdent(slug) });
  }
  if (!bySlug.size) return [];

  const schemaNames = [...bySlug.keys()].map((slug) => `app_${slug}`);
  const existing = await appsDb.query<{ table_schema: string }>(
    `SELECT table_schema FROM information_schema.tables
      WHERE table_name = 'shared_kv_reports' AND table_schema = ANY($1)`,
    [schemaNames]
  );

  const live = new Set(existing.rows.map((r) => r.table_schema));
  return [...bySlug.values()].filter((app) => live.has(`app_${app.slug}`));
}

/**
 * The production reader.
 *
 * Returns `null` when the apps database is not configured — PR previews, dev, and the legacy stage
 * cluster all run without `APPS_DATABASE_URL`. That is a SUPPORTED state, not an error, and the run
 * reports it as a skip rather than filing an empty run that would read as "we looked and nobody has
 * reported anything".
 */
export function createSharedReportReader(): SharedReportReader | null {
  if (!appsDb) return null;
  const pool = appsDb;

  return {
    async listUserReports({ since, until, limit }) {
      const apps = await listSharedStorageApps();
      const rows: SharedReportRow[] = [];
      let appsFailed = 0;
      let truncated = false;

      for (const app of apps) {
        const remaining = limit - rows.length;
        if (remaining <= 0) {
          truncated = true;
          break;
        }
        try {
          // `remaining + 1`: reading one past the budget is how the run can TELL that it hit the
          // budget rather than the end of the data. Without it a scan that returns exactly the
          // budget is indistinguishable from one that happened to find that many, and the run would
          // report "all reports surfaced" while silently dropping the rest.
          const res = await pool.query<{
            id: string;
            key: string;
            reporter_user_id: number;
            reason: string | null;
            created_at: Date;
            author_user_id: number | null;
            hidden: boolean;
          }>(buildUserReportQuery(app.schemaIdent), [since, until, remaining + 1]);

          const batch = res.rows.slice(0, remaining);
          if (res.rows.length > batch.length) truncated = true;
          for (const row of batch) {
            rows.push({
              id: row.id,
              slug: app.slug,
              appBlockId: app.appBlockId,
              key: row.key,
              reporterUserId: Number(row.reporter_user_id),
              reason: row.reason,
              createdAt: new Date(row.created_at),
              authorUserId: row.author_user_id == null ? null : Number(row.author_user_id),
              hidden: Boolean(row.hidden),
            });
          }
        } catch {
          appsFailed += 1;
        }
      }

      return { rows, appsScanned: apps.length, appsFailed, truncated };
    },

    async listModeratorIds(userIds) {
      const ids = [...new Set(userIds)];
      if (!ids.length) return new Set();
      const mods = await dbRead.user.findMany({
        where: { id: { in: ids }, isModerator: true },
        select: { id: true },
      });
      return new Set(mods.map((u) => u.id));
    },
  };
}
