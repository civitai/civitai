import { sql, type SqlBool } from 'kysely';
import { getModeratorDb } from '../moderator-db';
import type { CasesTables } from './cases-tables';

/** The moderator database with the case tables typed in; one client, shared with the rest of the app. */
export const casesDb = () => getModeratorDb().withTables<CasesTables>();
export type CasesDb = ReturnType<typeof casesDb>;

/** `failed` errors a person set on purpose: retired after a failure, or withdrawn before any send. */
export const DROPPED_ERRORS = ['Retired', 'Withdrawn'] as const;

/**
 * `failed` errors a resend can't fix: the row was erased, its address no longer matches its hash, or a
 * person dropped it. Such a row is never sent, exported or retried again.
 */
export const RETIRED_ERRORS = ['Erased', 'AddressHashMismatch', ...DROPPED_ERRORS] as const;

/**
 * A notice that may be sent: `pending`, or `failed` for a reason a resend can fix. Send, export and the
 * fallback's sent.jsonl import all use it. `alias` is the table alias, if the query has one.
 */
export const sendable = (alias?: string) => {
  const col = (c: string) => sql.ref(alias ? `${alias}.${c}` : c);
  return sql<SqlBool>`(${col('status')} = 'pending' OR (${col('status')} = 'failed' AND (${col(
    'error'
  )} IS NULL OR ${col('error')} NOT IN (${sql.join([...RETIRED_ERRORS])}))))`;
};

/** An import batch id: the `batchId` of a backlog file. */
export const BATCH_ID = /^[a-z0-9-]{3,60}$/;

/** The notices of one import batch, joined to their case as `c`. */
export const noticesOfBatch = (db: CasesDb, batchId: string) =>
  db
    .selectFrom('case_notice as n')
    .innerJoin('case_record as c', 'c.id', 'n.case_id')
    .where('c.import_batch_id', '=', batchId);

/** A row `sending` for longer than this may or may not have gone out; a person checks it. */
export const STALE_SENDING_MS = 10 * 60 * 1000;
