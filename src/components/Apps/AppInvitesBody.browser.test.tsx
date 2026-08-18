import { describe, expect, test } from 'vitest';
import { page, userEvent } from 'vitest/browser';

import { renderWithProviders } from '../../../test/component-setup';
import type { PendingInviteRow } from '~/components/Apps/AppInvitesBody';
import {
  acceptedInviteHref,
  AppInvitesBodyView,
  invalidationsForInviteResponse,
} from '~/components/Apps/AppInvitesBody';

/** `/apps/invites` — the invitee's inbox. Props-only view; no tRPC. */

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

describe('AppInvitesBodyView', () => {
  test('renders one card per pending invitation', async () => {
    renderWithProviders(
      <AppInvitesBodyView
        invites={[invite({ appListingId: 'apl_1' }), invite({ appListingId: 'apl_2' })]}
      />
    );
    await expect.element(page.getByTestId('apps-invite-apl_1')).toBeInTheDocument();
    await expect.element(page.getByTestId('apps-invite-apl_2')).toBeInTheDocument();
  });

  /**
   * 🔴 THE DISCLOSURE IS ON BOTH SIDES OF THE HANDSHAKE. The owner is told what they are
   * granting before they send; the invitee is told what they are accepting before they
   * accept. Both are derived from the same `CAPABILITIES_BY_KIND` row, so they cannot
   * disagree.
   */
  test('an ON-SITE invite discloses earnings access before Accept', async () => {
    renderWithProviders(<AppInvitesBodyView invites={[invite({ appListingId: 'apl_1' })]} />);
    const disclosure = page.getByTestId('apps-invite-disclosure-apl_1');
    await expect.element(disclosure).toHaveTextContent(/Buzz earnings/i);
    await expect.element(page.getByTestId('apps-invite-accept-apl_1')).toBeInTheDocument();
  });

  test('an OFF-SITE invite does NOT promise earnings or code access', async () => {
    renderWithProviders(
      <AppInvitesBodyView
        invites={[invite({ appListingId: 'apl_off', kind: 'offsite', appBlockId: null })]}
      />
    );
    const disclosure = page.getByTestId('apps-invite-disclosure-apl_off');
    await expect.element(disclosure).toBeInTheDocument();
    await expect.element(disclosure).not.toHaveTextContent(/Buzz earnings/i);
    await expect.element(disclosure).not.toHaveTextContent(/Push code/i);
  });

  test('Accept and Decline report the right listing and the right verdict', async () => {
    const calls: Array<[string, boolean]> = [];
    renderWithProviders(
      <AppInvitesBodyView
        invites={[invite({ appListingId: 'apl_1' }), invite({ appListingId: 'apl_2' })]}
        onRespond={(id, accept) => calls.push([id, accept])}
      />
    );
    const accept2 = page.getByTestId('apps-invite-accept-apl_2');
    await expect.element(accept2).toBeInTheDocument();
    await userEvent.click(accept2.element());
    await userEvent.click(page.getByTestId('apps-invite-decline-apl_1').element());
    expect(calls).toEqual([
      ['apl_2', true],
      ['apl_1', false],
    ]);
  });

  test('the in-flight row is disabled; the others stay clickable', async () => {
    const calls: string[] = [];
    renderWithProviders(
      <AppInvitesBodyView
        invites={[invite({ appListingId: 'apl_1' }), invite({ appListingId: 'apl_2' })]}
        busyListingId="apl_1"
        onRespond={(id) => calls.push(id)}
      />
    );
    await expect.element(page.getByTestId('apps-invite-accept-apl_1')).toBeDisabled();
    await expect.element(page.getByTestId('apps-invite-accept-apl_2')).not.toBeDisabled();
    await userEvent.click(page.getByTestId('apps-invite-accept-apl_2').element());
    expect(calls).toEqual(['apl_2']);
  });

  test('an empty inbox says so — not a blank page', async () => {
    renderWithProviders(<AppInvitesBodyView invites={[]} />);
    await expect.element(page.getByTestId('apps-invites-empty')).toBeInTheDocument();
    expect(page.getByTestId('apps-invites-list').elements()).toHaveLength(0);
  });

  test('a failed read shows the error, never an empty inbox', async () => {
    renderWithProviders(
      <AppInvitesBodyView invites={[]} errorMessage="Apps authoring is not enabled" />
    );
    await expect.element(page.getByTestId('apps-invites-error')).toBeInTheDocument();
    expect(page.getByTestId('apps-invites-empty').elements()).toHaveLength(0);
  });

  test('an accepted invite points at the CANONICAL listing-keyed editor', () => {
    // Not `/apps/<appBlockId>/…`: an off-site listing has no block id to build one with,
    // and the accepted seat is on the LISTING.
    expect(acceptedInviteHref('apl_1')).toBe('/apps/listing/apl_1/edit');
  });
});

describe('AppInvitesBodyView — the inviter', () => {
  test('renders an injected inviter chip rather than a raw id', async () => {
    renderWithProviders(
      <AppInvitesBodyView
        invites={[invite({ appListingId: 'apl_1', invitedBy: 42 })]}
        renderInviter={(userId) => <span data-testid={`chip-${userId}`}>alice</span>}
      />
    );
    await expect.element(page.getByTestId('chip-42')).toBeInTheDocument();
    await expect.element(page.getByTestId('apps-invite-inviter-apl_1')).toHaveTextContent(/alice/);
  });

  test('falls back to a plain id label when no renderer is injected', async () => {
    // The default keeps the View renderable with no data layer at all — but production
    // always injects `UserAvatar`, so this is the test-only path.
    renderWithProviders(
      <AppInvitesBodyView invites={[invite({ appListingId: 'apl_1', invitedBy: 42 })]} />
    );
    await expect
      .element(page.getByTestId('apps-invite-inviter-apl_1'))
      .toHaveTextContent(/user #42/);
  });
});

/**
 * 🔴 THE INVALIDATION SET. `getNavSummary` carries `hasPendingInvites`, which drives the
 * "Invites" sub-nav tab — and DECLINING is the verdict that can take that count to zero.
 * Gating the invalidation on `accepted` (the shipped shape) left the tab pointing at an
 * empty page until a reload, in exactly the case where it should disappear. Only the View
 * had tests, so the container callback was unpinned.
 */
describe('invalidationsForInviteResponse', () => {
  test('🔴 ACCEPT and DECLINE invalidate the SAME set', () => {
    expect(invalidationsForInviteResponse('declined')).toEqual(
      invalidationsForInviteResponse('accepted')
    );
  });

  test('the nav summary is in the set for BOTH verdicts', () => {
    for (const status of ['accepted', 'declined', 'rejected']) {
      expect(invalidationsForInviteResponse(status)).toContain('blocks.getNavSummary');
    }
  });

  test('the inbox and My apps are invalidated too, and nothing else', () => {
    expect(invalidationsForInviteResponse('accepted').sort()).toEqual(
      [
        'appCollaborators.listMyPendingInvites',
        'appListings.listMine',
        'blocks.getNavSummary',
      ].sort()
    );
  });
});
