import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
import type * as TrpcMod from '~/utils/trpc';
import type * as FeatureFlagsMod from '~/providers/FeatureFlagsProvider';
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
 * P2b AppListingCard component tests (`Component tests` in CI; the node-tier
 * gate is appListingCardView.test.ts). These pin the
 * rendered kind badge, recommend label, and kind-aware CTA affordance for a few
 * representative cards, PLUS the owner "Edit" deep-link gating (Item 2), the
 * clamped-title tooltip fallback, the card's LAYOUT contract (a two-line reserved
 * title, a 46px action row, and the stats line BELOW that row) and the play
 * count's null-vs-zero rule.
 *
 * ⚠️ "PLUS the long-username tooltip fallback (Item 1)" USED TO BE THE LAST CLAUSE
 * HERE. That test is deleted with its subject — the card no longer renders an
 * author chip (2026-09-06) — and the surviving tooltip coverage is the TITLE's, so
 * the sentence is re-derived rather than trimmed.
 */

const mocks = vi.hoisted(() => ({
  // `isModerator` is what `isAppReviewer` reads — the gate on the `⋮` menu's
  // moderator section. Optional so every pre-existing fixture keeps its exact
  // meaning (absent → falsy → not a moderator).
  currentUser: null as null | { id: number; username: string; isModerator?: boolean },
  // Store-visibility flags, MUTABLE per test — `useCanReviewListing` resolves the
  // client store scope from them, so a fixed literal would make this suite
  // structurally unable to construct a viewer who may review.
  features: { appBlocks: true, appListings: true, appBlocksPages: false } as Record<
    string,
    boolean
  >,
  reportMutate: vi.fn(),
  upsertMutate: vi.fn(),
  messageOwnerMutate: vi.fn(),
  delistMutate: vi.fn(),
  resetOffsiteMutate: vi.fn(),
  resetOnsiteMutate: vi.fn(),
  // The owner "Visibility" item's lazy read. Every `useQuery` call is recorded with its
  // `enabled`, so a test can show the read is OFF until the item is clicked. The stub
  // returns data only when enabled, matching React Query's behaviour for a disabled query.
  authoringCalls: [] as { input: unknown; enabled: boolean | undefined }[],
  authoringContext: null as null | Record<string, unknown>,
  setVisibilityMutate: vi.fn(),
  setVisibilityAsModMutate: vi.fn(),
}));

vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => mocks.currentUser,
}));

/**
 * 🔴 BOTH FLAG HOOKS ARE OVERRIDDEN, AND THEY MUST RETURN THE SAME OBJECT.
 * `useCanReviewListing` reads `useOptionalFeatureFlags` (it must not throw outside a
 * provider); overriding only `useFeatureFlags` leaves the optional one resolving to
 * the real null-outside-provider value, i.e. store scope `none`, which silently hides
 * the review affordance. `importOriginal` is SPREAD rather than replaced wholesale
 * (local-rules/no-wholesale-module-mock).
 */
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsMod>()),
  useFeatureFlags: () => mocks.features,
  useOptionalFeatureFlags: () => mocks.features,
}));

/**
 * 🔴 tRPC IS REACHED ONLY THROUGH THE `⋮` MENU'S MODALS, AND ONLY AFTER IT IS OPENED.
 *
 * The card itself makes no request. The shared `AppListingActionsMenu` mounts its
 * modals lazily — the first time the menu opens — so a test that never opens it needs
 * none of this. It is mocked anyway because several tests below DO open the menu, and
 * because a suite that would explode the moment someone adds such a test is a trap.
 *
 * Spread the REAL module and override only `trpc` (local-rules/no-wholesale-module-mock):
 * a hand-written replacement silently breaks every importer the day `~/utils/trpc` grows
 * an export this factory omits.
 */
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  trpc: {
    appListings: {
      getMyReview: { useQuery: () => ({ data: null, isLoading: false }) },
      upsertReview: { useMutation: () => ({ mutate: mocks.upsertMutate, isPending: false }) },
      reportListing: {
        useMutation: (opts?: { onSuccess?: () => void }) => ({
          mutate: (input: unknown) => {
            mocks.reportMutate(input);
            opts?.onSuccess?.();
          },
          isPending: false,
        }),
      },
      messageAppOwner: {
        useMutation: (opts?: {
          onSuccess?: (r: { recipientCount: number }) => void | Promise<void>;
        }) => ({
          mutate: (input: unknown) => {
            mocks.messageOwnerMutate(input);
            void opts?.onSuccess?.({ recipientCount: 1 });
          },
          mutateAsync: vi.fn(),
          isPending: false,
        }),
      },
      delistListing: {
        useMutation: (opts?: { onSuccess?: () => void | Promise<void> }) => ({
          mutate: (input: unknown) => {
            mocks.delistMutate(input);
            void opts?.onSuccess?.();
          },
          isPending: false,
        }),
      },
      resetListingToPending: {
        useMutation: (opts?: { onSuccess?: () => void | Promise<void> }) => ({
          mutate: (input: unknown) => {
            mocks.resetOffsiteMutate(input);
            void opts?.onSuccess?.();
          },
          isPending: false,
        }),
      },
      resetOnsiteListingToPending: {
        useMutation: (opts?: { onSuccess?: () => void | Promise<void> }) => ({
          mutate: (input: unknown) => {
            mocks.resetOnsiteMutate(input);
            void opts?.onSuccess?.();
          },
          isPending: false,
        }),
      },
      // 🔴 THE TWO VISIBILITY PICKERS' HOOKS. Both modals mount (lazily) the first time an
      // owner's or moderator's menu opens, so a missing key here throws AT MOUNT and fails
      // every test that opens the menu — not just the visibility ones.
      getAuthoringContext: {
        useQuery: (input: unknown, opts?: { enabled?: boolean }) => {
          mocks.authoringCalls.push({ input, enabled: opts?.enabled });
          return opts?.enabled
            ? { data: mocks.authoringContext ?? undefined, isError: false }
            : { data: undefined, isError: false };
        },
      },
      setListingVisibility: {
        useMutation: () => ({ mutate: mocks.setVisibilityMutate, isPending: false }),
      },
      setListingVisibilityAsModerator: {
        useMutation: () => ({ mutate: mocks.setVisibilityAsModMutate, isPending: false }),
      },
    },
    useUtils: () => ({
      appListings: {
        getMyReview: { invalidate: async () => undefined },
        listReviews: { invalidate: async () => undefined },
        getAppDetail: { invalidate: async () => undefined },
        getAuthoringContext: { invalidate: async () => undefined },
        listMine: { invalidate: async () => undefined },
      },
    }),
  },
}));

