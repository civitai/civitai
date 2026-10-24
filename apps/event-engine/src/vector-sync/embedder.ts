import { randomUUID } from 'node:crypto';
import { config } from '@/config';
import { logger } from '@/utils/logger';
import type { ImageRow } from './eligibility';
import { EMBED_MODEL, VECTOR_DIMENSIONS, type ModelStamp } from './qdrant';
import { QueueGate } from './queue-gate';

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
// The embedding profile is 512x512 pixels; 512 is on the image cacher's width ladder.
const EMBED_IMAGE_WIDTH = 512;
const TERMINAL = new Set(['succeeded', 'failed', 'expired', 'canceled']);

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
      imageUrl: edgeUrl(imageLocation, row.url, `width=${EMBED_IMAGE_WIDTH}`, '.jpeg'),
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

/** Splits inputs into workflows: at most `batchSize` (≤128) steps and 8 videos each. */
export function chunkInputs(
  inputs: EmbedInput[],
  batchSize = MAX_INPUTS_PER_WORKFLOW
): EmbedInput[][] {
  const batches: EmbedInput[][] = [];
  let current: EmbedInput[] = [];
  let videos = 0;
  for (const input of inputs) {
    const isVideo = !!input.videoUrl;
    if (current.length === batchSize || (isVideo && videos === MAX_VIDEOS_PER_WORKFLOW)) {
      batches.push(current);
      current = [];
      videos = 0;
    }
    current.push(input);
    if (isVideo) videos++;
  }
  if (current.length) batches.push(current);
  return batches;
}

/** Step names are how results map back to images. */
export const stepName = (id: string) => `img-${id}`;

/**
 * A budget of orchestrator jobs in flight, one per step. Waiters are served in order, and a
 * workflow larger than the budget takes all of it rather than waiting forever.
 */
export class JobBudget {
  private used = 0;
  private readonly waiters: Array<{ n: number; go: () => void }> = [];

  constructor(readonly capacity: number) {}

  async acquire(jobs: number): Promise<number> {
    const n = Math.min(jobs, this.capacity);
    if (!this.waiters.length && this.used + n <= this.capacity) {
      this.used += n;
      return n;
    }
    await new Promise<void>((go) => this.waiters.push({ n, go }));
    return n;
  }

  release(n: number) {
    this.used -= n;
    while (this.waiters.length && this.used + this.waiters[0].n <= this.capacity) {
      const next = this.waiters.shift()!;
      this.used += next.n;
      next.go();
    }
  }

  get inFlight() {
    return this.used;
  }
}

class RetryableError extends Error {
  constructor(message: string, readonly retryAfterMs?: number) {
    super(message);
  }
}

/** The orchestrator rejected the whole workflow (a 400); splitting it may isolate the input. */
class WorkflowRejectedError extends Error {}

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

export type EmbedderOptions = {
  endpoint: string;
  token: string;
  /** Orchestrator jobs (steps) in flight at once, across every call on this embedder. */
  maxInFlight: number;
  maxRetries: number;
  priority: 'low' | 'normal';
  batchSize?: number;
  /** Holds submits while the orchestrator's queue is deep. */
  gate?: Pick<QueueGate, 'waitOpen'>;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Wait passed to the orchestrator on submit and poll, seconds. */
  waitSeconds?: number;
};

type EmbedCall = {
  result: EmbedResult;
  /** The accepted stamp per media type: image and video steps report different profiles. */
  stamps: Map<'image' | 'video', ModelStamp>;
  /** Checked for every step's stamp before its vector is accepted; throwing rejects the workflow. */
  acceptStamp?: (stamp: ModelStamp) => Promise<void>;
};

