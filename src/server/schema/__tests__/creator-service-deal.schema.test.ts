import { describe, expect, it } from 'vitest';
import {
  declineServiceDealSchema,
  openServiceDealDisputeSchema,
  requestServiceDealCancellationSchema,
  requestServiceDealSchema,
} from '~/server/schema/creator-service-deal.schema';

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
        disclosureVersion: 'v1',
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
      disclosureVersion: 'v1',
    });
  });

  it('requires the revisions and delivery days the buyer was shown', () => {
    const base = { offeringId: 1, expectedPrice: 500, requestText: 'x', disclosureVersion: 'v1' };
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

it('requires the disclosure version the buyer was shown', () => {
  const input = {
    offeringId: 1,
    expectedPrice: 500,
    expectedRevisionsIncluded: 0,
    expectedDeliveryDays: 1,
    requestText: 'x',
  };
  expect(requestServiceDealSchema.safeParse(input).success).toBe(false);
  expect(requestServiceDealSchema.safeParse({ ...input, disclosureVersion: 'v1' }).success).toBe(
    true
  );
});

describe('exit reasons', () => {
  const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, value: object) =>
    schema.safeParse({ id: 1, ...value }).success;

  it.each([
    ['requestCancellation', requestServiceDealCancellationSchema, 'not_delivered'],
    ['openDispute', openServiceDealDisputeSchema, 'not_as_previewed'],
  ] as const)('%s takes text, a code, or both, but not neither', (_, schema, code) => {
    expect(ok(schema, {})).toBe(false);
    expect(ok(schema, { reason: '   ' })).toBe(false);
    expect(ok(schema, { reason: 'why' })).toBe(true);
    expect(ok(schema, { reasonCode: code })).toBe(true);
    expect(ok(schema, { reason: 'why', reasonCode: code })).toBe(true);
  });

  it('keeps decline reasons optional', () => {
    expect(ok(declineServiceDealSchema, {})).toBe(true);
    expect(ok(declineServiceDealSchema, { reasonCode: 'too_busy' })).toBe(true);
  });

  // One list per action: a code from another action's list is refused.
  it("refuses a code from another action's list", () => {
    expect(ok(declineServiceDealSchema, { reasonCode: 'not_delivered' })).toBe(false);
    expect(ok(requestServiceDealCancellationSchema, { reasonCode: 'too_busy' })).toBe(false);
    expect(ok(openServiceDealDisputeSchema, { reasonCode: 'quality' })).toBe(false);
  });
});
