import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
// Type-only namespace import (NOT `typeof import('...')`, which
// @typescript-eslint/consistent-type-imports rejects) so the spread below keeps
// the real module's type.
import type * as TrpcMod from '~/utils/trpc';

/**
 * Regression: the DOUBLE RULE under the `/apps` sub-nav.
 *
 * `AppsPageLayout` wrapped its header band in a `borderBottom` hairline, and
 * Mantine's `Tabs.List` (inside `AppsSubNav`) already draws its OWN bottom
 * border — so every `/apps` page rendered two parallel lines ~8px apart under
 * the tabs. The band's rule is gone; the tabs' rule is the separator.
 *
 * These assert BOTH sides. "The band has no border" alone would also pass if
 * someone deleted the tabs' border instead (leaving no separator at all), so the
 * tabs' rule is pinned as present in the same test.
 */

vi.mock('~/providers/FeatureFlagsProvider', () => ({ useFeatureFlags: () => ({ appBlocks: true }) }));
vi.mock('~/providers/IsClientProvider', () => ({ useIsClient: () => true }));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));
// Spread the REAL module and override only `trpc` (local-rules/no-wholesale-
// module-mock): a hand-written replacement silently breaks every importer the day
// '~/utils/trpc' grows an export this factory omits — the whole FILE then fails to
// load with 0 tests collected and no failing assertion.
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  trpc: { blocks: { getNavSummary: { useQuery: () => ({ data: undefined }) } } },
}));

const { AppsPageLayout } = await import('./AppsPageLayout');

/** The header band = the element that directly contains the sub-nav `<nav>`. */
function headerBand(): HTMLElement {
  const nav = document.querySelector('nav[aria-label="App sections"]');
  return nav?.parentElement as HTMLElement;
}

/**
 * ⚠️ The harness does NOT load `@mantine/core/styles.css` — component tests
 * render against Mantine's INLINE per-instance styles only. So `getComputedStyle`
 * cannot see anything a Mantine stylesheet rule supplies (`Tabs.List`'s own
 * bottom border, `Stack`'s `gap` resolved from `--stack-gap`, …), and an
 * assertion on those measures nothing. What IS observable here is exactly what
 * the component wrote inline — which is where the removed border lived
 * (`style={(theme) => ({ borderBottom: … })}`) and where the spacing tokens live
 * (`--stack-gap`). The stylesheet-dependent half of the claim (the tabs still
 * draw the one remaining rule) is pinned as a SOURCE guard in the blocking node
 * suite instead — see `__tests__/appsPageLayout.test.ts`.
 */
describe('AppsPageLayout — exactly ONE rule under the tabs', () => {
  test('the header band writes NO bottom border of its own (no-header page)', async () => {
    renderWithProviders(
      <AppsPageLayout>
        <div data-testid="body">body</div>
      </AppsPageLayout>
    );
    await expect.element(page.getByTestId('body')).toBeInTheDocument();

    const band = headerBand();
    // Guard the guard — a null band would make the assertion below vacuous.
    expect(band).toBeTruthy();
    // The removed rule was an INLINE style, so this is directly mutation-
    // sensitive: restoring it puts `1px solid …` back on `style.borderBottom`.
    expect(band.style.borderBottom).toBe('');
    expect(band.style.borderBottomWidth).toBe('');
  });

  test('the same holds on a page WITH a header (title/actions render inside the band)', async () => {
    renderWithProviders(
      <AppsPageLayout title="Your installed apps" subtitle="Manage them" actions={<button>Act</button>}>
        <div data-testid="body">body</div>
      </AppsPageLayout>
    );
    await expect
      .element(page.getByRole('heading', { name: 'Your installed apps' }))
      .toBeInTheDocument();
    expect(headerBand().style.borderBottom).toBe('');
  });

  test('SPACING: the band groups by PROXIMITY — tighter inside than to the body', async () => {
    // With the rule gone, proximity is the whole replacement for the removed
    // line, so it is asserted rather than assumed: `md` (16px) between the tabs
    // and the title INSIDE the band, vs `xl` (32px) from the band to the content
    // — a 2:1 contrast. It was `lg` (20px) first; a 1440 render showed that 20
    // vs 16 is four pixels and groups nothing, so the outer gap was widened.
    // Read off the inline `--stack-gap` custom properties Mantine writes, which
    // survive the missing stylesheet.
    renderWithProviders(
      <AppsPageLayout title="Your installed apps">
        <div data-testid="body">body</div>
      </AppsPageLayout>
    );
    await expect.element(page.getByTestId('body')).toBeInTheDocument();

    const band = headerBand();
    const outer = band.parentElement as HTMLElement;
    expect(band.style.getPropertyValue('--stack-gap')).toBe('var(--mantine-spacing-md)');
    expect(outer.style.getPropertyValue('--stack-gap')).toBe('var(--mantine-spacing-xl)');

    // …and the band's own BOTTOM padding is gone, so the header group hugs the
    // tabs it belongs to instead of sitting equidistant. (`pt="sm"`, no `pb`.)
    expect(band.style.paddingTop).not.toBe('');
    expect(band.style.paddingBottom).toBe('');
  });
});
