import { assertVectorSyncConfig, config } from '@/config';
import { logger } from '@/utils/logger';
import type { ImageRow } from './eligibility';
import { EMBED_MODEL, ModelMismatchError, VECTOR_DIMENSIONS, type ModelStamp } from './qdrant';
import { parseRetryAfter, RateLimiter } from './ratelimit';
import { sinkFromConfig, type VectorSink } from './sink';

// The orchestration client has no type for this step yet; this is the subset we send and read.
// One step embeds exactly one input; a workflow carries many steps.
export type EmbedInput = { id: string; imageUrl?: string; videoUrl?: string };
type StepOutput = {
  model: string;
  modelRevision: string;
  /** The image profile for an image step, the video profile for a video step. */
  profile: string;
  dimensions: number;
  precision?: string;
  embedding: number[];
};
type Workflow = {
  id: string;
  status: string;
  steps?: Array<{ name?: string; status?: string; output?: StepOutput }>;
};

export const MAX_INPUTS_PER_WORKFLOW = 128;
export const MAX_VIDEOS_PER_WORKFLOW = 8;
const MAX_VIDEO_SECONDS = 60;
const MAX_VIDEO_KB = 100 * 1024;
const MAX_VIDEO_SIDE = 4096;
// The variant the site's image cards request for 2x screens (a 450 card's hi-DPI rung), so it is
// usually already stored and the image cacher redirects to it without converting the original.
// The smallest ladder rung at or above the model's 512x512 profile that the site requests.
const EMBED_IMAGE_PARAMS = 'anim=false,width=800,optimized=true';
const TERMINAL = new Set(['succeeded', 'failed', 'expired', 'canceled']);

/**
 * The workflow ended without it being its inputs' fault: expired or canceled, or failed with no
 * step succeeding across several images. One failed image is that image's own failure.
 */
function looksLikeOutage(workflow: Workflow, inputs: number) {
  if (workflow.status === 'expired' || workflow.status === 'canceled') return true;
  return (
    workflow.status === 'failed' &&
    inputs > 1 &&
    !(workflow.steps ?? []).some((step) => step.status === 'succeeded')
  );
}

export type SkipReason =
  | 'external-url'
  | 'video-disabled'
  | 'video-too-long'
  | 'video-too-large'
  | 'video-too-large-dimensions'
  | 'unsupported-type';
type Built = { input: EmbedInput } | { skip: SkipReason };
type BuildOptions = { imageLocation: string; embedVideo: boolean };

/** Same shape as the main app's getEdgeUrl for a bare key. */
function edgeUrl(base: string, key: string, params: string, ext: string) {
  const name = key.replaceAll('%', '').replace(/\.[^./]*$/, '');
  return `${base}/${key}/${params}/${name}${ext}`;
}

/** One builder per media type; a type without one is skipped, not failed. */
const builders: Partial<Record<ImageRow['type'], (row: ImageRow, opts: BuildOptions) => Built>> = {
  image: (row, { imageLocation }) => ({
    input: {
      id: String(row.id),
      imageUrl: edgeUrl(imageLocation, row.url, EMBED_IMAGE_PARAMS, '.jpeg'),
    },
  }),
  video: (row, { imageLocation, embedVideo }) => {
    if (!embedVideo) return { skip: 'video-disabled' };
    if (row.duration != null && row.duration > MAX_VIDEO_SECONDS) return { skip: 'video-too-long' };
    if (row.sizeKB != null && row.sizeKB > MAX_VIDEO_KB) return { skip: 'video-too-large' };
    if ((row.width ?? 0) > MAX_VIDEO_SIDE || (row.height ?? 0) > MAX_VIDEO_SIDE) {
      return { skip: 'video-too-large-dimensions' };
    }
    return {
      input: {
        id: String(row.id),
        videoUrl: edgeUrl(imageLocation, row.url, 'original=true', '.mp4'),
      },
    };
  },
};

export function buildEmbedInput(
  row: ImageRow,
  opts: BuildOptions = {
    imageLocation: config.vectorSync.imageLocation,
    embedVideo: config.vectorSync.embedVideo,
  }
): Built {
  // Absolute URLs are not on our CDN; only stored keys are sent to the embedder.
  if (/^[a-z]+:/i.test(row.url)) return { skip: 'external-url' };
  const build = builders[row.type];
  return build ? build(row, opts) : { skip: 'unsupported-type' };
}

/** Below this, a cut vector is not the direct one (see verifyPrefix). */
export const PREFIX_MIN_COSINE = 0.9999;
const PREFIX_CHECK_ATTEMPTS = 3;
/** After a check that could not be made, wide embeds are refused this long, then checked again. */
const PREFIX_RETRY_AFTER_MS = 10 * 60_000;

