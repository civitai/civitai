import { createHash, randomBytes } from 'crypto';
import type { BlockQuoteGrant } from '~/server/middleware/block-scope.middleware';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import {
  BLOCK_STEP_QUOTE_ID_REGEX,
  BLOCK_TRAINING_QUOTE_ID_REGEX,
  type PassThroughStepBody,
} from '~/server/schema/blocks/workflow.schema';

// ─────────────────────────────────────────────────────────────────────────────
// App Blocks QUOTE GRANTS — the one store behind every spend an app may make ABOVE
// its token's per-call budget.
//
// An estimate prices one exact piece of work with a `whatif`, and stores the price
// here keyed by an opaque, server-minted `quoteId`. The viewer confirms THAT price
// from their own signed-in session, and the submit claims the record exactly once
// and charges against it. Nothing here trusts a number the block supplied.
//
// 🔴 ONE STORE, TWO KINDS. `kind:'training'` (`tq_…`) and the confirmed pass-through
// step (`sq_…`) differ only in what their records carry beyond the grant; the
// binding, the TTL, the consent write and the consume-once claim are the same rule,
// so they live here once. The kind selects the id shape AND the Redis namespace, so
// a quote id of one kind can never be read, confirmed or claimed as the other — a
// `tq_` id fails the `sq_` regex before any key is built, and the two namespaces
// are disjoint besides.
// ─────────────────────────────────────────────────────────────────────────────

export type BlockQuoteGrantKind = 'training' | 'step';

const QUOTE_KINDS = {
  training: {
    prefix: 'tq_',
    idRegex: BLOCK_TRAINING_QUOTE_ID_REGEX,
    namespace: REDIS_SYS_KEYS.BLOCKS.TRAINING_QUOTE,
  },
  step: {
    prefix: 'sq_',
    idRegex: BLOCK_STEP_QUOTE_ID_REGEX,
    namespace: REDIS_SYS_KEYS.BLOCKS.STEP_QUOTE,
  },
} as const satisfies Record<
  BlockQuoteGrantKind,
  { prefix: string; idRegex: RegExp; namespace: string }
>;

/** How long a quote stays usable — consent and submit must both land inside it. */
export const BLOCK_QUOTE_GRANT_TTL_SECONDS = 15 * 60;

/** The fields every stored quote record carries, whatever its kind. */
export type BlockQuoteGrantRecord = BlockQuoteGrant & {
  v: 1;
  quoteId: string;
  /** Hash of the body that was quoted (its `quoteId` excluded) — the submit must match it. */
  bodyHash: string;
  expiresAt: string;
  consentedAt: string | null;
};

export type BlockQuoteBinding = { userId: number; appBlockId: string; blockInstanceId: string };

function quoteKey(kind: BlockQuoteGrantKind, quoteId: string) {
  return `${QUOTE_KINDS[kind].namespace}:${quoteId}` as const;
}

/**
 * Thrown by `canonicalJson` for a value that is not plain JSON. `message` names the
 * path and what was found there (`input.when is a Date`), and nothing else.
 */
export class NonJsonQuotedBodyError extends Error {
  constructor(path: string, found: string) {
    super(`${path} is ${found}`);
    this.name = 'NonJsonQuotedBodyError';
  }
}

export function isNonJsonQuotedBodyError(e: unknown): e is NonJsonQuotedBodyError {
  return e instanceof NonJsonQuotedBodyError;
}

function describeNonJson(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (typeof value === 'number') return `the non-finite number ${String(value)}`;
  if (typeof value === 'object' && value !== null) {
    const name = (Object.getPrototypeOf(value) as { constructor?: { name?: string } } | null)
      ?.constructor?.name;
    return name ? `a ${name}` : 'a non-plain object';
  }
  return `a ${typeof value}`;
}

