import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
import { useDialogStore } from '~/components/Dialog/dialogStore';
import type { ResourceSelectModalProps } from '~/components/ImageGeneration/GenerationForm/ResourceSelectProvider';
import type { GenerationResource } from '~/shared/types/generation.types';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * App Blocks PAGE checkpoint picker (dev:live↔prod parity).
 *
 * The SDK hook `useCheckpointPicker()` posts OPEN_CHECKPOINT_PICKER and awaits
 * CHECKPOINT_PICKER_RESULT. The model-slot host (IframeHost) handles it, and the
 * dev:live SDK host serves it — but the PAGE host (PageBlockHost) historically
 * only handled the newer/wider OPEN_RESOURCE_PICKER, so a page block calling
 * `useCheckpointPicker()` had its request hit NO host handler (gotcha-#73): the
 * "Change model" button spun forever (no network call, no error). Authors
 * tested it working locally then it silently broke in prod.
 *
 * These tests mount the REAL PageBlockHost and drive the actual postMessage
 * bridge, asserting the newly-added handler mirrors IframeHost:
 *   1. OPEN_CHECKPOINT_PICKER (valid requestId + family hint) opens the native
 *      modal filtered to Checkpoint in that family, and on select posts back
 *      ONLY { requestId, versionId, modelId, modelName, versionName, baseModel }
 *      — the name/id-only projection, NO catalog / private / early-access leak;
 *   2. on cancel (close without pick) it posts a cancelled result (no `selected`);
 *   3. a request with no requestId (or non-string) is DROPPED — modal never
 *      opens, no reply;
 *   4. concurrent checkpoint + resource picks don't cross (each keeps its own
 *      requestId + result message type).
 *
 * The native modal is a dynamic import that needs real providers, so — exactly
 * like the OPEN_RESOURCE_PICKER test — we assert against the shared dialogStore
 * (where openResourceSelectModal triggers) and invoke the captured
 * onSelect/onClose callbacks to simulate the user's pick/dismiss.
 */

