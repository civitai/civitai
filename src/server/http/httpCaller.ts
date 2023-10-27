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

  public async get<TResponse = unknown>(endpoint: string) {
    const response = await fetch(`${this.baseUrl}${endpoint}`, { headers: this.baseHeaders });
    return this.prepareResponse<TResponse>(response);
  }

  public async post<TResponse = any, TPayload = unknown>(
    endpoint: string,
    opts: { payload: TPayload; headers?: MixedObject }
  ) {
    const { payload, headers } = opts;
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      method: 'POST',
      body: JSON.stringify(payload),
      headers: {
        'Content-Type': 'application/json',
        ...this.baseHeaders,
        ...headers,
      },
    });

    return this.prepareResponse<TResponse>(response);
  }

  public async put<TResponse = any, TPayload = unknown>(
    endpoint: string,
    opts: { payload: TPayload; headers?: MixedObject }
  ) {
    const { payload, headers } = opts;
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
      headers: {
        'Content-Type': 'application/json',
        ...this.baseHeaders,
        ...headers,
      },
    });

    return this.prepareResponse<TResponse>(response);
  }

  public async delete<TResponse = unknown>(endpoint: string) {
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      method: 'DELETE',
    });

    return this.prepareResponse<TResponse>(response);
  }
}
