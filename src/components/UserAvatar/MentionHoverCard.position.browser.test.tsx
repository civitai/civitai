import { describe, expect, test, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { renderWithProviders } from '../../../test/component-setup';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';

vi.mock('~/providers/BrowserSettingsProvider', () => ({
  useBrowsingSettings: (select: (s: { blurNsfw: boolean }) => unknown) =>
    select({ blurNsfw: false }),
}));

vi.mock('~/components/Sticker/sticker.util', async (orig) => ({
  ...(await orig<object>()),
  useStickerCosmetics: () => ({ sticker: {} }),
}));

vi.mock('~/components/UserAvatar/UserHoverCard', async (orig) => ({
  ...(await orig<object>()),
  useHoverCapable: () => true,
  HoverCreatorCard: () => <div data-testid="creator-card">card</div>,
}));

// The page's `.scroll-area` sets `will-change: transform`, which makes it the containing block
// of `position: fixed` descendants. The test loads no stylesheet, so the same thing is built
// inline: a scrolled box with that property around a mention that sits below the fold.
describe('mention card anchor inside a transformed scroll area', () => {
  test('is positioned over the mention, not offset by the scroll', async () => {
    await renderWithProviders(
      <div
        data-testid="scroller"
        style={{ willChange: 'transform', overflow: 'auto', height: 200, position: 'relative' }}
      >
        <div style={{ height: 600 }} />
        <RenderHtml
          html={'<p><span data-type="mention" data-id="1" data-label="Alpha">@Alpha</span></p>'}
        />
        <div style={{ height: 600 }} />
      </div>
    );
    const scroller = document.querySelector<HTMLElement>('[data-testid="scroller"]')!;
    const mention = document.querySelector<HTMLElement>('[data-type="mention"]')!;
    scroller.scrollTop = 550;
    await expect.poll(() => scroller.scrollTop).toBe(550);

    await userEvent.hover(mention);
    await expect
      .poll(() => document.querySelector('[data-testid="creator-card"]'), { timeout: 5000 })
      .not.toBeNull();

    const anchor = document.querySelector<HTMLElement>('div[style*="position: fixed"]')!;
    expect(anchor).not.toBeNull();
    const a = anchor.getBoundingClientRect();
    const m = mention.getBoundingClientRect();
    expect(Math.abs(a.top - m.top)).toBeLessThan(2);
    expect(Math.abs(a.left - m.left)).toBeLessThan(2);
    // Parked over the mention it would swallow the hover that keeps the card open.
    expect(getComputedStyle(anchor).pointerEvents).toBe('none');
  });
});
