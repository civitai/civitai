import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import type * as BrowserSettingsProvider from '~/providers/BrowserSettingsProvider';
import type * as CurrentUser from '~/hooks/useCurrentUser';
import type * as TrpcModule from '~/utils/trpc';
import { renderWithProviders } from '../../../test/component-setup';
// The real stylesheet, so the overlay is laid out as it ships and the Show button below is
// clicked the way a moderator clicks it (without it Playwright never finds it actionable).
import '~/styles/globals.css';

/**
 * Click-to-reveal on the moderator review surfaces — the REAL `ImageGuard2` underneath, not a
 * stub, so the overlay, the Show button and the per-image reveal state are the site's own.
 *
 * Levels: PG-13 = 2, R = 4, XXX = 16. Image ids 201 / 202 / 203, distinct from every constant.
 */

const { flags } = vi.hoisted(() => ({ flags: { canViewNsfw: false } }));

vi.mock('~/hooks/useCurrentUser', async (importOriginal) => ({
  ...(await importOriginal<typeof CurrentUser>()),
  useCurrentUser: () => ({ id: 1, isModerator: true }),
}));
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ appBlocks: true, canViewNsfw: flags.canViewNsfw }),
  useOptionalFeatureFlags: () => ({ appBlocks: true, canViewNsfw: flags.canViewNsfw }),
  useFeatureFlagsReady: () => true,
  FeatureFlagsProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock('~/providers/BrowserSettingsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowserSettingsProvider>()),
  useBrowsingSettings: () => false,
}));
vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../test/trpcProxyStub');
  return { ...(await importOriginal<typeof TrpcModule>()), trpc: makeTrpcProxy() };
});

import { ReviewMediaReveal } from '~/components/Apps/ReviewMediaReveal';
import { BrowsingModeOverrideCtx } from '~/components/BrowsingLevel/BrowsingLevelProvider';

const R = 4;
const PG13 = 2;
const XXX = 16;

function Media({ label }: { label: string }) {
  return <span data-testid="media">{label}</span>;
}

const revealedState = () =>
  page
    .getByTestId('reveal')
    .element()
    .querySelector('[data-revealed]')
    ?.getAttribute('data-revealed');

beforeEach(() => {
  flags.canViewNsfw = false;
});

