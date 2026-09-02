import { Text } from '@mantine/core';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import type * as FeatureFlagsMod from '~/providers/FeatureFlagsProvider';
import type * as TrpcMod from '~/utils/trpc';

/**
 * F2 — the breadcrumb's trailing app-name crumb is a real CONTROL: a button that
 * opens a popover carrying the app's full name, the store's recommend rollup and a
 * "View in App Store" action.
 *
 * 🔴 MOST TESTS HERE MOUNT `AppBlockChrome`, NOT `AppNameCrumb` — ON PURPOSE. The
 * crumb is reachable in production only through the chrome, and the chrome is what
 * decides whether it renders at all (page surface only), what `slug` it gets and
 * what responsive `maxWidth` it gets. A suite that rendered the crumb directly
 * would verify the component in isolation while the SEAM — chrome → crumb prop
 * threading — went uncovered, which is exactly how a correct component ships behind
 * a host that passes it nothing. The two tests that DO mount the crumb directly are
 * the ones needing a deterministic `maxWidth`, and they say so.
 *
 * Both mocks use the `importOriginal` spread rather than a wholesale replacement
 * (local-rules/no-wholesale-module-mock): a hand-written module object silently
 * breaks every importer the day the real module grows an export this factory omits.
 */

const mocks = vi.hoisted(() => ({
  // `appListings` OR `appBlocks` OR `appListingsPublicExternal` → store access.
  features: { appListings: true } as Record<string, boolean>,
  detail: undefined as unknown,
  isLoading: false,
  error: null as unknown,
  // Records what the component actually asked for, so the "which identifier keys
  // the lookup" claim is checked rather than assumed.
  // `undefined` means the hook was never CALLED — which is the assertion the
  // laziness and gate tests rest on, so it is reset before every test.
  lastQueryInput: undefined as unknown,
}));

// AppBlockChrome gates its "Review" item on the viewer's moderator flag and would
// otherwise throw for want of a CivitaiSessionContext. Anon, non-mod.
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));

// 🔴 `useOptionalFeatureFlags` IS THE ONE THAT MATTERS — the crumb reads the flags
// through it (fail-closed outside a provider), not through `useFeatureFlags`.
// Overriding only the latter would leave the crumb resolving the REAL
// null-outside-provider value, i.e. store access `false`, and every popover test
// below would fail against a static `<Text>` for a reason unrelated to what it
// asserts. Both are overridden, to the SAME flags.
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsMod>()),
  useFeatureFlags: () => mocks.features,
  useOptionalFeatureFlags: () => mocks.features,
}));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  trpc: {
    appListings: {
      getAppDetail: {
        useQuery: (input: unknown) => {
          mocks.lastQueryInput = input;
          return { data: mocks.detail, isLoading: mocks.isLoading, error: mocks.error };
        },
      },
    },
  },
}));

// eslint-disable-next-line import/first
import { AppNameCrumb } from '~/components/AppBlocks/AppNameCrumb';
// eslint-disable-next-line import/first
import { AppBlockChrome } from '~/components/AppBlocks/IframeHost';
// eslint-disable-next-line import/first
import { renderWithProviders } from '../../../test/component-setup';

const APP_NAME = 'Budgeted Generator';
const SLUG = 'budgeted-generator';

/** A `ListingDetail`-shaped fixture, only the fields the popover reads. */
function detailFixture(over: Record<string, unknown> = {}) {
  return {
    id: 'apl_01',
    slug: SLUG,
    name: APP_NAME,
    // 9 of 10 recommend → the shared `getRecommendLabel` renders "90% recommend (10)".
    recommend: { recommendedCount: 9, notRecommendedCount: 1, recommendPct: 0.9 },
    reviewCount: 10,
    ...over,
  };
}

function renderChrome(props: Record<string, unknown> = {}) {
  return renderWithProviders(
    <AppBlockChrome
      blockInstanceId="inst-crumb"
      appName={APP_NAME}
      slug={SLUG}
      slotId="app.page"
      {...props}
    />
  );
}

/**
 * The crumb element, once it is actually in the document.
 *
 * 🔴 AWAITS PRESENCE FIRST, AND THAT IS NOT DEFENSIVE PADDING. `render` returns
 * before React has committed, so a synchronous `.element()` throws
 * "Cannot find element with locator" against an EMPTY body — which reads as
 * "the component rendered nothing", i.e. as a real defect in the gate, when the
 * component is fine and the test simply looked too early. Six tests in this file
 * failed that way on their first run.
 */
async function trigger(): Promise<HTMLElement> {
  await expect.element(page.getByTestId('app-block-breadcrumb-name')).toBeInTheDocument();
  return page.getByTestId('app-block-breadcrumb-name').element() as HTMLElement;
}

