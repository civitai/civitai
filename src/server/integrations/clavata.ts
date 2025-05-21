import { env } from '~/env/server';
import { ClavataStreamingResponse, v1CreateJobRequest, v1Outcome } from '~/types/clavata';

// clavata-api-client.ts
export interface ClavataApiClientOptions {
  /** https://api.clavata.ai, etc. (no trailing slash) */
  baseUrl: string;
  /** API token (Bearer <token>) */
  token: string;
  /** Default policy when none is supplied per call */
  policyId?: string;
  /** Default confidence threshold */
  confidenceThreshold?: number;
}

export interface ClavataTag {
  tag: string;
  confidence: number; // 0-100
  outcome?: v1Outcome;
}

export class ClavataApiClient {
  private readonly fetchFn: typeof fetch;
  private readonly opts: Required<
    Pick<ClavataApiClientOptions, 'baseUrl' | 'token' | 'policyId' | 'confidenceThreshold'>
  >;

  constructor(
    fetchFn: typeof fetch = fetch,
    { baseUrl, token, policyId = '', confidenceThreshold = 0 }: ClavataApiClientOptions
  ) {
    if (!baseUrl) throw new Error('baseUrl is required');
    if (!token) throw new Error('token is required');

    this.fetchFn = fetchFn;
    this.opts = { baseUrl, token, policyId, confidenceThreshold };
  }

  /** Accepts either a base-64 string (or data URI) *or* an image URL */
  async runJobAsync(
    image: string,
    policyId?: string,
    signal?: AbortSignal
  ): Promise<{ externalId: string; tags: ReadonlyArray<ClavataTag> }> {
    const base64 =
      image.startsWith('data:') || /^[A-Za-z0-9+/]+=*$/.test(image)
        ? image
        : await this.imageUrlToBase64(image, signal);

    return this.runJobWithBase64(base64, policyId, signal);
  }

  async runTextJobAsync(
    text: string,
    policyId?: string
  ): Promise<{ externalId: string; tags: ReadonlyArray<ClavataTag> }> {
    if (!text || !text.length) return { externalId: '', tags: [] };

    const body: v1CreateJobRequest = {
      contentData: [{ text }],
      policyId: policyId ?? this.opts.policyId,
      threshold: this.opts.confidenceThreshold,
    };

    const res = await this.fetchFn(`${this.opts.baseUrl}/v1/jobs/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.opts.token}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Clavata request failed (${res.status} ${res.statusText}): ${text}`);
    }

    const json = (await res.json()) as ClavataStreamingResponse;
    console.log(json);

    // TODO make sure this is right
    if (json.error && json.error.code && json.error.code !== 0) {
      throw new Error(
        `Clavata request failed: ${json.error.code}|${json.error.message}|${JSON.stringify(
          json.error.details
        )}`
      );
    }

    if (!json.result) {
      throw new Error('Expected JSON with result');
    }
    console.log(json.result);

    const externalId: string | undefined = json?.result?.jobUuid;
    if (!externalId) {
      throw new Error('Expected JSON with result.jobUuid');
    }

    const sectionReports = json.result.policyEvaluationReport?.sectionEvaluationReports ?? [];

    const tags = sectionReports
      .map((r) => ({
        tag: r.name as string,
        confidence: Math.round((r.reviewResult?.score ?? 0) * 100),
        outcome: r.reviewResult?.outcome,
      }))
      .filter((t) => t.tag && t.confidence > this.opts.confidenceThreshold * 100)
      .sort((a, b) => b.confidence - a.confidence);

    // TODO other data?

    return { externalId, tags };
  }

  /* ---------- private helpers ---------- */

  private async imageUrlToBase64(url: string, signal?: AbortSignal): Promise<string> {
    const res = await this.fetchFn(url, { signal });
    if (!res.ok) {
      throw new Error(`Failed to download image (${res.status} ${res.statusText})`);
    }
    const buffer = await res.arrayBuffer();
    return typeof Buffer !== 'undefined'
      ? Buffer.from(buffer).toString('base64')
      : btoa(String.fromCharCode(...new Uint8Array(buffer)));
  }

  // TODO combine with above
  private async runJobWithBase64(
    base64Image: string,
    policyId?: string,
    signal?: AbortSignal
  ): Promise<{ externalId: string; tags: ReadonlyArray<ClavataTag> }> {
    const body = {
      contentData: [{ image: base64Image }],
      policyId: policyId ?? this.opts.policyId,
      waitForCompletion: true,
      threshold: this.opts.confidenceThreshold,
    };

    const res = await this.fetchFn(`${this.opts.baseUrl}/v1/jobs/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.opts.token}`,
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Clavata request failed (${res.status} ${res.statusText}): ${text}`);
    }

    const json = (await res.json()) as any;
    const externalId: string | undefined = json?.result?.jobUuid;
    if (!externalId) {
      throw new Error('Expected JSON with result.jobUuid');
    }

    const sectionReports = json.result.policyEvaluationReport?.sectionEvaluationReports ?? [];

    const tags: ClavataTag[] = sectionReports
      .map((r: any) => ({
        tag: r.name as string,
        confidence: Math.round((r.reviewResult?.score ?? 0) * 100),
        outcome: r.reviewResult?.outcome,
      }))
      .filter((t: ClavataTag) => t.tag && t.confidence > this.opts.confidenceThreshold * 100)
      .sort((a: ClavataTag, b: ClavataTag) => b.confidence - a.confidence);

    return { externalId, tags };
  }
}

export const clavata =
  env.CLAVATA_ENDPOINT && env.CLAVATA_TOKEN
    ? new ClavataApiClient(fetch, {
        baseUrl: env.CLAVATA_ENDPOINT,
        token: env.CLAVATA_TOKEN,
        policyId: env.CLAVATA_POLICIES?.imageUpload,
        confidenceThreshold: 0.5,
      })
    : undefined;
