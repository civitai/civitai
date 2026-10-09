import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import {
  getEventDecorationClearLeft,
  getHatLayout,
  HAT_LOOK,
} from '~/components/Cosmetics/EventDecoration/event-decoration-placement';
import type { HatPlacement } from '~/components/Cosmetics/EventDecoration/event-decoration-placement';
import { ITEM_BLEED } from '~/components/MasonryColumns/masonry.constants';
import type { EventDecorationFit } from '~/shared/constants/event-decoration.constants';

// Prod birthday art (128x160 files) with the brim and convex outline measured from the pixels:
// civchan is the tallest at rest, ufo the squattest.
const ART: Record<string, EventDecorationFit> = {
  civchan: {
    canvas: [128, 160],
    bounds: [-0.13, 3, 128, 152],
    brim: [17, 111, 132],
    outline: [
      [13.5, 130.6],
      [42.9, 10.2],
      [52.2, 2.1],
      [78.1, 3],
      [123.8, 27.6],
      [128, 32.8],
      [128.2, 40.9],
      [113.9, 136.3],
      [109.6, 142.5],
      [99.1, 147.8],
      [73.9, 153],
      [53, 152.8],
      [28.1, 147.3],
      [17.8, 142],
    ],
  },
  ufo: {
    canvas: [128, 160],
    bounds: [4, 75.33, 124, 152],
    brim: [19, 109, 141],
    outline: [
      [9, 128.1],
      [44.6, 88.3],
      [55.4, 83.1],
      [72.6, 83.1],
      [83.4, 88.3],
      [119, 128.1],
      [118.9, 136.6],
      [115.9, 140.9],
      [100.5, 148.6],
      [83.8, 152.4],
      [44.2, 152.4],
      [27.5, 148.6],
      [15.2, 143],
      [9.1, 136.6],
    ],
  },
  basic: {
    canvas: [128, 160],
    bounds: [13, 25, 115, 152],
    brim: [16, 112, 134],
    outline: [
      [15, 118.7],
      [59.9, 26],
      [68.1, 26],
      [113, 118.7],
      [115.9, 135.7],
      [111.8, 141],
      [101.6, 146.6],
      [86.9, 151.3],
      [76.2, 152.8],
      [51.8, 152.8],
      [41.1, 151.3],
      [26.4, 146.6],
      [16.2, 141],
      [12.1, 135.7],
    ],
  },
};

const SHAPES: Record<string, EventDecorationFit | undefined> = {
  ...ART,
  default: undefined,
  boundsOnly: { canvas: [384, 384], bounds: [58, 1, 326, 383] },
};

/** Where an art point lands on the card, using the layout exactly as the overlay applies it. */
function toCard(fit: EventDecorationFit | undefined, placement: HatPlacement, [x, y]: number[]) {
  const layout = getHatLayout(placement, fit);
  const scale = layout.width / (fit?.canvas?.[0] ?? 128);
  const [ox, oy] = layout.origin.split(' ').map(parseFloat);
  const rad = (layout.tilt * Math.PI) / 180;
  const [dx, dy] = [x * scale - ox, y * scale - oy];
  return {
    x: layout.left + ox + dx * Math.cos(rad) - dy * Math.sin(rad),
    y: layout.top + oy + dx * Math.sin(rad) + dy * Math.cos(rad),
  };
}

const insidePolygon = (p: { x: number; y: number }, poly: { x: number; y: number }[]) => {
  const sides = poly.map((a, i) => {
    const b = poly[(i + 1) % poly.length];
    return Math.sign((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x));
  });
  return sides.every((s) => s >= 0) || sides.every((s) => s <= 0);
};

// Feed grids crop whatever a card paints more than ITEM_BLEED outside itself. A hat that reached
// further would be sliced at rest, the one thing it must not be.
describe.each(Object.entries(SHAPES))('hat placement for %s art', (_, fit) => {
  it('corner: never reaches past the bleed', () => {
    const { reach } = getHatLayout('corner', fit);
    expect(reach.top).toBeGreaterThanOrEqual(-ITEM_BLEED - 1e-9);
    expect(reach.left).toBeGreaterThanOrEqual(-ITEM_BLEED - 1e-9);
  });

  // Carousels clip at the slide's own edge, with no bleed to spend.
  it('inside: stays 2px inside the card', () => {
    const { reach } = getHatLayout('inside', fit);
    expect(reach.top).toBeGreaterThanOrEqual(2 - 1e-9);
    expect(reach.left).toBeGreaterThanOrEqual(2 - 1e-9);
  });

  it('keeps the art in proportion', () => {
    const { width, height } = getHatLayout('corner', fit);
    const [w, h] = fit?.canvas ?? [128, 160];
    expect(height / width).toBeCloseTo(h / w, 9);
  });

  it.each<HatPlacement>(['corner', 'inside'])(
    '%s: corner chips step clear of the whole hat',
    (placement) => {
      const clear = getEventDecorationClearLeft({ type: 'hat', fit }, placement);
      expect(clear).toBeGreaterThan(getHatLayout(placement, fit).reach.right);
    }
  );
});

