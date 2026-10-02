import { beforeEach, describe, expect, test, vi } from 'vitest';
import type * as Trpc from '~/utils/trpc';

// Every measurement here is of padding and gaps, so both sheets have to be
// loaded or the geometry under test does not exist: Tailwind supplies the
// control's `px-2 py-1.5` and the header's `gap-3`, Mantine the Card padding.
import '~/styles/globals.css';
import '@mantine/core/styles.layer.css';

const generationData = {
  meta: { prompt: 'a cat' },
  resources: [],
  onSite: false,
};

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: {
    image: {
      getGenerationData: { useQuery: () => ({ data: generationData, isLoading: false }) },
      removeResource: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
    },
    useUtils: () => ({ image: { getGenerationData: { setData: vi.fn() } } }),
  },
}));
vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ id: 1, isModerator: false }),
}));

import { ImageGenerationData } from './ImageGenerationData';
import { renderWithProviders } from '../../../../test/component-setup';

beforeEach(() => {
  localStorage.removeItem('image-detail-section:generation-data');
});

async function renderPanel() {
  renderWithProviders(
    <div style={{ width: 400 }}>
      <ImageGenerationData imageId={1} collapsible />
    </div>
  );
  await vi.waitFor(() => {
    expect(copyControl()).toBeTruthy();
  });
}

function header() {
  return document.body.querySelector('[role="button"][aria-expanded]') as HTMLElement;
}

function copyControl() {
  return document.body.querySelector('[data-activity="copy:image-meta"]') as HTMLElement;
}

function isOpen() {
  return header().getAttribute('aria-expanded') === 'true';
}

// What a stray tap hits, rather than what the JSX suggests it hits — the
// control's own padding is half the fix, so dispatching at the element instead
// of at a coordinate would test nothing. Dispatched rather than `.click()`
// because the chevron is an SVGElement, which has no such method.
function clickAt(x: number, y: number, where: string) {
  const hit = document.elementFromPoint(x, y);
  expect(hit, `nothing at all ${where} (${x}, ${y})`).toBeTruthy();
  hit!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

// The fold is stored through Mantine's useLocalStorage, which lands the new
// value a frame or two after the click rather than in it — measured, the
// attribute still reads the old value on the line after `dispatchEvent`. The
// last test spends this same wait on a click that MUST collapse, so a settle
// grown too short fails there instead of quietly passing the probes below.
async function settle() {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => requestAnimationFrame(resolve));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// Reported 2026-09-22 (Freshdesk 73048, ClickUp 868m9eb7m): "You have to be
// precisely spot on to copy the gen data and not accidentally hide the
// section." COPY ALL is a text link inside the row that toggles the fold, so a
// near miss collapsed the panel — and the fold is stored per section, not per
// image, so one slip follows the reader onto every image they open next.
describe('COPY ALL in the collapsible Generation data header', () => {
  test('a click that misses it by a few pixels does not collapse the section', async () => {
    await renderPanel();

    // Read once, up front: a probe that collapsed the section would unmount the
    // control, and every rect taken after that is zero.
    const { left, right, top, bottom } = copyControl().getBoundingClientRect();
    const midX = (left + right) / 2;
    const midY = (top + bottom) / 2;
    const miss = 3;
    const probes: [string, number, number][] = [
      ['left of it', left - miss, midY],
      ['right of it', right + miss, midY],
      ['above it', midX, top - miss],
      ['below it', midX, bottom + miss],
      ['above and left of it', left - miss, top - miss],
      ['below and right of it', right + miss, bottom + miss],
    ];

    for (const [where, x, y] of probes) {
      clickAt(x, y, where);
      await settle();
      expect(isOpen(), `a click ${where} collapsed the section`).toBe(true);
    }
  });

  test('the control covers the full height of the header row', async () => {
    await renderPanel();

    // 16px of label in a 28px row before the fix, with the 6px above and below
    // it belonging to the toggle.
    expect(copyControl().getBoundingClientRect().height).toBeGreaterThanOrEqual(
      header().getBoundingClientRect().height
    );
  });

  // The control for the probes above: without it they pass against a header
  // that cannot collapse at all, or a settle that ends before the fold lands —
  // which is every way this file could be wired up wrong. The chevron end of
  // the row is deliberately still a toggle.
  test('the row still collapses when clicked away from the control', async () => {
    await renderPanel();

    const { right, top, bottom } = header().getBoundingClientRect();
    clickAt(right - 4, (top + bottom) / 2, 'on the chevron');
    await settle();

    expect(isOpen()).toBe(false);
  });
});