beforeEach(() => {
  mocks.features = { appListings: true };
  mocks.detail = detailFixture();
  mocks.isLoading = false;
  mocks.error = null;
  mocks.lastQueryInput = undefined;
});

describe('the app-name crumb is a real control', () => {
  test('it is a native button with popover semantics and a visible focus ring — not a div with an onClick', async () => {
    renderChrome();
    await expect.element(page.getByTestId('app-block-breadcrumb-name')).toBeInTheDocument();
    const btn = await trigger();

    // A real <button>: keyboard-focusable and Enter/Space-activatable by the
    // platform, with no `tabIndex`/`role`/`onKeyDown` shims to get wrong.
    expect(btn.tagName.toLowerCase()).toBe('button');
    // `type="button"`, so it can never submit an enclosing form.
    expect(btn.getAttribute('type')).toBe('button');
    // Mantine's `UnstyledButton` applies its focusable global class, which is what
    // paints the focus ring. Asserting the class (rather than a computed outline)
    // is deliberate: this harness loads no Mantine stylesheet, so a computed-style
    // assertion here would be measuring nothing.
    expect(btn.className).toContain('mantine-focus-auto');

    // Popover semantics, contributed by `Popover.Target`'s `withRoles`.
    expect(btn.getAttribute('aria-haspopup')).toBe('dialog');
    expect(btn.getAttribute('aria-expanded')).toBe('false');

    // It still shows the app name, and the popover is not open until asked.
    expect((btn.textContent ?? '').trim()).toBe(APP_NAME);
    await expect.element(page.getByTestId('app-block-name-popover')).not.toBeInTheDocument();
  });

  test('clicking it opens a popover with the full name, the recommend rollup and the store action', async () => {
    renderChrome();
    await page.getByTestId('app-block-breadcrumb-name').click();

    await expect.element(page.getByTestId('app-block-name-popover')).toBeInTheDocument();
    expect((await trigger()).getAttribute('aria-expanded')).toBe('true');

    // The FULL name — the crumb itself is width-capped and ellipsised.
    const full = page.getByTestId('app-block-name-popover-name').element();
    expect((full.textContent ?? '').trim()).toBe(APP_NAME);

    // The rollup, rendered through the SAME `getRecommendLabel` the store cards
    // use, so the frame and the store cannot disagree about one app's rating.
    const rec = page.getByTestId('app-block-name-popover-recommend').element();
    expect((rec.textContent ?? '').trim()).toBe('90% recommend (10)');

    await expect.element(page.getByTestId('app-block-name-popover-store-link')).toBeInTheDocument();
  });

  test.each(['{Enter}', ' '])(
    'it is keyboard-operable — focus + %s opens the popover',
    async (key) => {
      renderChrome();
      const btn = await trigger();

      // Natively focusable: no `tabIndex` shim required, so it sits in the tab order
      // between the "Marketplace" crumb link and the ⋮ trigger.
      btn.focus();
      expect(document.activeElement).toBe(btn);

      // 🔴 A REAL KEY EVENT, NOT `btn.click()`. Calling `.click()` after pressing a
      // key would pass on a `<div onClick>` too — it proves the handler runs, never
      // that a keyboard can reach it. `userEvent.keyboard` dispatches through the
      // browser, so the platform's own button activation is what turns Enter/Space
      // into the click. That is the whole claim being made.
      await userEvent.keyboard(key);

      await expect.element(page.getByTestId('app-block-name-popover')).toBeInTheDocument();
      expect((await trigger()).getAttribute('aria-expanded')).toBe('true');
    }
  );

  // 🔴 THE F0 BUG, IN ITS THIRD INCARNATION. The run page is dominated by a
  // cross-origin app iframe that SWALLOWS the mousedown, so Mantine's
  // `closeOnClickOutside` never fires and an uncontrolled dropdown is left floating
  // over the app the user just clicked into. Window `blur` is the signal that DOES
  // fire. Without `useIframeAwareMenu` this popover would hang open exactly like the
  // ⋮ menu once did.
  test('a window blur (a click landing inside the app iframe) closes the popover', async () => {
    renderChrome();
    await page.getByTestId('app-block-breadcrumb-name').click();
    await expect.element(page.getByTestId('app-block-name-popover')).toBeInTheDocument();

    window.dispatchEvent(new Event('blur'));
    await expect.element(page.getByTestId('app-block-name-popover')).not.toBeInTheDocument();

    // …and the trigger still works afterwards (the toggle is intact, not wedged).
    await page.getByTestId('app-block-breadcrumb-name').click();
    await expect.element(page.getByTestId('app-block-name-popover')).toBeInTheDocument();
  });
});

