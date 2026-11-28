import { TRPCError } from '@trpc/server';
import { createBuzzClient } from '@civitai/buzz';
import { env } from '~/env/server';
import { isDev } from '~/env/other';
import { throwBadRequestError } from '~/server/utils/errorHandling';

export const buzzService = createBuzzClient({
  endpoint: env.BUZZ_ENDPOINT,
  log: isDev ? (message, ...args) => console.log(message, ...args) : undefined,
  // Every branch carries the BuzzApiError as `cause`: the mapping is lossy (400 and 409 share one
  // code and message), so a caller that has to tell them apart has nothing else to read. Recover it
  // with `getBuzzApiStatus`; tRPC's error shape does not send `cause` to clients.
  mapError: (error) => {
    switch (error.status) {
      case 400:
        throw throwBadRequestError(null, error);
      case 404:
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Not found', cause: error });
      case 409:
        throw throwBadRequestError('There is a conflict with the transaction', error);
      default:
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'An unexpected error ocurred, please try again later',
          cause: error,
        });
    }
  },
});
