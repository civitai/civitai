// Server-side HTTP client for the search service (apps/search). Server-only: it carries the
// service token.
import { imageSearchResult, type ImageSearchInput, type ImageSearchResult } from './images';

export type SearchServiceErrorCode =
  | 'invalid'
  | 'unauthorized'
  | 'not-found'
  | 'not-ready'
  | 'upstream'
  | 'unavailable';

const CODE_BY_STATUS: Record<number, SearchServiceErrorCode> = {
  400: 'invalid',
  401: 'unauthorized',
  404: 'not-found',
  412: 'not-ready',
  502: 'upstream',
};

export class SearchServiceError extends Error {
  constructor(readonly code: SearchServiceErrorCode, message: string, readonly status?: number) {
    super(message);
    this.name = 'SearchServiceError';
  }
}

export type SearchClientOptions = {
  endpoint: string;
  token?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
};

export function createSearchClient({
  endpoint,
  token,
  timeoutMs = 10_000,
  fetch: fetchImpl = fetch,
}: SearchClientOptions) {
  const base = endpoint.replace(/\/+$/, '');

  async function post<T>(path: string, body: unknown, parse: (data: unknown) => T): Promise<T> {
    let res: Response;
    try {
      res = await fetchImpl(`${base}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new SearchServiceError('unavailable', `Search service unreachable: ${String(err)}`);
    }
    const data = (await res.json().catch(() => undefined)) as { error?: string } | undefined;
    if (!res.ok)
      throw new SearchServiceError(
        CODE_BY_STATUS[res.status] ?? 'unavailable',
        data?.error ?? `Search service error (${res.status})`,
        res.status
      );
    return parse(data);
  }

  return {
    images: {
      search: (input: ImageSearchInput): Promise<ImageSearchResult> =>
        post('/images/search', input, (data) => imageSearchResult.parse(data)),
    },
  };
}

export type SearchClient = ReturnType<typeof createSearchClient>;
