import type { TRPCLink } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import type { AppRouter } from '~/server/routers';
import { recordTrpcError } from '~/utils/feedback/browserErrorLog';

type ErrorData = { code?: unknown; httpStatus?: unknown } | undefined;

/**
 * Records each failed call's path, code and status for a bug report to attach. A batched call
 * fails inside an HTTP 200 response, so the resource-timing recorder cannot see it.
 *
 * Reads only `op.path` and `error.data.{code,httpStatus}`: never `op.input` and never
 * `error.message`, which can quote the input back.
 */
export const feedbackErrorLink: TRPCLink<AppRouter> = () => {
  return ({ next, op }) =>
    observable((observer) =>
      next(op).subscribe({
        next: (value) => observer.next(value),
        error: (error) => {
          if (typeof window !== 'undefined') {
            try {
              const data = (error as { data?: ErrorData }).data;
              recordTrpcError({
                path: op.path,
                code: typeof data?.code === 'string' ? data.code : undefined,
                httpStatus: typeof data?.httpStatus === 'number' ? data.httpStatus : undefined,
              });
            } catch {
              // Recording is best effort and must never change what the caller sees.
            }
          }
          observer.error(error);
        },
        complete: () => observer.complete(),
      })
    );
};
