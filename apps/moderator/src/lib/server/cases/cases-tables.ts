import type { ColumnType } from 'kysely';
import type { Generated, Timestamp } from '../moderator-db/types';

/**
 * The case engine's tables, in the same database as the rest of this app's moderation data.
 *
 * Declared here rather than in `moderator-db/types.ts`, as `abuse-detection-tables.ts` is: that file
 * mirrors the database as pulled, and these are hand-designed and hand-applied. `withTables<CasesTables>()`
 * adds them to the client's type without a second connection.
 *
 * Schema: `apps/moderator/cases/schema.sql`. `cases-schema.pglite.test.ts` applies it and checks that every
 * table and column here exists there and nothing there is missing here, and that the value sets below
 * match the CHECK constraints.
 *
 * `bigserial`/`bigint` columns are typed `number`: the moderator database's client parses int8 as a
 * number (`registerNumericTypeParsers` in `@civitai/db/kysely`). Ids stay far below 2^53.
 */

export const CASE_SOURCES = ['form', 'email', 'report', 'import'] as const;
export const CASE_TARGET_STATES = ['Pending', 'Removed', 'Held', 'Kept', 'Restored'] as const;
export const CASE_NOTICE_STATUSES = ['pending', 'sending', 'sent', 'failed'] as const;
export const CASE_PARTY_ROLES = ['claimant', 'uploader', 'agent-for-uploader'] as const;

export type CaseSource = (typeof CASE_SOURCES)[number];
export type CaseTargetState = (typeof CASE_TARGET_STATES)[number];
export type CaseNoticeStatus = (typeof CASE_NOTICE_STATUSES)[number];
export type CasePartyRole = (typeof CASE_PARTY_ROLES)[number];

type Json = ColumnType<unknown, string, string>;
type JsonWithDefault = ColumnType<unknown, string | undefined, string>;

export type CasesTables = {
  process_definition: {
    id: Generated<number>;
    key: string;
    current_version_id: number | null;
    enabled: Generated<boolean>;
    created_at: Generated<Timestamp>;
  };
  process_definition_version: {
    id: Generated<number>;
    definition_id: number;
    definition: Json;
    created_by_id: number;
    created_at: Generated<Timestamp>;
    note: string | null;
  };
  case_record: {
    id: Generated<number>;
    public_ref: string;
    process_key: string;
    /** NULL for imported cases, whose messages are verbatim rather than rendered from a definition. */
    definition_version_id: number | null;
    state: string;
    source: CaseSource;
    received_at: Timestamp;
    valid_at: Timestamp | null;
    due_at: Timestamp | null;
    warn_at: Timestamp | null;
    restore_earliest_at: Timestamp | null;
    restore_latest_at: Timestamp | null;
    minor_flag: Generated<boolean>;
    is_test: Generated<boolean>;
    related_case_id: number | null;
    submitter_user_id: number | null;
    /** Personal data: `case_record` is one of the five tables the read-only role cannot read. */
    submitter: JsonWithDefault;
    statements: JsonWithDefault;
    details: JsonWithDefault;
    email_confirmed_at: Timestamp | null;
    handled_by_id: number | null;
    decision: string | null;
    decided_at: Timestamp | null;
    retain_until: Timestamp | null;
    import_batch_id: string | null;
    submission_id: string | null;
    created_at: Generated<Timestamp>;
    updated_at: Generated<Timestamp>;
  };
  case_target: {
    id: Generated<number>;
    case_id: number;
    url: string;
    entity_type: string | null;
    entity_id: number | null;
    uploader_user_id: number | null;
    p_hash: string | null;
    hash_algo: string | null;
    category: string | null;
    state: Generated<CaseTargetState>;
    strike_id: number | null;
    kept_until: Timestamp | null;
    acted_at: Timestamp | null;
    acted_by_id: number | null;
  };
  case_event: {
    id: Generated<number>;
    case_id: number;
    case_target_id: number | null;
    at: Generated<Timestamp>;
    actor_id: number | null;
    type: string;
    threshold: string | null;
    attempt: number | null;
    data: JsonWithDefault;
  };
  case_notice: {
    id: Generated<number>;
    case_id: number;
    /** The target's id, or 0 for a message about the whole case. */
    target_key: number;
    notice_id: string;
    recipient_role: string;
    /** Personal data: where the message goes, as resolved when the row was made. NULL once erased. */
    recipient_address: string | null;
    address_hash: string;
    status: Generated<CaseNoticeStatus>;
    message_id: string | null;
    attempted_at: Timestamp | null;
    sent_at: Timestamp | null;
    /** An error class or code, never a message: messages can carry addresses. */
    error: string | null;
    subject_snapshot: string;
    /** NULL once erased: it quotes the recipient. */
    body_snapshot: string | null;
    created_at: Generated<Timestamp>;
  };
  case_party: {
    id: Generated<number>;
    case_id: number;
    role: CasePartyRole;
    user_id: number | null;
    address_hash: string | null;
    verified_at: Timestamp | null;
    created_at: Generated<Timestamp>;
  };
};

