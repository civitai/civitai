import { TRPCError } from '@trpc/server';

import { getEdgeUrl } from '~/client-utils/edge-url';
import { dbWrite } from '~/server/db/client';
import { civitaiHostedImageUrlSchema } from '~/server/schema/blocks/civitai-image-url';
import { resolveOwnedWorkflowOutputs } from '~/server/services/blocks/block-post.service';
import { restrictedOutputMessage } from '~/server/services/blocks/block-output-restriction';
import type { BlockOutputCeiling } from '~/server/services/blocks/block-output-restriction';
import {
  BLOCK_GENERATION_SOURCE_APP_ID_META_KEY,
  BLOCK_GENERATION_SOURCE_REF_META_KEY,
  persistBlockGenerationSourceImage,
} from '~/server/services/blocks/block-image-upload.service';
import {
  assertGenerationInputsUsable,
  isAppSourcePendingError,
} from '~/server/services/generation-input-urls';

/**
 * App Blocks `PERSIST_GENERATION_SOURCE` (`blocks.persistGenerationSource`): an app turns one of
 * its OWN finished generation outputs into a PRIVATE, scanned generation source it can feed back
 * into a workflow. No consent dialog, because nothing is shown to anyone: the row is owned by the
 * viewer, has no post, and carries the private provenance key, so no shared or postable read
 * returns it (`block-image-provenance-readers.test.ts`).
 *
 * The answer is ready when the SAME gate a generation runs (`assertGenerationInputsUsable`, App
 * Blocks entry) accepts the returned url. That is the definition of `ready`, not an imitation of
 * it, so a `ready: true` url is one a submit accepts.
 */

/**
 * The request's budget, started before the ownership check. The output fetch (every redirect hop
 * and the body read) and the store PUT are aborted when it runs out, and no row is written after
 * it; the scan wait gets what is left. NOT bounded by it: the ownership row and orchestrator reads
 * (`resolveOwnedWorkflowOutputs`), the idempotency lookup, the `createImage` insert once started,
 * and the one gate read that can straddle the deadline. So the reply comes at about this plus
 * those reads, and a call whose budget was spent before the fetch is refused at once.
 */
export const GENERATION_SOURCE_DEADLINE_MS = 30_000;
/** How often the scan state is re-read while waiting. */
export const GENERATION_SOURCE_POLL_MS = 1_500;

export const GENERATION_SOURCE_INDEX_OUT_OF_RANGE_MESSAGE =
  'imageIndex is out of range for this workflow’s outputs';
export const GENERATION_SOURCE_OUTPUT_UNAVAILABLE_MESSAGE =
  'that output is not available to use as a source';

export type PersistedGenerationSource = {
  url: string;
  width: number;
  height: number;
  imageId: number;
  /** The gate accepts `url` now. `false`: the scan had not finished by the deadline; ask again. */
  ready: boolean;
};

/**
 * The full-size delivery url for a stored key, in the form `blockSourceImageSchema` and the
 * generation gate both accept. Throws if the configured image origin would produce a url the
 * source schema refuses, rather than handing the app a source it can never submit.
 */
export function generationSourceUrl(key: string): string {
  const url = getEdgeUrl(key, { original: true, type: 'image' });
  const parsed = civitaiHostedImageUrlSchema.safeParse(url);
  if (!parsed.success) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'image delivery url is not a valid generation source',
    });
  }
  return parsed.data;
}

/**
 * The private source an earlier call already made from this output for this viewer and app, if
 * any. Owner-bound, and keyed on the server-owned provenance key, so a client cannot mint a row it
 * matches. `dbWrite`: a retry seconds after the first call must see that call's row.
 *
 * Not race-free: two concurrent first calls both miss and both write. That costs one duplicate
 * private row, bounded by the per-user rate limit, and nothing anyone else can see.
 */
export async function findBlockGenerationSourceImage(input: {
  userId: number;
  appId: string;
  ref: string;
}): Promise<{ id: number; url: string; width: number | null; height: number | null } | null> {
  const rows = await dbWrite.$queryRaw<
    Array<{ id: number; url: string; width: number | null; height: number | null }>
  >`
    SELECT i."id", i."url", i."width", i."height"
    FROM "Image" i
    WHERE i."userId" = ${input.userId}
      AND i."postId" IS NULL
      AND i."metadata"->>(${BLOCK_GENERATION_SOURCE_APP_ID_META_KEY}::text) = ${input.appId}
      AND i."metadata"->>(${BLOCK_GENERATION_SOURCE_REF_META_KEY}::text) = ${input.ref}
    ORDER BY i."id" DESC
    LIMIT 1
  `;
  return rows[0] ?? null;
}

