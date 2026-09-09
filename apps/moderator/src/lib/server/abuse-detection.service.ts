import { MAX_FINDINGS_PER_REPORT, type AbuseReportInput } from '@civitai/moderation';
import { getModeratorDb } from './moderator-db';
import type { AbuseDetectionTables } from './abuse-detection-tables';

/** The shared client, typed to include the two tables this module owns. */
const abuseDb = () => getModeratorDb().withTables<AbuseDetectionTables>();

/**
 * One client, shared with the rest of the app's moderation data — `withTables` adds these two tables
 * to its TYPE without opening a second connection.
 *
 * 🔴 An earlier version stood up its own pool on `MODERATOR_DATABASE_URL`, reasoning from a comment
 * that said that key and `RETOOL_DATABASE_URL` "name different instances". They do not, and by now
 * there is only one name: the Retool cutover landed 2026-08-18 (deployment repo `ee835acaf`),
 * repointing `RETOOL_DATABASE_URL` at the same `internal_tools` database and retiring it, and
 * `moderator-db.ts` now reads `MODERATOR_DATABASE_URL` alone. Verified against the running pod:
 * both keys resolve to `<service>.<namespace>.svc.cluster.local:5432/internal_tools`,
 * whose `public` schema holds the live tables while the pre-cutover snapshot sits in a `cutover`
 * schema. One database, therefore one pool.
 */

/**
 * Automated abuse-detection reports: the write the detectors POST, and the reads the board renders.
 *
 * What this surface is FOR, and why no existing one covers it: a detector produces two kinds of row,
 * and only one of them has ever been representable. `ModActivity` records what was DONE — it is an
 * action log, so a detection the system chose NOT to act on has nowhere to go. Most of what these
 * jobs produce is exactly that: scored, ranked, below the confidence gate, and left alone. Those are
 * the rows a human most needs to see, because they are where a false negative hides and where the
 * gate's calibration is judged.
 */

/** A run header, without its findings — what the board's list renders. */
export type AbuseRun = {
  id: number;
  detector: string;
  startedAt: Date;
  finishedAt: Date;
  summary: string | null;
  counters: Record<string, number>;
  receivedAt: Date;
  /** Denormalised for the list; the detail view fetches the rows. */
  findingCount: number;
  actionedCount: number;
};

export type AbuseFinding = {
  id: number;
  runId: number;
  userId: number;
  confidence: number;
  reason: string;
  actioned: boolean;
  action: string | null;
  createdAt: Date;
};

/**
 * Postgres `invalid_column_reference`, raised when `ON CONFLICT (…)` names columns no unique index
 * covers. (NOT `undefined_object`, which is 42704 — the class name matters because a maintainer
 * deciding whether to widen this catch needs to know 42P10 is broader than it looks: a bad
 * ORDER BY/GROUP BY reference raises it too. Inside `writeRun` the realistic sources are narrow.
 * `mod-activity.ts` documents the same code for the same ON CONFLICT case.)
 *
 * 🔴 This is the failure mode of a HALF-APPLIED schema, and it is otherwise undiagnosable from the
 * producer's side: it presents as a 500 on every POST forever, and the job retries into it. The
 * upsert requires the UNIQUE index; an environment still carrying the earlier non-unique index of a
 * different name satisfies neither `IF NOT EXISTS` nor the conflict target. The read path already
 * says "run schema.sql" when the tables are missing; the write path has to say it too.
 */
const PG_NO_MATCHING_CONFLICT_TARGET = '42P10';

/**
 * Store one run and its findings.
 *
 * One transaction: a run header whose findings failed to land would render as "0 findings", which is
 * indistinguishable from a genuinely clean run — the reassuring-zero failure this whole surface is
 * meant to remove. Either both land or neither does.
 */
export async function recordAbuseRun(input: AbuseReportInput): Promise<{ runId: number }> {
  const db = abuseDb();
  try {
    return await writeRun(db, input);
  } catch (e) {
    if ((e as { code?: unknown }).code === PG_NO_MATCHING_CONFLICT_TARGET)
      throw new Error(
        'abuse_detection_run is missing its (detector, started_at) UNIQUE index — apply ' +
          'apps/moderator/abuse-detection/schema.sql to MODERATOR_DATABASE_URL',
        { cause: e }
      );
    throw e;
  }
}

