// @vitest-environment happy-dom
import type { ReactElement } from 'react';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Trpc from '~/utils/trpc';
import { makeTrpcProxy } from '../../../../test/trpcProxyStub';

// Each "Not now" (or a dismissed native prompt) spends one of a few re-asks. A subscribe that fails
// AFTER the user said yes is our fault, and must not cost them a re-ask.
const mocks = vi.hoisted(() => ({
  enable: vi.fn(),
  mutate: vi.fn(),
  setData: vi.fn(),
  trackAction: vi.fn(() => Promise.resolve()),
  permission: 'default' as NotificationPermission,
}));

vi.mock('~/components/Notifications/usePushSubscription', () => ({
  usePushSubscription: () => ({ enable: mocks.enable, busy: false }),
}));
vi.mock('~/components/TrackView/track.utils', () => ({
  useTrackEvent: () => ({ trackAction: mocks.trackAction }),
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: makeTrpcProxy(
    {
      'user.getSettings': { useQuery: () => ({ data: { pushPromptDismissedCount: 1 } }) },
      'user.setSettings': { useMutation: () => ({ mutate: mocks.mutate }) },
    },
    {
      useUtils: () => ({ user: { getSettings: { setData: mocks.setData, invalidate: vi.fn() } } }),
    }
  ),
}));

import { usePushPromptActions } from '~/components/Notifications/pushPrompt';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function renderActions() {
  const result = { current: undefined as unknown as ReturnType<typeof usePushPromptActions> };
  function Probe() {
    result.current = usePushPromptActions('visit-prompt', 'new', 'desktop');
    return null;
  }
  act(() => createRoot(document.createElement('div')).render(createElement(Probe) as ReactElement));
  return result;
}

/** enable() as the browser would leave it: the permission it ends on, and whether it subscribed. */
function enableEndsWith(permission: NotificationPermission, ok: boolean) {
  mocks.enable.mockImplementation(async () => {
    mocks.permission = permission;
    return ok;
  });
}

const tracked = () =>
  mocks.trackAction.mock.calls.map(
    (c) => (c as unknown as [{ details: { action: string } }])[0].details.action
  );

beforeEach(() => {
  vi.clearAllMocks();
  mocks.permission = 'default';
  vi.stubGlobal('Notification', {
    get permission() {
      return mocks.permission;
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('usePushPromptActions dismissal budget', () => {
  it('a dismissed native prompt spends one re-ask', async () => {
    enableEndsWith('default', false);
    const actions = renderActions();
    await act(() => actions.current.enable());

    expect(tracked()).toContain('native_dismissed');
    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    expect(mocks.mutate.mock.calls[0][0]).toMatchObject({ pushPromptDismissedCount: 2 });
  });

  it('a subscribe that fails after permission was granted spends none', async () => {
    enableEndsWith('granted', false);
    const actions = renderActions();
    await act(() => actions.current.enable());

    expect(tracked()).toEqual(['enable_click', 'granted', 'failed']);
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it('"Not now" spends one re-ask', () => {
    const actions = renderActions();
    act(() => actions.current.notNow());

    expect(mocks.mutate).toHaveBeenCalledTimes(1);
  });
});
