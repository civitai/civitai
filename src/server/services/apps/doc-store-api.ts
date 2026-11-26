// The REST layer of the App Blocks document store: `/api/v1/blocks/storage/…`, served by
// one catch-all page (`src/pages/api/v1/blocks/storage/[[...path]].ts`). It resolves the
// caller (`doc-store-access.ts`), runs the gates the store leaves to its caller — scopes,
// consent, a collection's `ownedModelVersions` rule (`doc-store-ownership.ts`), the
// min-trust gate, rate limits, a collection's permission hook (`doc-store-hook.ts`),
// moderation — calls the store, and presents the result. Every refusal leaves through
// `sendError`, the one place a `DocStoreError` code becomes an HTTP status.
//
// PATHS. Collection names match `^[a-z][a-z0-9_]{0,31}$` and keys `[A-Za-z0-9._:-]{1,128}`,
// so a segment starting with `_` can never be a collection name. Every non-collection
// operation therefore sits at the COLLECTION position behind a leading `_`
// (`STORAGE_RESERVED_SEGMENTS`, positions 0-based):
//   []                               GET    info
//   [c]                              GET    list            POST create
//   ['_get', c]                      POST   get many  { keys }
//   [c, key]                         GET    get     PUT put     DELETE delete
//   [c, '@me']                       GET    getMine PUT putMine DELETE deleteMine  (keyedBy viewer)
//   [c, '@me', parent]               the same, for keyedBy parent+viewer (`viewerKeyedRoute`)
//   [c, key, 'marks', 'report']      PUT    reportMark DELETE unreportMark  (compatibility alias)
// `@me` sits at the KEY position and is outside the key grammar (`@`), so it is never a key.
// `_get` is a POST with a body (not a GET query) because 100 keys of 128 characters do not
// fit in a URL every proxy accepts.
//
// REMOVED (docs/app-storage-generic-core.md, rollout step 5): marks, counters, their tallies and
// server-side publish. Their routes are not routes any more and answer exactly as any unknown
// one: `PATCH /:c/:key` (the tally operators) a `405` naming the methods the path has,
// `/:c/:key/counters/:name` and `/:c/:key/marks/:name` a `404 not_found`, `_publish` /
// `_unpublish` a `404 not_found`, with ONE exception below. A list naming `markedBy` or `mark` is
// refused as any unknown parameter, and `sort=counter:` / `sort=mark:` as any undeclared sort field. A document is
// still presented with `counters: {}`, `marks: {}` and `viewer` (`presentDocs`), because
// published SDK releases refuse a document without them. Reports go through the report API
// (`doc-store-report-api.ts`); votes and per-viewer entries are viewer-keyed documents (`@me`).
//
// THE REPORT MARK ALIAS. Apps bundled with an SDK older than 0.30 report with
// `collection.mark(key, 'report')`, i.e. `PUT /:c/:key/marks/report`, and the `report` mark worked
// on every shared collection without being declared. So that path, and ONLY that mark name, stays:
// a `PUT` files a report through `fileReport`, exactly the code the report API runs (same gates,
// same budget, same `doc_mark` row and dedupe, same moderator queue), and answers `{marked: true}`,
// the shape those SDKs read; a `DELETE` answers what it always did, `400 invalid_request` "a report
// cannot be withdrawn", before any budget or trust lookup. Every other mark name is still no route.
// It is public-route only: the internal route never served it.
//
// IMPORTS. Every collection route takes an optional `?from=<source blockId>`. A `from` naming the
// token's OWN app (its blockId) is an own call, exactly as if `from` were omitted: same access,
// rate bucket and response (`otherAppSource`). Any other `from` runs the call in that SOURCE app,
// as the same viewer, through an import the caller's manifest declares (`resolveImportAccess` in
// `doc-store-access.ts`). Such a call is first charged to the CONSUMER's read bucket for the
// viewer, before it is resolved. Everything after that — gates, budgets, rate limits, moderation,
// ceilings — reads the source's access, so it applies as the source.
import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { sessionClient } from '~/server/auth/session-client';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { dbRead } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import type { SessionUser } from '~/types/session';
import type {
  BlockScopedNextApiRequest,
  BlockScopeRefusal,
  BlockScopeRefusalKind,
} from '~/server/middleware/block-scope.middleware';
import {
  blockClaimsAppLabel,
  markBlockRequestReadMiss,
  recordAppStorageRequest,
  recordDocStoreError,
  recordDocStoreUnchangedWrite,
  type AppBlockRefusalBucket,
  type AppStorageVia,
  type DocStoreEndpoint,
} from '~/server/metrics/app-block-runtime.metrics';
import {
  blockSubjectUserId,
  recordAppBlockRateLimitRefusal,
} from '~/server/services/blocks/rate-limit-refusal.service';
import {
  hasLinkedOAuthAccount,
  sharedWriteTrustRefusal,
} from '~/server/services/blocks/block-write-trust.service';
import {
  assertCollection,
  assertShareWritable,
  PUBLISHED_NS,
  refuseViewerKeyed,
  type DocStore,
} from '~/server/services/apps/doc-store';
import {
  resolveImportAccess,
  resolveStorageAccess,
  type ImportOp,
  type StorageAccess,
} from '~/server/services/apps/doc-store-access';
import { getDocStore } from '~/server/services/apps/doc-store.instance';
import {
  shadowAppDataList,
  type AppDataShadowInput,
} from '~/server/services/apps/app-data-shadow.service';
import { gateHook } from '~/server/services/apps/doc-store-hook';
import { assertOwnedModelVersions } from '~/server/services/apps/doc-store-ownership';
import { validateDocAgainstCollectionSchema } from '~/server/services/apps/doc-store-schema';
import { resolveSchemaMajor } from '~/server/services/apps/doc-store-schema-major';
import type {
  DocAuthor,
  DocCollection,
  DocListQuery,
  DocRatingStatus,
  DocRecord,
  DocStoreErrorCode,
  WrittenDocRecord,
} from '~/server/services/apps/doc-store.types';
import { withDocLevelGate } from '~/server/services/apps/doc-levels';
import {
  isViewerKeyedWritable,
  VIEWER_KEYED_SEGMENT,
  viewerKeyedDocKey,
} from '~/server/services/apps/doc-store-viewer-keyed';
import {
  DOC_STORE_BOUNDS,
  DocStoreError,
  REPORT_MARK,
} from '~/server/services/apps/doc-store.types';
import {
  emitSharedBlockAlert,
  enforcedBlockingHit,
  recordSharedDataScan,
  resolveSharedDataModerationMode,
  scanCounterKey,
  scanSharedData,
  scheduleSharedDataShadow,
  sharedRefusalField,
  type SharedDataModerationMode,
  type SharedDataSurface,
  type SharedRefusalField,
  type SharedTextHit,
  type SharedTextScan,
} from '~/server/services/apps/shared-data-moderation';
import { collectSharedDataLeaves } from '~/server/services/apps/shared-data-leaves';
import {
  containsPrivateMediaUrl,
  valueContainsPrivateMediaUrl,
} from '~/server/services/apps/shared-private-media-urls';
import { syncStoreItem } from '~/server/services/blocks/app-sub-listing-sync';
import { resolveClientIp } from '~/server/utils/client-ip';
import { appRateLimitMeta, retryAfterSecondsOf } from '~/server/utils/app-rate-limit';
import { GENERIC_SERVER_ERROR_MESSAGE } from '~/server/utils/rest-error-envelope';
import type { RateLimitMeta } from '~/shared/utils/rate-limit-meta';
import {
  checkDocStoreRateLimit,
  DOC_STORE_PRIVATE_WRITE_RATE_LIMIT_MAX,
  DOC_STORE_READ_RATE_LIMIT_MAX,
  DOC_STORE_REPORT_RATE_LIMIT_MAX,
  DOC_STORE_SHARED_WRITE_BUDGET,
  reserveSharedWrite,
  type DocStoreRateBucket,
} from '~/server/utils/shared-storage-rate-limit';
import {
  APP_STORAGE_COLLECTION_NAME_RE,
  APP_STORAGE_PUBLISH_SCOPE,
  collectionNeedsPublishScope,
  type DeclaredStorageCollection,
} from '~/shared/constants/block-storage.constants';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Every literal path segment, and the one position each may occupy. */
const GET_MANY_SEGMENT = '_get';
/** The removed per-mark path's segment, kept for the report mark alias only. */
const MARKS_SEGMENT = 'marks';
export const STORAGE_RESERVED_SEGMENTS = [
  { segment: GET_MANY_SEGMENT, position: 0 },
  { segment: VIEWER_KEYED_SEGMENT, position: 1 },
] as const;

