// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Each applied query is a semantic search, so the box writes `?query=` on Enter, blur or clear,
 * never while the user types.
 */
const router = vi.hoisted(() => ({
  pathname: '/challenges',
  query: {} as Record<string, string>,
  push: vi.fn(),
}));
vi.mock('next/router', () => ({ useRouter: () => router }));
vi.mock('@tabler/icons-react', () => ({ IconSearch: () => null }));
vi.mock('@mantine/core', async () => {
  const { createElement: h } = await import('react');
  return {
    TextInput: ({
      rightSection,
      leftSection: _left,
      size: _size,
      radius: _radius,
      w: _w,
      ...props
    }: Record<string, unknown> & { rightSection?: ReactNode }) =>
      h('div', null, h('input', props), rightSection),
    CloseButton: ({ onClick }: { onClick: () => void }) =>
      h('button', { onClick, 'aria-label': 'Clear search' }),
  };
});

import { FeedSearchInput } from '../FeedSearchInput';

let container: HTMLDivElement;
const mount = () => {
  container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(createElement(FeedSearchInput, { placeholder: 'Search challenges' })));
};
const input = () => container.querySelector('input') as HTMLInputElement;
const type = (text: string) =>
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input(), text);
    input().dispatchEvent(new Event('input', { bubbles: true }));
  });
const pushed = () => router.push.mock.calls.map(([url]) => url.query);

beforeEach(() => {
  vi.useFakeTimers();
  router.query = { status: 'Active' };
  router.push.mockReset();
});

describe('FeedSearchInput', () => {
  it('does not search while typing, however long the pause', () => {
    mount();
    type('neon');
    act(() => vi.advanceTimersByTime(5_000));
    type('neon cities');
    act(() => vi.advanceTimersByTime(5_000));
    expect(router.push).not.toHaveBeenCalled();
  });

  it('applies the normalized text once on Enter, keeping the other params', () => {
    mount();
    type('  neon   cities ');
    act(() => {
      input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(pushed()).toEqual([{ status: 'Active', query: 'neon cities' }]);
  });

  it('applies on blur, and not again for the same text', () => {
    router.query = { query: 'neon' };
    mount();
    act(() => input().dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    expect(router.push).not.toHaveBeenCalled();
    type('robots');
    act(() => input().dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    expect(pushed()).toEqual([{ query: 'robots' }]);
  });

  it('clearing drops the query param', () => {
    router.query = { status: 'Active', query: 'neon' };
    mount();
    act(() => (container.querySelector('button') as HTMLButtonElement).click());
    expect(pushed()).toEqual([{ status: 'Active' }]);
  });
});
