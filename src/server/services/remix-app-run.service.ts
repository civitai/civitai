import { createHash } from 'node:crypto';
import type { NsfwLevel, Workflow } from '@civitai/orchestration-client';
import { TRPCError } from '@trpc/server';
import { bustQueriedWorkflowsCache } from '~/server/services/orchestrator/orchestration-new.service';
import {
  submitPresetImageGen,
  whatIfPresetImageGen,
} from '~/server/services/orchestrator/preset-image-gen.service';
import { signProvenance, verifyProvenance } from '~/server/services/orchestrator/remix-provenance';
import {
  getWorkflow,
  patchWorkflowTags,
  queryWorkflows,
} from '~/server/services/orchestrator/workflows';
import {
  createHeadlessPost,
  type HeadlessPostGallery,
} from '~/server/services/headless-post.service';
import type { ProtectedContext } from '~/server/createContext';
import { logToAxiom } from '~/server/logging/client';
import {
  assertInputsUsable,
  buildRuntimeRequest,
  loadSource,
  remixRunId,
  remixSubmitArgs,
  runtimeSourceOf,
  viewerOf,
  type RemixAppCaller,
} from '~/server/services/remix-app.service';
import { getAllowedAccountTypes } from '~/server/utils/buzz-helpers';
import type { RemixAnswer, RemixApp, RemixAsk, RemixImage } from '~/shared/remix-apps/define';
import {
  remixAnswerRefusal,
  RemixReplayError,
  replayRemixApp,
  type RemixLogEntry,
} from '~/shared/remix-apps/replay';
import { getRuntimeRemixApp } from '~/shared/remix-apps/system-apps';
import {
  readRemixTag,
  REMIX_APP_TAG,
  REMIX_DONE_TAG,
  REMIX_RUN_TAG_PREFIX,
  REMIX_SEGMENT_TAG_PREFIX,
  remixRunTags,
} from '~/shared/remix-apps/tags';
import { orchestratorRefundableStatuses } from '~/shared/constants/generation.constants';
import { isMature } from '~/shared/constants/orchestrator.constants';
import type { RemixSourceImage } from '~/shared/utils/remix-tier';

export const MAX_RUN_SEGMENTS = 8;

export type RemixRunMetadata = { app: string; version: number; answers: RemixAnswer[] };

export type RemixRunState =
  | { status: 'running'; runId: string; workflowId: string }
  | { status: 'ask'; runId: string; ask: RemixAsk }
  | { status: 'priced'; runId: string; cost: number; ready: boolean }
  | { status: 'done'; runId: string; workflowId: string; outputs: RemixImage[] }
  | { status: 'failed'; runId: string; workflowId: string; reason: string };

const digest = (parts: unknown[], length: number) =>
  createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, length);

export const REMIX_RUN_ID = /^r[0-9a-f]{20}$/;

/** The orchestrator dedupes on (user, externalId): a repeated advance submits a segment once. */
function segmentExternalId(userId: number, runId: string, segment: number) {
  // The orchestrator only accepts [A-Za-z0-9_-] in an externalId.
  return `remix-run_${digest([userId, runId, segment], 32)}`;
}

type Segment = {
  index: number;
  workflow: Workflow;
  meta: RemixRunMetadata;
  /** From the segment's own signed provenance, never from its user-writable metadata. */
  sourceImageIds: number[];
};

const damaged = (detail: string) =>
  new TRPCError({ code: 'CONFLICT', message: `This remix can't continue: ${detail}` });

function readMeta(workflow: Workflow): RemixRunMetadata | undefined {
  const raw = (workflow.metadata as Record<string, unknown> | undefined)?.remixRun as
    | Partial<RemixRunMetadata>
    | undefined;
  if (!raw || typeof raw.app !== 'string' || typeof raw.version !== 'number') return undefined;
  const answers = Array.isArray(raw.answers)
    ? raw.answers.filter((a) => typeof a === 'string' || typeof a === 'number')
    : [];
  return { app: raw.app, version: raw.version, answers };
}

async function readRun(runId: string, caller: RemixAppCaller): Promise<Segment[]> {
  const { items } = await queryWorkflows({
    token: caller.token,
    tags: [REMIX_RUN_TAG_PREFIX + runId],
    take: MAX_RUN_SEGMENTS + 1,
    hideMatureContent: false,
  });
  const segments = items.map((workflow): Segment => {
    const index = Number(readRemixTag(workflow.tags, REMIX_SEGMENT_TAG_PREFIX));
    const meta = readMeta(workflow);
    if (!Number.isInteger(index) || !meta) throw damaged('a step is missing its run details');
    const provenance = (workflow.metadata as Record<string, unknown> | undefined)?.provenance;
    const sourceImageIds = verifyProvenance(provenance, caller.user.id) ?? [];
    return { index, workflow, meta, sourceImageIds };
  });
  segments.sort((a, b) => a.index - b.index);
  segments.forEach((segment, i) => {
    if (segment.index !== i) throw damaged('a step was deleted');
  });
  return segments;
}

