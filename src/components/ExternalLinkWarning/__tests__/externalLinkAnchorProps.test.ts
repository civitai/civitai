import { beforeEach, describe, expect, it, vi } from 'vitest';
import type React from 'react';

const mocks = vi.hoisted(() => ({ openExternalLinkWarning: vi.fn() }));
vi.mock('~/components/ExternalLinkWarning/openExternalLinkWarning', () => ({
  openExternalLinkWarning: mocks.openExternalLinkWarning,
}));

const { externalLinkAnchorProps } = await import(
  '~/components/ExternalLinkWarning/externalLinkAnchorProps'
);

const click = (init: Partial<Record<'ctrlKey' | 'metaKey' | 'shiftKey', boolean>> = {}) => {
  const preventDefault = vi.fn();
  return {
    event: {
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      ...init,
      preventDefault,
    } as unknown as React.MouseEvent<HTMLElement>,
    preventDefault,
  };
};

// The browser tests drive these handlers through real clicks but run in no gating job; this is
// the floor CI does run.
describe('externalLinkAnchorProps', () => {
  beforeEach(() => mocks.openExternalLinkWarning.mockClear());

  it('links to the warning page, not the destination', () => {
    expect(externalLinkAnchorProps('https://t.me/SomeGroup').href).toBe(
      '/leaving?url=https://t.me/SomeGroup'
    );
  });

  it('a plain click is cancelled and opens the in-page warning, reported once', () => {
    const onActivate = vi.fn();
    const { event, preventDefault } = click();
    externalLinkAnchorProps('https://t.me/SomeGroup', onActivate).onClick(event);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(mocks.openExternalLinkWarning).toHaveBeenCalledWith('https://t.me/SomeGroup');
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it.each(['ctrlKey', 'metaKey', 'shiftKey'] as const)(
    'a %s click is left to the browser, which opens the warning page',
    (key) => {
      const onActivate = vi.fn();
      const { event, preventDefault } = click({ [key]: true });
      externalLinkAnchorProps('https://t.me/SomeGroup', onActivate).onClick(event);
      expect(preventDefault).not.toHaveBeenCalled();
      expect(mocks.openExternalLinkWarning).not.toHaveBeenCalled();
      expect(onActivate).toHaveBeenCalledTimes(1);
    }
  );

  it.each([
    [1, 1],
    [2, 0],
  ])('auxclick with button %i is reported %i time(s)', (button, times) => {
    const onActivate = vi.fn();
    externalLinkAnchorProps('https://t.me/SomeGroup', onActivate).onAuxClick({
      button,
    } as React.MouseEvent<HTMLElement>);
    expect(onActivate).toHaveBeenCalledTimes(times);
  });
});
