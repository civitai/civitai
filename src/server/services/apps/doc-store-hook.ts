// App Storage PERMISSION HOOKS on the write path: the gate every viewer write to a collection
// with a `hook` passes through, and the client of the storage-hook-runner service that evaluates
// the hook (apps/storage-hook-runner, whose README "Contract" section is the wire contract).
//
// WHERE IT RUNS (`doc-store-api.ts`): after the collection's schema check, the ownership rule and
// the trust gate, and for a shared create or put INSIDE the shared-write reservation but before
// the moderation scan, so a refusal spends no scan. Never inside the store's write transaction:
// the gate reads the document (`store.get`, its own short transaction), asks the runner, and the
// store then writes in a new transaction pinned to the version the hook was shown.
//
// WHAT IT GUARANTEES:
//   - Every write op (create, put, delete, increment, mark, unmark) is decided by the hook, except
//     the `report` mark: a hook must never silence moderation reports.
//   - FAIL CLOSED. A runner that is unconfigured, unreachable, slow past the client timeout,
//     answers non-2xx, or answers anything whose signature, request digest or timestamp does not
//     verify, a hook source that cannot be loaded by its sha256, and the per-app runner-offline
//     flag all refuse the write as `hook_unavailable` (503, retry after 5 s). There is NO flag or
//     setting that skips a declared hook.
//   - The write that follows is the write the hook saw: the store refuses a hooked write without a
//     HookPass for exactly that (app, namespace, collection, key, op), and writes only at the
//     pass's document version (`doc-store-hook-pass.ts`), so a change in between is a
//     `version_conflict`.
//   - On a `?from=` import the access is the SOURCE app's (`resolveImportAccess`), so its
//     collections, and therefore their hooks, come from the source's approved manifest. The hook
//     is told the importing app as `from`.
//
// WHAT A HOOK IS SHOWN: the op, collection, key (pre-generated for a create), the stored data
// before and the data after (null where there is none), the stored document's metadata (version,
// author kind and whether the viewer is its author, counters, marks: never another user's id),
// the tally for a counter or mark, the viewer's user id, the app's blockId and the importer's.
// The counters it sees are a snapshot: tallies do not move the version, so they are not pinned.
import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { env } from '~/env/server';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { logToAxiom } from '~/server/logging/client';
import {
  recordStorageHookCall,
  type StorageHookCallOutcome,
} from '~/server/metrics/app-block-runtime.metrics';
import type { DocStore } from '~/server/services/apps/doc-store';
import type { StorageAccess } from '~/server/services/apps/doc-store-access';
import {
  mintHookPass,
  type HookOp,
  type HookPass,
} from '~/server/services/apps/doc-store-hook-pass';
import type { DocCollection, DocRecord } from '~/server/services/apps/doc-store.types';
import { DocStoreError, REPORT_MARK } from '~/server/services/apps/doc-store.types';
import { newUlid } from '~/server/utils/app-block-ids';
import {
  APP_STORAGE_HOOK_TIMEOUT_DEFAULT_MS,
  APP_STORAGE_HOOK_TIMEOUT_MAX_MS,
  APP_STORAGE_HOOK_TIMEOUT_MIN_MS,
  type DeclaredStorageHook,
} from '~/shared/constants/block-storage.constants';

export type { HookOp, HookPass };

// ---------------------------------------------------------------------------
// The runner contract (apps/storage-hook-runner/README.md, "Contract")
// ---------------------------------------------------------------------------

/** The runner's request/response signature header. */
export const HOOK_RUNNER_SIG_HEADER = 'x-storage-hook-sig';
/** Clock skew accepted on a response's signed `ts`, as the runner accepts on a request's. */
export const HOOK_RUNNER_SIG_SKEW_SECONDS = 60;
/**
 * The runner's worker backstop: a call still running `timeoutMs` + this after it reached a worker
 * is terminated and answered 500. Mirrors `BACKSTOP_MS` in the runner's `src/limits.ts` (the seam
 * test pins the two equal).
 */
