import { TRPCError } from '@trpc/server';

import { getEdgeUrl } from '~/client-utils/edge-url';
import { dbWrite } from '~/server/db/client';
import { civitaiHostedImageUrlSchema } from '~/server/schema/blocks/civitai-image-url';
import { resolveOwnedWorkflowOutputs } from '~/server/services/blocks/block-post.service';
import {
  pendingOutputMessage,
  restrictedOutputMessage,
} from '~/server/services/blocks/block-output-restriction';
import type { BlockOutputRules } from '~/server/services/blocks/block-output-mint';
import {
  BLOCK_GENERATION_SOURCE_APP_ID_META_KEY,
  BLOCK_GENERATION_SOURCE_REF_META_KEY,
  persistBlockGenerationSourceImage,
} from '~/server/services/blocks/block-image-upload.service';
import {
  assertGenerationInputsUsable,
  isAppSourcePendingError,
} from '~/server/services/generation-input-urls';
import { isTrustedOrchestratorUrl } from '~/server/services/orchestrator/trusted-blob-url';

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
 *
 * `blocks.persistUploadedGenerationSource` is the same writer for a source the viewer PICKED
 * (`OPEN_IMAGE_UPLOAD { purpose: 'generationSource' }`, a single `OPEN_MEDIA_UPLOAD` image): the
 * host has already uploaded it as a consumer blob, and {@link persistUploadedGenerationSource}
 * copies that blob into the same kind of private, scanned row. Only the byte source and the
 * idempotency ref differ; the fetch, fit, store, row, scan wait and request budget are shared.
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
export async function isGenerationSourceUsable(
  url: string,
  userId: number,
  appBlockId: string
): Promise<boolean> {
  try {
    await assertGenerationInputsUsable({
      urls: [url],
      userId,
      entry: 'appBlocksSourcePersist',
      isApiCaller: false,
      appBlockLog: { appBlockId },
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
  appBlockId: string;
  deadline: number;
}): Promise<boolean> {
  for (;;) {
    if (await isGenerationSourceUsable(input.url, input.userId, input.appBlockId)) return true;
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
   * The token's output rules (`resolveBlockOutputRules(claims)`): decide which output
   * positions are restricted, as the poll does. `imageIndex` is a position in
   * `AppWorkflow.outputs`.
   */
  ceiling: BlockOutputRules;
  /** The request budget; {@link GENERATION_SOURCE_DEADLINE_MS} unless a test shortens it. */
  budgetMs?: number;
}): Promise<PersistedGenerationSource> {
  return withinGenerationSourceBudget(input.budgetMs, (budget) =>
    persistWithin({ ...input, ...budget })
  );
}

type GenerationSourceBudget = { deadline: number; signal: AbortSignal };

/**
 * Runs `run` under one request budget: a deadline (epoch ms) for the scan wait and a signal that
 * aborts the fetch and the store when it passes. A timer, not `AbortSignal.timeout`, so the
 * deadline is one clock with the scan wait's.
 */
async function withinGenerationSourceBudget<T>(
  budgetMs: number | undefined,
  run: (budget: GenerationSourceBudget) => Promise<T>
): Promise<T> {
  const ms = budgetMs ?? GENERATION_SOURCE_DEADLINE_MS;
  const deadline = Date.now() + ms;
  const expiry = new AbortController();
  const timer = setTimeout(() => expiry.abort(), ms);
  try {
    return await run({ deadline, signal: expiry.signal });
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
  ceiling: BlockOutputRules;
  deadline: number;
  signal: AbortSignal;
}): Promise<PersistedGenerationSource> {
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
  // 🔴 Every refusal here runs BEFORE anything is fetched or looked up, so an output
  // that is restricted, blocked or still being rated is never copied to storage.
  if (output && 'pending' in output) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: pendingOutputMessage(input.imageIndex) });
  }
  if (output && 'blocked' in output) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: GENERATION_SOURCE_OUTPUT_UNAVAILABLE_MESSAGE,
    });
  }
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

  return keepGenerationSource({
    userId: input.userId,
    appId: input.appId,
    appBlockId: input.appBlockId,
    ref: `${input.workflowId}#${input.imageIndex}`,
    imageUrl: output.url,
    width: output.width,
    height: output.height,
    deadline: input.deadline,
    signal: input.signal,
  });
}

