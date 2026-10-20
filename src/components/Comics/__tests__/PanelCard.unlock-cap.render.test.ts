// @vitest-environment happy-dom
import { MantineProvider } from '@mantine/core';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import type { act as actType } from 'react-dom/test-utils';
import { afterEach, expect, it, vi } from 'vitest';
import type * as Trpc from '~/utils/trpc';
import { NSFW_CAPPED, NSFW_CAPPED_MESSAGE } from '~/shared/orchestrator/workflow-data';
import { makeTrpcProxy } from '../../../../test/trpcProxyStub';

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// A panel capped during the session: the chapter cache never received the reason the poll
// persisted, so the card must take it from the poll reply or it offers the unlock again.
const h = vi.hoisted(() => ({ poll: vi.fn() }));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: makeTrpcProxy(
    {},
    {
      useUtils: () => ({
        comics: {
          pollPanelStatus: { fetch: h.poll },
          getChapter: { setData: vi.fn(), invalidate: vi.fn(async () => undefined) },
        },
      }),
    }
  ),
}));
vi.mock('@dnd-kit/sortable', () => ({
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: () => undefined,
    transform: null,
    transition: undefined,
    isDragging: false,
  }),
}));
vi.mock('~/components/Signals/SignalsProvider', () => ({ useSignalConnection: () => undefined }));
vi.mock('~/components/Post/EditV2/ImageMetaModal', () => ({ ImageMetaModal: () => null }));
vi.mock('~/components/Dialog/dialogStore', () => ({ dialogStore: { trigger: vi.fn() } }));
vi.mock('~/components/Dialog/triggers/set-browsing-level', () => ({
  openSetBrowsingLevelModal: vi.fn(),
}));
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ isGreen: false }),
}));
vi.mock('~/providers/AppProvider', () => ({ useServerDomains: () => ({ red: 'civitai.red' }) }));
vi.mock('~/hooks/useSyncAccount', () => ({ useSyncAccount: () => (url: string) => url }));

const { PanelCard } = await import('~/components/Comics/PanelCard');

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = '';
});

const buttonLabels = () =>
  Array.from(document.body.querySelectorAll('button')).map((el) => el.textContent?.trim());

it('offers no unlock once the poll reports the output capped', async () => {
  h.poll.mockResolvedValue({
    id: 1,
    status: 'RequireUnlock',
    imageUrl: null,
    errorMessage: NSFW_CAPPED_MESSAGE,
    blockedReason: NSFW_CAPPED,
    blurredPreviewUrl: null,
  });
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const noop = () => undefined;
  await act(async () => {
    root!.render(
      React.createElement(
        MantineProvider,
        null,
        React.createElement(PanelCard, {
          panel: {
            id: 1,
            imageId: null,
            imageUrl: null,
            prompt: 'a panel',
            status: 'RequireUnlock',
            workflowId: 'wf-1',
            errorMessage: null,
            metadata: { quantity: 1 },
          },
          projectId: 11,
          chapterPosition: 1,
          position: 0,
          referenceNames: [],
          onDelete: noop,
          onRegenerate: noop,
          onDuplicate: noop,
          onInsertAfter: noop,
          onClick: noop,
        })
      )
    );
  });

  expect(h.poll).toHaveBeenCalledWith({ panelId: 1 }, expect.anything());
  expect(buttonLabels()).not.toContain('Unlock');
  expect(buttonLabels()).toContain('Regenerate');
  expect(document.body.textContent).toContain(NSFW_CAPPED_MESSAGE);
});
