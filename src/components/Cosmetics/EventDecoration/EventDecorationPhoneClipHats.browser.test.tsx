import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';

// A feed's first-column card sits at the page scroller's left edge on a phone, so a hat hung off
// its corner is cut by that scroller. Browser mode only: needs a real layout.

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
import { renderWithProviders } from '../../../../test/component-setup';
import { HatLayerHost } from '~/components/Cosmetics/EventDecoration/HatLayer';
import { TwCosmeticWrapper } from '~/components/TwCosmeticWrapper/TwCosmeticWrapper';

const hat = { type: 'hat', event: 'birthday2026', url: 'hat' };
const rect = (el: Element | null | undefined) => el!.getBoundingClientRect();
const hats = () => [...document.querySelectorAll('button[data-event-decoration="hat"]')];

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
  await page.viewport(390, 700);
  renderWithProviders(
    <div
      data-testid="scroller"
      style={{ width: 390, overflow: 'hidden auto', paddingTop: 60, position: 'relative' }}
    >
      {body}
    </div>
  );
  await vi.waitFor(() => expect(hats().length).toBeGreaterThan(0));
  // Past the settle after the hat measures its place.
  await new Promise((r) => setTimeout(r, 150));
}

// Bounding rects ignore a clipping ancestor, so a hat whose left edge is past the scroller's is cut.
function expectWhole(hatEl: Element, scroller: Element) {
  expect(rect(hatEl).left).toBeGreaterThanOrEqual(rect(scroller).left);
}

describe('the hat on a first-column card at phone width', () => {
  test('stays whole inside the scroller, and the card does not move', async () => {
    await phoneFeed(
      <div className="grid grid-cols-2 gap-2">
        <Card i={1} />
        <Card i={2} />
      </div>
    );
    const scroller = document.querySelector('[data-testid="scroller"]')!;
    expect(rect(document.querySelector('[data-testid="card"]')).left).toBe(rect(scroller).left);
    const first = hats().reduce((a, b) => (rect(b).left < rect(a).left ? b : a));
    expectWhole(first, scroller);
    expect(
      rect(document.querySelector('[data-testid="card"]')).top - rect(first).top
    ).toBeGreaterThan(30);
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
    expectWhole(first, scroller);
  });

  test('a card with room to its left keeps the hat where it was', async () => {
    await phoneFeed(
      <div style={{ paddingLeft: 60 }}>
        <Card i={1} />
      </div>
    );
    const [h] = hats();
    const card = document.querySelector('[data-testid="card"]')!;
    expect(rect(card).left - rect(h).left).toBeGreaterThan(15);
  });
});
