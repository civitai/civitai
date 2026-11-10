import { createHash } from 'node:crypto';
import type { NsfwLevel, Workflow } from '@civitai/orchestration-client';
import { TRPCError } from '@trpc/server';
import {
  bustQueriedWorkflowsCache,
  normalizeStepOutput,
} from '~/server/services/orchestrator/orchestration-new.service';
import {
  submitPresetImageGen,
  whatIfPresetImageGen,
} from '~/server/services/orchestrator/preset-image-gen.service';
import { signProvenance, verifyProvenance } from '~/server/services/orchestrator/remix-provenance';
import {
  getWorkflow,
  patchWorkflows,
  patchWorkflowTags,
  queryWorkflows,
} from '~/server/services/orchestrator/workflows';
import {
  createHeadlessPost,
  type HeadlessPostGallery,
} from '~/server/services/headless-post.service';
import type { ProtectedContext } from '~/server/createContext';
import { logToAxiom } from '~/server/logging/client';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import {
  assertInputsUsable,
  assertWithinQuote,
  buildRuntimeRequest,
  loadSource,
  remixRunId,
  remixSubmitArgs,
  remixWhatIfArgs,
  runtimeSourceOf,
  viewerOf,
  type RemixAppCaller,
} from '~/server/services/remix-app.service';
import { getRegisteredRemixApp } from '~/server/services/remix-app-registry.service';
import { getAllowedAccountTypes } from '~/server/utils/buzz-helpers';
import type {
  RemixAnswer,
  RemixApp,
  RemixAppSource,
  RemixAsk,
  RemixImage,
  RemixViewerAsk,
} from '~/shared/remix-apps/define';
import { remixOptionEffects } from '~/shared/remix-apps/mock-host';
import { isDefined } from '~/utils/type-guards';
import {
  remixAnswerRefusal,
  RemixReplayError,
  replayRemixApp,
  type RemixLogEntry,
} from '~/shared/remix-apps/replay';
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

export type RemixRunMetadata = {
  app: string;
  version: number;
  /** Answers given before this segment's workflow. */
  answers: RemixAnswer[];
  /** Answers given after it, when the run finished on them with no further workflow. */
  tail?: RemixAnswer[];
};

export type RemixRunState =
  | { status: 'running'; runId: string; workflowId: string }
  | {
      status: 'ask';
      runId: string;
      ask: RemixViewerAsk;
      /** A choice's price per option value: 0 when it finishes the run, absent when unknown. */
      prices?: Record<string, number>;
    }
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
  const answers = readAnswers(raw.answers) ?? [];
  const tail = readAnswers(raw.tail);
  return { app: raw.app, version: raw.version, answers, ...(tail?.length ? { tail } : {}) };
}

