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
import { Button, Text } from '@mantine/core';
import {
  LISTING_ACTION_ROW_HEIGHT_PX,
  LISTING_CARD_TITLE_LINES,
  LISTING_CARD_TITLE_LINE_HEIGHT,
} from '~/components/Apps/appListingCardGeometry';
import type { ListingCard } from '~/server/schema/blocks/app-listing-read.schema';

/**
 * P2b AppListingCard component tests (REPORT-ONLY — the browser project is
 * non-blocking; the blocking gate is appListingCardView.test.ts). These pin the
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
    openCount: 0,
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

/**
 * The action row, located from the primary CTA.
 *
 * 🔴 THE CTA IS NOW A DIRECT CHILD OF THE ROW — one level shallower than it was.
 * It used to sit inside a nested "action cluster" `Group` that existed only to
 * hold it and the `⋮` together as ONE flex item opposite the recommend rollup;
 * with the rollup relocated to the meta block, the row IS that cluster and the
 * wrapper is gone. A helper that still climbed twice would silently return the
 * card's `Stack` — which is also a flex container, so `assertLayoutIsReal` would
 * pass on it and every geometry assertion below would be about the wrong box.
 * Hence the shape check: only the action row carries `--group-wrap`.
 */
function assertIsActionRow(row: HTMLElement) {
  // 🔴 `mt="auto"` IS THE DISCRIMINATOR, and `--group-wrap` alone was NOT ENOUGH.
  // The retired action cluster was ALSO a `wrap="nowrap"` Group, so a wrap check
  // passes on it — measured: against pre-change code this helper landed on the
  // cluster and the container-248 width assertion went GREEN, because at that one
  // width the cluster happened to fill the row. Only the ROW is bottom-pinned.
  expect(row.style.marginTop, 'actionRow() did not land on the action row').toBe('auto');
  expect(row.style.getPropertyValue('--group-wrap')).toBe('nowrap');
}

function actionRow(ctaName: string) {
  const cta = page.getByRole('link', { name: ctaName, exact: true }).element() as HTMLElement;
  const row = cta.parentElement as HTMLElement;
  assertIsActionRow(row);
  return { cta, row };
}

/** The recommend rollup, wherever it is. Used for BOTH presence and absence. */
const ROLLUP_SELECTOR = '[data-testid="apps-listing-recommend-rollup"]';
/** The play count, wherever it is. Used for BOTH presence and absence. */
const PLAY_COUNT_SELECTOR = '[data-testid="apps-listing-play-count"]';

/**
 * The card's META BLOCK — the `Stack` holding the title and the two conditional
 * badges, reached from the title's own `Anchor`. Located structurally rather than
 * by a test id so a change that MOVES something out of it cannot be papered over
 * by moving an id with it.
 *
 * 🔴 THE LOCATOR IS UNCHANGED BY THE ROLLUP'S SECOND MOVE, and that is exactly
 * what the structural resolution bought. The block used to hold title / creator /
 * rollup / badges; the creator chip is deleted and the rollup now renders below the
 * action row, so today it holds title + badges. Walking from the title's `<a>` to
 * `anchor.parentElement` still lands on the same `Stack` either way — which is why
 * the guard below can assert the rollup is OUTSIDE it without the block having to
 * be re-located.
 */
function metaBlock(titleText: string): HTMLElement {
  const title = page.getByText(titleText, { exact: true }).element() as HTMLElement;
  const anchor = title.closest('a') as HTMLElement;
  expect(anchor, `no <a> around the title "${titleText}"`).not.toBeNull();
  return anchor.parentElement as HTMLElement;
}

