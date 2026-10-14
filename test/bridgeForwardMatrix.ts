import { TRPCClientError } from '@trpc/client';
import { expect, vi } from 'vitest';
import type { BridgeRpcMock } from './bridgeRpcMock';
import { trpcError } from './fixtures/trpc-client-error';
import { RATE_LIMIT, rateLimitedClientError } from './fixtures/shared-storage-rate-limit';
import {
  INVENTORY,
  checkReplyKeys,
  parseDeclaredKeys,
  type InventoryType,
} from '~/components/AppBlocks/hostHandlerParity';

/**
 * CHARACTERISATION MATRIX for every FORWARDED App Blocks bridge handler, on both hosts.
 *
 * A "forward" is a handler whose whole job is: validate the block's postMessage, call ONE
 * tRPC procedure with the host's block token, and post ONE `*_RESULT` reply. `PageBlockHost`
 * (PBH) and `IframeHost` (IH) each hand-write these, so the same contract exists twice. This
 * table pins what both do TODAY, row by row, with literal expectations — it is the safety net
 * a later consolidation must keep green, and it is valuable without one.
 *
 * Which host must serve a type comes from `hostHandlerParity.ts` INVENTORY ('required');
 * the first test in each `*HostForwardMatrix.browser.test.tsx` asserts that the types this
 * table covers for that host are exactly INVENTORY's `required` set, that INVENTORY's
 * `reply` agrees with `REPLY_TYPE` below, and that INVENTORY's `replyKeys` / `errorKeys` agree
 * with the pinned replies (`replyKeysProblems`).
 *
 * Each row asserts, with STRICT equality (an `undefined`-valued key is not the same as an
 * absent one):
 *   - the procedure was called exactly once with exactly `call`, or not at all (`call: null`);
 *   - exactly one reply of the type's reply message arrived, with exactly `reply`, or none
 *     (`reply: null`) — and a "none" is only believed after a positive control: the same
 *     mount answers a valid request of the same type afterwards (see `runRow`);
 *   - for a write with `invalidates`, the namespace invalidation SETTLED before the reply
 *     arrived (the reply must not exist while the invalidation is held open), and no
 *     `apps.*` invalidation happened on any other row.
 *
 * 🔴 A row marked `// current behaviour; candidate fix D<n>` pins something that looks
 * accidental. Each is pinned current behaviour ON PURPOSE — whether to change it belongs to
 * the host-handler table-refactor decision (ask an App Blocks owner), not to this suite:
 *   D1  two spellings of the no-token reply: `block credential unavailable` (nack families)
 *       vs `no block token` (subqueue / buzz / viewer / images).
 *   D2  CANCEL_APP_WORKFLOW validates BEFORE the review gate, so a malformed review request
 *       gets no reply (every other gated forward NACKs it).
 *   D3  a non-Error rejection gets one of three fallback texts (`workflow request failed`,
 *       `unknown`, `storage request failed`).
 *   D4  a malformed payload WITH a requestId is dropped silently, so the block waits for its
 *       SDK timeout — the one D-item with a user-facing effect.
 *   D5  QUERY_APP_WORKFLOWS spreads a non-object `params` (a string becomes indexed keys).
 *   D6  GET_IMAGES_BY_IDS drops an empty-string requestId; every other forward echoes it.
 *   D7  a storage no-token reply omits the type's failure fields (`value:null`, `ok:false`,
 *       `keys:[]`, zeroed quota, `item:null`) that its error and review replies carry.
 *   D8  SHARED_WITHDRAW's error/review replies carry no `ok:false`; UPDATE/REPORT do.
 */

export type Host = 'PageBlockHost' | 'IframeHost';
export type MountMode = 'default' | 'noToken' | 'review' | 'reviewRunForReal';

export interface MatrixRow {
  type: string;
  scenario: string;
  hosts: readonly Host[];
  mode: MountMode;
  payload: unknown;
  proc: string;
  rpc: { resolves: unknown } | { rejects: unknown };
  /** Exact argument list of the single call, or `null` for "never called". */
  call: unknown[] | null;
  /** Exact payload of the single reply, or `null` for "no reply". */
  reply: Record<string, unknown> | null;
  invalidates?: 'apps.storage' | 'apps.shared';
  candidateFix?: string;
}

// ── Literals every row speaks in ────────────────────────────────────────────────────────
export const TOKEN = 'tok_abc';
const REVIEW_NACK = 'not available in review preview';
/** `usePostMessage().nack` — the workflow / storage / shared families. */
const NACK_NO_TOKEN = 'block credential unavailable';
/** The hand-written `!token` replies — subqueue / buzz / viewer / images. */
const LEGACY_NO_TOKEN = 'no block token';
const READ_OPTS = { staleTime: 1_000 };

const BOTH: readonly Host[] = ['PageBlockHost', 'IframeHost'];
const PBH: readonly Host[] = ['PageBlockHost'];

const boom = new Error('boom');
/** A rejection that is not an Error at all — each family has its own fallback text. */
const NOT_AN_ERROR = 'nope';
/**
 * A real `TRPCClientError` carrying `data.rateLimit`. Its prose (1849s) disagrees with the
 * metadata (`RATE_LIMIT.retryAfterSeconds` = 17), so a host that parsed the message would fail.
 */
const RL_MESSAGE = 'Too many requests — retry in 1849s';
const rateLimited = rateLimitedClientError(RL_MESSAGE);
const rateLimitedMalformedMeta = TRPCClientError.from({
  error: {
    message: RL_MESSAGE,
    code: -32029,
    data: {
      code: 'TOO_MANY_REQUESTS',
      httpStatus: 429,
      rateLimit: { retryAfterSeconds: 0, retryAt: 'not a date' },
    },
  },
});
/** A network failure: a TRPCClientError with no tRPC code at all. */
const networkFailure = new TRPCClientError('Failed to fetch');

const failed = (error: string) => ({ workflowId: 'failed', status: 'failed', error });

/** The reply message type for each forwarded request type. */
export const REPLY_TYPE: Record<string, string> = {
  SUBMIT_WORKFLOW: 'WORKFLOW_SUBMITTED',
  ESTIMATE_WORKFLOW: 'ESTIMATE_RESULT',
  POLL_WORKFLOW: 'WORKFLOW_STATUS',
  CANCEL_WORKFLOW: 'WORKFLOW_CANCELED',
  QUERY_APP_WORKFLOWS: 'APP_WORKFLOWS_RESULT',
  CANCEL_APP_WORKFLOW: 'CANCEL_APP_WORKFLOW_RESULT',
  GET_BUZZ_BALANCE: 'BUZZ_BALANCE_RESULT',
  GET_BUZZ_TRANSACTIONS: 'BUZZ_TRANSACTIONS_RESULT',
  GET_BUZZ_ACCOUNTS: 'BUZZ_ACCOUNTS_RESULT',
  GET_DAILY_COMPENSATION: 'DAILY_COMPENSATION_RESULT',
  GET_VIEWER: 'VIEWER_RESULT',
  GET_IMAGES_BY_IDS: 'IMAGES_RESULT',
  APP_STORAGE_GET: 'APP_STORAGE_GET_RESULT',
  APP_STORAGE_SET: 'APP_STORAGE_SET_RESULT',
  APP_STORAGE_DELETE: 'APP_STORAGE_DELETE_RESULT',
  APP_STORAGE_LIST: 'APP_STORAGE_LIST_RESULT',
  APP_STORAGE_QUOTA: 'APP_STORAGE_QUOTA_RESULT',
  SHARED_LIST: 'SHARED_LIST_RESULT',
  SHARED_GET: 'SHARED_GET_RESULT',
  SHARED_GET_COUNT: 'SHARED_GET_COUNT_RESULT',
  SHARED_GET_COUNTS: 'SHARED_GET_COUNTS_RESULT',
  SHARED_APPEND: 'SHARED_APPEND_RESULT',
  SHARED_UPDATE: 'SHARED_UPDATE_RESULT',
  SHARED_VOTE: 'SHARED_VOTE_RESULT',
  SHARED_UNVOTE: 'SHARED_UNVOTE_RESULT',
  SHARED_WITHDRAW: 'SHARED_WITHDRAW_RESULT',
  SHARED_REPORT: 'SHARED_REPORT_RESULT',
};

/**
 * The positive control for "no reply" rows: a valid request of the same type, and what the
 * procedure resolves to for it. Sent AFTER the silent row's window, on the same mount.
 */
const LIVE_ID = 'rq_live';
export const SENTINEL: Record<string, { payload: Record<string, unknown>; resolves: unknown }> = {
  SUBMIT_WORKFLOW: { payload: { body: {} }, resolves: { snapshot: { workflowId: 'w' } } },
  ESTIMATE_WORKFLOW: { payload: { body: {} }, resolves: { snapshot: { workflowId: 'w' } } },
  POLL_WORKFLOW: { payload: { workflowId: 'w' }, resolves: { snapshot: { workflowId: 'w' } } },
  CANCEL_WORKFLOW: { payload: { workflowId: 'w' }, resolves: { snapshot: { workflowId: 'w' } } },
  QUERY_APP_WORKFLOWS: { payload: {}, resolves: { items: [] } },
  CANCEL_APP_WORKFLOW: { payload: { workflowId: 'w' }, resolves: { ok: true } },
  GET_BUZZ_BALANCE: { payload: {}, resolves: { blue: 1 } },
  GET_BUZZ_TRANSACTIONS: { payload: {}, resolves: { items: [] } },
  GET_BUZZ_ACCOUNTS: { payload: {}, resolves: { accounts: [] } },
  GET_DAILY_COMPENSATION: { payload: {}, resolves: { rows: [] } },
  GET_VIEWER: { payload: {}, resolves: { id: 1 } },
  GET_IMAGES_BY_IDS: { payload: { imageIds: [1] }, resolves: { images: [] } },
  APP_STORAGE_GET: { payload: { key: 'k' }, resolves: { value: null } },
  APP_STORAGE_SET: { payload: { key: 'k', value: 1 }, resolves: { sizeBytes: 1 } },
  APP_STORAGE_DELETE: { payload: { key: 'k' }, resolves: { deleted: true } },
  APP_STORAGE_LIST: { payload: {}, resolves: { keys: [], nextCursor: null } },
  APP_STORAGE_QUOTA: {
    payload: {},
    resolves: { usedBytes: 0, rowCount: 0, limitBytes: 1, limitRows: 1 },
  },
  SHARED_LIST: { payload: {}, resolves: { items: [], nextCursor: null } },
  SHARED_GET: { payload: { key: 'k' }, resolves: { item: null } },
  SHARED_GET_COUNT: { payload: { key: 'k' }, resolves: { count: 0 } },
  SHARED_GET_COUNTS: { payload: { keys: ['k'] }, resolves: { counts: {} } },
  SHARED_APPEND: { payload: { value: { title: 't' } }, resolves: { key: 'k' } },
  SHARED_UPDATE: { payload: { key: 'k', value: { title: 't' } }, resolves: { ok: true } },
  SHARED_VOTE: { payload: { key: 'k' }, resolves: { count: 1 } },
  SHARED_UNVOTE: { payload: { key: 'k' }, resolves: { count: 0 } },
  SHARED_WITHDRAW: { payload: { key: 'k' }, resolves: { ok: true, deleted: true } },
  SHARED_REPORT: { payload: { key: 'k' }, resolves: { ok: true } },
};

// ── Rows ─────────────────────────────────────────────────────────────────────────────────
// Rows are written per type, flat, with every expectation literal. The few helpers below
// only stamp out the fields that never vary within a type (type, proc, default rpc result).

function rowsFor(
  type: string,
  proc: string,
  resolves: unknown,
  rows: Array<Omit<MatrixRow, 'type' | 'proc' | 'rpc'> & { rpc?: MatrixRow['rpc'] }>
): MatrixRow[] {
  return rows.map((r) => ({ type, proc, rpc: { resolves }, ...r }));
}

// ── Workflows ──
const BODY = { steps: [{ $type: 'textToImage', input: { prompt: 'a cat' } }] };
const SNAP = { workflowId: 'wf_1', status: 'unassigned', cost: { total: 12 } };

