import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
/**
 * 🔴 THE APP'S REAL STYLESHEET CASCADE, imported ON PURPOSE — without it every
 * geometry assertion in this file is a lie.
 *
 * These are exactly the two `_app.tsx` loads, in the same order: the Tailwind
 * globals and the LAYERED Mantine sheet. Both halves are load-bearing and I got
 * each of them wrong once:
 *   - `@mantine/core/styles.css` (the non-layered variant) styles Mantine but
 *     leaves Tailwind out entirely, so `hidden` / `@container` / every utility
 *     class is inert. Measured: `container-type: normal`, the responsive Edit
 *     swap silently did nothing, and BOTH Edit forms rendered at once.
 *   - Tailwind alone would leave Mantine unstyled and put us back in the
 *     initial-value trap below.
 * `styles.layer.css` is what the app ships so Tailwind utilities can win over
 * Mantine's defaults; using the plain sheet here would test a cascade the app
 * does not have.
 *
 * The shared component harness deliberately does NOT load
 * `@mantine/core/styles.css`. `Group` styles itself entirely from that
 * stylesheet, so unstyled it computes `display: block` and `flex-wrap` returns
 * the CSS INITIAL value `nowrap` — which is true of literally any element.
 * `expect(getComputedStyle(row).flexWrap).toBe('nowrap')` therefore passed
 * against a component flipped to `wrap="wrap"`; the companion "Edit and the CTA
 * share a line" check was the same accident, since with no flex the buttons are
 * `display: inline` and share a text line no matter what.
 *
 * Mutation-proven: with both `<Group wrap="nowrap">` in `AppListingCard.tsx`
 * flipped to `"wrap"`, this file reported 27 passed / 1 failed — and the ONE
 * failure was the PRE-EXISTING `--group-wrap` test, not either of these.
 *
 * Any `getComputedStyle` assertion whose expected value happens to equal the CSS
 * initial value (`nowrap`, `visible`, `static`, `auto`, `none`, `0px`) is
 * suspect for exactly this reason. {@link assertLayoutIsReal} is the guard that
 * makes the import's failure loud instead of silent.
 */
import '~/styles/globals.css';
import '@mantine/core/styles.layer.css';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { LOADABLE_IMAGE_DATA_URI, renderWithProviders } from '../../../test/component-setup';
import type { ListingCard } from '~/server/schema/blocks/app-listing-read.schema';

/**
 * P2b AppListingCard component tests (REPORT-ONLY — the browser project is
 * non-blocking; the blocking gate is appListingCardView.test.ts). These pin the
 * rendered kind badge, recommend label, and kind-aware CTA affordance for a few
 * representative cards, PLUS the owner "Edit" deep-link gating (Item 2) and the
 * long-username tooltip fallback (Item 1).
 */

const mocks = vi.hoisted(() => ({
  currentUser: null as null | { id: number; username: string },
}));

vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => mocks.currentUser,
}));

// Import AFTER the mock is declared (vi.mock is hoisted, imports are not).
const { AppListingCard } = await import('./AppListingCard');

beforeEach(() => {
  mocks.currentUser = null;
});

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
    kindData: {
      kind: 'onsite',
      appBlockId: 'blk-1',
      hasPage: true,
      liveUrl: 'https://my-app.civit.ai',
    },
    ...over,
  };
}

/**
 * Render a card inside a fixed-width box.
 *
 * `width` is the OUTER box. `Card padding="md"` eats 2x16, so the content box —
 * the number the layout measurements below are about — is `width - 32`.
 *
 * 🔴 It was `width - 34` until S4 dropped `withBorder`, so every content box below
 * RECLAIMED 2px and the exact pins moved 280 -> 282 and 246 -> 248. That is the
 * border removal being real and measurable, not a tolerance drift; if these
 * numbers ever move back, the border came back. Proven by isolation: restoring
 * ONLY `withBorder` reproduces 280/246 exactly, and reverting ONLY the title
 * (`Text` -> `Title`) leaves both pins green.
 *
 * ⚠️ In THIS environment the border is exactly 1px a side (Mantine's
 * `calc(0.0625rem * var(--mantine-scale))` with `scale` unset and a 16px root),
 * so `width - 34` was exact arithmetic, not fractional. The 0.877px figure comes
 * from PROD, where the scale differs — do not use it to reason about these pins.
 *
 * The two widths used below, both measured through the real
 * `AppsPageLayout` + `Grid` rather than assumed:
 *   - `280` -> a 248px content box = the TRUE 1200px-viewport geometry
 *     (container 1200 -> column 296 -> card 280 -> row 248);
 *   - `314` -> a 282px content box, i.e. roughly a 1345 viewport. "280" in the
 *     original bug report is the CARD width at 1200, not its content box.
 */
function Sized({ width, card }: { width: number; card: ListingCard }) {
  return (
    <div style={{ width }}>
      <AppListingCard card={card} canOpenPage />
    </div>
  );
}

/**
 * 🔴 GUARD ON THE GUARD. Proves the stylesheet cascade above actually applied
 * before any geometry is trusted. If either import ever silently stops working
 * (renamed export path, harness change), every measurement below reverts to CSS
 * initial values and starts passing for the wrong reason — this fails loudly
 * instead, and names the cause.
 */
function assertLayoutIsReal(row: HTMLElement) {
  expect(
    getComputedStyle(row).display,
    'Mantine stylesheet did not apply — every geometry assertion below is vacuous'
  ).toBe('flex');
}

/** The action row's three parts, located from the primary CTA. */
function actionRow(ctaName: string) {
  const cta = page.getByRole('link', { name: ctaName, exact: true }).element() as HTMLElement;
  const actions = cta.parentElement as HTMLElement;
  const row = actions.parentElement as HTMLElement;
  const rollup = row.firstElementChild as HTMLElement;
  return { cta, actions, row, rollup };
}

/**
 * Two elements share one flex line.
 *
 * Compares vertical CENTRES, not `top`. `Group` defaults to `align="center"`, so
 * a short item (the ~18px recommend rollup) and a tall one (the ~36px action
 * buttons) legitimately have `top` values ~9px apart while sitting on the SAME
 * line — a `top`-based check reports them as wrapped and fails against correct
 * code. Tolerance is half the shorter element's height, which is comfortably
 * below the ~36px a real wrap would move them.
 */
function sameLine(a: Element, b: Element) {
  const ra = a.getBoundingClientRect();
  const rb = b.getBoundingClientRect();
  const centreDelta = Math.abs(ra.top + ra.height / 2 - (rb.top + rb.height / 2));
  return centreDelta < Math.min(ra.height, rb.height) / 2 + 1;
}

