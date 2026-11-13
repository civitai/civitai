import { describe, expect, it } from 'vitest';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { box, nextLayout, PHONE_VIEWPORT, renderAtViewport } from '../../../test/geometry-setup';
import { RemovedImagesView } from '~/components/CreatorJourney/RemovedImagesList';

const ROWS = 30;
const removed = {
  total: ROWS,
  truncated: false,
  items: Array.from({ length: ROWS }, (_, i) => ({
    removedAt: new Date(Date.UTC(2026, 0, ROWS - i)),
    reason: 'Terms of Service violation',
    imageId: null,
    canAppeal: false,
  })),
};

describe('RemovedImagesView with more rows than fit', () => {
  it('scrolls inside a 400px box until the last row can be reached', async () => {
    const { observed } = await renderAtViewport(<RemovedImagesView removed={removed} />);
    expect(observed).toEqual(PHONE_VIEWPORT);

    const viewport = document.querySelector('.mantine-ScrollArea-viewport') as HTMLElement;
    const rows = document.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(ROWS);
    const last = rows[ROWS - 1];

    // 400px plus the gutter Mantine keeps for the horizontal scrollbar.
    expect(box(viewport).height).toBeLessThanOrEqual(416);
    expect(viewport.scrollHeight).toBeGreaterThan(viewport.clientHeight);

    viewport.scrollTop = viewport.scrollHeight;
    await nextLayout();
    const { left, top, width, height } = box(last);
    const hit = document.elementFromPoint(left + width / 2, top + height / 2);
    expect(last.contains(hit)).toBe(true);
  });

  it('shows its scrollbar without a hover, so the viewer can tell the list continues', async () => {
    await renderAtViewport(<RemovedImagesView removed={removed} />);

    const bar = document.querySelector(
      '.mantine-ScrollArea-scrollbar[data-orientation="vertical"]'
    ) as HTMLElement | null;

    // Mantine's default is a hover-only overlay: before the pointer arrives the bar is not in the
    // DOM at all, and on a touch screen it never arrives.
    expect(bar).not.toBeNull();
    expect(bar!.getAttribute('data-state')).not.toBe('hidden');
    expect(box(bar!).width).toBeGreaterThan(0);
  });
});
