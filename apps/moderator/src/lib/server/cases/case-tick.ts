import { sendEmailStrict } from '@civitai/email';
import { sql, type Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { env } from '$env/dynamic/private';
import { casesDb, type CasesDb } from './cases.db';

/** The clocks a case can carry, in the order a moderator should read them. */
const CLOCKS = [
  { column: 'due_at', kind: 'overdue', label: 'past its deadline' },
  { column: 'warn_at', kind: 'warn', label: 'near its deadline' },
  { column: 'restore_latest_at', kind: 'restore-latest', label: 'past its latest restore date' },
  { column: 'restore_earliest_at', kind: 'restore-earliest', label: 'open for restore' },
] as const;

type ClockKind = (typeof CLOCKS)[number]['kind'];

export type CaseTickResult = { evaluated: number; alerted: number; overdue: number };

/** The last run, kept in the main DB's KeyValue so a gap in the schedule shows on the next run. */
export const CASE_TICK_HEARTBEAT_KEY = 'case-tick-heartbeat';
/** A gap this long between runs is reported, since no alert could fire while the tick was down. */
export const CASE_TICK_MAX_GAP_MS = 2 * 60 * 60 * 1000;

export type CaseTickHeartbeat = { at: string } & CaseTickResult;

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
 * (the unique case_event threshold key makes a rerun a no-op). Alerts on the thresholds this run newly
 * recorded, plus a note when the schedule has a gap. `evaluated` counts the cases read, so a run that
 * saw nothing reports 0 instead of looking healthy.
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

  // Thresholds are recorded and alerted together: if the alert fails, the records roll back and the
  // next run alerts them again, so a threshold is never marked done without anyone being told.
  const { alerted, overdue } = await db.transaction().execute(async (trx) => {
    const lines: { minor: boolean; kind: ClockKind; text: string }[] = [];
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
        const inserted = await trx
          .insertInto('case_event')
          .values({
            case_id: c.id,
            type: 'clock',
            threshold: `${clock.kind}@${when.toISOString()}`,
            data: JSON.stringify({ at: at.toISOString() }),
          })
          .onConflict((oc) =>
            oc
              .columns(['case_id', 'type', 'threshold'])
              .where('threshold', 'is not', null)
              .doNothing()
          )
          .returning('id')
          .executeTakeFirst();
        if (!inserted) continue;
        const hours = Math.round(((at.getTime() - when.getTime()) / 36e5) * 10) / 10;
        lines.push({
          minor: c.minor,
          kind: clock.kind,
          text: `${c.minor ? '[MINOR, escalate to Legal] ' : ''}${c.publicRef} (${
            c.processKey
          }) is ${clock.label}: ${when.toISOString()} (${hours}h ago)`,
        });
      }
    }

    const gap = last ? at.getTime() - new Date(last.at).getTime() : 0;
    const gapNote =
      last && gap > CASE_TICK_MAX_GAP_MS
        ? [
            `No clock check completed from ${
              last.at
            } until ${at.toISOString()}; anything below crossed during that gap.`,
          ]
        : [];
    const rank = (kind: ClockKind) => CLOCKS.findIndex((k) => k.kind === kind);
    lines.sort((a, b) => Number(b.minor) - Number(a.minor) || rank(a.kind) - rank(b.kind));

    if (lines.length || gapNote.length) {
      await alert(
        lines.length
          ? `Takedown clocks: ${lines.length} case threshold${
              lines.length === 1 ? '' : 's'
            } crossed`
          : 'Takedown clocks: no clock check completed for over 2 hours',
        [...gapNote, ...lines.map((l) => l.text)].join('\n')
      );
    }
    return { alerted: lines.length, overdue };
  });
  const result = { evaluated: open.length, alerted, overdue };
  await heartbeat.write({ at: at.toISOString(), ...result });
  return result;
}

/** The moderation alert inbox, shared by intake and the tick. */
export async function caseAlert(subject: string, text: string, template: string) {
  const to = env.MODERATION_ALERT_EMAIL;
  if (!to)
    throw Object.assign(new Error('MODERATION_ALERT_EMAIL is not set'), { name: 'NoAlertAddress' });
  await sendEmailStrict({
    to,
    subject,
    text,
    html: `<pre>${text.replace(
      /[&<>]/g,
      (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]!)
    )}</pre>`,
    tags: { template, mailClass: 'transactional' },
  });
}

export const defaultCaseTickDeps = (mainDb: Kysely<DB>): CaseTickDeps => ({
  db: casesDb(),
  alert: (subject, text) => caseAlert(subject, text, 'caseTickAlert'),
  heartbeat: {
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
  },
});