/**
 * The cut vectors could not be checked (the orchestrator kept failing the direct embed). Unlike a
 * mismatch it clears: the process refuses wide embeds for a while, then checks again.
 */
export class PrefixCheckUnavailableError extends Error {
  name = 'PrefixCheckUnavailableError';
}

/** The first `n` values of `v`, scaled to unit length: a wide embedding cut to a narrower one. */
export function unitPrefix(v: number[], n: number): number[] {
  const out = v.slice(0, n);
  const norm = Math.hypot(...out);
  return norm ? out.map((x) => x / norm) : out;
}

function cosine(a: number[], b: number[]) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / Math.sqrt(na * nb);
}

/** The width to request, and the sink: wider only with somewhere to keep the full vector. */
function widthFromConfig() {
  const width = config.vectorSync.embedSourceDimensions;
  if (width === VECTOR_DIMENSIONS) return {};
  const sink = sinkFromConfig();
  if (!sink) {
    logger.warn(
      { width },
      'vector-sync: VECTOR_EMBED_SOURCE_DIMENSIONS is set but no VECTOR_SINK_BUCKET; requesting the stored width'
    );
    return {};
  }
  return { sourceDimensions: width, sink };
}

/** Step names are how results map back to images. */
export const stepName = (id: string) => `img-${id}`;

/**
 * A budget of orchestrator jobs in flight, one per step. Waiters are served in order, and a
 * workflow larger than the budget takes all of it rather than waiting forever.
 */
export class JobBudget {
  private used = 0;
  private readonly waiters: Array<{ n: number; go: (granted: number) => void }> = [];

  constructor(public capacity: number) {}

  /** Lowers or raises the budget; waiters that now fit are started. */
  setCapacity(capacity: number) {
    this.capacity = Math.max(1, capacity);
    this.release(0);
  }

  async acquire(jobs: number): Promise<number> {
    const n = Math.min(jobs, this.capacity);
    if (!this.waiters.length && this.used + n <= this.capacity) {
      this.used += n;
      return n;
    }
    return new Promise<number>((go) => this.waiters.push({ n, go }));
  }

  release(n: number) {
    this.used -= n;
    // Clamped again here: capacity may have dropped below a queued waiter's size since it queued.
    for (;;) {
      const next = this.waiters[0];
      if (!next) break;
      const granted = Math.min(next.n, this.capacity);
      if (this.used + granted > this.capacity) break;
      this.waiters.shift();
      this.used += granted;
      next.go(granted);
    }
  }

  get inFlight() {
    return this.used;
  }
}

class RetryableError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs?: number,
    /** A 429: the orchestrator's flow control, retried on its own budget. */
    readonly rateLimited = false
  ) {
    super(message);
  }
}

/** The orchestrator rejected the whole workflow (a 400); splitting it may isolate the input. */
class WorkflowRejectedError extends Error {}

const INFLIGHT_POLICY = 'inflight-multimodalEmbedding';

export type EmbedResult = {
  vectors: Map<number, number[]>;
  /** Ids whose step failed, or that a rejected workflow could not be split away from. */
  failed: number[];
  stamp: ModelStamp | null;
  /**
   * Set when a workflow failed in a way that is not the inputs' fault (retries exhausted, auth,
   * a model mismatch). The vectors that did come back are still returned, so the caller can
   * store what it paid for before surfacing the error.
   */
  error?: unknown;
};

export class MixedStampError extends Error {
  constructor(a: ModelStamp, b: ModelStamp) {
    super(
      `one embed call returned two models: ${a.modelRevision}/${a.profile ?? a.videoProfile} and ${
        b.modelRevision
      }/${b.profile ?? b.videoProfile}`
    );
    this.name = 'MixedStampError';
  }
}

/** A rejected workflow is split at most this many times (128 down to groups of 8). */
const MAX_SPLIT_DEPTH = 4;
/**
 * 429s are the orchestrator's flow control, not errors: they are budgeted by time, and longer
 * than one workflow can run (30 min), since another process may hold the account's quota.
 */
const RATE_LIMITED_FOR_MS = 2 * 60 * 60_000;
const DEFAULT_OUTAGE_RETRY_FOR_MS = 15 * 60_000;
/** Longer than a workflow's steps usually take, so a re-send finds them cached. */
const DEFAULT_RESUBMIT_DELAY_MS = 2 * 60_000;
/** Retries of a poll after a network error or 5xx; the workflow keeps running meanwhile. */
const POLL_RETRIES = 8;

/** An ephemeral workflow finished between two polls and is gone, with its result. */
class LostResultError extends RetryableError {}

/**
 * A submit that failed after its body may have been sent (a network error, a 5xx, or a 2xx
 * whose body could not be read). It may be running anyway, and ephemeral workflows are not deduplicated (externalId is ignored
 * without Mongo), so it is sent again only once its steps should have finished, when identical
 * inputs come back from the orchestrator's cache instead of a second GPU run.
 */
