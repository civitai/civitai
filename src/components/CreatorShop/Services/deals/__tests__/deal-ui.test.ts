import { describe, expect, it } from 'vitest';
import {
  awaitsViewer,
  dealButtons,
  dealEscrowState,
  dealPageState,
  dealQueryError,
  escrowCopy,
  disputeNotice,
  groupEventsByRound,
  isModeratorHold,
  requestSentMessage,
  roundLabel,
  sheetEventText,
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

describe('delivery actions', () => {
  const delivered = deal({ status: 'Delivered', deliveredAt: new Date() });
  const inWindow = deal({
    status: 'Completed',
    deliveredAt: new Date('2026-10-03T00:00:00Z'),
    releaseAt: new Date(Date.now() + 3_600_000),
  });

  it('renders accept, revision and cancellation on a delivery, accept first', () => {
    expect(rendered(delivered, BUYER, true)).toEqual([
      'acceptDelivery',
      'requestRevision',
      'requestCancellation',
    ]);
    expect(dealButtons(dealActions(delivered, BUYER), { servicesEnabled: true })[0]).toEqual({
      action: 'acceptDelivery',
      primary: true,
    });
  });

  it('renders Report a problem during the dispute window', () => {
    expect(rendered(inWindow, BUYER, true)).toEqual(['openDispute']);
  });

  // Decision (Creator Services P3, briony 2026-10-15): accepting a delivery finishes a deal and a
  // dispute is the buyer's only way to stop the payout on bad files, so both are exits and stay
  // with the flag off. A revision asks for new work, an entry, so it goes dark. Keep this in step
  // with the flag gate in creator-service-deal.router.ts: a dark flag must never trap held Buzz.
  it('keeps accept and the dispute with the flag off, but not a revision', () => {
    expect(rendered(delivered, BUYER, false)).toEqual(['acceptDelivery', 'requestCancellation']);
    expect(rendered(inWindow, BUYER, false)).toEqual(['openDispute']);
    expect(dealButtons(dealActions(delivered, BUYER), { servicesEnabled: false })[0]).toEqual({
      action: 'acceptDelivery',
      primary: true,
    });
  });
});

describe('awaits-you badge', () => {
  const awaits = (d: DealTimingFields, viewer: number, servicesEnabled = true) =>
    awaitsViewer(dealActions(d, viewer), { servicesEnabled });
  const cancelAsked = deal({
    status: 'CancellationRequested',
    cancellationRequestedAt: new Date('2026-10-02T00:00:00Z'),
    cancellationRequestedById: BUYER,
  });

  it('fires for the party the deal is waiting on', () => {
    expect(awaits(deal({ status: 'Requested' }), SELLER)).toBe(true);
    expect(awaits(deal({ status: 'Delivered', deliveredAt: new Date() }), BUYER)).toBe(true);
    expect(awaits(cancelAsked, SELLER)).toBe(true);
  });

  it('does not fire on an optional action alone', () => {
    // The buyer can withdraw a waiting request, but the seller is the one it waits on.
    expect(awaits(deal({ status: 'Requested' }), BUYER)).toBe(false);
    const inWindow = deal({
      status: 'Completed',
      deliveredAt: new Date('2026-10-03T00:00:00Z'),
      releaseAt: new Date(Date.now() + 3_600_000),
    });
    expect(dealActions(inWindow, BUYER).actions).toContain('openDispute');
    expect(awaits(inWindow, BUYER)).toBe(false);
    expect(awaits(cancelAsked, BUYER)).toBe(false);
  });

  it('does not fire when the flag hides the primary action', () => {
    expect(awaits(deal({ status: 'Requested' }), SELLER, false)).toBe(false);
  });
});

describe('deal page access', () => {
  it('renders for whoever the deal query returns to, flag on or off', () => {
    expect(dealPageState({ isLoading: false, hasDeal: true })).toEqual({ kind: 'deal' });
  });

  it('is NotFound when the server refuses the deal (a non-party, or no such deal)', () => {
    for (const code of ['NOT_FOUND', 'FORBIDDEN', 'UNAUTHORIZED'])
      expect(dealPageState({ isLoading: false, hasDeal: false, error: { code } })).toEqual({
        kind: 'notFound',
      });
  });

  it('reads the code a tRPC failure carries, and none from a failure without one', () => {
    expect(dealQueryError({ data: { code: 'NOT_FOUND' } })).toEqual({ code: 'NOT_FOUND' });
    expect(dealQueryError({ data: null })).toEqual({ code: undefined });
    expect(dealQueryError(null)).toBeNull();
    // A server refusal read through it still shows NotFound; a dropped connection does not.
    const state = (error: Parameters<typeof dealQueryError>[0]) =>
      dealPageState({ isLoading: false, hasDeal: false, error: dealQueryError(error) }).kind;
    expect(state({ data: { code: 'NOT_FOUND' } })).toBe('notFound');
    expect(state({ data: null })).toBe('error');
  });

  it('is an error, never NotFound, when the query fails any other way', () => {
    for (const error of [{ code: 'INTERNAL_SERVER_ERROR' }, { code: 'TIMEOUT' }, {}])
      expect(dealPageState({ isLoading: false, hasDeal: false, error })).toEqual({
        kind: 'error',
      });
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

  it('never calls a completed deal paid before it settles', () => {
    const state = dealEscrowState({ status: 'Completed', held: true, settled: false });
    expect(state).toBe('awaitingRelease');
    expect(escrowCopy[state].title).toBe('Held in escrow');
    expect(dealEscrowState({ status: 'Completed', held: true, settled: true })).toBe('released');
  });

  it('keeps a disputed deal held until it settles, then says moderators settled it', () => {
    expect(dealEscrowState({ status: 'Disputed', held: true, settled: false })).toBe('disputed');
    expect(escrowCopy.disputed.title).toBe('Held in escrow');
    const settled = dealEscrowState({ status: 'Disputed', held: true, settled: true });
    expect(settled).toBe('disputeSettled');
    expect(escrowCopy[settled].title).not.toMatch(/held|released|paid|refunded/i);
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

  // Decision (Creator Services P2): with the flag off the list is still how a party FINDS their
  // open deals, so it serves anyone with one, and only them.
  const hasOpen = (open: boolean) => async () => open;

  it('serves the list with the flag off to a user with an open deal, open deals only', async () => {
    expect(
      await resolveServiceDealsListPage({ ...signedIn, features: off }, hasOpen(true))
    ).toEqual({ props: { openOnly: true } });
  });

  it('404s the list with the flag off for a user with no open deal (none, or only closed)', async () => {
    expect(
      await resolveServiceDealsListPage({ ...signedIn, features: off }, hasOpen(false))
    ).toEqual({ notFound: true });
  });

  it('404s the list with the flag off when signed out, without revealing it via a login redirect', async () => {
    expect(
      await resolveServiceDealsListPage(
        { session: null, ctx: signedIn.ctx, features: off },
        hasOpen(true)
      )
    ).toEqual({ notFound: true });
  });

  it('serves the full list with the flag on', async () => {
    expect(
      await resolveServiceDealsListPage(
        { ...signedIn, features: { creatorServices: true } },
        hasOpen(false)
      )
    ).toEqual({ props: { openOnly: false } });
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

describe('accountability sheet rounds', () => {
  it('starts a round at each revision and never goes back to an earlier one', () => {
    // Escrow events are written with round 0 even after a revision.
    const events = [0, 0, 0, 1, 1, 0, 2, 0].map((round, id) => ({ id, round }));
    expect(
      groupEventsByRound(events).map((group) => [group.round, group.events.map((e) => e.id)])
    ).toEqual([
      [0, [0, 1, 2]],
      [1, [3, 4, 5]],
      [2, [6, 7]],
    ]);
    expect(roundLabel(0)).toBe('Original order');
    expect(roundLabel(2)).toBe('Revision 2');
  });
});

describe('moderator holds', () => {
  const event = (type: string, actorRole: string) => ({ type, actorRole });

  it('is a hold when Civitai opened the latest dispute, not the buyer', () => {
    expect(isModeratorHold([event('Completed', 'buyer'), event('Disputed', 'system')])).toBe(true);
    expect(isModeratorHold([event('Completed', 'buyer'), event('Disputed', 'buyer')])).toBe(false);
    expect(isModeratorHold([event('Disputed', 'system'), event('Disputed', 'buyer')])).toBe(false);
    expect(isModeratorHold([event('Completed', 'system')])).toBe(false);
    // Later events that open no dispute do not change who opened it.
    expect(
      isModeratorHold([event('Disputed', 'system'), event('DeadlineExtended', 'moderator')])
    ).toBe(true);
  });

  it('reads a refused cancellation after a hold as a party dispute, not the hold', () => {
    expect(
      isModeratorHold([event('Disputed', 'system'), event('CancellationDeclined', 'seller')])
    ).toBe(false);
  });

  it('labels a system hold neutrally and shows its reason to moderators only', () => {
    const hold = { type: 'Disputed', actorRole: 'system', comment: 'internal_code' };
    for (const viewer of ['buyer', 'seller'] as const)
      expect(sheetEventText(hold, viewer, 'Opened a dispute')).toEqual({
        label: 'Held the deal for moderator review',
        comment: null,
      });
    expect(sheetEventText(hold, 'moderator', 'Opened a dispute').comment).toBe('internal_code');
    const buyer = { type: 'Disputed', actorRole: 'buyer', comment: 'files are broken' };
    expect(sheetEventText(buyer, 'seller', 'Opened a dispute')).toEqual({
      label: 'Opened a dispute',
      comment: 'files are broken',
    });
  });

  it('shows the dispute notice only while the Buzz is still held', () => {
    const events = [event('Disputed', 'system')];
    expect(disputeNotice({ status: 'Disputed', settled: false, events })).toMatch(
      /held for moderator review/
    );
    expect(disputeNotice({ status: 'Disputed', settled: true, events })).toBeNull();
    expect(
      disputeNotice({ status: 'Disputed', settled: false, events: [event('Disputed', 'buyer')] })
    ).toMatch(/in dispute/);
    expect(disputeNotice({ status: 'Completed', settled: false, events })).toBeNull();
  });
});