const SUBMIT = rowsFor('SUBMIT_WORKFLOW', 'blocks.submitWorkflow', { snapshot: SNAP }, [
  {
    scenario: 'valid request with idempotencyKey forwards the key',
    hosts: BOTH,
    mode: 'default',
    payload: { requestId: 'rq_1', body: BODY, idempotencyKey: 'idem_1' },
    call: [{ blockToken: TOKEN, body: BODY, idempotencyKey: 'idem_1' }],
    reply: { requestId: 'rq_1', snapshot: SNAP },
  },
  {
    scenario: 'no idempotencyKey: the key is absent from the call',
    hosts: BOTH,
    mode: 'default',
    payload: { requestId: 'rq_1', body: BODY },
    call: [{ blockToken: TOKEN, body: BODY }],
    reply: { requestId: 'rq_1', snapshot: SNAP },
  },
  {
    scenario: 'empty-string idempotencyKey is omitted, not forwarded',
    hosts: BOTH,
    mode: 'default',
    payload: { requestId: 'rq_1', body: BODY, idempotencyKey: '' },
    call: [{ blockToken: TOKEN, body: BODY }],
    reply: { requestId: 'rq_1', snapshot: SNAP },
  },
  {
    scenario: 'non-string idempotencyKey is omitted, not forwarded',
    hosts: BOTH,
    mode: 'default',
    payload: { requestId: 'rq_1', body: BODY, idempotencyKey: 12345 },
    call: [{ blockToken: TOKEN, body: BODY }],
    reply: { requestId: 'rq_1', snapshot: SNAP },
  },
  {
    scenario: 'body.accountType rides through whole; spentAccountType reaches the block',
    hosts: BOTH,
    mode: 'default',
    rpc: { resolves: { snapshot: { ...SNAP, spentAccountType: 'green' } } },
    payload: { requestId: 'rq_1', body: { ...BODY, accountType: 'green' } },
    call: [{ blockToken: TOKEN, body: { ...BODY, accountType: 'green' } }],
    reply: { requestId: 'rq_1', snapshot: { ...SNAP, spentAccountType: 'green' } },
  },
  {
    scenario: 'a block-sent blockToken is ignored; the host token is forwarded',
    hosts: BOTH,
    mode: 'default',
    payload: { requestId: 'rq_1', body: BODY, blockToken: 'tok_evil' },
    call: [{ blockToken: TOKEN, body: BODY }],
    reply: { requestId: 'rq_1', snapshot: SNAP },
  },
  {
    scenario: 'rpc rejects with Error → failure snapshot',
    hosts: BOTH,
    mode: 'default',
    rpc: { rejects: boom },
    payload: { requestId: 'rq_1', body: BODY },
    call: [{ blockToken: TOKEN, body: BODY }],
    reply: { requestId: 'rq_1', snapshot: failed('boom') },
  },
  {
    scenario: 'rpc rejects with tRPC error → failure snapshot carries only the message',
    hosts: BOTH,
    mode: 'default',
    rpc: { rejects: rateLimited },
    payload: { requestId: 'rq_1', body: BODY },
    call: [{ blockToken: TOKEN, body: BODY }],
    reply: { requestId: 'rq_1', snapshot: failed(RL_MESSAGE) },
  },
  {
    // current behaviour; candidate fix D3 — three different fallback texts across families
    scenario: 'rpc rejects with a non-Error → generic workflow fallback text',
    hosts: BOTH,
    mode: 'default',
    rpc: { rejects: NOT_AN_ERROR },
    payload: { requestId: 'rq_1', body: BODY },
    call: [{ blockToken: TOKEN, body: BODY }],
    reply: { requestId: 'rq_1', snapshot: failed('workflow request failed') },
    candidateFix: 'D3',
  },
  {
    scenario: 'no requestId → dropped, no call, no reply',
    hosts: BOTH,
    mode: 'default',
    payload: { body: BODY },
    call: null,
    reply: null,
  },
  {
    scenario: 'requestId only → forwarded with body undefined (server validates)',
    hosts: BOTH,
    mode: 'default',
    payload: { requestId: 'rq_1' },
    call: [{ blockToken: TOKEN, body: undefined }],
    reply: { requestId: 'rq_1', snapshot: SNAP },
  },
  {
    scenario: 'token null → nack failure snapshot, no call',
    hosts: PBH,
    mode: 'noToken',
    payload: { requestId: 'rq_1', body: BODY, idempotencyKey: 'idem_1' },
    call: null,
    reply: { requestId: 'rq_1', snapshot: failed(NACK_NO_TOKEN) },
  },
  {
    scenario: 'review mode → review NACK snapshot, no call',
    hosts: PBH,
    mode: 'review',
    payload: { requestId: 'rq_1', body: BODY, idempotencyKey: 'idem_1' },
    call: null,
    reply: { requestId: 'rq_1', snapshot: failed(REVIEW_NACK) },
  },
  {
    scenario: 'review + run-for-real → forwarded for real, key included',
    hosts: PBH,
    mode: 'reviewRunForReal',
    payload: { requestId: 'rq_1', body: BODY, idempotencyKey: 'idem_1' },
    call: [{ blockToken: TOKEN, body: BODY, idempotencyKey: 'idem_1' }],
    reply: { requestId: 'rq_1', snapshot: SNAP },
  },
  {
    scenario: 'review + malformed (requestId only) → review NACK, gate runs first',
    hosts: PBH,
    mode: 'review',
    payload: { requestId: 'rq_1' },
    call: null,
    reply: { requestId: 'rq_1', snapshot: failed(REVIEW_NACK) },
  },
]);

const ESTIMATE = rowsFor('ESTIMATE_WORKFLOW', 'blocks.estimateWorkflow', { snapshot: SNAP }, [
  {
    scenario: 'valid request; an idempotencyKey is NOT forwarded on estimate',
    hosts: BOTH,
    mode: 'default',
    payload: { requestId: 'rq_1', body: BODY, idempotencyKey: 'idem_1' },
    call: [{ blockToken: TOKEN, body: BODY }],
    reply: { requestId: 'rq_1', snapshot: SNAP },
  },
  {
    scenario: 'cost.authorFee reaches the block (no field whitelist on the snapshot)',
    hosts: BOTH,
    mode: 'default',
    rpc: { resolves: { snapshot: { ...SNAP, cost: { total: 49, authorFee: 37 } } } },
    payload: { requestId: 'rq_1', body: BODY },
    call: [{ blockToken: TOKEN, body: BODY }],
    reply: { requestId: 'rq_1', snapshot: { ...SNAP, cost: { total: 49, authorFee: 37 } } },
  },
  {
    scenario: 'cost.authorFee of 0 is a value, not an absence — it reaches the block',
    hosts: BOTH,
    mode: 'default',
    rpc: { resolves: { snapshot: { ...SNAP, cost: { total: 12, authorFee: 0 } } } },
    payload: { requestId: 'rq_1', body: BODY },
    call: [{ blockToken: TOKEN, body: BODY }],
    reply: { requestId: 'rq_1', snapshot: { ...SNAP, cost: { total: 12, authorFee: 0 } } },
  },
  {
    scenario: 'rpc rejects with Error → failure snapshot',
    hosts: BOTH,
    mode: 'default',
    rpc: { rejects: boom },
    payload: { requestId: 'rq_1', body: BODY },
    call: [{ blockToken: TOKEN, body: BODY }],
    reply: { requestId: 'rq_1', snapshot: failed('boom') },
  },
  {
    scenario: 'rpc rejects with tRPC error → failure snapshot carries only the message',
    hosts: BOTH,
    mode: 'default',
    rpc: { rejects: rateLimited },
    payload: { requestId: 'rq_1', body: BODY },
    call: [{ blockToken: TOKEN, body: BODY }],
    reply: { requestId: 'rq_1', snapshot: failed(RL_MESSAGE) },
  },
  {
    scenario: 'no requestId → dropped',
    hosts: BOTH,
    mode: 'default',
    payload: { body: BODY },
    call: null,
    reply: null,
  },
  {
    scenario: 'requestId only → forwarded with body undefined',
    hosts: BOTH,
    mode: 'default',
    payload: { requestId: 'rq_1' },
    call: [{ blockToken: TOKEN, body: undefined }],
    reply: { requestId: 'rq_1', snapshot: SNAP },
  },
  {
    scenario: 'token null → nack failure snapshot',
    hosts: PBH,
    mode: 'noToken',
    payload: { requestId: 'rq_1', body: BODY },
    call: null,
    reply: { requestId: 'rq_1', snapshot: failed(NACK_NO_TOKEN) },
  },
  {
    scenario: 'review mode → review NACK snapshot',
    hosts: PBH,
    mode: 'review',
    payload: { requestId: 'rq_1', body: BODY },
    call: null,
    reply: { requestId: 'rq_1', snapshot: failed(REVIEW_NACK) },
  },
  {
    scenario: 'review + run-for-real → forwarded',
    hosts: PBH,
    mode: 'reviewRunForReal',
    payload: { requestId: 'rq_1', body: BODY },
    call: [{ blockToken: TOKEN, body: BODY }],
    reply: { requestId: 'rq_1', snapshot: SNAP },
  },
  {
    scenario: 'review + malformed (requestId only) → review NACK',
    hosts: PBH,
    mode: 'review',
    payload: { requestId: 'rq_1' },
    call: null,
    reply: { requestId: 'rq_1', snapshot: failed(REVIEW_NACK) },
  },
]);