describe('the store link', () => {
  test('points at the /apps/store-preview/<slug> detail route, not the retired /apps/<appBlockId>', async () => {
    renderChrome({ appBlockId: 'ab-internal-row-id' });
    await page.getByTestId('app-block-breadcrumb-name').click();

    const link = page.getByTestId('app-block-name-popover-store-link').element();
    expect(link.tagName.toLowerCase()).toBe('a');
    expect(link.getAttribute('href')).toBe(`/apps/store-preview/${SLUG}`);
    // `/apps/<appBlockId>` is RETIRED and 302s. Pin the negative too: an href built
    // from the internal AppBlock row id would look plausible and redirect forever.
    expect(link.getAttribute('href')).not.toBe('/apps/ab-internal-row-id');
  });

  test('the listing lookup is keyed by SLUG and is lazy — it does not fire until the popover opens', async () => {
    renderChrome();
    await trigger(); // the mount has to have COMMITTED before "never called" means anything

    // 🔴 NOT CALLED AT ALL while closed — a stronger claim than "called with
    // enabled:false". The query lives inside the popover's dropdown body, which
    // Mantine does not mount until the popover opens, so laziness is STRUCTURAL
    // rather than a flag someone can get wrong.
    expect(mocks.lastQueryInput).toBeUndefined();

    await page.getByTestId('app-block-breadcrumb-name').click();
    await expect.element(page.getByTestId('app-block-name-popover')).toBeInTheDocument();

    // …and when it does run it is keyed by SLUG. `appBlockId` is the internal
    // AppBlock row id and matches NEITHER selector of `getAppDetail`.
    expect(mocks.lastQueryInput).toEqual({ slug: SLUG });
  });

  test('a slug with URL-significant characters is encoded, not interpolated raw', async () => {
    // The slug reaches the href through `getListingDetailHref`, which
    // `encodeURIComponent`s it. Asserting that here keeps the crumb from being the
    // one caller that hand-builds a path.
    mocks.detail = detailFixture({ slug: 'a b/c' });
    renderChrome({ slug: 'a b/c' });
    await page.getByTestId('app-block-breadcrumb-name').click();
    const link = page.getByTestId('app-block-name-popover-store-link').element();
    expect(link.getAttribute('href')).toBe('/apps/store-preview/a%20b%2Fc');
  });
});

describe('the popover never shows a broken or empty rating', () => {
  test('while the query is in flight it shows a loader, and NO rating and NO action', async () => {
    mocks.isLoading = true;
    mocks.detail = undefined;
    renderChrome();
    await page.getByTestId('app-block-breadcrumb-name').click();

    await expect.element(page.getByTestId('app-block-name-popover-loading')).toBeInTheDocument();
    // 🔴 A "0% recommend" flashed while the query is in flight is a false statement
    // about the app, not a loading state.
    await expect
      .element(page.getByTestId('app-block-name-popover-recommend'))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByTestId('app-block-name-popover-store-link'))
      .not.toBeInTheDocument();
    // The full name is available immediately — it comes from the host, not the query.
    const full = page.getByTestId('app-block-name-popover-name').element();
    expect((full.textContent ?? '').trim()).toBe(APP_NAME);
  });

  test('on a query error it says so and WITHHOLDS the store action', async () => {
    mocks.error = new Error('NOT_FOUND');
    mocks.detail = undefined;
    renderChrome();
    await page.getByTestId('app-block-breadcrumb-name').click();

    await expect
      .element(page.getByTestId('app-block-name-popover-unavailable'))
      .toBeInTheDocument();
    // 🔴 THE ACTION IS WITHHELD, NOT LEFT DANGLING. The same conditions that 404
    // `getAppDetail` (no listing row, unapproved, scope/deploy/maturity-gated) also
    // 404 `/apps/store-preview/<slug>`, so offering the link here would be an
    // affordance the server refuses.
    await expect
      .element(page.getByTestId('app-block-name-popover-store-link'))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByTestId('app-block-name-popover-recommend'))
      .not.toBeInTheDocument();
  });

  test('a resolved listing with no reviews reads "No reviews yet", not "0% recommend"', async () => {
    mocks.detail = detailFixture({
      recommend: { recommendedCount: 0, notRecommendedCount: 0, recommendPct: null },
      reviewCount: 0,
    });
    renderChrome();
    await page.getByTestId('app-block-breadcrumb-name').click();
    const rec = page.getByTestId('app-block-name-popover-recommend').element();
    expect((rec.textContent ?? '').trim()).toBe('No reviews yet');
    // The action still stands — the listing exists, it just has no reviews.
    await expect.element(page.getByTestId('app-block-name-popover-store-link')).toBeInTheDocument();
  });
});

