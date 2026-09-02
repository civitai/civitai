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
import {
  LISTING_ACTIONS_WIDEST_PX,
  LISTING_ACTION_ROW_GAP_PX,
  LISTING_ROLLUP_HIDE_BELOW_PX,
  LISTING_ROLLUP_MIN_WIDTH_PX,
} from '~/components/Apps/appListingCardView';
import type { ListingCard } from '~/server/schema/blocks/app-listing-read.schema';

/**
 * P2b AppListingCard component tests (REPORT-ONLY — the browser project is
 * non-blocking; the blocking gate is appListingCardView.test.ts). These pin the
 * rendered kind badge, recommend label, and kind-aware CTA affordance for a few
 * representative cards, PLUS the owner "Edit" deep-link gating (Item 2) and the
 * long-username tooltip fallback (Item 1).
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
 * The card itself makes no request. The shared `AppListingActionsMenu` mounts its four
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
    },
    useUtils: () => ({
      appListings: {
        getMyReview: { invalidate: async () => undefined },
        listReviews: { invalidate: async () => undefined },
        getAppDetail: { invalidate: async () => undefined },
      },
    }),
  },
}));

// Import AFTER the mock is declared (vi.mock is hoisted, imports are not).
const { AppListingCard } = await import('./AppListingCard');

beforeEach(() => {
  mocks.currentUser = null;
  mocks.features = { appBlocks: true, appListings: true, appBlocksPages: false };
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
          kindData: { kind: 'offsite', externalUrl: 'https://ext.app' },
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
    mocks.currentUser = OWNER; // → the `⋮` menu, i.e. the widest action set
    renderWithProviders(<AppListingCard card={base({})} canOpenPage />);
    await expect.element(page.getByTestId('apps-listing-card-actions-menu')).toBeInTheDocument();

    const trigger = page.getByTestId('apps-listing-card-actions-menu').element() as HTMLElement;
    // The group holding the primary CTA + the `⋮` trigger. The trigger sits inside a
    // `flexShrink: 0` Box the shared menu renders, so climb one more level.
    const actions = trigger.parentElement!.parentElement as HTMLElement;
    expect(actions.style.getPropertyValue('--group-wrap')).toBe('nowrap');
    // The actions are the rigid side: they never shrink…
    expect(actions.style.flexShrink).toBe('0');
    // …but they DO grow, which is what lets the CTA fill the row (S7).
    expect(actions.style.flexGrow).toBe('1');
    // …and the row itself never wraps, so the actions can't jump to the left.
    const row = actions.parentElement as HTMLElement;
    expect(row.style.getPropertyValue('--group-wrap')).toBe('nowrap');
    // 🔴 The recommend rollup is the flexible side — DOWN TO A FLOOR. It used to
    // carry `minWidth: 0` ("shrink to nothing"); that is exactly what a growing CTA
    // would exploit, so the floor is now a constraint the layout engine enforces.
    const rollup = row.firstElementChild as HTMLElement;
    expect(rollup).not.toBe(actions);
    expect(rollup.style.minWidth).toBe(`${LISTING_ROLLUP_MIN_WIDTH_PX}px`);
  });

  test('🔴 the `⋮` trigger is 36px — the row-height contract', async () => {
    // The row is `pt="xs"` (10px) + a 36px control = 46px, and it lives in an
    // `h-full` grid row, so a taller control here grows every card in that row
    // across the store. The trigger must therefore match the `sm` CTA button
    // exactly. (The control it replaced — the icon-only Edit — was also 36.)
    mocks.currentUser = OWNER;
    renderWithProviders(<Sized width={314} card={base({})} />);
    await expect.element(page.getByTestId('apps-listing-card-actions-menu')).toBeInTheDocument();
    const trigger = page.getByTestId('apps-listing-card-actions-menu').element() as HTMLElement;
    const box = trigger.getBoundingClientRect();
    expect(Math.round(box.width)).toBe(36);
    expect(Math.round(box.height)).toBe(36);
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
     * 🔴 THE ACTION-ROW GEOMETRY, RE-MEASURED ON THIS BRANCH.
     *
     * A 280px card is what a **1200px viewport** produces at the store's 4-column
     * `xl` grid — the narrowest geometry the store can actually produce, and a
     * very common laptop width.
     *
     * Every number below was taken from a real render in this environment, with
     * the app's real stylesheet cascade, at the widths named. It is NOT the
     * pre-change table carried forward. Card with a `⋮` menu, widest CTA ("View
     * details"), no reviews — the SHORTEST label the rollup can carry, so a
     * deficit here is structural rather than an artefact of a long string:
     *
     * 🔴 WHICH VIEWERS EACH TABLE DESCRIBES — the numbers did not move when the card
     * stopped offering Review/Report, but the POPULATIONS did, and a table whose
     * caption is wrong is the kind of prose that gets cited instead of re-measured.
     * "With a menu" is now exactly {owner, moderator}; "with no menu" is EVERY other
     * viewer, signed in or signed out. Before `surface="card"` the split was
     * {owner, moderator, any signed-in viewer} against {signed-out} alone.
     *
     *   | card | container | actions nat/rendered | rollup | row h | rollup    |
     *   |------|-----------|----------------------|--------|-------|-----------|
     *   |  280 |       248 | 184 /  248 (grown)   |    0   |    46 | HIDDEN    |
     *   |  296 |       264 | 184 /  184           |   70.1 |    46 | at FLOOR  |
     *   |  314 |       282 | 184 /  184           |   88.1 |    46 | clamped   |
     *   |  494 |       462 | 184 /  356.3 (grown) |   95.7 |    46 | natural   |
     *
     * and the same widths with NO menu — a signed-OUT viewer OR an ordinary
     * signed-IN one, which is what the byte-unchanged claim below rests on and why
     * that claim is now asserted over both:
     *
     *   | card | container | actions nat/rendered | rollup (reviewed) | row h |
     *   |------|-----------|----------------------|-------------------|-------|
     *   |  280 |       248 | 137.9 / 137.9        |             100.1 |    46 |
     *   |  314 |       282 | 137.9 / 137.9        |             134.1 |    46 |
     *   |  494 |       462 | 137.9 / 312.9        |             139.1 |    46 |
     *
     * TWO THINGS THE TABLES SAY THAT PROSE WOULD NOT:
     *
     *   1. `actions` is now TWO numbers. The CTA grows into the row's free space
     *      (S7), so the cluster's rendered width exceeds its natural width wherever
     *      there is slack. Where the row is in DEFICIT there is no growth and the
     *      two coincide — which is why the two middle rows of the first table, and
     *      the first two rows of the second, are unchanged from before this branch.
     *   2. The 264 row is the threshold doing its job: 70.1px is exactly
     *      `LISTING_ROLLUP_MIN_WIDTH_PX`, and 264 = 184 + 10 + 70 is exactly the
     *      arithmetic `LISTING_ROLLUP_HIDE_BELOW_PX` computes. The model and the
     *      measurement agree to 0.1px, which is why the threshold is stated as
     *      arithmetic rather than as a round number that happened to look right.
     *
     * 🔴 THE FIX IS STILL NOT TO LET THE ROW WRAP. Row height is a constant 46px in
     * every cell above — nowrap + `flexShrink: 0` is what holds it, and the file
     * documents why wrapping breaks alignment and grid-row heights.
     */
    describe("the action row at the store's real container widths", () => {
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
      // The widest CTA ("View details") — the tight cell in the table above. An
      // off-site listing with no external target makes `getListingCta` fall
      // through to the unified detail. Fully typed (`externalUrl` included)
      // rather than cast: the cast was HIDING a missing `externalUrl` and a
      // `subKind: 'oauth-connect'` that was not a member of the sub-kind union
      // at all, and neither `tsc` error reached vitest, which type-strips.
      // (The sub-kind itself is now gone — `externalUrl` is the only off-site
      // card input, so that particular typo has no shape left to take.)
      const OFFSITE_CONNECT = {
        ...REVIEWED,
        kind: 'offsite' as const,
        kindData: {
          kind: 'offsite',
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
          externalUrl: null,
        } satisfies ListingCard['kindData'],
      };

      test('🔴 menu card + "View details" keeps a LEGIBLE recommend rollup', async () => {
        mocks.currentUser = OWNER;
        renderWithProviders(<Sized width={314} card={base(OFFSITE_CONNECT)} />);
        await expect
          .element(page.getByRole('link', { name: 'View details', exact: true }))
          .toBeInTheDocument();

        const { row, rollup } = actionRow('View details');
        assertLayoutIsReal(row);
        expect(Math.round(row.clientWidth)).toBe(282); // 314 - 2x16 padding (no border since S4)

        // 80px is grounded in the measurements above, not invented: the glyph is
        // 13px + a 4px gap, so 80 leaves ~63px of text — enough for "91% recom…"
        // to read as a recommendation figure. Measured here: 88.1.
        expect(rollup.getBoundingClientRect().width).toBeGreaterThanOrEqual(80);
        // …and never below the floor while it is displayed — the property the
        // growing CTA could otherwise take away.
        expect(rollup.getBoundingClientRect().width).toBeGreaterThanOrEqual(
          LISTING_ROLLUP_MIN_WIDTH_PX
        );

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
       * Below the 264px threshold the rollup is HIDDEN rather than crushed, and the
       * actions keep the right edge. A stub is strictly worse than nothing: it holds
       * the slot, reads as a rendering bug, and communicates nothing.
       *
       * Re-measured on THIS branch (menu card, widest CTA, no reviews):
       *   container 248 -> rollup 0    (hidden by the query)
       *   container 264 -> rollup 70.1 (AT the floor)
       *   container 266 -> rollup 72.1
       *   container 282 -> rollup 88.1
       *   container 462 -> rollup 95.7 (natural; the CTA takes the other 260)
       */
      test('🔴 at the REAL 1200 geometry a menu card DROPS the rollup instead of crushing it', async () => {
        mocks.currentUser = OWNER;
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
      test('⚠️ INVARIANT: just ABOVE the 264px threshold the rollup is back and legible', async () => {
        mocks.currentUser = OWNER;
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
       * 🔴 THE THRESHOLD IS EXACTLY WHERE THE FLOOR FIRST FITS — the assertion the
       * arithmetic makes, checked at the arithmetic's own boundary rather than
       * somewhere comfortably inside the band.
       *
       * `LISTING_ROLLUP_HIDE_BELOW_PX` = actions(184) + gap(10) + floor(70) = 264. At
       * a 264px container the rollup must therefore be present and measure EXACTLY
       * the floor: one pixel of slack anywhere in that sum and it would be more, one
       * pixel of deficit and the query would have hidden it. Measured: 70.1.
       *
       * This is the case an off-by-a-few threshold survives everywhere else — 282 is
       * 18px inside the band and 248 is 16px outside it, so both stay green against a
       * threshold of, say, 250 or 276.
       *
       * ⚠️ INVARIANT GUARD, NOT regression coverage for THIS change: measured, it
       * passes on pre-change code too, because at a 264px container the available
       * space happens to equal the floor whether or not a floor is enforced. It is
       * regression coverage for the THRESHOLD — move 264 and it goes red — and the
       * clamp itself is pinned by the menu-less test above, which is the only width
       * at which the two differ.
       */
      test('🔴 AT the threshold the rollup is present and sits exactly on its floor', async () => {
        mocks.currentUser = OWNER;
        // 296 outer - 2x16 padding = a 264px container, i.e. the threshold itself.
        renderWithProviders(<Sized width={296} card={base(OFFSITE_CONNECT_NO_REVIEWS)} />);
        await expect
          .element(page.getByRole('link', { name: 'View details', exact: true }))
          .toBeInTheDocument();
        const { row, rollup, actions } = actionRow('View details');
        assertLayoutIsReal(row);
        expect(Math.round(row.clientWidth)).toBe(LISTING_ROLLUP_HIDE_BELOW_PX);
        expect(getComputedStyle(rollup).display).toBe('flex');
        // Exactly the floor, to sub-pixel: 70.1 measured against a 70 constant.
        expect(rollup.getBoundingClientRect().width).toBeCloseTo(LISTING_ROLLUP_MIN_WIDTH_PX, 0);
        // …and the other two terms of the sum are what the constants say they are, so
        // a green result here cannot be three compensating errors.
        expect(actions.getBoundingClientRect().width).toBeCloseTo(LISTING_ACTIONS_WIDEST_PX, 0);
        expect(getComputedStyle(row).columnGap).toBe(`${LISTING_ACTION_ROW_GAP_PX}px`);
        expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth + 1);
      });

      /**
       * 🔴 THE ROLLUP IS NEVER SQUEEZED BELOW ITS FLOOR WHILE DISPLAYED — swept, not
       * spot-checked, because the failure this guards is width-dependent by nature.
       *
       * 248 is included deliberately: there the rollup is HIDDEN, and a floor claim
       * must not be satisfied by a zero. The sweep therefore asserts the disjunction
       * (hidden, or >= floor) and separately asserts that at least one width in the
       * sweep is on each side of it — a positive control against a sweep that
       * silently tests only one arm.
       */
      /**
       * 🔴 THE ONE PLACE THE FLOOR IS OBSERVABLE — and finding it is the difference
       * between a guard and a decoration.
       *
       * MEASURED, and it is the uncomfortable result: at every container width the
       * store can produce, `minWidth: 70` changes NOTHING. The rollup only shrinks
       * under deficit, and a deficit deep enough to push it under 70 arrives at
       * exactly the width where the container query hides it — so on a card WITH a
       * menu the clamp and the query bite at the same point by construction. Every
       * other floor assertion in this file therefore passes on pre-change code too;
       * they are INVARIANT guards, and they say so.
       *
       * The clamp is observable on a card with NO menu, which carries no container
       * query at all (see the action row's `hasMenu` gate). Its cluster is 137.9, so
       * it needs 137.9 + 10 + 70 = 218px of container to hold both. Below that:
       *   pre-change  → the rollup shrinks freely; at a 168px container it measures
       *                 168 − 10 − 137.9 ≈ 20, a stub of two or three characters;
       *   post-change → it stops at 70 and the ROW overflows instead (scrollWidth
       *                 218 vs clientWidth 168).
       *
       * 🔴 THE OVERFLOW IS THE ACCEPTED COST, ASSERTED RATHER THAN HIDDEN. Trading a
       * meaningless 20px stub for an overflow is only defensible because no store
       * surface goes below 218: the 4-column `lg` grid bottoms out at 248, `base` is
       * one wide column, and the moderator preview card is capped at 340 (308
       * content). The width used here is a synthetic one no user reaches, chosen
       * because it is the only width at which the constraint is visible at all.
       */
      test('🔴 the floor CLAMPS a menu-less rollup that would otherwise be a stub', async () => {
        mocks.currentUser = null; // no menu → no container query → the clamp is the only guard
        renderWithProviders(<Sized width={200} card={base(OFFSITE_CONNECT_NO_REVIEWS)} />);
        await expect
          .element(page.getByRole('link', { name: 'View details', exact: true }))
          .toBeInTheDocument();
        const { row, rollup } = actionRow('View details');
        assertLayoutIsReal(row);
        expect(Math.round(row.clientWidth)).toBe(168);
        // No menu here — otherwise the query, not the clamp, would be what we measured.
        expect(page.getByTestId('apps-listing-card-actions-menu').elements()).toHaveLength(0);
        expect(getComputedStyle(rollup).display).toBe('flex');
        // 🔴 THE DISCRIMINATOR. Pre-change this measures ~20; the clamp holds it at 70.
        expect(rollup.getBoundingClientRect().width).toBeCloseTo(LISTING_ROLLUP_MIN_WIDTH_PX, 0);
        // …and the declared consequence, so nobody discovers it from a screenshot.
        expect(row.scrollWidth).toBeGreaterThan(row.clientWidth);
        expect(Math.round(row.getBoundingClientRect().height)).toBe(46);
      });

      /**
       * 🔴 THE FLOOR SWEEP — one test PER WIDTH, deliberately, not a loop with
       * `unmount()` between renders. This file already learned that the hard way:
       * `.unmount()` fights the scaffold's global `afterEach(cleanup)` over the
       * shared container and leaves EVERY subsequent test in the file rendering into
       * an empty body. Separate tests also let each width fail independently instead
       * of the first short-circuiting the rest.
       *
       * ⚠️ INVARIANT GUARD on the floor half — see the menu-less test above for why
       * a card WITH a menu cannot distinguish "clamped at 70" from "70 is all there
       * was". What it does pin as regression coverage is the hidden/displayed
       * BOUNDARY and the 46px row height at every width.
       */
      describe('🔴 displayed ⇒ at or above the floor, swept across store widths', () => {
        // 280 is the one width where the rollup is HIDDEN. It is in the sweep on
        // purpose: a floor claim must not be satisfiable by a zero, so that arm
        // asserts the zero explicitly and the others assert the floor.
        const HIDDEN_AT = 280;
        for (const width of [280, 296, 298, 314, 494]) {
          test(`@${width} (container ${width - 32})`, async () => {
            mocks.currentUser = OWNER;
            renderWithProviders(<Sized width={width} card={base(OFFSITE_CONNECT_NO_REVIEWS)} />);
            await expect
              .element(page.getByRole('link', { name: 'View details', exact: true }))
              .toBeInTheDocument();
            const { row, rollup } = actionRow('View details');
            assertLayoutIsReal(row);
            expect(Math.round(row.clientWidth)).toBe(width - 32);
            if (width === HIDDEN_AT) {
              expect(getComputedStyle(rollup).display).toBe('none');
              expect(rollup.getBoundingClientRect().width).toBe(0);
            } else {
              expect(getComputedStyle(rollup).display).toBe('flex');
              expect(rollup.getBoundingClientRect().width).toBeGreaterThanOrEqual(
                LISTING_ROLLUP_MIN_WIDTH_PX - 0.5
              );
            }
            // Row height is the other invariant every width has to hold.
            expect(Math.round(row.getBoundingClientRect().height)).toBe(46);
          });
        }
      });

      /**
       * 🔴 THE MENU-LESS VIEWERS, MEASURED FROM ONE ASSERTION BODY — AND THAT SHAPE
       * IS THE FIX, NOT A TIDY-UP.
       *
       * This used to be two tests making two different claims: a SIGNED-OUT arm
       * asserting the full rollup survives at the store's tightest real geometry, and
       * a SIGNED-IN arm asserting the opposite, because `useCanReportListing` is
       * `!!useCurrentUser()` and every signed-in shopper therefore got a `⋮`. With
       * `surface="card"` the viewer actions are gone from this surface, so the two
       * viewers are now the SAME case — and "the same" is a claim about a
       * RELATIONSHIP, which two independently-written tests cannot make. Two literal
       * tables drift; one body run twice cannot.
       *
       * 🔴 THE POPULATION THIS COVERS IS EVERY VIEWER EXCEPT {owner, moderator}. That
       * is the whole point of running it over both: a narrowing implemented as "hide
       * the menu when signed out" rather than "do not offer these items on the card"
       * passes the signed-out arm and fails the signed-in one.
       *
       * ⚠️ STILL AN INVARIANT GUARD ON THE SIGNED-OUT ARM — that card measured 95.7px
       * before this whole branch and measures 95.7px after. The SIGNED-IN arm is
       * genuine regression coverage: it is red on `5a6d111a19`.
       */
      describe('🔴 a menu-less viewer keeps the full rollup at the 1200 geometry', () => {
        // One test per viewer rather than a loop with `unmount()` — same reason as
        // the floor sweep above.
        for (const [label, user] of [
          ['signed-out', null],
          ['signed-in non-owner, non-moderator', SHOPPER],
        ] as const) {
          test(`${label}`, async () => {
            mocks.currentUser = user;
            renderWithProviders(<Sized width={280} card={base(OFFSITE_CONNECT_NO_REVIEWS)} />);
            await expect
              .element(page.getByRole('link', { name: 'View details', exact: true }))
              .toBeInTheDocument();
            const { row, actions, rollup } = actionRow('View details');
            assertLayoutIsReal(row);
            expect(Math.round(row.clientWidth)).toBe(248);
            // No trigger is what makes everything below true.
            expect(page.getByTestId('apps-listing-card-actions-menu').elements()).toHaveLength(0);
            expect(getComputedStyle(rollup).display).toBe('flex');
            // Literal pin from the measured table: 95.7px, i.e. the full natural
            // width, because a menu-less action set is 137.9px rather than 184px.
            expect(rollup.getBoundingClientRect().width).toBeGreaterThanOrEqual(95);
            const text = rollup.querySelector('[data-truncate]') as HTMLElement;
            expect(text.scrollWidth).toBeLessThanOrEqual(text.clientWidth);
            // 🔴 AND THE CLUSTER, BOUNDED RATHER THAN PINNED, BECAUSE THIS WIDTH IS
            // NOT IN DEFICIT. 137.9 + 10 + 95.7 = 243.6 against a 248px row, so there
            // are ~4px of slack for the CTA to grow into and the cluster's rendered
            // width is legitimately a little over its 137.9 natural. What the bound
            // excludes is the state the signed-in card was actually in before the
            // narrowing — a cluster grown to the full 248 with the rollup gone. The
            // exact 138 pin lives in the deficit-width test below, where growth is
            // structurally impossible.
            expect(actions.getBoundingClientRect().width).toBeLessThan(160);
            expect(Math.round(row.getBoundingClientRect().height)).toBe(46);
          });
        }
      });

      test('a menu card + "Open" (the narrower CTA) also keeps the rollup legible', async () => {
        mocks.currentUser = OWNER;
        renderWithProviders(<Sized width={314} card={base(REVIEWED)} />);
        await expect
          .element(page.getByRole('link', { name: 'Open', exact: true }))
          .toBeInTheDocument();
        const { row, rollup } = actionRow('Open');
        assertLayoutIsReal(row);
        expect(rollup.getBoundingClientRect().width).toBeGreaterThanOrEqual(80);
      });

      /**
       * 🔴 THE 138 PIN — AND THE REASON IT IS NOW RUN OVER TWO VIEWERS.
       *
       * This is the guard that was supposed to say "a shopper's action row did not
       * move", and for one branch it did not say that at all: it ran SIGNED-OUT only,
       * and a signed-out viewer had no menu before the change and none after, so the
       * assertion was structurally incapable of seeing the 137.9 → 184 shift that had
       * just landed on every SIGNED-IN shopper. It stayed green through exactly the
       * regression it reads as covering. A guard that cannot reach its own case is
       * worse than no guard, because it stops anyone looking.
       *
       * The repair is not a second copy of the numbers — that reproduces the same
       * failure one viewer over. It is the SAME body, run over both viewers, so the
       * claim being made is "these two measure identically" rather than two
       * independent claims that happen to be written with the same literals.
       *
       * 🔴 IT SURVIVES `flex-grow` ONLY BECAUSE THIS WIDTH IS IN DEFICIT, which is
       * worth stating rather than being quietly lucky about: at 282 the reviewed
       * rollup's natural 139.1 + 10 + 137.9 = 287 exceeds the row, so there is no
       * free space for the CTA to grow into and the cluster stays at its natural
       * 137.9. That is what makes an EXACT pin honest here. The same card at 462
       * measures 312.9 — the CTA filling the slack, which is the S7 change and NOT a
       * regression.
       */
      describe('🔴 a menu-less card is byte-unchanged — no menu, actions exactly 138', () => {
        for (const [label, user] of [
          ['signed-out', null],
          ['signed-in non-owner, non-moderator', SHOPPER],
        ] as const) {
          test(`${label}`, async () => {
            mocks.currentUser = user;
            renderWithProviders(<Sized width={314} card={base(OFFSITE_CONNECT)} />);
            await expect
              .element(page.getByRole('link', { name: 'View details', exact: true }))
              .toBeInTheDocument();
            const { row, actions, rollup } = actionRow('View details');
            assertLayoutIsReal(row);
            expect(page.getByTestId('apps-listing-owner-edit').elements()).toHaveLength(0);
            expect(page.getByTestId('apps-listing-card-actions-menu').elements()).toHaveLength(0);
            // Measured pre-change values, pinned so a menu-side change cannot leak.
            expect(Math.round(actions.getBoundingClientRect().width)).toBe(138);
            expect(rollup.getBoundingClientRect().width).toBeGreaterThanOrEqual(130);
            expect(Math.round(row.getBoundingClientRect().height)).toBe(46);
          });
        }
      });

      /**
       * 🔴 THE CTA FILLS THE ROW — the S7 change itself, asserted where there IS free
       * space, since the byte-unchanged test above deliberately sits where there is
       * none.
       *
       * Pre-change the CTA was at its natural 137.9px at every width and the row's
       * slack was simply empty. Measured on this branch at a 462px container: the
       * anonymous card's cluster is 312.9 and the owner's CTA is 310.3, i.e. every
       * pixel the rollup's natural width does not need.
       */
      describe('🔴 the primary CTA GROWS into the row', () => {
        // Split by viewer rather than looped for the same `unmount()` reason as the
        // sweep above. Both arms matter: a grow implemented on the menu's cluster
        // only would leave every anonymous card unchanged.
        for (const [label, user] of [
          ['anonymous', null],
          ['owner', OWNER],
        ] as const) {
          test(`${label} viewer at a 462px container`, async () => {
            mocks.currentUser = user;
            renderWithProviders(<Sized width={494} card={base(OFFSITE_CONNECT)} />);
            await expect
              .element(page.getByRole('link', { name: 'View details', exact: true }))
              .toBeInTheDocument();
            const { row, cta, rollup, actions } = actionRow('View details');
            assertLayoutIsReal(row);
            expect(Math.round(row.clientWidth)).toBe(462);
            // Natural CTA width is 137.9; anything near that means it did not grow.
            expect(cta.getBoundingClientRect().width).toBeGreaterThan(250);
            // …and it grew into SLACK, not into the rollup: the rollup is at its full
            // natural width here, well above the floor.
            expect(rollup.getBoundingClientRect().width).toBeGreaterThanOrEqual(95);
            // The row is exactly filled — no overflow, no gap at the right edge.
            expect(actions.getBoundingClientRect().right).toBeCloseTo(
              row.getBoundingClientRect().right,
              0
            );
            expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth + 1);
            // The one thing growth must NOT do.
            expect(Math.round(row.getBoundingClientRect().height)).toBe(46);
          });
        }
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
      // …and its container is still the shrinkable side — but now with a FLOOR
      // rather than `minWidth: 0`. Truncation is unaffected: the label sits inside
      // the clamped box and ellipsises there. What changed is where the shrinking
      // stops, and that is the property the growing CTA would otherwise erase.
      expect((rollup.parentElement as HTMLElement).style.minWidth).toBe(
        `${LISTING_ROLLUP_MIN_WIDTH_PX}px`
      );
    });

    test('🔴 the clamped rollup still TRUNCATES rather than overflowing its box', async () => {
      // The companion to the assertion above, and the half a style read cannot make:
      // at the threshold the rollup is clamped to exactly its 70px floor, which is
      // narrower than "No reviews yet" (79px natural) — so this is a width where the
      // ellipsis has to be doing real work. A floor that stopped the label
      // truncating would spill it out of the card instead.
      mocks.currentUser = OWNER; // → a menu, → the clamp is reachable
      renderWithProviders(
        <Sized
          width={296}
          card={base({ kind: 'offsite', kindData: { kind: 'offsite', externalUrl: null } })}
        />
      );
      await expect.element(page.getByText('No reviews yet')).toBeInTheDocument();
      const text = page.getByText('No reviews yet').element() as HTMLElement;
      const box = text.parentElement as HTMLElement;
      assertLayoutIsReal(box);
      expect(box.getBoundingClientRect().width).toBeCloseTo(LISTING_ROLLUP_MIN_WIDTH_PX, 0);
      // The label is wider than the box it is in, and is clipped rather than spilling.
      expect(text.scrollWidth).toBeGreaterThan(text.clientWidth);
      expect(text.getBoundingClientRect().right).toBeLessThanOrEqual(
        box.getBoundingClientRect().right + 1
      );
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
