import { Currency } from '@prisma/client';
import { chunk } from 'lodash-es';
import { constants } from '~/server/common/constants';
import { dbRead, dbWrite } from '~/server/db/client';
import { throwAuthorizationError, throwBadRequestError } from '~/server/utils/errorHandling';
import { getServerStripe } from '~/server/utils/get-server-stripe';
import { getBaseUrl } from '~/server/utils/url-helpers';
import { createLogger } from '~/utils/logging';
import { formatPriceForDisplay } from '~/utils/number-helpers';
import * as Schema from '../schema/stripe.schema';
import { PaymentMethodDeleteInput } from '../schema/stripe.schema';
import { completeStripeBuzzTransaction } from './buzz.service';
import { invalidateSession } from '~/server/utils/session-helpers';
import { createBuzzTransaction, getOrCreateCustomer } from '~/server/paddle/client';

const baseUrl = getBaseUrl();
const log = createLogger('paddle', 'yellow');

export const createCustomer = async ({ id, email }: Schema.CreateCustomerInput) => {
  const user = await dbWrite.user.findUnique({ where: { id }, select: { paddleCustomerId: true } });
  if (!user?.paddleCustomerId) {
    const customer = await getOrCreateCustomer({ email, userId: id });

    await dbWrite.user.update({ where: { id }, data: { paddleCustomerId: customer.id } });
    await invalidateSession(id);

    return customer.id;
  } else {
    return user.paddleCustomerId;
  }
};

export const getTransaction = async ({
  unitAmount,
  currency = Currency.USD,
  customerId,
  user,
}: Schema.PaymentIntentCreationSchema & {
  user: { id: number; email: string };
  customerId?: string;
}) => {
  // TODO: If a user doesn't exist, create one. Initially, this will be protected, but ideally, we should create the user on our end
  if (!customerId) {
    customerId = await createCustomer(user);
  }

  if (!customerId) {
    throw throwBadRequestError('We were unable to get or create a customer');
  }

  const transaction = await createBuzzTransaction({
    customerId,
    unitAmount,
    currency,
  });

  return {
    transactionId: transaction.id,
  };
};
