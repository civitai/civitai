import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
import { useDialogStore } from '~/components/Dialog/dialogStore';
import type { ResourceSelectModalProps } from '~/components/ImageGeneration/GenerationForm/ResourceSelectProvider';
import type { GenerationResource } from '~/shared/types/generation.types';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import type { BlockInstall, ModelSlotContext } from './types';

/**
 * App Blocks MODEL-SLOT checkpoint picker (the shipped `OPEN_CHECKPOINT_PICKER`
 * handler on `IframeHost`).
 *
 * A block mounted in a model slot fires OPEN_CHECKPOINT_PICKER to let the viewer
 * pick a Checkpoint. The host opens its OWN native ResourceSelectModal as host
 * chrome (the iframe never sees the catalog) and posts back ONLY the single
 * picked resource via CHECKPOINT_PICKER_RESULT.
 *
 * SECURITY HARDENING under test (mirrors the page picker's `publicOnly`):
 *   the modal is opened with `options.publicOnly: true`, which forces the Meili
 *   visibility filter to PUBLIC resources and DROPS the native modal's
 *   `OR user.id = <me>` clause — so an untrusted block can NEVER enumerate the
 *   viewer's OWN private checkpoints through this picker. This is a deliberate
 *   behaviour change: a model-slot block's picker no longer shows the viewer's
 *   private library (the intended hardening). See useResourceSelectMeiliFilters.
 *
 * The native modal is a dynamic import that needs real providers, so — exactly
 * like the page picker + OPEN_BUZZ_PURCHASE tests — we assert against the shared
 * dialogStore (where openResourceSelectModal triggers) and invoke the captured
 * onSelect/onClose callbacks to simulate the user's pick/dismiss. (The full
 * Meili-filter wiring of `publicOnly` is proven separately by the page picker
 * suite + useResourceSelectMeiliFilters; here we assert the model-slot call site
 * passes the flag through the SAME ResourceSelectOptions plumbing.)
 */

// IframeHost wires the workflow + storage + checkpoint bridges; stub trpc so it
// mounts network-free. The checkpoint picker itself makes NO tRPC call — it
// reuses the native modal which talks to Meili in the parent context.
vi.mock('~/utils/trpc', () => ({
  trpc: {
    blocks: {
      getEffectiveCheckpoint: { useQuery: () => ({ data: undefined, isLoading: false }) },
      getShowcaseImages: { useQuery: () => ({ data: undefined, isLoading: false }) },
      submitWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      estimateWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      pollWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      cancelWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      updateUserSettings: { useMutation: () => ({ mutateAsync: vi.fn() }) },
    },
    apps: {
      storage: {
        set: { useMutation: () => ({ mutateAsync: vi.fn() }) },
        delete: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      },
    },
    useUtils: () => ({
      apps: {
        storage: {
          get: { fetch: vi.fn() },
          list: { fetch: vi.fn() },
          getQuota: { fetch: vi.fn() },
        },
      },
    }),
  },
}));

// The browsing-level provider isn't mounted by renderWithProviders.
vi.mock('~/components/BrowsingLevel/BrowsingLevelProvider', () => ({
  useBrowsingLevelDebounced: () => 1,
}));

// eslint-disable-next-line import/first
import { IframeHost } from '~/components/AppBlocks/IframeHost';

const SAME_ORIGIN_SRC = `${window.location.origin}/`;

function postFromBlock(type: string, payload?: unknown) {
  const iframeEl = page.getByTestId('block-iframe').element() as HTMLIFrameElement;
  const cw = iframeEl.contentWindow;
  if (!cw) throw new Error('iframe contentWindow missing');
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { type, payload },
      origin: window.location.origin,
      source: cw,
    })
  );
}

function listenForReply() {
  const received: Array<{ type: string; payload: unknown }> = [];
  const iframeEl = page.getByTestId('block-iframe').element() as HTMLIFrameElement;
  const cw = iframeEl.contentWindow;
  if (!cw) throw new Error('iframe contentWindow missing');
  const handler = (e: MessageEvent) => {
    const d = e.data as { type?: string; payload?: unknown } | null;
    if (d && typeof d.type === 'string') received.push({ type: d.type, payload: d.payload });
  };
  cw.addEventListener('message', handler);
  return {
    received,
    last: (type: string) => [...received].reverse().find((m) => m.type === type),
    stop: () => cw.removeEventListener('message', handler),
  };
}

// The dialogStore entry openResourceSelectModal triggers — its `props` is the
// ResourceSelectModalProps we passed (onSelect/onClose/options/title).
function lastResourceModalProps(): ResourceSelectModalProps {
  const dialogs = useDialogStore.getState().dialogs;
  if (dialogs.length === 0) throw new Error('no resource-select modal opened');
  return dialogs[dialogs.length - 1].props as unknown as ResourceSelectModalProps;
}

