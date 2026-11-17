// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  acquireImageLoadSlot,
  MAX_CONCURRENT_IMAGE_LOADS,
  useImageLoadSlot,
} from '~/components/ResourceReview/ReviewCard/imageLoadLimiter';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
});

function renderSlot(wanted: boolean) {
  const result: { current?: ReturnType<typeof useImageLoadSlot> } = {};
  const Probe = ({ wanted }: { wanted: boolean }) => {
    result.current = useImageLoadSlot(wanted);
    return null;
  };
  root = createRoot(document.createElement('div'));
  act(() => root!.render(React.createElement(Probe, { wanted })));
  return {
    result,
    rerender: (next: boolean) =>
      act(() => root!.render(React.createElement(Probe, { wanted: next }))),
  };
}

describe('useImageLoadSlot', () => {
  it('keeps its grant when the card leaves and re-enters view, without holding a second slot', () => {
    const { result, rerender } = renderSlot(true);
    expect(result.current?.granted).toBe(true);
    act(() => result.current?.release()); // its query settled

    rerender(false);
    rerender(true);
    expect(result.current?.granted).toBe(true);

    const grants = Array.from({ length: MAX_CONCURRENT_IMAGE_LOADS }, () => vi.fn());
    const slots = grants.map((grant) => acquireImageLoadSlot(grant));
    expect(grants.every((g) => g.mock.calls.length === 1)).toBe(true);
    slots.forEach((s) => s.release());
  });
});
