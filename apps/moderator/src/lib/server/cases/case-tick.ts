import { sql, type Kysely, type OnConflictBuilder } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { caseAlert } from './case-alert';
import { casesDb, type CasesDb } from './cases.db';
import type { CasesTables } from './cases-tables';

/** The clocks a case can carry, in the order a moderator should read them. */
const CLOCKS = [
  { column: 'due_at', kind: 'overdue', label: 'past its deadline' },
  { column: 'warn_at', kind: 'warn', label: 'near its deadline' },
  { column: 'restore_latest_at', kind: 'restore-latest', label: 'past its latest restore date' },
  { column: 'restore_earliest_at', kind: 'restore-earliest', label: 'open for restore' },
] as const;

type ClockKind = (typeof CLOCKS)[number]['kind'];

/** `unsent` counts the alert lines that could not be sent this run; they are retried next run. */
export type CaseTickResult = {
  evaluated: number;
  alerted: number;
  overdue: number;
  unsent: number;
};

/** The last run, kept in the main DB's KeyValue so a gap in the schedule shows on the next run. */
export const CASE_TICK_HEARTBEAT_KEY = 'case-tick-heartbeat';
/** A gap this long between runs is reported, since no alert could fire while the tick was down. */
export const CASE_TICK_MAX_GAP_MS = 2 * 60 * 60 * 1000;

export type CaseTickHeartbeat = { at: string } & CaseTickResult;

/** Each threshold event is written once per case: a rerun, or an overlapping run, is a no-op. */
const onThreshold = (oc: OnConflictBuilder<CasesTables, 'case_event'>) =>
  oc.columns(['case_id', 'type', 'threshold']).where('threshold', 'is not', null).doNothing();

export type CaseTickDeps = {
  db: CasesDb;
  alert: (subject: string, text: string) => Promise<unknown>;
  heartbeat: {
    read: () => Promise<CaseTickHeartbeat | null>;
    write: (beat: CaseTickHeartbeat) => Promise<unknown>;
  };
  now?: () => Date;
};

/**
 * Evaluates the clocks of open, non-test, non-imported cases and records each crossed threshold once
 * (the unique case_event threshold key makes a rerun a no-op). Alerts on every recorded threshold not
 * yet alerted, plus a note when the schedule has a gap; a failed alert is retried on the next run.
 * `evaluated` counts the cases read, so a run that saw nothing reports 0 instead of looking healthy.
 */