class AmbiguousSubmitError extends RetryableError {}

/** The connection failed before the request was sent (refused, DNS, connect timeout, TLS). */
class NotSentError extends RetryableError {}

const NOT_SENT_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
]);
// Certificate verification, which fails in the handshake: DEPTH_ZERO_SELF_SIGNED_CERT,
// ERR_TLS_CERT_ALTNAME_INVALID. Other TLS errors (a bad record MAC) can come mid-request.
// EHOSTUNREACH and ENETUNREACH are left out too: they can hit a reused socket after sending.
const TLS_CODE = /CERT/;

/** fetch throws TypeError('fetch failed') with the socket error as its cause. */
function sentNothing(err: unknown) {
  for (let e = err, depth = 0; e instanceof Error && depth < 4; e = e.cause, depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && (NOT_SENT_CODES.has(code) || TLS_CODE.test(code))) return true;
  }
  return false;
}

/** Polls kept failing; the workflow may still be running. */
class PollGaveUpError extends Error {}

export type EmbedderOptions = {
  endpoint: string;
  token: string;
  /** Upper bound on orchestrator jobs (steps) in flight, across every call on this embedder. */
  maxInFlight: number;
  maxRetries: number;
  priority: 'low' | 'normal';
  batchSize?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Wait passed to the orchestrator on submit and poll, seconds. */
  waitSeconds?: number;
  /** Wait before re-sending an ambiguous submit (see AmbiguousSubmitError). */
  resubmitDelayMs?: number;
  /**
   * False ignores the RateLimit in-flight quota (q and r) for the cap and the workflow size, as
   * the orchestrator owners asked while its value is provisional. 429s and Retry-After still hold.
   */
  honorQuota?: boolean;
  /**
   * Steps submitted per second, across every call on this embedder; 0 or unset is unlimited.
   * Cache hits create no orchestrator job, so neither job budget bounds them.
   */
  maxStepsPerSecond?: number;
  /** No outage re-submit starts this long after a batch's first attempt (see looksLikeOutage). */
  outageRetryForMs?: number;
  /** Width asked of the orchestrator; wider than VECTOR_DIMENSIONS, vectors are cut to it. */
  sourceDimensions?: number;
  /** Where full-width vectors go, when sourceDimensions is wider. */
  sink?: VectorSink | null;
};

type EmbedCall = {
  result: EmbedResult;
  /** The accepted stamp per media type: image and video steps report different profiles. */
  stamps: Map<'image' | 'video', ModelStamp>;
  /** Checked for every step's stamp before its vector is accepted; throwing rejects the workflow. */
  acceptStamp?: (stamp: ModelStamp) => Promise<void>;
  /** Given each workflow's accepted vectors as it returns, so they can be stored before the call ends. */
  onVectors?: (vectors: Map<number, number[]>) => Promise<void>;
};

/** Takes up to `size` inputs off the front of `queue`, with at most 8 videos. */
export function takeBatch(queue: EmbedInput[], size: number): EmbedInput[] {
  const batch: EmbedInput[] = [];
  let videos = 0;
  while (queue.length && batch.length < size) {
    const isVideo = !!queue[0].videoUrl;
    if (isVideo && videos === MAX_VIDEOS_PER_WORKFLOW) break;
    batch.push(queue.shift()!);
    if (isVideo) videos++;
  }
  return batch;
}

export class Embedder {
  /** Called whenever a workflow returns vectors. */
  onProgress?: () => void;
  /** Set once a stamp has been accepted; the collection then has one recorded. */
  private stampSeen = false;
  readonly budget: JobBudget;
  /** The account's in-flight quota, from the orchestrator's RateLimit headers. */
  readonly limits = new RateLimiter(INFLIGHT_POLICY);
  private limitsLogged = false;
  /** When the next submit may go out, under maxStepsPerSecond. */
  private nextSubmitAt = 0;
  /** Runtime limits (setLimits), never above the configured ones. */
  private inFlightLimit?: number;
  private stepsPerSecondLimit?: number;
  private readonly fetch: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  readonly batchSize: number;
  readonly sourceDimensions: number;
  readonly sink: VectorSink | null;
  /** Media kinds whose cut vectors have matched a direct embed at the stored width. */
  private readonly prefixVerified = new Set<'image' | 'video'>();
  private readonly prefixChecks = new Map<'image' | 'video', Promise<void>>();
  /** Set once a check refused: every later call is refused before it submits anything, for good
   * after a mismatch and until `prefixRetryAt` when the check could not be made. */
  private prefixFailed?: unknown;
  private prefixRetryAt = Infinity;

