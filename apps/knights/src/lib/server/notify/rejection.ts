import { NotificationsClientError } from '@civitai/notifications';

/**
 * True only when the notifications app certainly did not accept the batch: a refusal (4xx, including
 * 429) or a configuration error. A payload that fails validation is rejected by the sender before
 * this is consulted. Everything else, including an error of unknown origin, a timeout, a transport
 * error or a 5xx, may have come after the app saved the batch, so it is not definitive.
 */
export function isDefinitiveRejection(error: unknown): boolean {
  if (!(error instanceof NotificationsClientError)) return false;
  if (error.status === undefined) return !error.retryable;
  return error.status < 500;
}
