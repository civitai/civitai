import { TRPCClientError } from '@trpc/client';

/** A `TRPCClientError` shaped the way the client builds one from a server error response. */
export function trpcError(code: string, httpStatus: number, message: string) {
  return new TRPCClientError(message, {
    result: { error: { code: -32000, message, data: { code, httpStatus } } },
  } as unknown as ConstructorParameters<typeof TRPCClientError>[1]);
}