/** The source every segment's signed provenance vouches for. */
function runSourceId(segments: Segment[]) {
  const claimed = (segments[0].workflow.metadata as Record<string, unknown> | undefined)?.remixOfId;
  if (typeof claimed !== 'number') throw damaged('its source image is unknown');
  if (!segments.every((s) => s.sourceImageIds.includes(claimed)))
    throw damaged('its source image could not be verified');
  return claimed;
}

type RunImage = RemixImage & { nsfwLevel?: NsfwLevel };

function outputImages(workflow: Workflow): RunImage[] {
  return (workflow.steps ?? []).flatMap((step) => {
    const images = ((step as { output?: { images?: unknown[] } }).output?.images ?? []) as {
      url?: string | null;
      width?: number | null;
      height?: number | null;
      available?: boolean | null;
      blockedReason?: string | null;
      nsfwLevel?: NsfwLevel;
    }[];
    return images
      .filter((image) => image.url && image.available !== false && !image.blockedReason)
      .map(({ url, width, height, nsfwLevel }) => ({
        url: url as string,
        width: width ?? undefined,
        height: height ?? undefined,
        nsfwLevel,
      }));
  });
}

/** What the viewer may see of `outputs`; undefined while one is not rated yet (fails closed). */
function visibleOutputs<T extends { url: string }>(
  outputs: T[],
  levels: Map<string, NsfwLevel | undefined>,
  caller: RemixAppCaller
): T[] | undefined {
  if (!caller.isGreenDomain && caller.user.showNsfw) return outputs;
  if (outputs.some(({ url }) => levels.has(url) && levels.get(url) == null)) return undefined;
  return outputs.filter(({ url }) => !isMature(levels.get(url)));
}

/**
 * Replays the app over the run so far and does the one thing the code reaches next: report a
 * segment still running, return an ask, price the next workflow, or submit it. `answers` are the
 * answers given since the latest segment, in order.
 */
async function advance({
  runId,
  app,
  image,
  segments,
  answers,
  quote,
  caller,
}: {
  runId: string;
  app: RemixApp;
  image: RemixSourceImage;
  segments: Segment[];
  answers: RemixAnswer[];
  quote?: number;
  caller: RemixAppCaller;
}): Promise<RemixRunState> {
  const log: RemixLogEntry[] = [];
  const levels = new Map<string, NsfwLevel | undefined>();
  for (const segment of segments) {
    for (const answer of segment.meta.answers) log.push({ type: 'ask', answer });
    const { status, id } = segment.workflow;
    const workflowId = id as string;
    if (orchestratorRefundableStatuses.includes(status))
      return { status: 'failed', runId, workflowId, reason: `This step ${status}.` };
    if (status !== 'succeeded') return { status: 'running', runId, workflowId };
    const images = outputImages(segment.workflow);
    if (!images.length)
      return { status: 'failed', runId, workflowId, reason: 'This step has no usable output.' };
    for (const { url, nsfwLevel } of images) levels.set(url, nsfwLevel);
    log.push({
      type: 'workflow',
      result: { workflowId, images: images.map(({ nsfwLevel: _, ...image }) => image) },
    });
  }

  const source = runtimeSourceOf(image);
  const replay = () =>
    replayRemixApp(app, source, log).catch((error) => {
      throw error instanceof RemixReplayError ? damaged(error.message) : error;
    });
  const pending = [...answers];
  let outcome = await replay();
  while (outcome.status === 'effect' && outcome.effect.type === 'ask' && pending.length) {
    const answer = pending.shift() as RemixAnswer;
    const refusal = remixAnswerRefusal(outcome.effect.spec, answer);
    if (refusal) throw new TRPCError({ code: 'BAD_REQUEST', message: refusal });
    log.push({ type: 'ask', answer });
    outcome = await replay();
  }
  if (pending.length) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Too many answers' });

  if (outcome.status === 'done') {
    const workflowId = segments[segments.length - 1]?.workflow.id as string;
    // The run reads every blob so the next segment can use it; what it shows follows the viewer.
    const outputs = visibleOutputs(outcome.outputs, levels, caller);
    // An output not rated yet keeps the run running until the scan lands.
    if (!outputs) return { status: 'running', runId, workflowId };
    return { status: 'done', runId, workflowId, outputs };
  }
  if (outcome.effect.type === 'ask') return { status: 'ask', runId, ask: outcome.effect.spec };

  const index = segments.length;
  if (index >= MAX_RUN_SEGMENTS) throw damaged('it has too many steps');
  const run = buildRuntimeRequest({
    app,
    image,
    request: outcome.effect.request,
    viewer: viewerOf(caller),
  });
  // The graph submit skips its own input gate ('checked-by-caller').
  await assertInputsUsable(run.inputUrls, caller, 'remixAppRun');

  const currencies = getAllowedAccountTypes(caller.features, ['blue']);
  const priced = await whatIfPresetImageGen({
    ...run.submit,
    user: caller.user,
    token: caller.token,
    currencies,
    flags: caller.features,
  });
  if (quote == null) return { status: 'priced', runId, ...priced };
  if (priced.cost > quote)
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: `The price changed to ${priced.cost.toLocaleString()} Buzz. Check it and run again.`,
    });

  const tags = remixRunTags({ slug: app.slug, runId, segment: index });
  const remixRun: RemixRunMetadata = { app: app.slug, version: app.version, answers };
  // A segment after the first reads the previous segment's output, which carries no source; the
  // mint names it again so the graph signs it into this segment's metadata and output files.
  const mint = signProvenance({ userId: caller.user.id, sourceImageIds: [image.id], kind: 'mint' });
  const result = await submitPresetImageGen({
    ...run.submit,
    ...remixSubmitArgs(caller, tags, currencies),
    remixOfId: image.id,
    externalId: segmentExternalId(caller.user.id, runId, index),
    sourceProvenance: mint ? [mint] : undefined,
    remixRun,
  });
  bustQueriedWorkflowsCache(caller.user.id).catch(() => null);
  return { status: 'running', runId, workflowId: result.id as string };
}

