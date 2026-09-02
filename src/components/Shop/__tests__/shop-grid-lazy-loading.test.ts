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
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { CosmeticSample } from '~/components/Shop/CosmeticSample';
import { PackCoverTiles } from '~/components/CreatorShop/Pack/PackCoverTiles';

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

function renderMedia(props: Record<string, unknown>) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    createRoot(container).render(
      createElement(EdgeMedia, { src: 'abc-123', width: 450, ...props } as never)
    );
  });
  return container.querySelector('img');
}

/**
 * The whole change rests on `loading` surviving EdgeMedia's prop split and EdgeImage's
 * rest-spread onto the `<img>`. Neither component mentions `loading` by name — it rides in
 * `...imgProps` and then `...props` — so nothing else in the repo would notice if a future
 * refactor started destructuring it out, and the shop grids would silently go eager again.
 *
 * Both seams are rendered, not just the inner one: adding `loading` to EdgeMedia's
 * destructured parameter list would leave an EdgeImage-only test green while every shop
 * card went eager again, which is the precise failure this file exists to catch.
 */
describe('EdgeImage forwards `loading` to the img element', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('sets loading="lazy" when asked', () => {
    expect(renderImage({ loading: 'lazy' })?.getAttribute('loading')).toBe('lazy');
  });

  // Control: the attribute is absent by default, so the assertion above is reading a value
  // this prop produced rather than one the element carries anyway. Asserts the element
  // exists first — `null?.getAttribute()` is undefined, not null, but an absent <img> would
  // otherwise be an easy way for this to pass while nothing rendered.
  it('sets no loading attribute when not asked', () => {
    const img = renderImage({});
    expect(img).not.toBeNull();
    expect(img?.getAttribute('loading')).toBeNull();
  });

  // The outer seam. EdgeMedia is what every call site in this change actually uses.
  it('survives EdgeMedia prop split', () => {
    expect(renderMedia({ loading: 'lazy' })?.getAttribute('loading')).toBe('lazy');
  });

  it('and EdgeMedia adds no loading attribute of its own', () => {
    const img = renderMedia({});
    expect(img).not.toBeNull();
    expect(img?.getAttribute('loading')).toBeNull();
  });
});

function renderSample(cosmetic: Record<string, unknown>, lazy?: boolean) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    createRoot(container).render(createElement(CosmeticSample, { cosmetic, lazy } as never));
  });
  return container.querySelector('img');
}

function renderTiles(lazy?: boolean) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    createRoot(container).render(
      createElement(PackCoverTiles, { tiles: ['abc-123'], lazy } as never)
    );
  });
  return container.querySelector('img');
}

const BADGE = { id: 1, name: 'b', type: 'Badge', data: { url: 'abc-123' } };
// No `data.type`, so getInferredMediaType resolves 'image' and an <img> renders. The
// video-typed case is the one deliberately NOT covered - see the scope note below.
const BACKGROUND = { id: 3, name: 'bg', type: 'ProfileBackground', data: { url: 'abc-123' } };
const STICKER = { id: 2, name: 's', type: 'Sticker', data: { url: 'abc-123', animated: true } };

/**
 * Renders rather than greps, because the grep could not tell "applied" from "declared and
 * ignored" — `toMatch(/lazy?: boolean/)` and `toMatch(/loading={/)` are two existence checks
 * over one file, satisfied when `loading` reaches only ONE of CosmeticSample's branches.
 * Each branch is asserted separately for the same reason.
 */
describe('CosmeticSample turns `lazy` into a loading attribute, per branch', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it.each([
    ['badge', BADGE],
    ['sticker', STICKER],
    ['image-typed profile background', BACKGROUND],
  ])('defers the %s branch', (_label, cosmetic) => {
    expect(renderSample(cosmetic, true)?.getAttribute('loading')).toBe('lazy');
  });

  // Control: without the prop the same branches render an img carrying no loading attribute,
  // so the assertions above read a value `lazy` produced rather than a default.
  it.each([
    ['badge', BADGE],
    ['sticker', STICKER],
    ['image-typed profile background', BACKGROUND],
  ])('leaves the %s branch eager when not asked', (_label, cosmetic) => {
    const img = renderSample(cosmetic, undefined);
    expect(img).not.toBeNull();
    expect(img?.getAttribute('loading')).toBeNull();
  });
});

