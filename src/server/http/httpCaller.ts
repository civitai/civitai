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

  public async getRaw(endpoint: string, opts?: { queryParams?: MixedObject }) {
    const url = QS.stringifyUrl({ url: `${this.baseUrl}${endpoint}`, query: opts?.queryParams });
    return await fetch(url, { headers: this.baseHeaders });
  }

  public async get<TResponse = unknown>(endpoint: string, opts?: { queryParams?: MixedObject }) {
    try {
      const response = await this.getRaw(endpoint, opts);
      return this.prepareResponse<TResponse>(response);
    } catch (error) {
      return this.handleFetchError(error as Error);
    }
  }

  public async postRaw(
    endpoint: string,
    opts: { body: BodyInit | null | undefined; headers?: MixedObject; queryParams?: MixedObject }
  ) {
    const { body, headers, queryParams } = opts;
    const url = QS.stringifyUrl({ url: `${this.baseUrl}${endpoint}`, query: queryParams });
    return await fetch(url, {
      method: 'POST',
      body,
      headers: { ...this.baseHeaders, ...headers },
    });
  }

  public async post<TResponse = unknown, TPayload = unknown>(
    endpoint: string,
    opts: { payload: TPayload; headers?: MixedObject; queryParams?: MixedObject }
  ) {
    const { payload, headers, queryParams } = opts;

    try {
      const response = await this.postRaw(endpoint, {
        body: JSON.stringify(payload),
        headers: { 'Content-Type': 'application/json', ...headers },
        queryParams,
      });

      return this.prepareResponse<TResponse>(response);
    } catch (error) {
      return this.handleFetchError(error as Error);
    }
  }

  public async putRaw(
    endpoint: string,
    opts: { body: BodyInit | null | undefined; headers?: MixedObject; queryParams?: MixedObject }
  ) {
    const { body, headers, queryParams } = opts;
    const url = QS.stringifyUrl({ url: `${this.baseUrl}${endpoint}`, query: queryParams });
    return await fetch(url, {
      method: 'PUT',
      body,
      headers: { ...this.baseHeaders, ...headers },
    });
  }

  public async put<TResponse = unknown, TPayload = unknown>(
    endpoint: string,
    opts: { payload: TPayload; headers?: MixedObject; queryParams?: MixedObject }
  ) {
    const { payload, headers, queryParams } = opts;
    try {
      const response = await this.putRaw(endpoint, {
        body: JSON.stringify(payload),
        headers: { 'Content-Type': 'application/json', ...headers },
        queryParams,
      });

      return this.prepareResponse<TResponse>(response);
    } catch (error) {
      return this.handleFetchError(error as Error);
    }
  }

  public async deleteRaw(endpoint: string) {
    return await fetch(`${this.baseUrl}${endpoint}`, {
      method: 'DELETE',
    });
  }

  public async delete<TResponse = unknown>(endpoint: string) {
    try {
      const response = await this.deleteRaw(endpoint);

      return this.prepareResponse<TResponse>(response);
    } catch (error) {
      return this.handleFetchError(error as Error);
    }
  }
}
