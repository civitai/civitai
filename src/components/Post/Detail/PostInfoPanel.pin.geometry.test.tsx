import clsx from 'clsx';
import { describe, expect, test } from 'vitest';
import { nextLayout, renderAtViewport } from '../../../../test/geometry-setup';
import { POST_INFO_PANEL_PIN } from '~/components/Post/Detail/postInfoPanelPin';

// The page body scrolls inside the app's `.scroll-area` (its `will-change: transform` is the
// reason the panel is sticky, see postInfoPanelPin.ts), and the panel is a flex item of the row.
function Page() {
  return (
    <div
      className="scroll-area @container"
      style={{ height: 600, overflowY: 'auto' }}
      data-testid="scroller"
    >
      <div className="flex flex-col items-center px-3">
        <div style={{ width: '100%', height: 2000 }} />
        <div className={clsx(POST_INFO_PANEL_PIN, 'h-28')} data-testid="panel" />
      </div>
    </div>
  );
}

const scroller = () => document.querySelector<HTMLElement>('[data-testid="scroller"]')!;
const panel = () => document.querySelector<HTMLElement>('[data-testid="panel"]')!;

describe('post info panel on a phone', () => {
  test.each([0, 700, 1200])('stays at the bottom of the scrollport at scroll %i', async (top) => {
    await renderAtViewport(<Page />);
    scroller().scrollTo(0, top);
    await nextLayout();
    expect(scroller().scrollTop).toBe(top);
    expect(Math.round(panel().getBoundingClientRect().bottom)).toBe(
      Math.round(scroller().getBoundingClientRect().bottom)
    );
  });

  test('spans the full width, through the row gutters', async () => {
    await renderAtViewport(<Page />);
    const box = panel().getBoundingClientRect();
    expect(Math.round(box.width)).toBe(Math.round(scroller().clientWidth));
  });
});
