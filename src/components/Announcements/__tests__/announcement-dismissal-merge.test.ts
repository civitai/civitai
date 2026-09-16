// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import type { act as actType } from 'react-dom/test-utils';
import { createRoot } from 'react-dom/client';

import { useMergeServerDismissals } from '~/components/Announcements/announcement-dismissal-merge';

// React 18.3 exposes `act` on the `react` export, ahead of our @types/react.
const act = (React as unknown as { act: typeof actType }).act;

function renderMerge(
  props: {
    liveIds: number[];
    serverDismissedIds: number[];
    merge: (ids: number[]) => void;
  },
  { renders = 1 }: { renders?: number } = {}
) {
  const container = document.createElement('div');
  const root = createRoot(container);
  const Harness = () => {
    useMergeServerDismissals(props);
    return null;
  };

  for (let i = 0; i < renders; i++)
    act(() => {
      root.render(React.createElement(Harness));
    });

  act(() => {
    root.unmount();
  });
}

describe('useMergeServerDismissals', () => {
  /**
   * The whole point of the account-level store: an announcement dismissed on another device is
   * still live here, and the device store has never heard of it. Without this union it shows
   * again on every device but the one it was dismissed on.
   */
  it('merges an account dismissal the device store does not have', () => {
    const merge = vi.fn();

    renderMerge({ liveIds: [1, 2, 3], serverDismissedIds: [2], merge });

    expect(merge).toHaveBeenCalledWith([2]);
    expect(merge).toHaveBeenCalledTimes(1);
  });

  /**
   * The merge writes to a store every one of these surfaces renders from, so a merge that fires
   * per render is a render loop rather than wrong data — no assertion about the ids can see it.
   */
  it('merges once across re-renders with the same inputs', () => {
    const merge = vi.fn();

    renderMerge({ liveIds: [1, 2, 3], serverDismissedIds: [2], merge }, { renders: 3 });

    expect(merge).toHaveBeenCalledTimes(1);
  });

  /**
   * Paired with the case above deliberately: `merge` not being called proves nothing on its own,
   * so the only difference between the two is whether the account's id is one this surface shows.
   */
  it('does not merge an id this surface is not showing', () => {
    const merge = vi.fn();

    renderMerge({ liveIds: [1, 2, 3], serverDismissedIds: [90], merge });

    expect(merge).not.toHaveBeenCalled();
  });

  it('does not touch the store when the account has no dismissals', () => {
    const merge = vi.fn();

    renderMerge({ liveIds: [1, 2, 3], serverDismissedIds: [], merge });

    expect(merge).not.toHaveBeenCalled();
  });

  /**
   * Before the live set has landed the intersection is empty, so the hook waits without a guard
   * of its own. Merging the whole account list here would put ids in a bucket that does not own
   * them.
   */
  it('waits for the live set', () => {
    const merge = vi.fn();

    renderMerge({ liveIds: [], serverDismissedIds: [2], merge });

    expect(merge).not.toHaveBeenCalled();
  });
});
