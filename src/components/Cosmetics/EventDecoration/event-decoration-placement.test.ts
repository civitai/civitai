import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import {
  applyHatFitChanges,
  getEventDecorationClearLeft,
  getEventDecorationClearLeftCss,
  getHatCardScale,
  getHatLayout,
  HAT_LOOK,
  HAT_LOOK_CARD_WIDTH,
  HAT_PLAIN_CARD_NUDGE,
  hatShiftCss,
} from '~/components/Cosmetics/EventDecoration/event-decoration-placement';
import type { HatPlacement } from '~/components/Cosmetics/EventDecoration/event-decoration-placement';
import { ITEM_BLEED } from '~/components/MasonryColumns/masonry.constants';
import { HAT_FIT_LIMITS } from '~/shared/constants/event-decoration.constants';
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
  // Bigger or worn shallower, the tallest design reaches past the bleed and is moved to fit.
  ...(name === 'civchan'
    ? []
    : [
        [`${name} sized 56`, { ...fit, size: 56 }] as const,
        [`${name} worn 30% deep`, { ...fit, depth: 0.3 }] as const,
      ]),
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
    expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(fit.size ?? HAT_LOOK.brim, 6);
  });

  it('pivots, and grows on hover, about the middle of its brim', () => {
    const layout = getHatLayout('corner', fit);
    const scale = layout.width / 128;
    expect(layout.origin).toBe(`${((brim[0] + brim[1]) / 2) * scale}px ${brim[2] * scale}px`);
  });

  it('puts the chosen share of its height on the card, with nothing moved to fit', () => {
    const middle = toCard(fit, 'corner', [(brim[0] + brim[1]) / 2, brim[2]]);
    const top = Math.min(...(fit.outline as number[][]).map(([, y]) => y));
    const height = (brim[2] - top) * ((fit.size ?? HAT_LOOK.brim) / (brim[1] - brim[0]));
    expect(Math.hypot(middle.x, middle.y)).toBeCloseTo((fit.depth ?? HAT_LOOK.onCard) * height, 6);
  });
});

