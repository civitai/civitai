import { MAX_FINDINGS_PER_REPORT, type AbuseReportInput } from '@civitai/moderation';
import { sql, type Kysely, type Transaction } from 'kysely';
import { getModeratorDb } from './moderator-db';
import type { AbuseDetectionTables, AbuseVerdict } from './abuse-detection-tables';

/** The shared client, typed to include the two tables this module owns. */
const abuseDb = () => getModeratorDb().withTables<AbuseDetectionTables>();

type AbuseDb = ReturnType<typeof abuseDb>;
type AbuseTrx = Transaction<AbuseDb extends Kysely<infer DB> ? DB : never>;

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
  /** 🔴 The PRODUCER's self-report. Not a verdict — see `verdict` below and the schema's comment. */
  actioned: boolean;
  action: string | null;
  createdAt: Date;
  /** The MODERATOR's ruling, or `null` for unruled. `null` is also what a deployment that has not
   *  applied the DDL yet reports for every row, which is the correct read-only degradation: nothing
   *  has been ruled there, because nothing CAN be. */
  verdict: AbuseVerdict | null;
  verdictBy: string | null;
  verdictAt: Date | null;
  /** The producer's cluster key. Findings sharing one WITHIN A RUN are one decision. */
  groupKey: string | null;
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
 * Postgres `undefined_column`.
 *
 * 🔴 THE SIBLING OF `42P01`, AND IT EXISTS BECAUSE THE DDL IS APPLIED BY HAND. `42P01` is "the
 * tables were never created"; this is the state that only became reachable once columns were ADDED
 * to a table that already exists — the board is live, the runs and findings are all there, and the
 * four verdict columns are not, because nobody has re-run `schema.sql` since the deploy. Read as an
 * outage it sends an operator hunting a database that is working perfectly.
 *
 * The two sides answer it differently, on purpose. A READ degrades: `getAbuseVerdictSummary` returns
 * `null`, the page renders every finding read-only, and no moderator is shown an error about a
 * feature they were not using a minute ago. A WRITE cannot degrade — silently accepting a ruling
 * that was never stored is the one outcome worse than refusing it — so `recordAbuseVerdict`
 * translates it into a message naming the file to run, exactly as the 42P10 branch above does.
 */
const PG_UNDEFINED_COLUMN = '42703';

/**
 * Postgres `insufficient_privilege`.
 *
 * The read paths already discriminate it: `schema.sql` says to apply it AS THE APPLICATION ROLE, and
 * running it as `postgres` instead — the natural `psql -U postgres` shortcut — leaves tables the app
 * cannot touch. The write path has to say it too, for the same reason it translates 42703: a bare
 * "the database refused the write" sends an operator hunting an outage on a database that is
 * healthy, and the remedy (ownership, not a grant — `ALTER TABLE` needs to be run BY the owner) is
 * not something the moderator on the other end of the click could guess.
 */
const PG_INSUFFICIENT_PRIVILEGE = '42501';

/** True for the pg error raised when a column in the statement does not exist on the table. */
export const isUndefinedColumnError = (e: unknown): boolean =>
  (e as { code?: unknown } | null)?.code === PG_UNDEFINED_COLUMN;

/**
 * The four columns THIS FEATURE added to a table that was already live and already receiving
 * reports. Named once, because two different things branch on the set: the capability probe below,
 * and the `42703` backstop, which has to separate two states that share one error code and have
 * opposite remedies: a column THIS CHANGE added is missing, versus some unrelated column is.
 */
const VERDICT_DDL_COLUMNS = ['verdict', 'verdict_by', 'verdict_at', 'group_key'] as const;