// PageBlockHost wires the workflow + storage bridges too; stub trpc so it mounts
// network-free (the checkpoint picker itself makes NO tRPC call — it reuses the
// native modal which talks to Meili in the parent context).
vi.mock('~/utils/trpc', () => ({
  // FeatureFlagsProvider (in PageBlockHost's real render graph) statically imports
  // `setTrpcBatchingEnabled` from this module (#2946). vi.mock replaces the module
  // wholesale, so the factory must re-declare it or the ESM link fails and the whole
  // test file fails to import.
  setTrpcBatchingEnabled: vi.fn(),
  trpc: {
    blocks: {
      submitWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      getMyBuzzBalance: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      estimateWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      pollWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      cancelWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
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

// eslint-disable-next-line import/first
import { PageBlockHost } from '~/components/AppBlocks/PageBlockHost';

function postFromBlock(type: string, payload?: unknown) {
  const iframeEl = page.getByTestId('app-page-iframe').element() as HTMLIFrameElement;
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
  const iframeEl = page.getByTestId('app-page-iframe').element() as HTMLIFrameElement;
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

// A representative GenerationResource the native modal would hand to onSelect.
// Includes fields that MUST NOT leak to the iframe (availability, hasAccess,
// minor/poi/sfwOnly, cover image) so the test proves the projection drops them.
function fakeResource(over: Partial<GenerationResource> = {}): GenerationResource {
  return {
    id: 9001, // = modelVersionId at the wire
    name: 'v1.0',
    baseModel: 'Flux.1 D',
    trainedWords: [],
    canGenerate: true,
    hasAccess: true,
    availability: 'Public',
    model: {
      id: 700,
      name: 'My Checkpoint',
      type: 'Checkpoint',
      nsfw: false,
      poi: true,
      minor: true,
      sfwOnly: true,
      userId: 5,
    },
    image: {
      id: 1,
      url: 'https://example/cover.jpg',
      width: 1,
      height: 1,
      hash: 'h',
      type: 'image',
    },
    ...over,
  } as unknown as GenerationResource;
}

const SAME_ORIGIN_SRC = `${window.location.origin}/`;

const baseProps = {
  appBlockId: 'apb_test',
  blockId: 'my-page-app',
  appId: 'app_test',
  blockInstanceId: 'page_apb_test',
  appName: 'Gen Matrix',
  iframeSrc: SAME_ORIGIN_SRC,
  sandbox: 'allow-scripts',
  trustTier: 'internal' as const,
  slug: 'my-page-app',
  token: 'tok_abc',
  expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  declaredScopes: ['ai:write:budgeted'],
  missingScopes: [] as string[],
  needsConsent: false,
  tokenError: false,
  viewer: { id: 42, username: 'tester' },
  theme: 'light' as const,
};

async function driveToReady() {
  await vi.waitFor(() => {
    const el = page.getByTestId('app-page-iframe').element() as HTMLIFrameElement;
    if (!el.contentWindow) throw new Error('not mounted yet');
  });
  await vi.waitFor(() => {
    postFromBlock('BLOCK_READY', {});
    const el = page.getByTestId('app-page-iframe').element() as HTMLIFrameElement;
    if (el.getAttribute('data-block-ready') !== 'true') throw new Error('not ready yet');
  });
}

describe('PageBlockHost checkpoint picker (dev:live↔prod parity with IframeHost)', () => {
  beforeEach(() => {
    useDialogStore.getState().closeAll();
  });

  test('OPEN_CHECKPOINT_PICKER opens the native modal filtered to Checkpoint in the requested family', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();

    postFromBlock('OPEN_CHECKPOINT_PICKER', { requestId: 'rq_ckpt', baseModelGroup: 'Flux1' });

    await vi.waitFor(() => {
      expect(useDialogStore.getState().dialogs).toHaveLength(1);
    });
    const props = lastResourceModalProps();
    // Checkpoint-only + canGenerate floor (native modal reused UNMODIFIED).
    expect(props.options?.resources).toHaveLength(1);
    expect(props.options?.resources?.[0].type).toBe('Checkpoint');
    expect(props.options?.canGenerate).toBe(true);
    // A family hint resolved to a non-empty baseModels list (Flux1 → Flux.1 D…).
    expect((props.options?.resources?.[0].baseModels ?? []).length).toBeGreaterThan(0);
  });

  test('on select posts back ONLY the name/id-only pick — no catalog / private / early-access leak', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('OPEN_CHECKPOINT_PICKER', { requestId: 'rq_pick' });
    await vi.waitFor(() => expect(useDialogStore.getState().dialogs).toHaveLength(1));

    // Simulate the user picking a checkpoint in the host modal.
    const props = lastResourceModalProps();
    props.onSelect(fakeResource());

    await vi.waitFor(() => {
      const r = replies.last('CHECKPOINT_PICKER_RESULT');
      if (!r) throw new Error('no reply yet');
      // EXACTLY the five-field projection IframeHost emits — IDs + the public
      // display names of the user-picked resource, nothing else.
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

    // Adversarial leak check: the reply must NOT carry any sensitive field from
    // the source GenerationResource. `modelType` is NOT in the checkpoint
    // projection either (the type is implicitly Checkpoint) — only the five
    // fields above.
    const payload = replies.last('CHECKPOINT_PICKER_RESULT')!.payload as {
      selected: Record<string, unknown>;
    };
    const sel = payload.selected;
    const sensitiveAbsent = ['availability', 'hasAccess', 'canGenerate', 'image', 'name',
      'nsfw', 'nsfwLevel', 'poi', 'minor', 'sfwOnly', 'userId', 'trainedWords', 'model', 'modelType'];
    for (const k of sensitiveAbsent) expect(sel).not.toHaveProperty(k);
    expect(Object.keys(sel).sort()).toEqual(
      ['baseModel', 'modelId', 'modelName', 'versionId', 'versionName']
    );
    replies.stop();
  });

  test('on cancel (close without pick) posts a cancelled result (no `selected`)', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('OPEN_CHECKPOINT_PICKER', { requestId: 'rq_cancel' });
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

  test('a pick does NOT also emit a spurious cancel (onClose after onSelect is a no-op)', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('OPEN_CHECKPOINT_PICKER', { requestId: 'rq_once' });
    await vi.waitFor(() => expect(useDialogStore.getState().dialogs).toHaveLength(1));

    const props = lastResourceModalProps();
    props.onSelect(fakeResource());
    props.onClose?.(); // the modal closes itself after a pick — must not double-fire

    await vi.waitFor(() => {
      const r = replies.last('CHECKPOINT_PICKER_RESULT');
      if (!r) throw new Error('no reply yet');
      expect((r.payload as { selected?: unknown }).selected).toBeDefined();
    });
    // EXACTLY one result for this requestId (the pick), no trailing cancel.
    const all = replies.received.filter(
      (m) => m.type === 'CHECKPOINT_PICKER_RESULT' && (m.payload as any)?.requestId === 'rq_once'
    );
    expect(all).toHaveLength(1);
    replies.stop();
  });

  test('a request with no requestId is dropped (no modal, no reply)', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('OPEN_CHECKPOINT_PICKER', { baseModelGroup: 'Flux1' });

    await new Promise((r) => setTimeout(r, 150));
    expect(useDialogStore.getState().dialogs).toHaveLength(0);
    expect(replies.last('CHECKPOINT_PICKER_RESULT')).toBeUndefined();
    replies.stop();
  });

  test('a request with a non-string requestId is dropped (no modal, no reply)', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('OPEN_CHECKPOINT_PICKER', { requestId: 42 });

    await new Promise((r) => setTimeout(r, 150));
    expect(useDialogStore.getState().dialogs).toHaveLength(0);
    expect(replies.last('CHECKPOINT_PICKER_RESULT')).toBeUndefined();
    replies.stop();
  });

  test('concurrent checkpoint + resource picks resolve to their OWN message type + requestId (no cross-talk)', async () => {
    // The native modal is one-at-a-time (the dialogStore holds a single modal),
    // so this drives open→pick→close per request. The guarantee that matters:
    // a CHECKPOINT_PICKER request resolves with CHECKPOINT_PICKER_RESULT (not
    // RESOURCE_PICKER_RESULT) and its own requestId, and vice-versa — the newly
    // added handler does not steal OPEN_RESOURCE_PICKER's replies or requestIds.
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    // Checkpoint pick.
    postFromBlock('OPEN_CHECKPOINT_PICKER', { requestId: 'rq_ck' });
    await vi.waitFor(() => expect(useDialogStore.getState().dialogs).toHaveLength(1));
    lastResourceModalProps().onSelect(
      fakeResource({ id: 111, model: { id: 11, name: 'CK', type: 'Checkpoint' } as any })
    );
    await vi.waitFor(() => {
      const r = replies.last('CHECKPOINT_PICKER_RESULT');
      if (!(r && (r.payload as any)?.requestId === 'rq_ck')) throw new Error('checkpoint not resolved');
    });
    useDialogStore.getState().closeAll();

    // Resource pick (Checkpoint via the wider handler) — a different message
    // type entirely.
    postFromBlock('OPEN_RESOURCE_PICKER', { requestId: 'rq_res', resourceType: 'Checkpoint' });
    await vi.waitFor(() => expect(useDialogStore.getState().dialogs).toHaveLength(1));
    lastResourceModalProps().onSelect(
      fakeResource({ id: 222, model: { id: 22, name: 'RES', type: 'Checkpoint' } as any })
    );
    await vi.waitFor(() => {
      const r = replies.last('RESOURCE_PICKER_RESULT');
      if (!(r && (r.payload as any)?.requestId === 'rq_res')) throw new Error('resource not resolved');
    });

    // Each result kept its own message type + requestId — the handlers don't cross.
    const ck = replies.received.find(
      (m) => m.type === 'CHECKPOINT_PICKER_RESULT' && (m.payload as any)?.requestId === 'rq_ck'
    )?.payload as { selected: { versionId: number } };
    const res = replies.received.find(
      (m) => m.type === 'RESOURCE_PICKER_RESULT' && (m.payload as any)?.requestId === 'rq_res'
    )?.payload as { selected: { versionId: number; modelType: string } };
    expect(ck.selected.versionId).toBe(111);
    expect(ck.selected).not.toHaveProperty('modelType'); // checkpoint projection has no modelType
    expect(res.selected).toMatchObject({ versionId: 222, modelType: 'Checkpoint' }); // resource one does
    replies.stop();
  });
});
