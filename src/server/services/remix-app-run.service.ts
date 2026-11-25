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
import {
  classifyPromptServer,
  type PromptClassification,
} from '~/server/services/orchestrator/promptAuditing';
import { isOverLengthRefusal } from '~/utils/metadata/audit';
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
import { REDIS_KEYS, redis } from '~/server/redis/client';
import { clusterCacheGuard } from '~/server/redis/cluster-cache-guard';
import {
  assertInputsUsable,
  assertWithinQuote,
  buildRuntimeRequest,
  loadReference,
  loadSource,
  remixRunId,
  remixSubmitArgs,
  remixWhatIfArgs,
  runtimeSourceOf,
  viewerOf,
  type RemixAppCaller,
} from '~/server/services/remix-app.service';
import {
  getRegisteredRemixApp,
  holdUserRemixApp,
  isRunnableBy,
  noteRunnerQuarantine,
  REMIX_APP_HELD,
  REMIX_APP_UNAVAILABLE,
  type RegisteredRemixApp,
} from '~/server/services/remix-app-registry.service';
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
  REMIX_IMAGE_STAND_IN,
  remixLogSize,
  RemixMissingReference,
  RemixReplayError,
  REMIX_RUN_LIMITS,
  type RemixLogEntry,
  type RemixReplayer,
  type RemixReplayOutcome,
} from '~/shared/remix-apps/replay';
import {
  readRemixTag,
  REMIX_APP_TAG,
  REMIX_DONE_TAG,
  REMIX_RUN_TAG_PREFIX,
  REMIX_SEGMENT_TAG_PREFIX,
  remixRunTags,
} from '~/shared/remix-apps/tags';
import { RemixQuarantinedError } from '~/server/services/remix-app-runner';
import { orchestratorRefundableStatuses } from '~/shared/constants/generation.constants';
import { isMature } from '~/shared/constants/orchestrator.constants';
import { resolveRemixAppEngine } from '~/shared/utils/remix-apps';
import {
  getRemixSourceUrl,
  REMIX_FALLBACK_DIMENSIONS,
  type RemixSourceImage,
} from '~/shared/utils/remix-tier';

export const MAX_RUN_SEGMENTS = 8;

export type RemixRunMetadata = {
  app: string;
  version: number;
  /** The app's `shape` when this segment was submitted. */
  shape?: string;
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
  return {
    app: raw.app,
    version: raw.version,
    answers,
    ...(typeof raw.shape === 'string' ? { shape: raw.shape } : {}),
    ...(tail?.length ? { tail } : {}),
  };
}

