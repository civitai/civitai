import { z } from 'zod';
import {
  MAX_REMIX_ANSWER_CHARS,
  MAX_REMIX_BRANCHES,
  MAX_REMIX_EFFECTS,
  TIMEOUT_DEFAULT_MS,
  TIMEOUT_MAX_MS,
  TIMEOUT_MIN_MS,
} from './limits.ts';

/**
 * The wire contract of `POST /v1/check`. The README documents it; the civitai write path (the
 * caller) must send exactly this. Strict on purpose: an unknown or missing field is a 400, which
 * the caller maps to `hook_unavailable`, so contract drift fails CLOSED and loudly instead of a
 * hook silently reading `undefined` for a field it relies on.
 */

/** The document writes. The tally ops (increment, mark, unmark) were removed from App Storage. */
export const HOOK_OPS = ['create', 'put', 'delete'] as const;
const Op = z.enum(HOOK_OPS);

/** blockIds and collection names. Bounded because `app` and `collection` are
 *  metric labels (and only a signed caller can send them). */
const Name = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/);

/** A JSON value that must be PRESENT (`null` when there is nothing), never omitted. */
const Present = z.unknown().refine((v) => v !== undefined, { message: 'required (send null)' });


/** The single argument the hook's default export is called with. */
export const HookInput = z
  .strictObject({
    op: Op,
    collection: Name,
    /** The document key; for `create` the caller pre-generates it so the hook can see it. */
    key: z.string().min(1).max(200),
    /** The stored document's data before this write, or null (create, or absent). */
    before: Present,
    /** The document's data after this write, or null (delete). */
    after: Present,
    /** Metadata of the stored document (version, author kind; `counters` / `marks` always
     *  empty), or null. Its inner shape is the write path's to define; the runner passes it
     *  through. */
    doc: z.record(z.string(), z.unknown()).nullable(),
    /** Always null since the tally ops were removed; still a required field, so a hook written
     *  against it keeps reading `null`. */
    tally: z.null(),
    viewer: z.strictObject({ userId: z.number().int() }),
    app: z.strictObject({ blockId: Name }),
    /** The importing app's blockId on a `?from=` write, else null. */
    from: Name.nullable(),
    /** On a viewer-keyed collection only: the parent key a `@me` write names (null under
     *  `keyedBy: "viewer"`). Absent on every other collection. */
    parent: z.string().min(1).max(96).nullable().optional(),
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

const Url = z.string().min(1).max(2048);
const Dimension = z.number().int().positive().max(100_000);

const RemixImage = z.strictObject({
  url: Url,
  width: Dimension.optional(),
  height: Dimension.optional(),
});

/** One recorded step of a run: a workflow's result, or the answer to an ask. */
const RemixLogEntry = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('workflow'),
    result: z.strictObject({
      workflowId: z.string().min(1).max(128),
      images: z.array(RemixImage).max(16),
    }),
  }),
  z.strictObject({
    type: z.literal('ask'),
    answer: z.union([z.string().max(MAX_REMIX_ANSWER_CHARS), z.number().int().nonnegative()]),
  }),
]);
const RemixLog = z.array(RemixLogEntry).max(MAX_REMIX_EFFECTS);

/**
 * The wire contract of `POST /v1/remix/replay`, strict like `/v1/check`'s. `base` is replayed,
 * then `base` followed by each of `branches` (the host prices a choice's options this way).
 */
export const RemixReplayRequest = z.strictObject({
  ts: z.number().int(),
  /** The remix row's blockId. */
  appId: Name,
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  source: z.string(),
  input: z
    .strictObject({
      source: z.strictObject({
        imageId: z.number().int().positive(),
        url: Url,
        width: Dimension,
        height: Dimension,
      }),
      base: RemixLog,
      branches: z.array(RemixLog).max(MAX_REMIX_BRANCHES).optional(),
      autoAnswer: z.literal('first').optional(),
    })
    .refine((i) => (i.branches ?? []).every((b) => i.base.length + b.length <= MAX_REMIX_EFFECTS), {
      message: `base plus a branch holds at most ${MAX_REMIX_EFFECTS} entries`,
    }),
});
export type RemixReplayRequest = z.infer<typeof RemixReplayRequest>;

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
  | 'quarantined'
  | 'shutting_down';