describe('AppListingCard', () => {
  test('on-site page app + canOpenPage → Open link to the run route', async () => {
    renderWithProviders(<AppListingCard card={base({})} canOpenPage />);
    await expect.element(page.getByText('My App')).toBeInTheDocument();
    await expect.element(page.getByText('by alice')).toBeInTheDocument();
    const open = page.getByRole('link', { name: 'Open' });
    await expect.element(open).toBeInTheDocument();
    await expect.element(open).toHaveAttribute('href', '/apps/run/my-app');
  });

  test('kind + category badges are NOT rendered on the card (round-2 truncation fix)', async () => {
    // "App" was formerly the on-site kind badge's exact-match text; "utility" is
    // base()'s category. Neither should render now that the badge column is gone
    // — the kind signal instead lives in the CTA (Open/View details vs Visit ↗)
    // and, for off-site, the detail-page disclosure Alert.
    renderWithProviders(<AppListingCard card={base({})} canOpenPage />);
    await expect.element(page.getByText('My App')).toBeInTheDocument();
    await expect.element(page.getByText('App', { exact: true })).not.toBeInTheDocument();
    await expect.element(page.getByText('Utility', { exact: true })).not.toBeInTheDocument();
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
    // The kind signal ("Off-site") is no longer a badge — it's conveyed by the
    // CTA below (an external "Visit" anchor vs. an internal Open/View details
    // link) plus the off-site disclosure Alert on the detail page.
    await expect.element(page.getByText('Off-site', { exact: true })).not.toBeInTheDocument();
    const visit = page.getByRole('link', { name: 'Visit' });
    await expect.element(visit).toHaveAttribute('href', 'https://ext.app');
    await expect.element(visit).toHaveAttribute('target', '_blank');
    await expect.element(visit).toHaveAttribute('rel', 'noopener noreferrer');
  });

  test('off-site connect → View details → unified detail (P2c)', async () => {
    // P2c: cards route to the unified detail; the Connect action itself lives on
    // the detail page (the connect flow needs a P2a authorize-URL DTO addition),
    // so the card's CTA is "View details", not an inert Connect button. The
    // former "Connect app" kind badge is gone — no longer asserted here.
    renderWithProviders(
      <AppListingCard
        card={base({
          kind: 'offsite',
          name: 'Connect App',
          kindData: { kind: 'offsite', subKind: 'connect', externalUrl: null },
        })}
      />
    );
    const details = page.getByRole('link', { name: 'View details' });
    await expect.element(details).toHaveAttribute('href', '/apps/store-preview/my-app');
  });

  test('on-site page app WITHOUT canOpenPage → View details → unified detail (P2c)', async () => {
    renderWithProviders(<AppListingCard card={base({})} canOpenPage={false} />);
    const details = page.getByRole('link', { name: 'View details' });
    await expect.element(details).toHaveAttribute('href', '/apps/store-preview/my-app');
  });

  // ── Card chrome, typography + CTA glyph (S4 / S5 / S6b) ────────────────────
  //
  // Markers are Mantine's own DOM output, verified against what it ACTUALLY emits
  // rather than assumed:
  //   withBorder -> a `data-with-border` ATTRIBUTE
  //   shadow     -> a `--paper-shadow` custom property
  //   size       -> a `--text-fz` custom property
  //   fw / c     -> PLAIN `font-weight:` / `color:` declarations
  // 🔴 `fw` and `c` are the trap: they do NOT become `--text-fw` / `--text-color`.
  // Asserting those fails against a perfectly correct component, which is exactly
  // how this suite burned a debugging cycle.
  //
  // 🔴 Not asserting resolved brand `rgb()` values: Mantine's stylesheets ARE
  // loaded here (`assertLayoutIsReal` depends on them), but ThemeProvider's
  // CSS-variable overrides are not — so `--mantine-color-white` resolves to
  // rgb(255,255,255) here and #fefefe in the app. Geometry (px) is trustworthy;
  // brand colours are not. The pixel/contrast values live in the PR's table.

  const cardRoot = () => document.querySelector('[class*="Card-root"]') as HTMLElement | null;

  /** The `tabler-icon-*` modifier on a CTA's glyph, e.g. `player-play`. */
  function ctaGlyph(link: Element): string {
    const svg = link.querySelector('svg');
    if (!svg) throw new Error('CTA rendered no glyph at all');
    const mod = Array.from(svg.classList).find(
      (c) => c.startsWith('tabler-icon-') && c !== 'tabler-icon'
    );
    if (!mod) throw new Error(`glyph carried no tabler-icon-* class: ${svg.getAttribute('class')}`);
    return mod.replace('tabler-icon-', '');
  }

  /**
   * Poll for the CTA BUTTON by href — the render is async, so a bare query races it.
   *
   * 🔴 Scoped to `[class*="Button-root"]`: more than one anchor on the card can
   * carry the same href (the title and the cover link to the detail, and the card
   * body can link to the run route), and a bare `a[href=...]` grabs whichever comes
   * first in document order — a wrapper with no glyph in it. That reads as
   * "the CTA rendered no glyph" when the CTA is fine.
   */
  async function waitForCta(href: string): Promise<Element> {
    const el = await vi.waitUntil(
      () => document.body.querySelector(`a[href="${href}"][class*="Button-root"]`),
      { timeout: 10000, interval: 25 }
    );
    return el as Element;
  }

  test('🔴 S4: the card has NO border and NO shadow, and takes its radius from Tailwind', async () => {
    renderWithProviders(<AppListingCard card={base({})} canOpenPage />);
    await expect.element(page.getByText('My App')).toBeInTheDocument();
    const root = cardRoot();
    expect(root, 'the Mantine Card root').toBeTruthy();
    // `withBorder` is gone → Mantine emits no `data-with-border`.
    expect(root!.hasAttribute('data-with-border')).toBe(false);
    // `shadow="sm"` is gone → no `--paper-shadow` is declared at all.
    expect(root!.getAttribute('style') ?? '').not.toContain('--paper-shadow');
    // 🔴 Assert the COMPUTED radius, not the className the JSX just wrote back to
    // us. `radius={0}` makes Mantine emit `--paper-radius: 0rem`, and Tailwind's
    // `.rounded-md` only wins because Mantine's sheet is inside `@layer mantine`
    // while Tailwind utilities are deliberately unlayered (`globals.css`). If that
    // layer ordering ever regresses, the card renders SQUARE — and a className
    // assertion would still be green.
    // 🔴 No `className).toContain('rounded-md')` echo here on purpose: it asserts
    // the string the JSX just wrote, it cannot detect the square-card failure
    // above, and — being ordered first — it would SHADOW the computed assertion
    // that can. An earlier check that always wins makes the later one untestable.
    expect(getComputedStyle(root!).borderRadius).toBe('6px');
    expect(getComputedStyle(root!).borderTopWidth).toBe('0px');
    expect(getComputedStyle(root!).boxShadow).toBe('none');
  });

  test('🔴 S5: the title is xl/700/white — and is no longer a heading', async () => {
    renderWithProviders(<AppListingCard card={base({})} canOpenPage />);
    // 🔴 Render barrier. `renderWithProviders` is async and `.element()` does NOT
    // retry, so reading it directly throws on the pre-commit DOM — and the throw
    // poisons every test after this one. `expect.element` polls; `.element()` does
    // not. (This is the same trap the S4 test above avoids by awaiting first.)
    await expect.element(page.getByText('My App')).toBeInTheDocument();
    const title = page.getByText('My App').element() as HTMLElement;
    const style = title.getAttribute('style') ?? '';
    // 🔴 Marker shapes verified against Mantine's ACTUAL output, not assumed:
    // `size` becomes a `--text-fz` custom property, but `fw`/`c` become PLAIN
    // `font-weight` / `color` declarations. Asserting `--text-fw` / `--text-color`
    // fails against a correctly-rendered component.
    expect(style).toContain('--text-fz: var(--mantine-font-size-xl)');
    expect(style).toContain('font-weight: 700');
    expect(style).toContain('color: var(--mantine-color-white)');
    // 🔴 `lh={1.2}` is load-bearing and easy to delete by accident: without it the
    // title inherits `--mantine-line-height-xl` (1.65), which at 20px is 33px vs
    // 24px — a ~14px card-height swing across a 2-line clamp, and card height is
    // exactly what the deferred S7 work is about.
    expect(style).toContain('line-height: 1.2');
    expect(getComputedStyle(title).lineHeight).toBe('24px');
    // Declared side effect: the card title is a <Text>, not an <h4>. This is
    // parity with `/models` (whose card title is a <p>), not an a11y regression —
    // asserted so the change is visible rather than discovered later.
    expect(title.tagName).not.toBe('H4');
    expect(cardRoot()!.querySelector('h1,h2,h3,h4,h5,h6')).toBeNull();
  });

  test('🔴 S5: the author line is sm/500 and STAYS dimmed (accepted contrast residual)', async () => {
    renderWithProviders(<AppListingCard card={base({})} canOpenPage />);
    await expect.element(page.getByText('by alice')).toBeInTheDocument();
    const author = page.getByText('by alice').element() as HTMLElement;
    const style = author.getAttribute('style') ?? '';
    expect(style).toContain('--text-fz: var(--mantine-font-size-sm)');
    expect(style).toContain('font-weight: 500');
    // 🔴 The accepted trade (decision 3): size + weight only. Taking the author to
    // white too would flatten the title-over-author hierarchy on a dark-6 body.
    // If this ever starts asserting white, decision 3 was changed without notice.
    expect(style).not.toContain('color: var(--mantine-color-white)');
  });

  // 🔴 ONE render per test. An earlier version rendered all three variants in a
  // single body and called `.unmount()` between them; that fights the scaffold's
  // global `afterEach(cleanup)` over the shared container and left EVERY
  // subsequent test in the file timing out at 15s. Separate tests also let each
  // glyph mutation be observed independently instead of the first short-circuiting
  // the rest.

  test('🔴 S6b: the in-site Open CTA carries the launch glyph', async () => {
    renderWithProviders(<AppListingCard card={base({})} canOpenPage />);
    expect(ctaGlyph(await waitForCta('/apps/run/my-app'))).toBe('player-play');
  });

  test('🔴 S6b: the off-site Visit CTA carries the external glyph', async () => {
    renderWithProviders(
      <AppListingCard
        card={base({
          kind: 'offsite',
          name: 'External App',
          kindData: { kind: 'offsite', subKind: 'external-link', externalUrl: 'https://ext.app' },
        })}
      />
    );
    expect(ctaGlyph(await waitForCta('https://ext.app'))).toBe('external-link');
  });

  test('🔴 S6b: the View-details CTA carries the view glyph, distinct from the other two', async () => {
    renderWithProviders(<AppListingCard card={base({})} canOpenPage={false} />);
    // `eye`, NOT `info-circle`. #3539 shipped IconEye here and the shared glyph
    // module was reconciled to match; asserting the value (not just "different")
    // is what stops a future wiring change from silently repainting it.
    expect(ctaGlyph(await waitForCta('/apps/store-preview/my-app'))).toBe('eye');
    // The in-site branch used to render NO icon at all — that silence was the half
    // of #3391's premise the card was failing. All three glyphs are distinct:
    // player-play / external-link / eye, pinned across the three tests above.
  });

  test('owner sees the Edit deep-link → on-site manifest editor', async () => {
    mocks.currentUser = { id: 5, username: 'alice' }; // matches base().creator.id
    renderWithProviders(<AppListingCard card={base({})} canOpenPage />);
    const edit = page.getByTestId('apps-listing-owner-edit');
    await expect.element(edit).toBeInTheDocument();
    await expect.element(edit).toHaveAttribute('href', '/apps/blk-1/edit');
  });

  test('owner of an off-site listing → Edit routes to the submit editor by listing id', async () => {
    mocks.currentUser = { id: 5, username: 'alice' };
    renderWithProviders(
      <AppListingCard
        card={base({
          kind: 'offsite',
          kindData: { kind: 'offsite', subKind: 'external-link', externalUrl: 'https://ext.app' },
        })}
      />
    );
    const edit = page.getByTestId('apps-listing-owner-edit');
    await expect.element(edit).toHaveAttribute('href', '/apps/submit?edit=l1');
  });

  test('non-owner does NOT see the Edit deep-link', async () => {
    mocks.currentUser = { id: 999, username: 'bob' };
    renderWithProviders(<AppListingCard card={base({})} canOpenPage />);
    await expect.element(page.getByTestId('apps-listing-owner-edit')).not.toBeInTheDocument();
  });

  test('signed-out viewer does NOT see the Edit deep-link', async () => {
    mocks.currentUser = null;
    renderWithProviders(<AppListingCard card={base({})} canOpenPage />);
    await expect.element(page.getByTestId('apps-listing-owner-edit')).not.toBeInTheDocument();
  });

  test('OWNER sees an "Incomplete" indicator when the card is below the floor (missing icon/cover)', async () => {
    mocks.currentUser = { id: 5, username: 'alice' }; // owner
    // base() has iconUrl: null + coverUrl: null → below floor.
    renderWithProviders(<AppListingCard card={base({})} canOpenPage />);
    await expect.element(page.getByTestId('apps-listing-owner-incomplete')).toBeInTheDocument();
  });

  test('OWNER does NOT see the "Incomplete" indicator when icon+cover are present', async () => {
    mocks.currentUser = { id: 5, username: 'alice' };
    renderWithProviders(
      <AppListingCard
        card={base({ iconUrl: LOADABLE_IMAGE_DATA_URI, coverUrl: LOADABLE_IMAGE_DATA_URI })}
        canOpenPage
      />
    );
    await expect.element(page.getByText('My App')).toBeInTheDocument();
    expect(page.getByTestId('apps-listing-owner-incomplete').elements()).toHaveLength(0);
  });

  test('NON-owner (public shopper) never sees the "Incomplete" indicator even below the floor', async () => {
    mocks.currentUser = { id: 999, username: 'bob' }; // not the creator
    renderWithProviders(<AppListingCard card={base({})} canOpenPage />);
    await expect.element(page.getByText('My App')).toBeInTheDocument();
    expect(page.getByTestId('apps-listing-owner-incomplete').elements()).toHaveLength(0);
  });

  test('signed-out viewer never sees the "Incomplete" indicator', async () => {
    mocks.currentUser = null;
    renderWithProviders(<AppListingCard card={base({})} canOpenPage />);
    await expect.element(page.getByText('My App')).toBeInTheDocument();
    expect(page.getByTestId('apps-listing-owner-incomplete').elements()).toHaveLength(0);
  });

  // ── Larger covers (feedback #1) ──────────────────────────────────────────────
  // The cover moved from a fixed `h={140}` letterbox to a RESPONSIVE 16:9 box
  // (Mantine AspectRatio). Two properties matter and are pinned below:
  //   (a) the box is 16:9 and the art lives INSIDE it (so widening the column
  //       widens the art), and
  //   (b) the `onError` → category-glyph placeholder occupies the SAME box, so a
  //       dangling cover URL swaps art with zero layout shift (CLS).
  // NOTE: the browser project does not load Mantine's stylesheet, so these assert
  // the INLINE ratio contract the component writes itself (`aspect-ratio` on the
  // box, which is what reserves the height, plus the absolute fill on whichever
  // art is inside it) rather than measured pixels — measured geometry would be
  // meaningless without the stylesheet.

  test('cover image renders INSIDE the 16:9 aspect box', async () => {
    renderWithProviders(
      <AppListingCard card={base({ coverUrl: LOADABLE_IMAGE_DATA_URI })} canOpenPage />
    );
    await expect.element(page.getByTestId('apps-listing-cover')).toBeInTheDocument();
    const box = page.getByTestId('apps-listing-cover').element() as HTMLElement;
    // 16:9 — this is what derives the box height from the fluid column width, so
    // the height is reserved before the image bytes arrive (the CLS guard).
    expect(box.style.aspectRatio.replace(/\s/g, '')).toBe('16/9');
    expect(box.style.width).toBe('100%');
    // The art is a CHILD of the ratio box, not a sibling — if it escaped the box
    // it would not be bounded by the reserved geometry.
    const img = box.querySelector('img');
    expect(img).not.toBeNull();
    expect(img?.getAttribute('src')).toBe(LOADABLE_IMAGE_DATA_URI);
    expect(img?.getAttribute('alt')).toBe('My App cover image');
    // Absolutely filling the box — NOT a percentage height, which would have to
    // resolve against a ratio-derived block size and could silently crop the art
    // under `overflow: hidden` if it ever resolved to `auto`.
    expect((img as HTMLElement).style.position).toBe('absolute');
    expect((img as HTMLElement).style.inset).toBe('0px');
    // No fixed pixel height anywhere on the box — the whole point of the change
    // (it was `h={140}`); the height now comes from the ratio.
    expect(box.style.height).toBe('');
  });

  test('no cover → the category-glyph placeholder fills the SAME 16:9 box and stays decorative', async () => {
    // base() has coverUrl: null.
    renderWithProviders(<AppListingCard card={base({})} canOpenPage />);
    await expect.element(page.getByTestId('apps-listing-cover')).toBeInTheDocument();
    const box = page.getByTestId('apps-listing-cover').element() as HTMLElement;
    expect(box.style.aspectRatio.replace(/\s/g, '')).toBe('16/9');
    const placeholder = page.getByTestId('apps-listing-cover-placeholder').element();
    // Same box: the placeholder is the ratio box's own child, so it inherits the
    // identical reserved geometry the <img> would have had.
    expect(placeholder.parentElement).toBe(box);
    // Decorative only — it carries no information the title/CTA don't.
    expect(placeholder.getAttribute('aria-hidden')).toBe('true');
    // Same absolute-fill encoding as the <img>, so the two are interchangeable
    // without any geometry change.
    expect((placeholder as HTMLElement).style.position).toBe('absolute');
    expect((placeholder as HTMLElement).style.inset).toBe('0px');
    expect(box.querySelector('img')).toBeNull();
  });

  test('a BROKEN cover URL falls back to the placeholder in the SAME box (no reflow, still aria-hidden)', async () => {
    // An unfetchable URL — the browser fires the <img>'s real `error` event, which
    // is the component's own onError → placeholder path. This is the ONE shape the
    // shared LOADABLE_IMAGE_DATA_URI cannot express: the whole point is that the
    // fetch must FAIL. Nothing here races the swap the way an "<img> exists"
    // assertion would: the one assertion that runs BEFORE the `vi.waitFor` is on
    // `apps-listing-cover`, the ratio box, which survives the error swap; the
    // placeholder assertion — the only one that depends on the post-error state —
    // is inside the `vi.waitFor`.
    renderWithProviders(
      <AppListingCard
        // eslint-disable-next-line local-rules/no-unloadable-image-fixture -- testing the onError → placeholder path; this URL MUST fail to load
        card={base({ coverUrl: 'https://edge.invalid/does-not-exist.png' })}
        canOpenPage
      />
    );
    await expect.element(page.getByTestId('apps-listing-cover')).toBeInTheDocument();

    await vi.waitFor(() => {
      expect(page.getByTestId('apps-listing-cover-placeholder').query()).not.toBeNull();
    });
    const after = page.getByTestId('apps-listing-cover').element() as HTMLElement;
    const placeholder = page.getByTestId('apps-listing-cover-placeholder').element();
    // The SAME ratio box survives the swap (identical reserved geometry) …
    expect(after.style.aspectRatio.replace(/\s/g, '')).toBe('16/9');
    expect(placeholder.parentElement).toBe(after);
    // … the broken <img> is gone …
    expect(after.querySelector('img')).toBeNull();
    // … and the fallback is still decorative.
    expect(placeholder.getAttribute('aria-hidden')).toBe('true');
  });

  // ── Larger CTAs (feedback #2) ────────────────────────────────────────────────
  // Both the kind-aware primary CTA and the owner-only secondary "Edit" moved one
  // step up Mantine's size scale (xs → sm). Asserted via the `--button-height`
  // custom property Mantine's Button varsResolver writes inline from `size`,
  // which is the size prop's observable effect (the stylesheet isn't loaded here).

  test('the kind-aware primary CTA renders at Mantine size "sm" (bumped from xs)', async () => {
    renderWithProviders(<AppListingCard card={base({})} canOpenPage />);
    await expect.element(page.getByRole('link', { name: 'Open' })).toBeInTheDocument();
    const open = page.getByRole('link', { name: 'Open' }).element() as HTMLElement;
    expect(open.style.getPropertyValue('--button-height')).toBe('var(--button-height-sm)');
  });

  test('the EXTERNAL Visit CTA also renders at size "sm" and keeps its new-tab anchor semantics', async () => {
    renderWithProviders(
      <AppListingCard
        card={base({
          kind: 'offsite',
          kindData: { kind: 'offsite', subKind: 'external-link', externalUrl: 'https://ext.app' },
        })}
      />
    );
    await expect.element(page.getByRole('link', { name: 'Visit' })).toBeInTheDocument();
    const visit = page.getByRole('link', { name: 'Visit' }).element() as HTMLElement;
    expect(visit.style.getPropertyValue('--button-height')).toBe('var(--button-height-sm)');
    // Enlarging must not flatten the kind-aware logic: still a real anchor.
    expect(visit.tagName).toBe('A');
    expect(visit.getAttribute('target')).toBe('_blank');
    expect(visit.getAttribute('rel')).toBe('noopener noreferrer');
  });

  test('the action row does NOT wrap — actions stay right-aligned and never shrink', async () => {
    // 🔴 Regression guard for the obvious-but-wrong fix to the taller `sm` buttons.
    // Letting this row wrap would (a) left-align the actions, because a wrapped
    // line with one item sits at flex-start under `justify="space-between"`, and
    // (b) make an OWNER card (Edit + CTA) wrap at a wider column than a non-owner
    // card, growing the height of the whole `h-full` grid row for everyone.
    mocks.currentUser = { id: 5, username: 'alice' }; // owner → widest action set
    renderWithProviders(<AppListingCard card={base({})} canOpenPage />);
    await expect.element(page.getByTestId('apps-listing-owner-edit')).toBeInTheDocument();

    const edit = page.getByTestId('apps-listing-owner-edit').element() as HTMLElement;
    // The group holding Edit + the primary CTA.
    const actions = edit.parentElement as HTMLElement;
    expect(actions.style.getPropertyValue('--group-wrap')).toBe('nowrap');
    // The actions are the rigid side: they never shrink…
    expect(actions.style.flexShrink).toBe('0');
    // …and the row itself never wraps, so the actions can't jump to the left.
    const row = actions.parentElement as HTMLElement;
    expect(row.style.getPropertyValue('--group-wrap')).toBe('nowrap');
    // The recommend rollup is the flexible side that absorbs the pressure.
    const rollup = row.firstElementChild as HTMLElement;
    expect(rollup).not.toBe(actions);
    expect(rollup.style.minWidth).toBe('0px');
  });

  test('the owner "Edit" secondary CTA also renders at size "sm"', async () => {
    mocks.currentUser = { id: 5, username: 'alice' };
    renderWithProviders(<AppListingCard card={base({})} canOpenPage />);
    await expect.element(page.getByTestId('apps-listing-owner-edit')).toBeInTheDocument();
    const edit = page.getByTestId('apps-listing-owner-edit').element() as HTMLElement;
    expect(edit.style.getPropertyValue('--button-height')).toBe('var(--button-height-sm)');
  });

  /**
   * CTA ICONS (product-feedback pass). Each action gets its own glyph so three
   * same-shaped buttons become distinguishable at a glance in a dense grid.
   *
   * 🔴 The load-bearing property is that the icon is DECORATIVE: the button's
   * ACCESSIBLE NAME must still be exactly the label text. A Tabler icon that
   * ever gained a `<title>` (or an `aria-label` added "for clarity") would
   * silently rename every CTA for screen-reader and automated-test consumers —
   * `getByRole('link', { name: 'Open' })` would stop matching, and so would the
   * existing tests above. Both halves are asserted per action.
   */
  describe('the CTA icons', () => {
    /** The action button's own svg glyphs (excludes the recommend-rollup icon). */
    function ctaIcons(name: string) {
      const el = page.getByRole('link', { name }).element();
      return Array.from(el.querySelectorAll('svg'));
    }

    test('Open (on-site, runnable) renders an icon and keeps the name "Open"', async () => {
      renderWithProviders(<AppListingCard card={base({})} canOpenPage />);
      // EXACT name — an icon contributing to the accessible name would make this
      // "Open " or "Open <something>" and fail.
      const open = page.getByRole('link', { name: 'Open', exact: true });
      await expect.element(open).toBeInTheDocument();
      expect(ctaIcons('Open')).toHaveLength(1);
    });

    test('Visit (off-site) renders an icon and keeps the name "Visit"', async () => {
      renderWithProviders(
        <AppListingCard
          card={base({
            kind: 'offsite',
            kindData: {
              kind: 'offsite',
              subKind: 'external-link',
              externalUrl: 'https://ext.example/app',
            },
          })}
          canOpenPage
        />
      );
      const visit = page.getByRole('link', { name: 'Visit', exact: true });
      await expect.element(visit).toBeInTheDocument();
      expect(ctaIcons('Visit')).toHaveLength(1);
    });

    test('View details (page flag dark) renders an icon and keeps its name', async () => {
      renderWithProviders(<AppListingCard card={base({})} canOpenPage={false} />);
      const view = page.getByRole('link', { name: 'View details', exact: true });
      await expect.element(view).toBeInTheDocument();
      await expect.element(view).toHaveAttribute('href', '/apps/store-preview/my-app');
      expect(ctaIcons('View details')).toHaveLength(1);
    });

    test('🔴 the action row still holds at NOWRAP with the wider buttons', async () => {
      // The row is `wrap="nowrap"` with `flexShrink: 0` on the actions for two
      // documented reasons (a wrapped single-item line left-aligns under
      // space-between; an OWNER card wrapping at a different width would grow the
      // height of a whole `h-full` grid row). Icons make the buttons ~22px wider,
      // so this pins that the row did not quietly gain wrapping to cope.
      //
      // Rendered in a NARROW column — the tight case is md/lg (3–4 columns), not
      // the wide single-column base — and with the OWNER "Edit" button present,
      // which is the widest configuration the row ever has.
      mocks.currentUser = { id: 5, username: 'alice' };
      renderWithProviders(<Sized width={340} card={base({})} />);
      await expect
        .element(page.getByRole('link', { name: 'Open', exact: true }))
        .toBeInTheDocument();

      const { row, actions, rollup } = actionRow('Open');
      assertLayoutIsReal(row);

      // Now that layout is real, this is a genuine assertion: with the stylesheet
      // loaded `Group` resolves `flex-wrap` from `--group-wrap`, so flipping the
      // component to `wrap="wrap"` makes this read `wrap`.
      expect(getComputedStyle(row).flexWrap).toBe('nowrap');
      expect(getComputedStyle(actions).flexWrap).toBe('nowrap');
      expect(getComputedStyle(actions).flexShrink).toBe('0');

      // …and BEHAVIOURALLY: everything is on one line and nothing overflows the
      // row box. This is the half a `--group-wrap` assertion cannot prove.
      expect(sameLine(rollup, actions)).toBe(true);
      expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth + 1);
      // The actions are at their natural width — not squeezed to fake a fit.
      expect(actions.getBoundingClientRect().width).toBeCloseTo(actions.scrollWidth, 0);
    });

    /**
     * 🔴 THE 280px OWNER REGRESSION.
     *
     * A 280px card content box is what a **1200px viewport** produces at the
     * store's 4-column `xl` grid — a very common laptop width, and one my
     * original 390/768/1440/2560 sweep skipped entirely.
     *
     * Measured there (content box px, `Group gap="xs"` between the two sides):
     *
     *   | case @280                  | actions | rollup | rollup text |
     *   |----------------------------|---------|--------|-------------|
     *   | non-owner + "Open"         |      94 |    139 |         122 |
     *   | non-owner + "View details" |     138 |    132 |         115 |
     *   | owner + "Open"             |     188 |     82 |          65 |
     *   | owner + "View details"     |     232 |     38 |          21 |
     *
     * The rollup's natural width is 139 / 122. In the last row it is 38 — the
     * "91% recommend (100)" text and even the 13px thumb glyph are gone. The
     * `leftSection` icons cost ~44px and that is exactly the deficit, so my PR
     * body's "the rollup absorbs the extra width by truncating, as designed" was
     * wrong for the owner case: below ~360 it does not truncate, it disappears.
     *
     * 🔴 THE FIX IS NOT TO LET THE ROW WRAP. Row height is a constant 46px in
     * every cell above, and nothing overflows — the nowrap + `flexShrink: 0`
     * design is correct and the file documents why wrapping breaks alignment and
     * grid-row heights. The fix is to shrink the OWNER-ONLY Edit control to an
     * icon below a container-query breakpoint, which is the only part of the row
     * that is optional.
     */
    describe('owner cards at a 280px content box (1200px viewport, xl grid)', () => {
      /**
       * 🔴 A REVIEWED card, deliberately. The shared `base()` fixture has no
       * reviews, so its rollup reads "No reviews yet" — only ~96px natural, which
       * FITS at 280 even for an owner and hides the whole regression. (It did:
       * the first run of the non-owner test below asserted a threshold taken from
       * the reviewed measurements and failed at 95.7 against the unreviewed
       * fixture.) "91% recommend (100)" is 139px natural, which is the content
       * that actually gets destroyed, and is what the measured table above used.
       */
      const REVIEWED = {
        recommend: { recommendedCount: 91, notRecommendedCount: 9, recommendPct: 0.91 },
        reviewCount: 100,
      };
      // The widest CTA ("View details") — the tight cell in the table above. A
      // connect-kind listing has no external target, so `getListingCta` falls
      // through to the unified detail. Fully typed (`externalUrl` included)
      // rather than cast. Two bugs the cast was HIDING, both surfaced the moment
      // it became a `satisfies`: `externalUrl` was missing, and the subKind was
      // `'oauth-connect'` — not a member of `OffsiteSubKind` at all
      // (`'connect' | 'external-link'`). Neither `tsc` error reached vitest,
      // which type-strips.
      const OFFSITE_CONNECT = {
        ...REVIEWED,
        kind: 'offsite' as const,
        kindData: {
          kind: 'offsite',
          subKind: 'connect',
          externalUrl: null,
        } satisfies ListingCard['kindData'],
      };

      /**
       * 🔴 THE SAME WIDEST-CTA CARD BUT WITH **NO REVIEWS** — deliberately a second
       * fixture rather than a tweak of the one above, because `OFFSITE_CONNECT`
       * spreads `REVIEWED` and that is easy to miss: a test that reads as "the
       * no-reviews case" while passing `OFFSITE_CONNECT` is silently measuring
       * "91% recommend (100)" (122px of text) instead of "No reviews yet" (79px).
       * That mistake was made and caught here by a red baseline, not by review.
       *
       * "No reviews yet" is the SHORT label — the least the rollup can ever say —
       * which is exactly why it is the right fixture for the truncation floor: if
       * even this does not fit, the deficit is structural.
       */
      const OFFSITE_CONNECT_NO_REVIEWS = {
        kind: 'offsite' as const,
        recommend: { recommendedCount: 0, notRecommendedCount: 0, recommendPct: null },
        reviewCount: 0,
        kindData: {
          kind: 'offsite',
          subKind: 'connect',
          externalUrl: null,
        } satisfies ListingCard['kindData'],
      };

      test('🔴 owner + "View details" keeps a LEGIBLE recommend rollup', async () => {
        mocks.currentUser = { id: 5, username: 'alice' };
        renderWithProviders(<Sized width={314} card={base(OFFSITE_CONNECT)} />);
        await expect
          .element(page.getByRole('link', { name: 'View details', exact: true }))
          .toBeInTheDocument();

        const { row, rollup } = actionRow('View details');
        assertLayoutIsReal(row);
        expect(Math.round(row.clientWidth)).toBe(282); // 314 - 2x16 padding (no border since S4)

        // 80px is grounded in the measurements above, not invented: the glyph is
        // 13px + a 4px gap, so 80 leaves ~63px of text — enough for "91% recom…"
        // to read as a recommendation figure. Pre-fix this is 38 (text 21), which
        // shows nothing at all; post-fix the icon-only Edit returns ~50px.
        expect(rollup.getBoundingClientRect().width).toBeGreaterThanOrEqual(80);

        // The thumb glyph specifically must survive — it is the affordance that
        // says "this number is a rating" at a glance.
        const glyph = rollup.querySelector('svg') as SVGElement;
        expect(glyph).toBeTruthy();
        expect(glyph.getBoundingClientRect().width).toBeGreaterThan(0);
        expect(glyph.getBoundingClientRect().right).toBeLessThanOrEqual(
          rollup.getBoundingClientRect().right + 1
        );

        // …and the row still holds its shape: one line, no overflow.
        expect(sameLine(rollup, actionRow('View details').actions)).toBe(true);
        expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth + 1);
      });

      /**
       * 🔴 THE TRUE 1200px GEOMETRY, which is TIGHTER than the case above.
       *
       * Measured through the real `AppsPageLayout` + `Grid` at a 1200 viewport:
       * container 1200 -> grid column 296 -> CARD 280 -> action-row content box
       * **248**. So "280px" in the original report is the card's OUTER width; the
       * box the action row actually gets is 248, and a 314px wrapper (content box
       * 282) corresponds to roughly a 1345 viewport.
       *
       * 🔴 THIS TEST'S EXPECTATION WAS INVERTED (rollup-floor pass, on main+#3547).
       * It used to assert the rollup SURVIVES here at >= 50px, and it passed: the
       * measured value on this tree is 54.1px. That IS the defect. At 54px the
       * rollup is a 13px thumb glyph, a 4px gap and 37px of 12px text, so the
       * shortest label it can carry — "No reviews yet", 79px natural — renders as a
       * ~5-character stub. A stub is strictly worse than nothing: it holds the
       * slot, reads as a rendering bug, and communicates nothing. Below a 264px
       * container the rollup is now HIDDEN instead, and the actions keep the right
       * edge.
       *
       * Measured on main+#3547 (owner, widest CTA, no reviews), pre-change:
       *   container 248 -> rollup 54 (text 37 / 79 natural, TRUNCATED)
       *   container 268 -> rollup 74 (text 57 / 79, truncated)
       *   container 282 -> rollup 88 (text 71 / 79, truncated)
       *   container 298 -> rollup 96 (text 79 / 79, full)
       */
      test('🔴 at the REAL 1200 geometry an owner card DROPS the rollup instead of crushing it', async () => {
        mocks.currentUser = { id: 5, username: 'alice' };
        // 🔴 NO reviews — the label the live report caught, and the SHORT one (79px
        // of text vs 122px for "91% recommend (100)"). Using the short label is
        // what makes this structural rather than an artefact of a long string:
        // even the least the rollup can ever say does not fit here.
        renderWithProviders(<Sized width={280} card={base(OFFSITE_CONNECT_NO_REVIEWS)} />);
        await expect
          .element(page.getByRole('link', { name: 'View details', exact: true }))
          .toBeInTheDocument();
        await expect.element(page.getByText('No reviews yet')).toBeInTheDocument();
        const { row, actions, rollup } = actionRow('View details');
        assertLayoutIsReal(row);
        expect(Math.round(row.clientWidth)).toBe(248); // 280 - 2x16 padding (no border since S4)

        // 🔴 THE GUARD. Pre-change this element measured 54.1px and computed
        // `display: flex`. Asserted FIRST, so a mutation that re-shrinks the rollup
        // fails HERE on this guard's own assertion rather than being killed by the
        // alignment check below (which passes either way while the rollup exists).
        expect(getComputedStyle(rollup).display).toBe('none');
        expect(rollup.getBoundingClientRect().width).toBe(0);

        // 🔴 A SEPARATE failure mode, deliberately in the same test because only
        // this geometry exposes it: with the rollup out of layout the row holds ONE
        // flex item, and `justify="space-between"` puts a lone item at flex-START.
        // The actions group carries `marginLeft: 'auto'` for exactly that; delete
        // the margin and the assertions above stay green while the whole CTA
        // cluster jumps to the card's left edge.
        expect(actions.getBoundingClientRect().right).toBeCloseTo(
          row.getBoundingClientRect().right,
          0
        );
        expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth + 1);
      });

      /**
       * ⚠️ INVARIANT GUARD, NOT regression coverage — it passes on pre-change code
       * too (the rollup measured 88.1px here before and after). It earns its place
       * by BOUNDING the hide above: the fix must remove the rollup only where it is
       * debris, and this is the first real store geometry above the threshold.
       * Without it, widening the threshold to "hide it on any narrow owner card"
       * would pass unnoticed.
       */
      test('⚠️ INVARIANT: just ABOVE the 264px threshold the owner rollup is back and legible', async () => {
        mocks.currentUser = { id: 5, username: 'alice' };
        renderWithProviders(<Sized width={314} card={base(OFFSITE_CONNECT)} />);
        await expect
          .element(page.getByRole('link', { name: 'View details', exact: true }))
          .toBeInTheDocument();
        const { row, rollup } = actionRow('View details');
        assertLayoutIsReal(row);
        expect(Math.round(row.clientWidth)).toBe(282); // 282 >= the 264 threshold
        expect(getComputedStyle(rollup).display).toBe('flex');
        // 80px is the literal floor from the pre-existing measured table.
        expect(rollup.getBoundingClientRect().width).toBeGreaterThanOrEqual(80);
        const glyph = rollup.querySelector('svg') as SVGElement;
        expect(glyph.getBoundingClientRect().width).toBeGreaterThan(0);
        expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth + 1);
      });

      /**
       * ⚠️ INVARIANT GUARD, NOT regression coverage — a non-owner card measured
       * 95.7px here before the change and measures 95.7px after. It is here because
       * the whole fix is owner-scoped (`showEdit`), and a version that dropped that
       * condition would delete the rollup from every public shopper's card at the
       * single most common desktop geometry — a failure no other test in this file
       * could see.
       */
      test('⚠️ INVARIANT: at the SAME 1200 geometry a NON-owner card keeps its full rollup', async () => {
        mocks.currentUser = null;
        renderWithProviders(<Sized width={280} card={base(OFFSITE_CONNECT_NO_REVIEWS)} />);
        await expect
          .element(page.getByRole('link', { name: 'View details', exact: true }))
          .toBeInTheDocument();
        const { row, rollup } = actionRow('View details');
        assertLayoutIsReal(row);
        expect(Math.round(row.clientWidth)).toBe(248);
        expect(getComputedStyle(rollup).display).toBe('flex');
        // Literal pin from the measured table: 95.7px, i.e. the full natural width,
        // because a non-owner action set is 138px rather than 184px.
        expect(rollup.getBoundingClientRect().width).toBeGreaterThanOrEqual(95);
        const text = rollup.querySelector('[data-truncate]') as HTMLElement;
        expect(text.scrollWidth).toBeLessThanOrEqual(text.clientWidth);
      });

      test('owner + "Open" (the narrower CTA) also keeps the rollup legible', async () => {
        mocks.currentUser = { id: 5, username: 'alice' };
        renderWithProviders(<Sized width={314} card={base(REVIEWED)} />);
        await expect
          .element(page.getByRole('link', { name: 'Open', exact: true }))
          .toBeInTheDocument();
        const { row, rollup } = actionRow('Open');
        assertLayoutIsReal(row);
        expect(rollup.getBoundingClientRect().width).toBeGreaterThanOrEqual(80);
      });

      test('🔴 NON-owner cards are byte-unchanged — no icon Edit, same actions width', async () => {
        // The whole change is owner-only. A non-owner card has no Edit control at
        // all, so its geometry must be exactly what it was before this fix.
        mocks.currentUser = null;
        renderWithProviders(<Sized width={314} card={base(OFFSITE_CONNECT)} />);
        await expect
          .element(page.getByRole('link', { name: 'View details', exact: true }))
          .toBeInTheDocument();
        const { row, actions, rollup } = actionRow('View details');
        assertLayoutIsReal(row);
        expect(page.getByTestId('apps-listing-owner-edit').elements()).toHaveLength(0);
        expect(page.getByTestId('apps-listing-owner-edit-icon').elements()).toHaveLength(0);
        // Measured pre-fix values, pinned so an owner-side change cannot leak.
        expect(Math.round(actions.getBoundingClientRect().width)).toBe(138);
        expect(rollup.getBoundingClientRect().width).toBeGreaterThanOrEqual(130);
      });

      test('the icon-only Edit keeps a real accessible name and its href', async () => {
        mocks.currentUser = { id: 5, username: 'alice' };
        renderWithProviders(<Sized width={314} card={base(OFFSITE_CONNECT)} />);
        const edit = page.getByTestId('apps-listing-owner-edit-icon');
        await expect.element(edit).toBeInTheDocument();
        // The glyph alone is not an accessible name (the CategoryFilterButtons
        // precedent) — and the icon form must go to the SAME place as the text one.
        await expect.element(edit).toHaveAttribute('aria-label', 'Edit');
        await expect.element(edit).toHaveAttribute('href', '/apps/submit?edit=l1');
        // …and it must not repeat the recents rail's `<a type="button">` leak.
        // This one uses the polymorphic `component={Link}` rather than
        // `renderRoot`, so Mantine knows the root is not a <button> and omits
        // `type` — asserted rather than assumed, since the two paths differ.
        expect((edit.element() as HTMLElement).getAttribute('type')).toBeNull();
      });

      test('the icon form is the one SHOWN at 280 and the text form at 460', async () => {
        // The container query is what decides, so assert on rendered visibility
        // rather than on which nodes exist.
        mocks.currentUser = { id: 5, username: 'alice' };
        const { rerender } = await renderWithProviders(
          <Sized width={314} card={base(OFFSITE_CONNECT)} />
        );
        await expect.element(page.getByTestId('apps-listing-owner-edit-icon')).toBeVisible();
        await expect.element(page.getByTestId('apps-listing-owner-edit')).not.toBeVisible();

        await rerender(<Sized width={494} card={base(OFFSITE_CONNECT)} />);
        await expect.element(page.getByTestId('apps-listing-owner-edit')).toBeVisible();
        await expect.element(page.getByTestId('apps-listing-owner-edit-icon')).not.toBeVisible();
      });
    });

    test('the recommend rollup is the side that absorbs the extra width (it truncates)', async () => {
      renderWithProviders(<Sized width={340} card={base({})} />);
      await expect.element(page.getByText('No reviews yet')).toBeInTheDocument();
      const rollup = page.getByText('No reviews yet').element() as HTMLElement;
      // Mantine's `data-truncate` attribute AND the resolved style — with the
      // stylesheet loaded the class-based ellipsis actually computes, so both
      // halves are real. (Before the stylesheet import this asserted only the
      // attribute, because `textOverflow` computed to `clip` regardless.)
      expect(rollup.getAttribute('data-truncate')).toBe('end');
      expect(getComputedStyle(rollup).textOverflow).toBe('ellipsis');
      // …and its container is the shrinkable side (`minWidth: 0` is what lets a
      // flex item shrink below its content width at all), which is the actual
      // mechanism that keeps the widened action buttons at natural size.
      expect((rollup.parentElement as HTMLElement).style.minWidth).toBe('0px');
    });
  });

  test('a long username reveals the full value in a tooltip on hover (clip fallback)', async () => {
    const longName = 'a-really-long-creator-username-that-will-definitely-overflow-the-card-column';
    // The tooltip is overflow-GATED (TruncatedText disables it unless the label
    // actually clips — a runtime scrollWidth/scrollHeight measurement). Constrain
    // the card to a narrow column so the long username really overflows; without a
    // width bound the label never clips and the tooltip stays disabled.
    renderWithProviders(
      <div style={{ width: 200 }}>
        <AppListingCard
          card={base({ creator: { id: 5, username: longName, image: null } })}
          canOpenPage
        />
      </div>
    );
    const label = page.getByText(`by ${longName}`);
    await expect.element(label).toBeInTheDocument();
    await label.hover();
    // The Tooltip renders the full username (portal) once the label overflows.
    await expect.element(page.getByText(longName, { exact: true })).toBeInTheDocument();
  });
});