  constructor(private readonly opts: EmbedderOptions) {
    this.budget = new JobBudget(Math.max(1, opts.maxInFlight));
    this.fetch = opts.fetch ?? globalThis.fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? Date.now;
    // Wider only with a sink: a full vector with nowhere to go is not worth asking for.
    this.sink = opts.sink ?? null;
    this.sourceDimensions = this.sink
      ? Math.max(VECTOR_DIMENSIONS, opts.sourceDimensions ?? VECTOR_DIMENSIONS)
      : VECTOR_DIMENSIONS;
    this.batchSize = Math.min(
      MAX_INPUTS_PER_WORKFLOW,
      Math.max(1, opts.batchSize ?? MAX_INPUTS_PER_WORKFLOW)
    );
  }

  static fromConfig(priority: 'low' | 'normal') {
    assertVectorSyncConfig();
    const { orchestratorEndpoint, embedToken, embedMaxInFlight, embedMaxRetries, imageLocation } =
      config.vectorSync;
    if (!orchestratorEndpoint || !embedToken) {
      throw new Error('ORCHESTRATOR_ENDPOINT and VECTOR_EMBED_TOKEN are required to embed');
    }
    // Without it every input is a relative URL and every step fails.
    if (!/^https?:\/\/[^/]/.test(imageLocation)) {
      throw new Error('VECTOR_IMAGE_LOCATION must be an absolute http(s) URL to embed');
    }
    // It counted workflows before workflows became one step per image; an old value like 4
    // would now allow 4 jobs and run one small workflow at a time without saying so.
    if (embedMaxInFlight < config.vectorSync.embedBatchSize) {
      throw new Error(
        `VECTOR_EMBED_MAX_IN_FLIGHT counts jobs (one per image) and must be at least VECTOR_EMBED_BATCH_SIZE (${config.vectorSync.embedBatchSize})`
      );
    }
    return new Embedder({
      endpoint: orchestratorEndpoint,
      token: embedToken,
      maxInFlight: embedMaxInFlight,
      maxRetries: embedMaxRetries,
      batchSize: config.vectorSync.embedBatchSize,
      resubmitDelayMs: config.vectorSync.embedResubmitDelaySeconds * 1000,
      outageRetryForMs: config.vectorSync.embedOutageRetrySeconds * 1000,
      honorQuota: config.vectorSync.embedHonorQuota,
      // Backfill and reconcile only: live sync must keep up with uploads, and is bounded by the
      // event rate rather than a walk over existing images.
      maxStepsPerSecond: priority === 'low' ? config.vectorSync.embedMaxStepsPerSecond : 0,
      ...widthFromConfig(),
      priority,
    });
  }

  async embed(
    inputs: EmbedInput[],
    { acceptStamp, onVectors }: Pick<EmbedCall, 'acceptStamp' | 'onVectors'> = {}
  ): Promise<EmbedResult> {
    const call: EmbedCall = {
      result: { vectors: new Map(), failed: [], stamp: null },
      stamps: new Map(),
      acceptStamp,
      onVectors,
    };
    if (this.prefixFailed && this.now() >= this.prefixRetryAt) this.prefixFailed = undefined;
    if (this.prefixFailed) {
      call.result.error = this.prefixFailed;
      return call.result;
    }
    const queue = [...inputs];
    const running = new Set<Promise<void>>();

    // Workflows are sized as they are sent, to what the account's quota has left.
    while (queue.length && !call.result.error) {
      const hold = this.limits.waitMs(this.now());
      if (hold > 0) {
        await this.sleep(hold);
        continue;
      }
      const size = this.allowance(
        Math.min(this.batchSize, this.budget.capacity),
        running.size === 0
      );
      if (size === 0) {
        if (running.size) await Promise.race(running);
        else
          await this.sleep(Math.max(this.limits.waitMs(this.now()), this.limits.minRetryAfterMs));
        continue;
      }
      // Paced before the batch is taken and the budget held: a batch waiting its turn holds no
      // jobs, and is sized from what the quota says after the wait, not before it. Paced by what
      // is left, not the full size, so a short batch does not push every later submit back.
      await this.paceSteps(Math.min(size, queue.length));
      if (call.result.error) break;
      const fresh = this.allowance(
        Math.min(this.batchSize, this.budget.capacity),
        running.size === 0
      );
      if (fresh === 0) continue;
      const batch = takeBatch(queue, Math.min(size, fresh));
      const held = await this.budget.acquire(batch.length);
      this.limits.reserve(batch.length);
      const task = (async () => {
        try {
          await this.embedSplitting(batch, call, 0, 0, this.now(), true);
        } catch (err) {
          call.result.error ??= err;
        } finally {
          this.budget.release(held);
        }
      })();
      running.add(task);
      void task.finally(() => running.delete(task));
      // Until a stamp has been accepted, the first workflow runs alone, so its model is
      // recorded before any other is compared against an empty stamp.
      if (!this.stampSeen) await task;
    }
    // allSettled: one failing workflow must not discard the vectors others paid for.
    await Promise.allSettled([...running]);
    return call.result;
  }