describe('ReviewMediaReveal', () => {
  test('🔴 on civitai.com an R image is blurred until the moderator clicks Show', async () => {
    renderWithProviders(
      <ReviewMediaReveal image={{ imageId: 201, nsfwLevel: R }} testId="reveal">
        <Media label="r-image" />
      </ReviewMediaReveal>
    );
    await expect.element(page.getByText('This image is rated')).toBeVisible();
    expect(revealedState()).toBe('false');
    const blurred = page.getByTestId('reveal').element().querySelector('[data-revealed]');
    expect((blurred as HTMLElement).style.filter).toContain('blur');

    await page.getByRole('button', { name: 'Show' }).click();
    await expect.poll(revealedState).toBe('true');
    expect(
      (page.getByTestId('reveal').element().querySelector('[data-revealed]') as HTMLElement).style
        .filter
    ).toBe('');
  });

  test('🔴 it blurs even for a moderator whose own setting turns blurring off', async () => {
    // `ImageGuard2` alone follows the viewer's blur preference: with no blurred levels it shows
    // mature media at once. The review pins the blur regardless.
    renderWithProviders(
      <BrowsingModeOverrideCtx.Provider value={{ userBrowsingLevel: 31, blurLevels: 0 }}>
        <ReviewMediaReveal image={{ imageId: 202, nsfwLevel: XXX }} testId="reveal">
          <Media label="xxx-image" />
        </ReviewMediaReveal>
      </BrowsingModeOverrideCtx.Provider>
    );
    await expect.element(page.getByText('This image is rated')).toBeVisible();
    expect(revealedState()).toBe('false');
  });

  test('🔴 a composite level carrying R is held back too — the guard agrees with the wrapper', async () => {
    renderWithProviders(
      <ReviewMediaReveal image={{ imageId: 204, nsfwLevel: 1 | R }} testId="reveal">
        <Media label="pg-and-r-image" />
      </ReviewMediaReveal>
    );
    await expect.element(page.getByText('This image is rated')).toBeVisible();
    expect(revealedState()).toBe('false');
  });

  test('🔴 a Blocked-level image is held back too', async () => {
    renderWithProviders(
      <ReviewMediaReveal image={{ imageId: 205, nsfwLevel: 32 }} testId="reveal">
        <Media label="blocked-image" />
      </ReviewMediaReveal>
    );
    await expect.element(page.getByText('This image is rated')).toBeVisible();
    expect(revealedState()).toBe('false');
  });

  test('a PG-13 image is shown as it is (only levels above PG-13 are held back)', async () => {
    renderWithProviders(
      <ReviewMediaReveal image={{ imageId: 203, nsfwLevel: PG13 }} testId="reveal">
        <Media label="pg13-image" />
      </ReviewMediaReveal>
    );
    await expect.element(page.getByTestId('media')).toBeVisible();
    expect(page.getByTestId('reveal').query()).toBeNull();
  });

  test('on a host that shows mature content the R image is shown as it is', async () => {
    flags.canViewNsfw = true;
    renderWithProviders(
      <ReviewMediaReveal image={{ imageId: 201, nsfwLevel: R }} testId="reveal">
        <Media label="r-image" />
      </ReviewMediaReveal>
    );
    await expect.element(page.getByTestId('media')).toBeVisible();
    expect(page.getByTestId('reveal').query()).toBeNull();
    expect(page.getByText('This image is rated').query()).toBeNull();
  });

  test('🔴 while held back, nothing inside can be reached by keyboard; after Show it can', async () => {
    // A focusable child stayed reachable by Tab under the blur, and Enter opened its
    // full-size viewer: the reveal was bypassable without clicking Show.
    const onOpen = vi.fn();
    renderWithProviders(
      <div>
        <button type="button">before</button>
        <ReviewMediaReveal image={{ imageId: 206, nsfwLevel: R }} testId="reveal">
          <button type="button" data-testid="inner" onClick={onOpen}>
            open-full-size
          </button>
        </ReviewMediaReveal>
        <button type="button">after</button>
      </div>
    );
    await expect.element(page.getByText('This image is rated')).toBeVisible();
    const inner = page.getByTestId('inner').element() as HTMLButtonElement;
    const held = page.getByTestId('reveal').element().querySelector('[data-revealed]');

    // A Tab sweep from before the block to past it never lands inside the held-back subtree.
    (page.getByRole('button', { name: 'before' }).element() as HTMLElement).focus();
    const focused: string[] = [];
    for (let i = 0; i < 4; i++) {
      await userEvent.keyboard('{Tab}');
      const active = document.activeElement as HTMLElement | null;
      expect(held?.contains(active)).toBe(false);
      focused.push(active?.textContent?.trim() ?? '');
    }
    // Positive control on the sweep itself: it did move, through the Show button, past the block.
    expect(focused).toContain('after');
    expect(focused).toContain('Show');
    // Nor can it be focused directly, so Enter has nothing to activate.
    inner.focus();
    expect(document.activeElement).not.toBe(inner);
    await userEvent.keyboard('{Enter}');
    expect(onOpen).not.toHaveBeenCalled();

    await page.getByRole('button', { name: 'Show' }).click();
    await expect.poll(revealedState).toBe('true');
    inner.focus();
    expect(document.activeElement).toBe(inner);
    await userEvent.keyboard('{Enter}');
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  test('`explain: false` blurs without the overlay (a thumbnail too small for it)', async () => {
    renderWithProviders(
      <ReviewMediaReveal image={{ imageId: 202, nsfwLevel: XXX }} explain={false} testId="reveal">
        <Media label="xxx-thumb" />
      </ReviewMediaReveal>
    );
    await expect.element(page.getByTestId('media')).toBeInTheDocument();
    expect(revealedState()).toBe('false');
    expect(page.getByText('This image is rated').query()).toBeNull();
  });
});
