import { randomUUID } from 'node:crypto';
import pLimit from 'p-limit';
import { config } from '@/config';
import { logger } from '@/utils/logger';
import type { ImageRow } from './eligibility';
import { EMBED_MODEL, VECTOR_DIMENSIONS, type ModelStamp } from './qdrant';

// The orchestration client has no type for this step yet; this is the subset we send and read.
export type EmbedInput = { id: string; imageUrl?: string; videoUrl?: string };
type EmbedOutput = {
  model: string;
  modelRevision: string;
  profile: string;
  videoProfile?: string;
  dimensions: number;
  data: Array<{ id: string; index: number; embedding: number[] }>;
};
type Workflow = {
  id: string;
  status: string;
  steps?: Array<{ status?: string; output?: EmbedOutput }>;
};

export const MAX_INPUTS_PER_WORKFLOW = 128;
export const MAX_VIDEOS_PER_WORKFLOW = 8;
const MAX_VIDEO_SECONDS = 60;
const MAX_VIDEO_KB = 100 * 1024;
// The embedding profile is 512x512 pixels; 512 is on the image cacher's width ladder.
const EMBED_IMAGE_WIDTH = 512;
const TERMINAL = new Set(['succeeded', 'failed', 'expired', 'canceled']);

export type SkipReason =
  | 'external-url'
  | 'video-disabled'
  | 'video-too-long'
  | 'video-too-large'
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

/** Splits inputs into workflow-sized batches: at most 128 inputs and 8 videos each. */
export function chunkInputs(inputs: EmbedInput[]): EmbedInput[][] {
  const batches: EmbedInput[][] = [];
  let current: EmbedInput[] = [];
  let videos = 0;
  for (const input of inputs) {
    const isVideo = !!input.videoUrl;
    if (
      current.length === MAX_INPUTS_PER_WORKFLOW ||
      (isVideo && videos === MAX_VIDEOS_PER_WORKFLOW)
    ) {
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

class RetryableError extends Error {
  constructor(message: string, readonly retryAfterMs?: number) {
    super(message);
  }
}

/** The batch itself failed (a bad input, a failed workflow); splitting it may isolate the cause. */
class BatchFailedError extends Error {}

export type EmbedResult = {
  vectors: Map<number, number[]>;
  /** Ids that failed on their own after bisection. */
  failed: number[];
  stamp: ModelStamp | null;
};

export type EmbedderOptions = {
  endpoint: string;
  token: string;
  maxInFlight: number;
  maxRetries: number;
  priority: 'low' | 'normal';
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Wait passed to the orchestrator on submit and poll, seconds. */
  waitSeconds?: number;
};

export class Embedder {
  private readonly limit: ReturnType<typeof pLimit>;
  private readonly fetch: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: EmbedderOptions) {
    this.limit = pLimit(opts.maxInFlight);
    this.fetch = opts.fetch ?? globalThis.fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  static fromConfig(priority: 'low' | 'normal') {
    const { orchestratorEndpoint, embedToken, embedMaxInFlight, embedMaxRetries } =
      config.vectorSync;
    if (!orchestratorEndpoint || !embedToken) {
      throw new Error('ORCHESTRATOR_ENDPOINT and VECTOR_EMBED_TOKEN are required to embed');
    }
    return new Embedder({
      endpoint: orchestratorEndpoint,
      token: embedToken,
      maxInFlight: embedMaxInFlight,
      maxRetries: embedMaxRetries,
      priority,
    });
  }

  async embed(inputs: EmbedInput[]): Promise<EmbedResult> {
    const result: EmbedResult = { vectors: new Map(), failed: [], stamp: null };
    await Promise.all(
      chunkInputs(inputs).map((batch) => this.limit(() => this.embedBisecting(batch, result)))
    );
    return result;
  }

  private async embedBisecting(batch: EmbedInput[], result: EmbedResult): Promise<void> {
    try {
      const output = await this.runWithRetry(batch);
      result.stamp ??= {
        model: output.model,
        modelRevision: output.modelRevision,
        profile: output.profile,
        videoProfile: output.videoProfile,
        dimensions: output.dimensions,
      };
      for (const item of output.data) result.vectors.set(Number(item.id), item.embedding);
    } catch (err) {
      if (!(err instanceof BatchFailedError)) throw err;
      if (batch.length === 1) {
        logger.warn({ id: batch[0].id, err: err.message }, 'vector-sync: input failed to embed');
        result.failed.push(Number(batch[0].id));
        return;
      }
      const mid = Math.ceil(batch.length / 2);
      // Sequential: the halves already hold this slot of the in-flight limit.
      await this.embedBisecting(batch.slice(0, mid), result);
      await this.embedBisecting(batch.slice(mid), result);
    }
  }

  private async runWithRetry(batch: EmbedInput[]): Promise<EmbedOutput> {
    // One key per batch, reused across its retries, so a submit that succeeded server-side but
    // failed on our side returns the existing workflow instead of paying twice.
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

  private async run(batch: EmbedInput[], externalId: string): Promise<EmbedOutput> {
    const wait = this.opts.waitSeconds ?? 30;
    let workflow = await this.request<Workflow>('POST', `/v2/consumer/workflows?wait=${wait}`, {
      steps: [
        {
          $type: 'multimodalEmbedding',
          name: 'embed',
          priority: this.opts.priority,
          // Bounds the poll loop below; the default is a day.
          timeout: '00:30:00',
          input: { model: EMBED_MODEL, dimensions: VECTOR_DIMENSIONS, inputs: batch },
        },
      ],
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

    const output = workflow.steps?.[0]?.output;
    if (workflow.status !== 'succeeded' || !output) {
      throw new BatchFailedError(`workflow ${workflow.id} ${workflow.status}`);
    }
    if (output.data.length !== batch.length) {
      throw new BatchFailedError(
        `workflow ${workflow.id} returned ${output.data.length} of ${batch.length} vectors`
      );
    }
    return output;
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
    // 400 is a bad input in the batch; 401/403 is configuration and would fail every half too.
    if (res.status === 400) throw new BatchFailedError(`400 ${text.slice(0, 500)}`);
    throw new Error(
      `orchestrator ${method} ${path.split('?')[0]} -> ${res.status} ${text.slice(0, 200)}`
    );
  }
}
