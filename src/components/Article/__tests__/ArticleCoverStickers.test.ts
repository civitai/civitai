// @vitest-environment happy-dom
import { beforeEach, describe, expect, test, vi } from 'vitest';
import * as React from 'react';
import type { act as actType } from 'react-dom/test-utils';
import { createRoot } from 'react-dom/client';

const act = (React as unknown as { act: typeof actType }).act;

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 🔴 THE GATE ON THE ARTICLE COVER, RENDERED — in the `unit` project, which is
 * the one CI runs. The sticker components' own tests are `*.browser.test.tsx`
 * in the `component` project, which no GitHub workflow invokes.
 *
 * `safe` is a boolean that no type checks: delete it from the condition and the
 * code still compiles, still renders, and draws a placed sticker over a cover
 * the viewer's browsing level blurred. That mutant is what these cases exist to
 * print, so each one names the state rather than asserting a truthy blob.
 *
 * The three sticker components are stubbed to markers deliberately. Their own
 * rendering is not the subject — the call site's composition is — and the two
 * things this pins that nothing else does are the gate and the CDN request
 * width, both of which are decisions taken here rather than in them.
 *
 * What this canNOT see, stated so a green run is not over-read: happy-dom
 * computes no layout, so the overlay's measurement, its offset parent, and the
 * pointer-events behaviour of a sticker over a cover link are all invisible
 * here. Those were verified in a browser against a real cover and stay that way.
 */

const flags = { stickerPlacement: true };

vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => flags,
}));

const overlayProps: Array<Record<string, unknown>> = [];
const badgeProps: Array<Record<string, unknown>> = [];
const providerProps: Array<Record<string, unknown>> = [];

vi.mock('~/components/Sticker/CardStickerOverlay', () => ({
  CardStickerOverlay: (props: Record<string, unknown>) => {
    overlayProps.push(props);
    return React.createElement('div', { 'data-testid': 'overlay' });
  },
}));

vi.mock('~/components/Sticker/StickerPlacementCardBadge', () => ({
  StickerPlacementCardBadge: (props: Record<string, unknown>) => {
    badgeProps.push(props);
    return React.createElement('button', { 'data-testid': 'badge' });
  },
}));

vi.mock('~/components/Sticker/StickerPlacementBatchProvider', () => ({
  StickerPlacementBatchProvider: (props: Record<string, unknown>) => {
    providerProps.push(props);
    return React.createElement(React.Fragment, null, props.children as React.ReactNode);
  },
}));

import { ArticleCoverStickers } from '~/components/Article/ArticleCoverStickers';

const IMAGE_ID = 139640277;

function render({ safe }: { safe: boolean }) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(React.createElement(ArticleCoverStickers, { imageId: IMAGE_ID, safe }));
  });
  return container;
}

describe('ArticleCoverStickers', () => {
  beforeEach(() => {
    flags.stickerPlacement = true;
    overlayProps.length = 0;
    badgeProps.length = 0;
    providerProps.length = 0;
    document.body.innerHTML = '';
  });

  test('draws the stickers and the reveal toggle on a safe cover', () => {
    const container = render({ safe: true });

    expect(
      container.querySelector('[data-testid="overlay"]'),
      'the sticker overlay'
    ).not.toBeNull();
    expect(container.querySelector('[data-testid="badge"]'), 'the reveal toggle').not.toBeNull();
  });

  test("🔴 draws NOTHING on a cover the viewer's browsing level blurred", () => {
    const container = render({ safe: false });

    expect(
      container.querySelector('[data-testid="overlay"]'),
      "a sticker drawn over a blurred cover — someone else's art on content this viewer is not cleared for"
    ).toBeNull();
    expect(container.querySelector('[data-testid="badge"]'), 'the reveal toggle').toBeNull();
  });

  test('🔴 asks for NO placements at all on a blurred cover', () => {
    render({ safe: false });

    expect(
      providerProps,
      'the batch provider mounted behind the gate, so a blurred cover still queries placements'
    ).toHaveLength(0);
  });

  test('draws nothing when the sticker placement flag is off', () => {
    flags.stickerPlacement = false;
    const container = render({ safe: true });

    expect(container.querySelector('[data-testid="overlay"]'), 'the sticker overlay').toBeNull();
    expect(container.querySelector('[data-testid="badge"]'), 'the reveal toggle').toBeNull();
  });

  test('requests cover-sized artwork, not the card default', () => {
    render({ safe: true });

    // 256 is the card constant and would upscale on a cover, which is visible
    // only as soft artwork on a retina display — nothing else would report it.
    expect(overlayProps[0]?.artworkWidth, 'the CDN request width for a cover sticker').toBe(512);
  });

  test('fetches placements for the cover image alone', () => {
    render({ safe: true });

    expect(providerProps[0]?.imageIds, 'the ids the batch provider fetches').toEqual([IMAGE_ID]);
  });
});
