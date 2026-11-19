import { useRef } from 'react';
import type { CSSProperties } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { StickerAttributionHoverCard } from '~/components/Sticker/StickerAttributionHoverCard';

// Harness loads no Tailwind/Mantine CSS; placement needs `.fixed` and the dropdown's `absolute`.
const stylesheet = document.createElement('style');
stylesheet.textContent = `.fixed { position: fixed; } .mantine-Popover-dropdown { position: absolute; }`;
document.head.append(stylesheet);

// The real hook reads `(hover: hover)`, which an earlier file's touch emulation can leave false.
vi.mock('~/components/UserAvatar/UserHoverCard', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useHoverCapable: () => true,
}));

vi.mock('~/components/Sticker/sticker-attribution.util', () => ({
  useStickerAttribution: () => ({
    sticker: { name: 'Wave', shopHref: null, creatorId: null },
    blocked: false,
    isLoading: false,
  }),
}));

function Thread({ style, above }: { style?: CSSProperties; above?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div style={style}>
      {above && <div data-testid="above" style={{ height: 20 }} />}
      <div ref={ref}>
        <p style={{ margin: 0 }}>
          Lovely image{' '}
          <span data-type="sticker" data-id="7" data-testid="sticker">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              alt=":wave:"
              style={{ display: 'inline-block', width: 22, height: 22, background: 'red' }}
            />
          </span>
        </p>
      </div>
      <StickerAttributionHoverCard containerRef={ref} />
    </div>
  );
}

const dropdown = () => document.querySelector<HTMLElement>('.mantine-Popover-dropdown');

const openCard = async () => {
  await userEvent.hover(page.getByTestId('sticker').element());
  await vi.waitFor(() => expect(dropdown()).not.toBeNull(), { timeout: 5000 });
  // Floating UI places the card after it mounts; wait for a position to land.
  await vi.waitFor(() => expect(dropdown()!.getBoundingClientRect().top).toBeGreaterThan(0));
};

const sticker = () => document.querySelector('[data-testid="sticker"]')!.getBoundingClientRect();

// Position `bottom-start`, 4px offset plus the arrow: comfortably inside this.
const NEAR = 24;
const expectCardOnSticker = () => {
  const card = dropdown()!.getBoundingClientRect();
  const target = sticker();
  expect(Math.abs(card.top - target.bottom)).toBeLessThanOrEqual(NEAR);
  expect(Math.abs(card.left - target.left)).toBeLessThanOrEqual(NEAR);
};

describe('sticker attribution card anchoring', () => {
  test('opens at its sticker', async () => {
    await renderWithProviders(<Thread style={{ marginTop: 120, marginLeft: 80 }} />);
    await openCard();
    expectCardOnSticker();
  });

  test('opens at its sticker inside an ancestor that has a transform', async () => {
    await renderWithProviders(
      <Thread style={{ transform: 'translate(0, 0)', marginTop: 300, marginLeft: 200 }} />
    );
    await openCard();
    expectCardOnSticker();
  });

  test('follows its sticker when content above grows while the card is open', async () => {
    await renderWithProviders(<Thread above style={{ marginTop: 40, marginLeft: 80 }} />);
    await openCard();
    // Onto the card: the sticker's mouseout no longer closes it.
    await userEvent.hover(dropdown()!);
    const gap = () => dropdown()!.getBoundingClientRect().top - sticker().bottom;
    const before = gap();
    // Small enough that the card stays under the pointer, so nothing here depends on the
    // browser synthesising a mouseleave after a layout shift.
    const GROW = 12;
    expect(dropdown()!.getBoundingClientRect().height).toBeGreaterThan(GROW * 4);
    document.querySelector<HTMLElement>('[data-testid="above"]')!.style.height = `${20 + GROW}px`;
    // Left in place, the card would sit GROW px closer to the sticker than it opened.
    await vi.waitFor(() => expect(Math.abs(gap() - before)).toBeLessThanOrEqual(1), {
      timeout: 5000,
    });
    expectCardOnSticker();
  });
});