/**
 * PackCoverTiles was the branch a source grep alone still covered: deleting its
 * `loading={lazy ? 'lazy' : undefined}` left every other assertion in this file green,
 * because nothing rendered the component. Exactly the "declared and ignored" gap the
 * CosmeticSample block above exists to close.
 */
describe('PackCoverTiles turns `lazy` into a loading attribute', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('defers its tiles when asked', () => {
    expect(renderTiles(true)?.getAttribute('loading')).toBe('lazy');
  });

  it('leaves them eager when not asked', () => {
    const img = renderTiles(undefined);
    expect(img).not.toBeNull();
    expect(img?.getAttribute('loading')).toBeNull();
  });
});

/**
 * ⚠️ Pins a DECISION (868kzk7k7). Nine components render `ShopItem`, all unvirtualised, so
 * without these the card's artwork is fetched before anyone scrolls to it. Measurements are
 * in PR #4565 rather than here — they are catalogue- and CDN-side, they decay silently, and
 * three of them were wrong in an earlier revision of this very comment.
 *
 * The card has THREE mutually exclusive artwork branches and all three must defer; covering
 * two leaves a whole class of shop item eager, which is invisible in any screenshot because
 * the difference is only in what the network did. Each is rendered below, not grepped.
 *
 * Two limits, so this is not read as more than it is: a ContentDecoration paints via a CSS
 * `background-image`, and a video-typed ProfileBackground routes to `EdgeVideo`, which never
 * receives `imgProps`. No `loading` attribute reaches either.
 *
 * Deliberately opt-in rather than a default on EdgeImage: that component backs every image on
 * the site, including feeds that already virtualise, and there is no `loading="eager"` opt-out
 * anywhere in the tree to escape a flipped default with.
 */
describe('the shop card defers all three of its artwork branches', () => {
  const shopItem = () => read('src/components/Shop/ShopItem.tsx');

  // `[^>]*\slazy` is satisfied by ` lazy={false}` — the negation contains the substring —
  // so the negative lookahead rejects any `lazy=` form and requires the boolean shorthand.
  // String.raw, not a plain template literal: `\s` in one collapses to a literal `s`, which
  // silently produced `slazys*=` — a pattern that matches nothing and fails open.
  //
  // Existential, not universal: asserts SOME mount is lazy, not every one. Inert today (the
  // card has exactly one mount per component) but it would not notice a second, eager mount
  // added beside the first. `[^>]*` also stops at a `>` inside a prop expression, so a prop
  // like `cosmetic={a > b}` would fail this on a correct mount — over-strict, fails safe.
  // The rendered tests above pin the behaviour; these only pin the call site.
  const bare = (tag: string) => new RegExp(String.raw`<${tag}(?![^>]*\slazy\s*=)[^>]*\slazy[\s/>]`);

  it.each([
    ['CosmeticSample', () => bare('CosmeticSample')],
    ['PackCoverTiles', () => bare('PackCoverTiles')],
  ])('defers the %s branch', (_label, pattern) => {
    expect(shopItem()).toMatch(pattern());
  });

  it('defers the cover branch', () => {
    expect(shopItem()).toMatch(/<EdgeMedia[^>]*\sloading="lazy"/);
  });

  /**
   * The control, against fixtures rather than the repo. The previous version asserted the
   * file did not match `<CosmeticThumb ... lazy>` — a component `ShopItem` never renders at
   * all, so it passed against an empty string and controlled nothing.
   */
  it.each([
    ['<CosmeticSample cosmetic={c} size="lg" lazy={false} />'],
    ['<CosmeticSample cosmetic={c} size="lg" lazy={enabled} />'],
    ['<CosmeticSample cosmetic={c} size="lg" />'],
  ])('rejects %j', (source) => {
    expect(source).not.toMatch(bare('CosmeticSample'));
  });

  it('accepts the boolean shorthand', () => {
    expect('<CosmeticSample cosmetic={c} size="lg" lazy />').toMatch(bare('CosmeticSample'));
  });
});