export async function startRemixRun({
  slug,
  imageId,
  nonce,
  quote,
  caller,
}: {
  slug: string;
  imageId: number;
  nonce: string;
  quote?: number;
  caller: RemixAppCaller;
}) {
  const app = getRuntimeRemixApp(slug);
  if (!app) throw new TRPCError({ code: 'NOT_FOUND', message: 'Remix app not found' });
  const image = await loadSource(imageId, caller, true);
  const runId = remixRunId({ userId: caller.user.id, slug, imageId, nonce });
  const segments = await readRun(runId, caller);
  return advance({ runId, app, image, segments, answers: [], quote, caller });
}

export async function advanceRemixRun({
  runId,
  answers = [],
  quote,
  caller,
}: {
  runId: string;
  answers?: RemixAnswer[];
  quote?: number;
  caller: RemixAppCaller;
}) {
  const segments = await readRun(runId, caller);
  if (!segments.length) throw new TRPCError({ code: 'NOT_FOUND', message: 'Remix not found' });
  const { meta } = segments[segments.length - 1];
  const app = getRuntimeRemixApp(meta.app);
  if (!app || app.version !== meta.version)
    throw damaged('the app changed since it started. Start it again from the image.');
  const image = await loadSource(runSourceId(segments), caller, true);
  return advance({ runId, app, image, segments, answers, quote, caller });
}

/**
 * Posts a finished remix's outputs, published, without the editor, and takes the run off the tray.
 * The outputs are read from the viewer's own workflow, never sent by the client. A second tap
 * returns the first post.
 */
export async function postRemixResult({
  workflowId,
  gallery,
  caller,
  ctx,
}: {
  workflowId: string;
  gallery?: HeadlessPostGallery;
  caller: RemixAppCaller;
  ctx: ProtectedContext;
}) {
  const workflow = await getWorkflow({ token: caller.token, path: { workflowId } });
  if (!workflow?.tags?.includes(REMIX_APP_TAG))
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Remix not found' });
  if (workflow.status !== 'succeeded')
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'This remix has not finished.' });

  const images = outputImages(workflow);
  const levels = new Map(images.map(({ url, nsfwLevel }) => [url, nsfwLevel]));
  const outputs = visibleOutputs(images, levels, caller);
  if (!outputs)
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'This result is still being checked. Try again in a moment.',
    });
  if (!outputs.length)
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Nothing from this remix can be posted.' });

  // Only a sanity check: whether this remix may go in free is the gallery's own decision, from the
  // provenance `addPostImage` verified onto the new image.
  const sourceId = (workflow.metadata as Record<string, unknown> | undefined)?.remixOfId;
  const galleryHost = gallery && gallery.hostImageId === sourceId ? gallery : undefined;

  const result = await createHeadlessPost({
    ctx,
    media: outputs.map(({ url, width, height }) => ({ workflowId, url, width, height })),
    publish: true,
    remixGallery: galleryHost,
    idempotencyKey: `remix:${workflowId}`,
    surface: 'remix-app',
  });
  if (gallery && !galleryHost)
    result.gallery = { submitted: false, reason: "This isn't a remix of that image." };

  await patchWorkflowTags({
    token: caller.token,
    input: [{ workflowId, tag: REMIX_DONE_TAG, op: 'add' }],
  }).catch((error) =>
    logToAxiom({
      name: 'remix-app-run',
      type: 'warning',
      message: `posted, but ${REMIX_DONE_TAG} was not added: ${(error as Error).message}`,
      details: { workflowId, postId: result.postId },
    }).catch(() => undefined)
  );
  bustQueriedWorkflowsCache(caller.user.id).catch(() => null);
  return result;
}