function writeRun(
  db: ReturnType<typeof abuseDb>,
  input: AbuseReportInput
): Promise<{ runId: number }> {
  return db.transaction().execute(async (trx) => {
    const run = await trx
      .insertInto('abuse_detection_run')
      .values({
        detector: input.detector,
        // The producer's clock. Parsed here rather than defaulted — see the schema comment.
        started_at: new Date(input.startedAt),
        finished_at: new Date(input.finishedAt),
        summary: input.summary ?? null,
        counters: JSON.stringify(input.counters ?? {}),
      })
      // 🔴 IDEMPOTENT on (detector, started_at). The producers retry: a POST that commits but whose
      // response is lost to a timeout gets sent again, and without this the board grows a duplicate
      // run every time — two rows claiming to be the same run, which is worse than none because a
      // reader cannot tell which is current. Re-reporting the same run REPLACES it.
      .onConflict((oc) =>
        oc.columns(['detector', 'started_at']).doUpdateSet({
          finished_at: new Date(input.finishedAt),
          summary: input.summary ?? null,
          counters: JSON.stringify(input.counters ?? {}),
          // Refreshed, not left at the first attempt's value. The detail page renders this as
          // "reported <when>", and it is the only record of when a detector was last heard from —
          // stale here, a re-reported run shows new data under an old receipt time.
          received_at: new Date(),
        })
      )
      .returning('id')
      .executeTakeFirstOrThrow();

    // Clear before re-inserting, so a replayed run does not accumulate its findings twice. A no-op on
    // the first write; the ON DELETE CASCADE does not help here because the run row survives.
    await trx.deleteFrom('abuse_detection_finding').where('run_id', '=', run.id).execute();

    if (input.findings.length > 0) {
      await trx
        .insertInto('abuse_detection_finding')
        .values(
          input.findings.map((f) => ({
            run_id: run.id,
            user_id: f.userId,
            confidence: f.confidence,
            reason: f.reason,
            actioned: f.actioned,
            // Mirrors the table's CHECK for the `actioned: false` direction. It CANNOT repair the
            // other one — an `actioned: true` carrying no action still normalises to NULL here, and
            // the CHECK would reject it, aborting the transaction and losing the whole run. That
            // shape is unreachable only because the CONTRACT now refuses it at the edge, which is
            // where a missing value has to be caught: this line has nothing to substitute for it.
            action: f.actioned ? f.action ?? null : null,
          }))
        )
        .execute();
    }

    return { runId: run.id };
  });
}

/**
 * One run header by id.
 *
 * Its own query, NOT a `find` over `getAbuseRuns`. Filtering a bounded list in memory means a run
 * outside that window 404s as "No such run" — false, and delayed: two detectors at different
 * cadences push a quiet detector's run out of the global window long before the limit looks
 * reachable. The list page would then link to a page that denies the run exists.
 */
export async function getAbuseRun(runId: number): Promise<AbuseRun | null> {
  const db = abuseDb();
  const row = await db
    .selectFrom('abuse_detection_run')
    .selectAll()
    .where('id', '=', runId)
    .executeTakeFirst();
  if (!row) return null;

  const counts = await db
    .selectFrom('abuse_detection_finding')
    .select(({ fn, eb }) => [
      fn.count<string>('id').as('finding_count'),
      fn
        .count<string>(eb.case().when('actioned', '=', true).then(eb.ref('id')).end())
        .as('actioned_count'),
    ])
    .where('run_id', '=', runId)
    .executeTakeFirst();

  return {
    id: row.id,
    detector: row.detector,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    summary: row.summary,
    counters: asCounters(row.counters),
    receivedAt: row.received_at,
    findingCount: Number(counts?.finding_count ?? 0),
    actionedCount: Number(counts?.actioned_count ?? 0),
  };
}

/** Newest runs, optionally for one detector. */
export async function getAbuseRuns(
  opts: { detector?: string; limit?: number } = {}
): Promise<AbuseRun[]> {
  const db = abuseDb();
  let q = db
    .selectFrom('abuse_detection_run as r')
    .leftJoin('abuse_detection_finding as f', 'f.run_id', 'r.id')
    .select(({ fn, eb }) => [
      'r.id',
      'r.detector',
      'r.started_at',
      'r.finished_at',
      'r.summary',
      'r.counters',
      'r.received_at',
      fn.count<string>('f.id').as('finding_count'),
      // COUNT of a filtered expression, not SUM of a boolean — `actioned` is nullable through the
      // LEFT JOIN, and SUM over NULLs returns NULL rather than 0 for a run with no findings.
      fn
        .count<string>(eb.case().when('f.actioned', '=', true).then(eb.ref('f.id')).end())
        .as('actioned_count'),
    ])
    // `r.id` alone: it is the primary key, so Postgres derives the other columns by functional
    // dependency. Listing all seven also works but drags the `jsonb` column into the GROUP BY, which
    // is legal only because jsonb has btree equality — it would break outright on a `json` column.
    .groupBy('r.id')
    .orderBy('r.started_at', 'desc')
    .limit(opts.limit ?? 50);

  if (opts.detector) q = q.where('r.detector', '=', opts.detector);

  const rows = await q.execute();
  return rows.map((r) => ({
    id: r.id,
    detector: r.detector,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    summary: r.summary,
    counters: asCounters(r.counters),
    receivedAt: r.received_at,
    findingCount: Number(r.finding_count),
    actionedCount: Number(r.actioned_count),
  }));
}

