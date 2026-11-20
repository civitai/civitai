import type { ProcessDefinition } from '@civitai/moderation/process-definition';
import type { CasePartyRole } from './cases-tables';
import { casesDb, type CasesDb } from './cases.db';
import {
  checkIntakeValues,
  submittedUrls,
  targetsFromUrls,
  type IntakeValues,
} from './intake-values';
import { newPublicRef } from './public-ref';
import { hashAddress } from './send-notice';

/** Thrown with every field problem, so the form can show them together. */
export class IntakeRefusedError extends Error {
  readonly status = 400;
  constructor(readonly fieldErrors: Record<string, string>) {
    super('The request has problems: ' + Object.keys(fieldErrors).join(', '));
    this.name = 'IntakeRefusedError';
  }
}

/** Who files each form: the uploader answers with a counter-notice; everyone else is a claimant. */
export const SUBMITTER_ROLE: Record<string, CasePartyRole> = { 'dmca-counter-notice': 'uploader' };
export const submitterRole = (key: string): CasePartyRole => SUBMITTER_ROLE[key] ?? 'claimant';

/**
 * The submitter says the person shown is or was a minor (Legal, 2026-11-20). Raised in code whatever
 * the definition does with it: the case is flagged and moderation alerted at submit.
 */
export const MINOR_FIELD = 'minor';
export const isMinorFlagged = (values: IntakeValues) => values[MINOR_FIELD] === true;

/** Contact details: held apart so erasure and the read-only lockdown can find them. */
const CONTACT_IDS = new Set(['name', 'email', 'contact', 'address', 'phone']);

/**
 * Adds whole weekdays (Monday to Friday, UTC). Holidays are not counted out; a deadline that must
 * skip them is Legal's call and belongs in the clock work (segment 4).
 */
export function addBusinessDays(from: Date, days: number) {
  const d = new Date(from);
  let left = days;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) left--;
  }
  return d;
}

/** The earliest deadline among the clocks that run from receipt, and its warning time. */
export function receiptDeadline(def: ProcessDefinition, receivedAt: Date) {
  let due: Date | null = null;
  let warn: Date | null = null;
  for (const c of def.clocks) {
    if (c.startsOn !== 'receipt') continue;
    const at =
      c.hours !== undefined
        ? new Date(receivedAt.getTime() + c.hours * 3_600_000)
        : addBusinessDays(receivedAt, c.businessDays ?? 0);
    if (!due || at < due) {
      due = at;
      warn = c.warnBeforeHours ? new Date(at.getTime() - c.warnBeforeHours * 3_600_000) : null;
    }
  }
  return { due, warn };
}

/** The case an earlier call with this submission id filed. Its receipt was that call's to send. */
async function existingSubmission(db: Pick<CasesDb, 'selectFrom'>, submissionId: string) {
  const row = await db
    .selectFrom('case_record as c')
    .innerJoin('case_party as p', 'p.case_id', 'c.id')
    .select(['c.id', 'c.public_ref', 'p.id as party_id'])
    .where('c.submission_id', '=', submissionId)
    .orderBy('p.id')
    .executeTakeFirst();
  return row
    ? {
        caseId: Number(row.id),
        publicRef: row.public_ref,
        partyId: Number(row.party_id),
        address: null,
        duplicate: true,
      }
    : null;
}

/**
 * Files one public request as a case: the record, a target per URL, the submitting party and a
 * `received` event, in one transaction. The values are checked against the definition first; nothing
 * is written for a refused request. Returns the case's public reference and the party's id (its link
 * token is minted against that id).
 */
export async function fileIntakeCase(
  input: {
    definition: ProcessDefinition;
    versionId: number;
    values: IntakeValues;
    submissionId?: string;
    submitterUserId?: number;
    isTest?: boolean;
    receivedAt?: Date;
  },
  { db = casesDb() }: { db?: CasesDb } = {}
) {
  const { definition: def, values } = input;
  const fieldErrors = checkIntakeValues(def, values);
  if (Object.keys(fieldErrors).length) throw new IntakeRefusedError(fieldErrors);

  const submitter: Record<string, unknown> = {};
  const statements: { id: string; label: string; value: unknown }[] = [];
  const details: Record<string, unknown> = {};
  for (const f of def.fields) {
    const v = values[f.id];
    if (v === undefined) continue;
    if (f.kind === 'checkbox' || f.kind === 'signature')
      statements.push({ id: f.id, label: f.label, value: v });
    else if (f.kind === 'email' || CONTACT_IDS.has(f.id)) submitter[f.id] = v;
    else details[f.id] = v;
  }
  const email = def.fields.find((f) => f.kind === 'email' && typeof values[f.id] === 'string');
  const address = email ? (values[email.id] as string).trim() : null;
  const receivedAt = input.receivedAt ?? new Date();
  const { due, warn } = receiptDeadline(def, receivedAt);
  const targets = targetsFromUrls(submittedUrls(def, values));

  if (input.submissionId) {
    const seen = await existingSubmission(db, input.submissionId);
    if (seen) return seen;
  }

  return db.transaction().execute(async (tx) => {
    const record = await tx
      .insertInto('case_record')
      .values({
        public_ref: newPublicRef(receivedAt),
        submission_id: input.submissionId ?? null,
        process_key: def.key,
        definition_version_id: input.versionId,
        state: def.initialState,
        source: 'form',
        received_at: receivedAt.toISOString(),
        due_at: due?.toISOString() ?? null,
        warn_at: warn?.toISOString() ?? null,
        is_test: input.isTest ?? false,
        minor_flag: isMinorFlagged(values),
        submitter_user_id: input.submitterUserId ?? null,
        submitter: JSON.stringify(submitter),
        statements: JSON.stringify(statements),
        details: JSON.stringify(details),
      })
      .onConflict((oc) => oc.column('submission_id').doNothing())
      .returning(['id', 'public_ref'])
      .executeTakeFirst();
    // The same submission won a race with this one: answer with that case, writing nothing.
    if (!record) return (await existingSubmission(tx, input.submissionId!))!;
    for (const t of targets)
      await tx
        .insertInto('case_target')
        .values({
          case_id: record.id,
          url: t.url,
          entity_type: t.entityType,
          entity_id: t.entityId,
        })
        .execute();
    const party = await tx
      .insertInto('case_party')
      .values({
        case_id: record.id,
        role: submitterRole(def.key),
        user_id: input.submitterUserId ?? null,
        address_hash: address ? hashAddress(address) : null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await tx
      .insertInto('case_event')
      .values({
        case_id: record.id,
        type: 'received',
        data: JSON.stringify({ source: 'form', version: input.versionId, targets: targets.length }),
      })
      .execute();
    return {
      caseId: Number(record.id),
      publicRef: record.public_ref,
      partyId: Number(party.id),
      address,
      duplicate: false,
    };
  });
}