describe('the whole cluster is gated on store access', () => {
  test('a viewer without store access gets the static crumb — no button, no popover, no query', async () => {
    // Every term of `hasAppsStoreAccess` off. This is the cohort the server refuses:
    // `/apps/store-preview/<slug>` returns `notFound` and `getAppDetail` throws
    // NOT_FOUND, so an interactive crumb here would be a pure dead end.
    mocks.features = {};
    renderChrome();

    await expect.element(page.getByTestId('app-block-breadcrumb-name')).toBeInTheDocument();
    const crumb = await trigger();
    expect(crumb.tagName.toLowerCase()).not.toBe('button');
    expect(crumb.getAttribute('aria-haspopup')).toBeNull();

    // …the name is still shown (the crumb keeps doing its original job) …
    expect((crumb.textContent ?? '').trim()).toBe(APP_NAME);

    // …the store query is never even instantiated for this viewer …
    expect(mocks.lastQueryInput).toBeUndefined();

    // …and clicking it does nothing at all.
    await page.getByTestId('app-block-breadcrumb-name').click();
    await expect.element(page.getByTestId('app-block-name-popover')).not.toBeInTheDocument();
  });

  test.each([
    ['appListings', { appListings: true }],
    ['appBlocks', { appBlocks: true }],
    ['appListingsPublicExternal', { appListingsPublicExternal: true }],
  ])('any single store-access term (%s) is enough to light the control', async (_term, flags) => {
    // The gate is the shared `hasAppsStoreAccess` OR, not a single flag. Pinning all
    // three arms stops a future "simplification" to one flag from silently removing
    // the affordance for the external-only cohort.
    mocks.features = flags as Record<string, boolean>;
    renderChrome();
    expect((await trigger()).tagName.toLowerCase()).toBe('button');
  });

  test('with no slug threaded the crumb stays static, even for a store-eligible viewer', async () => {
    // The model surface renders no breadcrumb at all, but a future caller that
    // renders the page chrome without a slug must degrade to text rather than offer
    // a link it cannot build.
    renderChrome({ slug: undefined });
    const crumb = await trigger();
    expect(crumb.tagName.toLowerCase()).not.toBe('button');
    expect(mocks.lastQueryInput).toBeUndefined();
  });
});

describe("F1's responsive geometry is threaded through the control, not dropped", () => {
  // These two mount `AppNameCrumb` directly: the chrome resolves `maxWidth` from a
  // live `ResizeObserver` measurement, so going through it would make the expected
  // number depend on the test viewport. The chrome→crumb wiring is covered by every
  // test above; what is under test here is that the CONTROL honours the cap.
  test('the control truncates at the resolved max-width, exactly as the static text did', async () => {
    // 🔴 COMPARED AGAINST A REFERENCE `<Text maw>`, NOT AGAINST '240px'. Mantine
    // renders `maw={240}` as `calc(15rem * var(--mantine-scale))`, so a px literal
    // here fails against correct code — and pinning that exact string instead would
    // be pinning a Mantine implementation detail that a version bump may rewrite.
    // The CLAIM is a relationship — "the control caps exactly where the static text
    // did" — so the reference node is what the assertion should be against.
    renderWithProviders(
      <>
        {/* `compact={false}` — this pair is about the DESKTOP crumb's width cap. The
            mobile shell's own geometry is covered in
            `AppBlockChromeMobileShell.browser.test.tsx`. */}
        <AppNameCrumb name={APP_NAME} slug={SLUG} maxWidth={240} compact={false} />
        <Text data-testid="ref-cap-240" truncate maw={240} />
        <Text data-testid="ref-cap-560" truncate maw={560} />
      </>
    );
    const inner = (await trigger()).querySelector('[data-truncate]') as HTMLElement | null;
    expect(inner, 'the crumb must still carry a truncating Text').not.toBeNull();

    const ref240 = page.getByTestId('ref-cap-240').element() as HTMLElement;
    const ref560 = page.getByTestId('ref-cap-560').element() as HTMLElement;

    // Positive control on the whole comparison: if Mantine emitted nothing for
    // `maw`, both references would be '' and the equality below would pass while
    // measuring nothing at all. Require a real value, and require the two DIFFERENT
    // caps to render differently.
    expect(ref240.style.maxWidth, 'Mantine emitted no max-width for maw={240}').not.toBe('');
    expect(ref240.style.maxWidth).not.toBe(ref560.style.maxWidth);

    expect((inner as HTMLElement).style.maxWidth).toBe(ref240.style.maxWidth);
  });

  test('an UNCAPPED tier (xl) sets no max-width — the wide bar is not re-capped', async () => {
    renderWithProviders(
      <AppNameCrumb name={APP_NAME} slug={SLUG} maxWidth={undefined} compact={false} />
    );
    const inner = (await trigger()).querySelector('[data-truncate]') as HTMLElement | null;
    expect(inner).not.toBeNull();
    expect((inner as HTMLElement).style.maxWidth).toBe('');
  });
});