export const HOOK_RUNNER_BACKSTOP_MS = 100;
/** Time a call may wait in the runner's queue behind other calls before a worker takes it. */
export const HOOK_RUNNER_QUEUE_ALLOWANCE_MS = 250;
/** The in-cluster network round trip, connection set-up and body transfer included. */
export const HOOK_RUNNER_NETWORK_ALLOWANCE_MS = 100;
/** `retryAfter` on a `hook_unavailable` refusal. */
export const HOOK_UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

/** The runner's `timeoutMs` clamp, which the manifest parser already enforces. */
export function clampHookTimeoutMs(ms: number | undefined): number {
  if (ms === undefined || !Number.isFinite(ms)) return APP_STORAGE_HOOK_TIMEOUT_DEFAULT_MS;
  return Math.min(
    APP_STORAGE_HOOK_TIMEOUT_MAX_MS,
    Math.max(APP_STORAGE_HOOK_TIMEOUT_MIN_MS, Math.round(ms))
  );
}

/**
 * The client's HTTP timeout for one call, sized as the runner README says: NOT just `timeoutMs`.
 * The runner's own answer can take `timeoutMs` + its backstop (which also caps the compile
 * allowance it adds to the deadline) once a worker has the call, plus the time the call queued
 * before that, plus the network. A client timeout shorter than that turns a slow but healthy
 * evaluation into `hook_unavailable`.
 */
export function hookClientTimeoutMs(timeoutMs: number | undefined): number {
  return (
    clampHookTimeoutMs(timeoutMs) +
    HOOK_RUNNER_BACKSTOP_MS +
    HOOK_RUNNER_QUEUE_ALLOWANCE_MS +
    HOOK_RUNNER_NETWORK_ALLOWANCE_MS
  );
}

export type HookTally =
  | { kind: 'counter'; name: string; by: number }
  | { kind: 'mark'; name: string };

/** The hook's single argument (`HookInput` in the runner's `src/contract.ts`). */
export type HookInput = {
  op: HookOp;
  collection: string;
  key: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  doc: {
    version: number;
    author: { kind: 'user'; isViewer: boolean } | { kind: 'app' } | { kind: 'counter' };
    counters: Record<string, number>;
    marks: Record<string, number>;
  } | null;
  tally: HookTally | null;
  viewer: { userId: number };
  app: { blockId: string };
  from: string | null;
};

export type HookRunnerCall = {
  /** The hook owner's blockId. */
  appId: string;
  collection: string;
  op: HookOp;
  sha256: string;
  source: string;
  timeoutMs: number;
  input: HookInput;
};

export const HOOK_AUTHOR_FAULT_CAUSES = [
  'error',
  'timeout',
  'oom',
  'stack_overflow',
  'invalid_result',
] as const;
export type HookAuthorFaultCause = (typeof HOOK_AUTHOR_FAULT_CAUSES)[number];

/** What one runner call decided, as the write path reads it. */
export type HookVerdict =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'author_fault'; cause: HookAuthorFaultCause }
  /** No trustworthy answer; `why` is for the log only. */
  | { kind: 'unavailable'; why: string };

export type HookRunnerConfig = { url: string; secret: string };

/** The runner's URL and secret from the environment, or null when either is unset or blank. */
export function hookRunnerConfig(): HookRunnerConfig | null {
  const url = (env.STORAGE_HOOK_RUNNER_URL ?? '').trim();
  const secret = (env.STORAGE_HOOK_RUNNER_SECRET ?? '').trim();
  if (!url || secret.length < 32) return null;
  return { url: url.replace(/\/+$/, ''), secret };
}

const sha256Hex = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const hmacHex = (secret: string, body: string | Buffer) =>
  createHmac('sha256', secret).update(body).digest('hex');