  private async embedSplitting(
    batch: EmbedInput[],
    call: EmbedCall,
    depth: number,
    outageRetries = 0,
    started = this.now(),
    paced = false
  ): Promise<void> {
    let workflow: Workflow;
    try {
      workflow = await this.runWithRetry(batch, paced, this.sourceDimensions);
    } catch (err) {
      if (!(err instanceof WorkflowRejectedError)) throw err;
      if (batch.length === 1 || depth >= MAX_SPLIT_DEPTH) {
        logger.warn(
          { ids: batch.map((b) => b.id), err: err.message },
          'vector-sync: workflow rejected; inputs failed'
        );
        call.result.failed.push(...batch.map((b) => Number(b.id)));
        return;
      }
      const mid = Math.ceil(batch.length / 2);
      // Sequential: the halves share this workflow's slice of the job budget.
      await this.embedSplitting(batch.slice(0, mid), call, depth + 1);
      await this.embedSplitting(batch.slice(mid), call, depth + 1);
      return;
    }

    // Each step stands alone: a failed step fails only its own image.
    const steps = new Map((workflow.steps ?? []).map((step) => [step.name, step]));
    const accepted: Array<[number, number[], ModelStamp, 'image' | 'video']> = [];
    const failed: string[] = [];
    for (const input of batch) {
      const out = steps.get(stepName(input.id));
      const output = out?.output;
      const width = output?.embedding?.length;
      if (this.wide && out?.status === 'succeeded' && width && width !== this.sourceDimensions) {
        // The orchestrator did not honour the width: every workflow would be paid for and dropped.
        this.prefixFailed = new ModelMismatchError(
          {},
          { model: output!.model, modelRevision: output!.modelRevision, dimensions: width },
          `asked for ${this.sourceDimensions}-d vectors, got ${width}-d; not embedding at this width`
        );
        throw this.prefixFailed;
      }
      if (
        out?.status !== 'succeeded' ||
        !output ||
        // Without them the vector cannot be checked against the collection's model.
        !output.modelRevision ||
        !output.profile ||
        output.embedding?.length !== this.sourceDimensions ||
        (output.precision && output.precision !== 'float32')
      ) {
        failed.push(input.id);
        continue;
      }
      const kind = input.videoUrl ? 'video' : 'image';
      const wide = this.sourceDimensions > VECTOR_DIMENSIONS;
      const stamp: ModelStamp = {
        model: output.model,
        modelRevision: output.modelRevision,
        // The stored width: a wide vector is cut to it below.
        dimensions: wide ? VECTOR_DIMENSIONS : output.dimensions,
        ...(wide ? { sourceDimensions: output.dimensions } : {}),
        ...(kind === 'video' ? { videoProfile: output.profile } : { profile: output.profile }),
      };
      accepted.push([Number(input.id), output.embedding, stamp, kind]);
    }
    // Retried here, not by the caller, so a batch that keeps failing ends as counted failures
    // (reconcile retries them) rather than a flush that never moves on. Only the unfinished
    // inputs go again; the steps that succeeded are kept below.
    const outage = failed.length > 0 && looksLikeOutage(workflow, batch.length);
    const backoff = Math.min(60_000, 1000 * 2 ** outageRetries) * (0.5 + Math.random() / 2);
    // Bounded by time as well as attempts: one expiry can take the whole 30-minute step timeout.
    const retryOutage =
      outage &&
      outageRetries < this.opts.maxRetries &&
      this.now() + backoff - started < (this.opts.outageRetryForMs ?? DEFAULT_OUTAGE_RETRY_FOR_MS);
    if (retryOutage) {
      logger.warn(
        { workflow: workflow.id, status: workflow.status, ids: failed, attempt: outageRetries },
        'vector-sync: workflow ended without its inputs being at fault; re-submitting'
      );
    } else if (outage) {
      logger.error(
        { workflow: workflow.id, status: workflow.status, ids: failed },
        'vector-sync: workflow kept failing after retries; inputs failed'
      );
      call.result.failed.push(...failed.map(Number));
    } else if (failed.length) {
      logger.warn({ workflow: workflow.id, ids: failed }, 'vector-sync: steps failed to embed');
      call.result.failed.push(...failed.map(Number));
    }

    // Every distinct stamp in this workflow is checked before any of its vectors is kept.
    const distinct = new Map<string, [ModelStamp, 'image' | 'video']>();
    for (const [, , stamp, kind] of accepted) distinct.set(JSON.stringify(stamp), [stamp, kind]);
    // Checked once per process and media kind; the workflows that finish meanwhile wait on it.
    // A failed check stays failed: nothing more is kept or paid for at this width.
    for (const kind of new Set(accepted.map(([, , , k]) => k))) {
      if (!this.wide || this.prefixVerified.has(kind)) continue;
      let check = this.prefixChecks.get(kind);
      if (!check) {
        const ofKind = accepted.filter(([, , , k]) => k === kind);
        const ids = new Set(ofKind.map(([id]) => String(id)));
        check = this.verifyPrefix(
          batch.filter((input) => ids.has(input.id)),
          ofKind
        ).then(
          () => void this.prefixVerified.add(kind),
          (err) => {
            this.prefixFailed = err;
            if (err instanceof PrefixCheckUnavailableError) {
              this.prefixChecks.delete(kind);
              this.prefixRetryAt = this.now() + PREFIX_RETRY_AFTER_MS;
            } else this.prefixRetryAt = Infinity;
            throw err;
          }
        );
        this.prefixChecks.set(kind, check);
      }
      await check;
    }
    for (const [stamp, kind] of distinct.values()) {
      const seen = call.stamps.get(kind);
      if (seen && JSON.stringify(seen) !== JSON.stringify(stamp))
        throw new MixedStampError(seen, stamp);
      await call.acceptStamp?.(stamp);
      call.stamps.set(kind, stamp);
      this.stampSeen = true;
    }
    if (accepted.length) {
      this.onProgress?.();
      call.result.stamp ??= accepted[0][2];
      const stored = new Map<number, number[]>();
      for (const [id, vector, stamp] of accepted) {
        if (this.sourceDimensions === VECTOR_DIMENSIONS) {
          stored.set(id, vector);
          continue;
        }
        this.sink?.add(id, vector, {
          model: stamp.model ?? EMBED_MODEL,
          revision: stamp.modelRevision,
          profile: (stamp.profile ?? stamp.videoProfile)!,
        });
        stored.set(id, unitPrefix(vector, VECTOR_DIMENSIONS));
      }
      for (const [id, vector] of stored) call.result.vectors.set(id, vector);
      await call.onVectors?.(stored);
    }
    if (retryOutage) {
      await this.sleep(backoff);
      const unfinished = new Set(failed);
      const again = batch.filter((input) => unfinished.has(input.id));
      await this.embedSplitting(again, call, depth, outageRetries + 1, started);
    }
  }

