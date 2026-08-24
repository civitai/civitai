// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import * as React from 'react';
import type { act as actType } from 'react-dom/test-utils';
import { createRoot } from 'react-dom/client';
import {
  imageWithStickersUrl,
  STICKER_REVEAL_PARAM,
  stickerRevealRequested,
} from '~/components/Placement/queue-routes';
import {
  stickersRevealed,
  useStickerRevealParam,
  useStickerRevealStore,
} from '~/store/sticker-reveal.store';

const act = (React as unknown as { act: typeof actType }).act;

/** Mounts the hook and hands back a way to re-render it with a new argument. */
function mount(present: boolean) {
  const container = document.createElement('div');
  const root = createRoot(container);
  const Probe = ({ value }: { value: boolean }) => {
    useStickerRevealParam(value);
    return null;
  };

  act(() => root.render(React.createElement(Probe, { value: present })));

  return { unmount: () => act(() => root.unmount()) };
}

describe('the reveal query param', () => {
  beforeEach(() => {
    useStickerRevealStore.setState({ revealed: false, forced: false });
  });

  const shown = () => stickersRevealed(useStickerRevealStore.getState());

  /**
   * The link and the page agree on the value. They are written in one file for
   * this reason: a link carrying a value nothing recognises fails as a page that
   * simply does not reveal, which is indistinguishable from the bug the param
   * exists to fix.
   */
  it('recognises the value the link helper writes', () => {
    const query = new URL(imageWithStickersUrl(74), 'https://civitai.com').searchParams;

    expect(query.get(STICKER_REVEAL_PARAM)).not.toBeNull();
    expect(stickerRevealRequested(query.get(STICKER_REVEAL_PARAM) ?? undefined)).toBe(true);
    expect(stickerRevealRequested(undefined)).toBe(false);
    expect(stickerRevealRequested('0')).toBe(false);
  });

  /**
   * Shows the stickers WITHOUT writing the setting.
   *
   * Both halves are the decision (Justin, 2026-08-24): a link that turned the
   * site-wide toggle on for good would change a preference the viewer never set,
   * from a press that read as "see my sticker".
   */
  it('shows stickers for the view without changing the stored setting', () => {
    const view = mount(true);

    expect(shown()).toBe(true);
    expect(useStickerRevealStore.getState().revealed).toBe(false);
    view.unmount();
  });

  // The negative control for the pair above: without it, a store that reported
  // `true` unconditionally would pass every assertion in this file.
  it('leaves the reveal alone without it', () => {
    const view = mount(false);

    expect(shown()).toBe(false);
    view.unmount();
  });

  // Leaving the view takes the override with it, so the next image is back to
  // whatever the viewer actually chose.
  it('stops forcing once the view is gone', () => {
    const view = mount(true);
    expect(shown()).toBe(true);

    view.unmount();

    expect(shown()).toBe(false);
  });

  /**
   * The chip is inert while the link is forcing the reveal.
   *
   * It reads as ON — `stickersRevealed` is what feeds it — so a toggle that
   * flipped the stored flag underneath would leave the chip saying "on", the
   * stickers still showing, and the viewer's actual setting silently changed by
   * a press that appeared to do nothing.
   */
  it('does not let the chip flip the stored setting under a forced view', () => {
    const view = mount(true);

    useStickerRevealStore.getState().toggle();

    expect(useStickerRevealStore.getState().revealed).toBe(false);
    expect(shown()).toBe(true);
    view.unmount();
  });

  // The same press on an ordinary view, so the test above cannot pass against a
  // toggle that never does anything.
  it('still toggles when nothing is forcing it', () => {
    useStickerRevealStore.getState().toggle();

    expect(useStickerRevealStore.getState().revealed).toBe(true);
    expect(shown()).toBe(true);
  });

  /**
   * 🔴 The override is per-view and must not reach localStorage.
   *
   * Persisting it would survive the page: every image on the site would then
   * show its stickers, with a toggle that does nothing, from one visit to one
   * notification link — and nothing on screen would say why or offer a way back.
   */
  it('never writes the per-view override to storage', () => {
    useStickerRevealStore.getState().setForced(true);
    useStickerRevealStore.getState().setRevealed(true);

    const stored = JSON.parse(localStorage.getItem('sticker-reveal') ?? '{}');

    expect(stored.state).toEqual({ revealed: true });
  });
});
