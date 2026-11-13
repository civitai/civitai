import type { AppCoverWorkflow } from '@civitai/app-assistant';
import { authedFetch, type FreeTierStatus } from '@civitai/components-chat/core';

import type { TokenSource } from './minter';

/** A workflow as orchestration's consumer API returns it: only the fields the runner reads. */
export interface Workflow {
  id?: string | null;
  tags?: string[] | null;
  metadata?: unknown;
}

/**
 * What a workflow's status is (orchestration's `WorkflowStatus`, camelCase on the consumer API):
 * `unassigned`, `preparing`, `scheduled` and `processing` are live; the rest are final.
 */
export type WorkflowStatus =
  | 'unassigned'
  | 'preparing'
  | 'scheduled'
  | 'processing'
  | 'succeeded'
  | 'failed'
  | 'expired'
  | 'canceled';

export const FINAL_STATUSES: readonly string[] = ['succeeded', 'failed', 'expired', 'canceled'];

/** `GET /v2/consumer/workflows/{id}`: only the fields the runner reads, all unchecked. */
export interface WorkflowState {
  id?: string | null;
  status?: WorkflowStatus | string | null;
  steps?: { $type?: string; status?: string | null; output?: unknown }[] | null;
}

export interface WorkflowTemplate {
  steps: { $type: string; name: string; input: Record<string, unknown> }[];
  tags: string[];
  metadata: unknown;
  externalId: string;
}

/** A refusal from orchestration, with its status. */
export class OrchestrationError extends Error {
  override name = 'OrchestrationError';
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const WORKFLOWS = 'v2/consumer/workflows';
/** The longest one call may take in all: its mint, its request, and a fresh mint and retry after a 401. */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * The orchestration consumer routes the conversation store uses, the same ones the chat's
 * `ThreadStore` reaches through `@civitai/sdk` and the chat's own `OrchestrationApi`: each request
 * carries a `chat` token from `tokens`, and a 401 is asked again once with a fresh one.
 */
export class OrchestrationClient {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(baseUrl: string, doFetch: typeof fetch = fetch) {
    this.#baseUrl = baseUrl.replace(/\/+$/, '');
    this.#fetch = doFetch;
  }

  queryWorkflows(
    tokens: TokenSource,
    query: { tags: string[]; take: number }
  ): Promise<{ items: Workflow[] }> {
    const params = new URLSearchParams();
    for (const tag of query.tags) params.append('tags', tag);
    params.set('take', String(query.take));
    return this.#json(tokens, 'GET', `${WORKFLOWS}?${params}`);
  }

  submitWorkflow(tokens: TokenSource, template: WorkflowTemplate): Promise<Workflow> {
    return this.#json(tokens, 'POST', WORKFLOWS, template);
  }

  /** What `template` would cost (orchestration's what-if); submits nothing. */
  estimateWorkflow(
    tokens: TokenSource,
    template: AppCoverWorkflow
  ): Promise<{ cost?: { total?: number | null } | null }> {
    return this.#json(tokens, 'POST', `${WORKFLOWS}?whatif=true`, template);
  }

  async updateWorkflow(
    tokens: TokenSource,
    workflowId: string,
    patch: { metadata: unknown }
  ): Promise<void> {
    await this.#json(tokens, 'PUT', `${WORKFLOWS}/${encodeURIComponent(workflowId)}`, patch);
  }

  async removeTag(tokens: TokenSource, workflowId: string, tag: string): Promise<void> {
    await this.#json(
      tokens,
      'DELETE',
      `${WORKFLOWS}/${encodeURIComponent(workflowId)}/tags/${encodeURIComponent(tag)}`
    );
  }

  getFreeTier(tokens: TokenSource): Promise<FreeTierStatus> {
    return this.#json(tokens, 'GET', 'v2/consumer/free-tier');
  }

  /**
   * A workflow's status and steps. With `waitSeconds`, orchestration holds the answer until the
   * workflow ends or that long passes (then answers 202 with it as it stands). `signal` stops waiting.
   */
  getWorkflow(
    tokens: TokenSource,
    workflowId: string,
    options: { waitSeconds?: number; signal?: AbortSignal } = {}
  ): Promise<WorkflowState> {
    const wait = options.waitSeconds ? `?wait=${options.waitSeconds}` : '';
    return this.#json(
      tokens,
      'GET',
      `${WORKFLOWS}/${encodeURIComponent(workflowId)}${wait}`,
      undefined,
      options.signal
    );
  }

  /** Cancels a workflow; a chat completion's job stops at once (orchestration's claim-cancellable jobs). */
  async cancelWorkflow(tokens: TokenSource, workflowId: string): Promise<void> {
    await this.#json(tokens, 'PUT', `${WORKFLOWS}/${encodeURIComponent(workflowId)}`, {
      status: 'canceled',
    });
  }

  async #json<T>(
    tokens: TokenSource,
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal
  ): Promise<T> {
    // The chat package's own signing fetch: a token per request, asked again fresh after a 401.
    const send = authedFetch(
      { getToken: ({ fresh } = {}) => tokens('chat', { fresh }) },
      this.#fetch
    );
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const response = await send(`${this.#baseUrl}/${path}`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    });
    const text = await response.text();
    if (!response.ok)
      throw new OrchestrationError(
        response.status,
        `orchestration answered ${response.status} to ${method} ${path.split('?')[0]}`
      );
    return (text ? JSON.parse(text) : undefined) as T;
  }
}
