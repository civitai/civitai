// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type * as StickerUtil from '~/components/Sticker/sticker.util';
import type * as Trpc from '~/utils/trpc';

/**
 * 🔴 THE PICKER'S POPOVER MUST STAY PORTALLED — do not delete `withinPortal`.
 *
 * It looks redundant, because Mantine portals by default. It is not:
 * `ThemeProvider` turns portalling OFF for every Popover in the app, and every
 * surface that mounts this picker sits in something that clips — on the image
 * page the comment column is a ScrollArea. Unportalled, the dropdown draws
 * inside that box and its top half is cut off behind the Generation data panel,
 * which is the reported bug (Freshdesk #71801). A z-index cannot reach a clip,
 * so this asserts DOM position and not paint order.
 *
 * Lives in the `unit` project rather than beside the browser tests because no CI
 * job runs the `component` project — a browser test here would be a local pin
 * only.
 */
const CLIPPER = 'clipping-ancestor';

vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ stickers: true }),
}));

// Spread rather than hand-listed: a factory replaces the module, so the day
// `sticker.util` gains an export this file omits, the import fails and the whole
// file collects zero tests — silently green.
vi.mock('~/components/Sticker/sticker.util', async (importOriginal) => ({
  ...(await importOriginal<typeof StickerUtil>()),
  // Owning nothing still mounts the dropdown, and this file asserts only WHERE
  // the dropdown is.
  useOwnedSticker: () => ({ sticker: [], bySlug: new Map(), isLoading: false }),
}));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: { cosmetic: { getStickerBalances: { useQuery: () => ({ data: [] }) } } },
}));

import { MantineProvider } from '@mantine/core';
import { StickerPicker } from '~/components/Sticker/StickerPicker';
import { theme } from '~/providers/ThemeProvider';

const render = async () => {
  const container = document.createElement('div');
  container.dataset.testid = CLIPPER;
  container.style.overflow = 'hidden';
  document.body.appendChild(container);
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  await act(async () => {
    createRoot(container).render(
      createElement(
        MantineProvider,
        // The APP's theme, not a bare provider. Under a bare one Mantine's own
        // default already portals, and this file passed with the fix deleted.
        { theme },
        createElement(StickerPicker, { onSelect: () => undefined })
      )
    );
  });
  return container;
};

describe('the sticker picker escapes whatever clips it', () => {
  it('has an app default that would clip it — the precondition this file rests on', () => {
    // Asserted rather than assumed: remove the app-wide default and every other
    // assertion here goes vacuous without printing anything.
    expect(theme.components?.Popover?.defaultProps?.withinPortal).toBe(false);
  });

  it('renders its open dropdown outside the clipping ancestor', async () => {
    const container = await render();
    const toggle = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Insert sticker"]'
    );
    if (!toggle) throw new Error('the picker toggle is not rendered');
    await act(async () => {
      toggle.click();
    });

    const dropdown = document.querySelector<HTMLElement>('input[placeholder="Search sticker"]');
    // Proves the dropdown opened at all, so the containment assertion below
    // cannot pass merely by nothing having rendered.
    expect(dropdown).not.toBeNull();

    // Reported as the ancestor's own testid so a revert names the box doing the
    // clipping, rather than printing "expected true to be false".
    const clipper = dropdown?.closest<HTMLElement>(`[data-testid="${CLIPPER}"]`) ?? null;
    expect(clipper?.dataset.testid ?? null).toBe(null);
  });
});
