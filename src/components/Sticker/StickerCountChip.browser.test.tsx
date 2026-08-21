import { describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { StickerCountChip } from '~/components/Sticker/StickerCountChip';

/**
 * The empty state is the whole point of the chip, and it is one ternary away
 * from rendering `0` — which is what the detail view showed before, and reads as
 * a fact about the image rather than an invitation to place something.
 *
 * Assertions read the element synchronously after mount rather than through
 * `expect.element`. Both catch the same regressions, but a poll spends the whole
 * 15 s matcher budget before reporting a state that was never going to arrive;
 * these fail in milliseconds.
 */
/**
 * Await the button's *existence* once — that state arrives, so the poll settles
 * immediately — then read everything else synchronously off the element. What
 * must not be polled is the text or the colour: those are states that either
 * are or are not correct at first paint, and awaiting one spends the full 15 s
 * budget waiting for something that was never going to change.
 */
const chip = async () => {
  await expect.element(page.getByRole('button')).toBeInTheDocument();
  return page.getByRole('button').element();
};
const backgroundOf = (element: Element) => getComputedStyle(element).backgroundColor;

describe('StickerCountChip', () => {
  test('shows the icon alone at zero — no word, and never the number', async () => {
    renderWithProviders(
      <StickerCountChip
        count={0}
        revealed={false}
        ariaLabel="No stickers yet"
        tooltip="Place a sticker"
        onClick={vi.fn()}
      />
    );

    const text = (await chip()).textContent;
    // The word "stickers" was the widest thing in a row that has to fit beside
    // the reaction buttons on a phone, and the icon already says it.
    expect(text).not.toContain('sticker');
    // A count of zero rendered as a numeral is the older regression this guards.
    expect(text).not.toContain('0');
    // 🔴 But the accessible name still spells it out. Dropping a word to save
    // space is a layout decision and must not reach a screen reader.
    expect(page.getByRole('button', { name: 'No stickers yet' }).elements()).toHaveLength(1);
  });

  test('says the number when there are stickers', async () => {
    renderWithProviders(
      <StickerCountChip count={3} revealed={false} tooltip="Show stickers" onClick={vi.fn()} />
    );

    expect((await chip()).textContent).toContain('3');
  });

  test('renders the bare number, whatever the count', async () => {
    renderWithProviders(
      <>
        <StickerCountChip count={1} revealed={false} tooltip="Show" onClick={vi.fn()} />
        <StickerCountChip count={4} revealed={false} tooltip="Show" onClick={vi.fn()} />
      </>
    );

    // No singular/plural to get right any more, because there is no noun: the
    // chip is the icon and the number, and nothing else.
    // The FACE of the chip is the number alone; the accessible name still
    // carries the noun, and gets the singular right.
    await expect.element(page.getByRole('button', { name: /^1 sticker$/ })).toBeInTheDocument();
    expect(page.getByRole('button', { name: /^4 stickers$/ }).elements()).toHaveLength(1);
    expect(page.getByRole('button', { name: /^1 stickers$/ }).elements()).toHaveLength(0);
    // Nothing rendered says it, though — that is the space this saves.
    expect(page.getByText(/sticker/i).elements()).toHaveLength(0);
  });

  /**
   * The reason this is asserted on rendered pixels rather than on the `color`
   * prop: the surfaces that mount this pass a `buttonStyling` whose inline
   * `style` beats Mantine's `var(--button-bg)` class rule, so `color="yellow"`
   * alone computes a variable nothing reads and the empty state renders in the
   * reaction row's grey. Reading the prop would have called that a pass.
   */
  test('renders the empty state in a different colour from the counted state', async () => {
    // Both at once, so the comparison is between two elements that exist in the
    // same document under the same stylesheet rather than across two mounts.
    renderWithProviders(
      <>
        <StickerCountChip count={0} revealed={false} tooltip="Place a sticker" onClick={vi.fn()} />
        <StickerCountChip count={3} revealed={false} tooltip="Show stickers" onClick={vi.fn()} />
      </>
    );

    // Anchored on the counted chip, whose name survives any regression in the
    // empty state — anchoring on "stickers" would make a lost empty state a 15 s
    // poll here instead of the millisecond failure it already is above.
    await expect.element(page.getByRole('button', { name: /^3 stickers$/ })).toBeInTheDocument();
    const empty = backgroundOf(page.getByRole('button', { name: /^stickers$/ }).element());
    const counted = backgroundOf(page.getByRole('button', { name: /^3 stickers$/ }).element());

    expect(empty).not.toBe(counted);
    expect(empty).not.toBe('rgba(0, 0, 0, 0)');
  });

  test('survives a surface that supplies its own inline background', async () => {
    renderWithProviders(
      <StickerCountChip
        count={0}
        revealed={false}
        tooltip="Place a sticker"
        onClick={vi.fn()}
        // What `ReactionSettingsProvider` hands the reaction row on the image
        // detail view. If the chip lets this win, the invitation is grey.
        buttonProps={{ style: { color: 'white', background: 'rgba(52, 58, 64, 0.4)' } }}
      />
    );

    expect(backgroundOf(await chip())).not.toBe('rgba(52, 58, 64, 0.4)');
  });

  test('keeps a className the surface passes alongside one in buttonProps', async () => {
    renderWithProviders(
      <StickerCountChip
        count={3}
        revealed={false}
        tooltip="Show stickers"
        onClick={vi.fn()}
        className="pointer-events-auto"
        buttonProps={{ className: 'from-the-row' }}
      />
    );

    const classes = (await chip()).className;
    expect(classes).toContain('pointer-events-auto');
    expect(classes).toContain('from-the-row');
  });

  /**
   * On a feed card there is no `ReactionSettingsProvider`, so no inline style —
   * `variant` is the only thing painting the revealed state, and the chip is the
   * card's whole on/off indication.
   *
   * Asserted on `data-variant` rather than computed colour on purpose: the
   * `component` project never imports `@mantine/core/styles.layer.css` (only
   * `_app.tsx` does), so Mantine sets `--button-bg` and nothing consumes it.
   * Every variant computes to the same UA default background here, which makes
   * a colour assertion silently blind to this exact regression.
   */
  test('paints the revealed state on a card, where nothing else does', async () => {
    renderWithProviders(
      <>
        <StickerCountChip count={3} revealed tooltip="Hide" onClick={vi.fn()} />
        <StickerCountChip count={5} revealed={false} tooltip="Show" onClick={vi.fn()} />
      </>
    );

    await expect.element(page.getByRole('button', { name: /^3 stickers$/ })).toBeInTheDocument();
    expect(
      page
        .getByRole('button', { name: /^3 stickers$/ })
        .element()
        .getAttribute('data-variant')
    ).toBe('light');
    expect(
      page
        .getByRole('button', { name: /^5 stickers$/ })
        .element()
        .getAttribute('data-variant')
    ).toBe('subtle');
  });

  test('paints the empty state as its own thing, not as the revealed state', async () => {
    renderWithProviders(
      <>
        <StickerCountChip count={0} revealed={false} tooltip="Place" onClick={vi.fn()} />
        <StickerCountChip count={5} revealed={false} tooltip="Show" onClick={vi.fn()} />
      </>
    );

    await expect.element(page.getByRole('button', { name: /^5 stickers$/ })).toBeInTheDocument();
    const empty = page.getByRole('button', { name: /^stickers$/ }).element() as HTMLElement;

    expect(empty.getAttribute('data-variant')).toBe('light');
    expect(empty.style.getPropertyValue('--button-bg')).toContain('yellow');
  });

  test('hands the press to the surface, which decides what a press means', async () => {
    const onClick = vi.fn();
    renderWithProviders(
      <StickerCountChip count={0} revealed={false} tooltip="Place a sticker" onClick={onClick} />
    );

    await userEvent.click(page.getByRole('button'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