/**
 * The shared tail of both writers: the row an earlier call already made for this viewer, app and
 * `ref`, or else the bytes at `imageUrl` fetched, fitted, stored and written as a private row
 * ({@link persistBlockGenerationSourceImage}); then the delivery url and the scan wait.
 * `imageUrl` must already be one the caller resolved or checked: the fetch re-checks only its
 * host allowlist.
 */
async function keepGenerationSource(input: {
  userId: number;
  appId: string;
  appBlockId: string;
  ref: string;
  imageUrl: string;
  width: number | null;
  height: number | null;
  deadline: number;
  signal: AbortSignal;
}): Promise<PersistedGenerationSource> {
  const { userId, appId, ref, deadline, signal } = input;
  const existing = await findBlockGenerationSourceImage({ userId, appId, ref });
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
      imageUrl: input.imageUrl,
      width: input.width,
      height: input.height,
      userId,
      appId,
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
  const ready = await waitForGenerationSource({
    url,
    userId,
    appBlockId: input.appBlockId,
    deadline,
  });
  return { url, width: image.width, height: image.height, imageId: image.imageId, ready };
}

/** Refusal for a url that is not a consumer blob on a trusted orchestrator host, as uploaded. */
export const UPLOADED_SOURCE_URL_MESSAGE = 'that url is not an uploaded generation source';

/** A consumer blob's path, whole: `/v<n>/consumer/blobs/<id>` and nothing before or after it. */
const CONSUMER_BLOB_PATHNAME = /^\/v\d+\/consumer\/blobs\/([A-Za-z0-9_.-]+)$/;

/**
 * The blob id when `raw` is a consumer blob url as the host's upload returns it, else `null`:
 * - canonical (a parser would not rewrite it: no dot segments, upper-case host, backslash or
 *   control bytes), so the host judged here is the host any fetcher sees;
 * - https on a trusted orchestrator host, the port included, with no userinfo (`@` refused
 *   anywhere) and no fragment (`isTrustedOrchestratorUrl`);
 * - a consumer blob path, whole: `/v<n>/consumer/blobs/<id>` with nothing before or after it
 *   (a query is allowed). Any url of that shape is accepted, the blob of a workflow output
 *   included: the check is on the url's form, not on how the blob was made. A job asset path
 *   (`/consumer/jobs/...`) or any other path is refused.
 *
 * Its id is the idempotency ref; an output's ref always holds `#`, which an id cannot, so the two
 * never collide.
 */
export function uploadedSourceBlobId(raw: string): string | null {
  if (!URL.canParse(raw)) return null;
  const parsed = new URL(raw);
  if (parsed.href !== raw || parsed.hash || raw.includes('@')) return null;
  if (!isTrustedOrchestratorUrl(raw)) return null;
  return CONSUMER_BLOB_PATHNAME.exec(parsed.pathname)?.[1] ?? null;
}

/**
 * `blocks.persistUploadedGenerationSource`: a generation source the viewer picked, already
 * uploaded by the host as a consumer blob, copied into a PRIVATE, scanned row owned by `userId`
 * through the writer `PERSIST_GENERATION_SOURCE` uses, and returned in the source shape plus
 * `imageId` and `ready` (see {@link PersistedGenerationSource}).
 *
 * The blob is not tied to its uploader: nothing on our side records who uploaded a consumer blob.
 * That gives the caller nothing they could not already download: the row written is always theirs,
 * at a fresh key, scanned before the gate accepts it, and never another user's row.
 */
export async function persistUploadedGenerationSource(input: {
  userId: number;
  appId: string;
  /** The block token's `appBlockId` claim, for the gate the scan wait asks. */
  appBlockId: string;
  url: string;
  /** The request budget; {@link GENERATION_SOURCE_DEADLINE_MS} unless a test shortens it. */
  budgetMs?: number;
}): Promise<PersistedGenerationSource> {
  const blobId = uploadedSourceBlobId(input.url);
  if (!blobId) throw new TRPCError({ code: 'BAD_REQUEST', message: UPLOADED_SOURCE_URL_MESSAGE });
  return withinGenerationSourceBudget(input.budgetMs, ({ deadline, signal }) =>
    keepGenerationSource({
      userId: input.userId,
      appId: input.appId,
      appBlockId: input.appBlockId,
      ref: `upload:${blobId}`,
      imageUrl: input.url,
      // Measured from the bytes: a blob carries no dimensions we trust.
      width: null,
      height: null,
      deadline,
      signal,
    })
  );
}
