import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as RoutedDialogLinkMod from '~/components/Dialog/RoutedDialogLink';

const trigger = vi.hoisted(() => vi.fn());
vi.mock('~/components/Dialog/RoutedDialogLink', async (importOriginal) => ({
  ...(await importOriginal<typeof RoutedDialogLinkMod>()),
  triggerRoutedDialog: trigger,
}));

import { storylineChapterLinkProps } from '~/components/Storyline/storyline-read-link';

type ClickField = 'button' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'defaultPrevented';
const click = (init: Partial<Record<ClickField, unknown>>) => {
  const event = {
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
    ...init,
    preventDefault: vi.fn(),
  };
  return event;
};

const link = {
  href: '/images/6000?storylineChapter=60&storylineVia=13,42',
  read: { imageId: 6000, chapterId: 60, via: [13, 42] },
};

beforeEach(() => trigger.mockReset());

describe('storylineChapterLinkProps', () => {
  it('opens the reader over the page on a plain click, on the route the href names', () => {
    const props = storylineChapterLinkProps(link);
    const event = click({});
    props.onClick?.(event as never);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(trigger).toHaveBeenCalledWith({
      name: 'imageDetail',
      state: { imageId: 6000, storylineChapterId: 60, storylineVia: [13, 42] },
    });
    expect(props.href).toBe(link.href);
  });

  it('leaves a new-tab click to the browser, which follows the href', () => {
    const props = storylineChapterLinkProps(link);
    for (const init of [
      { metaKey: true },
      { ctrlKey: true },
      { shiftKey: true },
      { altKey: true },
      { button: 1 },
      // Something else already handled it.
      { defaultPrevented: true },
    ]) {
      const event = click(init);
      props.onClick?.(event as never);
      expect(event.preventDefault).not.toHaveBeenCalled();
    }
    expect(trigger).not.toHaveBeenCalled();
  });

  it('is a plain link to the post when there is no image to open', () => {
    expect(storylineChapterLinkProps({ href: '/posts/220', read: null })).toEqual({
      href: '/posts/220',
      onClick: undefined,
    });
  });
});
