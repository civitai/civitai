import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ServiceOfferingStatus } from '~/shared/utils/prisma/enums';

// A services-only seller could not publish: the banner disabled "Publish shop" on `items.length === 0`
// though the server accepts a shop with only an Active service. This renders the real banner with the
// real hook mapping, and reads the button's own `disabled` attribute.

const mocks = vi.hoisted(() => ({
  mine: { offerings: [] as { status: string }[], hiddenOffDomain: 0 },
  loading: false,
  fetched: [] as boolean[],
}));

vi.mock('~/components/CreatorShop/Services/creator-service.util', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useQueryMyServices: (enabled: boolean) => {
    mocks.fetched.push(enabled);
    return { ...mocks.mine, isLoading: mocks.loading, eligibility: undefined };
  },
}));

const { PublishShopBanner } = await import('~/components/CreatorShop/Manage/PublishShopBanner');

const render = (props: {
  cosmeticCount?: number;
  cosmeticsLoading?: boolean;
  servicesCount?: boolean;
}) =>
  renderToStaticMarkup(
    createElement(
      MantineProvider,
      null,
      createElement(PublishShopBanner, {
        cosmeticCount: 0,
        cosmeticsLoading: false,
        servicesCount: true,
        onEnable: () => undefined,
        enabling: false,
        ...props,
      })
    )
  );

// The Publish button is the only <button> in the banner.
const publishDisabled = (html: string) => /<button[^>]*\bdisabled\b/.test(html);

beforeEach(() => {
  mocks.mine = { offerings: [], hiddenOffDomain: 0 };
  mocks.loading = false;
  mocks.fetched = [];
});

describe('the manage page publish banner', () => {
  it('enables Publish for a seller whose only item is an Active service', () => {
    mocks.mine.offerings = [{ status: ServiceOfferingStatus.Active }];
    expect(publishDisabled(render({}))).toBe(false);
  });

  it('keeps Publish disabled for an empty shop, and says why', () => {
    const html = render({});
    expect(publishDisabled(html)).toBe(true);
    expect(html).toContain('Add an item or publish a service before publishing your shop.');
  });

  it('does not let a Draft or Paused service fill the shop', () => {
    mocks.mine.offerings = [
      { status: ServiceOfferingStatus.Draft },
      { status: ServiceOfferingStatus.Paused },
    ];
    expect(publishDisabled(render({}))).toBe(true);
  });

  it('keeps Publish disabled for a viewer whose services cannot fill the shop (a moderator)', () => {
    mocks.mine.offerings = [{ status: ServiceOfferingStatus.Active }];
    const html = render({ servicesCount: false });
    expect(publishDisabled(html)).toBe(true);
    expect(html).toContain('Add at least one item before publishing your shop.');
  });

  it("asks for the seller's services only when they can fill the shop", () => {
    render({ servicesCount: true });
    render({ servicesCount: false });
    expect(mocks.fetched).toEqual([true, false]);
  });

  it('enables Publish when offerings this domain hides might be Active; the server answers', () => {
    mocks.mine.hiddenOffDomain = 2;
    expect(publishDisabled(render({}))).toBe(false);
  });

  it('does not block Publish while the services are still loading', () => {
    mocks.loading = true;
    expect(publishDisabled(render({}))).toBe(false);
  });

  it('does not block Publish while the cosmetics are still loading', () => {
    expect(publishDisabled(render({ cosmeticsLoading: true }))).toBe(false);
  });

  it('enables Publish when cosmetics fill the shop', () => {
    expect(publishDisabled(render({ cosmeticCount: 1 }))).toBe(false);
  });
});