/** The tables that hold personal data or name the people a claim is about: no read-only role reads them. */
export const CASE_CLOSED_TABLES = [
  'case_record',
  'case_target',
  'case_party',
  'case_notice',
  'case_event',
] as const;

type ColumnList<T> = { readonly [K in keyof T]: readonly (keyof T[K] & string)[] };
/** Fails to compile when a list below omits a column `CasesTables` declares. */
type Exhaustive<T, L extends ColumnList<T>> = {
  [K in keyof T]: Exclude<keyof T[K], L[K][number]> extends never ? true : never;
};

/**
 * Every column of every table, at runtime, so the schema test can compare them with the DDL. The
 * `Exhaustive` check below makes a column added to `CasesTables` and not listed here a type error.
 */
export const CASES_COLUMNS = {
  process_definition: ['id', 'key', 'current_version_id', 'enabled', 'created_at'],
  process_definition_version: [
    'id',
    'definition_id',
    'definition',
    'created_by_id',
    'created_at',
    'note',
  ],
  case_record: [
    'id',
    'public_ref',
    'process_key',
    'definition_version_id',
    'state',
    'source',
    'received_at',
    'valid_at',
    'due_at',
    'warn_at',
    'restore_earliest_at',
    'restore_latest_at',
    'minor_flag',
    'is_test',
    'related_case_id',
    'submitter_user_id',
    'submitter',
    'statements',
    'details',
    'email_confirmed_at',
    'handled_by_id',
    'decision',
    'decided_at',
    'retain_until',
    'import_batch_id',
    'submission_id',
    'created_at',
    'updated_at',
  ],
  case_target: [
    'id',
    'case_id',
    'url',
    'entity_type',
    'entity_id',
    'uploader_user_id',
    'p_hash',
    'hash_algo',
    'category',
    'state',
    'strike_id',
    'kept_until',
    'acted_at',
    'acted_by_id',
  ],
  case_event: [
    'id',
    'case_id',
    'case_target_id',
    'at',
    'actor_id',
    'type',
    'threshold',
    'attempt',
    'data',
  ],
  case_notice: [
    'id',
    'case_id',
    'target_key',
    'notice_id',
    'recipient_role',
    'recipient_address',
    'address_hash',
    'status',
    'message_id',
    'attempted_at',
    'sent_at',
    'error',
    'subject_snapshot',
    'body_snapshot',
    'created_at',
  ],
  case_party: ['id', 'case_id', 'role', 'user_id', 'address_hash', 'verified_at', 'created_at'],
} as const satisfies ColumnList<CasesTables>;

const _exhaustive: Exhaustive<CasesTables, typeof CASES_COLUMNS> = {
  process_definition: true,
  process_definition_version: true,
  case_record: true,
  case_target: true,
  case_event: true,
  case_notice: true,
  case_party: true,
};
void _exhaustive;
