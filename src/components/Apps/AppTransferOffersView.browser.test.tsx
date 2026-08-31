import { describe, expect, test } from 'vitest';
import { page, userEvent } from 'vitest/browser';

// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import type { PendingInviteRow } from '~/components/Apps/AppInvitesBody';
import { AppInvitesBodyView } from '~/components/Apps/AppInvitesBody';
import type { IncomingTransferRow } from '~/components/Apps/AppTransferOffersView';
import {
  AppTransferOffersView,
  formatTransferExpiry,
  invalidationsForTransferResponse,
  transferDisclosureItems,
} from '~/components/Apps/AppTransferOffersView';

/**
 * `/apps/invites` — the OWNERSHIP-OFFER half of the inbox. Props-only view; no tRPC.
 */

function offer(over: Partial<IncomingTransferRow> & { transferId: string }): IncomingTransferRow {
  return {
    appListingId: `apl-${over.transferId}`,
    slug: `slug-${over.transferId}`,
    name: `Name ${over.transferId}`,
    kind: 'onsite',
    appBlockId: 'ab_1',
    iconUrl: null,
    fromUserId: 10,
    expiresAt: new Date('2026-08-17T12:00:00Z'),
    createdAt: new Date('2026-08-10T12:00:00Z'),
    // The default is the TRANSFERABLE offer, so every pre-existing arm below keeps
    // describing the ordinary case. The blocked branch is driven from the PAGE, in
    // `src/tests/pages/apps/invites-transfer-blocked.browser.test.tsx` — deliberately not
    // from a prop here, because a prop-driven arm is exactly what let #3935's owner-side
    // defect sit green for months.
    acceptBlockedReason: null,
    ...over,
  };
}

function invite(over: Partial<PendingInviteRow> & { appListingId: string }): PendingInviteRow {
  return {
    slug: `slug-${over.appListingId}`,
    kind: 'onsite',
    appBlockId: 'ab_1',
    invitedBy: 10,
    createdAt: new Date('2026-08-01T00:00:00Z'),
    ...over,
  };
}

