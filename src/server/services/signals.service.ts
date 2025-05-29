import { TRPCError } from '@trpc/server';
import { env } from '~/env/server';
import type { GetByIdInput } from '~/server/schema/base.schema';
import type { GetSignalsAccessTokenResponse } from '~/server/schema/signals.schema';
import { throwBadRequestError } from '~/server/utils/errorHandling';

export async function getAccessToken({ id }: GetByIdInput) {
  // if (isProd) logToAxiom({ type: 'signals', id }, 'connection-testing').catch();
  const response = await fetch(`${env.SIGNALS_ENDPOINT}/users/${id}/accessToken`);
  if (!response.ok) {
    switch (response.status) {
      case 400:
        throw throwBadRequestError();
      default:
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'An unexpected error ocurred, please try again later',
        });
    }
  }

  const data: GetSignalsAccessTokenResponse = await response.json();
  return data;
}