/**
 * The column a `42703` names, or `null` for anything else.
 *
 * 🔴 PARSED FROM THE MESSAGE, BECAUSE THERE IS NO `error.column` TO READ. Measured against a real
 * server (PGlite 0.4.6, the harness in `__tests__/abuse-detection-pglite.harness.ts`): Postgres
 * populates the `column_name` error field for CONSTRAINT violations, not for a PARSE-time
 * `undefined_column`. A dropped-column INSERT comes back `routine: 'checkInsertTargets'` and a
 * dropped-column WHERE comes back `routine: 'errorMissingColumn'`, and NEITHER carries `column` —
 * the name exists only in the message, in one of two spellings:
 *
 *   column "group_key" of relation "abuse_detection_finding" does not exist   (INSERT/UPDATE target)
 *   column "verdict" does not exist                                           (everywhere else)
 *
 * The leading `column "…"` is common to both, which is what this reads. An unrecognised message
 * yields `null` and the error propagates unchanged — the safe direction, because the alternative is
 * retrying a write whose failure nobody understood.
 */
export function missingColumnFromError(e: unknown): string | null {
  const err = e as { code?: unknown; message?: unknown } | null;
  if (err?.code !== PG_UNDEFINED_COLUMN) return null;
  if (typeof err.message !== 'string') return null;
  const m = /column "([^"]+)"/.exec(err.message);
  return m ? m[1] : null;
}

/**
 * Does the live table carry the columns this feature added?
 *
 * 🔴 ASKED, NOT DISCOVERED BY FAILING — and that is the whole point of this function. The DDL is
 * applied by hand, so there is a window in which the table exists and these columns do not. Learning
 * that from a `42703` costs a ROLLED-BACK TRANSACTION plus a full redo on every report from every
 * detector, including the two that never send a group key and therefore lose nothing; and it cannot
 * separate a missing column of THIS change's from an unrelated missing column, so it reports the
 * second as the first and points the operator at the wrong file. One catalogue read answers it
 * outright, on a path that runs a handful of times a day.
 *
 * 🔴 NOT MEMOISED. A per-process cache would answer from a measurement taken before the operator ran
 * the file, so the first pod to report in the pre-DDL window would keep storing runs ungrouped until
 * it was restarted — and the same staleness in a test process, where each case builds its own
 * database, would answer about the previous case's table. A round trip is cheaper than either.
 *
 * `to_regclass` resolves the name through the SAME `search_path` the statements below use, and
 * answers NULL for a table that is not there at all — in which case no rows come back, the write is
 * built in its pre-DDL shape, and the missing TABLE raises its own `42P01` exactly as before.
 *
 * ALL FOUR or none: a half-applied DDL is treated as not applied, because the degraded path is the
 * one that cannot be wrong about a column it never names.
 */
async function verdictColumnsPresent(trx: AbuseTrx): Promise<boolean> {
  const { rows } = await sql<{ attname: string }>`
    SELECT attname FROM pg_attribute
     WHERE attrelid = to_regclass('abuse_detection_finding')
       AND attnum > 0 AND NOT attisdropped`.execute(trx);
  const present = new Set(rows.map((r) => r.attname));
  return VERDICT_DDL_COLUMNS.every((c) => present.has(c));
}

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
    const { runId, storedUngrouped } = await writeRun(db, input);
    if (storedUngrouped) warnStoringUngrouped('group_key', input);
    return { runId };
  } catch (e) {
    // 🔴 THE INGEST PATH DEGRADES RATHER THAN STOPPING, AND THIS IS NOW ONLY THE BACKSTOP.
    // `verdictColumnsPresent` asks the catalogue before building the statements, so an ordinary
    // pre-DDL report never reaches here at all — no rolled-back transaction and no redo, which is
    // what every report from every detector used to pay for a feature two of the three do not use.
    // What is left for this branch is the race: the DDL applied, or reverted, between the probe and
    // the write.
    //
    // 🔴 GATED ON WHICH COLUMN IS MISSING. `42703` is equally what an UNRELATED dropped column
    // raises, and the old unconditional branch answered that with `abuse_detection_finding has no
    // group_key column - apply schema.sql`: a confident, wrong remedy for a different fault, logged
    // just before the real error propagated. Only a column THIS change added is retried past.
    const missing = missingColumnFromError(e);
    if (missing !== null && (VERDICT_DDL_COLUMNS as readonly string[]).includes(missing)) {
      const { runId } = await writeRun(db, input, { forceLegacyShape: true });
      warnStoringUngrouped(missing, input);
      return { runId };
    }
    if ((e as { code?: unknown }).code === PG_NO_MATCHING_CONFLICT_TARGET)
      throw new Error(
        'abuse_detection_run is missing its (detector, started_at) UNIQUE index — apply ' +
          'apps/moderator/abuse-detection/schema.sql to MODERATOR_DATABASE_URL',
        { cause: e }
      );
    throw e;
  }
}

