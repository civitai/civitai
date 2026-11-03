import { useState } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';

// A feed's first-column card sits at the page scroller's left edge on a phone, so a hat hung off its
// corner overhangs that scroller. The hat keeps its place on the corner (the same as on a desktop
// card with room) and the scroller cuts what overhangs. Needs a real layout.

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

import { PHONE_VIEWPORT, renderAtViewport } from '../../../../test/geometry-setup';
import { HatLayerHost } from '~/components/Cosmetics/EventDecoration/HatLayer';
import { TwCosmeticWrapper } from '~/components/TwCosmeticWrapper/TwCosmeticWrapper';

const hat = { type: 'hat', event: 'birthday2026', url: 'hat' };
const rect = (el: Element | null | undefined) => el!.getBoundingClientRect();
const hats = () => [
  ...document.querySelectorAll<HTMLButtonElement>('button[data-event-decoration="hat"]'),
];
const cards = () => [...document.querySelectorAll('[data-testid="card"]')];

function Card({ i }: { i: number }) {
  return (
    <TwCosmeticWrapper
      eventDecoration={hat}
      eventDecorationOn={{ entityType: 'Model', entityId: i }}
    >
      <div data-testid="card" style={{ height: 200 }} className="rounded-md bg-slate-600" />
    </TwCosmeticWrapper>
  );
}

// Like the page: a scroller that clips at the viewport's left, its first column flush against it.
async function phoneFeed(body: React.ReactNode) {
  const { observed } = await renderAtViewport(
    <div
      data-testid="scroller"
      style={{ width: 390, overflow: 'hidden auto', paddingTop: 60, position: 'relative' }}
    >
      {body}
    </div>,
    PHONE_VIEWPORT
  );
  expect(observed).toEqual({ width: 390, height: 844 });
  await vi.waitFor(() => expect(hats().length).toBeGreaterThan(0));
  // Past any settle after the hat mounts.
  await new Promise((r) => setTimeout(r, 150));
}

// Where the hat sits against its own card's top-left corner.
const offsetFromCard = (hatEl: Element, cardEl: Element) => ({
  x: rect(cardEl).left - rect(hatEl).left,
  y: rect(cardEl).top - rect(hatEl).top,
});

// Layout rects carry sub-pixel noise between two cards.
function expectSameOffset(a: { x: number; y: number }, b: { x: number; y: number }) {
  expect(a.x).toBeCloseTo(b.x, 1);
  expect(a.y).toBeCloseTo(b.y, 1);
}

describe('the hat on a first-column card at phone width', () => {
  test('keeps the corner position it has on a card with room, and the scroller cuts the overhang', async () => {
    await phoneFeed(
      <div className="grid grid-cols-2 gap-2">
        <Card i={1} />
        <Card i={2} />
      </div>
    );
    const scroller = document.querySelector('[data-testid="scroller"]')!;
    const [card] = cards();
    expect(rect(card).left).toBe(rect(scroller).left);
    const flush = hats().reduce((a, b) => (rect(b).left < rect(a).left ? b : a));
    // The hat hangs past the scroller's edge: it was not moved in, and the card did not move either.
    expect(rect(flush).left).toBeLessThan(rect(scroller).left);
    expect(flush.style.translate).toBe('');
    expect(offsetFromCard(flush, card).y).toBeGreaterThan(30);
  });

  test('sits the same way against its card as one with room to its left', async () => {
    await phoneFeed(
      <div>
        <div className="grid grid-cols-2 gap-2">
          <Card i={1} />
        </div>
        <div style={{ paddingLeft: 60 }}>
          <Card i={2} />
        </div>
      </div>
    );
    const [flushCard, roomyCard] = cards();
    const [flushHat, roomyHat] = hats();
    expect(rect(roomyCard).left - rect(flushCard).left).toBeGreaterThan(50);
    expectSameOffset(offsetFromCard(flushHat, flushCard), offsetFromCard(roomyHat, roomyCard));
  });

  test('also when drawn in an ancestor hat layer', async () => {
    await phoneFeed(
      <div className="relative">
        <HatLayerHost>
          <div className="grid grid-cols-2 gap-2">
            <Card i={1} />
            <Card i={2} />
          </div>
        </HatLayerHost>
      </div>
    );
    const scroller = document.querySelector('[data-testid="scroller"]')!;
    const first = hats().reduce((a, b) => (rect(b).left < rect(a).left ? b : a));
    expect(rect(first).left).toBeLessThan(rect(scroller).left);
    expect(first.style.translate).toBe('');
  });

  test('a card scrolled out to the left takes its hat with it, still on its corner', async () => {
    function Rail() {
      const [, tick] = useState(0);
      return (
        <>
          <button data-testid="tick" onClick={() => tick((n) => n + 1)}>
            tick
          </button>
          <div data-testid="rail" style={{ overflowX: 'auto', display: 'flex', gap: 8 }}>
            {[1, 2, 3, 4].map((i) => (
              <div key={i} style={{ width: 200, flex: 'none' }}>
                <Card i={i} />
              </div>
            ))}
          </div>
        </>
      );
    }
    await phoneFeed(<Rail />);
    const [first] = hats();
    const before = offsetFromCard(first, cards()[0]);
    document.querySelector('[data-testid="rail"]')!.scrollLeft = 150;
    await userEvent.click(page.getByTestId('tick'));
    await new Promise((r) => setTimeout(r, 150));
    const [card1, card2] = cards();
    expect(rect(card1).left).toBeLessThan(0);
    expect(first.style.translate).toBe('');
    expectSameOffset(offsetFromCard(first, card1), before);
    expect(rect(first).left).toBeLessThan(rect(card2).left);
  });

  test('a tap on the hat still bursts', async () => {
    await phoneFeed(
      <div className="grid grid-cols-2 gap-2">
        <Card i={1} />
        <Card i={2} />
      </div>
    );
    const [first] = hats();
    expect(document.querySelector('[class*="burst"]')).toBeNull();
    const box = rect(first);
    // The visible part of the flush hat: right of the scroller's edge, centre of the hit shape.
    await userEvent.click(first, { position: { x: box.width * 0.75, y: box.height * 0.75 } });
    await vi.waitFor(() => expect(document.querySelector('[class*="burst"]')).not.toBeNull());
  });
});