/**
 * The findings of one run, most-confident first.
 *
 * 🔴 The cap IS the contract's, imported rather than re-typed. Two independent literals could not be
 * pinned equal by any test living in one package, and if the reader's were the lower it would
 * silently drop rows the writer accepted — the two screens then disagree about one run, and the
 * missing rows are the ones the sort pushed to the bottom.
 *
 * Because they are equal, `truncated` cannot fire for a conforming report; it is the guard for the
 * case where they stop being equal, and the over-fetch is what makes that observable instead of
 * silent.
 */
export async function getAbuseFindings(
  runId: number,
  limit = MAX_FINDINGS_PER_REPORT
): Promise<{ findings: AbuseFinding[]; truncated: boolean }> {
  // One more than asked for, purely to detect the cap — the extra row is dropped below.
  const rows = await abuseDb()
    .selectFrom('abuse_detection_finding')
    .selectAll()
    .where('run_id', '=', runId)
    .orderBy('confidence', 'desc')
    .orderBy('id', 'asc')
    .limit(limit + 1)
    .execute();
  return { findings: rows.slice(0, limit).map(toFinding), truncated: rows.length > limit };
}

/**
 * Everything any detector has said about one account — the per-user lookup.
 *
 * Ordered newest-first and NOT filtered on `actioned`: "we looked at this account twice and did
 * nothing" is a real answer to "why is this creator complaining", and the most common one.
 */
export async function getAbuseFindingsForUser(
  userId: number,
  limit = 50
): Promise<{ findings: AbuseFinding[]; truncated: boolean }> {
  // 🔴 `truncated` is the whole reason this returns an object. It used to return a bare array, and
  // its caller rendered `rows.length` as the TOTAL — so an account with 300 findings read as
  // "Abuse detections (50)" and a moderator concluded they had seen the entire record. On a surface
  // whose whole claim is honest reporting, a cap presented as a total is the one number that lies.
  // Same `limit + 1` probe as `getAbuseFindings` above; the extra row is dropped.
  const rows = await abuseDb()
    .selectFrom('abuse_detection_finding')
    .selectAll()
    .where('user_id', '=', userId)
    .orderBy('created_at', 'desc')
    .limit(limit + 1)
    .execute();
  return { findings: rows.slice(0, limit).map(toFinding), truncated: rows.length > limit };
}

/** The distinct detectors that have ever reported, for the board's filter. */
export async function getAbuseDetectors(): Promise<string[]> {
  const rows = await abuseDb()
    .selectFrom('abuse_detection_run')
    .select('detector')
    .distinct()
    .orderBy('detector', 'asc')
    .execute();
  return rows.map((r) => r.detector);
}

function toFinding(r: {
  id: number;
  run_id: number;
  user_id: number;
  confidence: number;
  reason: string;
  actioned: boolean;
  action: string | null;
  created_at: Date;
}): AbuseFinding {
  return {
    id: r.id,
    runId: r.run_id,
    userId: r.user_id,
    confidence: r.confidence,
    reason: r.reason,
    actioned: r.actioned,
    action: r.action,
    createdAt: r.created_at,
  };
}

/**
 * `counters` is `jsonb`, so the driver hands back whatever was stored — including a scalar or an
 * array if a producer ever posts one. Anything that is not a flat object of finite numbers is
 * dropped rather than rendered: a counter panel showing `[object Object]`, or a NaN, is worse than
 * showing nothing, because it reads as a measurement.
 *
 * Exported for its own tests. Faking the Kysely chain `getAbuseRuns` builds well enough to reach this
 * would produce a fake that cannot see query shape — which the sibling report tests document as the
 * failure mode that lets a wrong query pass. A pure function is testable as one.
 */
export function asCounters(raw: unknown): Record<string, number> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}
