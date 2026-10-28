import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import homeClasses from '~/components/HomeBlocks/HomeBlock.module.scss';

// =============================================================================
// Event hats on the corner of a shelf's cards, past their edge as in the feed, not moved inside.
//
// A shelf clips at its box (`overflow: hidden` for the row clamp, or a scroller), so it has to hold
// the hat's room itself: padding above and left of the first card, undone by an equal negative
// margin so no card moves, with the matching `--event-decoration-allowance`. Drives the real
// ShowcaseGrid and the home-block grid's stylesheet, with the real TwCosmeticWrapper and hat
// overlay; stubs only the hat's art and popover. Browser mode only: placement needs a real layout.
// =============================================================================

const HAT_URL =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M5 0L10 10H0z" fill="#e64980"/></svg>'
  );

// Next camel-cases a stylesheet's class names (`scroll-area` is `scrollArea`); this runner does not.
vi.mock('~/components/Profile/Sections/ShowcaseGrid.module.scss', async (importOriginal) => {
  const { default: classes } = await importOriginal<{ default: Record<string, string> }>();
  const camel = (name: string) => name.replace(/-(\w)/g, (_, c: string) => c.toUpperCase());
  const byCamel = Object.fromEntries(Object.entries(classes).map(([k, v]) => [camel(k), v]));
  return { default: { ...classes, ...byCamel } };
});
vi.mock('~/components/Cosmetics/EventDecoration/WornHatPopover', () => ({
  WornHatPopover: ({ children }: any) => <span>{children}</span>,
}));
vi.mock('~/components/EdgeMedia/EdgeMedia', () => ({
  EdgeMedia: ({ className }: any) => <img src={HAT_URL} className={className} alt="" />,
}));

import '~/styles/globals.css';
import { renderWithProviders } from '../../../../test/component-setup';
import { ShowcaseGrid } from '~/components/Profile/Sections/ShowcaseGrid';
import { TwCosmeticWrapper } from '~/components/TwCosmeticWrapper/TwCosmeticWrapper';

const hat = { type: 'hat', event: 'birthday2026', url: 'hat' };

function Card({ i }: { i: number }) {
  return (
    <TwCosmeticWrapper
      eventDecoration={hat}
      eventDecorationOn={{ entityType: 'Image', entityId: i }}
    >
      <div data-testid="card" style={{ height: 160 }} className="rounded-md bg-slate-600" />
    </TwCosmeticWrapper>
  );
}

const rect = (el: Element | null | undefined) => el!.getBoundingClientRect();
const cards = () => [...document.querySelectorAll('[data-testid="card"]')];
const hats = () => [...document.querySelectorAll('button[data-event-decoration="hat"]')];

async function shelf(width: number, body: React.ReactNode) {
  await page.viewport(Math.max(width + 80, 400), 700);
  renderWithProviders(
    // The page's CSS container, which the shelf's narrow layouts query.
    <div
      data-testid="root"
      style={{
        width,
        margin: '60px 40px',
        containerType: 'inline-size',
        ['--mantine-spacing-md' as string]: '16px',
      }}
    >
      {body}
    </div>
  );
  await vi.waitFor(() => expect(hats().length).toBeGreaterThan(0));
}

// The first hat reaches past its card's top and left edges, and none of it is cut by the clip.
function expectOnCorner(clip: Element, { left }: { left: number }) {
  const [card] = cards();
  const [h] = hats();
  expect(rect(card).top - rect(h).top).toBeGreaterThanOrEqual(24);
  expect(rect(card).left - rect(h).left).toBeGreaterThanOrEqual(left);
  expect(rect(h).top).toBeGreaterThanOrEqual(rect(clip).top - 0.5);
  expect(rect(h).left).toBeGreaterThanOrEqual(rect(clip).left - 0.5);
}

const items = Array.from({ length: 9 }, (_, i) => i);

describe('a hat on a shelf card sits on its corner', () => {
  test('profile showcase: past the top and left edge, no card moved, rows still clamped', async () => {
    await shelf(
      900,
      <ShowcaseGrid itemCount={items.length} rows={2} minWidth={280}>
        {items.map((i) => (
          <Card key={i} i={i} />
        ))}
      </ShowcaseGrid>
    );
    const root = document.querySelector('[data-testid="root"]')!;
    const grid = root.firstElementChild!;
    expectOnCorner(grid, { left: 24 });

    // The room is added and taken back: the first card is where it was (the items' 8px margin).
    expect(rect(cards()[0]).left - rect(root).left).toBeCloseTo(8, 0);
    expect(rect(cards()[0]).top - rect(root).top).toBeCloseTo(0, 0);
    // Three columns by two rows shown; the third row stays collapsed.
    // The grid's children are the cards' wrappers; a collapsed row is zero tall.
    expect(cards().filter((c) => rect(c.parentElement).height > 0)).toHaveLength(6);
  });

  test('profile showcase scroller on a phone: full room above, what the page leaves beside', async () => {
    await shelf(
      360,
      <ShowcaseGrid itemCount={items.length} rows={2} minWidth={280}>
        {items.map((i) => (
          <Card key={i} i={i} />
        ))}
      </ShowcaseGrid>
    );
    const root = document.querySelector('[data-testid="root"]')!;
    expectOnCorner(root.firstElementChild!, { left: 12 });
    // The scroller's own 16px padding and the card's 8px margin, as before the hat's room.
    expect(rect(cards()[0]).left - rect(root).left).toBeCloseTo(24, 0);
    expect(rect(cards()[0]).top - rect(root).top).toBeCloseTo(0, 0);
  });

  test('profile showcase carousel (early access): past the top and left edge, card unmoved', async () => {
    await shelf(
      900,
      <ShowcaseGrid itemCount={items.length} rows={1} carousel>
        {items.map((i) => (
          <Card key={i} i={i} />
        ))}
      </ShowcaseGrid>
    );
    const root = document.querySelector('[data-testid="root"]')!;
    // The scroll area is what clips.
    const scrollArea = root.firstElementChild!.firstElementChild!;
    expectOnCorner(scrollArea, { left: 24 });
    expect(rect(cards()[0]).left - rect(root).left).toBeCloseTo(24, 0);
    expect(rect(cards()[0]).top - rect(root).top).toBeCloseTo(0, 0);
  });

  test('home-block grid on a phone: full room above its cards', async () => {
    await shelf(
      360,
      <div
        className={homeClasses.grid}
        style={{ ['--rows' as string]: 1, ['--count' as string]: items.length }}
      >
        {items.map((i) => (
          <div key={i} className="p-2">
            <Card i={i} />
          </div>
        ))}
      </div>
    );
    const root = document.querySelector('[data-testid="root"]')!;
    expect(rect(cards()[0]).top - rect(hats()[0]).top).toBeGreaterThanOrEqual(30);
    expect(rect(cards()[0]).top - rect(hats()[0]).top).toBeGreaterThanOrEqual(30);
    expect(rect(hats()[0]).top).toBeGreaterThanOrEqual(rect(root.firstElementChild).top - 0.5);
  });
});
