// @vitest-environment happy-dom
import * as React from 'react';
import type { act as actType } from 'react-dom/test-utils';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as TrpcUtils from '~/utils/trpc';
import type * as ReactQuery from '@tanstack/react-query';

const act = (React as unknown as { act: typeof actType }).act;

const m = vi.hoisted(() => ({
  acceptTos: vi.fn(),
  trigger: vi.fn(),
  showInfoNotification: vi.fn(),
  listener: null as null | ((event: unknown) => void),
}));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof TrpcUtils>()),
    trpc: makeTrpcProxy({
      'strike.acceptTosAfterMute': { useMutation: () => ({ mutateAsync: m.acceptTos }) },
    }),
  };
});
vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof ReactQuery>()),
  useQueryClient: () => ({
    getMutationCache: () => ({
      subscribe: (listener: (event: unknown) => void) => {
        m.listener = listener;
        return () => undefined;
      },
    }),
  }),
}));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 1 }) }));
vi.mock('~/providers/AppProvider', () => ({
  useAppContext: () => ({ tosMeta: { fieldKey: 'f', hashFieldKey: 'h', hash: 'x' } }),
}));
vi.mock('~/components/Dialog/dialogStore', () => ({ dialogStore: { trigger: m.trigger } }));
vi.mock('~/utils/notifications', () => ({ showInfoNotification: m.showInfoNotification }));
vi.mock('next/dynamic', () => ({ default: () => () => null }));

const { useTosReacceptancePrompt } = await import('~/hooks/useTosReacceptancePrompt');

const blocked = () =>
  act(() =>
    m.listener?.({
      type: 'updated',
      action: { type: 'error', error: { data: { tosReacceptRequired: true } } },
    })
  );
const accept = async () => {
  const { onAccepted } = m.trigger.mock.calls.at(-1)![0].props;
  await act(async () => onAccepted());
};

beforeEach(() => {
  vi.clearAllMocks();
  m.listener = null;
  const root = createRoot(document.createElement('div'));
  function Probe() {
    useTosReacceptancePrompt();
    return null;
  }
  act(() => root.render(React.createElement(Probe)));
});

describe('useTosReacceptancePrompt', () => {
  it('opens the Terms on a blocked action, and not again once accepted', async () => {
    m.acceptTos.mockResolvedValue({ accepted: true });
    blocked();
    expect(m.trigger).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: 'tos-reacceptance' })
    );

    await accept();
    expect(m.showInfoNotification).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ title: 'Your account is still restricted', autoClose: false })
    );

    blocked();
    expect(m.trigger).toHaveBeenCalledOnce();
  });

  it('says nothing and keeps prompting when the acceptance did not record', async () => {
    m.acceptTos.mockRejectedValue(new Error('network'));
    blocked();
    await accept();
    expect(m.showInfoNotification).not.toHaveBeenCalled();

    blocked();
    expect(m.trigger).toHaveBeenCalledTimes(2);
  });
});