// Import AFTER the mock is declared (vi.mock is hoisted, imports are not).
const { AppListingCard } = await import('./AppListingCard');

beforeEach(() => {
  mocks.currentUser = null;
  mocks.features = { appBlocks: true, appListings: true, appBlocksPages: false };
  mocks.authoringCalls = [];
  mocks.authoringContext = null;
  mocks.setVisibilityMutate.mockClear();
  mocks.setVisibilityAsModMutate.mockClear();
});

/** A signed-in moderator who is NOT the fixture's owner (`base().creator.id === 5`). */
const MODERATOR = { id: 999, username: 'mod', isModerator: true };
/** An ordinary signed-in viewer who is not the owner. */
const SHOPPER = { id: 999, username: 'bob' };
/** The fixture's owner. */
const OWNER = { id: 5, username: 'alice' };

/**
 * Open the card's `⋮` menu and wait for the dropdown to mount.
 *
 * 🔴 EVERY MENU ITEM IS UNMOUNTED WHILE THE MENU IS CLOSED — a Mantine
 * `Menu.Dropdown` renders no DOM at all until it opens. So a query for `Edit` (or any
 * other item) before this has run reports absence for a control that is present and
 * correct, which is a false negative rather than a finding.
 */
async function openCardMenu() {
  const trigger = page.getByTestId('apps-listing-card-actions-menu');
  await expect.element(trigger).toBeInTheDocument();
  await trigger.click();
  return trigger;
}

/**
 * Every INTERACTIVE element in the document whose accessible name is exactly "Edit".
 *
 * 🔴 COUNTS NODES, NOT VISIBLE NODES, ON PURPOSE. The pre-change card rendered two
 * Edit controls and hid one with `display: none`; a check that filtered on visibility
 * would have scored that arrangement as "exactly one" and could never go red on it.
 * Non-interactive descendants (Mantine wraps a `Menu.Item`'s label in a `span`) are
 * excluded, so this counts affordances rather than DOM depth.
 */
function editAffordances(): Element[] {
  return Array.from(
    document.querySelectorAll('a, button, [role="menuitem"], [role="button"]')
  ).filter((el) => (el.getAttribute('aria-label') ?? el.textContent ?? '').trim() === 'Edit');
}

