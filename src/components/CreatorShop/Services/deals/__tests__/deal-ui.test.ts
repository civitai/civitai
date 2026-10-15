import { describe, expect, it } from 'vitest';
import {
  dealButtons,
  dealEscrowState,
  dealPageState,
  escrowCopy,
  requestSentMessage,
  visibleDealActions,
} from '~/components/CreatorShop/Services/deals/deal-ui';
import {
  resolveServiceDealPage,
  resolveServiceDealsListPage,
} from '~/components/CreatorShop/Services/deals/deal-pages.server';
import { dealActions, type DealTimingFields } from '~/shared/utils/creator-service-deal-view';

const BUYER = 1;
const SELLER = 2;
const deal = (over: Partial<DealTimingFields>): DealTimingFields => ({
  status: 'Requested',
  buyerId: BUYER,
  sellerId: SELLER,
  revisionsUsed: 0,
  revisionsIncluded: 2,
  requestedAt: new Date('2026-10-01T00:00:00Z'),
  dueAt: null,
  deliveredAt: null,
  releaseAt: null,
  cancellationRequestedAt: null,
  cancellationRequestedById: null,
  heldAt: new Date('2026-10-01T00:01:00Z'),
  settledAt: null,
  ...over,
});

// What the deal page renders for a viewer: the server's actions, through the page's filter.
const rendered = (d: DealTimingFields, viewer: number, servicesEnabled: boolean) =>
  visibleDealActions(dealActions(d, viewer).actions, { servicesEnabled });

// Decision (Creator Services P2): with `creatorServices` off, a party to a deal still reaches the
// deal page, but only its ways out. No accept, no new commitments. The exit endpoints are ungated
// on the server for the same reason: turning the flag off must never trap held Buzz.
describe('deal actions with the flag off', () => {
  it('lets the seller decline but not accept a held request', () => {
    const d = deal({ status: 'Requested' });
    expect(rendered(d, SELLER, true)).toEqual(['accept', 'decline']);
    expect(rendered(d, SELLER, false)).toEqual(['decline']);
  });

  it('keeps the buyer withdraw, and the cancellation exchange, available', () => {
    expect(rendered(deal({ status: 'Requested' }), BUYER, false)).toEqual(['withdraw']);
    expect(
      rendered(
        deal({
          status: 'CancellationRequested',
          cancellationRequestedAt: new Date('2026-10-02T00:00:00Z'),
          cancellationRequestedById: BUYER,
        }),
        SELLER,
        false
      )
    ).toEqual(['respondCancellation']);
  });

  it('keeps an overdue late cancel available', () => {
    const d = deal({ status: 'Accepted', dueAt: new Date('2026-10-02T00:00:00Z') });
    expect(rendered(d, BUYER, false)).toEqual(['cancelLate', 'requestCancellation']);
  });
});

describe('deal actions in P2', () => {
  it('does not render delivery actions, which ship with file delivery', () => {
    const d = deal({ status: 'Delivered', deliveredAt: new Date() });
    expect(dealActions(d, BUYER).actions).toContain('acceptDelivery');
    expect(rendered(d, BUYER, true)).toEqual(['requestCancellation']);
  });
});

describe('deal page access', () => {
  it('renders for whoever the deal query returns to, flag on or off', () => {
    expect(dealPageState({ isLoading: false, hasDeal: true })).toEqual({ kind: 'deal' });
  });

  it('is NotFound when the query returns nothing (a non-party, or no such deal)', () => {
    expect(dealPageState({ isLoading: false, hasDeal: false })).toEqual({ kind: 'notFound' });
  });
});

describe('escrow state', () => {
  it('says "Confirming payment" until the hold is confirmed, never "held"', () => {
    const state = dealEscrowState({ status: 'Requested', held: false, settled: false });
    expect(state).toBe('confirming');
    expect(escrowCopy[state].title).toBe('Confirming payment');
    expect(dealEscrowState({ status: 'Requested', held: true, settled: false })).toBe('held');
  });

  it('never says a refund is coming for a deal that was never charged', () => {
    for (const status of ['Declined', 'Expired', 'Cancelled'] as const)
      expect(dealEscrowState({ status, held: false, settled: false })).toBe('closedUncharged');
  });

  it('calls the request held in its toast only when the hold is confirmed', () => {
    expect(requestSentMessage(false)).not.toMatch(/held/i);
    expect(requestSentMessage(true)).toMatch(/held/i);
  });

  it('reports a closed-without-completing deal as refund pending, then refunded', () => {
    for (const status of ['Declined', 'Expired', 'Cancelled'] as const) {
      expect(dealEscrowState({ status, held: true, settled: false })).toBe('refundPending');
      expect(dealEscrowState({ status, held: true, settled: true })).toBe('refunded');
    }
  });
});

describe('deal page routes with the flag off', () => {
  const signedIn = { session: { user: { id: BUYER } }, ctx: { resolvedUrl: '/services/deals/9' } };
  const off = { creatorServices: false };

  it('still serves a deal page (the deal query decides who sees it)', () => {
    expect(resolveServiceDealPage({ ...signedIn, features: off })).toEqual({ props: {} });
  });

  it('404s the request list, an entry point', () => {
    expect(resolveServiceDealsListPage({ ...signedIn, features: off })).toEqual({ notFound: true });
    expect(
      resolveServiceDealsListPage({ ...signedIn, features: { creatorServices: true } })
    ).toEqual({ props: {} });
  });
});

describe('deal page buttons', () => {
  it('drops a primary the flag filter removed, so accept never renders with the flag off', () => {
    const d = { actions: ['accept', 'decline'] as const, primaryAction: 'accept' as const };
    expect(dealButtons({ ...d, actions: [...d.actions] }, { servicesEnabled: false })).toEqual([
      { action: 'decline', primary: false },
    ]);
    expect(dealButtons({ ...d, actions: [...d.actions] }, { servicesEnabled: true })).toEqual([
      { action: 'accept', primary: true },
      { action: 'decline', primary: false },
    ]);
  });
});