// `reach` is what the clamp and the chips use, so it must be the art where it actually lands.
describe.each(Object.entries(ART))('the reach of %s', (_, fit) => {
  it.each<HatPlacement>(['corner', 'inside'])(
    '%s: is the box around the placed outline',
    (placement) => {
      const placed = (fit.outline as number[][]).map((p) => toCard(fit, placement, p));
      const { reach } = getHatLayout(placement, fit);
      expect(reach.left).toBeCloseTo(Math.min(...placed.map((p) => p.x)), 6);
      expect(reach.top).toBeCloseTo(Math.min(...placed.map((p) => p.y)), 6);
      expect(reach.right).toBeCloseTo(Math.max(...placed.map((p) => p.x)), 6);
      expect(reach.bottom).toBeCloseTo(Math.max(...placed.map((p) => p.y)), 6);
    }
  );
});

const WORN = Object.entries(ART).flatMap(([name, fit]) => [
  [`${name}`, fit] as const,
  [`${name} tilted -30`, { ...fit, tilt: -30 }] as const,
  [`${name} tilted -60`, { ...fit, tilt: -60 }] as const,
]);

describe.each(WORN)('the worn look on %s', (_, fit) => {
  const brim = fit.brim as number[];
  const tilt = fit.tilt ?? HAT_LOOK.tilt;
  const outline = (fit.outline as number[][]).map((p) => toCard(fit, 'corner', p));

  it('wears the card corner inside the hat', () => {
    expect(insidePolygon({ x: 0, y: 0 }, outline)).toBe(true);
  });

  it('leans along a line through the corner', () => {
    const middle = toCard(fit, 'corner', [(brim[0] + brim[1]) / 2, brim[2]]);
    const rad = (tilt * Math.PI) / 180;
    const up = { x: Math.sin(rad), y: -Math.cos(rad) };
    const toCorner = { x: -middle.x, y: -middle.y };
    expect(up.x * toCorner.y - up.y * toCorner.x).toBeCloseTo(0, 6);
    expect(up.x * toCorner.x + up.y * toCorner.y).toBeGreaterThan(0);
  });

  it('is sized by its brim', () => {
    const [a, b] = [
      toCard(fit, 'corner', [brim[0], brim[2]]),
      toCard(fit, 'corner', [brim[1], brim[2]]),
    ];
    expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(HAT_LOOK.brim, 6);
  });

  it('pivots, and grows on hover, about the middle of its brim', () => {
    const layout = getHatLayout('corner', fit);
    const scale = layout.width / 128;
    expect(layout.origin).toBe(`${((brim[0] + brim[1]) / 2) * scale}px ${brim[2] * scale}px`);
  });

  it('puts the chosen share of its height on the card, with nothing moved to fit', () => {
    const middle = toCard(fit, 'corner', [(brim[0] + brim[1]) / 2, brim[2]]);
    const top = Math.min(...(fit.outline as number[][]).map(([, y]) => y));
    const height = (brim[2] - top) * (HAT_LOOK.brim / (brim[1] - brim[0]));
    expect(Math.hypot(middle.x, middle.y)).toBeCloseTo(HAT_LOOK.onCard * height, 6);
  });
});

// Justin accepted hats overlapping neighbouring cards so the tallest design is worn exactly as
// chosen (2026-10-09). Lowering ITEM_BLEED below what civchan needs moves it into the card instead.
it('the tallest design fits the bleed without being moved', () => {
  const { reach } = getHatLayout('corner', ART.civchan);
  expect(Math.min(reach.left, reach.top)).toBeGreaterThan(-ITEM_BLEED);
});

