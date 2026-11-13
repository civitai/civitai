import { describe, expect, it } from 'vitest';
import {
  dealActions,
  dealActorRole,
  dealDeadlines,
  dealEventActorId,
  dealVisibleReason,
  nextDealDeadline,
  type DealTimingFields,
} from '~/shared/utils/creator-service-deal-view';

const BUYER = 2;
const SELLER = 1;
const HOUR = 3_600_000;
const NOW = new Date('2026-10-20T12:00:00Z');
const ago = (hours: number) => new Date(NOW.getTime() - hours * HOUR);

const deal = (overrides: Partial<DealTimingFields> = {}): DealTimingFields => ({
  status: 'Requested',
  buyerId: BUYER,
  sellerId: SELLER,
  revisionsUsed: 0,
  revisionsIncluded: 1,
  requestedAt: ago(1),
  dueAt: null,
  deliveredAt: null,
  releaseAt: null,
  cancellationRequestedAt: null,
  cancellationRequestedById: null,
  heldAt: ago(1),
  settledAt: null,
  ...overrides,
});

describe('dealActions', () => {
  it('lets the seller accept only a confirmed hold, and always decline', () => {
    expect(dealActions(deal(), SELLER, NOW)).toEqual({
      actions: ['accept', 'decline'],
      primaryAction: 'accept',
    });
    expect(dealActions(deal({ heldAt: null }), SELLER, NOW)).toEqual({
      actions: ['decline'],
      primaryAction: null,
    });
  });

  // Decision (briony, 2026-10-15): after a moderator takedown the server refuses accept, so the
  // button must not be offered either. Decline stays, and so does everything the buyer can do.
  it('offers the seller only decline once a moderator has taken the offering down', () => {
    const takenDown = { offeringTakenDown: true };
    expect(dealActions(deal(), SELLER, NOW, takenDown)).toEqual({
      actions: ['decline'],
      primaryAction: null,
    });
    expect(dealActions(deal(), BUYER, NOW, takenDown).actions).toEqual(['withdraw']);
  });

  // With `creatorServices` off the router refuses these, so offering them is a dead button.
  it('drops the flag-gated actions, and a primary among them, while the flag is off', () => {
    const off = { gatedAllowed: false };
    expect(dealActions(deal(), SELLER, NOW, off)).toEqual({
      actions: ['decline'],
      primaryAction: null,
    });
    const delivered = deal({ status: 'Delivered', deliveredAt: ago(1) });
    expect(dealActions(delivered, BUYER, NOW, off)).toEqual({
      actions: ['acceptDelivery', 'requestCancellation'],
      primaryAction: 'acceptDelivery',
    });
  });

  it('lets the buyer withdraw a request, and nothing else', () => {
    expect(dealActions(deal(), BUYER, NOW).actions).toEqual(['withdraw']);
  });

  it('offers the late cancel only from a day past due', () => {
    const working = { status: 'Accepted' as const };
    expect(dealActions(deal({ ...working, dueAt: ago(23) }), BUYER, NOW).actions).toEqual([
      'requestCancellation',
    ]);
    expect(dealActions(deal({ ...working, dueAt: ago(25) }), BUYER, NOW)).toEqual({
      actions: ['cancelLate', 'requestCancellation'],
      primaryAction: 'cancelLate',
    });
  });

  it('never offers the late cancel after a delivery, however late', () => {
    expect(
      dealActions(deal({ status: 'InRevision', dueAt: ago(100) }), BUYER, NOW).actions
    ).toEqual(['requestCancellation']);
  });

  it('offers a revision only while one is left', () => {
    const delivered = { status: 'Delivered' as const, deliveredAt: ago(1) };
    expect(dealActions(deal(delivered), BUYER, NOW)).toEqual({
      actions: ['acceptDelivery', 'requestRevision', 'requestCancellation'],
      primaryAction: 'acceptDelivery',
    });
    expect(dealActions(deal({ ...delivered, revisionsUsed: 1 }), BUYER, NOW).actions).toEqual([
      'acceptDelivery',
      'requestCancellation',
    ]);
  });

  it('lets only the other party answer a cancellation', () => {
    const pending = { status: 'CancellationRequested' as const, cancellationRequestedById: BUYER };
    expect(dealActions(deal(pending), BUYER, NOW).actions).toEqual([]);
    expect(dealActions(deal(pending), SELLER, NOW).actions).toEqual(['respondCancellation']);
  });

  it('offers a dispute only inside the window and before payout', () => {
    const done = { status: 'Completed' as const, releaseAt: new Date(NOW.getTime() + HOUR) };
    expect(dealActions(deal(done), BUYER, NOW).actions).toEqual(['openDispute']);
    expect(dealActions(deal({ ...done, releaseAt: ago(1) }), BUYER, NOW).actions).toEqual([]);
    expect(dealActions(deal({ ...done, settledAt: ago(1) }), BUYER, NOW).actions).toEqual([]);
    expect(dealActions(deal(done), SELLER, NOW).actions).toEqual([]);
  });

  it('gives a moderator viewer no actions', () => {
    expect(dealActions(deal(), 999, NOW).actions).toEqual([]);
  });
});

describe('deadlines', () => {
  it('derives each from the timing constants', () => {
    expect(dealDeadlines(deal({ requestedAt: NOW })).acceptBy).toEqual(
      new Date(NOW.getTime() + 48 * HOUR)
    );
    expect(dealDeadlines(deal({ status: 'Delivered', deliveredAt: NOW })).autoCompleteAt).toEqual(
      new Date(NOW.getTime() + 72 * HOUR)
    );
    expect(
      dealDeadlines(deal({ status: 'CancellationRequested', cancellationRequestedAt: NOW }))
        .autoCancelAt
    ).toEqual(new Date(NOW.getTime() + 48 * HOUR));
    expect(dealDeadlines(deal({ status: 'Accepted', dueAt: NOW })).lateCancelFrom).toEqual(
      new Date(NOW.getTime() + 24 * HOUR)
    );
  });

  it('picks the soonest relevant one for the list card', () => {
    expect(nextDealDeadline(deal({ status: 'Accepted', dueAt: NOW }))).toEqual({
      kind: 'due',
      at: NOW,
    });
    expect(nextDealDeadline(deal({ status: 'Declined' }))).toBeNull();
  });
});

describe('dealActorRole', () => {
  it('names the system, the parties and anyone else as a moderator', () => {
    const d = deal();
    expect([-1, BUYER, SELLER, 42].map((id) => dealActorRole(d, id))).toEqual([
      'system',
      'buyer',
      'seller',
      'moderator',
    ]);
  });
});

// A moderator's id would let either party look up who ruled on their deal.
describe('dealEventActorId', () => {
  it("shows the parties' own ids and hides everyone else's", () => {
    const d = { buyerId: BUYER, sellerId: SELLER };
    expect([-1, BUYER, SELLER, 42].map((id) => dealEventActorId(d, id))).toEqual([
      null,
      BUYER,
      SELLER,
      null,
    ]);
  });
});

// The buyer must not learn the seller was banned, nor anyone the details of a failed scan.
describe('dealVisibleReason', () => {
  it('hides a system hold reason from the parties and shows it to moderators', () => {
    for (const reason of ['seller_unavailable', 'final_scan_failed']) {
      expect(dealVisibleReason(reason, false)).toBeNull();
      expect(dealVisibleReason(reason, true)).toBe(reason);
    }
  });

  it("shows a party's own words and other system notes to everyone", () => {
    for (const reason of ['broken zip', 'cancellation_declined', 'auto', null])
      expect(dealVisibleReason(reason, false)).toBe(reason);
  });
});
