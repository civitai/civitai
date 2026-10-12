// @vitest-environment happy-dom
import { MantineProvider } from '@mantine/core';
import { act, createElement } from 'react';
import type { Root } from 'react-dom/client';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Notifications from '~/utils/notifications';
import type * as Trpc from '~/utils/trpc';

const viewer = vi.hoisted(() => ({ current: null as { id: number } | null }));
const prefs = vi.hoisted(() => ({
  hiddenModels: [] as { id: number; hidden: boolean }[],
  mutateAsync: vi.fn(() => Promise.resolve()),
}));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => viewer.current }));
vi.mock('~/hooks/hidden-preferences', () => ({
  useHiddenPreferencesData: () => ({ hiddenModels: prefs.hiddenModels }),
  useToggleHiddenPreferences: () => ({ mutateAsync: prefs.mutateAsync, isPending: false }),
}));
vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return { ...(await importOriginal<typeof Trpc>()), trpc: makeTrpcProxy() };
});
vi.mock('~/utils/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof Notifications>()),
  showSuccessNotification: vi.fn(),
}));
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
  prefs.hiddenModels = [];
  prefs.mutateAsync.mockClear();
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

  it('hides the model by its own id, not its owner’s', async () => {
    viewer.current = { id: VIEWER_ID };
    const button = renderButton({ id: 7, user: { id: 99 } });
    await act(async () => button?.click());
    expect(prefs.mutateAsync).toHaveBeenCalledTimes(1);
    expect(prefs.mutateAsync).toHaveBeenCalledWith({ kind: 'model', data: [{ id: 7 }] });
  });

  it('reads the hidden state by the model’s own id, not its owner’s', () => {
    viewer.current = { id: VIEWER_ID };
    prefs.hiddenModels = [{ id: 7, hidden: true }];
    expect(renderButton({ id: 7, user: { id: 99 } })?.textContent).toBe('Unhide');
  });
});
