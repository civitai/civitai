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

const jsonParseFailure = /is not valid JSON|Unexpected token|JSON\.parse|Unexpected end of/i;

/**
 * tRPC drops the `Response` when `res.json()` throws, so an HTML body — an edge
 * rate-limit page, a gateway error — reaches the client as a bare `SyntaxError`
 * with no status to branch on.
 */
export function getQueryErrorMessage(error: {
  message: string;
  data?: { httpStatus?: number } | null;
}) {
  if (error.data?.httpStatus === 429)
    return 'Too many requests. Please wait a moment and try again.';
  if (jsonParseFailure.test(error.message))
    return "Couldn't reach the server — it may be busy. Please try again in a moment.";

  return error.message;
}