/** A reviewed card — the rollup then says something other than "No reviews yet". */
const REVIEWED_ROLLUP = {
  recommend: { recommendedCount: 91, notRecommendedCount: 9, recommendPct: 0.91 },
  reviewCount: 100,
};

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

  /**
   * 🔴 THE NUMBERS THE COMMENTS QUOTE AS MEASUREMENTS — pinned, so they are
   * measurements rather than folklore.
   *
   * Two figures do real argumentative work in this component's comments and in
   * `appListingCardGeometry.ts`, and until now NOTHING asserted either of them:
   *
   *   - **Mantine `md` is 42px tall.** This is the whole reason the CTA grows
   *     HORIZONTALLY instead of up the size scale — the row is a load-bearing 46px
   *     and the next size up would not fit. It is quoted three times.
   *   - **`--mantine-line-height-xl` is 1.65, i.e. 33px at the title's 20px.** This
   *     is why `lh` on the title is called load-bearing: without it the reserved
   *     two lines would be 66px rather than 48, an ~18px card-height swing.
   *
   * A number quoted as a measurement that nothing re-derives is exactly the shape
   * that gets cited for years after it stops being true — a Mantine upgrade
   * retuning either token would leave every comment and both design decisions
   * silently wrong. Both are one `getComputedStyle` away in a tier that already
   * renders the card, so there is no excuse for leaving them unpinned.
   *
   * 🔴 REPORT-ONLY TIER, stated: this is the browser project, so these do not gate
   * a merge. They are still the only place either number is checked at all.
   */
  describe('🔴 the Mantine tokens the geometry comments quote', () => {
    test('the next button size up (`md`) is 42px — taller than the 46px row can afford', async () => {
      // Rendered rather than read off a CSS variable: the claim is about a
      // BUTTON's height, and a token lookup would not see a padding or border
      // change that also moves it.
      renderWithProviders(
        <div>
          <Button size="sm" data-testid="probe-sm">
            Probe
          </Button>
          <Button size="md" data-testid="probe-md">
            Probe
          </Button>
        </div>
      );
      await expect.element(page.getByTestId('probe-sm')).toBeInTheDocument();
      const sm = page.getByTestId('probe-sm').element() as HTMLElement;
      const md = page.getByTestId('probe-md').element() as HTMLElement;
      // `sm` is the CTA's size and the row's CONTROL term — 36, the same number
      // `LISTING_ACTION_ROW_CONTROL_PX` spells and the `⋮` trigger renders at.
      expect(
        Math.round(sm.getBoundingClientRect().height),
        'Mantine `sm` is the CTA size AND the control term of the 46px row height'
      ).toBe(36);
      // …and `md` is 42, which is why "just bump the size" is not available: 42 + a
      // 10px `pt` is 52, and the row must stay 46 inside an `h-full` grid row.
      expect(
        Math.round(md.getBoundingClientRect().height),
        'the comments justify growing the CTA horizontally by saying `md` is 42px tall — ' +
          'if that is no longer true, re-argue the decision instead of re-quoting the number'
      ).toBe(42);
    });

    test("an xl Text with no `lh` inherits 1.65 — 33px, not the title's 24px", async () => {
      renderWithProviders(
        <div>
          <Text size="xl" data-testid="probe-default-lh">
            Probe
          </Text>
          <Text size="xl" lh={LISTING_CARD_TITLE_LINE_HEIGHT} data-testid="probe-pinned-lh">
            Probe
          </Text>
        </div>
      );
      await expect.element(page.getByTestId('probe-default-lh')).toBeInTheDocument();
      const bare = page.getByTestId('probe-default-lh').element() as HTMLElement;
      const pinned = page.getByTestId('probe-pinned-lh').element() as HTMLElement;
      // 20px x 1.65 = 33px. This is the value the title would inherit if `lh` were
      // ever dropped, and the reason the comment calls it load-bearing.
      expect(
        getComputedStyle(bare).lineHeight,
        'the comments justify `lh` on the title by saying the inherited xl line-height is ' +
          '1.65 (33px at 20px) — pin the new value and re-derive the reserved height if this moved'
      ).toBe('33px');
      // …against the 24px the pinned constant produces. The gap is what the
      // reserved two lines are worth: 48px vs 66px.
      expect(getComputedStyle(pinned).lineHeight).toBe('24px');

      // 🔴 THE "~18px SWING" THE COMMENTS QUOTE IS NOT ASSERTED SEPARATELY, AND
      // THAT IS DELIBERATE — it is `LISTING_CARD_TITLE_LINES * (33 - 24)`, i.e.
      // FULLY DETERMINED by the two measurements above. A third assertion over it
      // could only fail in worlds where one of them has already failed, so it would
      // be an UNREACHABLE guard: green for the whole life of the file, red only as
      // a second copy of someone else's failure.
      //
      // 🔴 TWO WRONG VERSIONS SHIPPED BEFORE THIS COMMENT DID, both flagged by
      // audit. First `expect(2 * 33 - 2 * 24).toBe(18)` — a tautology over two
      // hardcoded literals, wired to neither measurement, unable to fail at all,
      // with a comment calling it the arithmetic guard. Then a version computed
      // from `getComputedStyle` on both probes, which is honest arithmetic but
      // still unreachable for the reason above: measured, the mutation that retunes
      // the pinned line-height (1.2 -> 1.4) kills the `24px` pin FIRST and the
      // swing line never executes. Decoration that reads as a guard is the same
      // class as the walkable spread check above, so it is stated in prose instead.
      expect(LISTING_CARD_TITLE_LINES).toBe(2); // the multiplier in that arithmetic
    });
  });

  /**
   * 🔴 THE TITLE RESERVES TWO LINES WHETHER OR NOT IT USES THEM — asserted as an
   * ALIGNMENT claim between two cards, not as a style read on one.
   *
   * The defect this fixes is only visible in a ROW: a one-line title is 24px and a
   * wrapped one is 48px, so everything under it lands at a different y on every
   * card. A `min-height` on a single card is a fact about that card; "the lines up
   * under the title line up" is the property a shopper actually sees, and it is a
   * RELATIONSHIP, so it has to be measured across two cards in one flex row rather
   * than inferred from a computed style.
   *
   * 🔴 THE PROBE MOVED FROM THE CREATOR CHIP TO THE TAGLINE, AND THAT IS A
   * NARROWING OF THE CLAIM, NOT A SUBSTITUTION OF CONVENIENCE. This suite used to
   * measure two cards' `a[href^="/user/"]` chips. The store card no longer renders
   * an author chip at all, and the recommend rollup left the meta block in the same
   * change — so the only content still positioned by the title's height is the two
   * conditional badges and the tagline. The action row and the stats line below it
   * are bottom-pinned by `mt="auto"`, so measuring THEM would pass with the
   * reservation deleted and would be a guard on nothing. The tagline is the
   * shallowest thing the reservation still moves, so it is what this measures.
   *
   * 🔴 THE FIXTURES THEREFORE CARRY A TAGLINE, unlike `base()`'s default use
   * elsewhere in this file — one that is SHORT enough to occupy one line under the
   * `line-clamp-3`, and IDENTICAL on both cards, so a difference in its `top` can
   * only come from the title box above it.
   *
   * 🔴 THE FIXTURES ARE PAIRWISE DISTINCT AND OFF THE BOUNDARY, deliberately. A
   * 1-line title against a 2-line one would sit exactly ON the reservation and the
   * mutation "remove the min-height" would be unreachable — 2 lines is 2 lines
   * either way. The long title is chosen to overflow to THREE lines at this column
   * width, which is asserted below rather than assumed, so the clamp is doing real
   * work and the short card is genuinely a line short of the reservation.
   */
  describe('🔴 the title reserves its two lines, so the rows under it align', () => {
    /** One line at the width used below. */
    const SHORT_TITLE = 'Ink';
    /** Long enough to wrap past the clamp — proven, not assumed, in the test. */
    const LONG_TITLE =
      'Procedurally Generated Landscape Compositor With Depth Aware Relighting And Batch Export';
    /**
     * The probe. IDENTICAL on both cards and short enough to be one line under the
     * `line-clamp-3`, so its `top` is a function of the title box alone.
     */
    const TAGLINE = 'Quick tools';

    /** The two cards' roots, in DOM order: [short-title card, long-title card]. */
    function cardRoots(): HTMLElement[] {
      return Array.from(document.querySelectorAll('[class*="Card-root"]')) as HTMLElement[];
    }

    test('a 1-line title and a 3-line title put their TAGLINES at the SAME y', async () => {
      renderWithProviders(
        <div style={{ display: 'flex', width: 640, alignItems: 'flex-start' }}>
          <div style={{ width: 320 }}>
            <AppListingCard
              card={base({ name: SHORT_TITLE, slug: 'short-title', tagline: TAGLINE })}
              canOpenPage
            />
          </div>
          <div style={{ width: 320 }}>
            <AppListingCard
              card={base({ name: LONG_TITLE, slug: 'long-title', tagline: TAGLINE })}
              canOpenPage
            />
          </div>
        </div>
      );
      // Render barrier on BOTH cards — a `.getBoundingClientRect()` on a
      // pre-commit DOM throws, and the throw poisons every later test in the file.
      await expect.element(page.getByText(SHORT_TITLE, { exact: true })).toBeInTheDocument();
      await expect.element(page.getByText(LONG_TITLE, { exact: true })).toBeInTheDocument();

      const [shortCard, longCard] = cardRoots();
      expect(shortCard, 'both cards rendered').toBeTruthy();
      expect(longCard, 'both cards rendered').toBeTruthy();
      // Stylesheet guard: without the real cascade every measurement below is a
      // CSS initial value and passes for the wrong reason.
      assertLayoutIsReal(shortCard.querySelector('[class*="Group-root"]') as HTMLElement);

      const shortTitle = shortCard.querySelector('a[href^="/apps/store-preview/"] span')!;
      const longTitle = longCard.querySelector('a[href^="/apps/store-preview/"] span')!;

      // 🔴 THE FIXTURE CONTROL. The long title really does overflow its two-line
      // clamp here (vertical overflow = `scrollHeight > clientHeight`), and the
      // short one really does not fill it. Without this pair the alignment
      // assertion could be green because BOTH titles happened to be one line.
      expect(
        longTitle.scrollHeight,
        'the long fixture must overflow the 2-line clamp at this column width'
      ).toBeGreaterThan(longTitle.clientHeight);
      expect(shortTitle.scrollHeight).toBeLessThanOrEqual(shortTitle.clientHeight);

      // Both title boxes are the SAME height — the reservation doing its work.
      expect(shortTitle.getBoundingClientRect().height).toBeCloseTo(
        longTitle.getBoundingClientRect().height,
        0
      );
      // 2 lines x 1.2 line-height x 20px (`size="xl"`) = 48px.
      expect(Math.round(shortTitle.getBoundingClientRect().height)).toBe(48);

      // 🔴 THE CLAIM THIS TEST IS FOR. `top`, not centre: a difference here is
      // exactly the visible defect, and the two taglines are the same height so a
      // centre comparison would say nothing extra.
      //
      // 🔴 THE PROBE IS RESOLVED FROM EACH CARD'S OWN SUBTREE, and both are asserted
      // present BEFORE they are compared — a `null` on either side would otherwise
      // throw on `.getBoundingClientRect()` and read as a harness fault rather than
      // as the tagline having stopped rendering.
      const shortTagline = Array.from(shortCard.querySelectorAll('p')).find(
        (el) => el.textContent === TAGLINE
      ) as HTMLElement | undefined;
      const longTagline = Array.from(longCard.querySelectorAll('p')).find(
        (el) => el.textContent === TAGLINE
      ) as HTMLElement | undefined;
      expect(shortTagline, 'the short-title card rendered no tagline').toBeTruthy();
      expect(longTagline, 'the long-title card rendered no tagline').toBeTruthy();
      // NON-VACUITY: the probes are two DIFFERENT elements, one per card. A `find`
      // that landed on the same node twice would compare a box with itself.
      expect(shortTagline).not.toBe(longTagline);
      expect(
        shortTagline!.getBoundingClientRect().top,
        'the tagline must land at the same y whatever the title length — the title box ' +
          'reserves LISTING_CARD_TITLE_LINES x LISTING_CARD_TITLE_LINE_HEIGHT for every card'
      ).toBeCloseTo(longTagline!.getBoundingClientRect().top, 0);
    });

    /**
     * 🔴 AND THE AUTHOR CHIP THIS SUITE USED TO MEASURE IS REALLY GONE, asserted
     * here rather than left implicit in the rewrite above — otherwise "we now
     * measure the tagline" would be indistinguishable from "we stopped measuring
     * the chip because it was inconvenient".
     *
     * The absence is a `querySelector` returning `null`, NOT
     * `expect.element(...).not.toBeInTheDocument()`, which is INERT in this repo
     * (civitai/civitai#4197). It is controlled by a POSITIVE read of the same
     * shape first: the card's title anchor IS found by an equivalent
     * `querySelector`, so a `null` for the profile link is a real read of a
     * rendered card and not a selector that matches nothing anywhere.
     */
    test('🔴 the card renders NO author chip — no profile link, no "by <name>"', async () => {
      renderWithProviders(
        <Sized width={320} card={base({ creator: { id: 5, username: 'alice', image: null } })} />
      );
      await expect.element(page.getByText('My App', { exact: true })).toBeInTheDocument();
      const [card] = cardRoots();
      expect(card, 'the card did not render').toBeTruthy();

      // POSITIVE CONTROL, same call shape as the absence below.
      expect(
        card.querySelector('a[href^="/apps/store-preview/"]'),
        'the title anchor is missing — this card did not render, so the absence below is vacuous'
      ).not.toBeNull();

      expect(
        card.querySelector('a[href^="/user/"]'),
        'the author chip is back on the store card — attribution belongs on the DETAIL ' +
          'surfaces (AppDetailsModal / appDetailAuthorView / AppListingDetailBody), not here'
      ).toBeNull();
      // …and not as un-linked text either, which a chip stripped of its Anchor
      // would be. Read off `textContent`, for the same #4197 reason.
      expect(
        card.textContent,
        'the card still prints a "by <creator>" byline, just without the link'
      ).not.toContain('by alice');
    });

    /**
     * The clamp survived the switch from the `line-clamp-2` utility class to
     * `TruncatedText`'s multi-line mode — a swap that is easy to get wrong,
     * because that component's DEFAULT mode writes an INLINE `white-space: nowrap`
     * which silently beats the utility class and yields ONE ellipsised line.
     */
    test('🔴 a long title still clamps at two lines rather than one', async () => {
      renderWithProviders(
        <Sized width={320} card={base({ name: LONG_TITLE, slug: 'long-title' })} />
      );
      await expect.element(page.getByText(LONG_TITLE, { exact: true })).toBeInTheDocument();
      const title = page.getByText(LONG_TITLE, { exact: true }).element() as HTMLElement;
      const style = getComputedStyle(title);
      expect(style.webkitLineClamp).toBe('2');
      expect(style.whiteSpace).not.toBe('nowrap');
      // …and it renders as two lines, not one: 2 x 24px.
      expect(Math.round(title.getBoundingClientRect().height)).toBe(48);
    });

    /**
     * The other half `TruncatedText` buys: a clamped name is unreadable, so it is
     * revealed on hover — and ONLY when it actually clips (a runtime measurement,
     * not a guess).
     */
    test('a clamped title reveals its full value in a tooltip on hover', async () => {
      renderWithProviders(
        <Sized width={320} card={base({ name: LONG_TITLE, slug: 'long-title' })} />
      );
      const label = page.getByText(LONG_TITLE, { exact: true });
      await expect.element(label).toBeInTheDocument();
      await label.hover();
      // The portalled tooltip is a SECOND node carrying the same text.
      await vi.waitFor(() => {
        expect(page.getByText(LONG_TITLE, { exact: true }).elements().length).toBeGreaterThan(1);
      });
    });
  });

  /**
   * 🔴 THE RETIRED S5 AUTHOR-LINE ASSERTION, AND WHY IT IS DELETED RATHER THAN
   * RELAXED.
   *
   * A test here pinned the author line's typography — `sm` / `fw 500`, and NOT
   * white — as decision 3 of the S5 chrome pass ("size + weight only; taking both
   * title and author to white flattens the hierarchy on a dark-6 body"), together
   * with an ACCEPTED contrast residual of 4.73 (AA pass by 0.23, AAA fail).
   *
   * There is no author line on this card any more, so that assertion has no
   * subject. Leaving it asserting the old typography against a card that renders no
   * such element would be a test that can only fail; relaxing it into something
   * that passes either way would be worse — a green claim about a hierarchy that no
   * longer exists reads as coverage and stops anyone looking. What replaces it is
   * the ABSENCE guard above ("the card renders NO author chip"), which is the claim
   * that is now true and is mutation-visible.
   *
   * 🔴 THE CONTRAST RESIDUAL IS NOT SILENTLY RESOLVED — IT MOVED. The detail
   * surfaces still render attribution and are untouched by this change, so if that
   * 4.73 mattered it matters THERE now (`AppListingDetailBody`'s own `CreatorChip`),
   * not here. This paragraph exists so nobody reads the deletion as a fix.
   */

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

  test('🔴 the action row is exactly [CTA, ⋮] and does NOT wrap', async () => {
    // 🔴 Regression guard for the obvious-but-wrong fix to the taller `sm` buttons.
    // Letting this row wrap would put the `⋮` on its own line, so an OWNER card
    // would be TALLER than a menu-less one — and inside an `h-full` grid row that
    // grows every card in the row across the whole store.
    //
    // 🔴 THE CHILD LEDGER IS THE POINT, not an incidental structural check. The
    // row's geometry claim ("the CTA is the row minus the trigger and the gap")
    // is only true while these are its ONLY two children — a third one, of any
    // kind, silently invalidates every width assertion in this file. Asserting the
    // SET rather than a containment means the ledger fails when it grows as well
    // as when it shrinks.
    mocks.currentUser = OWNER; // → the `⋮`, i.e. the widest action set
    renderWithProviders(<AppListingCard card={base({})} canOpenPage />);
    await expect.element(page.getByTestId('apps-listing-card-actions-menu')).toBeInTheDocument();

    const trigger = page.getByTestId('apps-listing-card-actions-menu').element() as HTMLElement;
    // The trigger sits inside a `flexShrink: 0` Box the shared menu renders, so the
    // ROW is ONE level up from that Box — not two, as it was while a nested action
    // cluster stood between them.
    const triggerBox = trigger.parentElement as HTMLElement;
    const row = triggerBox.parentElement as HTMLElement;
    const cta = page.getByRole('link', { name: 'Open', exact: true }).element() as HTMLElement;

    assertIsActionRow(row);
    expect(Array.from(row.children)).toEqual([cta, triggerBox]);
    // The CTA is the side that grows; the trigger's box never does either way.
    expect(cta.style.flexGrow).toBe('1');
    expect(triggerBox.style.flexShrink).toBe('0');
    // 🔴 AND `justify="space-between"` IS GONE. It was there to push the actions
    // away from the rollup; with one growing child it distributes nothing, and
    // leaving it would be a declaration a later reader has to prove inert.
    // Mantine always writes `--group-justify` (defaulting to `flex-start`), so the
    // assertion is on the VALUE, not on the property's absence — asserting `''`
    // fails against correct code, which it did on this test's first run.
    expect(row.style.getPropertyValue('--group-justify')).toBe('flex-start');
    // 🔴 …as is the `marginLeft: 'auto'` that was its second mechanism. Same
    // reason: flexible lengths resolve BEFORE auto margins, so with the CTA
    // filling the row there is never any free space for one to absorb.
    expect(cta.style.marginLeft).toBe('');
    expect(triggerBox.style.marginLeft).toBe('');
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
      // The row is `wrap="nowrap"` for a documented reason: a wrapped line would
      // put the `⋮` under the CTA, so a card WITH a menu would be taller than one
      // without and would grow the height of a whole `h-full` grid row. Icons make
      // the button ~22px wider, so this pins that the row did not quietly gain
      // wrapping to cope.
      //
      // Rendered in a NARROW column — the tight case is md/lg (3–4 columns), not
      // the wide single-column base — and with the OWNER `⋮` present, which is the
      // widest configuration the row ever has.
      mocks.currentUser = { id: 5, username: 'alice' };
      renderWithProviders(<Sized width={340} card={base({})} />);
      await expect
        .element(page.getByRole('link', { name: 'Open', exact: true }))
        .toBeInTheDocument();

      const { row, cta } = actionRow('Open');
      assertLayoutIsReal(row);
      const trigger = page.getByTestId('apps-listing-card-actions-menu').element() as HTMLElement;

      // Now that layout is real, this is a genuine assertion: with the stylesheet
      // loaded `Group` resolves `flex-wrap` from `--group-wrap`, so flipping the
      // component to `wrap="wrap"` makes this read `wrap`.
      expect(getComputedStyle(row).flexWrap).toBe('nowrap');

      // …and BEHAVIOURALLY: both controls are on one line and nothing overflows
      // the row box. This is the half a `--group-wrap` assertion cannot prove.
      expect(sameLine(cta, trigger)).toBe(true);
      expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth + 1);
    });

    /**
     * 🔴 THE ACTION ROW AFTER THE ROLLUP MOVED OUT.
     *
     * The row used to hold two competing children — the recommend rollup and an
     * action cluster — under `justify="space-between"`, and most of this file's
     * geometry was about arbitrating between them: a `min-width` floor on the
     * rollup, a `@[264px]` container query hiding it below the width where even
     * the floor did not fit, a measured 184px "widest action cluster", and a
     * derived 264 threshold. Every one of those tests is DELETED rather than
     * relaxed — their subject no longer exists, and a green test asserting a
     * relationship that is gone reads as coverage while providing none.
     *
     * What replaces them is the smaller set of claims the row can still make:
     *
     *   | container | CTA (menu)        | CTA (no menu) | row h |
     *   |-----------|-------------------|---------------|-------|
     *   |       248 | 248 − 36 − 10     |           248 |    46 |
     *   |       282 | 282 − 36 − 10     |           282 |    46 |
     *   |       462 | 462 − 36 − 10     |           462 |    46 |
     *
     * 248 / 282 / 462 are the same three action-row widths the pre-change code
     * measured — 248 inside the 280px card the store renders at FOUR COLUMNS on a
     * 1168px grid, 282 one step wider, and 462 the wide end where the CTA has real
     * slack to grow into. They are kept because the row-height claim is the one
     * that must hold everywhere, and re-deriving a fresh set of widths would drop
     * the continuity with the numbers the file already reasons about.
     *
     * 🔴 ANCHORED TO THE GRID RUNG, NOT TO A VIEWPORT — see the `Sized` docblock
     * for why. This paragraph used to derive 248 from "container 1200 → grid
     * column 296 → card 280" and call 462 "the wide single-column `base` case";
     * both described a store layout rather than a card, and both have since gone
     * stale. No number here moved: what changed is that the justification no
     * longer claims anything about how a viewport becomes a column.
     *
     * 🔴 THE CTA WIDTHS ARE WRITTEN AS ARITHMETIC, NOT AS THE THREE RESULTING
     * NUMBERS, because the arithmetic is the claim: the CTA takes the whole row
     * minus the trigger and the gap. Three literals would pass just as well
     * against a CTA that happened to land there for some other reason.
     */
    describe("the action row at the store's real container widths", () => {
      // The widest CTA ("View details") — an off-site listing with no external
      // target makes `getListingCta` fall through to the unified detail. Fully
      // typed rather than cast: a cast here previously HID a missing `externalUrl`
      // and a sub-kind that was not a member of its union at all, and neither
      // `tsc` error reached vitest, which type-strips.
      const WIDEST_CTA = {
        kind: 'offsite' as const,
        recommend: { recommendedCount: 91, notRecommendedCount: 9, recommendPct: 0.91 },
        reviewCount: 100,
        kindData: {
          kind: 'offsite',
          externalUrl: null,
        } satisfies ListingCard['kindData'],
      };

      /**
       * 🔴 THE CTA FILLS THE ROW — asserted at TWO named container widths, because
       * one measurement is not a general claim.
       *
       * A narrow one (248 — the action row inside the four-column card) and a wide
       * one (462). Both are above the row's ~184px natural content, so both are
       * cases where the CTA must GROW; a single width could not distinguish "it
       * fills" from "it happens to fit".
       *
       * 🔴 NO SUPERLATIVE. These used to read "the store's tightest real geometry"
       * and "the widest". Neither is a claim this file can keep: which rung is
       * narrowest, and which is widest, is decided by the store's grid — not this
       * component's, and it has changed. What the pair still buys — two widths far
       * enough apart that "it fills" is a general claim rather than one
       * measurement — does not need either word.
       *
       * 🔴 THE EXPECTED VALUE IS BUILT FROM THE MEASURED TRIGGER AND THE MEASURED
       * GAP, not from `LISTING_ACTION_ROW_CONTROL_PX` / `_GAP_PX`. Deriving it
       * from the constants the component reads would move the expectation with any
       * mutation of them, and the test could never fail. The constants are checked
       * against those measurements separately, below.
       */
      describe('🔴 the CTA fills the row minus the trigger and the gap', () => {
        // One test per width rather than a loop with `unmount()` — that fights the
        // scaffold's global `afterEach(cleanup)` over the shared container and
        // leaves every LATER test in the file rendering into an empty body.
        for (const [outer, container] of [
          [280, 248],
          [494, 462],
        ] as const) {
          test(`container ${container}`, async () => {
            mocks.currentUser = OWNER; // → a `⋮`, i.e. the row's two-child case
            renderWithProviders(<Sized width={outer} card={base(WIDEST_CTA)} />);
            await expect
              .element(page.getByRole('link', { name: 'View details', exact: true }))
              .toBeInTheDocument();
            const { row, cta } = actionRow('View details');
            assertLayoutIsReal(row);
            expect(Math.round(row.clientWidth)).toBe(container);

            const trigger = page
              .getByTestId('apps-listing-card-actions-menu')
              .element() as HTMLElement;
            const triggerWidth = trigger.getBoundingClientRect().width;
            const gap = parseFloat(getComputedStyle(row).columnGap);
            // The two terms the CTA is the row MINUS, measured rather than
            // assumed — and each pinned to the literal it is contracted to be, so
            // a green result cannot be two compensating errors.
            expect(Math.round(triggerWidth)).toBe(36);
            expect(gap).toBe(10);

            expect(
              cta.getBoundingClientRect().width,
              `the CTA must fill the action row minus the 36px trigger and the 10px gap — ` +
                `asserted at container 248 AND container 462, this one is ${container}`
            ).toBeCloseTo(container - triggerWidth - gap, 0);
            // …and it fills it to the right edge, with no overflow.
            expect(cta.getBoundingClientRect().left).toBeCloseTo(
              row.getBoundingClientRect().left,
              0
            );
            expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth + 1);
          });
        }
      });

      /**
       * 🔴 THE MENU-LESS CASE — the other half of "fills the row", and the arm that
       * a fill implemented only on the menu's side would leave untouched.
       *
       * Every viewer except {owner, moderator} gets no `⋮` (`surface="card"`), so
       * for them the row holds ONE child and the CTA is the whole row. Run over
       * both a signed-out and a signed-in non-owner from ONE assertion body: the
       * claim is that those two measure IDENTICALLY, and two independently-written
       * tests cannot make a claim about a relationship. (A previous version of this
       * file ran the signed-out arm alone and was structurally blind to a 137.9 →
       * 184 shift that had just landed on every signed-in shopper.)
       */
      describe('🔴 with no `⋮`, the CTA is the whole row', () => {
        for (const [label, user] of [
          ['signed-out', null],
          ['signed-in non-owner, non-moderator', SHOPPER],
        ] as const) {
          test(`${label}`, async () => {
            mocks.currentUser = user;
            renderWithProviders(<Sized width={314} card={base(WIDEST_CTA)} />);
            await expect
              .element(page.getByRole('link', { name: 'View details', exact: true }))
              .toBeInTheDocument();
            const { row, cta } = actionRow('View details');
            assertLayoutIsReal(row);
            expect(page.getByTestId('apps-listing-card-actions-menu').elements()).toHaveLength(0);
            expect(Math.round(row.clientWidth)).toBe(282);
            // No trigger, no gap to leave — the CTA is the entire row.
            expect(cta.getBoundingClientRect().width).toBeCloseTo(282, 0);
            // 🔴 THE CONTROL HALF OF THE ROW-HEIGHT DERIVATION, AND IT WAS MISSING.
            // `LISTING_ACTION_ROW_HEIGHT_PX` is `pt` (10) + a 36px CONTROL, and the
            // suite asserted the 36 for the `⋮` trigger and for NOTHING ELSE. The
            // CTA's own 36 was only ever asserted as the CSS variable STRING
            // `var(--button-height-sm)` — which survives a theme override of that
            // token, a border or padding on the button, or swapping `Button` for
            // another element entirely.
            //
            // 🔴 IT MATTERS MORE ON THIS ROW THAN IT LOOKS, because `mih` MASKS it:
            // the row is floored at 46 whatever its child renders, so a CTA that
            // shrinks leaves the row measuring 46 and every row-height assertion
            // green. Measured on this arm with the CTA at `size="xs"`: with `mih`
            // the suite reported 2 reds (both size-token tests only); without `mih`
            // it reported 4, the extra two being these arms at `expected 40 to be
            // 46`. The floor is correct and stays — this assertion is what puts the
            // control back under observation despite it.
            expect(
              Math.round(cta.getBoundingClientRect().height),
              'the CTA must render at the same 36px as the ⋮ trigger — that 36 is the ' +
                'CONTROL term of LISTING_ACTION_ROW_HEIGHT_PX (pt 10 + control 36 = 46), ' +
                "and the row's `mih` floor hides a shrunken control from every height assertion"
            ).toBe(36);
            expect(Math.round(row.getBoundingClientRect().height)).toBe(46);
          });
        }
      });

      /**
       * 🔴 ROW HEIGHT IS 46px AT EVERY WIDTH — the invariant the whole store's grid
       * rests on, since the row sits in an `h-full` grid row and a taller control
       * here grows every card in that row.
       *
       * 🔴 46 IS A LITERAL HERE, DELIBERATELY. `LISTING_ACTION_ROW_HEIGHT_PX` is
       * asserted to EQUAL it in the same test rather than substituted for it:
       * writing `toBe(LISTING_ACTION_ROW_HEIGHT_PX)` would move the expectation in
       * lockstep with any mutation of the constant, so a changed constant would
       * render a 52px row and still pass. Measured at 248, 282 and 462 — the three
       * container widths the pre-change comment named.
       */
      describe('🔴 the row is 46px tall', () => {
        for (const [outer, container] of [
          [280, 248],
          [314, 282],
          [494, 462],
        ] as const) {
          test(`container ${container}`, async () => {
            mocks.currentUser = OWNER;
            renderWithProviders(<Sized width={outer} card={base(WIDEST_CTA)} />);
            await expect
              .element(page.getByRole('link', { name: 'View details', exact: true }))
              .toBeInTheDocument();
            const { row } = actionRow('View details');
            assertLayoutIsReal(row);
            expect(Math.round(row.clientWidth)).toBe(container);
            expect(
              Math.round(row.getBoundingClientRect().height),
              `the action row must stay 46px at container ${container} — it lives in an h-full grid row`
            ).toBe(46);
            // …and the shared constant, which the skeleton will import, says the
            // same thing the render just did.
            expect(LISTING_ACTION_ROW_HEIGHT_PX).toBe(46);
            // The two terms that produce it, read off the real box.
            expect(parseFloat(getComputedStyle(row).paddingTop)).toBe(10);
            const trigger = page
              .getByTestId('apps-listing-card-actions-menu')
              .element() as HTMLElement;
            expect(Math.round(trigger.getBoundingClientRect().height)).toBe(36);
          });
        }
      });
    });

    /**
     * 🔴 THE RECOMMEND ROLLUP MOVED AGAIN — OUTSIDE the meta block, and BELOW the
     * action row.
     *
     * ⚠️ THIS TEST IS RETARGETED, NOT RELAXED, AND THE DISTINCTION IS THE WHOLE
     * REASON IT EXISTS. It previously asserted "in the meta block and NOT in the
     * action row", written specifically so that a change moving the rollup out of
     * the meta block could not be papered over. This change IS that move, so the
     * old assertion went red BY DESIGN. The response is a new invariant that is at
     * least as strong — the rollup is in NEITHER of the two containers, and it is
     * positioned BELOW the row — and emphatically not an assertion that would pass
     * under either arrangement.
     *
     * Every half is in one test on purpose: "it is below the action row" is also
     * true of a card that renders it TWICE (once below, once in the meta block),
     * and "it is not in the meta block" is also true of a card that does not render
     * it at all.
     *
     * 🔴 EVERY ABSENCE IS `querySelector(...) === null`, NOT
     * `expect.element(...).not.toBeInTheDocument()`. That matcher is INERT in this
     * repo (civitai/civitai#4197) — it passes whether or not the element is there.
     * The form used here is controlled in the same test: the identical
     * `querySelector(ROLLUP_SELECTOR)` call against the CARD ROOT returns the node,
     * so a `null` from the meta block or the row is a real read and not a selector
     * that matches nothing.
     *
     * 🔴 EACH HALF CARRIES ITS OWN MESSAGE, so a mutant rendering the rollup in
     * BOTH places fails naming which place is wrong rather than on an ambiguous
     * count.
     */
    test('🔴 the rollup renders BELOW the action row — not in it, and not in the meta block', async () => {
      mocks.currentUser = OWNER; // the widest row — if it fits anywhere, it fits here
      renderWithProviders(<Sized width={314} card={base({ ...REVIEWED_ROLLUP })} />);
      // 🔴 THE BARRIER IS THE CTA, NOT THE ROLLUP'S OWN TEXT. `getByText` is
      // strict-mode: a mutation that renders the rollup in TWO places resolves to
      // two nodes and THROWS at the locator, so the test would go red for a locator
      // reason before any assertion ran — and a red for the wrong reason proves
      // nothing about the guard. The CTA is unique under every arrangement of the
      // rollup, so it is the barrier.
      await expect
        .element(page.getByRole('link', { name: 'Open', exact: true }))
        .toBeInTheDocument();

      // 🔴 POSITIVE CONTROL FIRST, using the SAME `querySelector(ROLLUP_SELECTOR)`
      // call shape as the two absences below — so a `null` from either container is
      // a real read and not a selector that matches nothing anywhere.
      const card = document.querySelector('[class*="Card-root"]') as HTMLElement;
      expect(card, 'the card did not render').not.toBeNull();
      const rollup = card.querySelector(ROLLUP_SELECTOR) as HTMLElement | null;
      expect(
        rollup,
        'the recommend rollup is not on the card at all — either it stopped rendering or ' +
          'ROLLUP_SELECTOR matches nothing, and both absences below would then be vacuous'
      ).not.toBeNull();

      const { row } = actionRow('Open');
      assertLayoutIsReal(row);
      const meta = metaBlock('My App');

      // 🔴 THE TWO CLAIMS THIS TEST EXISTS FOR, each with its own message.
      expect(
        meta.querySelector(ROLLUP_SELECTOR),
        'the recommend rollup is back in the META BLOCK — the operator moved it below the CTA'
      ).toBeNull();
      expect(
        row.querySelector(ROLLUP_SELECTOR),
        'the recommend rollup is inside the ACTION ROW — that row holds the CTA and the ⋮ ' +
          'trigger and nothing else, and sharing it is what cost a min-width floor, a ' +
          '@container breakpoint and a derived threshold constant last time'
      ).toBeNull();
      expect(meta.contains(rollup!)).toBe(false);
      expect(row.contains(rollup!)).toBe(false);
      // The row is exactly the CTA + the trigger's box, nothing else.
      expect(row.children).toHaveLength(2);

      // …and exactly ONE in the whole document — not zero (which would satisfy both
      // absences vacuously) and not two (a copy left behind in either container).
      expect(document.querySelectorAll(ROLLUP_SELECTOR)).toHaveLength(1);

      // 🔴 AND IT IS *BELOW* THE ROW, not merely outside it — a position claim no
      // containment check can make, and the half of the operator's ask ("move
      // reviews + plays below the CTA") that containment alone does not express.
      // `top` against the row's `bottom`, so "below" means genuinely after it in
      // the block flow rather than merely lower-topped inside an overlap.
      expect(
        rollup!.getBoundingClientRect().top,
        'the rollup does not start below the action row — "below the CTA" is the ask, and ' +
          'being outside the row is not the same claim'
      ).toBeGreaterThanOrEqual(row.getBoundingClientRect().bottom);

      // 🔴 AND `mt="auto"` STILL BOTTOM-PINS THE PAIR. The action row carries the
      // auto top margin and is no longer the Stack's LAST child, so "the row is at
      // the bottom" has to be re-measured rather than inherited from before the
      // move: a column flex container's single auto margin absorbs all free space,
      // which should push the row AND everything after it down together. What that
      // means observably is that the STATS LINE — now the last child — ends flush
      // with the Stack's content box.
      //
      // Measured against the Stack rather than the Card, because `Card padding="md"`
      // sits outside the Stack and would put a constant 16px in the comparison.
      const stack = row.parentElement as HTMLElement;
      expect(stack.contains(rollup!), 'the stats line is not a sibling of the action row').toBe(
        true
      );
      expect(
        stack.getBoundingClientRect().bottom - rollup!.getBoundingClientRect().bottom,
        'the bottom-pinned group is not flush with the bottom of the card body. `mt="auto"` ' +
          'must stay on the FIRST of the bottom-pinned children (the action row) — moved to a ' +
          'later one, or removed, a gap opens under the stats line and the CTA floats up.'
      ).toBeLessThan(1);
    });

    /**
     * 🔴 THE PLAY COUNT — RENDERED FOR A MEASURABLE LISTING, OMITTED ENTIRELY WHEN
     * `openCount === null`. NEVER a `0` for the null case.
     *
     * 🔴 THAT OMISSION IS AN OPERATOR OVERRIDE, NOT A DERIVATION. An off-site
     * listing's CTA is a third-party `target="_blank"` anchor, so nothing
     * on-platform observes the click and the number is STRUCTURALLY ABSENT; a `0`
     * would read as "nobody has ever used this app" about an app we cannot measure.
     * The mirror is equally load-bearing and is asserted below: an ON-SITE listing
     * with a genuine `0` DOES render "0 plays".
     *
     * 🔴 THE FIXTURES ARE PAIRWISE DISTINCT AND DISTINCT FROM EVERY CONSTANT THESE
     * ASSERTIONS NAME. 4821 is not 0, not 1, not a row/control/gap px value, and
     * abbreviates to a string ("4.8k") that shares no characters-in-order with the
     * raw number — so a mutant that printed the raw value, or that hardcoded any
     * geometry literal, cannot produce it.
     */
    describe('🔴 the play count', () => {
      test('an on-site listing renders it beside the rollup', async () => {
        renderWithProviders(<Sized width={314} card={base({ openCount: 4821 })} />);
        await expect
          .element(page.getByRole('link', { name: 'Open', exact: true }))
          .toBeInTheDocument();
        const play = document.querySelector(PLAY_COUNT_SELECTOR) as HTMLElement | null;
        expect(play, 'the play count did not render for a measurable listing').not.toBeNull();
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
        // …and both sit below the action row.
        const { row } = actionRow('Open');
        expect(play!.getBoundingClientRect().top).toBeGreaterThanOrEqual(
          row.getBoundingClientRect().bottom
        );
      });

      test('🔴 a genuine ZERO renders — "0 plays" is a measurement, not an absence', async () => {
        renderWithProviders(<Sized width={314} card={base({ openCount: 0 })} />);
        await expect
          .element(page.getByRole('link', { name: 'Open', exact: true }))
          .toBeInTheDocument();
        const play = document.querySelector(PLAY_COUNT_SELECTOR) as HTMLElement | null;
        expect(
          play,
          'an ON-SITE listing with openCount 0 rendered no play count. 0 is a real ' +
            'measurement ("no plays recorded yet") — only `null` is unmeasurable. A ' +
            'truthiness test (`card.openCount && …`) instead of `!= null` is the likely cause.'
        ).not.toBeNull();
        expect(play!.textContent).toContain('0 plays');
      });

      test('🔴 openCount === null renders NO play count node — never a 0', async () => {
        renderWithProviders(
          <Sized
            width={314}
            card={base({
              kind: 'offsite',
              openCount: null,
              kindData: { kind: 'offsite', externalUrl: 'https://ext.app' },
            })}
          />
        );
        await expect
          .element(page.getByRole('link', { name: 'Visit', exact: true }))
          .toBeInTheDocument();

        // 🔴 POSITIVE CONTROL ON THE SELECTOR ITSELF, in this same test. The two
        // tests above already show `PLAY_COUNT_SELECTOR` CAN match — but a bare
        // "not found" here would still be worthless if this render produced no card
        // at all, so the rollup (which always renders) is read with the identical
        // `querySelector` call shape before the absence is believed.
        const rollup = document.querySelector(ROLLUP_SELECTOR) as HTMLElement | null;
        expect(
          rollup,
          'the stats line did not render at all — the absence below is vacuous'
        ).not.toBeNull();

        expect(
          document.querySelector(PLAY_COUNT_SELECTOR),
          'an off-site listing rendered a play count. `openCount === null` means the number ' +
            'is STRUCTURALLY ABSENT (no on-platform request follows a third-party CTA), and ' +
            'the operator\'s call is to omit the stat entirely — a "0" here is a false claim ' +
            'about an app we cannot measure.'
        ).toBeNull();
        // …and not as bare text either, which a node stripped of its testid would be.
        const card = document.querySelector('[class*="Card-root"]') as HTMLElement;
        expect(card.textContent, 'the card prints a play count without its testid').not.toContain(
          'plays'
        );
        expect(card.textContent).not.toContain('0 play');
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
