// @vitest-environment happy-dom
import { MantineProvider } from '@mantine/core';
import { act, createElement } from 'react';
import type { Root } from 'react-dom/client';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const viewer = vi.hoisted(() => ({ current: null as { id: number } | null }));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => viewer.current }));
vi.mock('~/hooks/hidden-preferences', () => ({
  useHiddenPreferencesData: () => ({ hiddenModels: [] }),
  useToggleHiddenPreferences: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('~/utils/trpc', () => ({ trpc: { useUtils: () => ({}) } }));
vi.mock('~/components/LoginRedirect/LoginRedirect', () => ({
  LoginRedirect: ({ children }: { children: unknown }) => children,
}));

import { HideModelButton } from '~/components/HideModelButton/HideModelButton';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const VIEWER_ID = 42;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  viewer.current = null;
});

function renderButton(props: { modelId: number; ownerUserId: number }) {
  act(() => {
    root.render(createElement(MantineProvider, null, createElement(HideModelButton, props)));
  });
  return container.querySelector('button');
}

describe('HideModelButton owner check', () => {
  it('renders nothing on the viewer’s own model', () => {
    viewer.current = { id: VIEWER_ID };
    expect(renderButton({ modelId: 7, ownerUserId: VIEWER_ID })).toBeNull();
  });

  it('renders the button on a stranger’s model whose id equals the viewer’s user id', () => {
    viewer.current = { id: VIEWER_ID };
    expect(renderButton({ modelId: VIEWER_ID, ownerUserId: 99 })?.textContent).toBe('Hide');
  });

  it('renders the button for a signed-out viewer', () => {
    expect(renderButton({ modelId: 7, ownerUserId: VIEWER_ID })?.textContent).toBe('Hide');
  });
});
