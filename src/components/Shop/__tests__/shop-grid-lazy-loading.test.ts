// @vitest-environment happy-dom
import fs from 'fs';
import path from 'path';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ currentUser: null as unknown }));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => mocks.currentUser }));
vi.mock('~/providers/BrowserSettingsProvider', () => ({
  useBrowsingSettings: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ autoplayGifs: true }),
}));

import { EdgeImage } from '~/components/EdgeMedia/EdgeImage';

const repoRoot = path.resolve(__dirname, '../../../..');
const read = (relative: string) =>
  fs.readFileSync(path.join(repoRoot, ...relative.split('/')), 'utf-8');

function renderImage(props: Record<string, unknown>) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    createRoot(container).render(
      createElement(EdgeImage, { src: 'abc-123', options: { width: 450 }, ...props } as never)
    );
  });
  return container.querySelector('img');
}

/**
 * The whole change rests on `loading` surviving EdgeMedia's prop split and EdgeImage's
 * rest-spread onto the `<img>`. Neither component mentions `loading` by name — it rides in
 * `...imgProps` and then `...props` — so nothing else in the repo would notice if a future
 * refactor started destructuring it out, and the shop grids would silently go eager again.
 */
describe('EdgeImage forwards `loading` to the img element', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('sets loading="lazy" when asked', () => {
    expect(renderImage({ loading: 'lazy' })?.getAttribute('loading')).toBe('lazy');
  });

  // Control: the attribute is absent by default, so the assertion above is reading a value
  // this prop produced rather than one the element carries anyway.
  it('sets no loading attribute when not asked', () => {
    expect(renderImage({})?.getAttribute('loading')).toBeNull();
  });
});

/**
 * ⚠️ Pins a DECISION (868kzk7k7). Every shop grid renders `ShopItem` unvirtualised —
 * `Shop/ShopSection`, `CreatorShop/Storefront/ShopItemGrid`,
 * `HomeBlocks/CosmeticShopSectionHomeBlock` and `Profile/Sections/ShopSection` — and the
 * largest live section is 94 items with 16 animated (measured 2026-09-01). Without these,
 * the whole section's artwork is fetched on first paint.
 *
 * The card has THREE mutually exclusive artwork branches and all three must defer; covering
 * two of them leaves a whole class of shop item eager, which is invisible in any screenshot
 * because the difference is only in what the network did.
 *
 * Deliberately opt-in rather than a default on EdgeImage: that component backs every image
 * on the site, including feeds that already virtualise, and flipping its default is a much
 * broader change than this ticket.
 */
describe('the shop card defers all three of its artwork branches', () => {
  const shopItem = () => read('src/components/Shop/ShopItem.tsx');

  it.each([
    ['CosmeticSample', /<CosmeticSample[^>]*\slazy\b/],
    ['EdgeMedia cover', /<EdgeMedia[^>]*\sloading="lazy"/],
    ['PackCoverTiles', /<PackCoverTiles[^>]*\slazy\b/],
  ])('defers the %s branch', (_label, pattern) => {
    expect(shopItem()).toMatch(pattern);
  });

  // Control for the three matchers above: each names a distinct component, so a pattern
  // loose enough to match any lazy-ish attribute anywhere in the file would also match a
  // component the card does not render.
  it('does not match a component the card never renders', () => {
    expect(shopItem()).not.toMatch(/<CosmeticThumb[^>]*\slazy\b/);
  });
});

/**
 * The two shared components the card leans on must actually accept the prop. A `lazy` that
 * TypeScript allows but the component ignores would pass the guards above while changing
 * nothing — the failure this whole file exists to prevent.
 */
describe('the shared card components accept and apply lazy', () => {
  it.each([
    ['src/components/Shop/CosmeticSample.tsx'],
    ['src/components/CreatorShop/Pack/PackCoverTiles.tsx'],
  ])('%s turns `lazy` into a loading attribute', (relative) => {
    const source = read(relative);
    expect(source).toMatch(/lazy\?: boolean/);
    expect(source).toMatch(/loading=\{/);
  });
});