/**
 * 🔴 WARNED ONLY WHEN SOMETHING WAS ACTUALLY LOST — i.e. when this report carried a key the table
 * cannot hold. Three detectors post to this board and two of them send no key at all; warning on
 * their reports too, on every report, until a human runs a file, is a log line that carries no
 * information and trains its reader past the one that does. "My ring did not collapse into one row"
 * is the otherwise-unexplainable UI bug this message exists to explain, and a report with no ring in
 * it cannot have that bug.
 *
 * Emitted after the write, not before: a run that did not land has lost its grouping the way it lost
 * everything else, and saying so separately would be a second explanation for one failure.
 */
function warnStoringUngrouped(column: string, input: AbuseReportInput): void {
  if (!input.findings.some((f) => f.groupKey != null)) return;
  console.warn(
    `[abuse-detection] abuse_detection_finding has no ${column} column — storing this run ` +
      'UNGROUPED. Apply apps/moderator/abuse-detection/schema.sql to MODERATOR_DATABASE_URL.'
  );
}

async function writeRun(
  db: AbuseDb,
  input: AbuseReportInput,
  opts: { forceLegacyShape?: boolean } = {}
): Promise<{ runId: number; storedUngrouped: boolean }> {
  return db.transaction().execute(async (trx) => {
    // Asked once per report, inside the transaction whose statements are shaped by the answer.
    const withVerdictColumns = opts.forceLegacyShape ? false : await verdictColumnsPresent(trx);

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
      // reader cannot tell which is current.
      //
      // 🔴 RE-REPORTING REPLACES THE PRODUCER'S DATA AND KEEPS THE MODERATOR'S. It used to replace
      // everything: the run row survived the upsert with the same id, and the next statement deleted
      // every finding on it and re-inserted them from a payload that carries no verdict fields. That
      // was lossless while these rows held only producer-generated data; it stopped being lossless
      // the moment a human judgement went into the same row. Measured against this file's own PGlite
      // harness: rule three findings, re-POST the identical (detector, startedAt), and the run's
      // "still to review" count went from `{ ruled: 3, unruled: 0 }` back to `{ ruled: 0, unruled: 3 }`
      // — silently, with new row ids, reading exactly like a fresh run. The replay that does it is
      // the ordinary "committed, response lost to a timeout" retry this upsert exists for. See
      // `replaceFindings` below for what survives now.
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

    await replaceFindings(trx, run.id, input.findings, withVerdictColumns);
    return { runId: run.id, storedUngrouped: !withVerdictColumns };
  });
}