export type StorageRoute =
  | { op: 'info' }
  | { op: 'list' | 'create'; collection: string }
  | { op: 'getMany'; collection: string }
  | { op: 'get' | 'put' | 'delete'; collection: string; key: string }
  // The viewer's own document in a viewer-keyed collection; run as get / put / delete at the
  // derived key (`viewerKeyedRoute`). `parent` is the raw path segment, checked there.
  | { op: 'getMine' | 'putMine' | 'deleteMine'; collection: string; parent: string | null }
  // The report mark alias (`PUT`/`DELETE /:c/:key/marks/report`, see the header): a report filed
  // as the report API files it, and its refused withdrawal.
  | { op: 'reportMark' | 'unreportMark'; collection: string; key: string };

/** A route `run` executes. */
type OperationRoute = StorageRoute;

type Match = { route: StorageRoute } | { methods: string[] } | null;

/**
 * The route for a method and the path segments after `/storage`. `{ methods }` when the
 * path exists but not for this method; `null` when the path does not exist. Pure.
 */
export function matchStorageRoute(method: string, segments: readonly string[]): Match {
  const [a, b, c, d] = segments;
  const pick = (table: Record<string, StorageRoute>): Match =>
    table[method] ? { route: table[method] } : { methods: Object.keys(table) };
  const pickMine = (collection: string, parent: string | null): Match =>
    pick({
      GET: { op: 'getMine', collection, parent },
      PUT: { op: 'putMine', collection, parent },
      DELETE: { op: 'deleteMine', collection, parent },
    });
  switch (segments.length) {
    case 0:
      return pick({ GET: { op: 'info' } });
    case 1:
      if (a.startsWith('_')) return null;
      return pick({ GET: { op: 'list', collection: a }, POST: { op: 'create', collection: a } });
    case 2:
      if (a === GET_MANY_SEGMENT) return pick({ POST: { op: 'getMany', collection: b } });
      if (a.startsWith('_')) return null;
      if (b === VIEWER_KEYED_SEGMENT) return pickMine(a, null);
      return pick({
        GET: { op: 'get', collection: a, key: b },
        PUT: { op: 'put', collection: a, key: b },
        DELETE: { op: 'delete', collection: a, key: b },
      });
    case 3:
      if (a.startsWith('_') || b !== VIEWER_KEYED_SEGMENT) return null;
      return pickMine(a, c);
    case 4:
      // Only the `report` mark: every other mark name, and every counter, is no route.
      if (a.startsWith('_') || c !== MARKS_SEGMENT || d !== REPORT_MARK) return null;
      return pick({
        PUT: { op: 'reportMark', collection: a, key: b },
        DELETE: { op: 'unreportMark', collection: a, key: b },
      });
    default:
      return null;
  }
}

/** The metrics label for a request, from its method and path shape only. */
export function storageEndpointLabel(req: NextApiRequest): DocStoreEndpoint {
  const m = matchStorageRoute(req.method ?? 'GET', pathSegments(req));
  const op = m && 'route' in m ? m.route.op : 'info';
  if (op === 'info') return 'storage_info';
  if (op === 'reportMark' || op === 'unreportMark') return 'storage_report';
  if (op === 'list' || op === 'get' || op === 'getMany' || op === 'getMine') return 'storage_read';
  // create, put, delete, putMine, deleteMine.
  return 'storage_write';
}

function pathSegments(req: NextApiRequest): string[] {
  const raw = req.query.path;
  if (raw === undefined) return [];
  return Array.isArray(raw) ? raw : [raw];
}

// ---------------------------------------------------------------------------
// The error envelope — the ONE place a code becomes a status
// ---------------------------------------------------------------------------

export type StorageApiCode =
  | DocStoreErrorCode
  | 'internal_error'
  | 'method_not_allowed'
  /** The signed internal route refuses an import (`from` naming another app), before any write. */
  | 'not_supported_here'
  /** The signed internal route: the request named a schema `major` that is not the current one. */
  | 'stale_major';

export const STORAGE_ERROR_STATUS: Record<StorageApiCode, number> = {
  invalid_request: 400,
  index_not_declared: 400,
  schema_violation: 400,
  unauthenticated: 401,
  sign_in_required: 401,
  insufficient_scope: 403,
  consent_required: 403,
  import_not_declared: 403,
  not_exportable: 403,
  not_eligible: 403,
  not_author: 403,
  write_policy: 403,
  hook_rejected: 403,
  resource_not_owned: 403,
  not_found: 404,
  collection_not_declared: 404,
  version_conflict: 409,
  index_building: 409,
  cursor_expired: 410,
  removed: 410,
  too_large: 413,
  quota_exceeded: 413,
  content_rejected: 422,
  rate_limited: 429,
  storage_disabled: 503,
  moderation_unavailable: 503,
  hook_unavailable: 503,
  consent_unavailable: 503,
  service_unavailable: 503,
  internal_error: 500,
  method_not_allowed: 405,
  not_supported_here: 501,
  stale_major: 409,
};

export type StorageErrorBody = {
  code: StorageApiCode;
  message: string;
  /** The house envelope's legacy field; always the message here. */
  error: string;
  details?: Record<string, unknown>;
  /** On a 429 only: the house retry metadata (`rest-error-envelope.ts`), with `Retry-After`. */
  rateLimit?: RateLimitMeta;
};

/**
 * What the client is told for a store refusal whose own message describes the server (the
 * database role check); the detail stays in the store's log.
 */
const CLIENT_MESSAGE: Partial<Record<StorageApiCode, string>> = {
  storage_disabled: 'document storage is unavailable',
  // The store's connection-fault message names the driver error (`doc-store.ts`).
  service_unavailable: 'storage is temporarily unavailable',
};

export function envelope(code: StorageApiCode, message: string, details?: Record<string, unknown>) {
  const body: StorageErrorBody = { code, message, error: message };
  if (details) body.details = details;
  return body;
}

/**
 * Every error envelope this route sends leaves through here or `storageRefusalBody`, and both
 * count it in `civitai_app_block_doc_store_errors_total` under the envelope's own code.
 */
export function sendEnvelope(
  req: NextApiRequest,
  res: NextApiResponse,
  status: number,
  body: StorageErrorBody,
  endpoint: DocStoreEndpoint = storageEndpointLabel(req)
): void {
  recordDocStoreError(endpoint, body.code);
  res.status(status).json(body);
}

/** True for a document-store READ of a key that does not exist (see `sendError`). */
export function isDocumentReadMiss(req: NextApiRequest, code: StorageApiCode): boolean {
  return code === 'not_found' && storageEndpointLabel(req) === 'storage_read';
}

/** `endpoint`: the metrics label, for a route other than the storage catch-all (the report API). */
export function sendError(
  req: NextApiRequest,
  res: NextApiResponse,
  err: unknown,
  endpoint: DocStoreEndpoint = storageEndpointLabel(req)
): void {
  if (!(err instanceof DocStoreError)) {
    logToAxiom(
      {
        name: 'app-blocks-doc-store-route-fault',
        type: 'error',
        error: err instanceof Error ? err.name : typeof err,
        message: err instanceof Error ? err.message : String(err),
      },
      'app-blocks'
    );
    sendEnvelope(req, res, 500, envelope('internal_error', GENERIC_SERVER_ERROR_MESSAGE), endpoint);
    return;
  }
  const body = envelope(err.code, CLIENT_MESSAGE[err.code] ?? err.message, err.details);
  // A document GET for a key that does not exist yet is a READ MISS: an app's first read of a key
  // it has never written lands here by contract. Marked so the per-app REST counter reports it as
  // `result="not_found"` instead of `client_error`. On `storage_read` this code comes only from the
  // `get` op; the other `not_found` (an unmatched route) is labelled `storage_info` and stays an
  // error. The envelope itself, and `doc_store_errors_total{code="not_found"}`, are unchanged.
  if (isDocumentReadMiss(req, err.code)) markBlockRequestReadMiss(res);
  // Every refusal that names a retry delay (a 429, or a retryable 503) says so in the header.
  const retryAfter = err.details?.retryAfter;
  // Per-app attribution of the two refusals an app can loop on: a 429 (which limit) and a 409
  // version conflict (bucket `version_conflict` — not a rate limit, on the same counter so one
  // query answers "what is this app being refused"). Every document-store refusal leaves through
  // here, so this is the one place.
  if (err.code === 'rate_limited' || err.code === 'version_conflict') {
    recordRefusal(req, err, retryAfter, endpoint);
  }
  if (err.code === 'rate_limited') {
    // Every 429 carries the meta, a lock-timeout refusal with no delay of its own included.
    body.rateLimit = appRateLimitMeta('apps.doc-store', retryAfterSecondsOf(retryAfter, 1));
    res.setHeader('Retry-After', String(body.rateLimit.retryAfterSeconds));
  } else if (typeof retryAfter === 'number') {
    res.setHeader('Retry-After', String(retryAfter));
  }
  sendEnvelope(req, res, STORAGE_ERROR_STATUS[err.code], body, endpoint);
}

