import { TRPCError } from '@trpc/server';
import { env } from '~/env/server.mjs';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { GetByIdInput } from '~/server/schema/base.schema';
import { GetSignalsAccessTokenResponse } from '~/server/schema/signals.schema';
import { logToAxiom } from '~/server/logging/client';

export async function getAccessToken({ id }: GetByIdInput) {
  logToAxiom({ type: 'signals', id }, 'connection-testing');
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
