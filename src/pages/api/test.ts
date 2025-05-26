import { NextApiRequest, NextApiResponse } from 'next';
import inovoPayClient from '~/server/http/inovopay/inovopay.caller';
import { createBuzzOrder } from '~/server/services/inovopay.service';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';

export default PublicEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  try {
    const data = await createBuzzOrder({
      firstName: 'John',
      lastName: 'Doe',
      email: 'john.doe@example.com',
      billingAddress: '123 Main St',
      billingCity: 'New York',
      billingState: 'NY',
      billingZip: '10001',
      billingCountry: 'US',
      cardNumber: '4111111111111111', // Example card number
      tokenGuid: null,
      cardKey: '100',
      cardExpiry: '122026',
      buzzAmount: 10000,
      unitAmount: 1000,
      currency: 'USD', // Assuming USD as the currency
      userId: 1, // Assuming a user ID of 1 for this example
    });

    res.status(200).json({
      data,
    });
  } catch (error) {
    console.error('Error creating buzz order:', error);
    res.status(500).json({ error: 'Failed to create buzz order', error });
  }
});
