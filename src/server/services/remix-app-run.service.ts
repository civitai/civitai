import { createHash } from 'node:crypto';
import type { NsfwLevel, Workflow } from '@civitai/orchestration-client';
import { TRPCError } from '@trpc/server';
import { bustQueriedWorkflowsCache } from '~/server/services/orchestrator/orchestration-new.service';
import {
  submitPresetImageGen,
  whatIfPresetImageGen,
} from '~/server/services/orchestrator/preset-image-gen.service';
import { signProvenance, verifyProvenance } from '~/server/services/orchestrator/remix-provenance';
import { queryWorkflows } from '~/server/services/orchestrator/workflows';
import {
  assertInputsUsable,
  buildRuntimeRequest,
  loadSource,
  runtimeSourceOf,
  viewerOf,
  type RemixAppCaller,
} from '~/server/services/remix-app.service';
import { getAllowedAccountTypes } from '~/server/utils/buzz-helpers';
import type { RemixAnswer, RemixApp, RemixAsk, RemixImage } from '~/shared/remix-apps/define';
import { remixAnswerRefusal, replayRemixApp, type RemixLogEntry } from '~/shared/remix-apps/replay';
import { getRuntimeRemixApp } from '~/shared/remix-apps/system-apps';
import { orchestratorRefundableStatuses } from '~/shared/constants/generation.constants';
import { isMature } from '~/shared/constants/orchestrator.constants';
import type { RemixSourceImage } from '~/shared/utils/remix-tier';

export const REMIX_APP_TAG = 'remix-app';
export const REMIX_DONE_TAG = 'remix:done';
export const REMIX_DISMISSED_TAG = 'remix:dismissed';
const RUN_TAG = 'remix-run:';
const SEGMENT_TAG = 'remix-seg:';
const appTag = (slug: string) => `${REMIX_APP_TAG}:${slug}`;

export const MAX_RUN_SEGMENTS = 8;
const RUN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type RemixRunMetadata = { app: string; version: number; answers: RemixAnswer[] };

export type RemixRunState =
  | { status: 'running'; runId: string; workflowId: string }
  | { status: 'ask'; runId: string; ask: RemixAsk }
  | { status: 'priced'; runId: string; cost: number; ready: boolean }
  | { status: 'done'; runId: string; workflowId: string; outputs: RemixImage[] }
  | { status: 'failed'; runId: string; workflowId: string; reason: string };

const digest = (parts: unknown[], length: number) =>
  createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, length);

/** One tap (one nonce) is one run, so a repeated start finds the run it already made. */
export function remixRunId(args: { userId: number; slug: string; imageId: number; nonce: string }) {
  return `r${digest([args.userId, args.slug, args.imageId, args.nonce], 20)}`;
}

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

function tagValue(workflow: Workflow, prefix: string) {
  return workflow.tags?.find((tag) => tag.startsWith(prefix))?.slice(prefix.length);
}

async function readRun(runId: string, caller: RemixAppCaller): Promise<Segment[]> {
  const { items } = await queryWorkflows({
    token: caller.token,
    tags: [RUN_TAG + runId],
    take: MAX_RUN_SEGMENTS + 1,
    hideMatureContent: false,
  });
  const segments = items.map((workflow): Segment => {
    const index = Number(tagValue(workflow, SEGMENT_TAG));
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
  const pending = [...answers];
  let outcome = await replayRemixApp(app, source, log);
  while (outcome.status === 'effect' && outcome.effect.type === 'ask' && pending.length) {
    const answer = pending.shift() as RemixAnswer;
    const refusal = remixAnswerRefusal(outcome.effect.spec, answer);
    if (refusal) throw new TRPCError({ code: 'BAD_REQUEST', message: refusal });
    log.push({ type: 'ask', answer });
    outcome = await replayRemixApp(app, source, log);
  }
  if (pending.length) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Too many answers' });

  if (outcome.status === 'done') {
    const workflowId = segments[segments.length - 1]?.workflow.id as string;
    // The run reads every blob so the next segment can use it; what it shows follows the viewer.
    const hideMature = caller.isGreenDomain || !caller.user.showNsfw;
    const outputs = hideMature
      ? outcome.outputs.filter((image) => !isMature(levels.get(image.url)))
      : outcome.outputs;
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

  const tags = [REMIX_APP_TAG, appTag(app.slug), RUN_TAG + runId, SEGMENT_TAG + index];
  const remixRun: RemixRunMetadata = { app: app.slug, version: app.version, answers };
  // A segment after the first reads the previous segment's output, which carries no source; the
  // mint names it again so the graph signs it into this segment's metadata and output files.
  const mint = signProvenance({ userId: caller.user.id, sourceImageIds: [image.id], kind: 'mint' });
  const result = await submitPresetImageGen({
    ...run.submit,
    user: caller.user,
    token: caller.token,
    flags: caller.features,
    currencies,
    tags: caller.isGreenDomain ? ['green', ...tags] : tags,
    isGreen: caller.features.isGreen,
    allowMatureContent: caller.isGreenDomain || !caller.user.showNsfw ? false : undefined,
    track: caller.track,
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

export type RemixRunSummary = {
  runId: string;
  slug: string;
  workflowId: string;
  status: Workflow['status'];
  segments: number;
  createdAt: string;
};

/** The viewer's runs from the last week that were neither posted nor dismissed. */
export async function listRemixRuns({ caller }: { caller: RemixAppCaller }) {
  const { items } = await queryWorkflows({
    token: caller.token,
    tags: [REMIX_APP_TAG],
    take: 100,
    fromDate: new Date(Date.now() - RUN_WINDOW_MS),
    hideMatureContent: false,
  });
  const latest = new Map<string, { workflow: Workflow; index: number; count: number }>();
  for (const workflow of items) {
    const runId = tagValue(workflow, RUN_TAG);
    const index = Number(tagValue(workflow, SEGMENT_TAG));
    if (!runId || !Number.isInteger(index)) continue;
    const seen = latest.get(runId);
    if (!seen || index > seen.index)
      latest.set(runId, { workflow, index, count: (seen?.count ?? 0) + 1 });
    else seen.count++;
  }
  const runs: RemixRunSummary[] = [];
  for (const [runId, { workflow, count }] of latest) {
    const tags = workflow.tags ?? [];
    if (tags.includes(REMIX_DONE_TAG) || tags.includes(REMIX_DISMISSED_TAG)) continue;
    const slug = readMeta(workflow)?.app;
    if (!slug) continue;
    runs.push({
      runId,
      slug,
      workflowId: workflow.id as string,
      status: workflow.status,
      segments: count,
      createdAt: workflow.createdAt,
    });
  }
  return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