function signatureMatches(secret: string, body: Buffer, header: string | null): boolean {
  if (typeof header !== 'string' || !/^[0-9a-f]{64}$/.test(header)) return false;
  const expected = Buffer.from(hmacHex(secret, body), 'hex');
  const provided = Buffer.from(header, 'hex');
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

const REASON_MAX_CODE_POINTS = 200;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A verified 200 body's `result`, read strictly; anything else is not an answer. */
function readResult(result: unknown): HookVerdict {
  if (!isObj(result)) return { kind: 'unavailable', why: 'result is not an object' };
  if (result.allow === true && Object.keys(result).length === 1) return { kind: 'allow' };
  if (result.allow !== false) return { kind: 'unavailable', why: 'result.allow is not boolean' };
  if (result.cause === 'denied') {
    const reason = result.reason;
    // The runner has already sanitised the reason (control characters, bidi marks stripped, at
    // most 200 code points, never empty); it is shown to the user as plain text.
    if (
      typeof reason !== 'string' ||
      reason.trim() === '' ||
      [...reason].length > REASON_MAX_CODE_POINTS
    ) {
      return { kind: 'unavailable', why: 'deny reason is malformed' };
    }
    return { kind: 'deny', reason };
  }
  if ((HOOK_AUTHOR_FAULT_CAUSES as readonly unknown[]).includes(result.cause)) {
    return { kind: 'author_fault', cause: result.cause as HookAuthorFaultCause };
  }
  return { kind: 'unavailable', why: 'unknown result cause' };
}

/**
 * One signed `POST /v1/check`. Never throws: every failure is `unavailable`. A response counts
 * only when its signature verifies over the exact body bytes, its `req` is the sha256 of the
 * exact request body sent, and its `ts` is within the skew window; a non-2xx answer is a runner
 * fault whatever it says (a 500 includes the backstop terminating a hook that outran its
 * interrupt), so it is `unavailable` without being read.
 */
export async function callHookRunner(
  config: HookRunnerConfig | null,
  call: HookRunnerCall,
  opts: { nowSec?: () => number; fetchImpl?: typeof fetch } = {}
): Promise<HookVerdict> {
  if (!config) return { kind: 'unavailable', why: 'runner not configured' };
  const nowSec = opts.nowSec ?? (() => Math.floor(Date.now() / 1000));
  const body = JSON.stringify({
    ts: nowSec(),
    appId: call.appId,
    collection: call.collection,
    op: call.op,
    sha256: call.sha256,
    source: call.source,
    timeoutMs: clampHookTimeoutMs(call.timeoutMs),
    input: call.input,
  });
  const reqDigest = sha256Hex(Buffer.from(body, 'utf8'));
  let status: number;
  let raw: Buffer;
  let sig: string | null;
  try {
    const res = await (opts.fetchImpl ?? fetch)(`${config.url}/v1/check`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [HOOK_RUNNER_SIG_HEADER]: hmacHex(config.secret, body),
      },
      body,
      signal: AbortSignal.timeout(hookClientTimeoutMs(call.timeoutMs)),
    });
    status = res.status;
    sig = res.headers.get(HOOK_RUNNER_SIG_HEADER);
    raw = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    const name = err instanceof Error ? err.name : typeof err;
    return { kind: 'unavailable', why: name === 'TimeoutError' ? 'timeout' : `transport ${name}` };
  }
  if (status !== 200) return { kind: 'unavailable', why: `status ${status}` };
  if (!signatureMatches(config.secret, raw, sig)) {
    return { kind: 'unavailable', why: 'bad response signature' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    return { kind: 'unavailable', why: 'response is not JSON' };
  }
  if (!isObj(parsed)) return { kind: 'unavailable', why: 'response is not an object' };
  if (parsed.req !== reqDigest)
    return { kind: 'unavailable', why: 'response is for another request' };
  if (
    typeof parsed.ts !== 'number' ||
    !Number.isInteger(parsed.ts) ||
    Math.abs(nowSec() - parsed.ts) > HOOK_RUNNER_SIG_SKEW_SECONDS
  ) {
    return { kind: 'unavailable', why: 'stale response' };
  }
  return readResult(parsed.result);
}

// ---------------------------------------------------------------------------
// Hook sources (`app_storage_hook_sources`, written at submit by `storage-hooks.ts`)
// ---------------------------------------------------------------------------

/** Sources by sha256. Content-addressed and immutable, so an entry can never be stale. */
const sourceCache = new Map<string, string>();
const SOURCE_CACHE_MAX = 256;