const POLL_SNAP = { workflowId: 'wf_1', status: 'succeeded' };
const POLL = rowsFor('POLL_WORKFLOW', 'blocks.pollWorkflow', { snapshot: POLL_SNAP }, [
  {
    scenario: 'valid request with finite waitSeconds forwards it unchanged',
    hosts: BOTH,
    mode: 'default',
    payload: { requestId: 'rq_1', workflowId: 'wf_1', waitSeconds: 2.5 },
    call: [{ blockToken: TOKEN, workflowId: 'wf_1', waitSeconds: 2.5 }],
    reply: { requestId: 'rq_1', snapshot: POLL_SNAP },
  },
  {
    scenario: 'waitSeconds above the server cap (90) is forwarded as-is — no host clamp',
    hosts: BOTH,
    mode: 'default',
    payload: { requestId: 'rq_1', workflowId: 'wf_1', waitSeconds: 90 },
    call: [{ blockToken: TOKEN, workflowId: 'wf_1', waitSeconds: 90 }],
    reply: { requestId: 'rq_1', snapshot: POLL_SNAP },
  },
  {
    scenario: 'waitSeconds 0 is finite and forwarded',
    hosts: BOTH,
    mode: 'default',
    payload: { requestId: 'rq_1', workflowId: 'wf_1', waitSeconds: 0 },
    call: [{ blockToken: TOKEN, workflowId: 'wf_1', waitSeconds: 0 }],
    reply: { requestId: 'rq_1', snapshot: POLL_SNAP },
  },
  {
    scenario: 'waitSeconds absent → key absent',
    hosts: BOTH,
    mode: 'default',
    payload: { requestId: 'rq_1', workflowId: 'wf_1' },
    call: [{ blockToken: TOKEN, workflowId: 'wf_1' }],
    reply: { requestId: 'rq_1', snapshot: POLL_SNAP },
  },
  {
    scenario: 'waitSeconds Infinity (non-finite) → omitted',
    hosts: BOTH,
    mode: 'default',
    payload: { requestId: 'rq_1', workflowId: 'wf_1', waitSeconds: Infinity },
    call: [{ blockToken: TOKEN, workflowId: 'wf_1' }],
    reply: { requestId: 'rq_1', snapshot: POLL_SNAP },
  },
  {
    scenario: 'waitSeconds as a string → omitted',
    hosts: BOTH,
    mode: 'default',
    payload: { requestId: 'rq_1', workflowId: 'wf_1', waitSeconds: '5' },
    call: [{ blockToken: TOKEN, workflowId: 'wf_1' }],
    reply: { requestId: 'rq_1', snapshot: POLL_SNAP },
  },
  {
    scenario: 'rpc rejects with a network TRPCClientError (no code) → "processing" placeholder',
    hosts: BOTH,
    mode: 'default',
    rpc: { rejects: networkFailure },
    payload: { requestId: 'rq_1', workflowId: 'wf_1' },
    call: [{ blockToken: TOKEN, workflowId: 'wf_1' }],
    reply: { requestId: 'rq_1', snapshot: { workflowId: 'wf_1', status: 'processing' } },
  },
  {
    scenario: 'rpc rejects with tRPC FORBIDDEN → terminal failure snapshot',
    hosts: BOTH,
    mode: 'default',
    rpc: { rejects: trpcError('FORBIDDEN', 403, 'not this app') },
    payload: { requestId: 'rq_1', workflowId: 'wf_1' },
    call: [{ blockToken: TOKEN, workflowId: 'wf_1' }],
    reply: { requestId: 'rq_1', snapshot: failed('not this app') },
  },
  {
    scenario: 'rpc rejects with a code-less Error → "processing" placeholder, not failed',
    hosts: BOTH,
    mode: 'default',
    rpc: { rejects: boom },
    payload: { requestId: 'rq_1', workflowId: 'wf_1' },
    call: [{ blockToken: TOKEN, workflowId: 'wf_1' }],
    reply: { requestId: 'rq_1', snapshot: { workflowId: 'wf_1', status: 'processing' } },
  },
  {
    scenario: 'rpc rejects with tRPC SERVICE_UNAVAILABLE → "processing" placeholder',
    hosts: BOTH,
    mode: 'default',
    rpc: { rejects: trpcError('SERVICE_UNAVAILABLE', 503, 'upstream down') },
    payload: { requestId: 'rq_1', workflowId: 'wf_1' },
    call: [{ blockToken: TOKEN, workflowId: 'wf_1' }],
    reply: { requestId: 'rq_1', snapshot: { workflowId: 'wf_1', status: 'processing' } },
  },
  {
    scenario: 'rpc rejects with tRPC NOT_FOUND → terminal failure snapshot',
    hosts: BOTH,
    mode: 'default',
    rpc: { rejects: trpcError('NOT_FOUND', 404, 'workflow not found') },
    payload: { requestId: 'rq_1', workflowId: 'wf_1' },
    call: [{ blockToken: TOKEN, workflowId: 'wf_1' }],
    reply: { requestId: 'rq_1', snapshot: failed('workflow not found') },
  },
  {
    scenario: 'no requestId → dropped',
    hosts: BOTH,
    mode: 'default',
    payload: { workflowId: 'wf_1' },
    call: null,
    reply: null,
  },
  {
    // current behaviour; candidate fix D4 — a malformed request WITH a requestId is dropped
    // silently, so the block waits out its timeout instead of getting an error reply
    scenario: 'requestId only (no workflowId) → dropped silently',
    hosts: BOTH,
    mode: 'default',
    payload: { requestId: 'rq_1' },
    call: null,
    reply: null,
    candidateFix: 'D4',
  },
  {
    // current behaviour; candidate fix D4
    scenario: 'empty workflowId → dropped silently',
    hosts: BOTH,
    mode: 'default',
    payload: { requestId: 'rq_1', workflowId: '' },
    call: null,
    reply: null,
    candidateFix: 'D4',
  },
  {
    scenario: 'token null → nack failure snapshot',
    hosts: PBH,
    mode: 'noToken',
    payload: { requestId: 'rq_1', workflowId: 'wf_1' },
    call: null,
    reply: { requestId: 'rq_1', snapshot: failed(NACK_NO_TOKEN) },
  },
  {
    scenario: 'review mode → review NACK snapshot',
    hosts: PBH,
    mode: 'review',
    payload: { requestId: 'rq_1', workflowId: 'wf_1' },
    call: null,
    reply: { requestId: 'rq_1', snapshot: failed(REVIEW_NACK) },
  },
  {
    scenario: 'review + run-for-real → forwarded with waitSeconds',
    hosts: PBH,
    mode: 'reviewRunForReal',
    payload: { requestId: 'rq_1', workflowId: 'wf_1', waitSeconds: 3 },
    call: [{ blockToken: TOKEN, workflowId: 'wf_1', waitSeconds: 3 }],
    reply: { requestId: 'rq_1', snapshot: POLL_SNAP },
  },
  {
    scenario: 'review + malformed (no workflowId) → review NACK, gate runs first',
    hosts: PBH,
    mode: 'review',
    payload: { requestId: 'rq_1' },
    call: null,
    reply: { requestId: 'rq_1', snapshot: failed(REVIEW_NACK) },
  },
]);

const CANCEL_SNAP = { workflowId: 'wf_1', status: 'canceled' };
const CANCEL = rowsFor('CANCEL_WORKFLOW', 'blocks.cancelWorkflow', { snapshot: CANCEL_SNAP }, [
  {
    scenario: 'valid request; waitSeconds is NOT forwarded on cancel',
    hosts: BOTH,
    mode: 'default',
    payload: { requestId: 'rq_1', workflowId: 'wf_1', waitSeconds: 5 },
    call: [{ blockToken: TOKEN, workflowId: 'wf_1' }],
    reply: { requestId: 'rq_1', snapshot: CANCEL_SNAP },
  },
  {
    scenario: 'rpc rejects with Error → failure snapshot',
    hosts: BOTH,
    mode: 'default',
    rpc: { rejects: boom },
    payload: { requestId: 'rq_1', workflowId: 'wf_1' },
    call: [{ blockToken: TOKEN, workflowId: 'wf_1' }],
    reply: { requestId: 'rq_1', snapshot: failed('boom') },
  },
  {
    scenario: 'rpc rejects with tRPC SERVICE_UNAVAILABLE → terminal failure (no poll placeholder)',
    hosts: BOTH,
    mode: 'default',
    rpc: { rejects: trpcError('SERVICE_UNAVAILABLE', 503, 'upstream down') },
    payload: { requestId: 'rq_1', workflowId: 'wf_1' },
    call: [{ blockToken: TOKEN, workflowId: 'wf_1' }],
    reply: { requestId: 'rq_1', snapshot: failed('upstream down') },
  },
  {
    scenario: 'no requestId → dropped',
    hosts: BOTH,
    mode: 'default',
    payload: { workflowId: 'wf_1' },
    call: null,
    reply: null,
  },
  {
    // current behaviour; candidate fix D4
    scenario: 'requestId only (no workflowId) → dropped silently',
    hosts: BOTH,
    mode: 'default',
    payload: { requestId: 'rq_1' },
    call: null,
    reply: null,
    candidateFix: 'D4',
  },
  {
    scenario: 'token null → nack failure snapshot',
    hosts: PBH,
    mode: 'noToken',
    payload: { requestId: 'rq_1', workflowId: 'wf_1' },
    call: null,
    reply: { requestId: 'rq_1', snapshot: failed(NACK_NO_TOKEN) },
  },
  {
    scenario: 'review mode → review NACK snapshot',
    hosts: PBH,
    mode: 'review',
    payload: { requestId: 'rq_1', workflowId: 'wf_1' },
    call: null,
    reply: { requestId: 'rq_1', snapshot: failed(REVIEW_NACK) },
  },
  {
    scenario: 'review + run-for-real → forwarded',
    hosts: PBH,
    mode: 'reviewRunForReal',
    payload: { requestId: 'rq_1', workflowId: 'wf_1' },
    call: [{ blockToken: TOKEN, workflowId: 'wf_1' }],
    reply: { requestId: 'rq_1', snapshot: CANCEL_SNAP },
  },
  {
    scenario: 'review + malformed (no workflowId) → review NACK, gate runs first',
    hosts: PBH,
    mode: 'review',
    payload: { requestId: 'rq_1' },
    call: null,
    reply: { requestId: 'rq_1', snapshot: failed(REVIEW_NACK) },
  },
]);

// ── App subqueue (PBH only) ──
const APP_WF = { items: [{ id: 'wf_1' }], nextCursor: 'c2' };
const QUERY_APP = rowsFor('QUERY_APP_WORKFLOWS', 'blocks.queryAppWorkflows', APP_WF, [
  {
    scenario: 'valid: params spread, host token wins over a block-sent params.blockToken',
    hosts: PBH,
    mode: 'default',
    payload: { requestId: 'rq_1', params: { cursor: 'c1', limit: 10, blockToken: 'tok_evil' } },
    call: [{ cursor: 'c1', limit: 10, blockToken: TOKEN }],
    reply: { requestId: 'rq_1', result: APP_WF },
  },
  {
    scenario: 'rpc rejects with Error → error reply',
    hosts: PBH,
    mode: 'default',
    rpc: { rejects: boom },
    payload: { requestId: 'rq_1', params: { limit: 10 } },
    call: [{ limit: 10, blockToken: TOKEN }],
    reply: { requestId: 'rq_1', error: 'boom' },
  },
  {
    scenario: 'rpc rejects with tRPC error → message only',
    hosts: PBH,
    mode: 'default',
    rpc: { rejects: rateLimited },
    payload: { requestId: 'rq_1', params: { limit: 10 } },
    call: [{ limit: 10, blockToken: TOKEN }],
    reply: { requestId: 'rq_1', error: RL_MESSAGE },
  },
  {
    // current behaviour; candidate fix D3
    scenario: 'rpc rejects with a non-Error → "unknown"',
    hosts: PBH,
    mode: 'default',
    rpc: { rejects: NOT_AN_ERROR },
    payload: { requestId: 'rq_1' },
    call: [{ blockToken: TOKEN }],
    reply: { requestId: 'rq_1', error: 'unknown' },
    candidateFix: 'D3',
  },
  {
    scenario: 'no requestId → dropped',
    hosts: PBH,
    mode: 'default',
    payload: { params: {} },
    call: null,
    reply: null,
  },
  {
    scenario: 'requestId only → token-only call',
    hosts: PBH,
    mode: 'default',
    payload: { requestId: 'rq_1' },
    call: [{ blockToken: TOKEN }],
    reply: { requestId: 'rq_1', result: APP_WF },
  },
  {
    // current behaviour; candidate fix D5 — a non-object `params` is spread as-is, so a
    // string becomes indexed character keys in the call
    scenario: 'string params are spread into indexed keys',
    hosts: PBH,
    mode: 'default',
    payload: { requestId: 'rq_1', params: 'ab' },
    call: [{ 0: 'a', 1: 'b', blockToken: TOKEN }],
    reply: { requestId: 'rq_1', result: APP_WF },
    candidateFix: 'D5',
  },
  {
    // current behaviour; candidate fix D1 — this family says "no block token", the
    // nack() families say "block credential unavailable"
    scenario: 'token null → legacy no-token error reply',
    hosts: PBH,
    mode: 'noToken',
    payload: { requestId: 'rq_1', params: {} },
    call: null,
    reply: { requestId: 'rq_1', error: LEGACY_NO_TOKEN },
    candidateFix: 'D1',
  },
  {
    scenario: 'review mode → review NACK',
    hosts: PBH,
    mode: 'review',
    payload: { requestId: 'rq_1', params: {} },
    call: null,
    reply: { requestId: 'rq_1', error: REVIEW_NACK },
  },
  {
    scenario: 'review + run-for-real → forwarded',
    hosts: PBH,
    mode: 'reviewRunForReal',
    payload: { requestId: 'rq_1', params: { limit: 5 } },
    call: [{ limit: 5, blockToken: TOKEN }],
    reply: { requestId: 'rq_1', result: APP_WF },
  },
]);

const CANCEL_APP = rowsFor('CANCEL_APP_WORKFLOW', 'blocks.cancelAppWorkflow', { ok: true }, [
  {
    scenario: 'valid request',
    hosts: PBH,
    mode: 'default',
    payload: { requestId: 'rq_1', workflowId: 'wf_1' },
    call: [{ blockToken: TOKEN, workflowId: 'wf_1' }],
    reply: { requestId: 'rq_1', result: { ok: true } },
  },
  {
    scenario: 'rpc rejects with Error → error reply',
    hosts: PBH,
    mode: 'default',
    rpc: { rejects: boom },
    payload: { requestId: 'rq_1', workflowId: 'wf_1' },
    call: [{ blockToken: TOKEN, workflowId: 'wf_1' }],
    reply: { requestId: 'rq_1', error: 'boom' },
  },
  {
    scenario: 'rpc rejects with tRPC error → message only',
    hosts: PBH,
    mode: 'default',
    rpc: { rejects: trpcError('FORBIDDEN', 403, 'not yours') },
    payload: { requestId: 'rq_1', workflowId: 'wf_1' },
    call: [{ blockToken: TOKEN, workflowId: 'wf_1' }],
    reply: { requestId: 'rq_1', error: 'not yours' },
  },
  {
    scenario: 'no requestId → dropped',
    hosts: PBH,
    mode: 'default',
    payload: { workflowId: 'wf_1' },
    call: null,
    reply: null,
  },
  {
    // current behaviour; candidate fix D4
    scenario: 'requestId only (no workflowId) → dropped silently',
    hosts: PBH,
    mode: 'default',
    payload: { requestId: 'rq_1' },
    call: null,
    reply: null,
    candidateFix: 'D4',
  },
  {
    // current behaviour; candidate fix D1
    scenario: 'token null → legacy no-token error reply',
    hosts: PBH,
    mode: 'noToken',
    payload: { requestId: 'rq_1', workflowId: 'wf_1' },
    call: null,
    reply: { requestId: 'rq_1', error: LEGACY_NO_TOKEN },
    candidateFix: 'D1',
  },
  {
    scenario: 'review mode → review NACK',
    hosts: PBH,
    mode: 'review',
    payload: { requestId: 'rq_1', workflowId: 'wf_1' },
    call: null,
    reply: { requestId: 'rq_1', error: REVIEW_NACK },
  },
  {
    scenario: 'review + run-for-real → forwarded',
    hosts: PBH,
    mode: 'reviewRunForReal',
    payload: { requestId: 'rq_1', workflowId: 'wf_1' },
    call: [{ blockToken: TOKEN, workflowId: 'wf_1' }],
    reply: { requestId: 'rq_1', result: { ok: true } },
  },
  {
    // current behaviour; candidate fix D2 — validation runs BEFORE the review gate here,
    // the reverse of every other gated forward, so a malformed review request is silent
    scenario: 'review + malformed (no workflowId) → dropped silently, validation before gate',
    hosts: PBH,
    mode: 'review',
    payload: { requestId: 'rq_1' },
    call: null,
    reply: null,
    candidateFix: 'D2',
  },
]);

