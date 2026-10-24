// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import type { act as actType } from 'react-dom/test-utils';
import { createRoot } from 'react-dom/client';

import { useMergeServerDismissals } from '~/components/Announcements/announcement-dismissal-merge';

// React 18.3 exposes `act` on the `react` export, ahead of our @types/react.
const act = (React as unknown as { act: typeof actType }).act;

type MergeProps = {
  liveIds: number[];
  serverDismissedIds: number[];
  merge: (ids: number[]) => void;
};

/**
 * Renders the hook once per entry in `steps`, so a test can describe a SEQUENCE. The production
 * sequence is the point: `useServerDismissedAnnouncements` has no `initialData`, so the account's
 * ids are always absent on the first render and arrive on a later one.
 */
function renderMerge(...steps: MergeProps[]) {
  const container = document.createElement('div');
  const root = createRoot(container);
  const Harness = ({ props }: { props: MergeProps }) => {
    useMergeServerDismissals(props);
    return null;
  };

  for (const props of steps)
    act(() => {
      root.render(React.createElement(Harness, { props }));
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
   * 🔴 The sequence that actually ships. The account's ids are absent on the first render — the
   * query behind them has no `initialData` — so an effect that runs only on mount never merges
   * anything, for anyone, and the account store becomes write-only. Nothing about the ids can see
   * that; only a second render with different inputs can.
   */
  it('merges when the account list arrives after the first render', () => {
    const merge = vi.fn();
    const liveIds = [1, 2, 3];

    renderMerge(
      { liveIds, serverDismissedIds: [], merge },
      { liveIds, serverDismissedIds: [2], merge }
    );

    expect(merge).toHaveBeenCalledWith([2]);
    expect(merge).toHaveBeenCalledTimes(1);
  });

  /**
   * 🔴 The same sequence on the other input, and this one is not hypothetical either: the creator
   * surface has no seed at all. `useQueryFollowedAnnouncements` builds its list from a plain tRPC
   * query, so `liveIds` is empty on the first render and arrives on a later one — and a hook that
   * stops watching it never merges a creator dismissal at all.
   *
   * `serverDismissedIds` is deliberately the SAME array reference across both steps. A fresh
   * literal would re-run the effect on that dependency instead, and the test would pass with
   * `liveIds` dropped from the deps — varying two things and proving neither.
   */
  it('merges when the live set arrives after the first render', () => {
    const merge = vi.fn();
    const serverDismissedIds = [2];

    renderMerge(
      { liveIds: [], serverDismissedIds, merge },
      { liveIds: [1, 2, 3], serverDismissedIds, merge }
    );

    expect(merge).toHaveBeenCalledWith([2]);
    expect(merge).toHaveBeenCalledTimes(1);
  });

  /**
   * The merge writes to a store every one of these surfaces renders from, so a merge that fires
   * per render is a render loop rather than wrong data — no assertion about the ids can see it.
   */
  it('merges once across re-renders with the same inputs', () => {
    const merge = vi.fn();
    const props = { liveIds: [1, 2, 3], serverDismissedIds: [2], merge };

    renderMerge(props, props, props);

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
