import { describe, expect, test, vi } from 'vitest';
import { userEvent } from 'vitest/browser';

// A worn hat hangs off a feed card's top-left corner. The Hat Turf badge is the first chip in the
// card's header, so it has to land clear of the hat's footprint, not under it. Needs a real layout.

const HAT_URL =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M5 0L10 10H0z" fill="#e64980"/></svg>'
  );

vi.mock('~/components/Cosmetics/EventDecoration/WornHatPopover', () => ({
  WornHatPopover: ({ children }: any) => children,
}));
vi.mock('~/components/EdgeMedia/EdgeMedia', () => ({
  EdgeMedia: ({ className }: any) => <img src={HAT_URL} className={className} alt="" />,
}));

import {
  NARROW_PHONE_VIEWPORT,
  renderAtViewport,
  type Viewport,
} from '../../../test/geometry-setup';
import { AspectRatioCard } from '~/components/CardTemplates/AspectRatioCard';
import { IntersectionObserverProvider } from '~/components/IntersectionObserver/IntersectionObserverProvider';
import { HatLayerHost } from '~/components/Cosmetics/EventDecoration/HatLayer';

const DESKTOP_VIEWPORT = { width: 1280, height: 800 } as const;
const hatDecoration = {
  type: 'hat',
  event: 'birthday2026',
  url: 'hat',
  fit: { size: 90, tilt: -45 },
};
const rect = (el: Element) => el.getBoundingClientRect();
// The drawn art, not the button: the hover grow scales an inner element the button's box ignores.
const art = () => document.querySelector('button[data-event-decoration="hat"] img')!;
const overlap = (a: DOMRect, b: DOMRect) =>
  Math.min(a.right, b.right) > Math.max(a.left, b.left) &&
  Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top);

// Stands in for HatTurfBadge: the real one is a 24px dial, first in the card's header.
const Badge = () => (
  <div data-testid="badge" style={{ width: 24, height: 24, background: 'green' }} />
);

function Card({ worn, layer }: { worn: boolean; layer: boolean }) {
  const card = (
    <div style={{ width: 200 }}>
      <AspectRatioCard
        eventDecoration={worn ? hatDecoration : undefined}
        eventDecorationOn={{ entityType: 'Image', entityId: 1 }}
        header={
          <div className="flex w-full items-start justify-between">
            <Badge />
          </div>
        }
        render={() => <div style={{ height: '100%' }} className="bg-slate-600" />}
      />
    </div>
  );
  return (
    <div className="relative" style={{ padding: '60px 60px' }}>
      {layer ? <HatLayerHost>{card}</HatLayerHost> : card}
    </div>
  );
}

async function measure(viewport: Viewport, worn: boolean, layer: boolean) {
  await renderAtViewport(
    <IntersectionObserverProvider>
      <Card worn={worn} layer={layer} />
    </IntersectionObserverProvider>,
    viewport
  );
  const hatEl = () => document.querySelector('button[data-event-decoration="hat"]');
  if (worn) await vi.waitFor(() => expect(hatEl()).not.toBeNull());
  // The pointer from an earlier test would leave the hat grown.
  await userEvent.unhover(document.body);
  await new Promise((r) => setTimeout(r, 1200));
  return {
    badge: rect(document.querySelector('[data-testid="badge"]')!),
    hat: hatEl() ? rect(art()) : null,
  };
}

describe.each([
  ['phone 360', NARROW_PHONE_VIEWPORT],
  ['desktop', DESKTOP_VIEWPORT],
])('Hat Turf badge on a card wearing a hat, %s', (_name, viewport) => {
  test.each([
    ['inside a hat layer', true],
    ['without a hat layer', false],
  ])('stays clear of the hat %s', async (_n, layer) => {
    const { badge, hat } = await measure(viewport, true, layer);
    expect(hat).not.toBeNull();
    expect(hat!.width).toBeGreaterThan(10);
    expect(overlap(badge, hat!)).toBe(false);
  });

  test('stays clear of the hat while the card is hovered and the hat has grown', async () => {
    const { badge } = await measure(viewport, true, false);
    const card = document.querySelector('[data-card-hover]')!;
    await userEvent.hover(card);
    await new Promise((r) => setTimeout(r, 1200));
    const grown = rect(art());
    expect(overlap(badge, grown)).toBe(false);
  });

  test('stays at its usual corner spot when no hat is worn', async () => {
    const { badge } = await measure(viewport, false, false);
    const card = document.querySelector('[data-card-hover]')!.parentElement!;
    expect(badge.left - rect(card).left).toBe(8);
    expect(badge.top - rect(card).top).toBe(8);
  });
});