// ── Buzz / viewer / images (balance on both hosts, the rest PBH only) ──
const BALANCE = { blue: 10, green: 2, yellow: 0 };
const BUZZ_BALANCE = rowsFor('GET_BUZZ_BALANCE', 'blocks.getMyBuzzBalance', BALANCE, [
  {
    scenario: 'valid: only the host token is forwarded, extra fields dropped',
    hosts: BOTH,
    mode: 'default',
    payload: { requestId: 'rq_1', blockToken: 'tok_evil', accountType: 'yellow' },
    call: [{ blockToken: TOKEN }],
    reply: { requestId: 'rq_1', balance: BALANCE },
  },
  {
    scenario: 'rpc rejects with Error → error reply',
    hosts: BOTH,
    mode: 'default',
    rpc: { rejects: boom },
    payload: { requestId: 'rq_1' },
    call: [{ blockToken: TOKEN }],
    reply: { requestId: 'rq_1', error: 'boom' },
  },
  {
    scenario: 'rpc rejects with tRPC error → message only',
    hosts: BOTH,
    mode: 'default',
    rpc: { rejects: trpcError('FORBIDDEN', 403, 'missing scope') },
    payload: { requestId: 'rq_1' },
    call: [{ blockToken: TOKEN }],
    reply: { requestId: 'rq_1', error: 'missing scope' },
  },
  {
    // current behaviour; candidate fix D3
    scenario: 'rpc rejects with a non-Error → "unknown"',
    hosts: BOTH,
    mode: 'default',
    rpc: { rejects: NOT_AN_ERROR },
    payload: { requestId: 'rq_1' },
    call: [{ blockToken: TOKEN }],
    reply: { requestId: 'rq_1', error: 'unknown' },
    candidateFix: 'D3',
  },
  {
    scenario: 'no requestId → dropped',
    hosts: BOTH,
    mode: 'default',
    payload: {},
    call: null,
    reply: null,
  },
  {
    // The contrast for D6: here (and on every forward but GET_IMAGES_BY_IDS) an
    // empty-string requestId is accepted and echoed.
    scenario: 'empty-string requestId is accepted and echoed',
    hosts: BOTH,
    mode: 'default',
    payload: { requestId: '' },
    call: [{ blockToken: TOKEN }],
    reply: { requestId: '', balance: BALANCE },
  },
  {
    // current behaviour; candidate fix D1
    scenario: 'token null → legacy no-token error reply',
    hosts: PBH,
    mode: 'noToken',
    payload: { requestId: 'rq_1' },
    call: null,
    reply: { requestId: 'rq_1', error: LEGACY_NO_TOKEN },
    candidateFix: 'D1',
  },
  {
    scenario: 'review mode → review NACK',
    hosts: PBH,
    mode: 'review',
    payload: { requestId: 'rq_1' },
    call: null,
    reply: { requestId: 'rq_1', error: REVIEW_NACK },
  },
  {
    scenario: 'review + run-for-real → forwarded',
    hosts: PBH,
    mode: 'reviewRunForReal',
    payload: { requestId: 'rq_1' },
    call: [{ blockToken: TOKEN }],
    reply: { requestId: 'rq_1', balance: BALANCE },
  },
]);

/** The three PBH buzz reads share one shape; only names and the params spread differ. */
function buzzReadRows(
  type: string,
  proc: string,
  spreadsParams: boolean,
  result: unknown
): MatrixRow[] {
  const validPayload = spreadsParams
    ? { requestId: 'rq_1', params: { date: '2026-10-01', blockToken: 'tok_evil' } }
    : { requestId: 'rq_1', params: { date: '2026-10-01' }, blockToken: 'tok_evil' };
  const validCall = spreadsParams
    ? [{ date: '2026-10-01', blockToken: TOKEN }]
    : [{ blockToken: TOKEN }];
  return rowsFor(type, proc, result, [
    {
      scenario: spreadsParams
        ? 'valid: params spread, host token wins over params.blockToken'
        : 'valid: params are NOT forwarded, only the host token',
      hosts: PBH,
      mode: 'default',
      payload: validPayload,
      call: validCall,
      reply: { requestId: 'rq_1', result },
    },
    {
      scenario: 'rpc rejects with Error → error reply',
      hosts: PBH,
      mode: 'default',
      rpc: { rejects: boom },
      payload: { requestId: 'rq_1' },
      call: [{ blockToken: TOKEN }],
      reply: { requestId: 'rq_1', error: 'boom' },
    },
    {
      scenario: 'rpc rejects with tRPC error → message only',
      hosts: PBH,
      mode: 'default',
      rpc: { rejects: trpcError('FORBIDDEN', 403, 'missing scope') },
      payload: { requestId: 'rq_1' },
      call: [{ blockToken: TOKEN }],
      reply: { requestId: 'rq_1', error: 'missing scope' },
    },
    {
      scenario: 'no requestId → dropped',
      hosts: PBH,
      mode: 'default',
      payload: {},
      call: null,
      reply: null,
    },
    {
      scenario: 'requestId only → token-only call',
      hosts: PBH,
      mode: 'default',
      payload: { requestId: 'rq_1' },
      call: [{ blockToken: TOKEN }],
      reply: { requestId: 'rq_1', result },
    },
    {
      // current behaviour; candidate fix D1
      scenario: 'token null → legacy no-token error reply',
      hosts: PBH,
      mode: 'noToken',
      payload: { requestId: 'rq_1' },
      call: null,
      reply: { requestId: 'rq_1', error: LEGACY_NO_TOKEN },
      candidateFix: 'D1',
    },
    {
      scenario: 'review mode → review NACK',
      hosts: PBH,
      mode: 'review',
      payload: { requestId: 'rq_1' },
      call: null,
      reply: { requestId: 'rq_1', error: REVIEW_NACK },
    },
    {
      scenario: 'review + run-for-real → forwarded',
      hosts: PBH,
      mode: 'reviewRunForReal',
      payload: { requestId: 'rq_1' },
      call: [{ blockToken: TOKEN }],
      reply: { requestId: 'rq_1', result },
    },
  ]);
}

const BUZZ_TX = buzzReadRows('GET_BUZZ_TRANSACTIONS', 'blocks.getMyBuzzTransactions', true, {
  items: [{ id: 1 }],
  cursor: null,
});
const BUZZ_ACCOUNTS = buzzReadRows('GET_BUZZ_ACCOUNTS', 'blocks.getMyBuzzAccounts', false, {
  accounts: [{ type: 'yellow', balance: 3 }],
});
const DAILY_COMP = buzzReadRows('GET_DAILY_COMPENSATION', 'blocks.getMyDailyCompensation', true, {
  rows: [{ modelVersionId: 9, total: 4 }],
});

const VIEWER_RESULT = { id: 42, username: 'tester' };
const VIEWER = rowsFor('GET_VIEWER', 'blocks.getMyViewer', VIEWER_RESULT, [
  {
    scenario: 'valid: only the host token is forwarded',
    hosts: PBH,
    mode: 'default',
    payload: { requestId: 'rq_1', blockToken: 'tok_evil', userId: 7 },
    call: [{ blockToken: TOKEN }],
    reply: { requestId: 'rq_1', viewer: VIEWER_RESULT },
  },
  {
    scenario: 'rpc rejects with Error → error reply',
    hosts: PBH,
    mode: 'default',
    rpc: { rejects: boom },
    payload: { requestId: 'rq_1' },
    call: [{ blockToken: TOKEN }],
    reply: { requestId: 'rq_1', error: 'boom' },
  },
  {
    scenario: 'rpc rejects with tRPC error → message only',
    hosts: PBH,
    mode: 'default',
    rpc: { rejects: trpcError('FORBIDDEN', 403, 'missing scope') },
    payload: { requestId: 'rq_1' },
    call: [{ blockToken: TOKEN }],
    reply: { requestId: 'rq_1', error: 'missing scope' },
  },
  {
    scenario: 'no requestId → dropped',
    hosts: PBH,
    mode: 'default',
    payload: {},
    call: null,
    reply: null,
  },
  {
    // current behaviour; candidate fix D1
    scenario: 'token null → legacy no-token error reply',
    hosts: PBH,
    mode: 'noToken',
    payload: { requestId: 'rq_1' },
    call: null,
    reply: { requestId: 'rq_1', error: LEGACY_NO_TOKEN },
    candidateFix: 'D1',
  },
  {
    scenario: 'review mode → NOT gated, forwarded (render-safe read)',
    hosts: PBH,
    mode: 'review',
    payload: { requestId: 'rq_1' },
    call: [{ blockToken: TOKEN }],
    reply: { requestId: 'rq_1', viewer: VIEWER_RESULT },
  },
  {
    scenario: 'review + run-for-real → forwarded',
    hosts: PBH,
    mode: 'reviewRunForReal',
    payload: { requestId: 'rq_1' },
    call: [{ blockToken: TOKEN }],
    reply: { requestId: 'rq_1', viewer: VIEWER_RESULT },
  },
]);

const IMAGES_RESULT = { images: [{ id: 3, status: 'visible' }] };
const IMAGES = rowsFor('GET_IMAGES_BY_IDS', 'blocks.getImagesByIds', IMAGES_RESULT, [
  {
    scenario: 'valid: imageIds sanitised to positive integers',
    hosts: PBH,
    mode: 'default',
    payload: { requestId: 'rq_1', imageIds: [3, 0, -1, 2.5, '4', 7] },
    call: [{ blockToken: TOKEN, imageIds: [3, 7] }],
    reply: { requestId: 'rq_1', result: IMAGES_RESULT },
  },
  {
    scenario: 'rpc rejects with Error → error reply',
    hosts: PBH,
    mode: 'default',
    rpc: { rejects: boom },
    payload: { requestId: 'rq_1', imageIds: [3] },
    call: [{ blockToken: TOKEN, imageIds: [3] }],
    reply: { requestId: 'rq_1', error: 'boom' },
  },
  {
    scenario: 'rpc rejects with tRPC error → message only',
    hosts: PBH,
    mode: 'default',
    rpc: { rejects: trpcError('BAD_REQUEST', 400, 'too many ids') },
    payload: { requestId: 'rq_1', imageIds: [3] },
    call: [{ blockToken: TOKEN, imageIds: [3] }],
    reply: { requestId: 'rq_1', error: 'too many ids' },
  },
  {
    scenario: 'no requestId → dropped',
    hosts: PBH,
    mode: 'default',
    payload: { imageIds: [3] },
    call: null,
    reply: null,
  },
  {
    // current behaviour; candidate fix D6 — every other forward accepts '' as a requestId
    scenario: 'empty-string requestId → dropped (stricter than every other forward)',
    hosts: PBH,
    mode: 'default',
    payload: { requestId: '', imageIds: [3] },
    call: null,
    reply: null,
    candidateFix: 'D6',
  },
  {
    scenario: 'requestId only → empty result, no call',
    hosts: PBH,
    mode: 'default',
    payload: { requestId: 'rq_1' },
    call: null,
    reply: { requestId: 'rq_1', result: { images: [] } },
  },
  {
    // current behaviour; candidate fix D1
    scenario: 'token null → legacy no-token error reply',
    hosts: PBH,
    mode: 'noToken',
    payload: { requestId: 'rq_1', imageIds: [3] },
    call: null,
    reply: { requestId: 'rq_1', error: LEGACY_NO_TOKEN },
    candidateFix: 'D1',
  },
  {
    scenario: 'token null + no ids → empty result short-circuits before the token check',
    hosts: PBH,
    mode: 'noToken',
    payload: { requestId: 'rq_1', imageIds: [] },
    call: null,
    reply: { requestId: 'rq_1', result: { images: [] } },
  },
  {
    scenario: 'review mode → NOT gated, forwarded (render-safe read)',
    hosts: PBH,
    mode: 'review',
    payload: { requestId: 'rq_1', imageIds: [3] },
    call: [{ blockToken: TOKEN, imageIds: [3] }],
    reply: { requestId: 'rq_1', result: IMAGES_RESULT },
  },
  {
    scenario: 'review + run-for-real → forwarded',
    hosts: PBH,
    mode: 'reviewRunForReal',
    payload: { requestId: 'rq_1', imageIds: [3] },
    call: [{ blockToken: TOKEN, imageIds: [3] }],
    reply: { requestId: 'rq_1', result: IMAGES_RESULT },
  },
]);

