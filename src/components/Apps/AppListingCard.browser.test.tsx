import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
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
    kindData: { kind: 'onsite', appBlockId: 'blk-1', hasPage: true, liveUrl: 'https://my-app.civit.ai' },
    ...over,
  };
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
    await expect
      .element(page.getByTestId('apps-listing-owner-incomplete'))
      .toBeInTheDocument();
  });

  test('OWNER does NOT see the "Incomplete" indicator when icon+cover are present', async () => {
    mocks.currentUser = { id: 5, username: 'alice' };
    renderWithProviders(
      <AppListingCard
        card={base({ iconUrl: 'https://edge/icon.png', coverUrl: 'https://edge/cover.png' })}
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

  // A 1x1 transparent PNG. A real (non-network) src that LOADS, so the <img>
  // survives — any http(s) URL fails to fetch in the test browser and trips the
  // component's own onError → placeholder path (exercised separately below).
  const LOADABLE_PNG =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  test('cover image renders INSIDE the 16:9 aspect box', async () => {
    renderWithProviders(<AppListingCard card={base({ coverUrl: LOADABLE_PNG })} canOpenPage />);
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
    expect(img?.getAttribute('src')).toBe(LOADABLE_PNG);
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
    // is the component's own onError → placeholder path.
    renderWithProviders(
      <AppListingCard card={base({ coverUrl: 'https://edge.invalid/does-not-exist.png' })} canOpenPage />
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

  test('a long username reveals the full value in a tooltip on hover (clip fallback)', async () => {
    const longName = 'a-really-long-creator-username-that-will-definitely-overflow-the-card-column';
    // The tooltip is overflow-GATED (TruncatedText disables it unless the label
    // actually clips — a runtime scrollWidth/scrollHeight measurement). Constrain
    // the card to a narrow column so the long username really overflows; without a
    // width bound the label never clips and the tooltip stays disabled.
    renderWithProviders(
      <div style={{ width: 200 }}>
        <AppListingCard card={base({ creator: { id: 5, username: longName, image: null } })} canOpenPage />
      </div>
    );
    const label = page.getByText(`by ${longName}`);
    await expect.element(label).toBeInTheDocument();
    await label.hover();
    // The Tooltip renders the full username (portal) once the label overflows.
    await expect.element(page.getByText(longName, { exact: true })).toBeInTheDocument();
  });
});
