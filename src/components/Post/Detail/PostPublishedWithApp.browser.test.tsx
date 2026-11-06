/**
 * The post-detail "Made with <app>" credit, in real Chromium.
 *
 * Pinned here and nowhere else:
 *
 *  1. 🔴 THE WORDING, as a WHOLE NORMALISED STRING. `public-owner.ts` exists because the app page
 *     once rendered `by {appName}` and, since an approved block's `OauthClient.name` equals the
 *     app's own title, the AUTHOR slot showed the APP TITLE. A reword toward "by" is the
 *     regression that matters, and a `toContain('Made with')` check would pass on "Made with X by X".
 *  2. The LINKED vs UNLINKED branches, a disclosure decision: a not-viewable app must not get a
 *     `/apps/store-preview/<slug>` link the destination refuses to serve, and must not fetch a card.
 *  3. That a null chip renders NOTHING.
 *  4. That a resolved card is what renders for a viewable app, and that a card read that has not
 *     arrived falls back to the linked name instead of dropping the credit.
 *
 * `AppListingCard` is stubbed: it needs a dozen unrelated procedures and has its own test. The stub
 * records its props so the wiring (the card the server returned, `canOpenPage` from the flag) is
 * what is asserted here.
 *
 * 🔴 EVERY DOM READ IS GATED ON AN AWAITED LOCATOR FIRST. React commits asynchronously, so a
 * synchronous `document.querySelector` after `renderWithProviders` reads an EMPTY container, which
 * looks exactly like a component that returned null. The negative tests render a sibling marker and
 * wait for it, so the zero has a positive control.
 */
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as TrpcModule from '~/utils/trpc';
import type * as FeatureFlagsMod from '~/providers/FeatureFlagsProvider';
import type { PostAppChip } from '~/server/services/blocks/post-app-chip.logic';
import type { ListingCard } from '~/server/schema/blocks/app-listing-read.schema';

const mocks = vi.hoisted(() => ({
  card: undefined as unknown,
  cardInputs: [] as unknown[],
  cardProps: [] as { card: unknown; canOpenPage?: boolean; embedded?: boolean }[],
  appBlocksPages: false,
}));

vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsMod>()),
  useFeatureFlags: () => ({ appBlocksPages: mocks.appBlocksPages }),
}));

vi.mock('~/components/Apps/AppListingCard', () => ({
  AppListingCard: (props: {
    card: { name: string };
    canOpenPage?: boolean;
    embedded?: boolean;
    coverBadge?: ReactNode;
  }) => {
    mocks.cardProps.push(props);
    // The real card pins `coverBadge` over its cover; the stub renders it first so the credit's
    // wording is still read as one string with the card's name after it.
    return (
      <div data-testid="stub-listing-card">
        <span>{props.coverBadge}</span> <span>{props.card.name}</span>
      </div>
    );
  },
}));

vi.mock('~/utils/trpc', async (importOriginal) => {
  // `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof TrpcModule>()),
    trpc: makeTrpcProxy({
      'appListings.getAppCard': {
        useQuery: (input: unknown) => {
          mocks.cardInputs.push(input);
          return { data: mocks.card };
        },
      },
    }),
  };
});

import { LOADABLE_IMAGE_DATA_URI, renderWithProviders } from '../../../../test/component-setup';
import { PostPublishedWithApp } from '~/components/Post/Detail/PostPublishedWithApp';

const CHIP = '[data-testid="post-published-with-app"]';
const chip = () => document.querySelector<HTMLElement>(CHIP);

/** Whitespace-normalised; nothing else is collapsed, so an extra word cannot hide. */
const sentence = () => (chip()?.innerText ?? '').replace(/\s+/gu, ' ').trim();

async function rendered(app: PostAppChip) {
  renderWithProviders(<PostPublishedWithApp app={app} />);
  await expect.element(page.getByTestId('post-published-with-app')).toBeInTheDocument();
}

async function renderedWithoutChip(app: PostAppChip | null | undefined) {
  renderWithProviders(
    <>
      <div data-testid="render-committed" />
      <PostPublishedWithApp app={app} />
    </>
  );
  await expect.element(page.getByTestId('render-committed')).toBeInTheDocument();
}

const viewable: PostAppChip = {
  slug: 'custom-generators',
  name: 'Custom Generators',
  iconUrl: LOADABLE_IMAGE_DATA_URI,
};

beforeEach(() => {
  mocks.card = undefined;
  mocks.cardInputs = [];
  mocks.cardProps = [];
  mocks.appBlocksPages = false;
});

