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
