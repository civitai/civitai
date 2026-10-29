import { NotificationsClientError } from '@civitai/notifications';

/**
 * True when the notifications app certainly did not accept the batch: a refusal (4xx, including 429),
 * a configuration error, or a payload the client rejected before sending. A timeout, a transport
 * error or a 5xx may have come after the app saved the batch, so those are not definitive.
 */
export function isDefinitiveRejection(error: unknown): boolean {
  if (!(error instanceof NotificationsClientError)) return true;
  if (error.status === undefined) return !error.retryable;
  return error.status < 500;
}
