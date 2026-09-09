import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { MantineProvider } from '@mantine/core';
import { theme } from '~/providers/ThemeProvider';
import type * as StickerUtil from '~/components/Sticker/sticker.util';
import type * as Trpc from '~/utils/trpc';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { StickerPicker } from '~/components/Sticker/StickerPicker';

/**
 * 🔴 THE DECISION THIS FILE PINS: the picker's Popover must be PORTALLED.
 *
 * Whoever deletes `withinPortal` from StickerPicker should read this first. It
 * looks redundant because Mantine portals by default — but ThemeProvider sets
 * `Popover: { defaultProps: { withinPortal: false } }` for the whole app, so
 * without the explicit prop the dropdown renders inside whatever clips it. On
 * the image page that is the comment column's ScrollArea, and the reported
 * symptom was the top half of the picker hidden behind the Generation Info
 * panel (Freshdesk #71801).
 *
 * A z-index cannot fix that, which is why this asserts DOM position and not
 * paint order: an unportalled dropdown is a descendant of the clipping box, and
 * that is the property the fix changes.
 */
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ stickers: true }),
}));

vi.mock('~/components/Sticker/sticker.util', async (importOriginal) => ({
  ...(await importOriginal<typeof StickerUtil>()),
  // Owning nothing renders the empty state, which still mounts the dropdown —
  // and this file asserts WHERE the dropdown is, never what is in it.
  useOwnedSticker: () => ({ sticker: [], bySlug: new Map(), isLoading: false }),
}));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: {
    cosmetic: {
      getStickerBalances: { useQuery: () => ({ data: [] }) },
    },
  },
}));

const CLIPPER = 'clipping-ancestor';

/**
 * 🔴 THE REAL `theme` IS WHAT MAKES THIS TEST ABLE TO FAIL, and it is imported
 * rather than restated. `renderWithProviders` mounts a BARE MantineProvider,
 * where Mantine's own default already portals every Popover — so under it this
 * file passed identically with and without the fix. Verified by deleting
 * `withinPortal` from the component: 2 passed. Nesting the app's own theme is
 * what reproduces `withinPortal: false`, and a copy of that line here would
 * drift the day ThemeProvider changes it.
 *
 * The harness loads no app stylesheet, so a Tailwind `overflow-hidden` class
 * would be inert here — the clip is written inline for that reason.
 */
const renderInClippingBox = async () => {
  renderWithProviders(
    <MantineProvider theme={theme}>
      <div data-testid={CLIPPER} style={{ overflow: 'hidden', height: 120, width: 320 }}>
        <StickerPicker onSelect={() => undefined} />
      </div>
    </MantineProvider>
  );
  await page.getByRole('button', { name: 'Insert sticker' }).click();
  // Awaiting a state that ARRIVES and then stays: the dropdown does not tear
  // itself down, so the matcher can keep polling for it.
  const dropdown = page.getByPlaceholder('Search sticker');
  await expect.element(dropdown).toBeInTheDocument();
  return dropdown.element();
};

describe('StickerPicker escapes a clipping ancestor', () => {
  test('the open dropdown is not rendered inside the box that clips it', async () => {
    const dropdown = await renderInClippingBox();

    // Reported as the ancestor's own testid rather than as a boolean, so a
    // revert fails with the name of the box doing the clipping instead of
    // "expected true to be false".
    const clipper = dropdown.closest(`[data-testid="${CLIPPER}"]`) as HTMLElement | null;
    expect(clipper?.dataset.testid ?? null).toBe(null);
  });

  test('and it is still mounted, under document.body', async () => {
    const dropdown = await renderInClippingBox();

    // The negative above passes for free if the dropdown never rendered at all;
    // this is what makes the pair mean "portalled" rather than "absent".
    expect(document.body.contains(dropdown)).toBe(true);
  });
});
