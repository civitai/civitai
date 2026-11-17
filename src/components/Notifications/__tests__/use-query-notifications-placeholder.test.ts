// @vitest-environment happy-dom
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as TrpcModule from '~/utils/trpc';

/**
 * The panel asks for no placeholder: with one, a tab whose list is still loading shows the previous
 * tab's rows under its own heading (Updates rows under Comments).
 */

const act = (React as unknown as { act: (callback: () => void) => void }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let lastOptions: { placeholderData?: unknown } | undefined;
vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof TrpcModule>()),
    trpc: makeTrpcProxy({
      'notification.getAllByUser': {
        useInfiniteQuery: (_input: unknown, opts: { placeholderData?: unknown }) => {
          lastOptions = opts;
          return { data: undefined };
        },
      },
    }),
  };
});

const { keepPreviousData } = await import('@tanstack/react-query');
const { useQueryNotifications } = await import('~/components/Notifications/notifications.utils');

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => act(() => root?.unmount()));

function render(options: { keepPreviousData?: boolean }) {
  function Probe() {
    useQueryNotifications({ limit: 30, category: undefined }, options);
    return null;
  }
  root = createRoot(document.createElement('div'));
  act(() => root!.render(React.createElement(Probe)));
}

describe('useQueryNotifications placeholder', () => {
  it('shows no previous list when the caller passes keepPreviousData: false', () => {
    render({ keepPreviousData: false });
    expect(lastOptions?.placeholderData).toBeUndefined();
  });

  it('keeps the previous list when the caller asks for it', () => {
    render({ keepPreviousData: true });
    expect(lastOptions?.placeholderData).toBe(keepPreviousData);
  });
});
