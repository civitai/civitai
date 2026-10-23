import { afterEach, describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import type { ReactElement, ReactNode } from 'react';
import { Badge, Text } from '@mantine/core';
import { AnimatedCount } from '~/components/Metrics/AnimatedCount';
import { nextLayout, renderWithProviders } from '../../../test/geometry-setup';

/**
 * Animated digits paint on the same pixel rows as plain text.
 *
 * Layout boxes do not show this (they agree to 0.01px); only painted ink does, so each case
 * screenshots an `AnimatedCount` beside the same number as plain text and compares ink rows.
 * With a fractional digit row height (root font size other than 16px) the digits painted up to
 * ~1px off plain text. CI runs this at DPR 1 only.
 */

const structures: Record<string, (inner: ReactNode) => ReactElement> = {
  'tailwind text-sm': (inner) => (
    <span className="text-sm font-extrabold tabular-nums">{inner}</span>
  ),
  // Mantine forces `line-height: inherit` on everything inside a Badge label.
  'mantine badge': (inner) => (
    <Badge variant="transparent" c="#000" tt="none" size="lg" fw={800} p={0}>
      {inner}
    </Badge>
  ),
  'mantine sm': (inner) => (
    <Text fw={800} size="sm" className="tabular-nums">
      {inner}
    </Text>
  ),
};

afterEach(() => {
  document.documentElement.style.fontSize = '';
});

async function inkOf(el: Element, region: DOMRect, root: DOMRect) {
  const base64 = await page.elementLocator(el).screenshot({ save: false });
  const img = new Image();
  img.src = `data:image/png;base64,${base64}`;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0);
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const scale = img.width / root.width;
  const x0 = Math.floor((region.left - root.left) * scale);
  const x1 = Math.ceil((region.right - root.left) * scale);
  let total = 0;
  let weighted = 0;
  let first = -1;
  let last = -1;
  for (let y = 0; y < img.height; y++) {
    let row = 0;
    for (let x = x0; x < Math.min(x1, img.width); x++) row += 255 - data[(y * img.width + x) * 4];
    if (row > 510) {
      if (first < 0) first = y;
      last = y;
    }
    total += row;
    weighted += row * y;
  }
  return { first, last, centre: weighted / total };
}

/** Ink of the animated number minus ink of the plain one, both rendered side by side. */
async function measure(
  structure: string,
  value: number,
  rootPx: number,
  offsetPx: number,
  plantedShiftPx = 0
) {
  document.documentElement.style.fontSize = `${rootPx}px`;
  const render = structures[structure];
  renderWithProviders(
    <div
      data-testid="pair"
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 40,
        width: 360,
        padding: 10,
        paddingTop: 10 + offsetPx,
        background: '#fff',
        color: '#000',
      }}
    >
      <div data-r="animated" style={{ position: 'relative', top: plantedShiftPx }}>
        {render(<AnimatedCount value={value} abbreviate={false} />)}
      </div>
      <div data-r="plain">{render(value.toLocaleString('en-US'))}</div>
    </div>
  );
  await nextLayout();
  await Promise.all(document.getAnimations().map((a) => a.finished));
  const pair = document.querySelector('[data-testid="pair"]')!;
  const root = pair.getBoundingClientRect();
  const animated = pair.querySelector('[data-r="animated"]')!.getBoundingClientRect();
  const plain = pair.querySelector('[data-r="plain"]')!.getBoundingClientRect();
  const a = await inkOf(pair, animated, root);
  const p = await inkOf(pair, plain, root);
  return {
    top: a.first - p.first,
    bottom: a.last - p.last,
    centre: a.centre - p.centre,
    digitWindow: getComputedStyle(pair.querySelector('[data-testid="cnf-digit"]')!).height,
    digitFontSize: getComputedStyle(pair.querySelector('[data-testid="cnf-digit"]')!).fontSize,
    rowPitch: `${
      pair.querySelector('[data-testid="cnf-digit"]')!.firstElementChild!.getBoundingClientRect()
        .height / 10
    }px`,
  };
}

describe('AnimatedCount digit rows', () => {
  for (const structure of Object.keys(structures)) {
    test.each([
      [280389, 0],
      [280389, 0.5],
      [987654, 0],
      [987654, 0.5],
    ])(
      `${structure}: ink matches plain text at an 18px root (value %i, offset %fpx)`,
      async (value, offset) => {
        const m = await measure(structure, value, 18, offset);
        expect(m.top).toBe(0);
        expect(m.bottom).toBe(0);
        expect(Math.abs(m.centre)).toBeLessThan(0.25);
      }
    );

    test(`${structure}: default 16px root is unchanged`, async () => {
      // A badge at a half-pixel offset already differs from plain text at 16px, before this change.
      const m = await measure(structure, 280389, 16, structure === 'mantine badge' ? 0 : 0.5);
      expect(m.digitWindow).toBe(m.digitFontSize);
      expect(m.rowPitch).toBe(m.digitWindow);
      if (structure !== 'mantine badge') expect(m.digitWindow).toBe('14px');
      expect(m.top).toBe(0);
      expect(m.bottom).toBe(0);
      expect(Math.abs(m.centre)).toBeLessThan(0.05);
    });

    test(`${structure}: window and row pitch are the same whole px at an 18px root`, async () => {
      const m = await measure(structure, 280389, 18, 0);
      expect(Number.isInteger(parseFloat(m.digitWindow))).toBe(true);
      expect(m.rowPitch).toBe(m.digitWindow);
      if (structure !== 'mantine badge') expect(m.digitWindow).toBe('16px');
    });
  }

  test('the measurement sees a 1px shift', async () => {
    const m = await measure('mantine sm', 280389, 16, 0, 1);
    expect(m.top).toBe(1);
    expect(m.bottom).toBe(1);
    expect(m.centre).toBeGreaterThan(0.9);
  });
});
