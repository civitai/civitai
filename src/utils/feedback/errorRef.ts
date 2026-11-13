/**
 * The reference a masked server fault carries in its message, "(ref: <12 hex>)" — written by
 * `getClientSafeError` in `src/server/trpc/client-safe-error.ts` and logged with the full error.
 * Read from the text because almost every caller rethrows as `new Error(error.message)`, which
 * keeps the message and drops the tRPC `data` that also holds it.
 */
export function parseErrorRef(message: string | undefined): string | undefined {
  return message?.match(/\(ref: ([0-9a-f]{12})\)/)?.[1];
}