export async function caseTick({
  db,
  alert,
  heartbeat,
  now = () => new Date(),
}: CaseTickDeps): Promise<CaseTickResult> {
  const at = now();
  // The heartbeat is only for the gap note; a failed read must not stop the clocks.
  const last = await heartbeat.read().catch(() => null);
  const open = await db
    .selectFrom('case_record as c')
    .select([
      'c.id',
      'c.public_ref as publicRef',
      'c.process_key as processKey',
      'c.minor_flag as minor',
      'c.due_at as due_at',
      'c.warn_at as warn_at',
      'c.restore_earliest_at as restore_earliest_at',
      'c.restore_latest_at as restore_latest_at',
    ])
    .where('c.source', '!=', 'import')
    .where('c.import_batch_id', 'is', null)
    .where('c.is_test', '=', false)
    .where('c.decided_at', 'is', null)
    // A party action can move a case to a terminal state without a decision; such a case is closed.
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom('process_definition_version as v')
            .whereRef('v.id', '=', 'c.definition_version_id')
            .where(
              sql<boolean>`v.definition->'states' @> jsonb_build_array(jsonb_build_object('id', c.state, 'terminal', true))`
            )
            .select(sql`1`.as('one'))
        )
      )
    )
    // A fixed lock order, so two overlapping runs wait on each other instead of deadlocking.
    .orderBy('c.id')
    .execute();

  // Thresholds are recorded first and committed on their own, so a failed alert can't undo them.
  const overdue = await db.transaction().execute(async (trx) => {
    let overdue = 0;
    for (const c of open) {
      for (const clock of CLOCKS) {
        const value = c[clock.column];
        if (!value) continue;
        const when = new Date(value as unknown as string);
        if (when > at) continue;
        if (clock.kind === 'warn' && c.due_at && new Date(c.due_at as unknown as string) <= at)
          continue;
        if (clock.kind === 'overdue') overdue++;
        await trx
          .insertInto('case_event')
          .values({
            case_id: c.id,
            type: 'clock',
            threshold: `${clock.kind}@${when.toISOString()}`,
            data: JSON.stringify({ at: at.toISOString() }),
          })
          .onConflict(onThreshold)
          .execute();
      }
    }
    return overdue;
  });

  const gap = last ? at.getTime() - new Date(last.at).getTime() : 0;
  const gapNote =
    last && gap > CASE_TICK_MAX_GAP_MS
      ? [
          `No clock check completed from ${
            last.at
          } until ${at.toISOString()}; anything below crossed during that gap.`,
        ]
      : [];

  // Every recorded threshold without a `clock-alerted` event is still owed an alert, whichever run
  // recorded it. The rows are claimed for the send, so an overlapping run skips them.
  const cases = new Map(open.map((c) => [Number(c.id), c]));
  const { alerted, unsent, failed } = await db.transaction().execute(async (trx) => {
    const pending = cases.size
      ? await trx
          .selectFrom('case_event as e')
          .select(['e.id', 'e.case_id as caseId', 'e.threshold'])
          .where('e.type', '=', 'clock')
          .where('e.case_id', 'in', [...cases.keys()])
          .where(({ not, exists, selectFrom }) =>
            not(
              exists(
                selectFrom('case_event as s')
                  .whereRef('s.case_id', '=', 'e.case_id')
                  .where('s.type', '=', 'clock-alerted')
                  .whereRef('s.threshold', '=', 'e.threshold')
                  .select(sql`1`.as('one'))
              )
            )
          )
          .orderBy('e.id')
          .forUpdate()
          .skipLocked()
          .execute()
      : [];
    const lines = pending.map((p) => {
      const c = cases.get(Number(p.caseId))!;
      const [kind, iso] = (p.threshold ?? '').split(/@(.*)/s) as [ClockKind, string];
      const clock = CLOCKS.find((k) => k.kind === kind);
      const hours = Math.round(((at.getTime() - new Date(iso).getTime()) / 36e5) * 10) / 10;
      return {
        minor: c.minor,
        kind,
        text: `${c.minor ? '[MINOR, escalate to Legal] ' : ''}${c.publicRef} (${c.processKey}) is ${
          clock?.label ?? kind
        }: ${iso} (${hours}h ago)`,
      };
    });
    const rank = (kind: ClockKind) => CLOCKS.findIndex((k) => k.kind === kind);
    lines.sort((a, b) => Number(b.minor) - Number(a.minor) || rank(a.kind) - rank(b.kind));
    if (!lines.length && !gapNote.length) return { alerted: 0, unsent: 0, failed: null };

    try {
      await alert(
        lines.length
          ? `Takedown clocks: ${lines.length} case threshold${
              lines.length === 1 ? '' : 's'
            } crossed`
          : `Takedown clocks: no clock check completed for over ${
              CASE_TICK_MAX_GAP_MS / 36e5
            } hours`,
        [...gapNote, ...lines.map((l) => l.text)].join('\n')
      );
    } catch (e) {
      const code = (e as Error)?.name || 'Error';
      return { alerted: 0, unsent: lines.length + gapNote.length, failed: { code, pending } };
    }
    // If this insert fails after the send, the next run sends the same lines again: a duplicate
    // alert is acceptable, a missed one is not.
    if (pending.length)
      await trx
        .insertInto('case_event')
        .values(
          pending.map((p) => ({
            case_id: p.caseId,
            type: 'clock-alerted',
            threshold: p.threshold,
            data: JSON.stringify({ at: at.toISOString() }),
          }))
        )
        .onConflict(onThreshold)
        .execute();
    return { alerted: lines.length, unsent: 0, failed: null };
  });

  // One unsent event per case and error code for as long as its oldest owed threshold stays unsent,
  // not one per run.
  if (failed) {
    const oldest = new Map<number, string | null>();
    for (const p of failed.pending)
      if (!oldest.has(Number(p.caseId))) oldest.set(Number(p.caseId), p.threshold);
    if (oldest.size)
      await db
        .insertInto('case_event')
        .values(
          [...oldest].map(([caseId, threshold]) => ({
            case_id: caseId,
            type: 'clock-alert-unsent',
            threshold: `${failed.code}:${threshold}`,
            data: JSON.stringify({ at: at.toISOString(), code: failed.code }),
          }))
        )
        .onConflict(onThreshold)
        .execute();
  }
  const result = { evaluated: open.length, alerted, overdue, unsent };
  await heartbeat.write({ at: at.toISOString(), ...result });
  return result;
}

export const keyValueHeartbeat = (mainDb: Kysely<DB>): CaseTickDeps['heartbeat'] => ({
  read: async () => {
    const row = await mainDb
      .selectFrom('KeyValue')
      .select('value')
      .where('key', '=', CASE_TICK_HEARTBEAT_KEY)
      .executeTakeFirst();
    return (row?.value as CaseTickHeartbeat | undefined) ?? null;
  },
  write: (beat) =>
    mainDb
      .insertInto('KeyValue')
      .values({ key: CASE_TICK_HEARTBEAT_KEY, value: JSON.stringify(beat) })
      .onConflict((oc) => oc.column('key').doUpdateSet({ value: JSON.stringify(beat) }))
      .execute(),
});

export const defaultCaseTickDeps = (mainDb: Kysely<DB>): CaseTickDeps => ({
  db: casesDb(),
  alert: (subject, text) => caseAlert(subject, text, 'caseTickAlert'),
  heartbeat: keyValueHeartbeat(mainDb),
});