describe('PostPublishedWithApp', () => {
  test('renders nothing at all when the server resolved no app', async () => {
    await renderedWithoutChip(null);
    expect(chip()).toBeNull();
  });

  test('renders nothing when the field is absent entirely', async () => {
    await renderedWithoutChip(undefined);
    expect(chip()).toBeNull();
  });

  test('a viewable app whose card has not arrived: exactly "Made with <app>", linked, never "by"', async () => {
    await rendered(viewable);
    expect(sentence()).toBe('Made with Custom Generators');
    expect(sentence()).not.toMatch(/\bby\b/iu);
    expect(chip()?.querySelector('a')?.getAttribute('href')).toBe(
      '/apps/store-preview/custom-generators'
    );
  });

  test('encodes the slug in the fallback link', async () => {
    await rendered({ ...viewable, slug: 'needs encoding/../x' });
    // Encoded because the destination is built by concatenation: a `../`, a `//host`, or a `?`/`#`
    // in a slug would otherwise steer the path off `/apps/store-preview/`.
    expect(chip()?.querySelector('a')?.getAttribute('href')).toBe(
      '/apps/store-preview/needs%20encoding%2F..%2Fx'
    );
  });

  test('asks for the card by the chip slug', async () => {
    await rendered(viewable);
    expect(mocks.cardInputs[0]).toEqual({ slug: 'custom-generators' });
  });

  test('a resolved card renders as the embedded store card, the label on its cover, with the page-open flag', async () => {
    mocks.card = { id: 'l1', slug: 'custom-generators', name: 'Custom Generators Card' };
    mocks.appBlocksPages = true;
    await rendered(viewable);
    await expect.element(page.getByTestId('stub-listing-card')).toBeInTheDocument();
    expect(sentence()).toBe('Made with Custom Generators Card');
    expect((mocks.cardProps.at(-1)?.card as ListingCard).slug).toBe('custom-generators');
    expect(mocks.cardProps.at(-1)?.canOpenPage).toBe(true);
    expect(mocks.cardProps.at(-1)?.embedded).toBe(true);
    // No heading above the card any more: the label is the cover badge, inside the card.
    expect(chip()?.querySelector('p')).toBeNull();
    expect(page.getByTestId('post-published-with-app-label').elements()).toHaveLength(1);
    // The card replaces the name link; no second link to the same page.
    expect(chip()?.querySelector('a')).toBeNull();
  });

  test('a resolved card is told it cannot open a page when the flag is off', async () => {
    mocks.card = { id: 'l1', slug: 'custom-generators', name: 'Custom Generators Card' };
    await rendered(viewable);
    await expect.element(page.getByTestId('stub-listing-card')).toBeInTheDocument();
    expect(mocks.cardProps.at(-1)?.canOpenPage).toBe(false);
  });

  test('a not-viewable app: the name UNLINKED, no icon box, and no card fetched', async () => {
    // The live instance: an app whose block is suspended and whose listing is removed.
    // `/apps/store-preview/<slug>` refuses to serve it, so a link here would be a 404 dressed
    // as a working link.
    await rendered({ slug: null, name: 'Ab Img Poster', iconUrl: null });
    expect(sentence()).toBe('Made with Ab Img Poster');
    expect(chip()?.querySelector('a')).toBeNull();
    expect(document.querySelector('a[href*="store-preview"]')).toBeNull();
    expect(chip()?.querySelector('img')).toBeNull();
    expect(mocks.cardInputs).toEqual([]);
  });

  test('renders a decorative icon when there is one', async () => {
    await rendered(viewable);
    const icon = chip()?.querySelector('img');
    expect(icon).not.toBeNull();
    // Decorative: the name beside it already says which app.
    expect(icon?.getAttribute('alt')).toBe('');
  });

  test('renders no placeholder box for an app with no icon — the common live case', async () => {
    await rendered({ ...viewable, iconUrl: null });
    expect(sentence()).toBe('Made with Custom Generators');
    // Mantine's `Avatar` draws a grey placeholder box when `src` is absent.
    expect(chip()?.querySelector('img')).toBeNull();
    expect(chip()?.querySelector('.mantine-Avatar-root')).toBeNull();
  });

  test('names the item and links it where its store card links, then the app', async () => {
    const item = {
      name: 'Fakeful',
      href: '/apps/run/game-frame/fakeful?sl=asl_1',
      external: false,
    };
    await rendered({ ...viewable, item });
    expect(sentence()).toBe('Made with Fakeful on Custom Generators');
    const [itemLink, appLink] = Array.from(chip()?.querySelectorAll('a') ?? []);
    expect(itemLink?.getAttribute('href')).toBe('/apps/run/game-frame/fakeful?sl=asl_1');
    expect(itemLink?.getAttribute('target')).toBeNull();
    expect(appLink?.getAttribute('href')).toMatch(/^\/apps\/store-preview\//);
  });

  test('opens an off-site item in a new tab without handing it the opener', async () => {
    const item = {
      name: 'Fakeful',
      href: 'https://games.civitai.com/play/fakeful',
      external: true,
    };
    await rendered({ ...viewable, item });
    const itemLink = chip()?.querySelector('a');
    expect(itemLink?.getAttribute('href')).toBe('https://games.civitai.com/play/fakeful');
    expect(itemLink?.getAttribute('target')).toBe('_blank');
    expect(itemLink?.getAttribute('rel')).toBe('noopener noreferrer');
  });

  test('names an item with no valid link unlinked', async () => {
    const item = { name: 'Fakeful', href: null, external: false };
    await rendered({ ...viewable, item });
    expect(sentence()).toBe('Made with Fakeful on Custom Generators');
    expect(chip()?.querySelectorAll('a')).toHaveLength(1);
  });
});