/**
 * Whether `app-blocks-storage-unchanged-writes-free` is on for the REQUESTING app: evaluated for
 * the block token's app block id — not the
 * resolved store context's app, which is the SOURCE app through an import. The free-write counter
 * is labelled with the same app (`requestAppLabel`). No claims, no flag.
 */
async function isUnchangedWriteFree(req: NextApiRequest): Promise<boolean> {
  const appBlockId = (req as BlockScopedNextApiRequest).blockClaims?.appBlockId;
  if (!appBlockId) return false;
  return isFlipt(FLIPT_FEATURE_FLAGS.APP_BLOCKS_STORAGE_UNCHANGED_WRITES_FREE, appBlockId);
}

/** The `app_block_id` label of the request's verified block claims (`other` without any). */
function requestAppLabel(req: NextApiRequest): string {
  const claims = (req as BlockScopedNextApiRequest).blockClaims;
  return claims ? blockClaimsAppLabel(claims) : 'other';
}

/** The `details.bucket` of every limiter refusal this route raises. */
type DocStoreRefusalBucket = DocStoreRateBucket | 'shared-write';
const DOC_STORE_REFUSAL_BUCKETS: ReadonlySet<string> = new Set<DocStoreRefusalBucket>([
  'read',
  'write',
  'report',
  'shared-write',
]);

/**
 * Every `rate_limited` this module raises is built here (pinned by the ledger test), so its
 * `details.bucket` — what the app receives in its 429, and the metric's `bucket` label — is always
 * one of `DocStoreRefusalBucket`. The store's own lock-timeout refusals carry `reason:
 * 'contention'` instead.
 */
function rateLimited(message: string, bucket: DocStoreRefusalBucket, retryAfter: number) {
  return new DocStoreError('rate_limited', message, { bucket, retryAfter });
}

function refusalBucket(err: DocStoreError): AppBlockRefusalBucket {
  if (err.code === 'version_conflict') return 'version_conflict';
  const bucket = err.details?.bucket;
  if (typeof bucket === 'string' && DOC_STORE_REFUSAL_BUCKETS.has(bucket)) {
    return bucket as DocStoreRefusalBucket;
  }
  return err.details?.reason === 'contention' ? 'contention' : 'unattributed';
}

function recordRefusal(
  req: NextApiRequest,
  err: DocStoreError,
  retryAfter: unknown,
  endpoint: DocStoreEndpoint
): void {
  const claims = (req as BlockScopedNextApiRequest).blockClaims;
  recordAppBlockRateLimitRefusal({
    appBlockId: requestAppLabel(req),
    surface: 'doc_store',
    bucket: refusalBucket(err),
    endpoint,
    retryAfterSeconds: typeof retryAfter === 'number' ? retryAfter : undefined,
    userId: claims ? blockSubjectUserId(claims.sub) : null,
    status: STORAGE_ERROR_STATUS[err.code],
  });
}

/**
 * The token middleware's refusals, in this route's envelope with stable storage codes, so a
 * client sees ONE shape whichever layer refused. The status stays the middleware's; each code
 * below maps to that same status in `STORAGE_ERROR_STATUS` (pinned by a test).
 */
const MIDDLEWARE_REFUSAL: Record<BlockScopeRefusalKind, { code: StorageApiCode; reason?: string }> =
  {
    invalid_token: { code: 'unauthenticated' },
    instance_revoked: { code: 'not_eligible', reason: 'instance_revoked' },
    permission_state_unavailable: { code: 'consent_unavailable' },
    consent_revoked: { code: 'consent_required' },
    app_not_approved: { code: 'not_eligible', reason: 'app_not_approved' },
    approval_unavailable: { code: 'service_unavailable' },
    insufficient_scope: { code: 'insufficient_scope' },
    context_binding: { code: 'not_eligible', reason: 'context_binding' },
  };

export function storageRefusalBody(
  refusal: BlockScopeRefusal,
  req: NextApiRequest,
  endpoint: DocStoreEndpoint = storageEndpointLabel(req)
): StorageErrorBody {
  const { code, reason } = MIDDLEWARE_REFUSAL[refusal.kind];
  // The middleware sends this body; it is counted here, the one place it is built.
  recordDocStoreError(endpoint, code);
  return envelope(code, refusal.error, reason ? { reason } : undefined);
}

const invalid = (message: string, details?: Record<string, unknown>) =>
  new DocStoreError('invalid_request', message, details);

// ---------------------------------------------------------------------------
// Request bodies and queries
// ---------------------------------------------------------------------------

const dataSchema = z.record(z.string(), z.unknown());
const putBody = z.strictObject({ data: dataSchema, ifVersion: z.number().optional() });
const createBody = z.strictObject({ data: dataSchema });
const getManyBody = z.strictObject({ keys: z.array(z.string()) });

/**
 * The largest request body read: one document at the store's own stored-size cap plus room for
 * the request wrapper around it (`{"data":…,"ifVersion":n}`, or a batch get's 100 keys). Next's
 * body parser is OFF for this route (see the page), so an oversized or malformed body is
 * answered here, in this route's envelope, after the token middleware has set CORS headers.
 */
export const STORAGE_BODY_LIMIT_BYTES = DOC_STORE_BOUNDS.docBytes + 16 * 1024;

/** The request body stopped arriving (the client disconnected). Answered quietly. */
class BodyAbortedError extends Error {}

/** Read and parse a JSON request body; `undefined` when there is none. Only POST and PUT. */
async function readJsonBody(req: NextApiRequest): Promise<unknown> {
  if (req.method !== 'POST' && req.method !== 'PUT') return undefined;
  const tooLarge = () =>
    new DocStoreError('too_large', `request body exceeds ${STORAGE_BODY_LIMIT_BYTES} bytes`, {
      limit: STORAGE_BODY_LIMIT_BYTES,
    });
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > STORAGE_BODY_LIMIT_BYTES) throw tooLarge();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of req as unknown as AsyncIterable<Buffer | string>) {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      size += buf.length;
      if (size > STORAGE_BODY_LIMIT_BYTES) throw tooLarge();
      chunks.push(buf);
    }
  } catch (err) {
    if (err instanceof DocStoreError) throw err;
    // The client went away mid-body (`aborted`, `ECONNRESET`): not a fault of ours.
    throw new BodyAbortedError();
  }
  if (size === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw invalid('request body is not valid JSON');
  }
}

export function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const value = body === undefined ? {} : body;
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw invalid('invalid request body', {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return parsed.data;
}

// The report mark alias's body: none, or `{}` (a mark never carried a payload).
const markBody = z.strictObject({});

const LIST_PARAMS = new Set(['sort', 'author', 'keyPrefix', 'limit', 'cursor']);
const WHERE_PARAM = /^where\[([^\]]+)\]$/;

/** `?where[f]=v&sort=…` → a store query. Unknown parameters are refused, not ignored. */
function parseListQuery(req: NextApiRequest, decl: DeclaredStorageCollection): DocListQuery {
  const q: DocListQuery = {};
  for (const [name, raw] of Object.entries(req.query)) {
    // The catch-all's own route parameter, and the import selector (read by the handler).
    if (name === 'path' || name === FROM_PARAM) continue;
    if (Array.isArray(raw) || raw === undefined) throw invalid(`${name} must be given once`);
    const where = WHERE_PARAM.exec(name);
    if (where) {
      q.where = { ...q.where, [where[1]]: whereValue(decl, where[1], raw) };
      continue;
    }
    if (!LIST_PARAMS.has(name)) throw invalid(`unknown query parameter ${name}`);
    if (name === 'limit') {
      if (!/^[0-9]{1,3}$/.test(raw)) throw invalid('limit must be an integer');
      q.limit = Number(raw);
    } else if (name === 'author') {
      if (raw !== 'me') throw invalid(`${name} must be "me"`);
      q.author = 'me';
    } else {
      q[name as 'sort' | 'keyPrefix' | 'cursor'] = raw;
    }
  }
  return q;
}