/**
 * Bring one run's findings in line with the payload, WITHOUT destroying a ruling.
 *
 * 🔴 THE DELETE IS SCOPED TO THE UNRULED ROWS, AND THAT IS THE WHOLE FIX. A clear-and-reinsert is the
 * right shape for rows a producer owns outright — it is what stops a replayed run accumulating its
 * findings twice, which is a real bug and is still prevented here. It is the wrong shape for a row a
 * human has written to. A verdict is not the producer's to delete by re-POSTing, and it is the one
 * thing in this table that cannot be recomputed: re-running the detector reproduces every producer
 * column exactly and reproduces no verdict at all.
 *
 * 🔴 NO ACCUMULATION. After this runs, the findings on the run are: every ruled row that was already
 * there, plus one row for each payload finding no ruled row already covers. Both halves are fixed
 * points — a second replay of the same payload deletes the unruled half and re-inserts exactly it —
 * so replaying N times leaves the same row count as replaying once. Growth is possible only through
 * a moderator ruling something, which is the intended direction.
 *
 * 🔴 THE MATCH IS `(run_id, user_id)`, and it is a match, not a key. The table has no unique index on
 * that pair and this does not add one — adding one would be a second hand-applied DDL step, and on a
 * live table already holding whatever the detectors have written it could not be created at all
 * without a de-duplication pass first. Counting survivors per user instead makes a payload that
 * repeats a user behave sanely (its first N findings for that user are the ones already present)
 * without claiming a uniqueness the database does not enforce.
 *
 * 🔴 A RULED ROW IS NOT REFRESHED FROM THE PAYLOAD, deliberately. The moderator ruled on the `reason`
 * and `confidence` that were on screen; overwriting them with a replay's copy would leave a verdict
 * attached to evidence nobody ruled on. For a genuine replay the two are identical anyway — the
 * payload is keyed by `(detector, started_at)`, so a second POST under that pair is the same run.
 *
 * 🔴 THE AWKWARD CASE — A RULED FINDING THE REPLAY NO LONGER REPORTS — IS KEPT, NOT DROPPED, and this
 * is a decision rather than a fallout. Either way makes a claim: keeping it leaves a row on the run
 * that this payload did not assert, and dropping it destroys a judgement a human made. Kept, because
 * the two failures are not symmetric. A retained row is visible — it is on the board, ruled, with its
 * ruler and its timestamp — and a moderator or an operator can act on it. A dropped verdict is
 * invisible, unrecoverable, and it silently deflates the denominator of the false-positive rate this
 * whole board exists to measure; a detector that stopped flagging an account it was told was a false
 * positive would be erasing precisely the evidence of its own error. `abuse-detection.verdict.test.ts`
 * pins this direction.
 */
async function replaceFindings(
  trx: AbuseTrx,
  runId: number,
  findings: AbuseReportInput['findings'],
  withVerdictColumns: boolean
): Promise<void> {
  if (!withVerdictColumns) {
    // Pre-DDL there is no `verdict` column to scope the delete by, and nothing to preserve either:
    // no ruling can have been recorded on a deployment that cannot store one. The original
    // clear-and-reinsert is exactly right there, and naming a column that does not exist is the
    // error this whole branch exists to avoid.
    await trx.deleteFrom('abuse_detection_finding').where('run_id', '=', runId).execute();
    await insertFindings(trx, runId, findings, false);
    return;
  }

  await trx
    .deleteFrom('abuse_detection_finding')
    .where('run_id', '=', runId)
    .where('verdict', 'is', null)
    .execute();

  const survivors = await trx
    .selectFrom('abuse_detection_finding')
    .select(['id', 'user_id'])
    .where('run_id', '=', runId)
    .execute();

  const survivorsPerUser = new Map<number, number>();
  for (const s of survivors)
    survivorsPerUser.set(s.user_id, (survivorsPerUser.get(s.user_id) ?? 0) + 1);

  const fresh: AbuseReportInput['findings'] = [];
  for (const f of findings) {
    const remaining = survivorsPerUser.get(f.userId) ?? 0;
    // Already on the run, carrying a ruling. Left exactly as it is.
    if (remaining > 0) survivorsPerUser.set(f.userId, remaining - 1);
    else fresh.push(f);
  }
  await insertFindings(trx, runId, fresh, true);
}

