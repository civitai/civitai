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

// The hat is really visible past the card's edge: the topmost element at a point inside its
// overhang is the hat, so a clipping ancestor (which bounding rects ignore) turns this red.
function expectOverhangVisible(hat: Element) {
  const r = hat.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + 8);
  expect(hit?.closest('button[data-event-decoration="hat"]')).toBe(hat);
}

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
    expectOverhangVisible(h);
    expect(rect(first).top - rect(h).top).toBeGreaterThanOrEqual(34);
    expect(rect(first).left - rect(h).left).toBeGreaterThanOrEqual(24);
    expect(rect(h).left).toBeGreaterThanOrEqual(rect(root).left - 40);
  });

  test('only the slides in view have a hat, and it rides its card while they move', async () => {
    await carousel();
    const root = document.querySelector('[data-testid="root"]')!;
    const cards = () => [...document.querySelectorAll('[data-testid="card"]')];
    const inView = (c: Element) =>
      rect(c).left >= rect(root).left && rect(c).left + rect(c).width / 2 < rect(root).right;
    const nearest = (c: Element) =>
      hats().reduce(
        (best, h) =>
          Math.abs(rect(h).left - rect(c).left) < Math.abs(rect(best).left - rect(c).left)
            ? h
            : best,
        hats()[0]
      );
    // How far left of its card a hat sits at rest.
    const [first] = cards().filter(inView);
    const resting = rect(first).left - rect(nearest(first)).left;
    for (const h of hats()) {
      expect(rect(h).left).toBeGreaterThanOrEqual(rect(root).left - 40);
      expect(rect(h).right).toBeLessThanOrEqual(rect(root).right + 40);
    }
    // Sampled once every frame, after the frame's other callbacks, so each hat is compared with the
    // cards as painted: how far it is from where its card would put it. No hat drawn counts as 99.
    const moving: number[] = [];
    let last = NaN;
    let sampling = true;
    const sample = () =>
      requestAnimationFrame(() =>
        setTimeout(() => {
          const at = rect(first).left;
          if (at !== last && !Number.isNaN(last)) {
            moving.push(
              hats().length
                ? Math.max(
                    ...hats().map((h) =>
                      Math.min(
                        ...cards().map((c) => Math.abs(rect(h).left - rect(c).left + resting))
                      )
                    )
                  )
                : 99
            );
          }
          last = at;
          if (sampling) sample();
        }, 0)
      );
    sample();
    try {
      const start = rect(first).left;
      await userEvent.click(document.querySelector<HTMLElement>('button.right-3')!);
      await vi.waitFor(() => expect(rect(first).left).not.toBe(start));
      // The scroll has stopped when the first card has not moved for a few frames.
      let still = 0;
      let prev = NaN;
      await vi.waitFor(
        () => {
          const left = rect(first).left;
          still = left === prev ? still + 1 : 0;
          prev = left;
          expect(still).toBeGreaterThanOrEqual(5);
        },
        { timeout: 10000, interval: 100 }
      );
    } finally {
      sampling = false;
    }
    // Hats were drawn on the cards for the whole move, to the pixel.
    expect(moving.length).toBeGreaterThan(10);
    // The first frame's `scroll` can trail the slide's first step by a frame.
    expect(Math.max(...moving.slice(1))).toBeLessThanOrEqual(1);
    await vi.waitFor(() => expect(hats().length).toBeGreaterThan(0), {
      timeout: HAT_SETTLE_FALLBACK_MS + 1000,
    });
    expect(hats().length).toBeLessThan(items.length);
    for (const h of hats()) {
      expect(rect(h).left).toBeGreaterThanOrEqual(rect(root).left - 40);
      expect(rect(h).right).toBeLessThanOrEqual(rect(root).right + 40);
    }
  });
});