/** A query-string filter value, typed by the field's DECLARED index type. */
function whereValue(decl: DeclaredStorageCollection, field: string, raw: string) {
  switch (decl.indexes.get(field)) {
    case 'number': {
      const n = Number(raw);
      if (raw.trim() === '' || !Number.isFinite(n))
        throw invalid(`where[${field}] must be a number`);
      return n;
    }
    case 'boolean':
      if (raw !== 'true' && raw !== 'false') throw invalid(`where[${field}] must be true or false`);
      return raw === 'true';
    case 'time':
      return /^-?[0-9]+$/.test(raw) ? Number(raw) : raw;
    default:
      // string, or undeclared (the store answers index_not_declared)
      return raw;
  }
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

export type PresentedAuthor =
  | { kind: 'user'; isViewer: boolean; username?: string }
  | { kind: 'app' };

export type PresentedDoc = {
  key: string;
  data: Record<string, unknown>;
  version: number;
  /**
   * Content levels on only (`doc-levels.ts`): the effective level (NsfwLevel bit; the moderator's
   * override first) and the rating status, each null when unset. Server-set: nothing an app
   * writes reaches them. Absent while levels are off, so those responses are unchanged.
   */
  level?: number | null;
  ratingStatus?: DocRatingStatus | null;
  createdAt: string;
  updatedAt: string;
  author: PresentedAuthor;
  /**
   * 🔴 SDK COMPATIBILITY, NOT DATA. Counters, marks and their tallies were removed
   * (docs/app-storage-generic-core.md, rollout step 5), but `@civitai/sdk` up to 0.30 refuses a
   * document reply without `counters` and `marks` (each an object of numbers) and without
   * `viewer` (`null`, or `{ marks: string[] }`): `toDocument` throws "malformed". So every
   * document is sent with them EMPTY, on every collection, whatever its manifest declares:
   * `{}`, `{}`, and `{ marks: [] }` for a signed-in viewer (`null` for an anonymous one). Drop
   * them only once no supported SDK release reads them.
   */
  counters: Record<string, never>;
  marks: Record<string, never>;
  viewer: { marks: never[] } | null;
};

/**
 * Store records → wire documents. The store's `author.uid` is read here ONLY to look up a
 * username for a `showAuthor` collection, and is never copied to the output: every field of
 * `PresentedAuthor` is listed explicitly. `signedIn`: whether the request has a viewer, which
 * decides the compatibility `viewer` field (`PresentedDoc`).
 */
async function presentDocs(
  docs: readonly (DocRecord | null)[],
  decl: DeclaredStorageCollection,
  signedIn: boolean
): Promise<(PresentedDoc | null)[]> {
  const usernames = new Map<number, string>();
  if (decl.showAuthor) {
    const uids = [
      ...new Set(docs.flatMap((d) => (d && d.author.kind === 'user' ? [d.author.uid] : []))),
    ];
    if (uids.length > 0) {
      const rows = await dbRead.user.findMany({
        where: { id: { in: uids } },
        select: { id: true, username: true },
      });
      for (const r of rows) if (r.username) usernames.set(r.id, r.username);
    }
  }
  const author = (a: DocAuthor): PresentedAuthor => {
    if (a.kind !== 'user') return { kind: a.kind };
    const username = decl.showAuthor ? usernames.get(a.uid) : undefined;
    return { kind: 'user', isViewer: a.isViewer, ...(username ? { username } : {}) };
  };
  return docs.map((d) =>
    d
      ? {
          key: d.key,
          data: d.data,
          version: d.version,
          ...(d.rating ? { level: d.rating.level, ratingStatus: d.rating.status } : {}),
          createdAt: d.createdAt.toISOString(),
          updatedAt: d.updatedAt.toISOString(),
          author: author(d.author),
          counters: {},
          marks: {},
          viewer: signedIn ? { marks: [] } : null,
        }
      : null
  );
}

async function presentDoc(doc: DocRecord, decl: DeclaredStorageCollection, signedIn: boolean) {
  return (await presentDocs([doc], decl, signedIn))[0] as PresentedDoc;
}

/**
 * `open`: whether a viewer-keyed collection takes `@me` writes (`isViewerKeyedWritable`).
 * `counters` and `marks` are always empty, whatever the manifest declares: the store serves
 * neither (docs/app-storage-generic-core.md, rollout step 5); the SDK's `StorageCollectionInfo`
 * still types both as lists.
 */
function presentDeclaration(decl: DeclaredStorageCollection, open: boolean) {
  return {
    kind: decl.kind,
    visibility: decl.visibility,
    ...(decl.visibility === 'shared' ? { write: decl.write ?? 'own' } : {}),
    counters: [],
    marks: [],
    indexes: Object.fromEntries(decl.indexes),
    showAuthor: decl.showAuthor,
    ...(decl.keyedBy ? { keyedBy: decl.keyedBy, open } : {}),
  };
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

export function collectionOf(access: StorageAccess, name: string): DocCollection {
  const decl = APP_STORAGE_COLLECTION_NAME_RE.test(name) ? access.collections.get(name) : undefined;
  if (!decl) {
    throw new DocStoreError('collection_not_declared', `collection ${name} is not declared`, {
      collection: name,
    });
  }
  const coll = { name, config: decl };
  // A declared collection using a feature the store does not support yet is refused here, the
  // store's own way, before any budget, trust lookup or moderation is spent on it.
  assertCollection(coll);
  return coll;
}

/**
 * `coll` with the schema major a write of a document body is stamped with
 * (`DocCollection.schemaMajor`): the collection's current major in production, derived from the
 * app's manifest history; `null` when it cannot be. Development and review data are not stamped.
 */
async function withSchemaMajor(access: StorageAccess, coll: DocCollection): Promise<DocCollection> {
  if (access.ctx.ns !== PUBLISHED_NS) return coll;
  const schemaMajor = await resolveSchemaMajor({
    appBlockId: access.ctx.appId,
    head: access.enforcedManifest,
    collection: coll.name,
  });
  return { ...coll, schemaMajor };
}

export function requireViewer(access: StorageAccess): number {
  if (access.ctx.viewerUid === null) {
    throw new DocStoreError('sign_in_required', 'sign in required');
  }
  return access.ctx.viewerUid;
}

/**
 * Creating, editing or deleting a document other viewers read needs the consent-gated scope.
 * Through an import it is the viewer's grant in the SOURCE app (`resolveImportAccess`), and the
 * refusal names the source in `details.from`.
 */
function assertPublishScope(access: StorageAccess, coll: DocCollection): void {
  if (!collectionNeedsPublishScope(coll.config)) return;
  if (access.scopes.includes(APP_STORAGE_PUBLISH_SCOPE)) return;
  throw publishRefusal(access);
}

/**
 * A report on one of the SOURCE's shared collections, through an import: an authoring op there
 * (`importOpOf`), so it needs the viewer's publish consent in the source exactly as a create or
 * put does — whatever the collection's write policy. A report on the app's own documents needs
 * only `apps:storage`.
 */
function assertImportReportPublishScope(access: StorageAccess, shared: boolean): void {
  if (access.importedFrom === undefined || !shared) return;
  if (access.scopes.includes(APP_STORAGE_PUBLISH_SCOPE)) return;
  throw publishRefusal(access);
}

function publishRefusal(access: StorageAccess): DocStoreError {
  if (access.consentUnavailable) {
    return new DocStoreError('consent_unavailable', 'permission state is temporarily unavailable', {
      retryAfter: 1,
    });
  }
  return new DocStoreError(
    'consent_required',
    access.importedFrom === undefined
      ? `${APP_STORAGE_PUBLISH_SCOPE} has not been granted`
      : `${APP_STORAGE_PUBLISH_SCOPE} has not been granted in ${access.importedFrom}`,
    {
      scope: APP_STORAGE_PUBLISH_SCOPE,
      ...(access.importedFrom === undefined ? {} : { from: access.importedFrom }),
    }
  );
}

/** The min-trust gate, on every viewer write into a shared collection. Returns the subject. */
async function assertTrusted(uid: number): Promise<SessionUser> {
  const user = (await sessionClient.getSessionUserById(uid)) as SessionUser | null;
  const linked = user ? await hasLinkedOAuthAccount(user) : false;
  const refusal = sharedWriteTrustRefusal(user, linked);
  if (refusal) {
    throw new DocStoreError('not_eligible', refusal.message, { reason: refusal.reason });
  }
  return user as SessionUser;
}

/**
 * THE REPORT GATE of the report API (`doc-store-report-api.ts`), in this order: a signed-in viewer;
 * through an import, the viewer's publish consent in the source; the `report` bucket (a daily
 * budget); then, on a shared collection, the trust gate. Returns the viewer.
 */
export async function assertReportGate(
  access: StorageAccess,
  req: NextApiRequest,
  shared: boolean
): Promise<number> {
  const uid = requireViewer(access);
  assertImportReportPublishScope(access, shared);
  await charge('report', access, req);
  if (shared) await assertTrusted(uid);
  return uid;
}

/**
 * FILE ONE REPORT: the one code path behind the report API (`doc-store-report-api.ts`) and the
 * report mark alias (`PUT /:c/:key/marks/report`). `access` is the access the report runs with (the
 * source's, through an import) and `coll` its collection. In this order: a signed-in viewer; a
 * shared collection, refused `400 invalid_request` before any budget; the report gate
 * (`assertReportGate`); then the store's `report`, which writes the viewer's one report row (a
 * repeat adds none) on a document that exists and is not hidden, and is what the moderator queue
 * reads. No permission hook is asked: a hook must never silence a report.
 */
export async function fileReport(
  access: StorageAccess,
  coll: DocCollection,
  key: string,
  req: NextApiRequest,
  store: DocStore
): Promise<void> {
  requireViewer(access);
  if (coll.config.visibility !== 'shared') {
    throw new DocStoreError('invalid_request', 'reports exist on shared collections only');
  }
  await assertReportGate(access, req, true);
  await store.report(access.ctx, coll, key);
}

export async function charge(
  bucket: DocStoreRateBucket,
  access: StorageAccess,
  req: NextApiRequest
): Promise<void> {
  const uid = access.ctx.viewerUid;
  const principal = uid === null ? `ip:${resolveClientIp(req)}` : `u:${uid}`;
  const rl = await checkDocStoreRateLimit(bucket, access.ctx.appId, principal);
  if (!rl.allowed) throw rateLimited('rate limit exceeded', bucket, rl.retryAfterSeconds);
}

const COARSE_CATEGORY = { link: 'link', overflow: 'unreviewable' } as Record<string, string>;

/**
 * What `moderate` hands back: run it once the write has committed — with the stored key when the
 * store assigned it (a create); otherwise the key `moderate` was given is used.
 */
type AfterCommit = (committedKey?: string) => void;
const nothingAfterCommit: AfterCommit = () => undefined;

/** Where `input` carries an orchestrator media link, as a refusal names it, or null. */
function privateMediaField(input: {
  data?: Record<string, unknown>;
  key?: string;
}): SharedRefusalField | null {
  if (input.data !== undefined) {
    const collected = collectSharedDataLeaves(input.data);
    if ('overflow' in collected) {
      if (valueContainsPrivateMediaUrl(input.data)) return { field: 'data', fieldKind: 'value' };
    } else {
      const leaf = collected.leaves.find((l) => containsPrivateMediaUrl(l.raw));
      if (leaf) {
        const hit: SharedTextHit = {
          category: 'link',
          matched: 'private_media',
          label: 'private_media',
          leaf: { raw: leaf.raw, path: leaf.path, segments: leaf.segments, kind: leaf.kind },
        };
        const scan = { leafCount: collected.leaves.length, overflow: null, hits: [hit] };
        return sharedRefusalField(scan, hit, 'data');
      }
    }
  }
  if (input.key !== undefined && containsPrivateMediaUrl(input.key))
    return { field: 'key', fieldKind: 'value' };
  return null;
}

function refusePrivateMedia(
  access: StorageAccess,
  user: SessionUser,
  at: SharedRefusalField
): never {
  const field = at.field === 'key' ? 'key' : 'data';
  emitSharedBlockAlert(
    { appBlockId: access.ctx.appId, uid: user.id },
    { policy: 'link', category: 'link', field }
  );
  throw new DocStoreError('content_rejected', 'content was rejected by moderation', {
    category: 'link',
    ...at,
  });
}

/**
 * Moderation of one shared write — every string leaf and object key of `data` and, when the app
 * chose it, the document key — in the app's shared-data moderation mode
 * (`resolveSharedDataModerationMode`):
 *
 * - `off`: nothing is scanned or recorded; only an orchestrator media link is refused.
 * - `shadow`: nothing is scanned NOW. The returned `AfterCommit` schedules each scan through
 *   `scheduleSharedDataShadow`, the legacy surface's own shadow path: after the write, off the
 *   request path, recorded with mode `shadow`, never refusing, never alerting (except an
 *   orchestrator media link, refused as in `off`, with the scans still scheduled). A scanner failure
 *   is logged there and reaches nobody. The caller runs it only once the store has committed, so a
 *   write that fails records nothing.
 * - `enforce`: scanned inline, before the write. A scan that cannot run is refused as retryable
 *   (`moderation_unavailable`); a hit is refused (`content_rejected`) with a coarse category and
 *   the field it sits in (`sharedRefusalField`: a JSON path such as `data.actions[2].text`, or
 *   `key`), never the matched term or text, and raises the shared block alert.
 *
 * `resolvedMode`: the mode the caller already resolved for this app; omitted, it is resolved here.
 */
async function moderate(
  access: StorageAccess,
  user: SessionUser,
  surface: SharedDataSurface,
  rowKey: string,
  input: { data?: Record<string, unknown>; key?: string },
  resolvedMode?: SharedDataModerationMode
): Promise<AfterCommit> {
  const mode = resolvedMode ?? (await resolveSharedDataModerationMode(access.ctx.appId));
  // Refused in every mode; under `enforce` a minor/POI hit in the same write is refused and
  // recorded first.
  const privateMedia = privateMediaField(input);
  if (mode === 'off') {
    if (privateMedia) refusePrivateMedia(access, user, privateMedia);
    return nothingAfterCommit;
  }
  // Moderators are exempt from the pattern list here exactly as on the legacy surface.
  const scanOpts = { isModerator: user.isModerator };
  const scans: { field: 'data' | 'key'; run: () => Promise<SharedTextScan> }[] = [];
  if (input.data !== undefined) {
    const data = input.data;
    scans.push({ field: 'data', run: () => scanSharedData(data, scanOpts) });
  }
  if (input.key !== undefined) {
    const key = input.key;
    scans.push({ field: 'key', run: () => scanCounterKey(key, scanOpts) });
  }
  if (mode === 'shadow') {
    const schedule: AfterCommit = (committedKey = rowKey) => {
      for (const { run } of scans) {
        scheduleSharedDataShadow(run, {
          appBlockId: access.ctx.appId,
          rowKey: committedKey,
          surface,
        });
      }
    };
    if (privateMedia) {
      schedule();
      refusePrivateMedia(access, user, privateMedia);
    }
    return schedule;
  }
  for (const { field, run } of scans) {
    let scan: SharedTextScan;
    try {
      scan = await run();
    } catch (err) {
      logToAxiom(
        {
          name: 'app-blocks-doc-store-moderation-scan-failed',
          type: 'error',
          appBlockId: access.ctx.appId,
          error: err instanceof Error ? err.name : typeof err,
        },
        'block-audit'
      );
      throw new DocStoreError('moderation_unavailable', 'content could not be reviewed right now', {
        retryAfter: 5,
      });
    }
    const hit = await enforcedBlockingHit(scan);
    void recordSharedDataScan(scan, {
      appBlockId: access.ctx.appId,
      rowKey,
      surface,
      mode: 'enforce',
      blocked: hit != null,
    });
    if (hit) {
      emitSharedBlockAlert(
        { appBlockId: access.ctx.appId, uid: user.id },
        {
          policy: hit.category === 'audit_regex' ? 'audit' : hit.category,
          category: hit.category,
          field,
        }
      );
      throw new DocStoreError('content_rejected', 'content was rejected by moderation', {
        category: COARSE_CATEGORY[hit.category] ?? 'blocked',
        ...sharedRefusalField(scan, hit, field),
      });
    }
  }
  if (privateMedia) refusePrivateMedia(access, user, privateMedia);
  return nothingAfterCommit;
}

/**
 * Failures that are OUR fault, refunded without charging the caller's rejection bucket: the
 * store or a dependency was unavailable, the store timed out on a lock other writers held, or
 * anything that is not a `DocStoreError` at all. Every other refusal `fn` raises before the
 * write lands is charged as a rejection.
 *
 * ⚠️ THE DEFAULT IS THE OPPOSITE OF THE LEGACY SURFACE'S. `apps-shared.router.ts` refunds only
 * the statements it marks as plumbing (`asTransactionFault`: connection, BEGIN, COMMIT) and
 * charges a raw error from its INSERT/UPDATE, because a value can make those fail. Here a raw
 * error is refunded, which is sound only because the store validates a document fully before
 * any SQL runs and `translatePgError` (`doc-store.ts`) maps the one value-reachable database
 * error (the stored-size CHECK) to `too_large`, and connection faults to `service_unavailable`
 * (refunded above). A new constraint a value can violate must be
 * mapped there too, or every such failure becomes a free retry of the moderation scan.
 */
function isOurFault(err: unknown): boolean {
  if (!(err instanceof DocStoreError)) return true;
  if (err.code === 'rate_limited') return err.details?.reason === 'contention';
  // A permission hook that FAILED (threw, ran out of time or memory, returned something invalid)
  // is the app author's fault, not the viewer's: refunded like a fault of ours. A hook that
  // refused (`cause: 'denied'`) is an ordinary refusal and is charged as one.
  if (err.code === 'hook_rejected') return err.details?.cause !== 'denied';
  return (
    err.code === 'storage_disabled' ||
    // The store's database could not be reached (`translatePgError`), or a gate's read failed.
    err.code === 'service_unavailable' ||
    err.code === 'moderation_unavailable' ||
    err.code === 'consent_unavailable' ||
    // The permission hook could not be evaluated (`doc-store-hook.ts`): nothing was decided.
    err.code === 'hook_unavailable'
  );
}

/**
 * A shared document write spends the document store's shared write budget
 * (`DOC_STORE_SHARED_WRITE_BUDGET`, its own, not the legacy surface's): reserved before the
 * write and any inline moderation scan, and given back only if the write does not land. `fn`
 * calls `landed()` the moment the store has committed, so a failure after that (presenting the
 * result) spends the token like any landed write.
 */
async function withSharedWriteBudget<T>(
  access: StorageAccess,
  uid: number,
  fn: (landed: () => void) => Promise<T>
): Promise<T> {
  const reservation = await reserveSharedWrite(
    uid,
    access.ctx.appId,
    DOC_STORE_SHARED_WRITE_BUDGET
  );
  if (!reservation.allowed) {
    throw rateLimited(
      'shared write budget exhausted',
      'shared-write',
      reservation.retryAfterSeconds
    );
  }
  let hasLanded = false;
  try {
    return await fn(() => {
      hasLanded = true;
    });
  } catch (err) {
    if (!hasLanded) await reservation.release({ rejected: !isOurFault(err) });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

type Reply = { status: number; body: unknown };

type ViewerKeyedOp = Extract<StorageRoute, { op: 'getMine' | 'putMine' | 'deleteMine' }>;
/** A route `run`'s switch executes: a `@me` route is translated into a document route first. */
type DocRoute = Exclude<OperationRoute, { op: 'info' } | ViewerKeyedOp>;

const isViewerKeyedOp = (route: StorageRoute): route is ViewerKeyedOp =>
  route.op === 'getMine' || route.op === 'putMine' || route.op === 'deleteMine';

const VIEWER_KEYED_DOC_OP = { getMine: 'get', putMine: 'put', deleteMine: 'delete' } as const;

/**
 * VIEWER-KEYED DOCUMENTS (`doc-store-viewer-keyed.ts`). A `@me` route becomes exactly the get, put
 * or delete of the viewer's own document at the derived key, so every gate below applies to it as
 * to any document write; `keyed.parent` is what a write's content scan and hook see in place of
 * the derived key. A create, or a write by key, to a viewer-keyed collection is refused.
 */
async function viewerKeyedRoute(
  route: Exclude<OperationRoute, { op: 'info' }>,
  access: StorageAccess,
  coll: DocCollection
): Promise<{ route: DocRoute; keyed: { parent: string | null } | null }> {
  if (!isViewerKeyedOp(route)) {
    if (route.op === 'create' || route.op === 'put' || route.op === 'delete') {
      refuseViewerKeyed(coll, 'writing by key');
    }
    return { route, keyed: null };
  }
  const op = VIEWER_KEYED_DOC_OP[route.op];
  const key = await viewerKeyedDocKey({
    ctx: access.ctx,
    coll,
    parent: route.parent,
    write: op !== 'get',
  });
  return { route: { op, collection: route.collection, key }, keyed: { parent: route.parent } };
}

async function run(
  req: NextApiRequest,
  body: unknown,
  requested: OperationRoute,
  access: StorageAccess,
  store: DocStore,
  via: AppStorageVia
): Promise<Reply> {
  const { ctx } = access;
  const ok = (body: unknown, status = 200): Reply => ({ status, body });
  // The internal route's answers add where each write sits in the app namespace's write order
  // (WRITES-DESIGN.md, "Its answer adds what the overlay needs"); the public route's are unchanged.
  const service = via === 'service';
  // Info is signed-in only: its body carries the app-wide usage (documents, bytes) — the app's
  // SHARED documents, which is what `appBytes`/`appDocs` bound; private documents count toward
  // the viewer's own usage and `viewerBytes`/`viewerDocs` only (`DocStoreUsage`).
  // Every read is charged first, so a read of an undeclared collection is limited too.
  // Writes are charged below, once the collection says which bucket they spend.
  // Every `@me` op, reads included, is the signed-in viewer's own: anonymous is refused first.
  if (requested.op === 'info' || isViewerKeyedOp(requested)) requireViewer(access);
  if (
    requested.op === 'info' ||
    requested.op === 'list' ||
    requested.op === 'get' ||
    requested.op === 'getMany' ||
    requested.op === 'getMine'
  ) {
    await charge('read', access, req);
  }

  if (requested.op === 'info') {
    // The per-viewer figures are the ceiling the store charges this viewer's writes against
    // (`store.viewerLimits`: in production their membership tier's); the app ceilings are fixed.
    const [usage, viewerLimits] = await Promise.all([
      store.usage(ctx),
      store.viewerLimits(requireViewer(access)),
    ]);
    const L = store.limits;
    const collections = await Promise.all(
      [...access.collections].map(
        async ([name, decl]) =>
          [
            name,
            presentDeclaration(decl, decl.keyedBy ? await isViewerKeyedWritable(ctx, name) : false),
          ] as const
      )
    );
    return ok({
      collections: Object.fromEntries(collections),
      limits: {
        docBytes: DOC_STORE_BOUNDS.docBytes,
        appBytes: L.appBytes,
        appDocs: L.appDocs,
        viewerBytes: viewerLimits.userBytes,
        viewerDocs: viewerLimits.userDocs,
        listLimitMax: DOC_STORE_BOUNDS.listLimitMax,
        getManyMax: DOC_STORE_BOUNDS.getManyMax,
        rate: {
          readsPerMinute: DOC_STORE_READ_RATE_LIMIT_MAX,
          // The per-viewer `write` bucket: private writes, every DELETE, and — only while
          // `app-blocks-storage-unchanged-writes-free` is on for the app — every shared PUT,
          // changed or not (the field keeps its name).
          privateWritesPerMinute: DOC_STORE_PRIVATE_WRITE_RATE_LIMIT_MAX,
          // The marks-and-counters bucket is gone with marks and counters (rollout step 5). Kept at
          // 0, not dropped: every SDK from 0.14 to 0.31 types it as a required number.
          marksAndCountersPerMinute: 0,
          // The report API's daily budget (`assertReportGate`).
          reportsPerDay: DOC_STORE_REPORT_RATE_LIMIT_MAX,
          sharedWritesBurst: DOC_STORE_SHARED_WRITE_BUDGET.burst.capacity,
          sharedWritesPerDay: DOC_STORE_SHARED_WRITE_BUDGET.daily.capacity,
        },
      },
      usage,
    });
  }

  const coll = collectionOf(access, requested.collection);
  const decl = coll.config;
  const shared = decl.visibility === 'shared';
  const signedIn = ctx.viewerUid !== null;
  const { route, keyed } = await viewerKeyedRoute(requested, access, coll);
  const written = async (doc: WrittenDocRecord) => {
    const presented = await presentDoc(doc, decl, signedIn);
    return service ? { ...presented, seq: doc.seq, recordId: doc.recordId } : presented;
  };

  switch (route.op) {
    case 'reportMark': {
      // A mark carries no payload, `report` included: a body other than none or `{}` is refused.
      parseBody(markBody, body);
      await fileReport(access, coll, route.key, req, store);
      // The shape the `report` mark always answered (SDK `toMarkResult`): never a count.
      return ok({ marked: true });
    }
    case 'unreportMark':
      // As the removed route answered it: a report cannot be withdrawn (re-filing after a
      // moderator's dismissal would re-open it), refused before any budget or trust lookup.
      throw new DocStoreError('invalid_request', 'a report cannot be withdrawn', {
        mark: REPORT_MARK,
      });
    case 'list': {
      const query = parseListQuery(req, decl);
      const result = await store.list(ctx, coll, query);
      return ok({
        items: await presentDocs(result.items, decl, signedIn),
        nextCursor: result.nextCursor,
      });
    }
    case 'get': {
      const doc = await store.get(ctx, coll, route.key);
      if (!doc) throw new DocStoreError('not_found', 'document not found');
      return ok(await presentDoc(doc, decl, signedIn));
    }
    case 'getMany': {
      const { keys } = parseBody(getManyBody, body);
      const docs = await store.getMany(ctx, coll, keys);
      return ok({ items: await presentDocs(docs, decl, signedIn) });
    }
    case 'create':
    case 'put':
    case 'delete': {
      const uid = requireViewer(access);
      // The store's own write-policy rule, run before any budget or moderation is spent.
      assertShareWritable(coll);
      // DELETE needs only `apps:storage`: revoking the publish scope, or failing the trust gate,
      // never stops a viewer removing documents they authored (the store still requires the
      // viewer to be the author). Creating and updating need both.
      if (route.op !== 'delete') assertPublishScope(access, coll);
      // Parsed before any budget is reserved, so a malformed body is not charged.
      const created = route.op === 'create' ? parseBody(createBody, body) : null;
      const putIn = route.op === 'put' ? parseBody(putBody, body) : null;
      const deleteVersion = route.op === 'delete' ? deleteIfVersion(req) : undefined;
      // Every write that sets `data` (create and put are the only two), before the trust lookup,
      // the write budget and the moderation scan — the manifest schema documents a refusal as
      // spending no write budget and no scan.
      const newData = created?.data ?? putIn?.data;
      // The collection's schema first: the store checks it again itself (any caller), but here a
      // refusal also spends no ownership lookup. A put replaces the whole body, so `newData` IS
      // the resulting document.
      if (newData) validateDocAgainstCollectionSchema(ctx, coll, newData);
      if (newData) await assertOwnedModelVersions(decl, newData, uid);
      // The PERMISSION HOOK (`doc-store-hook.ts`): after every check above (the schema first), and
      // for a shared create or put inside the write reservation but before the moderation scan,
      // so a refusal spends no scan. Its pass pins the store write to the version it was shown.
      const writeOp = route.op;
      const writeKey = route.op === 'put' || route.op === 'delete' ? route.key : undefined;
      const decide = () =>
        gateHook({
          access,
          coll,
          store,
          op: writeOp,
          key: writeKey,
          after: newData,
          ifVersion: putIn?.ifVersion ?? deleteVersion,
          ...(keyed ? { parent: keyed.parent } : {}),
        });
      const write = async (user: SessionUser | null, landed: () => void): Promise<Reply> => {
        const grant = await decide();
        if (created) {
          const afterCommit = user
            ? await moderate(access, user, 'append', '', { data: created.data })
            : nothingAfterCommit;
          const doc = await store.create(ctx, await withSchemaMajor(access, coll), created.data, {
            key: grant?.key,
            hookPass: grant?.pass,
          });
          landed();
          afterCommit(doc.key);
          return ok(await written(doc), 201);
        }
        if (putIn && route.op === 'put') {
          const { data, ifVersion } = putIn;
          // A viewer-keyed document's key is a digest, not client text: only its parent is scanned.
          const scannedKey = keyed ? keyed.parent ?? undefined : route.key;
          const afterCommit = user
            ? await moderate(access, user, 'update', route.key, { data, key: scannedKey })
            : nothingAfterCommit;
          const doc = await store.put(ctx, await withSchemaMajor(access, coll), route.key, data, {
            ifVersion,
            hookPass: grant?.pass,
          });
          landed();
          afterCommit();
          return ok(await written(doc));
        }
        if (route.op !== 'delete') throw new Error('doc-store-api: unreachable write op');
        const result = await store.delete(ctx, coll, route.key, {
          ifVersion: deleteVersion,
          hookPass: grant?.pass,
        });
        // The author removed a published item: its App Store card follows. Production only: a
        // dev namespace's key is not the published item's.
        if (result.deleted && shared && ctx.ns === PUBLISHED_NS) {
          await syncStoreItem({
            appBlockId: ctx.appId,
            itemKey: route.key,
            change: 'withdrawn',
            authorUserId: uid,
          });
        }
        // `{ deleted }` only on the public route. The internal route adds the tombstone's `seq` and
        // the key it removed: for an `@me` delete that is the derived key, which app-data-go never
        // sent and needs to hide the document from its caches until the streams show the delete.
        if (service && result.deleted) {
          return ok({ deleted: true, seq: result.seq, key: route.key });
        }
        return ok({ deleted: result.deleted });
      };
      if (!shared || route.op === 'delete') {
        await charge('write', access, req);
        return write(null, () => undefined);
      }
      const user = await assertTrusted(uid);
      // A shared put that would change no stored row is free of the shared-write budget (FLAG:
      // `app-blocks-storage-unchanged-writes-free`, per app; off, this block is skipped). After
      // every check above, so it refuses exactly what any write does. Under the flag every shared
      // put first spends one `write` token (the per-viewer request bucket, never refunded), so a
      // loop of identical puts is still bounded. Then, when the store says the put would change
      // nothing (`putIfUnchanged`: `classifyPublish` plus the index rows), the
      // answer is the stored document as a write returns it — no shared-write token, no
      // moderation scan, nothing written — counted per app. Anything else (a change, a stale
      // `ifVersion`, another author's or a hidden document) takes the ordinary write below. A
      // create always writes a new key, so it is never unchanged.
      if (putIn && route.op === 'put' && (await isUnchangedWriteFree(req))) {
        await charge('write', access, req);
        const stored = await store.putIfUnchanged(ctx, coll, route.key, putIn.data, {
          ifVersion: putIn.ifVersion,
        });
        if (stored) {
          recordDocStoreUnchangedWrite(requestAppLabel(req));
          return ok(await written(stored));
        }
      }
      return withSharedWriteBudget(access, uid, (landed) => write(user, landed));
    }
  }
}

function deleteIfVersion(req: NextApiRequest): number | undefined {
  const raw = req.query.ifVersion;
  if (raw === undefined) return undefined;
  if (Array.isArray(raw) || !/^[0-9]{1,15}$/.test(raw)) {
    throw invalid('ifVersion must be a non-negative integer');
  }
  return Number(raw);
}

const FROM_PARAM = 'from';
/** The schema major a write names, on the internal route only (WRITES-DESIGN.md, D2). */
const MAJOR_PARAM = 'major';

/** The named `major`, or null when none is named. */
function namedMajorOf(req: NextApiRequest): number | null {
  const raw = req.query[MAJOR_PARAM];
  if (raw === undefined) return null;
  if (Array.isArray(raw) || !/^[1-9][0-9]{0,5}$/.test(raw)) {
    throw invalid(`${MAJOR_PARAM} must be a positive integer, given once`);
  }
  return Number(raw);
}

const noSuchRoute = () => new DocStoreError('not_found', 'no such storage route');

/** The import selector, or null. Only collection routes take one; `info` refuses it as stray. */
function importSourceOf(req: NextApiRequest): string | null {
  const raw = req.query[FROM_PARAM];
  if (raw === undefined) return null;
  if (Array.isArray(raw)) throw invalid(`${FROM_PARAM} must be given once`);
  return raw;
}

/**
 * The `from` of a call that reaches ANOTHER app, or null for an own call. `from` is an app's
 * blockId (`APP_STORAGE_IMPORT_FROM_RE`), and a `from` naming the token's own app (`own.blockId`,
 * the blockId the token was issued for) is an own call: identical to omitting it, with the same
 * access, scopes, rate bucket and response, for every token kind. An app never imports from itself
 * (the manifest validator and the read predicate both refuse it), so no import is lost. A caller
 * that always names its source (the shared app-data service's REST fallback) then reads the app it
 * names, whichever app the token is.
 */
export function otherAppSource(
  from: string | null,
  own: Pick<StorageAccess, 'blockId'>
): string | null {
  return from !== null && from === own.blockId ? null : from;
}

/**
 * What an operation does, for an import: a read; a delete; or an authoring write (create, put),
 * the only kind that can need the viewer's publish consent in the source.
 * Every one but a read is refused through a read-only import.
 */
function importOpOf(route: Exclude<StorageRoute, { op: 'info' }>): ImportOp {
  if (
    route.op === 'list' ||
    route.op === 'get' ||
    route.op === 'getMany' ||
    route.op === 'getMine'
  ) {
    return 'read';
  }
  return route.op === 'delete' || route.op === 'deleteMine' ? 'delete' : 'author';
}

/**
 * Query parameters other than the route's own are refused everywhere except a list. On the
 * internal route `info` also takes `from`: app-data-go names the app on every call, and the
 * handler refuses it unless it is the token's own (`otherAppSource`).
 */
function assertNoStrayQuery(req: NextApiRequest, route: StorageRoute, via: AppStorageVia): void {
  if (route.op === 'list') return;
  const own = route.op === 'delete' || route.op === 'deleteMine' ? ['path', 'ifVersion'] : ['path'];
  const allowed =
    route.op === 'info' && via === 'direct'
      ? own
      : via === 'service' && route.op !== 'info'
      ? [...own, FROM_PARAM, MAJOR_PARAM]
      : [...own, FROM_PARAM];
  const stray = Object.keys(req.query).find((k) => !allowed.includes(k));
  if (stray) throw invalid(`unknown query parameter ${stray}`);
}

// ---------------------------------------------------------------------------
// The handler
// ---------------------------------------------------------------------------

export type StorageApiDeps = {
  /** The store (default: the process store, `getDocStore`). */
  store?: () => DocStore;
  /**
   * Handed every list the route answered 200, after the response is sent (`app-data-shadow.service.ts`,
   * the shared app-data service's shadow read). Unset: the process shadow. It decides on its own
   * whether to read anything; whatever it does or throws, the response is already the store's.
   */
  shadow?: (input: AppDataShadowInput) => void;
  /**
   * The route this handler serves (`app_storage_requests_total{via}`). `direct`, the default: the
   * public route. `service`: the signed internal route app-data-go forwards to
   * (`doc-store-internal-route.ts`), which serves only `SERVICE_OPS`, refuses every import
   * `501 not_supported_here`, and answers each write's `seq` / `recordId`.
   */
  via?: AppStorageVia;
};

/**
 * What the internal route serves: the document writes and `info` (WRITES-DESIGN.md, "the write
 * verbs and info only"). Reads stay on the streams. The viewer-keyed writes (`putMine`,
 * `deleteMine`: `PUT`/`DELETE …/@me[/:parent]`) are writes like any other, and app-data-go
 * forwards them; `getMine` is a read and stays on the streams.
 */
const SERVICE_OPS: ReadonlySet<StorageRoute['op']> = new Set<StorageRoute['op']>([
  'info',
  'create',
  'put',
  'delete',
  'putMine',
  'deleteMine',
]);

/** A route match as the internal route sees it: any op it does not serve is no route at all. */
function servedMatch(req: NextApiRequest, match: Match, via: AppStorageVia): Match {
  if (via === 'direct' || !match) return match;
  if ('route' in match) return SERVICE_OPS.has(match.route.op) ? match : null;
  const segments = pathSegments(req);
  const methods = match.methods.filter((m) => {
    const other = matchStorageRoute(m, segments);
    return other !== null && 'route' in other && SERVICE_OPS.has(other.route.op);
  });
  return methods.length > 0 ? { methods } : null;
}

/**
 * The shadow's view of one list the route answered (`AppDataShadowInput`). `access` is the access
 * the list ran with, and `from` the import source after `otherAppSource` (null: the app's own).
 */
function appDataShadowInput(
  req: NextApiRequest,
  collection: string,
  from: string | null,
  access: StorageAccess,
  body: unknown
): AppDataShadowInput {
  const served = body as { items: { key: string; data: unknown }[]; nextCursor: string | null };
  const keyPrefix = req.query.keyPrefix;
  return {
    authorization: req.headers.authorization,
    own: from === null,
    published: access.ctx.ns === PUBLISHED_NS,
    tokenKind: access.tokenKind,
    signedIn: access.ctx.viewerUid !== null,
    visibility: access.collections.get(collection)?.visibility,
    queryKeys: Object.keys(req.query).filter((k) => k !== 'path' && k !== FROM_PARAM),
    keyPrefix: typeof keyPrefix === 'string' ? keyPrefix : undefined,
    appBlockId: access.ctx.appId,
    blockId: access.blockId,
    collection,
    head: access.enforcedManifest,
    served: { items: served.items, nextCursor: served.nextCursor ?? null },
  };
}

export function createStorageHandler(deps: StorageApiDeps = { store: getDocStore }) {
  const shadow = deps.shadow ?? shadowAppDataList;
  const via = deps.via ?? 'direct';
  const getStore = deps.store ?? getDocStore;
  return async function storageHandler(req: NextApiRequest, res: NextApiResponse) {
    try {
      const match = servedMatch(
        req,
        matchStorageRoute(req.method ?? 'GET', pathSegments(req)),
        via
      );
      if (!match) throw noSuchRoute();
      if ('methods' in match) {
        res.setHeader('Allow', match.methods.join(', '));
        sendEnvelope(
          req,
          res,
          STORAGE_ERROR_STATUS.method_not_allowed,
          envelope('method_not_allowed', 'method not allowed')
        );
        return;
      }
      const claims = (req as BlockScopedNextApiRequest).blockClaims;
      if (!claims) throw new DocStoreError('unauthenticated', 'a block token is required');
      assertNoStrayQuery(req, match.route, via);
      const own = await resolveStorageAccess(claims, {
        consentUnavailable: (req as BlockScopedNextApiRequest).blockConsentUnavailable === true,
      });
      const route = match.route;
      recordAppStorageRequest({
        app: blockClaimsAppLabel(claims),
        op: route.op,
        via,
        viewer: own.ctx.viewerUid === null ? 'signed_out' : 'signed_in',
        tokenKind: own.tokenKind,
      });
      const from =
        route.op === 'info' && via === 'direct' ? null : otherAppSource(importSourceOf(req), own);
      if (from !== null && via === 'service') {
        // Imports are not served through app-data-go yet (WRITES-DESIGN.md, "imports refused"):
        // only the site knows which app the token was issued for, so the site refuses them, before
        // anything is charged, read or written. Lifting this is a later turn-on with its own closing.
        sendEnvelope(
          req,
          res,
          STORAGE_ERROR_STATUS.not_supported_here,
          envelope('not_supported_here', 'imports are not served on this route')
        );
        return;
      }
      if (via === 'service' && route.op !== 'info') {
        // A write naming a schema major must name the collection's current one, the major the
        // store stamps (`withSchemaMajor`); none named means current. A collection with no
        // resolved major is at major 1 (apps/app-data-go/DESIGN.md), so a resolution failure can
        // only refuse a named major, never stamp a wrong one.
        const named = namedMajorOf(req);
        if (named !== null && own.ctx.ns === PUBLISHED_NS) {
          const current =
            (await resolveSchemaMajor({
              appBlockId: own.ctx.appId,
              head: own.enforcedManifest,
              collection: route.collection,
            })) ?? 1;
          if (current !== named) {
            sendEnvelope(
              req,
              res,
              STORAGE_ERROR_STATUS.stale_major,
              envelope('stale_major', 'the named schema major is not the current one', {
                currentMajor: current,
              })
            );
            return;
          }
        }
      }
      if (from !== null) await charge('read', own, req);
      const access =
        from === null || route.op === 'info'
          ? own
          : await resolveImportAccess(own, {
              from,
              collection: route.collection,
              op: importOpOf(route),
            });
      const body = await readJsonBody(req);
      const op: OperationRoute = route;
      // Content levels (`doc-levels.ts`): with the flag on for the app whose documents this
      // reaches, the store gates every shared read on the token's viewer level.
      const gated = await withDocLevelGate(access, claims);
      const reply = await run(req, body, op, gated, getStore(), via);
      res.status(reply.status).json(reply.body);
      if (op.op === 'list' && reply.status === 200) {
        // After the response: the shadow only compares, and nothing it does reaches the caller.
        try {
          shadow(appDataShadowInput(req, op.collection, from, gated, reply.body));
        } catch {
          // A shadow never affects the request.
        }
      }
    } catch (err) {
      if (err instanceof BodyAbortedError) {
        // A client abort is not a server fault: no error log, and nothing written to a
        // connection that is already gone. A still-open one gets a plain refusal.
        if (!req.destroyed && !res.destroyed && !res.writableEnded) {
          sendEnvelope(req, res, 400, envelope('invalid_request', 'request body was not received'));
        }
        return;
      }
      sendError(req, res, err);
    }
  };
}