  private get wide() {
    return this.sourceDimensions > VECTOR_DIMENSIONS;
  }

  /** Until every kind seen so far has passed its check (or before any has been seen). */
  private get awaitingPrefix() {
    if (!this.wide) return false;
    if (!this.prefixVerified.size) return true;
    for (const kind of this.prefixChecks.keys()) if (!this.prefixVerified.has(kind)) return true;
    return false;
  }

  /** The step rate submits are paced to now, after setLimits; 0 is unlimited. */
  get stepsPerSecond() {
    const configured = this.opts.maxStepsPerSecond;
    const limit = this.stepsPerSecondLimit;
    return (limit && configured ? Math.min(limit, configured) : limit ?? configured) ?? 0;
  }

  /** How many of `max` steps the account's quota takes now, across every call on this embedder. */
  submitAllowance(max: number) {
    // One workflow at a time until a cut vector has been checked, so a mismatch wastes only one.
    if (this.awaitingPrefix && this.budget.inFlight > 0) return 0;
    return this.allowance(max, this.budget.inFlight === 0);
  }

  /** How long a submit made now would wait: its step-rate slot, or a 429's hold. */
  get submitWaitMs() {
    const now = this.now();
    return Math.max(0, this.nextSubmitAt - now, this.limits.waitMs(now));
  }

  /** Spaces submits so steps go out at a steady rate, with no burst: each reserves its own slot. */
  private async paceSteps(steps: number) {
    const rate = this.stepsPerSecond;
    if (!rate) return;
    const now = this.now();
    const at = Math.max(now, this.nextSubmitAt);
    this.nextSubmitAt = at + (steps * 1000) / rate;
    if (at > now) await this.sleep(at - now);
  }

