import { describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { AppListingCard } from '~/components/Apps/AppListingCard';
import type { ListingCard } from '~/server/schema/blocks/app-listing-read.schema';

/**
 * P2b AppListingCard component tests (REPORT-ONLY — the browser project is
 * non-blocking; the blocking gate is appListingCardView.test.ts). These pin the
 * rendered kind badge, recommend label, and kind-aware CTA affordance for a few
 * representative cards.
 */

function base(over: Partial<ListingCard>): ListingCard {
  return {
    id: 'l1',
    slug: 'my-app',
    kind: 'onsite',
    name: 'My App',
    tagline: 'A handy app',
    category: 'utility',
    contentRating: null,
    iconUrl: null,
    coverUrl: null,
    creator: { id: 5, username: 'alice', image: null },
    recommend: { recommendedCount: 0, notRecommendedCount: 0, recommendPct: null },
    reviewCount: 0,
    kindData: { kind: 'onsite', appBlockId: 'blk-1', hasPage: true },
    ...over,
  };
}

describe('AppListingCard', () => {
  test('on-site page app + canOpenPage → Open link to the run route', async () => {
    renderWithProviders(<AppListingCard card={base({})} canOpenPage />);
    await expect.element(page.getByText('My App')).toBeInTheDocument();
    // exact: the "App" kind badge, else the substring also matches the title
    // ("My App") and description ("A handy app") — strict-mode violation.
    await expect.element(page.getByText('App', { exact: true })).toBeInTheDocument();
    await expect.element(page.getByText('by alice')).toBeInTheDocument();
    const open = page.getByRole('link', { name: 'Open' });
    await expect.element(open).toBeInTheDocument();
    await expect.element(open).toHaveAttribute('href', '/apps/run/my-app');
  });

  test('no reviews → "No reviews yet"', async () => {
    renderWithProviders(<AppListingCard card={base({})} canOpenPage />);
    await expect.element(page.getByText('No reviews yet')).toBeInTheDocument();
  });

  test('reviewed app → "N% recommend (M)"', async () => {
    renderWithProviders(
      <AppListingCard
        card={base({
          recommend: { recommendedCount: 9, notRecommendedCount: 1, recommendPct: 0.9 },
          reviewCount: 10,
        })}
        canOpenPage
      />
    );
    await expect.element(page.getByText('90% recommend (10)')).toBeInTheDocument();
  });

  test('off-site external-link https → Visit ↗ external anchor', async () => {
    renderWithProviders(
      <AppListingCard
        card={base({
          kind: 'offsite',
          name: 'External App',
          kindData: { kind: 'offsite', subKind: 'external-link', externalUrl: 'https://ext.app' },
        })}
      />
    );
    await expect.element(page.getByText('Off-site')).toBeInTheDocument();
    const visit = page.getByRole('link', { name: 'Visit' });
    await expect.element(visit).toHaveAttribute('href', 'https://ext.app');
    await expect.element(visit).toHaveAttribute('target', '_blank');
    await expect.element(visit).toHaveAttribute('rel', 'noopener noreferrer');
  });

  test('off-site connect → Connect badge + View details → unified detail (P2c)', async () => {
    // P2c: cards route to the unified detail; the Connect action itself lives on
    // the detail page (the connect flow needs a P2a authorize-URL DTO addition),
    // so the card's CTA is "View details", not an inert Connect button.
    renderWithProviders(
      <AppListingCard
        card={base({
          kind: 'offsite',
          name: 'Connect App',
          kindData: { kind: 'offsite', subKind: 'connect', externalUrl: null },
        })}
      />
    );
    // exact: the "Connect app" badge, else the substring also matches the title
    // ("Connect App", case-insensitive) — strict-mode violation.
    await expect.element(page.getByText('Connect app', { exact: true })).toBeInTheDocument();
    const details = page.getByRole('link', { name: 'View details' });
    await expect.element(details).toHaveAttribute('href', '/apps/store-preview/my-app');
  });

  test('on-site page app WITHOUT canOpenPage → View details → unified detail (P2c)', async () => {
    renderWithProviders(<AppListingCard card={base({})} canOpenPage={false} />);
    const details = page.getByRole('link', { name: 'View details' });
    await expect.element(details).toHaveAttribute('href', '/apps/store-preview/my-app');
  });
});
