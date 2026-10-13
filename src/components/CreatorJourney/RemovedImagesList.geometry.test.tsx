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
});
