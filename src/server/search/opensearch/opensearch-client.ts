// A thin OpenSearch REST client: the handful of calls index builds and writes need. No SDK, so
// every request is visible here and the transport is swappable in tests.

export type OpenSearchTransport = (
  method: 'GET' | 'PUT' | 'POST' | 'DELETE' | 'HEAD',
  path: string,
  body?: unknown,
  options?: { ndjson?: boolean }
) => Promise<{ status: number; body: unknown }>;

type BulkItemOutcome = {
  _id: string;
  status: number;
  error?: { type?: string; reason?: string };
};
export type OpenSearchSearchResponse = {
  took: number;
  hits: {
    total: { value: number; relation: 'eq' | 'gte' };
    hits: {
      _id: string;
      _source?: Record<string, unknown>;
      highlight?: Record<string, string[]>;
    }[];
  };
  aggregations?: Record<
    string,
    {
      buckets?: { key: string | number; doc_count: number }[];
      /** A `min` / `max` aggregation's result. */
      value?: number | null;
    }
  >;
};
type BulkResponse = { errors?: boolean; items: Record<string, BulkItemOutcome>[] };

export class OpenSearchError extends Error {
  constructor(readonly status: number, readonly path: string, readonly detail: unknown) {
    super(`OpenSearch ${status} on ${path}: ${JSON.stringify(detail).slice(0, 500)}`);
    this.name = 'OpenSearchError';
  }
}

export function fetchTransport({
  url,
  username,
  password,
  timeoutMs = 60_000,
}: {
  url: string;
  username?: string;
  password?: string;
  timeoutMs?: number;
}): OpenSearchTransport {
  const base = url.replace(/\/$/, '');
  const auth: Record<string, string> =
    username && password
      ? { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` }
      : {};
  return async (method, path, body, options) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...auth,
        'Content-Type': options?.ndjson ? 'application/x-ndjson' : 'application/json',
      },
      body:
        body === undefined ? undefined : options?.ndjson ? (body as string) : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  };
}

export type BulkOperation =
  | { action: 'index'; id: number | string; document: unknown }
  | { action: 'delete'; id: number | string };

export type BulkResult = {
  /** Ids the engine refused for a reason a retry cannot fix (mapping errors and the like). */
  rejected: { id: string; status: number; reason: string }[];
  /** Ids refused for load (429) or a node fault (5xx): safe to send again. */
  retryable: string[];
};

const isRetryableStatus = (status: number) => status === 429 || status >= 500;

export function createOpenSearchClient(transport: OpenSearchTransport) {
  const call = async (...args: Parameters<OpenSearchTransport>) => {
    const res = await transport(...args);
    if (res.status >= 400) throw new OpenSearchError(res.status, args[1], res.body);
    return res.body;
  };

  return {
    async indexExists(index: string) {
      const res = await transport('HEAD', `/${encodeURIComponent(index)}`);
      return res.status === 200;
    },
    createIndex: (index: string, body: { settings?: unknown; mappings?: unknown }) =>
      call('PUT', `/${encodeURIComponent(index)}`, body),
    deleteIndex: (index: string) => call('DELETE', `/${encodeURIComponent(index)}`),
    updateSettings: (index: string, settings: unknown) =>
      call('PUT', `/${encodeURIComponent(index)}/_settings`, { index: settings }),
    refresh: (index: string) => call('POST', `/${encodeURIComponent(index)}/_refresh`),
    async count(index: string): Promise<number> {
      const body = (await call('GET', `/${encodeURIComponent(index)}/_count`)) as { count: number };
      return body.count;
    },
    /** The concrete indexes `alias` points at today; empty when the alias does not exist. */
    async aliasTargets(alias: string): Promise<string[]> {
      const res = await transport('GET', `/_alias/${encodeURIComponent(alias)}`);
      if (res.status === 404) return [];
      if (res.status >= 400) throw new OpenSearchError(res.status, `/_alias/${alias}`, res.body);
      return Object.keys((res.body as Record<string, unknown> | undefined) ?? {});
    },
    /** Every concrete index whose name starts with `prefix`. */
    async listIndexes(prefix: string): Promise<string[]> {
      const body = await call(
        'GET',
        `/_cat/indices/${encodeURIComponent(prefix)}*?format=json&h=index`
      );
      return (body as { index: string }[]).map((row) => row.index).sort();
    },
    /** Points `alias` at `index` and away from everything else, in one atomic step. */
    async swapAlias(alias: string, index: string) {
      const current = await this.aliasTargets(alias);
      await call('POST', '/_aliases', {
        actions: [
          ...current.filter((i) => i !== index).map((i) => ({ remove: { index: i, alias } })),
          { add: { index, alias } },
        ],
      });
    },
    search: <T = OpenSearchSearchResponse>(index: string, body: unknown) =>
      call('POST', `/${encodeURIComponent(index)}/_search`, body) as Promise<T>,
    async bulk(index: string, operations: BulkOperation[]): Promise<BulkResult> {
      if (!operations.length) return { rejected: [], retryable: [] };
      const lines: string[] = [];
      for (const op of operations) {
        lines.push(JSON.stringify({ [op.action]: { _index: index, _id: String(op.id) } }));
        if (op.action === 'index') lines.push(JSON.stringify(op.document));
      }
      const res = await transport('POST', '/_bulk', lines.join('\n') + '\n', { ndjson: true });
      if (isRetryableStatus(res.status))
        return { rejected: [], retryable: operations.map((op) => String(op.id)) };
      if (res.status >= 400) throw new OpenSearchError(res.status, '/_bulk', res.body);

      const result: BulkResult = { rejected: [], retryable: [] };
      const body = res.body as BulkResponse | undefined;
      if (!body?.errors) return result;
      for (const item of body.items) {
        const outcome = Object.values(item)[0];
        // Deleting a document that is not there is the outcome a delete wants.
        if (outcome.status < 300 || (outcome.status === 404 && 'delete' in item)) continue;
        if (isRetryableStatus(outcome.status)) result.retryable.push(outcome._id);
        else
          result.rejected.push({
            id: outcome._id,
            status: outcome.status,
            reason: outcome.error?.reason ?? outcome.error?.type ?? 'unknown',
          });
      }
      return result;
    },
  };
}

export type OpenSearchClient = ReturnType<typeof createOpenSearchClient>;
