import { describe, expect, it } from 'vitest';
import { requestServiceDealSchema } from '~/server/schema/creator-service-deal.schema';

describe('requestServiceDealSchema', () => {
  // The price, the Buzz type and the seller come from the offering and the request's domain. A
  // client that sends them must have them dropped here, before the service ever sees them.
  it('drops anything the buyer could use to set the terms', () => {
    expect(
      requestServiceDealSchema.parse({
        offeringId: 1,
        expectedPrice: 500,
        requestText: ' draw my cat ',
        price: 1,
        buzzType: 'blue',
        sellerId: 99,
        buyerId: 98,
      })
    ).toEqual({ offeringId: 1, expectedPrice: 500, requestText: 'draw my cat' });
  });
});