function fakeResource(over: Partial<GenerationResource> = {}): GenerationResource {
  return {
    id: 9001, // = modelVersionId at the wire
    name: 'v1.0',
    baseModel: 'Flux.1 D',
    trainedWords: [],
    canGenerate: true,
    hasAccess: true,
    availability: 'Public',
    model: { id: 700, name: 'My Checkpoint', type: 'Checkpoint', userId: 5 },
    ...over,
  } as unknown as GenerationResource;
}

const modelContext: ModelSlotContext = {
  slotId: 'model.sidebar_top',
  entityType: 'model',
  modelId: 700,
  modelVersionId: 9001,
  modelName: 'My Checkpoint',
  modelType: 'Checkpoint',
  modelNsfwLevel: 1,
  creatorUserId: 5,
  viewerUserId: 42,
  viewerNsfwEnabled: false,
  viewerUsername: 'tester',
  theme: 'light',
};

const install: BlockInstall = {
  blockInstanceId: 'inst_test',
  blockId: 'my-model-app',
  appId: 'app_test',
  appBlockId: 'apb_test',
  manifest: {
    name: 'My Model App',
    iframe: {
      src: SAME_ORIGIN_SRC,
      minHeight: 200,
      maxHeight: null,
      resizable: true,
      sandbox: 'allow-scripts',
    },
  },
  publisherSettings: {},
  enabled: true,
  renderMode: 'iframe',
  // internal tier → sandbox keeps allow-same-origin → inbound pinned to the
  // real (same) origin, matching the messages we dispatch.
  trustTier: 'internal',
};

const baseProps = {
  install,
  context: modelContext,
  token: 'tok_abc',
  expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
};

async function mountAndWaitForIframe() {
  renderWithProviders(<IframeHost {...baseProps} />);
  await vi.waitFor(() => {
    const el = page.getByTestId('block-iframe').element() as HTMLIFrameElement;
    if (!el.contentWindow) throw new Error('not mounted yet');
  });
}

describe('IframeHost model-slot checkpoint picker', () => {
  beforeEach(() => {
    useDialogStore.getState().closeAll();
  });

  test('OPEN_CHECKPOINT_PICKER opens the native modal with publicOnly:true (no private-library leak)', async () => {
    await mountAndWaitForIframe();

    postFromBlock('OPEN_CHECKPOINT_PICKER', {
      requestId: 'rq_ckpt',
      baseModelGroup: 'Flux1',
    });

    await vi.waitFor(() => {
      expect(useDialogStore.getState().dialogs).toHaveLength(1);
    });
    const props = lastResourceModalProps();
    // Checkpoint type + canGenerate floor + PUBLIC-ONLY hardening.
    expect(props.options?.resources).toHaveLength(1);
    expect(props.options?.resources?.[0].type).toBe('Checkpoint');
    expect(props.options?.canGenerate).toBe(true);
    // The hardening: a model-slot block must not enumerate the viewer's private
    // checkpoints — the SAME ResourceSelectOptions.publicOnly the page picker
    // uses, which drops the `OR user.id = me` Meili clause.
    expect(props.options?.publicOnly).toBe(true);
    // A family hint resolved to a non-empty baseModels list (Flux1 → Flux.1 D…).
    expect((props.options?.resources?.[0].baseModels ?? []).length).toBeGreaterThan(0);
  });

  test('on select posts CHECKPOINT_PICKER_RESULT with the chosen version (pick→post-back flow intact)', async () => {
    await mountAndWaitForIframe();
    const replies = listenForReply();

    postFromBlock('OPEN_CHECKPOINT_PICKER', { requestId: 'rq_pick', baseModelGroup: 'Flux1' });
    await vi.waitFor(() => expect(useDialogStore.getState().dialogs).toHaveLength(1));

    const props = lastResourceModalProps();
    props.onSelect(fakeResource());

    await vi.waitFor(() => {
      const r = replies.last('CHECKPOINT_PICKER_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({
        requestId: 'rq_pick',
        selected: {
          versionId: 9001,
          modelId: 700,
          modelName: 'My Checkpoint',
          versionName: 'v1.0',
          baseModel: 'Flux.1 D',
        },
      });
    });
    replies.stop();
  });

  test('on cancel (close without pick) posts a cancelled CHECKPOINT_PICKER_RESULT (no `selected`)', async () => {
    await mountAndWaitForIframe();
    const replies = listenForReply();

    postFromBlock('OPEN_CHECKPOINT_PICKER', { requestId: 'rq_cancel', baseModelGroup: 'Flux1' });
    await vi.waitFor(() => expect(useDialogStore.getState().dialogs).toHaveLength(1));

    const props = lastResourceModalProps();
    props.onClose?.(); // user dismissed without selecting

    await vi.waitFor(() => {
      const r = replies.last('CHECKPOINT_PICKER_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({ requestId: 'rq_cancel' });
    });
    replies.stop();
  });
});