// ── Private storage ──
const S_GET = rowsFor('APP_STORAGE_GET', 'apps.storage.get', { value: { note: 'hi' } }, [
  {
    scenario: 'valid read through the cached seam',
    hosts: BOTH,
    mode: 'default',
    payload: { requestId: 'rq_1', key: 'draft', blockToken: 'tok_evil' },
    call: [{ blockToken: TOKEN, key: 'draft' }, READ_OPTS],
    reply: { requestId: 'rq_1', value: { note: 'hi' } },
  },
  {
    scenario: 'rpc rejects with Error → value null + error',
    hosts: BOTH,
    mode: 'default',
    rpc: { rejects: boom },
    payload: { requestId: 'rq_1', key: 'draft' },
    call: [{ blockToken: TOKEN, key: 'draft' }, READ_OPTS],
    reply: { requestId: 'rq_1', value: null, error: 'boom' },
  },
  {
    scenario: 'rpc rejects with tRPC error → message only',
    hosts: BOTH,
    mode: 'default',
    rpc: { rejects: trpcError('FORBIDDEN', 403, 'feature disabled') },
    payload: { requestId: 'rq_1', key: 'draft' },
    call: [{ blockToken: TOKEN, key: 'draft' }, READ_OPTS],
    reply: { requestId: 'rq_1', value: null, error: 'feature disabled' },
  },
  {
    // current behaviour; candidate fix D3
    scenario: 'rpc rejects with a non-Error → storage fallback text',
    hosts: BOTH,
    mode: 'default',
    rpc: { rejects: NOT_AN_ERROR },
    payload: { requestId: 'rq_1', key: 'draft' },
    call: [{ blockToken: TOKEN, key: 'draft' }, READ_OPTS],
    reply: { requestId: 'rq_1', value: null, error: 'storage request failed' },
    candidateFix: 'D3',
  },
  {
    scenario: 'no requestId → dropped',
    hosts: BOTH,
    mode: 'default',
    payload: { key: 'draft' },
    call: null,
    reply: null,
  },
  {
    // current behaviour; candidate fix D4
    scenario: 'requestId only (no key) → dropped silently',
    hosts: BOTH,
    mode: 'default',
    payload: { requestId: 'rq_1' },
    call: null,
    reply: null,
    candidateFix: 'D4',
  },
  {
    // current behaviour; candidate fix D7 — the no-token reply omits `value: null`, unlike
    // both the error and the review replies of the same type
    scenario: 'token null → nack error, WITHOUT value:null',
    hosts: PBH,
    mode: 'noToken',
    payload: { requestId: 'rq_1', key: 'draft' },
    call: null,
    reply: { requestId: 'rq_1', error: NACK_NO_TOKEN },
    candidateFix: 'D7',
  },
  {
    scenario: 'review mode → value null + review NACK',
    hosts: PBH,
    mode: 'review',
    payload: { requestId: 'rq_1', key: 'draft' },
    call: null,
    reply: { requestId: 'rq_1', value: null, error: REVIEW_NACK },
  },
  {
    scenario: 'review + run-for-real → forwarded',
    hosts: PBH,
    mode: 'reviewRunForReal',
    payload: { requestId: 'rq_1', key: 'draft' },
    call: [{ blockToken: TOKEN, key: 'draft' }, READ_OPTS],
    reply: { requestId: 'rq_1', value: { note: 'hi' } },
  },
  {
    scenario: 'review + malformed (no key) → review NACK, gate runs first',
    hosts: PBH,
    mode: 'review',
    payload: { requestId: 'rq_1' },
    call: null,
    reply: { requestId: 'rq_1', value: null, error: REVIEW_NACK },
  },
]);

const S_SET = rowsFor('APP_STORAGE_SET', 'apps.storage.set', { sizeBytes: 17 }, [
  {
    scenario: 'valid write invalidates apps.storage BEFORE replying',
    hosts: BOTH,
    mode: 'default',
    payload: { requestId: 'rq_1', key: 'draft', value: { note: 'hi' }, blockToken: 'tok_evil' },
    call: [{ blockToken: TOKEN, key: 'draft', value: { note: 'hi' } }],
    reply: { requestId: 'rq_1', ok: true, sizeBytes: 17 },
    invalidates: 'apps.storage',
  },
  {
    scenario: 'key without value → forwarded with value undefined',
    hosts: BOTH,
    mode: 'default',
    payload: { requestId: 'rq_1', key: 'draft' },
    call: [{ blockToken: TOKEN, key: 'draft', value: undefined }],
    reply: { requestId: 'rq_1', ok: true, sizeBytes: 17 },
    invalidates: 'apps.storage',
  },
  {
    scenario: 'rpc rejects with Error → ok:false + error, no invalidation',
    hosts: BOTH,
    mode: 'default',
    rpc: { rejects: boom },
    payload: { requestId: 'rq_1', key: 'draft', value: 1 },
    call: [{ blockToken: TOKEN, key: 'draft', value: 1 }],
    reply: { requestId: 'rq_1', ok: false, error: 'boom' },
  },
  {
    scenario: 'rpc rejects with tRPC error (rateLimit) → message only, no rateLimit',
    hosts: BOTH,
    mode: 'default',
    rpc: { rejects: rateLimited },
    payload: { requestId: 'rq_1', key: 'draft', value: 1 },
    call: [{ blockToken: TOKEN, key: 'draft', value: 1 }],
    reply: { requestId: 'rq_1', ok: false, error: RL_MESSAGE },
  },
  {
    scenario: 'no requestId → dropped',
    hosts: BOTH,
    mode: 'default',
    payload: { key: 'draft', value: 1 },
    call: null,
    reply: null,
  },
  {
    // current behaviour; candidate fix D4
    scenario: 'requestId only (no key) → dropped silently',
    hosts: BOTH,
    mode: 'default',
    payload: { requestId: 'rq_1', value: 1 },
    call: null,
    reply: null,
    candidateFix: 'D4',
  },
  {
    // current behaviour; candidate fix D7 — no `ok:false`, unlike error + review replies
    scenario: 'token null → nack error, WITHOUT ok:false',
    hosts: PBH,
    mode: 'noToken',
    payload: { requestId: 'rq_1', key: 'draft', value: 1 },
    call: null,
    reply: { requestId: 'rq_1', error: NACK_NO_TOKEN },
    candidateFix: 'D7',
  },
  {
    scenario: 'review mode → ok:false + review NACK',
    hosts: PBH,
    mode: 'review',
    payload: { requestId: 'rq_1', key: 'draft', value: 1 },
    call: null,
    reply: { requestId: 'rq_1', ok: false, error: REVIEW_NACK },
  },
  {
    scenario: 'review + run-for-real → forwarded, invalidates before reply',
    hosts: PBH,
    mode: 'reviewRunForReal',
    payload: { requestId: 'rq_1', key: 'draft', value: 1 },
    call: [{ blockToken: TOKEN, key: 'draft', value: 1 }],
    reply: { requestId: 'rq_1', ok: true, sizeBytes: 17 },
    invalidates: 'apps.storage',
  },
  {
    scenario: 'review + malformed (no key) → review NACK, gate runs first',
    hosts: PBH,
    mode: 'review',
    payload: { requestId: 'rq_1' },
    call: null,
    reply: { requestId: 'rq_1', ok: false, error: REVIEW_NACK },
  },
]);

const S_DEL = rowsFor('APP_STORAGE_DELETE', 'apps.storage.delete', { deleted: true }, [
  {
    scenario: 'valid delete invalidates apps.storage BEFORE replying',
    hosts: BOTH,
    mode: 'default',
    payload: { requestId: 'rq_1', key: 'draft', value: 'ignored' },
    call: [{ blockToken: TOKEN, key: 'draft' }],
    reply: { requestId: 'rq_1', ok: true, deleted: true },
    invalidates: 'apps.storage',
  },
  {
    // The valid row resolves `deleted: true`; this one `false`, so neither can be a constant.
    scenario: 'deleted:false (key did not exist) is passed through, not a constant',
    hosts: BOTH,
    mode: 'default',
    rpc: { resolves: { deleted: false } },
    payload: { requestId: 'rq_1', key: 'nope' },
    call: [{ blockToken: TOKEN, key: 'nope' }],
    reply: { requestId: 'rq_1', ok: true, deleted: false },
    invalidates: 'apps.storage',
  },
  {
    scenario: 'rpc rejects with Error → ok:false + deleted:false + error',
    hosts: BOTH,
    mode: 'default',
    rpc: { rejects: boom },
    payload: { requestId: 'rq_1', key: 'draft' },
    call: [{ blockToken: TOKEN, key: 'draft' }],
    reply: { requestId: 'rq_1', ok: false, deleted: false, error: 'boom' },
  },
  {
    scenario: 'rpc rejects with tRPC error → message only',
    hosts: BOTH,
    mode: 'default',
    rpc: { rejects: rateLimited },
    payload: { requestId: 'rq_1', key: 'draft' },
    call: [{ blockToken: TOKEN, key: 'draft' }],
    reply: { requestId: 'rq_1', ok: false, deleted: false, error: RL_MESSAGE },
  },
  {
    scenario: 'no requestId → dropped',
    hosts: BOTH,
    mode: 'default',
    payload: { key: 'draft' },
    call: null,
    reply: null,
  },
  {
    // current behaviour; candidate fix D4
    scenario: 'requestId only (no key) → dropped silently',
    hosts: BOTH,
    mode: 'default',
    payload: { requestId: 'rq_1' },
    call: null,
    reply: null,
    candidateFix: 'D4',
  },
  {
    // current behaviour; candidate fix D7
    scenario: 'token null → nack error, WITHOUT ok/deleted',
    hosts: PBH,
    mode: 'noToken',
    payload: { requestId: 'rq_1', key: 'draft' },
    call: null,
    reply: { requestId: 'rq_1', error: NACK_NO_TOKEN },
    candidateFix: 'D7',
  },
  {
    scenario: 'review mode → ok:false + deleted:false + review NACK',
    hosts: PBH,
    mode: 'review',
    payload: { requestId: 'rq_1', key: 'draft' },
    call: null,
    reply: { requestId: 'rq_1', ok: false, deleted: false, error: REVIEW_NACK },
  },
  {
    scenario: 'review + run-for-real → forwarded, invalidates before reply',
    hosts: PBH,
    mode: 'reviewRunForReal',
    payload: { requestId: 'rq_1', key: 'draft' },
    call: [{ blockToken: TOKEN, key: 'draft' }],
    reply: { requestId: 'rq_1', ok: true, deleted: true },
    invalidates: 'apps.storage',
  },
  {
    scenario: 'review + malformed (no key) → review NACK, gate runs first',
    hosts: PBH,
    mode: 'review',
    payload: { requestId: 'rq_1' },
    call: null,
    reply: { requestId: 'rq_1', ok: false, deleted: false, error: REVIEW_NACK },
  },
]);