describe('AppTransferOffersView', () => {
  test('renders one card per live offer, named by the listing', async () => {
    renderWithProviders(
      <AppTransferOffersView
        transfers={[
          offer({ transferId: 'aot_1', name: 'Shiny Thing' }),
          offer({ transferId: 'aot_2', name: 'Other Thing' }),
        ]}
      />
    );
    await expect.element(page.getByTestId('apps-transfer-aot_1')).toBeInTheDocument();
    await expect.element(page.getByTestId('apps-transfer-aot_2')).toBeInTheDocument();
    await expect.element(page.getByTestId('apps-transfer-aot_1')).toHaveTextContent('Shiny Thing');
  });

  /**
   * 🔴 THE DISTINCTION FROM A SEAT INVITE, asserted on the RENDERED OUTPUT of BOTH
   * components in ONE tree — which is the only place the claim can be settled. Each view
   * tested alone can look perfectly distinct and still render as two identical cards
   * beside each other, because "distinct" is a property of the PAIR.
   */
  test('🔴 an ownership offer reads differently from a seat invite on the same page', async () => {
    renderWithProviders(
      <div>
        <AppTransferOffersView transfers={[offer({ transferId: 'aot_1' })]} />
        <AppInvitesBodyView invites={[invite({ appListingId: 'apl_1' })]} />
      </div>
    );
    // Both are present — this is the combined state, not one component in isolation.
    await expect.element(page.getByTestId('apps-transfer-aot_1')).toBeInTheDocument();
    await expect.element(page.getByTestId('apps-invite-apl_1')).toBeInTheDocument();

    // 1. Its own titled section, which the seat inbox does not sit inside.
    await expect
      .element(page.getByTestId('apps-transfers-section'))
      .toHaveTextContent(/Ownership transfers/i);
    // 2. A badge that says what it is.
    await expect
      .element(page.getByTestId('apps-transfer-badge-aot_1'))
      .toHaveTextContent(/Ownership transfer/i);
    // 3. A warning naming the consequence, which the invite's disclosure does not carry.
    await expect
      .element(page.getByTestId('apps-transfer-warning-aot_1'))
      .toHaveTextContent(/current owner loses ownership/i);
    await expect
      .element(page.getByTestId('apps-invite-disclosure-apl_1'))
      .not.toHaveTextContent(/loses ownership/i);
    // 4. Different button copy — "Accept ownership", not "Accept".
    await expect
      .element(page.getByTestId('apps-transfer-accept-aot_1'))
      .toHaveTextContent(/Accept ownership/i);
    await expect
      .element(page.getByTestId('apps-invite-accept-apl_1'))
      .toHaveTextContent(/^Accept$/);
  });

  test('the warning names the irreversible half BEFORE the button', async () => {
    renderWithProviders(<AppTransferOffersView transfers={[offer({ transferId: 'aot_1' })]} />);
    const warning = page.getByTestId('apps-transfer-warning-aot_1');
    await expect.element(warning).toHaveTextContent(/current owner loses ownership/i);
    await expect.element(warning).toHaveTextContent(/collaborators keep their seats/i);
    await expect.element(page.getByTestId('apps-transfer-accept-aot_1')).toBeInTheDocument();
  });

  /**
   * 🔴 THE MONEY LINE. Buzz accrued before the transfer stays with the OLD owner — the
   * service deliberately never rewrites `BlockBuzzAttribution.appOwnerUserId`. A
   * recipient who is not told that will read a zeroed earnings page as a bug.
   */
  test('an ON-SITE offer says prior Buzz stays with the previous owner', async () => {
    renderWithProviders(<AppTransferOffersView transfers={[offer({ transferId: 'aot_1' })]} />);
    await expect
      .element(page.getByTestId('apps-transfer-warning-aot_1'))
      .toHaveTextContent(/stays with the previous owner/i);
  });

  test('an OFF-SITE offer promises no repo and no earnings, which cannot exist for it', async () => {
    renderWithProviders(
      <AppTransferOffersView
        transfers={[offer({ transferId: 'aot_off', kind: 'offsite', appBlockId: null })]}
      />
    );
    const warning = page.getByTestId('apps-transfer-warning-aot_off');
    await expect.element(warning).toBeInTheDocument();
    await expect.element(warning).not.toHaveTextContent(/repository/i);
    await expect.element(warning).not.toHaveTextContent(/Buzz/i);
    // …and it still says the owner-losing part, which is kind-independent.
    await expect.element(warning).toHaveTextContent(/loses ownership/i);
  });

  test('Accept and Decline report the right transfer and the right verdict', async () => {
    const calls: Array<[string, boolean]> = [];
    renderWithProviders(
      <AppTransferOffersView
        transfers={[offer({ transferId: 'aot_1' }), offer({ transferId: 'aot_2' })]}
        onRespond={(id, accept) => calls.push([id, accept])}
      />
    );
    const accept2 = page.getByTestId('apps-transfer-accept-aot_2');
    await expect.element(accept2).toBeInTheDocument();
    await userEvent.click(accept2.element());
    await userEvent.click(page.getByTestId('apps-transfer-decline-aot_1').element());
    expect(calls).toEqual([
      ['aot_2', true],
      ['aot_1', false],
    ]);
  });

  test('the in-flight offer is disabled; the others stay clickable', async () => {
    const calls: string[] = [];
    renderWithProviders(
      <AppTransferOffersView
        transfers={[offer({ transferId: 'aot_1' }), offer({ transferId: 'aot_2' })]}
        busyTransferId="aot_1"
        onRespond={(id) => calls.push(id)}
      />
    );
    await expect.element(page.getByTestId('apps-transfer-accept-aot_1')).toBeDisabled();
    await expect.element(page.getByTestId('apps-transfer-accept-aot_2')).not.toBeDisabled();
    await userEvent.click(page.getByTestId('apps-transfer-accept-aot_2').element());
    expect(calls).toEqual(['aot_2']);
  });

  test('the deadline is shown, so an offer that is about to lapse is visible', async () => {
    renderWithProviders(
      <AppTransferOffersView
        transfers={[offer({ transferId: 'aot_1', expiresAt: new Date('2026-08-17T12:00:00Z') })]}
      />
    );
    await expect
      .element(page.getByTestId('apps-transfer-expiry-aot_1'))
      .toHaveTextContent('Aug 17, 2026');
  });

  /**
   * 🔴 ABSENCE, WITH A POSITIVE CONTROL FIRST. `locator.elements()` is SYNCHRONOUS, so an
   * emptiness asserted straight after `render` passes whatever the component does. The
   * seat inbox beside it is the awaited proof that React has committed.
   */
  test('🔴 renders NOTHING when there are no offers — the seat inbox is untouched', async () => {
    renderWithProviders(
      <div>
        <AppTransferOffersView transfers={[]} />
        <AppInvitesBodyView invites={[invite({ appListingId: 'apl_1' })]} />
      </div>
    );
    await expect.element(page.getByTestId('apps-invite-apl_1')).toBeInTheDocument();
    expect(page.getByTestId('apps-transfers-section').elements()).toHaveLength(0);
  });

  test('🔴 renders NOTHING while loading, rather than an empty state that then flips', async () => {
    renderWithProviders(
      <div>
        <AppTransferOffersView transfers={[offer({ transferId: 'aot_1' })]} isLoading />
        <AppInvitesBodyView invites={[invite({ appListingId: 'apl_1' })]} />
      </div>
    );
    await expect.element(page.getByTestId('apps-invite-apl_1')).toBeInTheDocument();
    expect(page.getByTestId('apps-transfers-section').elements()).toHaveLength(0);
    expect(page.getByTestId('apps-transfer-aot_1').elements()).toHaveLength(0);
  });

  /** A failed read is NOT an empty inbox — saying "no offers" would be a false negative. */
  test('an error renders the error, not silence', async () => {
    renderWithProviders(<AppTransferOffersView transfers={[]} errorMessage="Nope." />);
    await expect.element(page.getByTestId('apps-transfers-error')).toHaveTextContent('Nope.');
  });

  test('the offering user is rendered through the injected identity slot', async () => {
    renderWithProviders(
      <AppTransferOffersView
        transfers={[offer({ transferId: 'aot_1', fromUserId: 77 })]}
        renderOfferer={(id) => <span data-testid={`stub-user-${id}`}>user {id}</span>}
      />
    );
    await expect.element(page.getByTestId('stub-user-77')).toBeInTheDocument();
  });
});

