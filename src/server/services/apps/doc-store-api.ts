// The REST layer of the App Blocks document store: `/api/v1/blocks/storage/…`, served by
// one catch-all page (`src/pages/api/v1/blocks/storage/[[...path]].ts`). It resolves the
// caller (`doc-store-access.ts`), runs the gates the store leaves to its caller — scopes,
// consent, a collection's `ownedModelVersions` rule (`doc-store-ownership.ts`), the
// min-trust gate, rate limits, moderation — calls the store, and presents the
// result. Every refusal leaves through `sendError`, the one place a `DocStoreError` code
// becomes an HTTP status.
//
// PATHS. Collection names match `^[a-z][a-z0-9_]{0,31}$` and keys `[A-Za-z0-9._:-]{1,128}`,
// so a segment starting with `_` can never be a collection name. Every non-collection
// operation therefore sits at the COLLECTION position behind a leading `_`, and the fixed
// words `counters` / `marks` only ever appear as the third segment, after a key — a position
// where no collection or key is parsed (`STORAGE_RESERVED_SEGMENTS`, positions 0-based):
//   []                               GET    info
//   [c]                              GET    list            POST create
//   ['_get', c]                      POST   get many  { keys }
//   [c, key]                         GET    get     PUT put     DELETE delete
//   [c, key, 'counters', name]       POST   increment
//   [c, key, 'marks', name]          PUT    mark    DELETE unmark
// `_get` is a POST with a body (not a GET query) because 100 keys of 128 characters do not
// fit in a URL every proxy accepts.
import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { sessionClient } from '~/server/auth/session-client';
import { dbRead } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import type { SessionUser } from '~/types/session';
import type {
  BlockScopedNextApiRequest,
  BlockScopeRefusal,
  BlockScopeRefusalKind,
} from '~/server/middleware/block-scope.middleware';
import type { AppBlockEndpoint } from '~/server/metrics/app-block-runtime.metrics';
import {
  hasLinkedOAuthAccount,
  sharedWriteTrustRefusal,
} from '~/server/services/blocks/block-write-trust.service';
import {
  assertCollection,
  assertShareWritable,
  PUBLISHED_NS,
  refuseReportWithdrawal,
  type DocStore,
} from '~/server/services/apps/doc-store';
import { resolveStorageAccess, type StorageAccess } from '~/server/services/apps/doc-store-access';
import { getDocStore } from '~/server/services/apps/doc-store.instance';
import { assertOwnedModelVersions } from '~/server/services/apps/doc-store-ownership';
import type {
  DocAuthor,
  DocCollection,
  DocListQuery,
  DocRecord,
  DocStoreErrorCode,
} from '~/server/services/apps/doc-store.types';
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
  type SharedDataSurface,
  type SharedTextScan,
} from '~/server/services/apps/shared-data-moderation';
import { syncStoreItem } from '~/server/services/blocks/app-sub-listing-sync';
import { resolveClientIp } from '~/server/utils/client-ip';
import { rateLimitMetaFor } from '~/server/utils/rate-limit-error';
import { GENERIC_SERVER_ERROR_MESSAGE } from '~/server/utils/rest-error-envelope';
import type { RateLimitMeta } from '~/shared/utils/rate-limit-meta';
import {
  checkDocStoreRateLimit,
  DOC_STORE_PRIVATE_WRITE_RATE_LIMIT_MAX,
  DOC_STORE_READ_RATE_LIMIT_MAX,
  DOC_STORE_REPORT_RATE_LIMIT_MAX,
  DOC_STORE_TALLY_RATE_LIMIT_MAX,
  reserveSharedWrite,
  SHARED_WRITE_BUDGET,
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
const COUNTERS_SEGMENT = 'counters';
const MARKS_SEGMENT = 'marks';
export const STORAGE_RESERVED_SEGMENTS = [
  { segment: GET_MANY_SEGMENT, position: 0 },
  { segment: COUNTERS_SEGMENT, position: 2 },
  { segment: MARKS_SEGMENT, position: 2 },
] as const;

export type StorageRoute =
  | { op: 'info' }
  | { op: 'list' | 'create'; collection: string }
  | { op: 'getMany'; collection: string }
  | { op: 'get' | 'put' | 'delete'; collection: string; key: string }
  | { op: 'increment'; collection: string; key: string; name: string }
  | { op: 'mark' | 'unmark'; collection: string; key: string; name: string };

type Match = { route: StorageRoute } | { methods: string[] } | null;

/**
 * The route for a method and the path segments after `/storage`. `{ methods }` when the
 * path exists but not for this method; `null` when the path does not exist. Pure.
 */
export function matchStorageRoute(method: string, segments: readonly string[]): Match {
  const [a, b, c, d] = segments;
  const pick = (table: Record<string, StorageRoute>): Match =>
    table[method] ? { route: table[method] } : { methods: Object.keys(table) };
  switch (segments.length) {
    case 0:
      return pick({ GET: { op: 'info' } });
    case 1:
      if (a.startsWith('_')) return null;
      return pick({ GET: { op: 'list', collection: a }, POST: { op: 'create', collection: a } });
    case 2:
      if (a === GET_MANY_SEGMENT) return pick({ POST: { op: 'getMany', collection: b } });
      if (a.startsWith('_')) return null;
      return pick({
        GET: { op: 'get', collection: a, key: b },
        PUT: { op: 'put', collection: a, key: b },
        DELETE: { op: 'delete', collection: a, key: b },
      });
    case 4:
      if (a.startsWith('_')) return null;
      if (c === COUNTERS_SEGMENT) {
        return pick({ POST: { op: 'increment', collection: a, key: b, name: d } });
      }
      if (c === MARKS_SEGMENT) {
        return pick({
          PUT: { op: 'mark', collection: a, key: b, name: d },
          DELETE: { op: 'unmark', collection: a, key: b, name: d },
        });
      }
      return null;
    default:
      return null;
  }
}

/** The metrics label for a request, from its method and path shape only. */
export function storageEndpointLabel(req: NextApiRequest): AppBlockEndpoint {
  const m = matchStorageRoute(req.method ?? 'GET', pathSegments(req));
  const op = m && 'route' in m ? m.route.op : 'info';
  if (op === 'info') return 'storage_info';
  if (op === 'list' || op === 'get' || op === 'getMany') return 'storage_read';
  if (op === 'create' || op === 'put' || op === 'delete') return 'storage_write';
  return 'storage_tally';
}

function pathSegments(req: NextApiRequest): string[] {
  const raw = req.query.path;
  if (raw === undefined) return [];
  return Array.isArray(raw) ? raw : [raw];
}

// ---------------------------------------------------------------------------
// The error envelope — the ONE place a code becomes a status
// ---------------------------------------------------------------------------

export type StorageApiCode = DocStoreErrorCode | 'internal_error' | 'method_not_allowed';

export const STORAGE_ERROR_STATUS: Record<StorageApiCode, number> = {
  invalid_request: 400,
  index_not_declared: 400,
  unauthenticated: 401,
  sign_in_required: 401,
  insufficient_scope: 403,
  consent_required: 403,
  not_eligible: 403,
  not_author: 403,
  write_policy: 403,
  resource_not_owned: 403,
  not_found: 404,
  collection_not_declared: 404,
  version_conflict: 409,
  index_building: 409,
  cursor_expired: 410,
  too_large: 413,
  quota_exceeded: 413,
  content_rejected: 422,
  rate_limited: 429,
  storage_disabled: 503,
  moderation_unavailable: 503,
  consent_unavailable: 503,
  service_unavailable: 503,
  internal_error: 500,
  method_not_allowed: 405,
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
};

function envelope(code: StorageApiCode, message: string, details?: Record<string, unknown>) {
  const body: StorageErrorBody = { code, message, error: message };
  if (details) body.details = details;
  return body;
}

function sendError(res: NextApiResponse, err: unknown): void {
  if (!(err instanceof DocStoreError)) {
    logToAxiom(
      {
        name: 'app-blocks-doc-store-route-fault',
        type: 'error',
        error: err instanceof Error ? err.name : typeof err,
        message: err instanceof Error ? err.message : String(err),
      },
      'app-blocks'
    ).catch(() => undefined);
    res.status(500).json(envelope('internal_error', GENERIC_SERVER_ERROR_MESSAGE));
    return;
  }
  const body = envelope(err.code, CLIENT_MESSAGE[err.code] ?? err.message, err.details);
  // Every refusal that names a retry delay (a 429, or a retryable 503) says so in the header.
  const retryAfter = err.details?.retryAfter;
  if (typeof retryAfter === 'number') {
    res.setHeader('Retry-After', String(retryAfter));
    if (err.code === 'rate_limited') body.rateLimit = rateLimitMetaFor(retryAfter);
  }
  res.status(STORAGE_ERROR_STATUS[err.code]).json(body);
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

export function storageRefusalBody(refusal: BlockScopeRefusal): StorageErrorBody {
  const { code, reason } = MIDDLEWARE_REFUSAL[refusal.kind];
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
const incrementBody = z.strictObject({ by: z.number().optional() });
// A mark carries no payload; `report` included.
const markBody = z.strictObject({});

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

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const value = body === undefined ? {} : body;
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw invalid('invalid request body', {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return parsed.data;
}

const LIST_PARAMS = new Set(['sort', 'author', 'markedBy', 'mark', 'keyPrefix', 'limit', 'cursor']);
const WHERE_PARAM = /^where\[([^\]]+)\]$/;

/** `?where[f]=v&sort=…` → a store query. Unknown parameters are refused, not ignored. */
function parseListQuery(req: NextApiRequest, decl: DeclaredStorageCollection): DocListQuery {
  const q: DocListQuery = {};
  for (const [name, raw] of Object.entries(req.query)) {
    if (name === 'path') continue; // the catch-all's own route parameter
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
    } else if (name === 'author' || name === 'markedBy') {
      if (raw !== 'me') throw invalid(`${name} must be "me"`);
      q[name] = 'me';
    } else {
      q[name as 'sort' | 'mark' | 'keyPrefix' | 'cursor'] = raw;
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
  | { kind: 'app' }
  | { kind: 'counter' };

export type PresentedDoc = {
  key: string;
  data: Record<string, unknown>;
  version: number;
  createdAt: string;
  updatedAt: string;
  author: PresentedAuthor;
  counters: Record<string, number>;
  marks: Record<string, number>;
  viewer: { marks: string[] } | null;
};

/**
 * Store records → wire documents. The store's `author.uid` is read here ONLY to look up a
 * username for a `showAuthor` collection, and is never copied to the output: every field of
 * `PresentedAuthor` is listed explicitly.
 */
async function presentDocs(
  docs: readonly (DocRecord | null)[],
  decl: DeclaredStorageCollection
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
          createdAt: d.createdAt.toISOString(),
          updatedAt: d.updatedAt.toISOString(),
          author: author(d.author),
          counters: d.counters,
          marks: d.marks,
          viewer: d.viewer,
        }
      : null
  );
}

async function presentDoc(doc: DocRecord, decl: DeclaredStorageCollection) {
  return (await presentDocs([doc], decl))[0] as PresentedDoc;
}

function presentDeclaration(decl: DeclaredStorageCollection) {
  return {
    kind: decl.kind,
    visibility: decl.visibility,
    ...(decl.visibility === 'shared' ? { write: decl.write ?? 'own' } : {}),
    counters: [...decl.counters],
    marks: [...decl.marks],
    indexes: Object.fromEntries(decl.indexes),
    showAuthor: decl.showAuthor,
  };
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

function collectionOf(access: StorageAccess, name: string): DocCollection {
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

function requireViewer(access: StorageAccess): number {
  if (access.ctx.viewerUid === null) {
    throw new DocStoreError('sign_in_required', 'sign in required');
  }
  return access.ctx.viewerUid;
}

/** Creating, editing or deleting a document other viewers read needs the consent-gated scope. */
function assertPublishScope(access: StorageAccess, coll: DocCollection): void {
  if (!collectionNeedsPublishScope(coll.config)) return;
  if (access.scopes.includes(APP_STORAGE_PUBLISH_SCOPE)) return;
  if (access.consentUnavailable) {
    throw new DocStoreError('consent_unavailable', 'permission state is temporarily unavailable', {
      retryAfter: 1,
    });
  }
  throw new DocStoreError('consent_required', `${APP_STORAGE_PUBLISH_SCOPE} has not been granted`, {
    scope: APP_STORAGE_PUBLISH_SCOPE,
  });
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

async function charge(
  bucket: DocStoreRateBucket,
  access: StorageAccess,
  req: NextApiRequest
): Promise<void> {
  const uid = access.ctx.viewerUid;
  const principal = uid === null ? `ip:${resolveClientIp(req)}` : `u:${uid}`;
  const rl = await checkDocStoreRateLimit(bucket, access.ctx.appId, principal);
  if (!rl.allowed) {
    throw new DocStoreError('rate_limited', 'rate limit exceeded', {
      bucket,
      retryAfter: rl.retryAfterSeconds,
    });
  }
}

const COARSE_CATEGORY = { link: 'link', overflow: 'unreviewable' } as Record<string, string>;

/**
 * What `moderate` hands back: run it once the write has committed — with the stored key when the
 * store assigned it (a create); otherwise the key `moderate` was given is used.
 */
type AfterCommit = (committedKey?: string) => void;
const nothingAfterCommit: AfterCommit = () => undefined;

/**
 * Moderation of one shared write — every string leaf and object key of `data` and, when the app
 * chose it, the document key — in the app's shared-data moderation mode
 * (`resolveSharedDataModerationMode`):
 *
 * - `off`: nothing is scanned or recorded.
 * - `shadow`: nothing is scanned NOW. The returned `AfterCommit` schedules each scan through
 *   `scheduleSharedDataShadow`, the legacy surface's own shadow path: after the write, off the
 *   request path, recorded with mode `shadow`, never refusing, never alerting. A scanner failure
 *   is logged there and reaches nobody. The caller runs it only once the store has committed, so a
 *   write that fails records nothing.
 * - `enforce`: scanned inline, before the write. A scan that cannot run is refused as retryable
 *   (`moderation_unavailable`); a hit is refused (`content_rejected`) with a coarse category,
 *   never the matched text, and raises the shared block alert.
 */
async function moderate(
  access: StorageAccess,
  user: SessionUser,
  surface: SharedDataSurface,
  rowKey: string,
  input: { data?: Record<string, unknown>; key?: string }
): Promise<AfterCommit> {
  const mode = await resolveSharedDataModerationMode(access.ctx.appId);
  if (mode === 'off') return nothingAfterCommit;
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
    return (committedKey = rowKey) => {
      for (const { run } of scans) {
        scheduleSharedDataShadow(run, {
          appBlockId: access.ctx.appId,
          rowKey: committedKey,
          surface,
        });
      }
    };
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
      ).catch(() => undefined);
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
      });
    }
  }
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
 * error (the stored-size CHECK) to `too_large`. A new constraint a value can violate must be
 * mapped there too, or every such failure becomes a free retry of the moderation scan.
 */
function isOurFault(err: unknown): boolean {
  if (!(err instanceof DocStoreError)) return true;
  if (err.code === 'rate_limited') return err.details?.reason === 'contention';
  return (
    err.code === 'storage_disabled' ||
    err.code === 'moderation_unavailable' ||
    err.code === 'consent_unavailable'
  );
}

/**
 * A shared document write spends the shared write budget: reserved before the write and any
 * inline moderation scan, and given back only if the write does not land. `fn` calls `landed()`
 * the moment the store has committed, so a failure after that (presenting the result) spends the
 * token like any landed write.
 */
async function withSharedWriteBudget<T>(
  access: StorageAccess,
  uid: number,
  fn: (landed: () => void) => Promise<T>
): Promise<T> {
  const reservation = await reserveSharedWrite(uid, access.ctx.appId);
  if (!reservation.allowed) {
    throw new DocStoreError('rate_limited', 'shared write budget exhausted', {
      bucket: 'shared-write',
      retryAfter: reservation.retryAfterSeconds,
    });
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

async function run(
  req: NextApiRequest,
  body: unknown,
  route: StorageRoute,
  access: StorageAccess,
  store: DocStore
): Promise<Reply> {
  const { ctx } = access;
  const ok = (body: unknown, status = 200): Reply => ({ status, body });
  // Info is signed-in only: its body carries the app-wide usage (documents, bytes).
  // Every read is charged first, so a read of an undeclared collection is limited too.
  // Writes are charged below, once the collection says which bucket they spend.
  if (route.op === 'info') requireViewer(access);
  if (route.op === 'info' || route.op === 'list' || route.op === 'get' || route.op === 'getMany') {
    await charge('read', access, req);
  }

  if (route.op === 'info') {
    const usage = await store.usage(ctx);
    const L = store.limits;
    return ok({
      collections: Object.fromEntries(
        [...access.collections].map(([name, decl]) => [name, presentDeclaration(decl)])
      ),
      limits: {
        docBytes: DOC_STORE_BOUNDS.docBytes,
        appBytes: L.appBytes,
        appDocs: L.appDocs,
        viewerBytes: L.userBytes,
        viewerDocs: L.userDocs,
        listLimitMax: DOC_STORE_BOUNDS.listLimitMax,
        getManyMax: DOC_STORE_BOUNDS.getManyMax,
        rate: {
          readsPerMinute: DOC_STORE_READ_RATE_LIMIT_MAX,
          privateWritesPerMinute: DOC_STORE_PRIVATE_WRITE_RATE_LIMIT_MAX,
          marksAndCountersPerMinute: DOC_STORE_TALLY_RATE_LIMIT_MAX,
          reportsPerDay: DOC_STORE_REPORT_RATE_LIMIT_MAX,
          sharedWritesBurst: SHARED_WRITE_BUDGET.burst.capacity,
          sharedWritesPerDay: SHARED_WRITE_BUDGET.daily.capacity,
        },
      },
      usage,
    });
  }

  const coll = collectionOf(access, route.collection);
  const decl = coll.config;
  const shared = decl.visibility === 'shared';

  switch (route.op) {
    case 'list': {
      const query = parseListQuery(req, decl);
      const result = await store.list(ctx, coll, query);
      return ok({ items: await presentDocs(result.items, decl), nextCursor: result.nextCursor });
    }
    case 'get': {
      const doc = await store.get(ctx, coll, route.key);
      if (!doc) throw new DocStoreError('not_found', 'document not found');
      return ok(await presentDoc(doc, decl));
    }
    case 'getMany': {
      const { keys } = parseBody(getManyBody, body);
      const docs = await store.getMany(ctx, coll, keys);
      return ok({ items: await presentDocs(docs, decl) });
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
      if (newData) await assertOwnedModelVersions(decl, newData, uid);
      const write = async (user: SessionUser | null, landed: () => void): Promise<Reply> => {
        if (created) {
          const afterCommit = user
            ? await moderate(access, user, 'append', '', { data: created.data })
            : nothingAfterCommit;
          const doc = await store.create(ctx, coll, created.data);
          landed();
          afterCommit(doc.key);
          return ok(await presentDoc(doc, decl), 201);
        }
        if (putIn && route.op === 'put') {
          const { data, ifVersion } = putIn;
          const afterCommit = user
            ? await moderate(access, user, 'update', route.key, { data, key: route.key })
            : nothingAfterCommit;
          const doc = await store.put(ctx, coll, route.key, data, { ifVersion });
          landed();
          afterCommit();
          return ok(await presentDoc(doc, decl));
        }
        if (route.op !== 'delete') throw new Error('doc-store-api: unreachable write op');
        const result = await store.delete(ctx, coll, route.key, { ifVersion: deleteVersion });
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
        return ok(result);
      };
      if (!shared || route.op === 'delete') {
        await charge('write', access, req);
        return write(null, () => undefined);
      }
      const user = await assertTrusted(uid);
      return withSharedWriteBudget(access, uid, (landed) => write(user, landed));
    }
    case 'increment': {
      const uid = requireViewer(access);
      const { by } = parseBody(incrementBody, body);
      // The bucket first: a refused request costs no subject lookup.
      await charge('tally', access, req);
      const user = shared ? await assertTrusted(uid) : null;
      // Under `write: 'none'` an increment can CREATE a public document under the app's key. The
      // store does not say whether this one did, so the key is scanned on every such increment.
      const afterCommit =
        user && decl.write === 'none'
          ? await moderate(access, user, 'counter', route.key, { key: route.key })
          : nothingAfterCommit;
      const counted = await store.increment(ctx, coll, route.key, route.name, by);
      afterCommit();
      return ok(counted);
    }
    case 'mark':
    case 'unmark': {
      // Before any budget or trust lookup: a withdrawal is a 400 for everyone.
      if (route.op === 'unmark') refuseReportWithdrawal(route.name);
      const uid = requireViewer(access);
      if (route.op === 'mark') parseBody(markBody, body);
      await charge('tally', access, req);
      if (route.op === 'mark' && route.name === REPORT_MARK) await charge('report', access, req);
      if (shared) await assertTrusted(uid);
      const result =
        route.op === 'mark'
          ? await store.mark(ctx, coll, route.key, route.name)
          : await store.unmark(ctx, coll, route.key, route.name);
      // A report count is never exposed.
      return ok(
        route.name === REPORT_MARK
          ? { marked: result.marked }
          : { marked: result.marked, count: result.count }
      );
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

/** Query parameters other than the route's own are refused everywhere except a list. */
function assertNoStrayQuery(req: NextApiRequest, route: StorageRoute): void {
  if (route.op === 'list') return;
  const allowed = route.op === 'delete' ? ['path', 'ifVersion'] : ['path'];
  const stray = Object.keys(req.query).find((k) => !allowed.includes(k));
  if (stray) throw invalid(`unknown query parameter ${stray}`);
}

// ---------------------------------------------------------------------------
// The handler
// ---------------------------------------------------------------------------

export type StorageApiDeps = { store: () => DocStore };

export function createStorageHandler(deps: StorageApiDeps = { store: getDocStore }) {
  return async function storageHandler(req: NextApiRequest, res: NextApiResponse) {
    try {
      const match = matchStorageRoute(req.method ?? 'GET', pathSegments(req));
      if (!match) throw new DocStoreError('not_found', 'no such storage route');
      if ('methods' in match) {
        res.setHeader('Allow', match.methods.join(', '));
        res
          .status(STORAGE_ERROR_STATUS.method_not_allowed)
          .json(envelope('method_not_allowed', 'method not allowed'));
        return;
      }
      const claims = (req as BlockScopedNextApiRequest).blockClaims;
      if (!claims) throw new DocStoreError('unauthenticated', 'a block token is required');
      assertNoStrayQuery(req, match.route);
      const access = await resolveStorageAccess(claims, {
        consentUnavailable: (req as BlockScopedNextApiRequest).blockConsentUnavailable === true,
      });
      const body = await readJsonBody(req);
      const reply = await run(req, body, match.route, access, deps.store());
      res.status(reply.status).json(reply.body);
    } catch (err) {
      if (err instanceof BodyAbortedError) {
        // A client abort is not a server fault: no error log, and nothing written to a
        // connection that is already gone. A still-open one gets a plain refusal.
        if (!req.destroyed && !res.destroyed && !res.writableEnded) {
          res.status(400).json(envelope('invalid_request', 'request body was not received'));
        }
        return;
      }
      sendError(res, err);
    }
  };
}
