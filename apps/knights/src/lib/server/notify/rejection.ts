import { NotificationsClientError } from '@civitai/notifications';

/**
 * True only when the notifications app certainly did not accept the batch: it answered with a refusal
 * (4xx, including 429). A client error with no status, which could be a dropped connection, is not
 * definitive, and neither is a missing configuration (checked before a run starts). A payload that fails validation is rejected by the sender before
 * this is consulted. Everything else, including an error of unknown origin, a timeout, a transport
 * error or a 5xx, may have come after the app saved the batch, so it is not definitive.
 */
export function isDefinitiveRejection(error: unknown): boolean {
  if (!(error instanceof NotificationsClientError) || error.status === undefined) return false;
  return error.status < 500;
}
