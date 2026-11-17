import { z } from 'zod';
import { TIMEOUT_DEFAULT_MS, TIMEOUT_MAX_MS, TIMEOUT_MIN_MS } from './limits.ts';

/**
 * The wire contract of `POST /v1/check`. The README documents it; the civitai write path (the
 * caller) must send exactly this. Strict on purpose: an unknown or missing field is a 400, which
 * the caller maps to `hook_unavailable`, so contract drift fails CLOSED and loudly instead of a
 * hook silently reading `undefined` for a field it relies on.
 */

export const HOOK_OPS = ['create', 'put', 'delete', 'increment', 'mark', 'unmark'] as const;
const Op = z.enum(HOOK_OPS);

/** blockIds, collection, counter and mark names. Bounded because `app` and `collection` are
 *  metric labels (and only a signed caller can send them). */
const Name = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/);

/** A JSON value that must be PRESENT (`null` when there is nothing), never omitted. */
const Present = z.unknown().refine((v) => v !== undefined, { message: 'required (send null)' });

const Tally = z
  .discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('counter'), name: Name, by: z.number().finite() }),
    z.strictObject({ kind: z.literal('mark'), name: Name }),
  ])
  .nullable();

/** The single argument the hook's default export is called with. */
export const HookInput = z.strictObject({
  op: Op,
  collection: Name,
  /** The document key; for `create` the caller pre-generates it so the hook can see it. */
  key: z.string().min(1).max(200),
  /** The stored document's data before this write, or null (create, or absent). */
  before: Present,
  /** The document's data after this write, or null (delete, increment, mark, unmark). */
  after: Present,
  /** Metadata of the stored document (version, author kind, counters, marks), or null. Its
   *  inner shape is the write path's to define; the runner passes it through. */
  doc: z.record(z.string(), z.unknown()).nullable(),
  /** For increment / mark / unmark: which counter (and by how much) or which mark. */
  tally: Tally,
  viewer: z.strictObject({ userId: z.number().int() }),
  app: z.strictObject({ blockId: Name }),
  /** The importing app's blockId on a `?from=` write, else null. */
  from: Name.nullable(),
});
export type HookInput = z.infer<typeof HookInput>;

export const CheckRequest = z
  .strictObject({
    /** Integer unix seconds, inside the signed body (replay window). */
    ts: z.number().int(),
    appId: Name,
    collection: Name,
    op: Op,
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    /** The hook module's source text. Its UTF-8 bytes must hash to `sha256`. */
    source: z.string(),
    /** Clamped to [TIMEOUT_MIN_MS, TIMEOUT_MAX_MS]; default TIMEOUT_DEFAULT_MS. */
    timeoutMs: z.number().finite().optional(),
    input: HookInput,
  })
  .refine(
    (r) =>
      r.input.op === r.op && r.input.collection === r.collection && r.input.app.blockId === r.appId,
    {
      message: 'input.op / input.collection / input.app.blockId must match op / collection / appId',
    }
  );
export type CheckRequest = z.infer<typeof CheckRequest>;

export function clampTimeout(ms: number | undefined): number {
  if (ms === undefined) return TIMEOUT_DEFAULT_MS;
  return Math.min(TIMEOUT_MAX_MS, Math.max(TIMEOUT_MIN_MS, Math.round(ms)));
}

/** Error codes of a non-2xx answer. Every one of them means `hook_unavailable` to the caller. */
export type RefusalCode =
  | 'bad_signature'
  | 'stale_timestamp'
  | 'bad_request'
  | 'source_too_large'
  | 'sha_mismatch'
  | 'body_too_large'
  | 'overloaded'
  | 'worker_crashed'
  | 'worker_terminated'
  | 'shutting_down';