/**
 * The canonical form a quoted body is hashed in: JSON with object keys sorted at every
 * depth, so the hash does not depend on key order.
 *
 * 🔴 EXACT, OR IT THROWS. Only plain JSON is accepted — plain objects, arrays, strings,
 * FINITE numbers, booleans and `null`. Anything else (`Date`, `Map`, `Set`, a class
 * instance, `BigInt`, a symbol or function, `NaN`/`Infinity`, an `undefined` array
 * element, an empty slot in a sparse array) throws `NonJsonQuotedBodyError` rather than being squeezed into a string two
 * different values could share: a `Date` and a `Map` both have no own enumerable keys,
 * so a looser form hashed every one of them as `{}` and a quote confirmed for one such
 * body matched any other. A body is bound exactly, or it is not quotable.
 *
 * An object key whose value is `undefined` is skipped — that is how the wire body
 * carries an absent optional (`step: undefined`), and JSON drops it from what the
 * orchestrator receives, so it is not a difference in the work.
 */
export function canonicalJson(value: unknown, path = 'body'): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new NonJsonQuotedBodyError(path, describeNonJson(value));
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    // BY INDEX, not `map`: `map` and `join` skip a hole, so a sparse array would hash as
    // if its empty slots were not there (`[ , ]` like `[]`).
    const entries: string[] = [];
    for (let i = 0; i < value.length; i += 1) {
      if (!(i in value)) throw new NonJsonQuotedBodyError(`${path}[${i}]`, 'an empty array slot');
      entries.push(canonicalJson(value[i], `${path}[${i}]`));
    }
    return `[${entries.join(',')}]`;
  }
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value) as unknown;
    if (proto !== Object.prototype && proto !== null) {
      throw new NonJsonQuotedBodyError(path, describeNonJson(value));
    }
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .filter((k) => record[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k], `${path}.${k}`)}`);
    return `{${entries.join(',')}}`;
  }
  throw new NonJsonQuotedBodyError(path, describeNonJson(value));
}

/**
 * The hash that binds a quote to the body it priced. `quoteId` is excluded — it is
 * the one field the submit adds — and every other value must be identical. Throws
 * `NonJsonQuotedBodyError` for a body that is not plain JSON (see `canonicalJson`).
 */
export function hashQuotedBody(body: { quoteId?: string }): string {
  const { quoteId: _quoteId, ...rest } = body;
  return createHash('sha256').update(canonicalJson(rest)).digest('hex');
}

/**
 * Store a fresh quote of `kind`. The `quoteId` is server-minted (128 random bits) and
 * the record starts UNCONSENTED.
 */
export async function storeQuoteGrant<R extends BlockQuoteGrantRecord>(
  kind: BlockQuoteGrantKind,
  input: Omit<R, 'v' | 'quoteId' | 'expiresAt' | 'consentedBy' | 'consentedAt'>
): Promise<R> {
  const quoteId = `${QUOTE_KINDS[kind].prefix}${randomBytes(16).toString('hex')}`;
  const record = {
    ...input,
    v: 1,
    quoteId,
    expiresAt: new Date(Date.now() + BLOCK_QUOTE_GRANT_TTL_SECONDS * 1000).toISOString(),
    consentedBy: null,
    consentedAt: null,
  } as R;
  await sysRedis.set(quoteKey(kind, quoteId), JSON.stringify(record), {
    EX: BLOCK_QUOTE_GRANT_TTL_SECONDS,
  });
  return record;
}

function parseQuote<R extends BlockQuoteGrantRecord>(raw: unknown): R | null {
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw) as R;
    return parsed && parsed.v === 1 ? parsed : null;
  } catch {
    return null;
  }
}

function isBoundTo(quote: BlockQuoteGrantRecord, binding: BlockQuoteBinding): boolean {
  return (
    quote.userId === binding.userId &&
    quote.appBlockId === binding.appBlockId &&
    quote.blockInstanceId === binding.blockInstanceId
  );
}

/**
 * Read a quote FOR THIS subject, app and install, or `null` (absent, expired,
 * malformed, of the other kind, or bound to someone else — one answer for all, so a
 * quote id cannot be used to probe another viewer's runs). Does not consume it.
 */
export async function readQuoteGrant<R extends BlockQuoteGrantRecord>(
  kind: BlockQuoteGrantKind,
  quoteId: string,
  binding: BlockQuoteBinding
): Promise<R | null> {
  if (!QUOTE_KINDS[kind].idRegex.test(quoteId)) return null;
  const quote = parseQuote<R>(await sysRedis.get(quoteKey(kind, quoteId)));
  return quote && isBoundTo(quote, binding) ? quote : null;
}

/**
 * Record that `sessionUserId` confirmed this quote. Returns the updated record, or
 * `null` when the quote is not readable for this binding or the session user is not
 * the quote's own subject.
 *
 * The write keeps the quote's remaining TTL (`KEEPTTL`) and only overwrites an
 * existing key (`XX`), so confirming never extends a quote's life and never
 * resurrects one the submit already claimed.
 */
export async function recordQuoteGrantConsent<R extends BlockQuoteGrantRecord>(
  kind: BlockQuoteGrantKind,
  quoteId: string,
  binding: BlockQuoteBinding,
  sessionUserId: number
): Promise<R | null> {
  const quote = await readQuoteGrant<R>(kind, quoteId, binding);
  if (!quote || quote.userId !== sessionUserId) return null;
  const updated: R = {
    ...quote,
    consentedBy: sessionUserId,
    consentedAt: new Date().toISOString(),
  };
  const written = await sysRedis.set(quoteKey(kind, quoteId), JSON.stringify(updated), {
    XX: true,
    KEEPTTL: true,
  });
  return written ? updated : null;
}

/**
 * Claim a quote for a submit — EXACTLY ONCE. `GETDEL` is atomic, so of two concurrent
 * submits naming one quote only one gets the record; the other gets `null`. The record
 * is consumed whatever the caller then decides, so a submit refused for any reason
 * needs a fresh quote and a fresh confirmation.
 *
 * It does NOT check the binding — the caller's ceiling does that, once, so the check
 * is load-bearing rather than a shadowed second copy (see `blockQuoteGrantRefusal`).
 */
export async function claimQuoteGrant<R extends BlockQuoteGrantRecord>(
  kind: BlockQuoteGrantKind,
  quoteId: string
): Promise<R | null> {
  if (!QUOTE_KINDS[kind].idRegex.test(quoteId)) return null;
  return parseQuote<R>(await sysRedis.getDel(quoteKey(kind, quoteId)));
}

// ── The confirmed pass-through STEP kind (`sq_…`) ───────────────────────────────

/**
 * A stored step quote: the grant, plus the `$type` it priced, for the consent dialog.
 * `total` is the orchestrator's FIXED price for exactly the hashed body — never a
 * variable/cap price, never the app's declared `maxBuzz`.
 */
export type BlockStepQuoteRecord = BlockQuoteGrantRecord & { stepType: string };

/** `hashQuotedBody` for a pass-through step body. */
export function hashPassThroughStepBody(body: PassThroughStepBody): string {
  return hashQuotedBody(body);
}

export function storeStepQuote(
  input: Omit<BlockStepQuoteRecord, 'v' | 'quoteId' | 'expiresAt' | 'consentedBy' | 'consentedAt'>
): Promise<BlockStepQuoteRecord> {
  return storeQuoteGrant<BlockStepQuoteRecord>('step', input);
}

export function readStepQuote(quoteId: string, binding: BlockQuoteBinding) {
  return readQuoteGrant<BlockStepQuoteRecord>('step', quoteId, binding);
}

export function recordStepQuoteConsent(
  quoteId: string,
  binding: BlockQuoteBinding,
  sessionUserId: number
) {
  return recordQuoteGrantConsent<BlockStepQuoteRecord>('step', quoteId, binding, sessionUserId);
}

export function claimStepQuote(quoteId: string) {
  return claimQuoteGrant<BlockStepQuoteRecord>('step', quoteId);
}
