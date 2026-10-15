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
        expectedRevisionsIncluded: 1,
        expectedDeliveryDays: 3,
        requestText: ' draw my cat ',
        revisionsIncluded: 9,
        deliveryDays: 1,
        price: 1,
        buzzType: 'blue',
        sellerId: 99,
        buyerId: 98,
      })
    ).toEqual({
      offeringId: 1,
      expectedPrice: 500,
      expectedRevisionsIncluded: 1,
      expectedDeliveryDays: 3,
      requestText: 'draw my cat',
    });
  });

  it('requires the revisions and delivery days the buyer was shown', () => {
    const base = { offeringId: 1, expectedPrice: 500, requestText: 'x' };
    expect(requestServiceDealSchema.safeParse(base).success).toBe(false);
    expect(
      requestServiceDealSchema.safeParse({ ...base, expectedRevisionsIncluded: 0 }).success
    ).toBe(false);
    expect(
      requestServiceDealSchema.safeParse({
        ...base,
        expectedRevisionsIncluded: 0,
        expectedDeliveryDays: 1,
      }).success
    ).toBe(true);
  });
});