describe('transferDisclosureItems / formatTransferExpiry / invalidations', () => {
  test('the on-site list names the repo and the Buzz cut-off; the off-site one does not', () => {
    const onsite = transferDisclosureItems('onsite');
    const offsite = transferDisclosureItems('offsite');
    expect(onsite.some((i) => /repository/i.test(i))).toBe(true);
    expect(onsite.some((i) => /Buzz/i.test(i))).toBe(true);
    expect(offsite.some((i) => /repository/i.test(i))).toBe(false);
    expect(offsite.some((i) => /Buzz/i.test(i))).toBe(false);
    // Both still state the two kind-independent facts.
    for (const items of [onsite, offsite]) {
      expect(items.some((i) => /become the owner/i.test(i))).toBe(true);
      expect(items.some((i) => /loses ownership/i.test(i))).toBe(true);
    }
  });

  test('the expiry formatter is timezone-pinned and survives a string', () => {
    expect(formatTransferExpiry(new Date('2026-08-17T12:00:00Z'))).toBe('Aug 17, 2026');
    expect(formatTransferExpiry('2026-08-17T12:00:00Z')).toBe('Aug 17, 2026');
    expect(formatTransferExpiry('not a date')).toBe('soon');
  });

  /**
   * 🔴 PINNED AS EQUAL rather than pinned once and assumed: DECLINING is the case that can
   * take the offer count to zero, so an invalidation set gated on `accept` would leave a
   * nav entry pointing at an empty page.
   */
  test('accept and decline invalidate exactly the same keys', () => {
    expect(invalidationsForTransferResponse(true)).toEqual(invalidationsForTransferResponse(false));
    expect(invalidationsForTransferResponse(true)).toEqual([
      'appCollaborators.listMyPendingTransfers',
      'appListings.listMine',
      'blocks.getNavSummary',
    ]);
  });
});