/** Recorded answers live in workflow metadata, which its owner can patch: any that do not fit damage the run. */
function readAnswers(raw: unknown): RemixAnswer[] | undefined {
  if (raw == null) return undefined;
  const fits = (a: unknown) =>
    (typeof a === 'string' && a.length <= REMIX_RUN_LIMITS.answerLength) ||
    (Number.isSafeInteger(a) && (a as number) >= 0);
  if (!Array.isArray(raw) || raw.length > REMIX_RUN_LIMITS.effects || !raw.every(fits))
    throw damaged('a step has answers that do not fit');
  return raw as RemixAnswer[];
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
  author,
  replay,
  image,
  source,
  log,
  spec,
  caller,
  currencies,
  references,
}: {
  app: RemixApp;
  author: RegisteredRemixApp['author'] | undefined;
  replay: RemixReplayer;
  image: RemixSourceImage;
  references: readonly RemixSourceImage[];
  source: RemixAppSource;
  log: RemixLogEntry[];
  spec: Extract<RemixAsk, { kind: 'choice' }>;
  caller: RemixAppCaller;
  currencies: ReturnType<typeof getAllowedAccountTypes>;
}) {
  // An option whose next step the checks refuse is left unpriced; tapping it refuses the run.
  const effects = await remixOptionEffects(replay, source, log, spec).catch((error) => {
    if (error instanceof RemixReplayError) return [];
    throw error;
  });
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
          author,
          log,
          references,
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

/** Prices for one open ask: a repeated advance at it re-prices nothing. A cache, on the cluster. */
async function cachedOptionPrices(
  [runId, segment, step]: [string, number, number],
  price: () => Promise<Record<string, number>>
) {
  const key = `${REDIS_KEYS.REMIX_APP.OPTION_PRICES}:${runId}:${segment}:${step}` as const;
  const cached = await clusterCacheGuard.readOr('cachedOptionPrices', () => redis.get(key), null);
  if (cached) return JSON.parse(cached) as Record<string, number>;
  const prices = await price();
  await clusterCacheGuard.writeBestEffort('cachedOptionPrices', () =>
    redis.set(key, JSON.stringify(prices), { EX: OPTION_PRICES_TTL_SECONDS })
  );
  return prices;
}

export { REMIX_APP_HELD };
export const REMIX_APP_UNCHECKED = 'This app cannot be checked right now. Try again in a moment.';
export const REMIX_APP_UNJUDGED = 'This app cannot be checked with these answers. Try other ones.';

type AuthorPart = Awaited<ReturnType<NonNullable<RegisteredRemixApp['authorPrompt']>>>;

/**
 * The author-part check: a user app's own part of its prompt, judged alone and recorded against nobody.
 * A block sends the app back to review and refuses the run before the viewer's audit, which would
 * count the author's words against the viewer.
 */
async function assertAuthorPartPasses(slug: string, part: AuthorPart) {
  // The masked run went elsewhere, so the viewer's audit would judge words of the author's unseen.
  // Refused, never held: the viewer's own answers can steer the app there.
  if (!part) {
    logToAxiom({
      name: 'remix-app-run',
      type: 'warning',
      message: "Refused a user remix app's run: its author's part could not be built",
      payload: { slug },
    });
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: REMIX_APP_UNJUDGED });
  }
  // Off green on every domain: a hold takes the app out everywhere, and green's own list strikes nobody.
  const verdict = await classifyPromptServer({ prompt: part.prompt, isGreen: false }).catch(() => {
    throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: REMIX_APP_UNCHECKED });
  });
  if (verdict.outcome === 'pass') {
    // Unjudged, it could still block in the viewer's audit a moment later.
    if (verdict.externalError)
      throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: REMIX_APP_UNCHECKED });
    return;
  }
  await holdUserRemixApp(slug, { action: 'held-author-prompt' }).catch((error: unknown) =>
    logToAxiom({
      name: 'remix-app-run',
      type: 'error',
      message: "Could not send a user remix app back to review on its author's prompt",
      payload: { slug, error: error instanceof Error ? error.message : String(error) },
    })
  );
  throw new TRPCError({ code: 'PRECONDITION_FAILED', message: REMIX_APP_HELD });
}

export const REMIX_APP_PROMPT_REFUSED =
  "This app's prompt was refused with these answers. Try other ones.";

/**
 * Another's user app's whole prompt, judged before the viewer's audit, which records what it
 * refuses against the viewer: any refusal stops the run here, recorded against nobody but the app.
 */
async function assertWholePromptPasses(slug: string, prompt: string, caller: RemixAppCaller) {
  const isGreen = !!caller.features.isGreen;
  const whole = await classifyPromptServer({ prompt, isGreen }).catch(() => null);
  if (whole?.outcome === 'pass' && !whole.externalError) return;
  if (!whole || whole.outcome === 'pass')
    throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: REMIX_APP_UNCHECKED });
  // Green's own list strikes nobody, and holds no app back from the other domains.
  if (!isGreen) await recordCombinationBlock(slug, whole, caller.user.id);
  // An event, not an audit row: a row would feed the viewer's blocked-prompt count.
  logToAxiom({
    name: 'remix-combination-refusal',
    type: 'info',
    message: "A combination refusal on another creator's remix app",
    payload: {
      slug,
      viewerId: caller.user.id,
      outcome: whole.outcome,
      categories: [...new Set(whole.triggers.map(({ category }) => category))],
    },
  });
  throw new TRPCError({ code: 'BAD_REQUEST', message: REMIX_APP_PROMPT_REFUSED });
}

/**
 * The combination count: a user app's whole prompt blocked where its author part alone did not.
 * One block per distinct viewer, and only the threshold pulls the app: no one viewer can. A soft
 * block or an over-length refusal counts against nobody, so not against the app either.
 */
