import { describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';

// Browser mode only: needs a real layout.

const HAT_URL =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M5 0L10 10H0z" fill="#e64980"/></svg>'
  );

vi.mock('~/components/Cosmetics/EventDecoration/WornHatPopover', () => ({
  WornHatPopover: ({ children }: any) => <span>{children}</span>,
}));
vi.mock('~/components/EdgeMedia/EdgeMedia', () => ({
  EdgeMedia: ({ className }: any) => <img src={HAT_URL} className={className} alt="" />,
}));

import '~/styles/globals.css';
import { renderWithProviders } from '../../../test/component-setup';
import { MasonryCarousel } from '~/components/MasonryColumns/MasonryCarousel';
import { HAT_SETTLE_FALLBACK_MS } from '~/components/EmblaCarousel/EmblaCarousel';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { TwCosmeticWrapper } from '~/components/TwCosmeticWrapper/TwCosmeticWrapper';

const hat = { type: 'hat', event: 'birthday2026', url: 'hat' };
const items = Array.from({ length: 6 }, (_, id) => ({ id }));

function Card({ data }: { data: { id: number } }) {
  return (
    <TwCosmeticWrapper
      eventDecoration={hat}
      eventDecorationOn={{ entityType: 'Model', entityId: data.id }}
    >
      <div data-testid="card" style={{ height: 200 }} className="rounded-md bg-slate-600" />
    </TwCosmeticWrapper>
  );
}

const rect = (el: Element | null | undefined) => el!.getBoundingClientRect();
const hats = () => [...document.querySelectorAll('button[data-event-decoration="hat"]')];

async function carousel() {
  await page.viewport(1100, 600);
  renderWithProviders(
    <div data-testid="root" style={{ width: 1000, margin: '60px 50px' }}>
      <MasonryProvider>
        <MasonryCarousel data={items} height={200} itemId={(d) => d.id} render={Card as any} />
      </MasonryProvider>
    </div>
  );
  await vi.waitFor(() => expect(hats().length).toBeGreaterThan(0));
}

describe('a hat on a masonry carousel card', () => {
  test('hangs past the first card corner, inside the page and not cut', async () => {
    await carousel();
    const root = document.querySelector('[data-testid="root"]')!;
    const cards = [...document.querySelectorAll('[data-testid="card"]')];
    const first = cards.reduce((a, b) => (rect(b).left < rect(a).left ? b : a));
    let h!: Element;
    await vi.waitFor(() => {
      const c = rect(first);
      h = hats().find(
        (el) => Math.abs(rect(el).left - c.left) < 80 && Math.abs(rect(el).top - c.top) < 80
      )!;
      expect(h).toBeTruthy();
    });
    expect(rect(first).top - rect(h).top).toBeGreaterThanOrEqual(34);
    expect(rect(first).left - rect(h).left).toBeGreaterThanOrEqual(24);
    expect(rect(h).left).toBeGreaterThanOrEqual(rect(root).left - 40);
  });

  test('only the slides in view have a hat, and none while they move', async () => {
    await carousel();
    const root = document.querySelector('[data-testid="root"]')!;
    for (const h of hats()) {
      expect(rect(h).left).toBeGreaterThanOrEqual(rect(root).left - 40);
      expect(rect(h).right).toBeLessThanOrEqual(rect(root).right + 40);
    }
    // Sampled every frame, so the hidden stretch is recorded rather than polled for.
    let fewest = Infinity;
    let sampling = true;
    const sample = () => {
      fewest = Math.min(fewest, hats().length);
      if (sampling) requestAnimationFrame(sample);
    };
    sample();
    try {
      await userEvent.click(document.querySelector<HTMLElement>('button.right-3')!);
      await vi.waitFor(() => expect(fewest).toBe(0));
      await vi.waitFor(() => expect(hats().length).toBeGreaterThan(0), {
        timeout: HAT_SETTLE_FALLBACK_MS + 1000,
      });
    } finally {
      sampling = false;
    }
    expect(hats().length).toBeLessThan(items.length);
    for (const h of hats()) {
      expect(rect(h).left).toBeGreaterThanOrEqual(rect(root).left - 40);
      expect(rect(h).right).toBeLessThanOrEqual(rect(root).right + 40);
    }
  });
});
