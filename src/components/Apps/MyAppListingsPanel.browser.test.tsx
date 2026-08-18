import { describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';

import { renderWithProviders } from '../../../test/component-setup';
import type { MyAppListingRow } from '~/components/Apps/MyAppListingsPanel';
import { myAppListingHref, MyAppListingsPanelView } from '~/components/Apps/MyAppListingsPanel';
import { capabilitiesForKind } from '~/shared/constants/app-capabilities.constants';

/** "My apps" — the ownership-OR-seat list a collaborator had no surface for. */

function appRow(over: Partial<MyAppListingRow> & { appListingId: string }): MyAppListingRow {
  const kind = over.kind ?? 'onsite';
  return {
    slug: `slug-${over.appListingId}`,
    name: `Name ${over.appListingId}`,
    status: 'approved',
    kind,
    appBlockId: kind === 'onsite' ? 'ab_1' : null,
    role: 'owner',
    capabilities: capabilitiesForKind(kind),
    ...over,
  };
}

describe('MyAppListingsPanelView', () => {
  test('an app held by a SEAT is listed and badged Collaborator, not Owner', async () => {
    renderWithProviders(
      <MyAppListingsPanelView rows={[appRow({ appListingId: 'apl_seat', role: 'editor' })]} />
    );
    const badge = page.getByTestId('apps-mine-role-apl_seat');
    await expect.element(badge).toHaveTextContent('Collaborator');
    await expect.element(badge).not.toHaveTextContent('Owner');
  });

  test('an OWNED app is badged Owner', async () => {
    renderWithProviders(
      <MyAppListingsPanelView rows={[appRow({ appListingId: 'apl_own', role: 'owner' })]} />
    );
    await expect.element(page.getByTestId('apps-mine-role-apl_own')).toHaveTextContent('Owner');
  });

  test('an OFF-SITE listing appears — the whole point of the listing-keyed read', async () => {
    renderWithProviders(
      <MyAppListingsPanelView
        rows={[appRow({ appListingId: 'apl_off', kind: 'offsite', role: 'editor' })]}
      />
    );
    await expect.element(page.getByTestId('apps-mine-row-apl_off')).toBeInTheDocument();
    await expect.element(page.getByTestId('apps-mine-row-apl_off')).toHaveTextContent('External');
  });

  test('each row links to the canonical listing-keyed editor', async () => {
    renderWithProviders(<MyAppListingsPanelView rows={[appRow({ appListingId: 'apl_1' })]} />);
    const link = page.getByTestId('apps-mine-link-apl_1');
    await expect.element(link).toBeInTheDocument();
    expect(link.element().getAttribute('href')).toBe('/apps/listing/apl_1/edit?tab=details');
  });

  test('an empty list says so; an error says something else', async () => {
    renderWithProviders(<MyAppListingsPanelView rows={[]} />);
    await expect.element(page.getByTestId('apps-mine-empty')).toBeInTheDocument();
  });

  test('a failed read shows the error, never "you have no apps"', async () => {
    renderWithProviders(
      <MyAppListingsPanelView rows={[]} errorMessage="Apps authoring is not enabled" />
    );
    await expect.element(page.getByTestId('apps-mine-error')).toBeInTheDocument();
    expect(page.getByTestId('apps-mine-empty').elements()).toHaveLength(0);
  });
});

describe('myAppListingHref — the row cannot deep-link a tab its kind refuses', () => {
  test('both kinds land on `details`, which every shape allows', () => {
    expect(myAppListingHref(appRow({ appListingId: 'apl_on' }))).toBe(
      '/apps/listing/apl_on/edit?tab=details'
    );
    expect(myAppListingHref(appRow({ appListingId: 'apl_off', kind: 'offsite' }))).toBe(
      '/apps/listing/apl_off/edit?tab=details'
    );
  });

  test('🔴 never `?tab=manifest` for an off-site row', () => {
    expect(myAppListingHref(appRow({ appListingId: 'apl_off', kind: 'offsite' }))).not.toContain(
      'manifest'
    );
  });
});

/**
 * 🔴 A row whose editor would refuse must not link to it. `getAppListingAuthoringContext`
 * throws FORBIDDEN on a non-authorable status, and before the status gate the canonical
 * page opened on a moderator-REMOVED listing with a fully live Collaborators tab — an
 * owner could invite someone onto a delisted app and the acceptance would mint repo write.
 */
describe('MyAppListingsPanelView — non-authorable listings are listed, not linked', () => {
  for (const status of ['removed', 'rejected'] as const) {
    test(`a \`${status}\` listing renders WITHOUT a link`, async () => {
      renderWithProviders(
        <MyAppListingsPanelView rows={[appRow({ appListingId: 'apl_x', status })]} />
      );
      // The row itself is the commit proof — it must still be listed.
      await expect.element(page.getByTestId('apps-mine-row-apl_x')).toBeInTheDocument();
      await expect.element(page.getByTestId('apps-mine-unlinked-apl_x')).toBeInTheDocument();
      expect(page.getByTestId('apps-mine-link-apl_x').elements()).toHaveLength(0);
    });
  }

  for (const status of ['draft', 'pending', 'approved'] as const) {
    test(`an \`${status}\` listing DOES link (the control)`, async () => {
      renderWithProviders(
        <MyAppListingsPanelView rows={[appRow({ appListingId: 'apl_y', status })]} />
      );
      await expect.element(page.getByTestId('apps-mine-link-apl_y')).toBeInTheDocument();
      expect(page.getByTestId('apps-mine-unlinked-apl_y').elements()).toHaveLength(0);
    });
  }
});