  /** `paced`: the first attempt already took its step-rate slot (the embed loop's batches). */
  /**
   * Embeds the batch again at the stored width and refuses to go on if a cut vector differs from
   * its direct one: mixing them in one collection would skew every search. A check that cannot be
   * made (no image embedded both ways, or the direct embed failing) is retried a few times and then
   * refused too, so a process never keeps paying for wide vectors it cannot use.
   */
  private async verifyPrefix(
    batch: EmbedInput[],
    accepted: Array<[number, number[], ModelStamp, 'image' | 'video']>
  ) {
    let problem = '';
    for (let attempt = 1; attempt <= PREFIX_CHECK_ATTEMPTS; attempt++) {
      let workflow: Workflow;
      try {
        workflow = await this.runWithRetry(batch, false, VECTOR_DIMENSIONS);
      } catch (err) {
        problem = (err as Error).message;
        if (attempt < PREFIX_CHECK_ATTEMPTS) await this.sleep(5000 * attempt);
        continue;
      }
      const direct = new Map((workflow.steps ?? []).map((s) => [s.name, s.output?.embedding]));
      let compared = 0;
      let worst = 1;
      for (const [id, vector] of accepted) {
        const other = direct.get(stepName(String(id)));
        if (other?.length !== VECTOR_DIMENSIONS) continue;
        compared++;
        worst = Math.min(worst, cosine(unitPrefix(vector, VECTOR_DIMENSIONS), other));
      }
      if (!compared) {
        problem = 'no image embedded at both widths';
        if (attempt < PREFIX_CHECK_ATTEMPTS) await this.sleep(5000 * attempt);
        continue;
      }
      logger.info(
        { compared, worstCosine: worst, sourceDimensions: this.sourceDimensions },
        'vector-sync: cut vectors checked against direct embeds'
      );
      if (worst < PREFIX_MIN_COSINE) {
        throw new ModelMismatchError(
          {},
          accepted[0][2],
          `a ${this.sourceDimensions}-d vector cut to ${VECTOR_DIMENSIONS} differs from the direct ${VECTOR_DIMENSIONS}-d embed (cosine ${worst}); not mixing them`
        );
      }
      return;
    }
    throw new PrefixCheckUnavailableError(
      `could not check ${
        this.sourceDimensions
      }-d vectors cut to ${VECTOR_DIMENSIONS} against direct embeds (${problem}); refusing the wider width for ${
        PREFIX_RETRY_AFTER_MS / 60_000
      } min`
    );
  }

  private async runWithRetry(
    batch: EmbedInput[],
    paced = false,
    dimensions = this.sourceDimensions
  ): Promise<Workflow> {
    let errors = 0;
    let rateLimited = 0;
    const rateLimitedSince = this.now();
    for (let tries = 0; ; tries++) {
      if (tries > 0 || !paced) await this.paceSteps(batch.length);
      // After the pace: a 429 seen meanwhile holds this submit too.
      const hold = this.limits.waitMs(this.now());
      if (hold > 0) await this.sleep(hold);
      try {
        return await this.run(batch, dimensions);
      } catch (err) {
        // Giving up on a workflow that may still be running: the caller's retry (a backfill page,
        // the next consumer flush) re-sends it within seconds, so wait for it to finish first.
        const resubmitDelay = this.opts.resubmitDelayMs ?? DEFAULT_RESUBMIT_DELAY_MS;
        if (!(err instanceof RetryableError)) {
          if (err instanceof PollGaveUpError) await this.sleep(resubmitDelay);
          throw err;
        }
        const attempt = err.rateLimited ? rateLimited++ : errors++;
        const exhausted = err.rateLimited
          ? this.now() - rateLimitedSince >= RATE_LIMITED_FOR_MS
          : attempt >= this.opts.maxRetries;
        if (exhausted) {
          if (err instanceof AmbiguousSubmitError) await this.sleep(resubmitDelay);
          throw new Error(`embedding gave up after ${attempt + 1} attempts: ${err.message}`);
        }
        // A 429's Retry-After is already the embedder-wide hold the loop waits out above.
        if (err.rateLimited && err.retryAfterMs !== undefined) continue;
        // Retry-After is followed exactly; without it, exponential backoff with jitter.
        let delay =
          err.retryAfterMs ?? Math.min(60_000, 1000 * 2 ** attempt) * (0.5 + Math.random() / 2);
        if (err instanceof AmbiguousSubmitError) delay = Math.max(delay, resubmitDelay);
        logger.warn({ attempt, delay, err: err.message }, 'vector-sync: embedding backoff');
        await this.sleep(delay);
      }
    }
  }

  private async run(batch: EmbedInput[], dimensions: number): Promise<Workflow> {
    const wait = this.opts.waitSeconds ?? 60;
    // Ephemeral: the orchestrator keeps no document for it. It disappears once terminal, so the
    // result comes back on the submit or a long poll; one that finishes between polls is gone,
    // and the whole workflow is sent again (identical inputs come back from its cache).
    let workflow = await this.submit(wait, {
      steps: batch.map((input) => ({
        $type: 'multimodalEmbedding',
        name: stepName(input.id),
        priority: this.opts.priority,
        // Bounds the poll loop below; the default is a day.
        timeout: '00:30:00',
        input: {
          model: EMBED_MODEL,
          dimensions,
          precision: 'float32',
          ...(input.videoUrl ? { videoUrl: input.videoUrl } : { imageUrl: input.imageUrl }),
        },
      })),
      tier: 'paid',
      allowMatureContent: true,
      ephemeral: true,
      tags: ['vector-sync'],
    });
    // A poll that fails is retried as a poll: re-POSTing a workflow that is still running would
    // run its steps twice. If polls give up, runWithRetry waits before the caller can re-send.
    let pollErrors = 0;
    while (!TERMINAL.has(workflow.status)) {
      try {
        workflow = await this.request<Workflow>(
          'GET',
          `/v2/consumer/workflows/${encodeURIComponent(workflow.id)}?wait=${wait}&until=completion`,
          undefined,
          { lostIfNotFound: true }
        );
      } catch (err) {
        if (!(err instanceof RetryableError) || err instanceof LostResultError) throw err;
        if (++pollErrors > POLL_RETRIES) throw new PollGaveUpError(`poll gave up: ${err.message}`);
        await this.sleep(err.retryAfterMs ?? Math.min(60_000, 1000 * 2 ** pollErrors));
      }
    }
    return workflow;
  }

