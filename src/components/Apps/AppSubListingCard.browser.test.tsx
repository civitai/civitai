import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../test/component-setup';
import type { SubListingCard } from '~/server/schema/blocks/app-listing-read.schema';

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));

const { AppSubListingCard, getSubListingHref } = await import('./AppSubListingCard');

const CARD: SubListingCard = {
  cardType: 'sub-listing',
  id: 'asl_01J9ZK3Q4R5S6T7V8W9X0Y1Z2A',
  name: 'Neon Portraits',
  tagline: 'Glowing headshots',
  kind: 'onsite',
  category: 'generation',
  contentRating: 'pg',
  coverUrl: null,
  creator: { id: 7, username: 'pixelwitch', image: null },
  parent: { id: 'apl_P', slug: 'custom-generators', name: 'Custom Generators', iconUrl: null },
  runHref: '/apps/run/custom-generators/g/NEON?sl=asl_01J9ZK3Q4R5S6T7V8W9X0Y1Z2A',
};

const hrefOf = (el: Element | null) => el?.closest('a')?.getAttribute('href');

describe('AppSubListingCard', () => {
  test('shows the item, its author and the app it lives in', async () => {
    renderWithProviders(<AppSubListingCard card={CARD} canOpenPage />);
    await expect.element(page.getByText('Neon Portraits')).toBeVisible();
    await expect.element(page.getByText('Glowing headshots')).toBeVisible();
    await expect
      .element(page.getByTestId('apps-sub-listing-parent-chip'))
      .toHaveTextContent('in Custom Generators');
    const author = page.getByTestId('apps-sub-listing-author');
    await expect.element(author).toHaveTextContent('by pixelwitch');
    expect(hrefOf(author.element())).toBe('/user/pixelwitch');
    expect(hrefOf(page.getByTestId('apps-sub-listing-parent-chip').element())).toBe(
      '/apps/store-preview/custom-generators'
    );
  });

  test('opens the item inside the app when the viewer can open app pages', async () => {
    renderWithProviders(<AppSubListingCard card={CARD} canOpenPage />);
    const cta = page.getByTestId('apps-sub-listing-cta');
    await expect.element(cta).toHaveTextContent('Open');
    expect(hrefOf(cta.element())).toBe(CARD.runHref);
    expect(hrefOf(page.getByText('Neon Portraits').element())).toBe(CARD.runHref);
  });

  test("otherwise sends the viewer to the app's store page", async () => {
    renderWithProviders(<AppSubListingCard card={CARD} canOpenPage={false} />);
    const cta = page.getByTestId('apps-sub-listing-cta');
    await expect.element(cta).toHaveTextContent('View Custom Generators');
    expect(hrefOf(cta.element())).toBe('/apps/store-preview/custom-generators');
    expect(hrefOf(page.getByText('Neon Portraits').element())).toBe(
      '/apps/store-preview/custom-generators'
    );
  });

  test('falls back to the placeholder cover when there is no image', async () => {
    renderWithProviders(<AppSubListingCard card={CARD} canOpenPage />);
    await expect.element(page.getByTestId('apps-listing-cover-placeholder')).toBeInTheDocument();
  });

  test('getSubListingHref never returns a URL the card did not get from the server', () => {
    expect(getSubListingHref(CARD, true)).toBe(CARD.runHref);
    expect(getSubListingHref(CARD, false)).toBe('/apps/store-preview/custom-generators');
  });
});