const LIST_RESULT = {
  keys: [{ key: 'a', updatedAt: new Date('2026-06-17T00:00:00.000Z') }],
  nextCursor: 'c2',
};
const LIST_REPLY_KEYS = [{ key: 'a', updatedAt: '2026-06-17T00:00:00.000Z' }];
const S_LIST = rowsFor('APP_STORAGE_LIST', 'apps.storage.list', LIST_RESULT, [
  {
    scenario: 'valid: limit clamped to 200, dates serialised to ISO',
    hosts: BOTH,
    mode: 'default',
    payload: { requestId: 'rq_1', prefix: 'a', limit: 9999, cursor: 'c1' },
    call: [{ blockToken: TOKEN, prefix: 'a', limit: 200, cursor: 'c1' }, READ_OPTS],
    reply: { requestId: 'rq_1', keys: LIST_REPLY_KEYS, nextCursor: 'c2' },
  },
  {
    scenario: 'limit below 1 clamps to 1; fractional limit floors',
    hosts: BOTH,
    mode: 'default',
    payload: { requestId: 'rq_1', limit: 0.5 },
    call: [{ blockToken: TOKEN, prefix: undefined, limit: 1, cursor: undefined }, READ_OPTS],
    reply: { requestId: 'rq_1', keys: LIST_REPLY_KEYS, nextCursor: 'c2' },
  },
  {
    scenario: 'requestId only → default limit 50, undefined prefix/cursor keys present',
    hosts: BOTH,
    mode: 'default',
    payload: { requestId: 'rq_1', limit: '7', prefix: 3 },
    call: [{ blockToken: TOKEN, prefix: undefined, limit: 50, cursor: undefined }, READ_OPTS],
    reply: { requestId: 'rq_1', keys: LIST_REPLY_KEYS, nextCursor: 'c2' },
  },
  {
    scenario: 'rpc rejects with Error → empty keys + error',
    hosts: BOTH,
    mode: 'default',
    rpc: { rejects: boom },
    payload: { requestId: 'rq_1' },
    call: [{ blockToken: TOKEN, prefix: undefined, limit: 50, cursor: undefined }, READ_OPTS],
    reply: { requestId: 'rq_1', keys: [], error: 'boom' },
  },
  {
    scenario: 'rpc rejects with tRPC error → message only',
    hosts: BOTH,
    mode: 'default',
    rpc: { rejects: rateLimited },
    payload: { requestId: 'rq_1' },
    call: [{ blockToken: TOKEN, prefix: undefined, limit: 50, cursor: undefined }, READ_OPTS],
    reply: { requestId: 'rq_1', keys: [], error: RL_MESSAGE },
  },
  {
    scenario: 'no requestId → dropped',
    hosts: BOTH,
    mode: 'default',
    payload: { prefix: 'a' },
    call: null,
    reply: null,
  },
  {
    // current behaviour; candidate fix D7
    scenario: 'token null → nack error, WITHOUT keys:[]',
    hosts: PBH,
    mode: 'noToken',
    payload: { requestId: 'rq_1' },
    call: null,
    reply: { requestId: 'rq_1', error: NACK_NO_TOKEN },
    candidateFix: 'D7',
  },
  {
    scenario: 'review mode → empty keys + review NACK',
    hosts: PBH,
    mode: 'review',
    payload: { requestId: 'rq_1' },
    call: null,
    reply: { requestId: 'rq_1', keys: [], error: REVIEW_NACK },
  },
  {
    scenario: 'review + run-for-real → forwarded',
    hosts: PBH,
    mode: 'reviewRunForReal',
    payload: { requestId: 'rq_1', prefix: 'a' },
    call: [{ blockToken: TOKEN, prefix: 'a', limit: 50, cursor: undefined }, READ_OPTS],
    reply: { requestId: 'rq_1', keys: LIST_REPLY_KEYS, nextCursor: 'c2' },
  },
]);

const QUOTA = { usedBytes: 100, rowCount: 3, limitBytes: 1000, limitRows: 50 };
const S_QUOTA = rowsFor('APP_STORAGE_QUOTA', 'apps.storage.getQuota', { ...QUOTA, extra: 1 }, [
  {
    scenario: 'valid: four quota fields copied, extras dropped',
    hosts: BOTH,
    mode: 'default',
    payload: { requestId: 'rq_1', blockToken: 'tok_evil' },
    call: [{ blockToken: TOKEN }, READ_OPTS],
    reply: { requestId: 'rq_1', ...QUOTA },
  },
  {
    scenario: 'rpc rejects with Error → zeroed quota + error',
    hosts: BOTH,
    mode: 'default',
    rpc: { rejects: boom },
    payload: { requestId: 'rq_1' },
    call: [{ blockToken: TOKEN }, READ_OPTS],
    reply: {
      requestId: 'rq_1',
      usedBytes: 0,
      rowCount: 0,
      limitBytes: 0,
      limitRows: 0,
      error: 'boom',
    },
  },
  {
    scenario: 'rpc rejects with tRPC error → message only',
    hosts: BOTH,
    mode: 'default',
    rpc: { rejects: rateLimited },
    payload: { requestId: 'rq_1' },
    call: [{ blockToken: TOKEN }, READ_OPTS],
    reply: {
      requestId: 'rq_1',
      usedBytes: 0,
      rowCount: 0,
      limitBytes: 0,
      limitRows: 0,
      error: RL_MESSAGE,
    },
  },
  {
    scenario: 'no requestId → dropped',
    hosts: BOTH,
    mode: 'default',
    payload: {},
    call: null,
    reply: null,
  },
  {
    // current behaviour; candidate fix D7
    scenario: 'token null → nack error, WITHOUT the zeroed quota fields',
    hosts: PBH,
    mode: 'noToken',
    payload: { requestId: 'rq_1' },
    call: null,
    reply: { requestId: 'rq_1', error: NACK_NO_TOKEN },
    candidateFix: 'D7',
  },
  {
    scenario: 'review mode → zeroed quota + review NACK',
    hosts: PBH,
    mode: 'review',
    payload: { requestId: 'rq_1' },
    call: null,
    reply: {
      requestId: 'rq_1',
      usedBytes: 0,
      rowCount: 0,
      limitBytes: 0,
      limitRows: 0,
      error: REVIEW_NACK,
    },
  },
  {
    scenario: 'review + run-for-real → forwarded',
    hosts: PBH,
    mode: 'reviewRunForReal',
    payload: { requestId: 'rq_1' },
    call: [{ blockToken: TOKEN }, READ_OPTS],
    reply: { requestId: 'rq_1', ...QUOTA },
  },
]);

// ── Shared storage ──
const ITEM = {
  key: 'k1',
  authorUserId: 7,
  value: { title: 'hello' },
  count: 3,
  createdAt: new Date('2026-06-01T00:00:00.000Z'),
  updatedAt: new Date('2026-06-02T00:00:00.000Z'),
  viewerVoted: true,
  hiddenAt: null,
};
const ITEM_REPLY = {
  key: 'k1',
  authorUserId: 7,
  value: { title: 'hello' },
  count: 3,
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-02T00:00:00.000Z',
  viewerVoted: true,
};

/**
 * `viewerVoted` is OPTIONAL on a shared row (absent when the server has no viewer to vote).
 * ITEM above always carries `true`, so on its own it cannot see a host that DEFAULTS the
 * field (`?? false`); these fixtures omit it, and strict equality then pins the pass-through.
 */
const { viewerVoted: _vvItem, ...ITEM_NO_VOTE } = ITEM;
const { viewerVoted: _vvReply, ...ITEM_REPLY_NO_VOTE_BASE } = ITEM_REPLY;
const ITEM_REPLY_NO_VOTE = { ...ITEM_REPLY_NO_VOTE_BASE, viewerVoted: undefined };

const SH_LIST = rowsFor('SHARED_LIST', 'apps.shared.list', { items: [ITEM], nextCursor: 'c2' }, [
  {
    scenario: 'valid: limit clamped to 100, mine:true forwarded, item mapped',
    hosts: BOTH,
    mode: 'default',
    payload: { requestId: 'rq_1', prefix: 'p', limit: 500, cursor: 'c1', mine: true },
    call: [{ blockToken: TOKEN, prefix: 'p', limit: 100, cursor: 'c1', mine: true }, READ_OPTS],
    reply: { requestId: 'rq_1', items: [ITEM_REPLY], nextCursor: 'c2' },
  },
  {
    scenario: 'an item WITHOUT viewerVoted is passed through as undefined, not defaulted',
    hosts: BOTH,
    mode: 'default',
    rpc: { resolves: { items: [ITEM_NO_VOTE], nextCursor: 'c2' } },
    payload: { requestId: 'rq_1' },
    call: [
      { blockToken: TOKEN, prefix: undefined, limit: 50, cursor: undefined, mine: undefined },
      READ_OPTS,
    ],
    reply: { requestId: 'rq_1', items: [ITEM_REPLY_NO_VOTE], nextCursor: 'c2' },
  },
  {
    scenario: 'a result WITHOUT nextCursor replies nextCursor undefined, not defaulted',
    hosts: BOTH,
    mode: 'default',
    rpc: { resolves: { items: [ITEM] } },
    payload: { requestId: 'rq_1' },
    call: [
      { blockToken: TOKEN, prefix: undefined, limit: 50, cursor: undefined, mine: undefined },
      READ_OPTS,
    ],
    reply: { requestId: 'rq_1', items: [ITEM_REPLY], nextCursor: undefined },
  },
  {
    scenario: 'mine:"true" (string) is NOT forwarded as true',
    hosts: BOTH,
    mode: 'default',
    payload: { requestId: 'rq_1', mine: 'true' },
    call: [
      { blockToken: TOKEN, prefix: undefined, limit: 50, cursor: undefined, mine: undefined },
      READ_OPTS,
    ],
    reply: { requestId: 'rq_1', items: [ITEM_REPLY], nextCursor: 'c2' },
  },
  {
    scenario: 'rpc rejects with Error → error only',
    hosts: BOTH,
    mode: 'default',
    rpc: { rejects: boom },
    payload: { requestId: 'rq_1' },
    call: [
      { blockToken: TOKEN, prefix: undefined, limit: 50, cursor: undefined, mine: undefined },
      READ_OPTS,
    ],
    reply: { requestId: 'rq_1', error: 'boom' },
  },
  {
    scenario: 'rpc rejects with tRPC rateLimit error → a READ drops the rateLimit meta',
    hosts: BOTH,
    mode: 'default',
    rpc: { rejects: rateLimited },
    payload: { requestId: 'rq_1' },
    call: [
      { blockToken: TOKEN, prefix: undefined, limit: 50, cursor: undefined, mine: undefined },
      READ_OPTS,
    ],
    reply: { requestId: 'rq_1', error: RL_MESSAGE },
  },
  {
    scenario: 'no requestId → dropped',
    hosts: BOTH,
    mode: 'default',
    payload: { prefix: 'p' },
    call: null,
    reply: null,
  },
  {
    scenario: 'token null → nack error',
    hosts: PBH,
    mode: 'noToken',
    payload: { requestId: 'rq_1' },
    call: null,
    reply: { requestId: 'rq_1', error: NACK_NO_TOKEN },
  },
  {
    scenario: 'review mode → NOT gated, forwarded (shared reads stay live)',
    hosts: PBH,
    mode: 'review',
    payload: { requestId: 'rq_1', prefix: 'p' },
    call: [
      { blockToken: TOKEN, prefix: 'p', limit: 50, cursor: undefined, mine: undefined },
      READ_OPTS,
    ],
    reply: { requestId: 'rq_1', items: [ITEM_REPLY], nextCursor: 'c2' },
  },
  {
    scenario: 'review + run-for-real → forwarded',
    hosts: PBH,
    mode: 'reviewRunForReal',
    payload: { requestId: 'rq_1', prefix: 'p' },
    call: [
      { blockToken: TOKEN, prefix: 'p', limit: 50, cursor: undefined, mine: undefined },
      READ_OPTS,
    ],
    reply: { requestId: 'rq_1', items: [ITEM_REPLY], nextCursor: 'c2' },
  },
]);