  private async submit(wait: number, body: unknown): Promise<Workflow> {
    try {
      return await this.request<Workflow>('POST', `/v2/consumer/workflows?wait=${wait}`, body);
    } catch (err) {
      if (err instanceof RetryableError && !err.rateLimited && !(err instanceof NotSentError)) {
        throw new AmbiguousSubmitError(err.message, err.retryAfterMs);
      }
      throw err;
    }
  }

  /**
   * Lowers the configured in-flight cap and step rate at runtime; an unset value restores the
   * configured one. Neither can be raised above its configured value.
   */
  setLimits({ inFlight, stepsPerSecond }: { inFlight?: number; stepsPerSecond?: number }) {
    this.inFlightLimit = inFlight;
    this.stepsPerSecondLimit = stepsPerSecond;
    this.applyCapacity();
  }

  private get honorsQuota() {
    return this.opts.honorQuota !== false;
  }

  private applyCapacity() {
    const quota = this.honorsQuota ? this.limits.quota ?? Infinity : Infinity;
    this.budget.setCapacity(Math.min(this.opts.maxInFlight, this.inFlightLimit ?? Infinity, quota));
  }

  /** How many steps may go out now. A 429's hold applies even when the quota headers are ignored. */
  private allowance(max: number, nothingInFlight: boolean) {
    if (!this.honorsQuota) return this.limits.waitMs(this.now()) > 0 ? 0 : max;
    return this.limits.allowance(max, nothingInFlight, this.now());
  }

  /** Applies the account quota as the cap, and logs the limits once, from the first response. */
  private observeLimits(headers: Headers) {
    const before = this.limits.quota;
    const seen = this.limits.observe(headers);
    if (seen.quota !== undefined && seen.quota !== before) this.applyCapacity();
    if (!this.limitsLogged && (seen.policies.size || seen.states.size)) {
      this.limitsLogged = true;
      logger.info(
        {
          inflightQuota: seen.quota,
          inflightRemaining: seen.remaining,
          quotaHonored: this.honorsQuota,
          buzzPolicy: seen.policies.get('buzz'),
          buzzRemaining: seen.states.get('buzz'),
          cap: this.budget.capacity,
        },
        'vector-sync: orchestrator rate limits'
      );
    }
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    { lostIfNotFound = false } = {}
  ): Promise<T> {
    let res: Response;
    try {
      res = await this.fetch(`${this.opts.endpoint}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.opts.token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      const cause = (err as Error).cause as { code?: string } | undefined;
      const message = `network: ${(err as Error).message}${cause?.code ? ` (${cause.code})` : ''}`;
      throw sentNothing(err) ? new NotSentError(message) : new RetryableError(message);
    }
    this.observeLimits(res.headers);
    if (res.ok) {
      try {
        return (await res.json()) as T;
      } catch (err) {
        // A 2xx that can't be read: a POST was accepted (retried as ambiguous), a GET is re-polled.
        throw new RetryableError(`unreadable response: ${(err as Error).message}`);
      }
    }

    const text = await res.text().catch(() => '');
    let retryAfterMs = parseRetryAfter(res.headers.get('retry-after'), this.now());
    if (res.status === 429) {
      // The in-flight quota or the buzz window. Every submit on this embedder waits it out.
      if (retryAfterMs !== undefined) retryAfterMs = this.limits.hold(retryAfterMs, this.now());
      throw new RetryableError(`429 ${text.slice(0, 200)}`, retryAfterMs, true);
    }
    if (res.status >= 500)
      throw new RetryableError(`${res.status} ${text.slice(0, 200)}`, retryAfterMs);
    // An ephemeral workflow that finished between polls is gone; send it again.
    if (res.status === 404 && lostIfNotFound)
      throw new LostResultError('ephemeral workflow gone before its result was read');
    // 400 is a bad input in the workflow; 401/403 is configuration and would fail every half too.
    if (res.status === 400) throw new WorkflowRejectedError(`400 ${text.slice(0, 500)}`);
    throw new Error(
      `orchestrator ${method} ${path.split('?')[0]} -> ${res.status} ${text.slice(0, 200)}`
    );
  }
}