/**
 * Whether the generation gate accepts `url` for this viewer as an App Blocks source: `true` when
 * it does, `false` while the scan is still pending. Any other refusal (blocked, held for review,
 * unscannable) is thrown as the gate threw it.
 */
export async function isGenerationSourceUsable(url: string, userId: number): Promise<boolean> {
  try {
    await assertGenerationInputsUsable({
      urls: [url],
      userId,
      entry: 'appBlocksSourcePersist',
      isApiCaller: false,
    });
    return true;
  } catch (error) {
    if (isAppSourcePendingError(error)) return false;
    throw error;
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Re-asks {@link isGenerationSourceUsable} every {@link GENERATION_SOURCE_POLL_MS} until it
 * accepts or `deadline` (epoch ms) passes. Always asks at least once.
 */
export async function waitForGenerationSource(input: {
  url: string;
  userId: number;
  deadline: number;
}): Promise<boolean> {
  for (;;) {
    if (await isGenerationSourceUsable(input.url, input.userId)) return true;
    const left = input.deadline - Date.now();
    if (left <= 0) return false;
    await sleep(Math.min(GENERATION_SOURCE_POLL_MS, left));
  }
}

export async function persistBlockGenerationSource(input: {
  userId: number;
  appId: string;
  appBlockId: string;
  workflowId: string;
  imageIndex: number;
  getWorkflow: (workflowId: string) => Promise<unknown>;
  /**
   * The token's output ceiling (`blockOutputCeilingFromClaims(claims)`): decides which
   * output positions are restricted. `imageIndex` is a position in `AppWorkflow.outputs`.
   */
  ceiling: BlockOutputCeiling;
  /** The request budget; {@link GENERATION_SOURCE_DEADLINE_MS} unless a test shortens it. */
  budgetMs?: number;
}): Promise<PersistedGenerationSource> {
  const budgetMs = input.budgetMs ?? GENERATION_SOURCE_DEADLINE_MS;
  const deadline = Date.now() + budgetMs;
  // A timer, not `AbortSignal.timeout`, so the deadline is one clock with the scan wait's.
  const expiry = new AbortController();
  const timer = setTimeout(() => expiry.abort(), budgetMs);
  try {
    return await persistWithin({ ...input, deadline, signal: expiry.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function persistWithin(input: {
  userId: number;
  appId: string;
  appBlockId: string;
  workflowId: string;
  imageIndex: number;
  getWorkflow: (workflowId: string) => Promise<unknown>;
  ceiling: BlockOutputCeiling;
  deadline: number;
  signal: AbortSignal;
}): Promise<PersistedGenerationSource> {
  const { deadline, signal } = input;
  // Ownership (the durable user + app + workflow row), the app tag, a FINISHED workflow, and the
  // host allowlist, in that order, before anything is fetched. Slots keep the indexes the app saw.
  const slots = await resolveOwnedWorkflowOutputs({
    userId: input.userId,
    appId: input.appId,
    appBlockId: input.appBlockId,
    workflowId: input.workflowId,
    getWorkflow: input.getWorkflow,
    ceiling: input.ceiling,
  });
  if (input.imageIndex >= slots.length) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: GENERATION_SOURCE_INDEX_OUT_OF_RANGE_MESSAGE,
    });
  }
  const output = slots[input.imageIndex];
  // A restricted position is refused by name, never swapped for another output.
  if (output && 'restricted' in output) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: restrictedOutputMessage(input.imageIndex),
    });
  }
  if (!output) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: GENERATION_SOURCE_OUTPUT_UNAVAILABLE_MESSAGE,
    });
  }

  const ref = `${input.workflowId}#${input.imageIndex}`;
  const existing = await findBlockGenerationSourceImage({
    userId: input.userId,
    appId: input.appId,
    ref,
  });
  let image: { imageId: number; key: string; width: number; height: number };
  if (existing && existing.width != null && existing.height != null) {
    image = {
      imageId: existing.id,
      key: existing.url,
      width: existing.width,
      height: existing.height,
    };
  } else {
    const written = await persistBlockGenerationSourceImage({
      imageUrl: output.url,
      width: output.width,
      height: output.height,
      userId: input.userId,
      appId: input.appId,
      ref,
      signal,
    });
    image = {
      imageId: written.imageId,
      key: written.url,
      width: written.width,
      height: written.height,
    };
  }

  const url = generationSourceUrl(image.key);
  const ready = await waitForGenerationSource({ url, userId: input.userId, deadline });
  return { url, width: image.width, height: image.height, imageId: image.imageId, ready };
}
