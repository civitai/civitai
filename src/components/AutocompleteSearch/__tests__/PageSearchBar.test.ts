// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The header bar on a page that searches its own content: a plain box for the page's `?query=`,
 * written on Enter, blur or clear, never while typing; Enter and clear also tell the header.
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
      variant: _variant,
      ...props
    }: Record<string, unknown> & { rightSection?: ReactNode }) =>
      h('div', null, h('input', props), rightSection),
    CloseButton: ({ onClick }: { onClick: () => void }) =>
      h('button', { onClick, 'aria-label': 'Clear search' }),
  };
});

import { PageSearchBar } from '../PageSearchBar';

const onSubmit = vi.fn();
const onClear = vi.fn();
let container: HTMLDivElement;
const mount = () => {
  container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() =>
    root.render(createElement(PageSearchBar, { placeholder: 'Search the shop', onSubmit, onClear }))
  );
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
  router.pathname = '/shop';
  router.query = {};
  router.push.mockReset();
  onSubmit.mockReset();
  onClear.mockReset();
});

describe('PageSearchBar', () => {
  it("does not search while typing; Enter writes the page's query and tells the header", () => {
    mount();
    type('wings');
    expect(router.push).not.toHaveBeenCalled();
    act(() => {
      input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(pushed()).toEqual([{ query: 'wings' }]);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('shows the query already on the URL, and clearing drops it', () => {
    router.query = { query: 'wings' };
    mount();
    expect(input().value).toBe('wings');
    act(() => (container.querySelector('button') as HTMLButtonElement).click());
    expect(pushed()).toEqual([{}]);
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});