type RawQueryClient = {
  $queryRaw: <T>(query: TemplateStringsArray, ...values: unknown[]) => Promise<T>;
};

async function readSourceRow(client: RawQueryClient, sha256: string): Promise<string | null> {
  const rows = await client.$queryRaw<{ source: string }[]>`
    SELECT "source" FROM "app_storage_hook_sources" WHERE "sha256" = ${sha256}
  `;
  const source = rows?.[0]?.source;
  return typeof source === 'string' ? source : null;
}

/**
 * The hook module pinned by `sha256`, or null when no row holds it (or the table is missing).
 * Read from the replica, then the primary on a miss (a source recorded moments ago may not have
 * replicated). The text is re-hashed before it is used or cached: the runner refuses a mismatch
 * too, but a row that does not hash to its key is never sent.
 */
export async function loadHookSource(sha256: string): Promise<string | null> {
  const cached = sourceCache.get(sha256);
  if (cached !== undefined) return cached;
  const { dbRead, dbWrite } = await import('~/server/db/client');
  let source: string | null = null;
  try {
    source =
      (await readSourceRow(dbRead as unknown as RawQueryClient, sha256)) ??
      (await readSourceRow(dbWrite as unknown as RawQueryClient, sha256));
  } catch (err) {
    logToAxiom(
      {
        name: 'app-blocks-storage-hook-source-read-failed',
        type: 'error',
        error: err instanceof Error ? err.name : typeof err,
        message: err instanceof Error ? err.message : String(err),
      },
      'app-blocks'
    ).catch(() => undefined);
    return null;
  }
  if (source === null || sha256Hex(Buffer.from(source, 'utf8')) !== sha256) return null;
  if (sourceCache.size >= SOURCE_CACHE_MAX) {
    const oldest = sourceCache.keys().next().value;
    if (oldest !== undefined) sourceCache.delete(oldest);
  }
  sourceCache.set(sha256, source);
  return source;
}

/** Test-only: forget every cached source. */
export function resetHookSourceCacheForTests(): void {
  sourceCache.clear();
}

/**
 * Whether the operator has switched the runner OFFLINE for this app (Flipt
 * `app-blocks-storage-hook-runner-offline`, entityId = the app block id, no context). While on,
 * every hooked write of the app is refused `hook_unavailable` without a call. An absent flag,
 * Flipt unreachable, or an error reads as NOT offline: the normal path, which still fails closed
 * on its own. This lever can only refuse more; nothing can make a hook be skipped.
 */