const SH_GET = rowsFor('SHARED_GET', 'apps.shared.get', { item: ITEM }, [
  {
    scenario: 'valid: item mapped like SHARED_LIST',
    hosts: BOTH,
    mode: 'default',
    payload: { requestId: 'rq_1', key: 'k1' },
    call: [{ blockToken: TOKEN, key: 'k1' }, READ_OPTS],
    reply: { requestId: 'rq_1', item: ITEM_REPLY },
  },
  {
    scenario: 'an item WITHOUT viewerVoted is passed through as undefined, not defaulted',
    hosts: BOTH,
    mode: 'default',
    rpc: { resolves: { item: ITEM_NO_VOTE } },
    payload: { requestId: 'rq_1', key: 'k1' },
    call: [{ blockToken: TOKEN, key: 'k1' }, READ_OPTS],
    reply: { requestId: 'rq_1', item: ITEM_REPLY_NO_VOTE },
  },
  {
    scenario: 'missing row → item:null',
    hosts: BOTH,
    mode: 'default',
    rpc: { resolves: { item: null } },
    payload: { requestId: 'rq_1', key: 'gone' },
    call: [{ blockToken: TOKEN, key: 'gone' }, READ_OPTS],
    reply: { requestId: 'rq_1', item: null },
  },
  {
    scenario: 'rpc rejects with Error → item:null + error',
    hosts: BOTH,
    mode: 'default',
    rpc: { rejects: boom },
    payload: { requestId: 'rq_1', key: 'k1' },
    call: [{ blockToken: TOKEN, key: 'k1' }, READ_OPTS],
    reply: { requestId: 'rq_1', item: null, error: 'boom' },
  },
  {
    scenario: 'rpc rejects with tRPC rateLimit error → message only',
    hosts: BOTH,
    mode: 'default',
    rpc: { rejects: rateLimited },
    payload: { requestId: 'rq_1', key: 'k1' },
    call: [{ blockToken: TOKEN, key: 'k1' }, READ_OPTS],
    reply: { requestId: 'rq_1', item: null, error: RL_MESSAGE },
  },
  {
    scenario: 'no requestId → dropped',
    hosts: BOTH,
    mode: 'default',
    payload: { key: 'k1' },
    call: null,
    reply: null,
  },
  {
    // current behaviour; candidate fix D4
    scenario: 'requestId only (no key) → dropped silently',
    hosts: BOTH,
    mode: 'default',
    payload: { requestId: 'rq_1' },
    call: null,
    reply: null,
    candidateFix: 'D4',
  },
  {
    // current behaviour; candidate fix D7 — no `item: null`, unlike the error reply
    scenario: 'token null → nack error, WITHOUT item:null',
    hosts: PBH,
    mode: 'noToken',
    payload: { requestId: 'rq_1', key: 'k1' },
    call: null,
    reply: { requestId: 'rq_1', error: NACK_NO_TOKEN },
    candidateFix: 'D7',
  },
  {
    scenario: 'review mode → NOT gated, forwarded',
    hosts: PBH,
    mode: 'review',
    payload: { requestId: 'rq_1', key: 'k1' },
    call: [{ blockToken: TOKEN, key: 'k1' }, READ_OPTS],
    reply: { requestId: 'rq_1', item: ITEM_REPLY },
  },
  {
    scenario: 'review + run-for-real → forwarded',
    hosts: PBH,
    mode: 'reviewRunForReal',
    payload: { requestId: 'rq_1', key: 'k1' },
    call: [{ blockToken: TOKEN, key: 'k1' }, READ_OPTS],
    reply: { requestId: 'rq_1', item: ITEM_REPLY },
  },
  {
    // current behaviour; candidate fix D4 — no review gate here, so malformed is silent
    scenario: 'review + malformed (no key) → dropped silently (no gate on reads)',
    hosts: PBH,
    mode: 'review',
    payload: { requestId: 'rq_1' },
    call: null,
    reply: null,
    candidateFix: 'D4',
  },
]);

const SH_COUNT = rowsFor('SHARED_GET_COUNT', 'apps.shared.getCount', { count: 9, extra: 1 }, [
  {
    scenario: 'valid',
    hosts: BOTH,
    mode: 'default',
    payload: { requestId: 'rq_1', key: 'k1' },
    call: [{ blockToken: TOKEN, key: 'k1' }, READ_OPTS],
    reply: { requestId: 'rq_1', count: 9 },
  },
  {
    scenario: 'rpc rejects with Error → error only',
    hosts: BOTH,
    mode: 'default',
    rpc: { rejects: boom },
    payload: { requestId: 'rq_1', key: 'k1' },
    call: [{ blockToken: TOKEN, key: 'k1' }, READ_OPTS],
    reply: { requestId: 'rq_1', error: 'boom' },
  },
  {
    scenario: 'rpc rejects with tRPC error → message only',
    hosts: BOTH,
    mode: 'default',
    rpc: { rejects: rateLimited },
    payload: { requestId: 'rq_1', key: 'k1' },
    call: [{ blockToken: TOKEN, key: 'k1' }, READ_OPTS],
    reply: { requestId: 'rq_1', error: RL_MESSAGE },
  },
  {
    scenario: 'no requestId → dropped',
    hosts: BOTH,
    mode: 'default',
    payload: { key: 'k1' },
    call: null,
    reply: null,
  },
  {
    // current behaviour; candidate fix D4
    scenario: 'requestId only (no key) → dropped silently',
    hosts: BOTH,
    mode: 'default',
    payload: { requestId: 'rq_1' },
    call: null,
    reply: null,
    candidateFix: 'D4',
  },
  {
    scenario: 'token null → nack error',
    hosts: PBH,
    mode: 'noToken',
    payload: { requestId: 'rq_1', key: 'k1' },
    call: null,
    reply: { requestId: 'rq_1', error: NACK_NO_TOKEN },
  },
  {
    scenario: 'review mode → NOT gated, forwarded',
    hosts: PBH,
    mode: 'review',
    payload: { requestId: 'rq_1', key: 'k1' },
    call: [{ blockToken: TOKEN, key: 'k1' }, READ_OPTS],
    reply: { requestId: 'rq_1', count: 9 },
  },
  {
    scenario: 'review + run-for-real → forwarded',
    hosts: PBH,
    mode: 'reviewRunForReal',
    payload: { requestId: 'rq_1', key: 'k1' },
    call: [{ blockToken: TOKEN, key: 'k1' }, READ_OPTS],
    reply: { requestId: 'rq_1', count: 9 },
  },
]);

const SH_COUNTS = rowsFor('SHARED_GET_COUNTS', 'apps.shared.getCounts', { counts: { a: 1 } }, [
  {
    scenario: 'valid',
    hosts: BOTH,
    mode: 'default',
    payload: { requestId: 'rq_1', keys: ['a', 'b'] },
    call: [{ blockToken: TOKEN, keys: ['a', 'b'] }, READ_OPTS],
    reply: { requestId: 'rq_1', counts: { a: 1 } },
  },
  {
    scenario: 'non-string array elements are forwarded unchecked (server validates)',
    hosts: BOTH,
    mode: 'default',
    payload: { requestId: 'rq_1', keys: [1, null] },
    call: [{ blockToken: TOKEN, keys: [1, null] }, READ_OPTS],
    reply: { requestId: 'rq_1', counts: { a: 1 } },
  },
  {
    scenario: 'rpc rejects with Error → error only',
    hosts: BOTH,
    mode: 'default',
    rpc: { rejects: boom },
    payload: { requestId: 'rq_1', keys: ['a'] },
    call: [{ blockToken: TOKEN, keys: ['a'] }, READ_OPTS],
    reply: { requestId: 'rq_1', error: 'boom' },
  },
  {
    scenario: 'rpc rejects with tRPC error → message only',
    hosts: BOTH,
    mode: 'default',
    rpc: { rejects: rateLimited },
    payload: { requestId: 'rq_1', keys: ['a'] },
    call: [{ blockToken: TOKEN, keys: ['a'] }, READ_OPTS],
    reply: { requestId: 'rq_1', error: RL_MESSAGE },
  },
  {
    scenario: 'no requestId → dropped',
    hosts: BOTH,
    mode: 'default',
    payload: { keys: ['a'] },
    call: null,
    reply: null,
  },
  {
    // current behaviour; candidate fix D4
    scenario: 'keys not an array → dropped silently',
    hosts: BOTH,
    mode: 'default',
    payload: { requestId: 'rq_1', keys: 'a' },
    call: null,
    reply: null,
    candidateFix: 'D4',
  },
  {
    scenario: 'token null → nack error',
    hosts: PBH,
    mode: 'noToken',
    payload: { requestId: 'rq_1', keys: ['a'] },
    call: null,
    reply: { requestId: 'rq_1', error: NACK_NO_TOKEN },
  },
  {
    scenario: 'review mode → NOT gated, forwarded',
    hosts: PBH,
    mode: 'review',
    payload: { requestId: 'rq_1', keys: ['a'] },
    call: [{ blockToken: TOKEN, keys: ['a'] }, READ_OPTS],
    reply: { requestId: 'rq_1', counts: { a: 1 } },
  },
  {
    scenario: 'review + run-for-real → forwarded',
    hosts: PBH,
    mode: 'reviewRunForReal',
    payload: { requestId: 'rq_1', keys: ['a'] },
    call: [{ blockToken: TOKEN, keys: ['a'] }, READ_OPTS],
    reply: { requestId: 'rq_1', counts: { a: 1 } },
  },
]);

/**
 * Shared WRITES share one skeleton: invalidate `apps.shared` before the success reply,
 * carry `rateLimit` on a rate-limited refusal, and NACK in review mode EVEN under
 * run-for-real. What differs per type is the payload, the call and the reply shapes.
 */
function sharedWriteRows(opts: {
  type: string;
  proc: string;
  resolves: unknown;
  payload: Record<string, unknown>;
  call: Record<string, unknown>;
  successReply: Record<string, unknown>;
  /** Fields the error reply carries before `error` (e.g. `ok: false`). */
  errorPrefix: Record<string, unknown>;
  /** Fields the review NACK carries before `error`. */
  reviewPrefix: Record<string, unknown>;
  malformed: { scenario: string; payload: Record<string, unknown> };
  extra?: MatrixRow[];
}): MatrixRow[] {
  const { type, proc, resolves, payload, call } = opts;
  return [
    ...rowsFor(type, proc, resolves, [
      {
        scenario: 'valid write invalidates apps.shared BEFORE replying',
        hosts: BOTH,
        mode: 'default',
        payload: { requestId: 'rq_1', ...payload, blockToken: 'tok_evil' },
        call: [{ blockToken: TOKEN, ...call }],
        reply: { requestId: 'rq_1', ...opts.successReply },
        invalidates: 'apps.shared',
      },
      {
        scenario: 'rpc rejects with Error → error reply, no invalidation, no rateLimit',
        hosts: BOTH,
        mode: 'default',
        rpc: { rejects: boom },
        payload: { requestId: 'rq_1', ...payload },
        call: [{ blockToken: TOKEN, ...call }],
        reply: { requestId: 'rq_1', ...opts.errorPrefix, error: 'boom' },
      },
      {
        scenario: 'rpc rejects with tRPC rateLimit error → rateLimit meta carried',
        hosts: BOTH,
        mode: 'default',
        rpc: { rejects: rateLimited },
        payload: { requestId: 'rq_1', ...payload },
        call: [{ blockToken: TOKEN, ...call }],
        reply: {
          requestId: 'rq_1',
          ...opts.errorPrefix,
          error: RL_MESSAGE,
          rateLimit: RATE_LIMIT,
        },
      },
      {
        scenario: 'rpc rejects with malformed rateLimit meta → meta dropped',
        hosts: BOTH,
        mode: 'default',
        rpc: { rejects: rateLimitedMalformedMeta },
        payload: { requestId: 'rq_1', ...payload },
        call: [{ blockToken: TOKEN, ...call }],
        reply: { requestId: 'rq_1', ...opts.errorPrefix, error: RL_MESSAGE },
      },
      {
        scenario: 'no requestId → dropped',
        hosts: BOTH,
        mode: 'default',
        payload: { ...payload },
        call: null,
        reply: null,
      },
      {
        // current behaviour; candidate fix D4
        scenario: opts.malformed.scenario,
        hosts: BOTH,
        mode: 'default',
        payload: { requestId: 'rq_1', ...opts.malformed.payload },
        call: null,
        reply: null,
        candidateFix: 'D4',
      },
      {
        scenario: 'token null → nack error',
        hosts: PBH,
        mode: 'noToken',
        payload: { requestId: 'rq_1', ...payload },
        call: null,
        reply: { requestId: 'rq_1', error: NACK_NO_TOKEN },
      },
      {
        scenario: 'review mode → review NACK',
        hosts: PBH,
        mode: 'review',
        payload: { requestId: 'rq_1', ...payload },
        call: null,
        reply: { requestId: 'rq_1', ...opts.reviewPrefix, error: REVIEW_NACK },
      },
      {
        scenario: 'review + run-for-real → STILL NACKed (cross-user write never granted)',
        hosts: PBH,
        mode: 'reviewRunForReal',
        payload: { requestId: 'rq_1', ...payload },
        call: null,
        reply: { requestId: 'rq_1', ...opts.reviewPrefix, error: REVIEW_NACK },
      },
      {
        scenario: 'review + malformed → review NACK, gate runs first',
        hosts: PBH,
        mode: 'review',
        payload: { requestId: 'rq_1', ...opts.malformed.payload },
        call: null,
        reply: { requestId: 'rq_1', ...opts.reviewPrefix, error: REVIEW_NACK },
      },
    ]),
    ...(opts.extra ?? []),
  ];
}

