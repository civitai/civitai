export class ClientError extends Error {
  constructor(message?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ClientError';
  }
}

export class AuthorizationError extends Error {
  constructor(message?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AuthorizationError';
  }
}

export async function sleep(timeout: number) {
  return new Promise((resolve) => setTimeout(resolve, timeout));
}

export function withRetries<T>(
  fn: (remainingAttempts: number) => Promise<T>,
  retries = 3,
  retryTimeout?: number
): Promise<T> {
  return fn(retries).catch((error: Error) => {
    if (retries > 0) {
      if (retryTimeout) {
        return sleep(retryTimeout).then(() => {
          return withRetries(fn, retries - 1, retryTimeout);
        });
      }
      return withRetries(fn, retries - 1);
    } else {
      throw error;
    }
  });
}

/**
 * tRPC drops the `Response` when `res.json()` throws, so an HTML body — an edge
 * rate-limit page, a gateway error — arrives with no `data.httpStatus` to branch
 * on, carrying the raw `SyntaxError` as its cause.
 */
export function getQueryErrorMessage(error: {
  message: string;
  cause?: unknown;
  data?: { httpStatus?: number } | null;
}) {
  if (error.data?.httpStatus === 429)
    return 'Too many requests. Please wait a moment and try again.';
  if (error.cause instanceof SyntaxError)
    return "Couldn't reach the server — it may be busy. Please try again in a moment.";

  return error.message;
}