function base(over: Partial<ListingCard>): ListingCard {
  return {
    id: 'l1',
    slug: 'my-app',
    kind: 'onsite',
    name: 'My App',
    tagline: 'A handy app',
    category: 'utility',
    contentRating: null,
    isBeta: false,
    iconUrl: null,
    coverUrl: null,
    creator: { id: 5, username: 'alice', image: null },
    recommend: { recommendedCount: 0, notRecommendedCount: 0, recommendPct: null },
    reviewCount: 0,
    openCount: 0,
    restrictedAudience: null,
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
 * The widths used below:
 *   - `280` -> a 248px action row. This is the CARD the store renders at FOUR
 *     COLUMNS on a 1168px grid;
 *   - `314` -> a 282px action row, one step wider — kept for continuity with the
 *     pre-change table rather than because a particular rung produces it;
 *   - `494` -> a 462px action row, the wide end, chosen so the CTA has real slack
 *     to grow into.
 *
 * 🔴 STATED AGAINST THE GRID RUNG, NOT A VIEWPORT — AND THAT IS A CORRECTION, NOT
 * A STYLE PREFERENCE. This block used to derive 280 as "the TRUE 1200px-viewport
 * geometry (container 1200 -> column 296 -> card 280 -> row 248)". Every step of
 * that chain except the last is the STORE's business, not the card's, and both
 * halves have since moved: the `column 296` step names Mantine `<Grid.Col>`
 * arithmetic the store no longer uses, and a 1200 viewport does not even yield
 * four columns once a scrollbar is reserved. The card NUMBERS were never wrong —
 * 280/248 is still the real four-column card — but the sentence a maintainer reads
 * to decide whether these fixtures still represent production had gone stale, and
 * a stale justification is how correct fixtures get "fixed".
 *
 * The card's contract is "AT THESE WIDTHS, THIS GEOMETRY". That survives whichever
 * grid implementation sits above it, so these widths are exercise points anchored
 * to the grid, and deliberately not to a viewport or to any grid's column maths.
 * ("280" in the original bug report is the CARD width, not its content box.)
 */
function Sized({ width, card }: { width: number; card: ListingCard }) {
  return (
    <div style={{ width }}>
      <AppListingCard card={card} canOpenPage />
    </div>
  );
}

/** The recommend rollup, wherever it is. Used for BOTH presence and absence. */
const ROLLUP_SELECTOR = '[data-testid="apps-listing-recommend-rollup"]';
/** The play count, wherever it is. Used for BOTH presence and absence. */
const PLAY_COUNT_SELECTOR = '[data-testid="apps-listing-play-count"]';

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
          kindData: { kind: 'offsite', externalUrl: 'https://ext.app' },
        })}
      />
    );
    const visit = page.getByRole('link', { name: 'Visit' });
    await expect.element(visit).toHaveAttribute('href', 'https://ext.app');
    await expect.element(visit).toHaveAttribute('target', '_blank');
    await expect.element(visit).toHaveAttribute('rel', 'noopener noreferrer');
    // The kind signal ("Standalone") is no longer a badge — it's conveyed by the
    // CTA above (an external "Visit" anchor vs. an internal Open/View details
    // link) plus the off-site disclosure Alert on the detail page.
    //
    // 🔴 `expect(locator.query()).toBeNull()`, NOT `expect.element(...).not.toBeInTheDocument()`.
    // The latter is REACHABLE BUT NON-ASSERTING: it passes for every string, including
    // ones the card demonstrably renders. Controlled both ways — asserting absence of
    // 'Visit' (rendered, per the three awaits above) goes RED in this form and PASSED in
    // the old one. Ordering is load-bearing too: `.query()` is a point-in-time read, so
    // it must follow an awaited positive assertion or it can pass on an unsettled render.
    expect(page.getByText('Standalone', { exact: true }).query()).toBeNull();
  });

  test('off-site connect with NO external target → View details → unified detail', async () => {
    // 🔴 `externalUrl: null` is what makes this the View-details case, NOT the
    // sub-kind. The comment here used to say cards route connect listings to the
    // detail because "the connect flow needs a P2a authorize-URL DTO addition" —
    // that premise was wrong and produced a dead end (the detail's Connect
    // affordance was an inert stub). A connect listing WITH an https
    // `externalUrl` now gets a direct Visit ↗; see the test below. The former
    // "Connect app" kind badge is gone — no longer asserted here.
    renderWithProviders(
      <AppListingCard
        card={base({
          kind: 'offsite',
          name: 'Connect App',
          kindData: { kind: 'offsite', externalUrl: null },
        })}
      />
    );
    const details = page.getByRole('link', { name: 'View details' });
    await expect.element(details).toHaveAttribute('href', '/apps/store-preview/my-app');
  });

  test('🔴 off-site connect WITH an https externalUrl → Visit ↗ external anchor', async () => {
    // The rendered counterpart of the view-model reversal: a linked OAuth client
    // no longer strands the card on "View details". Asserted on the real anchor
    // (href + target + rel), not just the label, because the whole defect was an
    // affordance that looked present and went nowhere.
    renderWithProviders(
      <AppListingCard
        card={base({
          kind: 'offsite',
          name: 'Connect App',
          kindData: { kind: 'offsite', externalUrl: 'https://connect.app' },
        })}
      />
    );
    await expect.element(page.getByRole('link', { name: 'View details' })).not.toBeInTheDocument();
    const visit = page.getByRole('link', { name: 'Visit' });
    await expect.element(visit).toHaveAttribute('href', 'https://connect.app');
    await expect.element(visit).toHaveAttribute('target', '_blank');
    await expect.element(visit).toHaveAttribute('rel', 'noopener noreferrer');
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
          kindData: { kind: 'offsite', externalUrl: 'https://ext.app' },
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

  // ── The `⋮` overflow menu ───────────────────────────────────────────────────
  //
  // Edit used to be TWO controls in the action row — a text `Button` and an
  // icon-only `ActionIcon`, swapped by an `@[360px]` container query. Both are
  // gone, and so is that breakpoint: Edit is now one `Menu.Item` inside the
  // SHARED `AppListingActionsMenu` (see that module), reached through a fixed
  // 36px `⋮` trigger.

  test('owner sees the Edit deep-link → on-site manifest editor', async () => {
    mocks.currentUser = OWNER; // matches base().creator.id
    renderWithProviders(<AppListingCard card={base({})} canOpenPage />);
    await openCardMenu();
    const edit = page.getByTestId('apps-listing-owner-edit');
    await expect.element(edit).toBeInTheDocument();
    await expect.element(edit).toHaveAttribute('href', '/apps/blk-1/edit');
  });

  test('owner of an off-site listing → Edit routes to the submit editor by listing id', async () => {
    mocks.currentUser = OWNER;
    renderWithProviders(
      <AppListingCard
        card={base({
          kind: 'offsite',
          kindData: { kind: 'offsite', externalUrl: 'https://ext.app' },
        })}
      />
    );
    await openCardMenu();
    const edit = page.getByTestId('apps-listing-owner-edit');
    await expect.element(edit).toHaveAttribute('href', '/apps/submit?edit=l1');
  });

  /**
   * 🔴 THE CARD DOES NOT OFFER THE VIEWER ACTIONS — the narrowing, asserted on the
   * viewer it is about.
   *
   * `useCanReportListing` is `!!useCurrentUser()`, so before `surface="card"` this
   * viewer — an ordinary signed-in shopper, the single most common real visitor to
   * the store — got a `⋮` holding Report and Leave a review, and the wider action
   * row that comes with it. Both items now live only on the listing DETAIL page
   * (`appListingMenuSurface.ts`), so this viewer's menu holds nothing and the
   * trigger is suppressed.
   *
   * 🔴 THIS IS THE CASE THE SUITE COULD NOT SEE. The action-row width guard that
   * was supposed to cover this pinned a SIGNED-OUT viewer, who has no menu either
   * way — so it stayed green across the whole change. A guard that cannot reach the
   * case it appears to cover is worse than no guard, which is why the geometry half
   * below is now run over BOTH viewers from one assertion body.
   */
  test('🔴 a signed-in NON-owner, NON-moderator gets NO menu on the CARD', async () => {
    mocks.currentUser = SHOPPER;
    renderWithProviders(<AppListingCard card={base({})} canOpenPage />);
    // Render barrier — the card is really on screen, so the zeros below are about
    // the menu and not about an empty document.
    await expect.element(page.getByText('My App')).toBeInTheDocument();
    // 🔴 `.elements()).toHaveLength(0)`, NOT `expect.element(...).not.toBeInTheDocument()`
    // — the latter is INERT in this repo (civitai/civitai#4197).
    expect(page.getByTestId('apps-listing-card-actions-menu').elements()).toHaveLength(0);
    // 🔴 AND THE ITEMS THEMSELVES, not only the trigger. A Mantine `Menu.Dropdown`
    // renders no DOM while closed, so these three zeros are weak on their own — they
    // are here so a future change that keeps the trigger but empties it, or renders
    // the items somewhere other than behind the trigger, still fails.
    expect(page.getByTestId('apps-listing-report-action').elements()).toHaveLength(0);
    expect(page.getByTestId('apps-listing-review-action').elements()).toHaveLength(0);
    expect(page.getByTestId('apps-listing-owner-edit').elements()).toHaveLength(0);
  });

  /**
   * 🔴 THE POSITIVE CONTROL FOR THE TEST ABOVE, AND IT IS NOT OPTIONAL. "No menu for
   * a signed-in shopper" is also what a card renders when the menu is broken for
   * everyone, when the fixture is malformed, or when the harness stopped mounting
   * the component at all. The OWNER arm proves the card can still produce a menu
   * from the very same fixture and the very same render path, so the zeros above are
   * attributable to the viewer rather than to the machinery.
   */
  test('🔴 …while the OWNER, on the same fixture, still gets one', async () => {
    mocks.currentUser = OWNER;
    renderWithProviders(<AppListingCard card={base({})} canOpenPage />);
    await openCardMenu();
    await expect.element(page.getByTestId('apps-listing-owner-edit')).toBeInTheDocument();
    // …and the narrowing reaches INSIDE an open menu, not just the trigger: the
    // owner is signed in, so `useCanReportListing` admits them, and Report is absent
    // here only because the CARD does not offer it. On the detail page the same
    // viewer does get it — `AppListingDetailBody.browser.test.tsx` pins that.
    expect(page.getByTestId('apps-listing-report-action').elements()).toHaveLength(0);
    expect(page.getByTestId('apps-listing-review-action').elements()).toHaveLength(0);
  });

  test('🔴 a signed-out viewer gets NO menu at all', async () => {
    // Nothing in the menu is available to an anonymous viewer: Edit is owner-only,
    // review and report both require a session, and the mod section requires
    // `isModerator`. An empty menu that punishes the click is worse than no control,
    // so the trigger itself is absent — which is also what keeps an anonymous
    // shopper's action row byte-identical to what it was before this change.
    mocks.currentUser = null;
    renderWithProviders(<AppListingCard card={base({})} canOpenPage />);
    await expect.element(page.getByText('My App')).toBeInTheDocument();
    expect(page.getByTestId('apps-listing-card-actions-menu').elements()).toHaveLength(0);
    expect(page.getByTestId('apps-listing-owner-edit').elements()).toHaveLength(0);
  });

  test('🔴 a MODERATOR viewing someone else’s card gets the moderator section', async () => {
    // Accepted geometry consequence, asserted rather than left implicit: with the
    // viewer actions gone from this surface, the owner and a moderator are the ONLY
    // viewers who get a `⋮` (and therefore a wider action cluster) on a card every
    // other viewer sees without one.
    //
    // 🔴 THIS IS ALSO THE SUITE'S "a menu WITHOUT Edit" CASE. It used to be a signed-in
    // shopper's; that viewer now has no menu at all, and a claim about what is inside a
    // menu has to be made on a viewer who HAS one.
    mocks.currentUser = MODERATOR;
    renderWithProviders(<AppListingCard card={base({})} canOpenPage />);
    await openCardMenu();
    await expect.element(page.getByTestId('apps-listing-mod-message-owner')).toBeInTheDocument();
    await expect.element(page.getByTestId('apps-listing-mod-manage')).toBeInTheDocument();
    // …and still no Edit: they are not the owner.
    expect(page.getByTestId('apps-listing-owner-edit').elements()).toHaveLength(0);
  });

  test('🔴 `preview` suppresses the whole menu, moderator included', async () => {
    // The moderator listing-media review renders this card READ-ONLY over an
    // UNAPPROVED shadow listing. Without the prop, the reviewer — who is by
    // definition a moderator — would be offered live takedown actions against a
    // listing whose status and whose `id` are both unguaranteed.
    mocks.currentUser = MODERATOR;
    renderWithProviders(<AppListingCard card={base({})} canOpenPage preview />);
    await expect.element(page.getByText('My App')).toBeInTheDocument();
    expect(page.getByTestId('apps-listing-card-actions-menu').elements()).toHaveLength(0);
  });

  // ── Visibility items ─────────────────────────────────────────────────────────

  test('the OWNER gets a Visibility item; a moderator who is not the owner does not', async () => {
    mocks.currentUser = OWNER;
    renderWithProviders(<AppListingCard card={base({})} canOpenPage />);
    await openCardMenu();
    await expect.element(page.getByTestId('apps-listing-owner-visibility')).toBeInTheDocument();
    await expect
      .element(page.getByTestId('apps-listing-owner-visibility'))
      .toHaveTextContent('Visibility');
    // Not a moderator, so no moderator copy of the control.
    expect(page.getByTestId('apps-listing-mod-visibility').elements()).toHaveLength(0);
  });

  test('a MODERATOR (not the owner) gets "Set visibility" and NOT the owner item', async () => {
    mocks.currentUser = MODERATOR;
    renderWithProviders(<AppListingCard card={base({})} canOpenPage />);
    await openCardMenu();
    const item = page.getByTestId('apps-listing-mod-visibility');
    await expect.element(item).toBeInTheDocument();
    await expect.element(item).toHaveTextContent('Set visibility');
    expect(page.getByTestId('apps-listing-owner-visibility').elements()).toHaveLength(0);
  });

  test('an OWNER who is also a MODERATOR gets "Visibility" and NOT "Set visibility" — the other mod items stay', async () => {
    mocks.currentUser = { ...OWNER, isModerator: true };
    renderWithProviders(<AppListingCard card={base({})} canOpenPage />);
    await openCardMenu();
    await expect
      .element(page.getByTestId('apps-listing-owner-visibility'))
      .toHaveTextContent('Visibility');
    // The rest of the moderator section is present, so the absence below is about
    // set-visibility alone and not a missing moderator section.
    await expect.element(page.getByTestId('apps-listing-mod-message-owner')).toBeInTheDocument();
    await expect.element(page.getByTestId('apps-listing-hide-menu-item')).toBeInTheDocument();
    await expect.element(page.getByTestId('apps-listing-unpublish-menu-item')).toBeInTheDocument();
    await expect.element(page.getByTestId('apps-listing-mod-manage')).toBeInTheDocument();
    expect(page.getByTestId('apps-listing-mod-visibility').elements()).toHaveLength(0);
    expect(document.body.textContent).not.toContain('Set visibility');
  });

  test('🔴 the owner picker’s read is OFF until the item is clicked, then loads that listing', async () => {
    mocks.currentUser = OWNER;
    mocks.authoringContext = {
      status: 'approved',
      role: 'owner',
      lastModerationAction: null,
      visibility: 'testers',
      visibilityAvailable: true,
    };
    renderWithProviders(<AppListingCard card={base({})} canOpenPage />);
    await openCardMenu();
    await expect.element(page.getByTestId('apps-listing-owner-visibility')).toBeInTheDocument();
    // Mounted with the menu, but never enabled: opening the menu requests nothing.
    expect(mocks.authoringCalls.length).toBeGreaterThan(0);
    expect(mocks.authoringCalls.every((c) => c.enabled === false)).toBe(true);

    await page.getByTestId('apps-listing-owner-visibility').click();
    // The REAL `ListingVisibilityModal`, fed from the fetched context.
    await expect
      .element(page.getByTestId('apps-listing-owner-visibility-save').first())
      .toBeInTheDocument();
    expect(mocks.authoringCalls.some((c) => c.enabled === true)).toBe(true);
    expect(mocks.authoringCalls.filter((c) => c.enabled).map((c) => c.input)).toContainEqual({
      appListingId: 'l1',
    });
  });

  test('🔴 an INELIGIBLE fetched row gets an explanation, not the picker', async () => {
    // `rejected` carries no settable level (`showVisibility` is false), which no store
    // surface would normally render — the point is that the fetched status decides.
    mocks.currentUser = OWNER;
    mocks.authoringContext = {
      status: 'rejected',
      role: 'owner',
      lastModerationAction: null,
      visibility: null,
      visibilityAvailable: true,
    };
    renderWithProviders(<AppListingCard card={base({})} canOpenPage />);
    await openCardMenu();
    await page.getByTestId('apps-listing-owner-visibility').click();
    await expect
      .element(page.getByTestId('apps-listing-owner-visibility-unavailable').first())
      .toBeInTheDocument();
    expect(
      document.querySelectorAll('[data-testid="apps-listing-owner-visibility-save"]')
    ).toHaveLength(0);
  });

  test('the moderator item opens the moderator picker for this listing', async () => {
    mocks.currentUser = MODERATOR;
    renderWithProviders(<AppListingCard card={base({})} canOpenPage />);
    await openCardMenu();
    await page.getByTestId('apps-listing-mod-visibility').click();
    // The REAL `ModListingVisibilityModal` — its reason field and title.
    await expect
      .element(page.getByTestId('apps-mod-visibility-reason').first())
      .toBeInTheDocument();
    expect(document.body.textContent).toContain('Set visibility for my-app');
  });

  test('🔴 EXACTLY ONE Edit affordance in the accessibility tree', async () => {
    // The pre-change card rendered TWO Edit controls and relied on `display: none`
    // to keep one of them out of the accessibility tree — a property its comment
    // called out and which must survive the move into a menu. It does, more
    // strongly: there is now one node, not two with one hidden.
    mocks.currentUser = OWNER;
    renderWithProviders(<AppListingCard card={base({})} canOpenPage />);
    await openCardMenu();
    await expect.element(page.getByTestId('apps-listing-owner-edit')).toBeInTheDocument();
    // By ACCESSIBLE NAME over the whole document (the dropdown is portalled), not by
    // testid — the claim is about what a screen reader is offered, and a second Edit
    // added without the testid would be invisible to a testid count.
    expect(editAffordances().map((el) => el.getAttribute('data-testid'))).toEqual([
      'apps-listing-owner-edit',
    ]);
  });

  test('🔴 the `⋮` trigger has a real accessible name and does not navigate the card', async () => {
    // Icon-only → the glyph alone is not an accessible name (the
    // `CategoryFilterButtons` precedent), so `aria-label` supplies it and a Tooltip
    // supplies the sighted equivalent.
    //
    // 🔴 THE CARD-CLICK HALF IS THE POINT. Every action on this card stops
    // propagation because the card is a click target, and a Mantine dropdown is
    // PORTALLED — which moves the DOM node but NOT React's event path, so a click
    // inside it still reaches an ancestor's `onClick`. A menu that navigates the
    // card when you open it is the obvious failure of this change.
    // 🔴 AN OWNER WHO IS ALSO A MODERATOR, AND THE COMBINATION IS FORCED BY THE
    // NARROWING RATHER THAN CHOSEN. This test needs two things in one open dropdown:
    // something to prove it opened, and a NON-NAVIGATING item to click, because a
    // click on a `Link` would leave "did the card navigate?" unanswerable. It used to
    // use Edit for the first and `Report` for the second — but the card no longer
    // offers Report to anyone (`surface="card"`), and the only non-navigating items
    // left on this surface are the moderator section's. So: Edit for the open proof,
    // "Contact owner" for the propagation click.
    mocks.currentUser = { ...OWNER, isModerator: true };
    const onCardClick = vi.fn();
    renderWithProviders(
      <div onClick={onCardClick}>
        <AppListingCard card={base({})} canOpenPage />
      </div>
    );
    const trigger = await openCardMenu();
    await expect.element(trigger).toHaveAttribute('aria-label', 'App options');
    // The dropdown opened…
    await expect.element(page.getByTestId('apps-listing-owner-edit')).toBeInTheDocument();
    // …and the click that opened it never reached the card.
    expect(onCardClick).toHaveBeenCalledTimes(0);

    // A click INSIDE the dropdown must not reach it either.
    await page.getByTestId('apps-listing-mod-message-owner').click();
    expect(onCardClick).toHaveBeenCalledTimes(0);
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
    /**
     * 🔴 THE PLAY COUNT — RENDERED ONLY FOR A COUNT OF ONE OR MORE. BOTH
     * `openCount === null` AND `openCount === 0` RENDER NOTHING.
     *
     * 🔴 THAT IS AN OPERATOR OVERRIDE, NOT A DERIVATION — and the two inputs reach
     * the same pixels for DIFFERENT reasons, which is why they get separate tests
     * with separate names rather than one "falsy is absent" case:
     *   · `null` is STRUCTURALLY UNMEASURABLE (an off-site listing's CTA is a
     *     third-party `target="_blank"` anchor; nothing on-platform observes it);
     *   · `0` is MEASURED AND EMPTY (an on-site app nobody has opened yet).
     * Operator, 2026-09-06: "dont show 0 plays (just show nothing)".
     *
     * ⚠️ THE ZERO CASE IS INVERTED FROM ROUND 1 OF THIS PR, which asserted here that
     * an on-site `0` DOES render "0 plays" because a zero is a measurement rather
     * than an absence. That is still true of the DATA — `cardOpenCount`'s "do not
     * over-null" rule is untouched — and was only ever wrong about the SCREEN. Said
     * out loud so the next reader does not read the inversion as a regression.
     *
     * 🔴 EVERY ABSENCE TEST BELOW CARRIES ITS OWN POSITIVE CONTROL **ON THE SAME
     * SELECTOR, IN THE SAME RENDER**, and that is a change forced by this reversal
     * rather than a stylistic choice. With TWO of the three inputs now rendering
     * nothing, `document.querySelector(PLAY_COUNT_SELECTOR) === null` is what a
     * BROKEN SELECTOR looks like as well as what correct behaviour looks like — and
     * the previous version leaned on a sibling test having shown the selector works,
     * which is not a control at all once most fixtures produce nothing. So each
     * absence test renders a `>0` card ALONGSIDE the absent one and proves the
     * selector matches the former before believing the `null` from the latter.
     *
     * 🔴 THE FIXTURES ARE PAIRWISE DISTINCT AND DISTINCT FROM EVERY CONSTANT THESE
     * ASSERTIONS NAME. 4821 is not 0, not 1, not a row/control/gap px value, and
     * abbreviates to a string ("4.8k") that shares no characters-in-order with the
     * raw number — so a mutant that printed the raw value, or that hardcoded any
     * geometry literal, cannot produce it.
     */
    describe('🔴 the play count', () => {
      /** A card with real plays — the positive arm of every pairing below. */
      const BUSY = { name: 'Busy App', slug: 'busy-app', openCount: 4821 };

      /**
       * The one card in `document` whose subtree matches `sel`, or `null`. Used for
       * BOTH presence and absence, so an absence is always read the same way a
       * presence is.
       */
      function cardNamed(title: string): HTMLElement {
        const heading = page.getByText(title, { exact: true }).element() as HTMLElement;
        const card = heading.closest('[class*="Card-root"]') as HTMLElement | null;
        expect(card, `no card root around the title "${title}"`).not.toBeNull();
        return card!;
      }

      test('an on-site listing with plays renders the count beside the rollup', async () => {
        renderWithProviders(<Sized width={314} card={base(BUSY)} />);
        await expect
          .element(page.getByRole('link', { name: 'Open', exact: true }))
          .toBeInTheDocument();
        const play = document.querySelector(PLAY_COUNT_SELECTOR) as HTMLElement | null;
        expect(play, 'the play count did not render for a listing with plays').not.toBeNull();
        expect(play!.textContent).toContain('4.8k plays');
        // BESIDE the rollup, i.e. on the SAME line — not a second line, which would
        // make the card taller than the skeleton reserves.
        const rollup = document.querySelector(ROLLUP_SELECTOR) as HTMLElement;
        expect(rollup, 'the rollup did not render').not.toBeNull();
        expect(
          sameLine(rollup, play!),
          'the play count wrapped onto its own line — that makes the card ~17px taller than ' +
            'AppListingCardSkeleton reserves, on every card in the h-full grid row'
        ).toBe(true);
        // …and both sit in the footer.
        expect(
          play!.closest('[data-testid="apps-listing-card-footer"]'),
          'the play count is not in the footer'
        ).not.toBeNull();
      });

      test('🔴 openCount 0 (MEASURED AND EMPTY) renders NO play count — no "0 plays" chip', async () => {
        // Two cards in ONE render: the control and the case. `Sized` takes a single
        // card, so they are laid out side by side here.
        renderWithProviders(
          <div style={{ display: 'flex', width: 640, alignItems: 'flex-start' }}>
            <div style={{ width: 314 }}>
              <AppListingCard card={base(BUSY)} canOpenPage />
            </div>
            <div style={{ width: 314 }}>
              <AppListingCard
                card={base({ name: 'Quiet App', slug: 'quiet-app', openCount: 0 })}
                canOpenPage
              />
            </div>
          </div>
        );
        await expect.element(page.getByText('Busy App', { exact: true })).toBeInTheDocument();
        await expect.element(page.getByText('Quiet App', { exact: true })).toBeInTheDocument();

        // 🔴 POSITIVE CONTROL, SAME SELECTOR, SAME RENDER, FIRST.
        const busy = cardNamed('Busy App');
        const quiet = cardNamed('Quiet App');
        expect(busy).not.toBe(quiet); // two distinct cards, not one matched twice
        expect(
          busy.querySelector(PLAY_COUNT_SELECTOR),
          'PLAY_COUNT_SELECTOR matched nothing even on a card WITH plays — the absence ' +
            'assertion below would be a fact about the selector, not about openCount 0'
        ).not.toBeNull();

        // THE CLAIM.
        expect(
          quiet.querySelector(PLAY_COUNT_SELECTOR),
          'an on-site listing with openCount 0 rendered a play count. Operator override ' +
            '2026-09-06: "dont show 0 plays (just show nothing)". The likely cause is ' +
            '`getPlayCountLabel` guarding on `openCount == null` alone again.'
        ).toBeNull();
        // …and not as bare text either, which a node stripped of its testid would be.
        expect(
          quiet.textContent,
          'the zero card prints a play count without its testid'
        ).not.toContain('play');
        // Exactly one in the document: the control's. Not zero (which would satisfy
        // the absence vacuously) and not two.
        expect(document.querySelectorAll(PLAY_COUNT_SELECTOR)).toHaveLength(1);
      });

      test('🔴 openCount null (UNMEASURABLE — off-site) renders NO play count either', async () => {
        renderWithProviders(
          <div style={{ display: 'flex', width: 640, alignItems: 'flex-start' }}>
            <div style={{ width: 314 }}>
              <AppListingCard card={base(BUSY)} canOpenPage />
            </div>
            <div style={{ width: 314 }}>
              <AppListingCard
                card={base({
                  name: 'Away App',
                  slug: 'away-app',
                  kind: 'offsite',
                  openCount: null,
                  kindData: { kind: 'offsite', externalUrl: 'https://ext.app' },
                })}
              />
            </div>
          </div>
        );
        await expect.element(page.getByText('Busy App', { exact: true })).toBeInTheDocument();
        await expect.element(page.getByText('Away App', { exact: true })).toBeInTheDocument();

        // 🔴 POSITIVE CONTROL, SAME SELECTOR, SAME RENDER, FIRST.
        const busy = cardNamed('Busy App');
        const away = cardNamed('Away App');
        expect(busy).not.toBe(away);
        expect(
          busy.querySelector(PLAY_COUNT_SELECTOR),
          'PLAY_COUNT_SELECTOR matched nothing even on a card WITH plays — the absence ' +
            'assertion below would be a fact about the selector, not about openCount null'
        ).not.toBeNull();

        // THE CLAIM.
        expect(
          away.querySelector(PLAY_COUNT_SELECTOR),
          'an off-site listing rendered a play count. `openCount === null` means the number ' +
            'is STRUCTURALLY UNMEASURABLE (no on-platform request follows a third-party CTA), ' +
            'so there is nothing honest to print — this is a DIFFERENT reason from the zero ' +
            'case, with the same rendering.'
        ).toBeNull();
        expect(
          away.textContent,
          'the off-site card prints a play count without its testid'
        ).not.toContain('play');
        expect(document.querySelectorAll(PLAY_COUNT_SELECTOR)).toHaveLength(1);

        // 🔴 AND THE STATS LINE ITSELF IS STILL THERE on the absent card — the rollup
        // half is unconditional. Without this, "no play count" would also be
        // satisfied by a card that rendered no stats line at all, which would be a
        // height regression against the skeleton rather than the behaviour under test.
        expect(
          away.querySelector(ROLLUP_SELECTOR),
          'the off-site card rendered no stats line at all — that is shorter than its ' +
            'skeleton reserves, not "the play count is omitted"'
        ).not.toBeNull();
      });
    });

    /**
     * The rollup line is unconditional — a card with no reviews still gets it.
     * Dropping it would make card height depend on review state inside an `h-full`
     * grid row, which is the same misalignment the reserved title lines fix.
     */
    test('🔴 a card with no reviews still renders the rollup line', async () => {
      renderWithProviders(<Sized width={314} card={base({})} />);
      // Same reason as above: barrier on the unique CTA, so the COUNT below is what
      // fails when the rollup is rendered twice.
      await expect
        .element(page.getByRole('link', { name: 'Open', exact: true }))
        .toBeInTheDocument();
      expect(document.querySelectorAll(ROLLUP_SELECTOR)).toHaveLength(1);
      expect(document.body.textContent).toContain('No reviews yet');
    });
  });

  /**
   * 🔴 THE RETIRED LONG-USERNAME TOOLTIP TEST, DELETED WITH ITS SUBJECT.
   *
   * A test here rendered a card at 200px with a 76-character creator username and
   * proved the author chip's `TruncatedText` revealed the full value in a portalled
   * Tooltip on hover — the overflow-GATED behaviour (a runtime
   * scrollWidth/scrollHeight measurement, so the tooltip stays disabled unless the
   * label really clips).
   *
   * The card renders no author chip, so there is nothing to clip and nothing to
   * reveal. The `TruncatedText` component is untouched and is STILL exercised on
   * this card by the TITLE's own tooltip test above ("a clamped title reveals its
   * full value in a tooltip on hover"), so deleting this one loses no coverage of
   * that component's overflow gate — it loses coverage of a chip that no longer
   * exists.
   */
});