/** The producer's rows, in the shape the live table can hold. */
async function insertFindings(
  trx: AbuseTrx,
  runId: number,
  findings: AbuseReportInput['findings'],
  withGroupKey: boolean
): Promise<void> {
  if (findings.length === 0) return;
  await trx
    .insertInto('abuse_detection_finding')
    .values(
      findings.map((f) => ({
        run_id: runId,
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
        // 🔴 NORMALISED TO NULL, never left undefined. The contract accepts an ABSENT key from
        // the three producers that do not send one, and `undefined` in a Kysely `values()` row
        // omits the column from the INSERT — which is fine on its own, but one statement whose
        // rows disagree about their columns is a runtime error rather than a missing value. NULL
        // is also exactly what "this finding is in no cluster" means in the table.
        //
        // Dropped entirely — not set to NULL — in the pre-DDL shape, because naming a column that
        // does not exist is the error that shape exists to avoid.
        ...(withGroupKey ? { group_key: f.groupKey ?? null } : {}),
      }))
    )
    .execute();
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

/**
 * 🔴 THE FOUR VERDICT FIELDS ARE OPTIONAL ON THE INPUT, AND THAT IS THE READ-SIDE DEGRADATION.
 *
 * Both find queries are `selectAll()`, so against a database whose DDL has not been applied the
 * driver simply hands back rows without these keys — no error, because nothing NAMED a column that
 * is missing. `?? null` is what turns that into "unruled", which is the truthful reading: on a
 * deployment with no verdict columns, nothing has been ruled and nothing can be.
 *
 * Widening `selectAll()` into an explicit column list would convert that silent, correct degradation
 * into a 42703 on the board's main read. Do not.
 */
function toFinding(r: {
  id: number;
  run_id: number;
  user_id: number;
  confidence: number;
  reason: string;
  actioned: boolean;
  action: string | null;
  created_at: Date;
  verdict?: AbuseVerdict | null;
  verdict_by?: string | null;
  verdict_at?: Date | null;
  group_key?: string | null;
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
    verdict: r.verdict ?? null,
    verdictBy: r.verdict_by ?? null,
    verdictAt: r.verdict_at ?? null,
    groupKey: r.group_key ?? null,
  };
}

/**
 * How much of a run has been ruled on, or `null` when the verdict columns are not applied here.
 *
 * 🔴 A SEPARATE QUERY RATHER THAN A COLUMN ON `getAbuseRun`, and the separation is the degradation.
 * This is the one read that NAMES `verdict`, so it is the one read that can raise 42703 — folding it
 * into the run header's counts would put that failure on the path the whole detail page depends on,
 * and the page would 503 on a database that is serving every row it holds.
 *
 * 🔴 COUNTED OVER THE WHOLE RUN, not over the page. `getAbuseFindings` caps at
 * MAX_FINDINGS_PER_REPORT and reports `truncated`; a "12 still to review" derived from the rendered
 * rows would be a cap presented as a total — the exact lie the per-user read was fixed for.
 *
 * `null` is not zero and the caller must not render it as one: zero means "everything here has been
 * ruled on", `null` means "this deployment cannot record a ruling at all".
 */
export async function getAbuseVerdictSummary(
  runId: number
): Promise<{ ruled: number; unruled: number } | null> {
  try {
    const row = await abuseDb()
      .selectFrom('abuse_detection_finding')
      .select(({ fn, eb }) => [
        // COUNT of a filtered expression: `count(verdict)` alone would skip NULLs and give the ruled
        // half, but there is no matching spelling for the unruled half, and two differently-shaped
        // counters beside each other is how one of them silently stops meaning what it says.
        fn
          .count<string>(eb.case().when('verdict', 'is not', null).then(eb.ref('id')).end())
          .as('ruled'),
        fn
          .count<string>(eb.case().when('verdict', 'is', null).then(eb.ref('id')).end())
          .as('unruled'),
      ])
      .where('run_id', '=', runId)
      .executeTakeFirst();
    return { ruled: Number(row?.ruled ?? 0), unruled: Number(row?.unruled ?? 0) };
  } catch (e) {
    // The DDL has not been applied here. Read-only is the correct state, not an error.
    if (isUndefinedColumnError(e)) return null;
    throw e;
  }
}

/**
 * Record one moderator's ruling.
 *
 * 🔴 SCOPED TO THE RUN, ALWAYS — `runId` is not a convenience, it is the authorisation boundary of
 * the write. A finding id arrives in a form post and is therefore attacker-chosen; without the run
 * predicate, a post from run 7's page could rule a finding belonging to run 9, and — worse, because
 * it is invisible — a group ruling would reach every run that ever carried the same `group_key`. The
 * same email-domain ring reappears in tomorrow's cohort under the identical key, so "all findings
 * with this key" without a run bound is "every day this ring has ever been seen", ruled in one click
 * by someone who reviewed one day's evidence.
 *
 * 🔴 ONE RULING, N FINDINGS, only when the producer said so. A non-NULL `group_key` is the producer's
 * claim that these rows are one actor; the ruling then covers all of them IN THIS RUN. A NULL key is
 * not a group — it is the absence of one — so it must never be used as a match value, or every
 * ungrouped finding in the run would be ruled together by the first one anybody clicked.
 *
 * 🔴 IT DOES NOT TOUCH `actioned` OR `action`. Those are the producer's record of what IT did; this
 * is a human's record of whether that was right. Overwriting the first with the second would destroy
 * the only evidence of what the detector actually chose to do, which is the measurement this whole
 * board exists to make.
 *
 * Re-ruling is expected and overwrites: `verdict_by`/`verdict_at` always name the CURRENT ruling, so
 * a moderator correcting a mistake stands behind the correction rather than the mistake.
 */
export async function recordAbuseVerdict(input: {
  runId: number;
  findingId: number;
  verdict: AbuseVerdict;
  verdictBy: string;
}): Promise<{ updated: number; groupKey: string | null }> {
  const db = abuseDb();
  try {
    // The clicked finding, read first — it is what supplies the group key, and reading it is also
    // how a finding that does not belong to this run is refused rather than ruled.
    const target = await db
      .selectFrom('abuse_detection_finding')
      .select(['id', 'group_key'])
      .where('id', '=', input.findingId)
      .where('run_id', '=', input.runId)
      .executeTakeFirst();
    if (!target) return { updated: 0, groupKey: null };

    const groupKey = target.group_key ?? null;
    let q = db
      .updateTable('abuse_detection_finding')
      .set({
        verdict: input.verdict,
        verdict_by: input.verdictBy,
        // The server's clock, not the browser's: this is an audit field.
        verdict_at: new Date(),
      })
      .where('run_id', '=', input.runId);
    // Grouped: every member of the cluster in THIS run. Ungrouped: this row and nothing else.
    q =
      groupKey === null ? q.where('id', '=', input.findingId) : q.where('group_key', '=', groupKey);

    const result = await q.executeTakeFirst();
    return { updated: Number(result?.numUpdatedRows ?? 0), groupKey };
  } catch (e) {
    // 🔴 A WRITE MUST NOT DEGRADE. Accepting a ruling the database never stored, and rendering it as
    // recorded, is worse than refusing it — the moderator moves on believing the row is graded.
    if (isUndefinedColumnError(e))
      throw new Error(
        'abuse_detection_finding has no verdict columns — apply ' +
          'apps/moderator/abuse-detection/schema.sql to MODERATOR_DATABASE_URL as the application role',
        { cause: e }
      );
    // 🔴 THE SAME DISCRIMINATION THE TWO READ PATHS ALREADY MAKE. Both `+page.server.ts` loads
    // branch on 42501 and say "re-run schema.sql as the application role"; without this the write
    // answered the identical cause with "the database refused the write", which reads as an outage.
    // It is a LIKELY state, not a hypothetical: the file's own header exists because `psql -U
    // postgres` is the natural shortcut, and it leaves tables the app can be granted rights on but
    // still does not own — enough to SELECT, not enough for the `ALTER TABLE`s this file now runs.
    if ((e as { code?: unknown }).code === PG_INSUFFICIENT_PRIVILEGE)
      throw new Error(
        'this role cannot write abuse_detection_finding — re-run ' +
          'apps/moderator/abuse-detection/schema.sql as the application role, or transfer ownership ' +
          'of the tables to it (see the file header)',
        { cause: e }
      );
    throw e;
  }
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