export async function isHookRunnerOffline(appBlockId: string): Promise<boolean> {
  try {
    return (
      (await isFlipt(FLIPT_FEATURE_FLAGS.APP_BLOCKS_STORAGE_HOOK_RUNNER_OFFLINE, appBlockId)) ===
      true
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export type HookGateArgs = {
  access: StorageAccess;
  coll: DocCollection;
  store: Pick<DocStore, 'get'>;
  op: HookOp;
  /** The document key; omitted for a create, which pre-generates it here. */
  key?: string;
  /** The document body after a create or put. */
  after?: Record<string, unknown>;
  tally?: HookTally;
  /** The caller's own `ifVersion` (put, delete). Refused before the hook when it is stale. */
  ifVersion?: number;
  /** An increment that creates the document when it is absent (`write: 'none'`). */
  createsWhenAbsent?: boolean;
};

/** What the write runs with: the pass, and the key (pre-generated for a create). */
export type HookGrant = { pass: HookPass; key: string };

/** The refusals. */
function unavailable(collection: string): DocStoreError {
  return new DocStoreError('hook_unavailable', 'the permission check is temporarily unavailable', {
    collection,
    retryAfter: HOOK_UNAVAILABLE_RETRY_AFTER_SECONDS,
  });
}

/** The stored document's metadata as a hook sees it: no user id, ever. */
function docMeta(doc: DocRecord): HookInput['doc'] {
  return {
    version: doc.version,
    author:
      doc.author.kind === 'user'
        ? { kind: 'user', isViewer: doc.author.isViewer }
        : { kind: doc.author.kind },
    counters: doc.counters,
    marks: doc.marks,
  };
}

function logUnavailable(access: StorageAccess, collection: string, why: string): void {
  logToAxiom(
    {
      name: 'app-blocks-storage-hook-unavailable',
      type: 'warning',
      appBlockId: access.ctx.appId,
      collection,
      why,
    },
    'app-blocks'
  ).catch(() => undefined);
}

/**
 * Decide one write with the collection's permission hook. Returns null for a collection with no
 * hook (and for the `report` mark, which is exempt), else the HookPass the store write needs.
 * Throws `hook_rejected` (403) when the hook refuses or fails, `hook_unavailable` (503) when it
 * cannot be evaluated, and `version_conflict` when the caller's `ifVersion` is already stale.
 */
export async function gateHook(args: HookGateArgs): Promise<HookGrant | null> {
  const { access, coll, op } = args;
  const hook: DeclaredStorageHook | undefined = coll.config.hook;
  if (!hook) return null;
  if (op === 'mark' && args.tally?.name === REPORT_MARK) return null;
  const { ctx } = access;
  if (ctx.viewerUid === null) throw new DocStoreError('sign_in_required', 'sign in required');

  const key = op === 'create' ? newUlid() : args.key;
  if (key === undefined) throw new Error('doc-store-hook: a key is required for ' + op);
  const before = op === 'create' ? null : await args.store.get(ctx, coll, key);
  const version = before?.version ?? 0;
  if (args.ifVersion !== undefined && args.ifVersion !== version) {
    throw new DocStoreError('version_conflict', 'version conflict', { currentVersion: version });
  }
  const pass = () =>
    mintHookPass({ appId: ctx.appId, ns: ctx.ns, collection: coll.name, key, op, version });

  // Nothing for the hook to decide: deleting or tallying a document that does not exist changes
  // nothing (the store answers it, pinned to "still absent"). An increment that would CREATE the
  // document is decided like any other write.
  const tallyOp = op === 'increment' || op === 'mark' || op === 'unmark';
  if (
    !before &&
    (op === 'delete' || (tallyOp && !(op === 'increment' && args.createsWhenAbsent)))
  ) {
    return { pass: pass(), key };
  }

  const refuse = (outcome: StorageHookCallOutcome, why: string, seconds?: number) => {
    recordStorageHookCall(outcome, seconds);
    logUnavailable(access, coll.name, why);
    return unavailable(coll.name);
  };
  if (await isHookRunnerOffline(ctx.appId)) throw refuse('offline', 'runner offline flag');
  const source = await loadHookSource(hook.sha256);
  if (source === null) throw refuse('unavailable', 'hook source not found');

  const started = performance.now();
  const verdict = await callHookRunner(hookRunnerConfig(), {
    appId: access.blockId,
    collection: coll.name,
    op,
    sha256: hook.sha256,
    source,
    timeoutMs: hook.timeoutMs,
    input: {
      op,
      collection: coll.name,
      key,
      before: before ? before.data : null,
      after: op === 'create' || op === 'put' ? args.after ?? null : null,
      doc: before ? docMeta(before) : null,
      tally: args.tally ?? null,
      viewer: { userId: ctx.viewerUid },
      app: { blockId: access.blockId },
      from: access.importer ?? null,
    },
  });
  const seconds = (performance.now() - started) / 1000;
  switch (verdict.kind) {
    case 'allow':
      recordStorageHookCall('allow', seconds);
      return { pass: pass(), key };
    case 'deny':
      recordStorageHookCall('denied', seconds);
      throw new DocStoreError('hook_rejected', verdict.reason, {
        collection: coll.name,
        cause: 'denied',
      });
    case 'author_fault':
      recordStorageHookCall(verdict.cause, seconds);
      throw new DocStoreError(
        'hook_rejected',
        "this write could not be checked: the app's permission hook failed",
        { collection: coll.name, cause: verdict.cause }
      );
    case 'unavailable':
      throw refuse('unavailable', verdict.why, seconds);
  }
}