/**
 * The author-declared BETA badge.
 *
 * 🔴 EVERY ABSENCE ASSERTION HERE READS `textContent`, NEVER
 * `expect.element(...).not.toBeInTheDocument()`. That matcher is INERT in this repo
 * (civitai/civitai#4197) — it passes whether or not the element is there — so an
 * absence written that way proves nothing. Each absence is also paired with a POSITIVE
 * CONTROL from the same fixture proving the card rendered at all, so "no Beta" can
 * never be satisfied by a card that rendered nothing.
 */
/**
 * Card A (design pass of 2026-10-27): the icon straddles the cover, the title and Open sit on
 * the ICON's centre line, the whole card is one link, and a footer row holds the stats on the
 * left and the creator on the right.
 *
 * Every measurement is a RELATIONSHIP between boxes (centres, edges, a shared y across cards),
 * not a style read, and each is taken against the real stylesheet.
 */
describe('AppListingCard — card A layout', () => {
  const rect = (el: Element) => el.getBoundingClientRect();
  const midY = (el: Element) => rect(el).top + rect(el).height / 2;
  const testId = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement;
  const coverBox = () =>
    Array.from(document.querySelectorAll<HTMLElement>('div')).find(
      (d) => d.style.aspectRatio.replace(/\s/g, '') === '16/9'
    )!;

  async function renderCard(over: Partial<ListingCard> = {}, width = 320) {
    renderWithProviders(
      <Sized width={width} card={base({ iconUrl: LOADABLE_IMAGE_DATA_URI, ...over })} />
    );
    await expect.element(page.getByRole('link', { name: 'Open', exact: true })).toBeInTheDocument();
    const header = testId('apps-listing-card-header');
    // Guard on the guard: with no stylesheet the header is not a flex row and every number
    // below is vacuous.
    expect(getComputedStyle(header).display, 'Mantine stylesheet did not apply').toBe('flex');
    return header;
  }

  test('🔴 the icon, the title and Open share ONE centre line', async () => {
    const header = await renderCard();
    const icon = header.firstElementChild as HTMLElement;
    const title = page.getByText('My App', { exact: true }).element();
    const open = page.getByRole('link', { name: 'Open', exact: true }).element();
    expect(rect(icon).height).toBe(56);
    expect(Math.abs(midY(title) - midY(icon)), 'title is off the icon centre').toBeLessThanOrEqual(
      1
    );
    expect(Math.abs(midY(open) - midY(icon)), 'Open is off the icon centre').toBeLessThanOrEqual(1);
    // Open is on the TITLE's row, to its right, not under it.
    expect(rect(open).left).toBeGreaterThanOrEqual(rect(title).right);
  });

  test('🔴 the icon straddles the cover edge: 14px over, the rest below', async () => {
    const header = await renderCard();
    const icon = header.firstElementChild as HTMLElement;
    expect(coverBox(), 'no 16:9 cover box').toBeDefined();
    expect(Math.abs(rect(icon).top - (rect(coverBox()).bottom - 14))).toBeLessThanOrEqual(1);
  });

  test('🔴 the title is ONE line even when far too long, and clips instead of wrapping', async () => {
    const name = 'An extraordinarily long application name that cannot possibly fit on one line';
    await renderCard({ name });
    const title = page.getByText(name, { exact: true }).element() as HTMLElement;
    expect(rect(title).height, 'title wrapped').toBeLessThanOrEqual(25);
    expect(title.scrollWidth).toBeGreaterThan(title.clientWidth);
  });

  test('🔴 Open is the compact-sm button: 26px tall, still named "Open"', async () => {
    await renderCard();
    const open = page.getByRole('link', { name: 'Open', exact: true }).element();
    expect(rect(open).height).toBe(26);
  });

  test('🔴 the footer is pinned: cards of different content end their footers at the same y', async () => {
    renderWithProviders(
      <div style={{ display: 'flex', alignItems: 'stretch', width: 660, gap: 16 }}>
        <Sized width={320} card={base({ slug: 'a', name: 'Short', tagline: null })} />
        <Sized
          width={320}
          card={base({
            slug: 'b',
            name: 'Tall',
            tagline: 'A tagline long enough to wrap onto several lines in a narrow card. '.repeat(
              3
            ),
          })}
        />
      </div>
    );
    await expect.element(page.getByText('Tall', { exact: true })).toBeInTheDocument();
    const footers = Array.from(
      document.querySelectorAll('[data-testid="apps-listing-card-footer"]')
    );
    expect(footers).toHaveLength(2);
    const cards = footers.map((f) => f.closest('.mantine-Card-root') as HTMLElement);
    // Control: the cards are the same height (stretched), but their CONTENT differs, so the
    // footer only lines up if it is bottom-pinned.
    expect(rect(cards[0]).height).toBe(rect(cards[1]).height);
    expect(
      document.body.textContent,
      'control: the tall card must actually carry its tagline'
    ).toContain('A tagline long enough');
    expect(Math.abs(rect(footers[0]).top - rect(footers[1]).top)).toBeLessThanOrEqual(1);
  });

  test('🔴 the creator is right-aligned in the footer, the stats on the left', async () => {
    await renderCard();
    const footer = testId('apps-listing-card-footer');
    const creator = testId('apps-listing-card-creator');
    const stats = testId('apps-listing-card-stats');
    expect(creator.textContent).toBe('alice');
    expect(Math.abs(rect(creator).right - rect(footer).right)).toBeLessThanOrEqual(1);
    expect(Math.abs(rect(stats).left - rect(footer).left)).toBeLessThanOrEqual(1);
    expect(rect(creator).left).toBeGreaterThan(rect(stats).right);
  });

  test('🔴 hit-test: the card body is the title link; Open and the creator stay clickable above it', async () => {
    await renderCard();
    const center = (el: Element) => {
      const r = rect(el);
      return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    };
    const card = document.querySelector('.mantine-Card-root') as HTMLElement;
    const c = rect(card);
    const body = document.elementFromPoint(c.left + c.width / 2, c.top + c.height * 0.75);
    expect(
      body?.closest('a')?.getAttribute('href'),
      'a click in the card body does not reach the detail link'
    ).toContain('my-app');
    const openHit = center(page.getByRole('link', { name: 'Open', exact: true }).element());
    expect(openHit?.closest('a')?.textContent).toBe('Open');
    expect(center(testId('apps-listing-card-creator'))?.closest('a')?.getAttribute('href')).toBe(
      '/user/alice'
    );
  });

  test('🔴 the ⋮ menu sits inside the cover top-right, for the owner', async () => {
    mocks.currentUser = OWNER;
    await renderCard();
    const trigger = page.getByTestId('apps-listing-card-actions-menu').element();
    const cover = rect(coverBox());
    const t = rect(trigger);
    expect(t.right).toBeLessThanOrEqual(cover.right);
    expect(cover.right - t.right).toBeLessThan(16);
    expect(t.top - cover.top).toBeLessThan(16);
    expect(t.bottom).toBeLessThanOrEqual(cover.bottom);
    // Hit-test: the trigger, not the stretched card link, owns its own point.
    const hit = document.elementFromPoint(t.left + t.width / 2, t.top + t.height / 2);
    expect(trigger.contains(hit)).toBe(true);
  });
});