export class Embedder {
  /** Called whenever a workflow returns vectors. */
  onProgress?: () => void;
  /** Set once a stamp has been accepted; the collection then has one recorded. */
  private stampSeen = false;
  readonly budget: JobBudget;
  private readonly fetch: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: EmbedderOptions) {
    this.budget = new JobBudget(Math.max(1, opts.maxInFlight));
    this.fetch = opts.fetch ?? globalThis.fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  static fromConfig(priority: 'low' | 'normal', gate?: Pick<QueueGate, 'waitOpen'>) {
    const { orchestratorEndpoint, embedToken, embedMaxInFlight, embedMaxRetries, imageLocation } =
      config.vectorSync;
    if (!orchestratorEndpoint || !embedToken) {
      throw new Error('ORCHESTRATOR_ENDPOINT and VECTOR_EMBED_TOKEN are required to embed');
    }
    // Without it every input is a relative URL and every step fails.
    if (!/^https?:\/\/[^/]/.test(imageLocation)) {
      throw new Error('VECTOR_IMAGE_LOCATION must be an absolute http(s) URL to embed');
    }
    return new Embedder({
      endpoint: orchestratorEndpoint,
      token: embedToken,
      maxInFlight: embedMaxInFlight,
      maxRetries: embedMaxRetries,
      batchSize: config.vectorSync.embedBatchSize,
      priority,
      // From VECTOR_QUEUE_PROM_URL when set; one gate per embedder, so per process.
      gate: gate ?? QueueGate.fromConfig(),
    });
  }

  async embed(
    inputs: EmbedInput[],
    { acceptStamp }: { acceptStamp?: (stamp: ModelStamp) => Promise<void> } = {}
  ): Promise<EmbedResult> {
    const call: EmbedCall = {
      result: { vectors: new Map(), failed: [], stamp: null },
      stamps: new Map(),
      acceptStamp,
    };
    const run = async (batch: EmbedInput[]) => {
      const held = await this.budget.acquire(batch.length);
      try {
        // After one systemic failure, workflows still queued are not submitted.
        if (call.result.error) return;
        await this.embedSplitting(batch, call, 0);
      } catch (err) {
        call.result.error ??= err;
      } finally {
        this.budget.release(held);
      }
    };
    const [first, ...rest] = chunkInputs(inputs, this.opts.batchSize);
    // Until a stamp has been accepted, the first workflow runs alone, so its model is recorded
    // before any other is compared against an empty stamp.
    const queued = this.stampSeen ? [first, ...rest] : rest;
    if (first && !this.stampSeen) await run(first);
    // allSettled, not all: one failing workflow must not discard the vectors others paid for.
    await Promise.allSettled(queued.filter(Boolean).map((batch) => run(batch)));
    return call.result;
  }

  private async embedSplitting(batch: EmbedInput[], call: EmbedCall, depth: number): Promise<void> {
    let workflow: Workflow;
    try {
      workflow = await this.runWithRetry(batch);
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
      if (
        out?.status !== 'succeeded' ||
        !output ||
        output.embedding?.length !== VECTOR_DIMENSIONS ||
        (output.precision && output.precision !== 'float32')
      ) {
        failed.push(input.id);
        continue;
      }
      const kind = input.videoUrl ? 'video' : 'image';
      const stamp: ModelStamp = {
        model: output.model,
        modelRevision: output.modelRevision,
        dimensions: output.dimensions,
        ...(kind === 'video' ? { videoProfile: output.profile } : { profile: output.profile }),
      };
      accepted.push([Number(input.id), output.embedding, stamp, kind]);
    }
    if (failed.length) {
      logger.warn({ workflow: workflow.id, ids: failed }, 'vector-sync: steps failed to embed');
      call.result.failed.push(...failed.map(Number));
    }

    // Every distinct stamp in this workflow is checked before any of its vectors is kept.
    const distinct = new Map<string, [ModelStamp, 'image' | 'video']>();
    for (const [, , stamp, kind] of accepted) distinct.set(JSON.stringify(stamp), [stamp, kind]);
    for (const [stamp, kind] of distinct.values()) {
      const seen = call.stamps.get(kind);
      if (seen && JSON.stringify(seen) !== JSON.stringify(stamp))
        throw new MixedStampError(seen, stamp);
      await call.acceptStamp?.(stamp);
      call.stamps.set(kind, stamp);
      this.stampSeen = true;
    }
    if (!accepted.length) return;
    this.onProgress?.();
    call.result.stamp ??= accepted[0][2];
    for (const [id, vector] of accepted) call.result.vectors.set(id, vector);
  }

  private async runWithRetry(batch: EmbedInput[]): Promise<Workflow> {
    // One key per attempt at this workflow, reused across its retries, so a submit that
    // succeeded server-side but failed on our side returns the existing workflow instead of
    // paying twice. Not derived from the inputs: the orchestrator returns a failed workflow for
    // its key too, which would make a transient failure permanent.
    const externalId = `vs-${randomUUID()}`;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.run(batch, externalId);
      } catch (err) {
        if (!(err instanceof RetryableError) || attempt >= this.opts.maxRetries) {
          if (err instanceof RetryableError)
            throw new Error(`embedding gave up after ${attempt + 1} attempts: ${err.message}`);
          throw err;
        }
        const backoff = Math.min(60_000, 1000 * 2 ** attempt) * (0.5 + Math.random() / 2);
        const delay = Math.max(err.retryAfterMs ?? 0, backoff);
        logger.warn({ attempt, delay, err: err.message }, 'vector-sync: embedding backoff');
        await this.sleep(delay);
      }
    }
  }

  private async run(batch: EmbedInput[], externalId: string): Promise<Workflow> {
    await this.opts.gate?.waitOpen();
    const wait = this.opts.waitSeconds ?? 30;
    // Not ephemeral: an ephemeral workflow disappears once terminal, and one that finishes
    // between two polls would take its paid vectors with it.
    let workflow = await this.request<Workflow>('POST', `/v2/consumer/workflows?wait=${wait}`, {
      steps: batch.map((input) => ({
        $type: 'multimodalEmbedding',
        name: stepName(input.id),
        priority: this.opts.priority,
        // Bounds the poll loop below; the default is a day.
        timeout: '00:30:00',
        input: {
          model: EMBED_MODEL,
          dimensions: VECTOR_DIMENSIONS,
          precision: 'float32',
          ...(input.videoUrl ? { videoUrl: input.videoUrl } : { imageUrl: input.imageUrl }),
        },
      })),
      tier: 'paid',
      allowMatureContent: true,
      externalId,
      tags: ['vector-sync'],
    });
    while (!TERMINAL.has(workflow.status)) {
      workflow = await this.request<Workflow>(
        'GET',
        `/v2/consumer/workflows/${encodeURIComponent(workflow.id)}?wait=${wait}&until=completion`
      );
    }
    return workflow;
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetch(`${this.opts.endpoint}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.opts.token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new RetryableError(`network: ${(err as Error).message}`);
    }
    if (res.ok) return (await res.json()) as T;

    const text = await res.text().catch(() => '');
    if (res.status === 429 || res.status >= 500) {
      const retryAfter = Number(res.headers.get('retry-after'));
      throw new RetryableError(
        `${res.status} ${text.slice(0, 200)}`,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined
      );
    }
    // 400 is a bad input in the workflow; 401/403 is configuration and would fail every half too.
    if (res.status === 400) throw new WorkflowRejectedError(`400 ${text.slice(0, 500)}`);
    throw new Error(
      `orchestrator ${method} ${path.split('?')[0]} -> ${res.status} ${text.slice(0, 200)}`
    );
  }
}
