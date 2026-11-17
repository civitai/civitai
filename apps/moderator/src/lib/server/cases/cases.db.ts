import { getModeratorDb } from '../moderator-db';
import type { CasesTables } from './cases-tables';

/** The moderator database with the case tables typed in; one client, shared with the rest of the app. */
export const casesDb = () => getModeratorDb().withTables<CasesTables>();
export type CasesDb = ReturnType<typeof casesDb>;

/** The statuses a notice can be sent from. Send, export and the fallback's sent.jsonl import all use it. */
export const SENDABLE = ['pending', 'failed'] as const;

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
