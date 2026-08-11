import { describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { StickerCountChip } from '~/components/Sticker/StickerCountChip';

/**
 * The empty state is the whole point of the chip, and it is one ternary away
 * from rendering `0` — which is what the detail view showed before, and reads as
 * a fact about the image rather than an invitation to place something.
 */
describe('StickerCountChip', () => {
  test('says the word at zero, and never the number', async () => {
    renderWithProviders(
      <StickerCountChip count={0} revealed={false} tooltip="Place a sticker" onClick={vi.fn()} />
    );

    await expect.element(page.getByText('stickers')).toBeVisible();
    // A count of zero rendered as a numeral is the regression this guards.
    expect(page.getByText('0').elements()).toHaveLength(0);
  });

  test('says the number when there are stickers, and never the word', async () => {
    renderWithProviders(
      <StickerCountChip count={3} revealed={false} tooltip="Show stickers" onClick={vi.fn()} />
    );

    await expect.element(page.getByText('3')).toBeVisible();
    expect(page.getByText('stickers').elements()).toHaveLength(0);
  });

  test('hands the press to the surface, which decides what a press means', async () => {
    const onClick = vi.fn();
    renderWithProviders(
      <StickerCountChip count={0} revealed={false} tooltip="Place a sticker" onClick={onClick} />
    );

    await userEvent.click(page.getByText('stickers'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