const SH_APPEND = sharedWriteRows({
  type: 'SHARED_APPEND',
  proc: 'apps.shared.append',
  resolves: { key: 'k9', sizeBytes: 3 },
  payload: { value: { title: 'new' } },
  call: { value: { title: 'new' } },
  successReply: { key: 'k9' },
  errorPrefix: {},
  reviewPrefix: {},
  malformed: { scenario: 'value null → dropped silently', payload: { value: null } },
  extra: rowsFor('SHARED_APPEND', 'apps.shared.append', { key: 'k9' }, [
    {
      // current behaviour; candidate fix D4
      scenario: 'string value → dropped silently',
      hosts: BOTH,
      mode: 'default',
      payload: { requestId: 'rq_1', value: 'new' },
      call: null,
      reply: null,
      candidateFix: 'D4',
    },
  ]),
});

const SH_UPDATE = sharedWriteRows({
  type: 'SHARED_UPDATE',
  proc: 'apps.shared.update',
  resolves: { ok: true, extra: 1 },
  payload: { key: 'k1', value: { title: 'edited' } },
  call: { key: 'k1', value: { title: 'edited' } },
  successReply: { ok: true },
  errorPrefix: { ok: false },
  reviewPrefix: { ok: false },
  malformed: { scenario: 'no value → dropped silently', payload: { key: 'k1' } },
});

const SH_VOTE = sharedWriteRows({
  type: 'SHARED_VOTE',
  proc: 'apps.shared.vote',
  resolves: { count: 4, extra: 1 },
  payload: { key: 'k1' },
  call: { key: 'k1' },
  successReply: { count: 4 },
  errorPrefix: {},
  reviewPrefix: {},
  malformed: { scenario: 'no key → dropped silently', payload: {} },
});

const SH_UNVOTE = sharedWriteRows({
  type: 'SHARED_UNVOTE',
  proc: 'apps.shared.unvote',
  resolves: { count: 2, extra: 1 },
  payload: { key: 'k1' },
  call: { key: 'k1' },
  successReply: { count: 2 },
  errorPrefix: {},
  reviewPrefix: {},
  malformed: { scenario: 'no key → dropped silently', payload: {} },
});

const SH_WITHDRAW = sharedWriteRows({
  type: 'SHARED_WITHDRAW',
  proc: 'apps.shared.withdraw',
  resolves: { ok: true, deleted: false, extra: 1 },
  payload: { key: 'k1' },
  call: { key: 'k1' },
  successReply: { ok: true, deleted: false },
  // current behaviour; candidate fix D8 — WITHDRAW's error + review replies carry no
  // `ok:false`, while its `{ ok, error? }` siblings UPDATE and REPORT send one
  errorPrefix: {},
  reviewPrefix: {},
  malformed: { scenario: 'no key → dropped silently', payload: {} },
  // The valid row resolves `deleted: false`; this one resolves `deleted: true`, so a host
  // that hardcoded either value is caught by one of the two.
  extra: rowsFor('SHARED_WITHDRAW', 'apps.shared.withdraw', { ok: true, deleted: true }, [
    {
      scenario: 'deleted:true from the server is passed through (not a constant)',
      hosts: BOTH,
      mode: 'default',
      payload: { requestId: 'rq_1', key: 'k1' },
      call: [{ blockToken: TOKEN, key: 'k1' }],
      reply: { requestId: 'rq_1', ok: true, deleted: true },
      invalidates: 'apps.shared',
    },
  ]),
});

const SH_REPORT = sharedWriteRows({
  type: 'SHARED_REPORT',
  proc: 'apps.shared.report',
  resolves: { ok: true },
  payload: { key: 'k1', reason: 'spam' },
  call: { key: 'k1', reason: 'spam' },
  successReply: { ok: true },
  errorPrefix: { ok: false },
  reviewPrefix: { ok: false },
  malformed: { scenario: 'no key → dropped silently', payload: { reason: 'spam' } },
  extra: rowsFor('SHARED_REPORT', 'apps.shared.report', { ok: true }, [
    {
      scenario: 'non-string reason → reason key present as undefined',
      hosts: BOTH,
      mode: 'default',
      payload: { requestId: 'rq_1', key: 'k1', reason: 42 },
      call: [{ blockToken: TOKEN, key: 'k1', reason: undefined }],
      reply: { requestId: 'rq_1', ok: true },
      invalidates: 'apps.shared',
    },
  ]),
});
// D8 is pinned by the WITHDRAW rows above (their error/review replies have no `ok`).
for (const r of SH_WITHDRAW) {
  if (r.reply && 'error' in r.reply && !('ok' in r.reply)) r.candidateFix = 'D8';
}

export const ROWS: readonly MatrixRow[] = [
  ...SUBMIT,
  ...ESTIMATE,
  ...POLL,
  ...CANCEL,
  ...QUERY_APP,
  ...CANCEL_APP,
  ...BUZZ_BALANCE,
  ...BUZZ_TX,
  ...BUZZ_ACCOUNTS,
  ...DAILY_COMP,
  ...VIEWER,
  ...IMAGES,
  ...S_GET,
  ...S_SET,
  ...S_DEL,
  ...S_LIST,
  ...S_QUOTA,
  ...SH_LIST,
  ...SH_GET,
  ...SH_COUNT,
  ...SH_COUNTS,
  ...SH_APPEND,
  ...SH_UPDATE,
  ...SH_VOTE,
  ...SH_UNVOTE,
  ...SH_WITHDRAW,
  ...SH_REPORT,
];

/**
 * Every way `rows` disagree with INVENTORY's `replyKeys` / `errorKeys`. `runRow` pins each row's
 * `reply` with strict equality to what the real host sent, so a row here is evidence about the
 * host, not a literal compared with itself.
 *
 * It checks both directions:
 *   - every pinned reply matches its declared list (`checkReplyKeys`);
 *   - every declared key, `?` keys included, appears in at least one reply of that outcome, and
 *     a type whose `errorKeys` is a list has at least one pinned error reply. Otherwise a
 *     declared key that no row exercises reads as checked.
 */
export function replyKeysProblems(rows: readonly MatrixRow[]): string[] {
  const problems: string[] = [];
  const seen = new Map<string, { success: Set<string>; error: Set<string>; errors: number }>();
  for (const row of rows) {
    if (!row.reply) continue;
    const type = row.type as InventoryType;
    const { outcome, problems: rowProblems } = checkReplyKeys(type, row.reply);
    for (const p of rowProblems) problems.push(`${rowName(row)}: ${p}`);
    const s = seen.get(type) ?? { success: new Set(), error: new Set(), errors: 0 };
    for (const k of Object.keys(row.reply)) if (k !== 'requestId') s[outcome].add(k);
    if (outcome === 'error') s.errors += 1;
    seen.set(type, s);
  }
  for (const type of new Set(rows.map((r) => r.type))) {
    const spec = INVENTORY[type as InventoryType];
    const s = seen.get(type);
    if (!s) {
      problems.push(`${type}: no row pins a reply`);
      continue;
    }
    const lists = [
      ['replyKeys', spec.replyKeys, s.success],
      ['errorKeys', spec.errorKeys, s.error],
    ] as const;
    for (const [field, declared, observed] of lists) {
      if (!Array.isArray(declared)) continue;
      const { required, optional } = parseDeclaredKeys(declared);
      for (const k of [...required, ...optional]) {
        if (!observed.has(k)) problems.push(`${type}: ${field} declares \`${k}\`; no row has it`);
      }
    }
    if (Array.isArray(spec.errorKeys) && s.errors === 0) {
      problems.push(`${type}: errorKeys is a list, but no row pins an error reply`);
    }
  }
  return problems;
}

export function rowName(row: MatrixRow): string {
  return `${row.type} · ${row.mode} · ${row.scenario}`;
}

// ── Runner ───────────────────────────────────────────────────────────────────────────────

export interface ReplyLog {
  of: (type: string) => Array<{ type: string; payload: unknown }>;
  stop: () => void;
}

export interface HostDriver {
  rpc: BridgeRpcMock;
  /** Mount the host in `mode` and return once its handlers are registered. */
  mount: (mode: MountMode) => Promise<void>;
  post: (type: string, payload: unknown) => void;
  /** Start capturing host→block replies; each one must also be pushed to `rpc.events`. */
  listen: () => ReplyLog;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** How long a "no reply" row waits before its positive control. */
const SILENCE_MS = 150;
/** How long an invalidation is held open before it is released. */
const HOLD_MS = 100;

const isAppsInvalidate = (e: string) =>
  e.startsWith('invalidate:apps.storage:') || e.startsWith('invalidate:apps.shared:');

export async function runRow(row: MatrixRow, d: HostDriver): Promise<void> {
  const { rpc } = d;
  rpc.reset();
  const spy = rpc.fn(row.proc);
  if ('rejects' in row.rpc) spy.mockRejectedValue(row.rpc.rejects);
  else spy.mockResolvedValue(row.rpc.resolves);
  const replyType = REPLY_TYPE[row.type];

  await d.mount(row.mode);
  const replies = d.listen();
  try {
    if (row.reply) {
      const release = row.invalidates ? rpc.holdInvalidations() : null;
      d.post(row.type, row.payload);
      if (release) {
        await vi.waitFor(() => {
          expect(rpc.events).toContain(`invalidate:${row.invalidates}:start`);
        });
        await sleep(HOLD_MS);
        // The reply must NOT exist while the invalidation is still unsettled.
        expect(replies.of(replyType)).toEqual([]);
        release();
      }
      await vi.waitFor(() => {
        expect(replies.of(replyType).length).toBeGreaterThan(0);
      });
      await sleep(30); // a duplicate reply would land here
      expect(replies.of(replyType).map((r) => r.payload)).toStrictEqual([row.reply]);
    } else {
      d.post(row.type, row.payload);
      await sleep(SILENCE_MS);
    }

    // Everything below reads the state BEFORE any positive control ran.
    const calls = [...spy.mock.calls];
    const events = [...rpc.events];

    if (row.call) expect(calls).toStrictEqual([row.call]);
    else expect(calls).toEqual([]);

    if (row.invalidates) {
      expect(rpc.invalidate(row.invalidates)).toHaveBeenCalledTimes(1);
      const iCall = events.indexOf(`rpc:${row.proc}`);
      const iSettled = events.indexOf(`invalidate:${row.invalidates}:settled`);
      const iReply = events.indexOf(`reply:${replyType}`);
      expect(iCall).toBeGreaterThanOrEqual(0);
      expect(iSettled).toBeGreaterThan(iCall);
      expect(iReply).toBeGreaterThan(iSettled);
      expect(events.filter(isAppsInvalidate)).toEqual([
        `invalidate:${row.invalidates}:start`,
        `invalidate:${row.invalidates}:settled`,
      ]);
    } else {
      expect(events.filter(isAppsInvalidate)).toEqual([]);
    }

    if (!row.reply) {
      expect(replies.of(replyType)).toEqual([]);
      // POSITIVE CONTROL: the same mount answers a valid request of this type, so the
      // silence above is a property of the payload, not of a handler that never listened.
      const sentinel = SENTINEL[row.type];
      spy.mockReset();
      spy.mockResolvedValue(sentinel.resolves);
      d.post(row.type, { requestId: LIVE_ID, ...sentinel.payload });
      await vi.waitFor(() => {
        const live = replies
          .of(replyType)
          .filter((r) => (r.payload as { requestId?: unknown })?.requestId === LIVE_ID);
        expect(live).toHaveLength(1);
      });
      expect(replies.of(replyType)).toHaveLength(1);
    }
  } finally {
    replies.stop();
  }
}