// Chosen by Justin on real feed cards in the interactive mock (2026-10-09). Change it with him.
it('wears the look chosen on real cards', () => {
  expect(HAT_LOOK).toEqual({ brim: 40, tilt: -45, onCard: 0.47, grow: 1.4 });
});

// These are text pins: they see the declaration, not the rendered room. SCSS cannot import
// ITEM_BLEED, so home blocks restate it: room above and left of their edge cards, traded from
// margin to padding around the cards' own 8px (`p-2`) so nothing moves.
const declared = (file: string, declaration: string) =>
  new RegExp(String.raw`^\s*${declaration.replace(/[()[\]]/g, '$&')}`, 'm').test(
    readFileSync(file, 'utf8')
  );

it('home blocks give edge cards the same room as the feed', () => {
  const file = 'src/components/HomeBlocks/HomeBlock.module.scss';
  for (const side of ['top', 'left']) {
    expect(declared(file, `margin-${side}: -${ITEM_BLEED}px;`)).toBe(true);
    expect(declared(file, `padding-${side}: ${ITEM_BLEED - 8}px;`)).toBe(true);
  }
});

// Containers that clip at a card's edge declare their room and keep hats at rest size.
it.each([
  [
    'src/components/Profile/Sections/ShowcaseGrid.module.scss',
    '--event-decoration-allowance: 8px;',
  ],
  ['src/components/Profile/Sections/ShowcaseGrid.module.scss', '--event-decoration-grow: 1;'],
  ['src/components/HomeBlocks/HomeBlock.module.scss', '--event-decoration-grow: 1;'],
])('%s declares %s', (file, declaration) => {
  expect(declared(file, declaration)).toBe(true);
});

it('masonry carousels give hats no room and no growth', () => {
  const source = readFileSync('src/components/MasonryColumns/MasonryCarousel.tsx', 'utf8');
  expect(source).toMatch(/'\[--event-decoration-allowance:0px\] \[--event-decoration-grow:1\]'/);
});

describe('a hat too big for the bleed', () => {
  it('is moved right until it fits the left edge', () => {
    const { reach } = getHatLayout('corner', { ...ART.basic, size: 120, tilt: -80 });
    expect(reach.left).toBeCloseTo(-ITEM_BLEED, 6);
    expect(reach.top).toBeGreaterThanOrEqual(-ITEM_BLEED - 1e-9);
  });

  it('is moved down until it fits the top edge', () => {
    const { reach } = getHatLayout('corner', { ...ART.basic, size: 120, tilt: -10 });
    expect(reach.top).toBeCloseTo(-ITEM_BLEED, 6);
    expect(reach.left).toBeGreaterThanOrEqual(-ITEM_BLEED - 1e-9);
  });
});

// Containers with less room than the feed (carousels, profile grids) pass their own allowance.
it.each([0, 8, 24])('fits a container that gives %ipx of room', (allowance) => {
  const { reach } = getHatLayout('corner', ART.civchan, allowance);
  expect(Math.min(reach.left, reach.top)).toBeCloseTo(-allowance, 6);
});

it('outlines its hit area with the art, not the canvas', () => {
  const { hitArea, width } = getHatLayout('corner', ART.basic);
  const scale = width / 128;
  expect(hitArea).toBe(
    `polygon(${(ART.basic.outline as number[][])
      .map(([x, y]) => `${x * scale}px ${y * scale}px`)
      .join(', ')})`
  );
  const plain = getHatLayout('corner', { canvas: [128, 160], bounds: [8, 4, 120, 150] });
  const s = plain.width / 128;
  expect(plain.hitArea).toBe(
    `polygon(${8 * s}px ${4 * s}px, ${120 * s}px ${4 * s}px, ${120 * s}px ${150 * s}px, ${
      8 * s
    }px ${150 * s}px)`
  );
});

describe('getEventDecorationClearLeft', () => {
  it('is zero for decorations that are not hats', () => {
    expect(getEventDecorationClearLeft({ type: 'scarf' }, 'corner')).toBe(0);
  });
});

describe('fit data that does not describe real art', () => {
  it('falls back to the default convention instead of producing NaN', () => {
    const broken = {
      bounds: [10, 10, 5, 5],
      canvas: ['a', 2],
      size: -3,
      brim: [5, 1, 3],
      outline: [[1, 2]],
    } as never;
    expect(getHatLayout('corner', broken)).toEqual(getHatLayout('corner'));
  });
});