async function recordCombinationBlock(slug: string, whole: PromptClassification, viewerId: number) {
  if (whole.outcome === 'soft' || isOverLengthRefusal(whole.triggers)) return;
  await holdUserRemixApp(slug, {
    action: whole.externalError ? 'held-classifier-error' : 'held-combination-blocks',
    viewerId,
  }).catch((error: unknown) =>
    logToAxiom({
      name: 'remix-app-run',
      type: 'error',
      message: 'Could not record a refused run of a user remix app',
      payload: { slug, error: error instanceof Error ? error.message : String(error) },
    })
  );
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
  entry: { app, replay: replayer, shape, author, authorPrompt },
  image,
  segments,
  answers: given,
  quote,
  caller,
  priceOptions = true,
}: {
  runId: string;
  entry: Pick<RegisteredRemixApp, 'app' | 'replay' | 'shape' | 'author' | 'authorPrompt'>;
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
      // A size can follow one the app declared, so it is bounded as the runner's log requires.
      result: {
        workflowId,
        images: images.map(({ url, width, height }) => ({
          url,
          width: remixLogSize(width),
          height: remixLogSize(height),
        })),
      },
    });
  }
  const last = segments[segments.length - 1];
  const tail = last?.meta.tail ?? [];
  for (const answer of tail) log.push({ type: 'ask', answer });
  // A repeat of the answers that finished the run, already recorded.
  if (tail.length && isSameAnswers(answers, tail)) answers = [];

  const source = runtimeSourceOf(image);
  const currencies = getAllowedAccountTypes(caller.features, ['blue']);
  const quarantined = async (error: unknown) => {
    if (!(error instanceof RemixQuarantinedError)) return error;
    return (await noteRunnerQuarantine({ slug: app.slug, author }, caller.user.id, error))
      ? new TRPCError({ code: 'PRECONDITION_FAILED', message: REMIX_APP_HELD })
      : new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: REMIX_APP_UNAVAILABLE });
  };
  // A finished run stays readable and postable whatever its references became: they are gated
  // when a segment is built, not when the run is read.
  const references = new Map<number, RemixImage>();
  const referenceRows: RemixSourceImage[] = [];
  /** Recorded answers that no longer load (deleted, or no longer the viewer's): nothing more runs. */
  const unavailable = new Set<number>();
  /** `asked`: answered just now, so refused at once rather than at the submit. */
  const addReference = async (imageId: number, asked: boolean) => {
    const row = await loadReference(imageId, caller).catch((error) => {
      if (asked) throw error;
      return null;
    });
    if (!row) {
      unavailable.add(imageId);
      // A url no step may submit: the submit refuses first.
      references.set(imageId, { url: `remix-unavailable:${imageId}` });
      return;
    }
    if (asked) {
      const resolved = resolveRemixAppEngine(app, image, viewerOf(caller), [...referenceRows, row]);
      if ('refusal' in resolved)
        throw new TRPCError({ code: 'FORBIDDEN', message: resolved.refusal });
    }
    referenceRows.push(row);
    references.set(imageId, {
      url: getRemixSourceUrl(row),
      width: remixLogSize(row.width) ?? REMIX_FALLBACK_DIMENSIONS.width,
      height: remixLogSize(row.height) ?? REMIX_FALLBACK_DIMENSIONS.height,
    });
  };
  const replay = async (): Promise<RemixReplayOutcome> => {
    // Bounded by the log: each pass loads an image answer it had not.
    for (;;) {
      try {
        return await replayer(source, log, references);
      } catch (error) {
        if (error instanceof RemixMissingReference && !references.has(error.imageId)) {
          await addReference(error.imageId, false);
          continue;
        }
        throw error instanceof RemixReplayError ? damaged(error.message) : await quarantined(error);
      }
    }
  };
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
        : undefined) ??
      // The stand-in is for quotes; a viewer names a real image.
      (spec.kind === 'image' && answer === REMIX_IMAGE_STAND_IN ? 'Not an image' : undefined);
    if (refusal) throw new TRPCError({ code: 'BAD_REQUEST', message: refusal });
    if (spec.kind === 'image' && typeof answer === 'number' && !references.has(answer))
      await addReference(answer, true);
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
    if (!priceOptions || unavailable.size) return { status: 'ask', runId, ask };
    const prices = await cachedOptionPrices([runId, segments.length, outcome.index], () =>
      optionPrices({
        app,
        author,
        replay: (from, optionLog) =>
          replayer(from, optionLog, references).catch(async (error) => {
            throw error instanceof RemixReplayError ? error : await quarantined(error);
          }),
        image,
        source,
        log,
        spec,
        caller,
        currencies,
        references: referenceRows,
      })
    );
    return { status: 'ask', runId, ask, prices };
  }

  const index = segments.length;
  if (index >= MAX_RUN_SEGMENTS) throw damaged('it has too many steps');
  if (unavailable.size)
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'An image this run uses is no longer available',
    });
  const run = buildRuntimeRequest({
    app,
    image,
    request: outcome.effect.request,
    viewer: viewerOf(caller),
    author,
    log,
    references: referenceRows,
  });
  // The graph submit skips its own input gate ('checked-by-caller').
  await assertInputsUsable(run.inputUrls, caller, 'remixAppRun');

  const priced = await whatIfPresetImageGen({
    graphInput: run.graphInput,
    ...remixWhatIfArgs(caller, currencies),
  });
  if (quote == null) return { status: 'priced', runId, ...priced };
  assertWithinQuote(priced.cost, quote);

  const { request } = outcome.effect;
  // An author's own run is audited as any other, with the author as the viewer: their words count
  // against them, and their refusals never move their own app's count.
  const othersApp = !!author && author.userId !== caller.user.id && request.kind === 'image';
  const part =
    othersApp && authorPrompt
      ? await authorPrompt(source, log).catch(async (error) => {
          throw await quarantined(error);
        })
      : null;
  if (othersApp) {
    await assertAuthorPartPasses(app.slug, part);
    // Trimmed, as the graph hands it to the viewer's audit.
    await assertWholePromptPasses(app.slug, request.prompt.trim(), caller);
  }

  const tags = remixRunTags({ slug: app.slug, runId, segment: index, runtime: true });
  const remixRun: RemixRunMetadata = { app: app.slug, version: app.version, shape, answers };
  // A segment after the first reads the previous segment's output, which carries no source; the
  // mint names it again so the graph signs it into this segment's metadata and output files.
  const mint = signProvenance({
    userId: caller.user.id,
    sourceImageIds: [image.id, ...references.keys()],
    kind: 'mint',
  });
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
  const entry = await getRegisteredRemixApp(slug, caller, { allowDisabled });
  const image = await loadSource(imageId, caller, true);
  const runId = remixRunId({ userId: caller.user.id, slug, imageId, nonce });
  const segments = await readRun(runId, caller);
  // Started already: its first workflow holds these answers, and a repeat tap only reloads it.
  const given = segments.length ? [] : answers;
  return advance({ runId, entry, image, segments, answers: given, quote, caller });
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
  const { segments, entry, image } = await loadRun(runId, caller);
  return advance({ runId, entry, image, segments, answers, quote, caller });
}