// Justin accepted hats overlapping neighbouring cards so the tallest design is worn exactly as
// chosen (2026-10-09). Lowering ITEM_BLEED below what civchan needs moves it into the card instead.
it('the tallest design fits the bleed without being moved, on a plain card too', () => {
  const { reach } = getHatLayout('corner', ART.civchan, undefined, HAT_PLAIN_CARD_NUDGE);
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
  new RegExp(String.raw`^\s*${declaration.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm').test(
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
  [
    'src/components/HomeBlocks/HomeBlock.module.scss',
    '--event-decoration-allowance: calc(var(--mantine-spacing-md) + 8px);',
  ],
])('%s declares %s', (file, declaration) => {
  expect(declared(file, declaration)).toBe(true);
});

// Measured in a real Mantine modal: the sticky header sits flush on the body, so the preview card
// had no room above it and the hat was hidden behind the header.
it('the hat picker makes room above each preview card, declares it, and stops growth', () => {
  const source = readFileSync('src/components/Decorations/EventHatPickerModal.tsx', 'utf8');
  const wrappers = [...source.matchAll(/<div className="([^"]*)">\s*<PreviewCard\s/g)];
  // The try-on and the no-hats state each draw one.
  expect(wrappers).toHaveLength(2);
  for (const wrapper of wrappers)
    expect(wrapper[1].split(/\s+/).sort()).toEqual(
      ['pt-4', '[--event-decoration-allowance:16px]', '[--event-decoration-grow:1]'].sort()
    );
});

it('masonry carousels give hats no room and no growth', () => {
  const source = readFileSync('src/components/MasonryColumns/MasonryCarousel.tsx', 'utf8');
  expect(source).toMatch(/'\[--event-decoration-allowance:0px\] \[--event-decoration-grow:1\]'/);
});

// Chosen by Justin in the hat tuner on his phone (2026-10-09): 4px further up and left on cards
// without a frame. Change it with him.
it('nudges hats on plain cards by the chosen amount', () => {
  expect(HAT_PLAIN_CARD_NUDGE).toBe(4);
});

it.each(Object.entries(ART))('a plain card moves %s exactly that far up and left', (_, fit) => {
  const framed = getHatLayout('corner', fit, Infinity);
  const plain = getHatLayout('corner', fit, Infinity, HAT_PLAIN_CARD_NUDGE);
  expect(plain.reach.left).toBeCloseTo(framed.reach.left - HAT_PLAIN_CARD_NUDGE, 9);
  expect(plain.reach.top).toBeCloseTo(framed.reach.top - HAT_PLAIN_CARD_NUDGE, 9);
  expect(plain.origin).toBe(framed.origin);
});

// The nudge only moves a hat out into room the container has; where the room is used up, the
// plain card's hat is held at the same edge as the framed one.
it.each(Object.entries(ART))('a container with no room absorbs the nudge for %s', (_, fit) => {
  const framed = getHatLayout('corner', fit, 0);
  const plain = getHatLayout('corner', fit, 0, HAT_PLAIN_CARD_NUDGE);
  expect(plain.reach).toEqual(framed.reach);
});

it.each(Object.entries(ART))('a hat kept inside the card ignores the nudge: %s', (_, fit) => {
  expect(getHatLayout('inside', fit, undefined, HAT_PLAIN_CARD_NUDGE)).toEqual(
    getHatLayout('inside', fit)
  );
});

describe('a hat too big for the bleed', () => {
  it('is moved right until it fits the left edge', () => {
    const { reach } = getHatLayout('corner', { ...ART.basic, size: 64, tilt: -80 });
    expect(reach.left).toBeCloseTo(-ITEM_BLEED, 6);
    expect(reach.top).toBeGreaterThanOrEqual(-ITEM_BLEED - 1e-9);
  });

  it('is moved down until it fits the top edge', () => {
    const { reach } = getHatLayout('corner', { ...ART.basic, size: 64, tilt: -10 });
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

// Each hat may carry its own look (set by mods per cosmetic); without one it wears HAT_LOOK.
describe('a hat with its own fit', () => {
  it('grows on hover by its own amount, or the chosen look', () => {
    expect(getHatLayout('corner', ART.basic).grow).toBe(HAT_LOOK.grow);
    expect(getHatLayout('corner', { ...ART.basic, grow: 1.15 }).grow).toBe(1.15);
  });

  it.each(Object.entries(ART))('moves %s by exactly its offset where there is room', (_, fit) => {
    const at = getHatLayout('corner', fit, Infinity);
    const moved = getHatLayout('corner', { ...fit, offset: [5, -7] }, Infinity);
    expect(moved.reach.left).toBeCloseTo(at.reach.left + 5, 9);
    expect(moved.reach.top).toBeCloseTo(at.reach.top - 7, 9);
    expect(moved.origin).toBe(at.origin);
  });

  // Each axis on its own: the room is set 6px past where the hat already reaches, so only the
  // offset can carry it into the crop.
  it.each(Object.entries(ART))("cannot offset %s past its container's room", (_, fit) => {
    const at = getHatLayout('corner', fit, Infinity).reach;
    const roomLeft = -at.left + 6;
    const left = getHatLayout('corner', { ...fit, offset: [-12, 0] }, roomLeft).reach;
    expect(left.left).toBeCloseTo(-roomLeft, 6);
    const roomTop = -at.top + 6;
    const up = getHatLayout('corner', { ...fit, offset: [0, -12] }, roomTop).reach;
    expect(up.top).toBeCloseTo(-roomTop, 6);
  });

  it.each(Object.entries(ART))(
    'keeps %s inside the card in a carousel, whatever its fit',
    (_, fit) => {
      const { reach } = getHatLayout('inside', {
        ...fit,
        size: 64,
        depth: 0.2,
        offset: [-12, -12],
      });
      expect(reach.left).toBeGreaterThanOrEqual(2 - 1e-9);
      expect(reach.top).toBeGreaterThanOrEqual(2 - 1e-9);
    }
  );

  // Measured against the art placed on the card, not against the layout's own `reach`.
  it.each(Object.entries(ART))('moves the corner chips clear of %s wherever it sits', (_, own) => {
    const fit: EventDecorationFit = { ...own, size: 64, offset: [12, 0] };
    const placed = (fit.outline as number[][]).map((p) => toCard(fit, 'corner', p));
    const clear = getEventDecorationClearLeft({ type: 'hat', fit }, 'corner');
    expect(clear).toBeGreaterThan(Math.max(...placed.map((p) => p.x)));
  });

  it.each<[string, EventDecorationFit, EventDecorationFit]>([
    ['size', { size: 500 }, { size: 64 }],
    ['size', { size: 5 }, { size: 24 }],
    ['tilt', { tilt: -200 }, { tilt: -80 }],
    ['tilt', { tilt: 30 }, { tilt: 0 }],
    ['depth', { depth: 5 }, { depth: 0.8 }],
    ['depth', { depth: 0 }, { depth: 0.2 }],
    ['grow', { grow: 9 }, { grow: 1.6 }],
    ['grow', { grow: 0.5 }, { grow: 1 }],
    ['offset', { offset: [100, -100] }, { offset: [12, -12] }],
  ])('pulls a %s out of range to the nearest end', (_, wild, end) => {
    expect(getHatLayout('corner', { ...ART.basic, ...wild }, Infinity)).toEqual(
      getHatLayout('corner', { ...ART.basic, ...end }, Infinity)
    );
    expect(getHatLayout('corner', { ...ART.basic, ...end }, Infinity)).not.toEqual(
      getHatLayout('corner', ART.basic, Infinity)
    );
  });

  // The ranges a mod can set, agreed for the hat editor (2026-10-09). Change them deliberately.
  it('limits each setting to the agreed range', () => {
    expect(HAT_FIT_LIMITS).toEqual({
      size: [24, 64],
      tilt: [-80, 0],
      depth: [0.2, 0.8],
      grow: [1, 1.6],
      offset: [-12, 12],
    });
  });

  it("wears today's look when its fit sets none of these", () => {
    const settings = { size: 40, tilt: -45, depth: 0.47, grow: 1.4, offset: [0, 0] as [0, 0] };
    expect(getHatLayout('corner', { ...ART.civchan, ...settings })).toEqual(
      getHatLayout('corner', ART.civchan)
    );
  });
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
      tilt: Infinity,
      depth: 'x',
      grow: NaN,
      offset: [1],
    } as never;
    expect(getHatLayout('corner', broken)).toEqual(getHatLayout('corner'));
    expect(getHatLayout('corner', { offset: ['a', 1] } as never)).toEqual(getHatLayout('corner'));
  });
});

// What the editor previews is what a save stores: the same field-by-field merge.
describe('an unsaved hat edit', () => {
  const stored = { ...ART.basic, tilt: -30, grow: 1.2 };

  it('keeps the shape and the fields it does not touch', () => {
    expect(applyHatFitChanges(stored, { size: 50 })).toEqual({ ...stored, size: 50 });
  });

  it('drops a cleared field so the hat wears the default look', () => {
    const { grow: _, ...rest } = stored;
    expect(applyHatFitChanges(stored, { grow: null })).toEqual(rest);
    expect(getHatLayout('corner', applyHatFitChanges(stored, { grow: null })).grow).toBe(
      HAT_LOOK.grow
    );
  });

  it('skips a setting the edit leaves undefined', () => {
    const result = applyHatFitChanges(stored, { size: undefined, tilt: -50 });
    expect(result).toStrictEqual({ ...stored, tilt: -50 });
    expect('size' in result).toBe(false);
  });

  it('does not change the fit it was given', () => {
    const before = structuredClone(stored);
    applyHatFitChanges(stored, { tilt: null, size: 30 });
    expect(stored).toEqual(before);
  });
});

describe('a card narrower than a feed card', () => {
  const feedLayout = (fit: EventDecorationFit, nudge = 0) =>
    getHatLayout('corner', fit, Infinity, nudge);

  it.each([undefined, HAT_LOOK_CARD_WIDTH, 480, 0, -50, Number.NaN, Number.POSITIVE_INFINITY])(
    'wears the feed look at card width %s',
    (cardWidth) => {
      expect(getHatLayout('corner', ART.basic, Infinity, 0, cardWidth)).toEqual(
        feedLayout(ART.basic)
      );
    }
  );

  it.each(Object.entries(ART))('wears %s at half the size on a half-width card', (_, fit) => {
    const feed = feedLayout(fit, HAT_PLAIN_CARD_NUDGE);
    const half = getHatLayout(
      'corner',
      fit,
      Infinity,
      HAT_PLAIN_CARD_NUDGE,
      HAT_LOOK_CARD_WIDTH / 2
    );
    expect(half.width).toBeCloseTo(feed.width / 2, 9);
    expect(half.height).toBeCloseTo(feed.height / 2, 9);
    expect(half.left).toBeCloseTo(feed.left / 2, 9);
    expect(half.top).toBeCloseTo(feed.top / 2, 9);
    for (const side of ['left', 'top', 'right', 'bottom'] as const)
      expect(half.reach[side]).toBeCloseTo(feed.reach[side] / 2, 9);
    expect(half.tilt).toBe(feed.tilt);
    expect(half.grow).toBe(feed.grow);
  });

  it("shrinks a hat's own size and offset with the card", () => {
    const fit = { ...ART.basic, size: 60, offset: [10, -8] as [number, number] };
    const feed = feedLayout(fit);
    const half = getHatLayout('corner', fit, Infinity, 0, HAT_LOOK_CARD_WIDTH / 2);
    expect(half.width).toBeCloseTo(feed.width / 2, 9);
    expect(half.reach.left).toBeCloseTo(feed.reach.left / 2, 9);
    expect(half.reach.top).toBeCloseTo(feed.reach.top / 2, 9);
  });

  it("keeps the container's room unscaled", () => {
    const small = getHatLayout('corner', ART.civchan, 0, 0, HAT_LOOK_CARD_WIDTH / 2);
    expect(small.reach.left).toBeGreaterThanOrEqual(-1e-9);
    expect(small.reach.top).toBeGreaterThanOrEqual(-1e-9);
    const inside = getHatLayout('inside', ART.civchan, undefined, 0, HAT_LOOK_CARD_WIDTH / 2);
    expect(inside.reach.left).toBeCloseTo(2, 9);
    expect(inside.reach.top).toBeGreaterThanOrEqual(2 - 1e-9);
  });

  it('clears corner content by the smaller hat', () => {
    const half = HAT_LOOK_CARD_WIDTH / 2;
    expect(
      getEventDecorationClearLeft({ type: 'hat', fit: ART.basic }, 'inside', undefined, 0, half)
    ).toBe(Math.ceil(getHatLayout('inside', ART.basic, undefined, 0, half).reach.right) + 4);
    expect(getEventDecorationClearLeftCss({ type: 'hat', fit: ART.basic }, 'corner', 0, half)).toBe(
      `calc(${
        Math.ceil(getHatLayout('corner', ART.basic, Infinity, 0, half).reach.right) + 4
      }px + ${hatShiftCss(getHatLayout('corner', ART.basic, Infinity, 0, half).reach.left)})`
    );
  });

  it('scales by width over the look card, never up', () => {
    expect(getHatCardScale(HAT_LOOK_CARD_WIDTH / 4)).toBe(0.25);
    expect(getHatCardScale(HAT_LOOK_CARD_WIDTH * 2)).toBe(1);
    expect(getHatCardScale()).toBe(1);
    expect(HAT_LOOK_CARD_WIDTH).toBe(320);
  });
});