describe('AppListingCard — the beta badge', () => {
  test('renders a Beta badge when the listing declares beta', async () => {
    renderWithProviders(<AppListingCard card={base({ isBeta: true })} canOpenPage />);
    await expect.element(page.getByTestId('apps-listing-card-beta')).toBeInTheDocument();
    expect(document.body.textContent).toContain('Beta');
  });

  test('renders NO Beta badge when the listing does not declare beta', async () => {
    renderWithProviders(<AppListingCard card={base({ isBeta: false })} canOpenPage />);
    // Positive control FIRST: the card really did render.
    await expect.element(page.getByText('My App')).toBeInTheDocument();
    // Then the absence, read off the text rather than through the inert matcher.
    expect(document.body.textContent).not.toContain('Beta');
    expect(document.querySelector('[data-testid="apps-listing-card-beta"]')).toBeNull();
  });

  test('🔴 the card carries the BADGE only — never the free-text note', async () => {
    // The note is DETAIL-ONLY by decision (`ListingCard` has no `betaMessage` key at all).
    // A card is a low-attention surface; unreviewed author prose belongs where there is
    // room to read it. Written as a test because a future widening of the card DTO would
    // otherwise be invisible here.
    const card = base({ isBeta: true }) as Record<string, unknown>;
    card.betaMessage = 'this must never render on a card';
    renderWithProviders(<AppListingCard card={card as never} canOpenPage />);
    await expect.element(page.getByTestId('apps-listing-card-beta')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('this must never render on a card');
  });
});

/**
 * The RESTRICTED-VISIBILITY badge ("Testers only" / "Moderators only" / "Unlisted").
 *
 * The label/tooltip decisions are pinned in the BLOCKING unit tier
 * (`__tests__/listingVisibilityCopy.test.ts` → `visibilityBadgeFor`); this suite pins only
 * that the card renders what that function returns, where, and that it does not add a
 * stacked row to the meta block. Absences are read off `querySelector` / `textContent`
 * (the `.not.toBeInTheDocument()` matcher is inert here — civitai/civitai#4197), each
 * after a positive control.
 */
describe('AppListingCard — the restricted-visibility badge', () => {
  test.each([
    ['testers', 'Testers only'],
    ['moderators', 'Moderators only'],
    ['private', 'Unlisted'],
  ] as const)('restrictedAudience=%s renders "%s"', async (restrictedAudience, label) => {
    renderWithProviders(<AppListingCard card={base({ restrictedAudience })} canOpenPage />);
    const badge = page.getByTestId('apps-listing-card-visibility');
    await expect.element(badge).toBeInTheDocument();
    expect(badge.element().textContent).toBe(label);
  });

  test('renders NO badge when restrictedAudience is null', async () => {
    renderWithProviders(<AppListingCard card={base({ restrictedAudience: null })} canOpenPage />);
    await expect.element(page.getByText('My App')).toBeInTheDocument();
    expect(document.querySelector('[data-testid="apps-listing-card-visibility"]')).toBeNull();
    for (const label of ['Testers only', 'Moderators only', 'Unlisted']) {
      expect(document.body.textContent).not.toContain(label);
    }
  });

  test('🔴 shares ONE line with the Beta badge — the meta block grows no stacked row', async () => {
    renderWithProviders(
      <Sized width={494} card={base({ isBeta: true, restrictedAudience: 'testers' })} />
    );
    const beta = page.getByTestId('apps-listing-card-beta');
    const vis = page.getByTestId('apps-listing-card-visibility');
    await expect.element(beta).toBeInTheDocument();
    await expect.element(vis).toBeInTheDocument();
    // Same wrapping row element, and the same visual line at a width with room for both.
    const row = page.getByTestId('apps-listing-card-badges').element();
    expect(beta.element().closest('[data-testid="apps-listing-card-badges"]')).toBe(row);
    expect(vis.element().closest('[data-testid="apps-listing-card-badges"]')).toBe(row);
    expect(sameLine(beta.element(), vis.element()), 'Beta and the visibility badge wrapped').toBe(
      true
    );
  });

  test('🔴 adding the visibility badge beside Beta does not move the TAGLINE', async () => {
    // The relationship the title reservation protects is "the tagline sits at one y". A
    // second badge stacked as its own row would push it down by a badge height; in the
    // shared row it must not move at all.
    renderWithProviders(
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
        <Sized width={494} card={base({ slug: 'one', name: 'One', isBeta: true })} />
        <Sized
          width={494}
          card={base({ slug: 'two', name: 'Two', isBeta: true, restrictedAudience: 'moderators' })}
        />
      </div>
    );
    await expect.element(page.getByTestId('apps-listing-card-visibility')).toBeInTheDocument();
    const taglines = Array.from(document.querySelectorAll('p, div')).filter(
      (el) => el.children.length === 0 && el.textContent === 'A handy app'
    );
    expect(taglines, 'expected one tagline per card').toHaveLength(2);
    const [a, b] = taglines.map((el) => el.getBoundingClientRect().top);
    expect(Math.abs(a - b), 'the visibility badge pushed the tagline down').toBeLessThan(1);
  });
});
