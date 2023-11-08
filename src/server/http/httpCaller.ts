import { QS } from '~/utils/qs';
import { handleLogError } from '../utils/errorHandling';

export abstract class HttpCaller {
  private baseUrl: string;
  private baseHeaders: MixedObject;

  constructor(baseUrl: string, options?: { headers?: MixedObject }) {
    this.baseUrl = baseUrl;
    this.baseHeaders = options?.headers || {};
  }

  private async prepareResponse<TData = any>(response: Response) {
    return {
      status: response.status,
      ok: response.ok,
      data: (await response.json().catch(() => null)) as TData | null,
    };
  }

  private handleFetchError(error: Error) {
    handleLogError(error);
    return { ok: false, status: 500, message: error.message } as const;
  }

  public async get<TResponse = unknown>(endpoint: string, opts?: { queryParams?: MixedObject }) {
    const url = QS.stringifyUrl({ url: `${this.baseUrl}${endpoint}`, query: opts?.queryParams });
    try {
      const response = await fetch(url, { headers: this.baseHeaders });

      return this.prepareResponse<TResponse>(response);
    } catch (error) {
      return this.handleFetchError(error as Error);
    }
  }

  public async post<TResponse = unknown, TPayload = unknown>(
    endpoint: string,
    opts: { payload: TPayload; headers?: MixedObject; queryParams?: MixedObject }
  ) {
    const { payload, headers, queryParams } = opts;
    const url = QS.stringifyUrl({ url: `${this.baseUrl}${endpoint}`, query: queryParams });
    try {
      const response = await fetch(url, {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: {
          'Content-Type': 'application/json',
          ...this.baseHeaders,
          ...headers,
        },
      });

      return this.prepareResponse<TResponse>(response);
    } catch (error) {
      return this.handleFetchError(error as Error);
    }
  }

  public async put<TResponse = unknown, TPayload = unknown>(
    endpoint: string,
    opts: { payload: TPayload; headers?: MixedObject; queryParams?: MixedObject }
  ) {
    const { payload, headers, queryParams } = opts;
    const url = QS.stringifyUrl({ url: `${this.baseUrl}${endpoint}`, query: queryParams });
    try {
      const response = await fetch(url, {
        method: 'PUT',
        body: JSON.stringify(payload),
        headers: {
          'Content-Type': 'application/json',
          ...this.baseHeaders,
          ...headers,
        },
      });

      return this.prepareResponse<TResponse>(response);
    } catch (error) {
      return this.handleFetchError(error as Error);
    }
  }

  public async delete<TResponse = unknown>(endpoint: string) {
    try {
      const response = await fetch(`${this.baseUrl}${endpoint}`, {
        method: 'DELETE',
      });

      return this.prepareResponse<TResponse>(response);
    } catch (error) {
      return this.handleFetchError(error as Error);
    }
  }
}
