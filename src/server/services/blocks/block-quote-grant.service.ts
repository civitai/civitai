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

/** JSON with object keys sorted at every depth, so a hash does not depend on key order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.keys(value as Record<string, unknown>)
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * The hash that binds a quote to the body it priced. `quoteId` is excluded — it is
 * the one field the submit adds — and everything else must be identical.
 */
export function hashQuotedBody(body: { quoteId?: string }): string {
  const { quoteId: _quoteId, ...rest } = body;
  return createHash('sha256').update(canonicalJson(rest)).digest('hex');
}

/**
 * The identity of a RUN — app, the quoted body's hash, and how many runs of that body
 * have been SUBMITTED — as a sha256 hex digest. Retries of one run share it; it keys
 * the run's orchestrator `externalId` (deduped per `(userId, externalId)`), so a retry
 * after an ambiguous failure — which needs a fresh quote — dedupes onto the run the
 * orchestrator may already have created, while a deliberate re-run after a known
 * result is a new run.
 */
export function quotedRunKey(appBlockId: string, bodyHash: string, generation: number): string {
  return createHash('sha256').update(`${appBlockId}\n${bodyHash}\n${generation}`).digest('hex');
}

export const QUOTED_RUN_GENERATION_TTL_SECONDS = 2 * 24 * 60 * 60;

/** Where a kind keeps its run-generation counters. */
export type QuotedRunGenerationKey =
  | `${typeof REDIS_SYS_KEYS.BLOCKS.TRAINING_DATASET}:${string}`
  | `${typeof REDIS_SYS_KEYS.BLOCKS.STEP_QUOTE}:runs:${string}`;

/** How many runs under `key` have been submitted (0 when unknown or malformed). */
export async function readQuotedRunGeneration(key: QuotedRunGenerationKey): Promise<number> {
  const raw = await sysRedis.get(key);
  const n = Number(raw ?? 0);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

/** Record a submitted run. Best-effort: a lost bump only makes the next re-run dedupe. */
export async function bumpQuotedRunGeneration(key: QuotedRunGenerationKey): Promise<void> {
  try {
    await sysRedis.incrBy(key, 1);
    await sysRedis.expire(key, QUOTED_RUN_GENERATION_TTL_SECONDS);
  } catch {
    // best-effort
  }
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

/**
 * The run-generation counter for a confirmed step body. Per (viewer, app, body): unlike
 * a training body, a step body names nothing user-bound, so the viewer and app are in
 * the key to keep one viewer's submits from moving another's run identity.
 */
export function confirmedStepRunGenerationKey(
  userId: number,
  appBlockId: string,
  bodyHash: string
): QuotedRunGenerationKey {
  return `${REDIS_SYS_KEYS.BLOCKS.STEP_QUOTE}:runs:${userId}:${appBlockId}:${bodyHash}`;
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