function readAnswers(raw: unknown): RemixAnswer[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.filter((a): a is RemixAnswer => typeof a === 'string' || typeof a === 'number');
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

/** Read through the generator queue's normalizer: an upscale is a comfy step that returns `blobs`, not `images`. */
export function outputImages(workflow: Workflow): RunImage[] {
  return (workflow.steps ?? [])
    .flatMap((step) => normalizeStepOutput(step as Parameters<typeof normalizeStepOutput>[0]))
    .flatMap((blob) =>
      blob.type === 'image' && blob.url && blob.available !== false && !blob.blockedReason
        ? [
            {
              url: blob.url,
              width: blob.width ?? undefined,
              height: blob.height ?? undefined,
              nsfwLevel: blob.nsfwLevel,
            },
          ]
        : []
    );
}

type Gate = 'shown' | 'hidden' | 'unrated';

/** Whether the viewer may see an output: the blob is the run's either way. */
function gateOf(
  url: string,
  levels: Map<string, NsfwLevel | undefined>,
  caller: RemixAppCaller
): Gate {
  // A url this run never generated has no rating to go on, for any viewer.
  if (!levels.has(url)) return 'hidden';
  if (!caller.isGreenDomain && caller.user.showNsfw) return 'shown';
  // Fails closed: a rating not landed yet is neither shown nor hidden.
  if (levels.has(url) && levels.get(url) == null) return 'unrated';
  return isMature(levels.get(url)) ? 'hidden' : 'shown';
}

/** What the viewer may see of `outputs`; undefined while one is not rated yet (fails closed). */
function visibleOutputs<T extends { url: string }>(
  outputs: T[],
  levels: Map<string, NsfwLevel | undefined>,
  caller: RemixAppCaller
): T[] | undefined {
  const gates = outputs.map(({ url }) => gateOf(url, levels, caller));
  if (gates.includes('unrated')) return undefined;
  return outputs.filter((_, i) => gates[i] === 'shown');
}

/** A pick's images as the viewer gets them; undefined while one is not rated yet. */
function viewerPick(
  images: RemixImage[],
  levels: Map<string, NsfwLevel | undefined>,
  caller: RemixAppCaller
): (RemixImage | null)[] | undefined {
  const gates = images.map(({ url }) => gateOf(url, levels, caller));
  if (gates.includes('unrated')) return undefined;
  return images.map((image, i) => (gates[i] === 'shown' ? image : null));
}

/**
 * Each option's price, from a what-if on the workflow answering it leads to: what the button
 * shows, and the quote its tap sends. An option the host cannot price is left out, and its tap
 * prices before it submits.
 */
async function optionPrices({
  app,
  image,
  source,
  log,
  spec,
  caller,
  currencies,
}: {
  app: RemixApp;
  image: RemixSourceImage;
  source: RemixAppSource;
  log: RemixLogEntry[];
  spec: Extract<RemixAsk, { kind: 'choice' }>;
  caller: RemixAppCaller;
  currencies: ReturnType<typeof getAllowedAccountTypes>;
}) {
  const effects = await remixOptionEffects(app, source, log, spec);
  const priced = await Promise.all(
    effects.map(async ({ value, next }) => {
      if (!next) return [value, 0] as const;
      if (next.type !== 'workflow') return undefined;
      try {
        const run = buildRuntimeRequest({
          app,
          image,
          request: next.request,
          viewer: viewerOf(caller),
        });
        const { cost } = await whatIfPresetImageGen({
          graphInput: run.graphInput,
          ...remixWhatIfArgs(caller, currencies),
        });
        return [value, cost] as const;
      } catch {
        return undefined;
      }
    })
  );
  return Object.fromEntries(priced.filter(isDefined));
}

const NONE_SHOWN = 'None of the results can be shown here.';
const OPTION_PRICES_TTL_SECONDS = 5 * 60;

/** Prices for one open ask: a repeated advance at it re-prices nothing. */
async function cachedOptionPrices(
  [runId, segment, step]: [string, number, number],
  price: () => Promise<Record<string, number>>
) {
  const key = `${REDIS_SYS_KEYS.REMIX_APP.OPTION_PRICES}:${runId}:${segment}:${step}` as const;
  const cached = await sysRedis.get(key).catch(() => null);
  if (cached) return JSON.parse(cached) as Record<string, number>;
  const prices = await price();
  await sysRedis
    .set(key, JSON.stringify(prices), { EX: OPTION_PRICES_TTL_SECONDS })
    .catch(() => undefined);
  return prices;
}

const isSameAnswers = (a: RemixAnswer[], b: RemixAnswer[]) =>
  a.length === b.length && a.every((answer, i) => answer === b[i]);

function recordTail(workflowId: string, tail: RemixAnswer[], caller: RemixAppCaller) {
  return patchWorkflows({
    token: caller.token,
    input: [{ workflowId, patches: [{ op: 'add', path: '/metadata/remixRun/tail', value: tail }] }],
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
  answers: given,
  quote,
  caller,
  priceOptions = true,
}: {
  runId: string;
  app: RemixApp;
  image: RemixSourceImage;
  segments: Segment[];
  answers: RemixAnswer[];
  quote?: number;
  caller: RemixAppCaller;
  /** Off where only whether the run finished matters. */
  priceOptions?: boolean;
}): Promise<RemixRunState> {
  let answers = given;
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
  const last = segments[segments.length - 1];
  const tail = last?.meta.tail ?? [];
  for (const answer of tail) log.push({ type: 'ask', answer });
  // A repeat of the answers that finished the run, already recorded.
  if (tail.length && isSameAnswers(answers, tail)) answers = [];

  const source = runtimeSourceOf(image);
  const currencies = getAllowedAccountTypes(caller.features, ['blue']);
  const replay = () =>
    replayRemixApp(app, source, log).catch((error) => {
      throw error instanceof RemixReplayError ? damaged(error.message) : error;
    });
  const pending = [...answers];
  let outcome = await replay();
  while (outcome.status === 'effect' && outcome.effect.type === 'ask' && pending.length) {
    const answer = pending.shift() as RemixAnswer;
    const { spec } = outcome.effect;
    const refusal =
      remixAnswerRefusal(spec, answer) ??
      // Only an image the viewer was shown can be picked.
      (spec.kind === 'pick' && !viewerPick(spec.images, levels, caller)?.[answer as number]
        ? 'Not one of the images'
        : undefined);
    if (refusal) throw new TRPCError({ code: 'BAD_REQUEST', message: refusal });
    log.push({ type: 'ask', answer });
    outcome = await replay();
  }
  if (pending.length) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Too many answers' });

  if (outcome.status === 'done') {
    if (!last) throw damaged('it finished without running anything');
    const workflowId = last.workflow.id as string;
    // No later segment will record these answers, so the latest one keeps them, or a reload would
    // ask them again.
    if (answers.length) await recordTail(workflowId, [...tail, ...answers], caller);
    // The run reads every blob so the next segment can use it; what it shows follows the viewer.
    const outputs = visibleOutputs(outcome.outputs, levels, caller);
    // An output not rated yet keeps the run running until the scan lands.
    if (!outputs) return { status: 'running', runId, workflowId };
    return { status: 'done', runId, workflowId, outputs };
  }
  if (outcome.effect.type === 'ask') {
    const { spec } = outcome.effect;
    const workflowId = last?.workflow.id as string;
    if (spec.kind === 'pick') {
      // The same gate as a finished run's outputs: these urls reach the viewer too.
      const images = viewerPick(spec.images, levels, caller);
      if (!images) return { status: 'running', runId, workflowId };
      if (!images.some(Boolean)) return { status: 'failed', runId, workflowId, reason: NONE_SHOWN };
      return { status: 'ask', runId, ask: { ...spec, images } };
    }
    if (spec.kind !== 'choice') return { status: 'ask', runId, ask: spec };
    // The same gate again, failing closed: an image not rated yet is left off rather than waited on.
    const { image: shown, ...choice } = spec;
    const ask =
      shown && gateOf(shown.url, levels, caller) === 'shown' ? { ...choice, image: shown } : choice;
    if (!priceOptions) return { status: 'ask', runId, ask };
    const prices = await cachedOptionPrices([runId, segments.length, outcome.index], () =>
      optionPrices({ app, image, source, log, spec, caller, currencies })
    );
    return { status: 'ask', runId, ask, prices };
  }

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

  const priced = await whatIfPresetImageGen({
    graphInput: run.graphInput,
    ...remixWhatIfArgs(caller, currencies),
  });
  if (quote == null) return { status: 'priced', runId, ...priced };
  assertWithinQuote(priced.cost, quote);

  const tags = remixRunTags({ slug: app.slug, runId, segment: index, runtime: true });
  const remixRun: RemixRunMetadata = { app: app.slug, version: app.version, answers };
  // A segment after the first reads the previous segment's output, which carries no source; the
  // mint names it again so the graph signs it into this segment's metadata and output files.
  const mint = signProvenance({ userId: caller.user.id, sourceImageIds: [image.id], kind: 'mint' });
  const result = await submitPresetImageGen({
    graphInput: run.graphInput,
    ...remixSubmitArgs(caller, tags, currencies),
    remixOfId: image.id,
    externalId: segmentExternalId(caller.user.id, runId, index),
    sourceProvenance: mint ? [mint] : undefined,
    remixRun,
  });
  bustQueriedWorkflowsCache(caller.user.id).catch(() => null);
  return { status: 'running', runId, workflowId: result.id as string };
}

/**
 * `answers`: to asks before the app's first workflow, which records them when it submits.
 * `allowDisabled`: a mod's test run of an app the menu does not list yet.
 */
export async function startRemixRun({
  slug,
  imageId,
  nonce,
  answers = [],
  quote,
  caller,
  allowDisabled = false,
}: {
  slug: string;
  imageId: number;
  nonce: string;
  answers?: RemixAnswer[];
  quote?: number;
  caller: RemixAppCaller;
  allowDisabled?: boolean;
}) {
  const { app } = await getRegisteredRemixApp(slug, { allowDisabled });
  const image = await loadSource(imageId, caller, true);
  const runId = remixRunId({ userId: caller.user.id, slug, imageId, nonce });
  const segments = await readRun(runId, caller);
  // Started already: its first workflow holds these answers, and a repeat tap only reloads it.
  const given = segments.length ? [] : answers;
  return advance({ runId, app, image, segments, answers: given, quote, caller });
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
  const { segments, app, image } = await loadRun(runId, caller);
  return advance({ runId, app, image, segments, answers, quote, caller });
}

async function loadRun(runId: string, caller: RemixAppCaller) {
  const segments = await readRun(runId, caller);
  if (!segments.length) throw new TRPCError({ code: 'NOT_FOUND', message: 'Remix not found' });
  const { meta } = segments[segments.length - 1];
  const changed = () => damaged('the app changed since it started. Start it again from the image.');
  // A disabled app's run still finishes: it was paid for.
  const { app } = await getRegisteredRemixApp(meta.app, { allowDisabled: true }).catch((error) => {
    throw error instanceof TRPCError && error.code === 'NOT_FOUND' ? changed() : error;
  });
  if (app.version !== meta.version) throw changed();
  const image = await loadSource(runSourceId(segments), caller, true);
  return { segments, app, image };
}

type PostableResult = {
  /** The run's latest workflow: where the tray reads `remix:done`. */
  workflowId: string;
  /** Each output with the workflow that made it, which `addPostImage` verifies provenance from. */
  media: { workflowId: string; url: string; width?: number; height?: number }[];
  sourceId: unknown;
  idempotencyKey: string;
};

const stillChecking = () =>
  new TRPCError({
    code: 'PRECONDITION_FAILED',
    message: 'This result is still being checked. Try again in a moment.',
  });
const notFinished = () =>
  new TRPCError({ code: 'BAD_REQUEST', message: 'This remix has not finished.' });

/** A one-shot remix: everything its one workflow made. */
async function workflowResult(workflowId: string, caller: RemixAppCaller): Promise<PostableResult> {
  const workflow = await getWorkflow({ token: caller.token, path: { workflowId } });
  if (!workflow?.tags?.includes(REMIX_APP_TAG))
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Remix not found' });
  if (workflow.status !== 'succeeded') throw notFinished();

  const images = outputImages(workflow);
  const levels = new Map(images.map(({ url, nsfwLevel }) => [url, nsfwLevel]));
  const outputs = visibleOutputs(images, levels, caller);
  if (!outputs) throw stillChecking();
  return {
    workflowId,
    media: outputs.map(({ url, width, height }) => ({ workflowId, url, width, height })),
    sourceId: (workflow.metadata as Record<string, unknown> | undefined)?.remixOfId,
    idempotencyKey: `remix:${workflowId}`,
  };
}

/** A runtime run: what the app returned, which may be fewer than its last workflow made. */
async function runResult(runId: string, caller: RemixAppCaller): Promise<PostableResult> {
  const { segments, app, image } = await loadRun(runId, caller);
  // No quote: replaying a run that has not finished can price its next step, never submit it.
  const state = await advance({
    runId,
    app,
    image,
    segments,
    answers: [],
    caller,
    priceOptions: false,
  });
  if (state.status !== 'done') {
    const settled = segments.every(({ workflow }) => workflow.status === 'succeeded');
    throw state.status === 'running' && settled ? stillChecking() : notFinished();
  }
  const madeBy = new Map(
    segments.flatMap(({ workflow }) =>
      outputImages(workflow).map(({ url }) => [url, workflow.id as string] as const)
    )
  );
  return {
    workflowId: state.workflowId,
    media: state.outputs.map(({ url, width, height }) => ({
      workflowId: madeBy.get(url) ?? state.workflowId,
      url,
      width,
      height,
    })),
    sourceId: image.id,
    idempotencyKey: `remix:${runId}`,
  };
}

/**
 * Posts a finished remix's outputs, published, without the editor, and takes the run off the tray.
 * The outputs are read from the viewer's own workflows, never sent by the client. A second tap
 * returns the first post.
 */
export async function postRemixResult({
  workflowId: oneShot,
  runId,
  gallery,
  caller,
  ctx,
}: {
  gallery?: HeadlessPostGallery;
  caller: RemixAppCaller;
  ctx: ProtectedContext;
} & ({ workflowId: string; runId?: undefined } | { runId: string; workflowId?: undefined })) {
  const { workflowId, media, sourceId, idempotencyKey } = runId
    ? await runResult(runId, caller)
    : await workflowResult(oneShot as string, caller);
  if (!media.length)
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Nothing from this remix can be posted.' });

  // Only a sanity check: whether this remix may go in free is the gallery's own decision, from the
  // provenance `addPostImage` verified onto the new image.
  const galleryHost = gallery && gallery.hostImageId === sourceId ? gallery : undefined;

  const result = await createHeadlessPost({
    ctx,
    media,
    publish: true,
    remixGallery: galleryHost,
    idempotencyKey,
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
