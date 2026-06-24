import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import type { AvailableBlock } from '~/server/schema/blocks/subscription.schema';

/**
 * App Blocks marketplace CARD — component tests for the Install/Open-app CTA gate.
 *
 * Load-bearing behaviour: the "Install"/"Manage" CTA is shown ONLY for apps that
 * install into a model/in-context slot. A PAGE app (target slot `app.page`,
 * installModel `'none'`) is stateless — it has no install row and the slot
 * install path is server-gated dark (#2622) — so its card shows ONLY "Open app".
 *
 * The predicate is `isPageSlot(targetSlotId)` (slot-registry, the single source
 * of truth), keyed on the APP's slot, NOT the viewer — so a model-slot app still
 * shows Install for the grandfathered mod audience.
 */

// LoginRedirect just clones its child with an onClick wrapper (pulls in router +
// tour context we don't need). Stub it to a pass-through so the child's own
// onClick runs directly — keeps the card test network-free.
vi.mock('~/components/LoginRedirect/LoginRedirect', () => ({
  LoginRedirect: ({ children }: { children: React.ReactElement }) => children,
}));

// Import AFTER the mocks are declared (vi.mock is hoisted, imports are not).
const { AppBlockCard } = await import('./AppBlockCard');

function makeBlock(slotId: string, overrides: Partial<AvailableBlock> = {}): AvailableBlock {
  return {
    id: 'app-1',
    blockId: 'my-block',
    appId: 'app-1',
    appName: 'My App',
    manifest: {
      name: 'My App',
      description: 'Does a thing.',
      targets: [{ slotId }],
      // Page apps declare a page; the "Open app" affordance also needs canOpenPage.
      hasPage: slotId === 'app.page',
    },
    installCount: 3,
    category: null,
    scopesSummary: [],
    avgRating: null,
    reviewCount: 0,
    ...overrides,
  };
}

const onOpen = vi.fn();

beforeEach(() => {
  onOpen.mockClear();
});

describe('AppBlockCard install CTA gate', () => {
  test('page app (app.page slot) shows "Open app", NOT Install/Manage', async () => {
    renderWithProviders(
      <AppBlockCard
        block={makeBlock('app.page')}
        alreadySubscribed={false}
        onOpen={onOpen}
        canOpenPage
      />
    );

    await expect.element(page.getByRole('link', { name: /open app/i })).toBeInTheDocument();
    // The dead/forbidden install action is gone for a page app.
    expect(page.getByRole('button', { name: /^install$/i }).query()).toBeNull();
    expect(page.getByRole('button', { name: /^manage$/i }).query()).toBeNull();
  });

  test('page app shows "Open app" even when alreadySubscribed (no "Manage" leak)', async () => {
    renderWithProviders(
      <AppBlockCard
        block={makeBlock('app.page')}
        alreadySubscribed
        onOpen={onOpen}
        canOpenPage
      />
    );

    await expect.element(page.getByRole('link', { name: /open app/i })).toBeInTheDocument();
    expect(page.getByRole('button', { name: /^manage$/i }).query()).toBeNull();
  });

  test('model-slot app renders "Install" and fires onOpen', async () => {
    renderWithProviders(
      <AppBlockCard
        block={makeBlock('model.sidebar_top')}
        alreadySubscribed={false}
        onOpen={onOpen}
      />
    );

    const install = page.getByRole('button', { name: /^install$/i });
    await expect.element(install).toBeInTheDocument();
    // No page → no "Open app" for a model-slot app.
    expect(page.getByRole('link', { name: /open app/i }).query()).toBeNull();

    await install.click();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  test('model-slot app already subscribed renders "Manage"', async () => {
    renderWithProviders(
      <AppBlockCard
        block={makeBlock('model.below_images')}
        alreadySubscribed
        onOpen={onOpen}
      />
    );

    await expect.element(page.getByRole('button', { name: /^manage$/i })).toBeInTheDocument();
    expect(page.getByRole('button', { name: /^install$/i }).query()).toBeNull();
  });
});