async function loadRun(runId: string, caller: RemixAppCaller) {
  const segments = await readRun(runId, caller);
  if (!segments.length) throw new TRPCError({ code: 'NOT_FOUND', message: 'Remix not found' });
  const { meta } = segments[segments.length - 1];
  const changed = () => damaged('the app changed since it started. Start it again from the image.');
  // A disabled app's run still finishes: it was paid for.
  const entry = await getRegisteredRemixApp(meta.app, caller, { allowDisabled: true }).catch(
    (error) => {
      throw error instanceof TRPCError && error.code === 'NOT_FOUND' ? changed() : error;
    }
  );
  // A user app out of menus runs again only for a mod, or for its author while it waits on review:
  // every other run stops here, finished ones too.
  const { author } = entry;
  if (author && !caller.user.isModerator && !isRunnableBy(entry, caller))
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'This app is no longer available',
    });
  // Runs from before shapes were recorded carry none; no user app predates them.
  const shape = meta.shape ?? (author ? undefined : entry.shape);
  if (entry.app.version !== meta.version || shape !== entry.shape) throw changed();
  const image = await loadSource(runSourceId(segments), caller, true);
  return { segments, entry, image };
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
  const { segments, entry, image } = await loadRun(runId, caller);
  // No quote: replaying a run that has not finished can price its next step, never submit it.
  const state = await advance({
    runId,
    entry,
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
    })
  );
  bustQueriedWorkflowsCache(caller.user.id).catch(() => null);
  return result;
}
