// @vitest-environment happy-dom
import { MantineProvider } from '@mantine/core';
import { act, createElement } from 'react';
import type { Root } from 'react-dom/client';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Trpc from '~/utils/trpc';

const viewer = vi.hoisted(() => ({ current: null as { id: number } | null }));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => viewer.current }));
vi.mock('~/hooks/hidden-preferences', () => ({
  useHiddenPreferencesData: () => ({ hiddenModels: [] }),
  useToggleHiddenPreferences: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return { ...(await importOriginal<typeof Trpc>()), trpc: makeTrpcProxy() };
});
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

function renderButton(model: { id: number; user: { id: number } }) {
  act(() => {
    root.render(createElement(MantineProvider, null, createElement(HideModelButton, { model })));
  });
  return container.querySelector('button');
}

describe('HideModelButton owner check', () => {
  it('renders nothing on the viewer’s own model', () => {
    viewer.current = { id: VIEWER_ID };
    expect(renderButton({ id: 7, user: { id: VIEWER_ID } })).toBeNull();
  });

  it('renders the button on a stranger’s model whose id equals the viewer’s user id', () => {
    viewer.current = { id: VIEWER_ID };
    expect(renderButton({ id: VIEWER_ID, user: { id: 99 } })?.textContent).toBe('Hide');
  });

  it('renders the button for a signed-out viewer', () => {
    expect(renderButton({ id: 7, user: { id: VIEWER_ID } })?.textContent).toBe('Hide');
  });
});
