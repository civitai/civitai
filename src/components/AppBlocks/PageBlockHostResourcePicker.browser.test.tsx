import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
import { useDialogStore } from '~/components/Dialog/dialogStore';
import type { ResourceSelectModalProps } from '~/components/ImageGeneration/GenerationForm/ResourceSelectProvider';
import type { GenerationResource } from '~/shared/types/generation.types';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * App Blocks PAGE resource picker (Design 1 — host-chrome).
 *
 * A full-page App Block (`/apps/run/<slug>`) that wants to let the USER pick a
 * generation resource (Checkpoint / LoRA) — instead of the author hard-coding
 * version IDs — posts OPEN_RESOURCE_PICKER. The host opens its OWN native
 * ResourceSelectModal as host chrome (the iframe never sees the catalog), and
 * posts back ONLY the single picked resource via RESOURCE_PICKER_RESULT. This
 * generalizes the model-slot OPEN_CHECKPOINT_PICKER to pages + widens it from
 * Checkpoint-only to a typed allowlist (v1: Checkpoint + LoRA).
 *
 * These tests mount the REAL PageBlockHost and drive the actual postMessage
 * bridge, asserting:
 *   1. the host opens the native modal (UNMODIFIED) with the RIGHT filters
 *      (requested type, canGenerate:true, family hint resolved);
 *   2. on select it posts back ONLY { requestId, versionId, modelId, modelName,
 *      versionName, baseModel, modelType } — the public display names of the
 *      user-picked resource, plus the body-building IDs; NO catalog, NO list,
 *      NO private/early-access/availability internals;
 *   3. on cancel (close without pick) it posts a cancelled result (no `selected`);
 *   4. an UNSUPPORTED requested type (not Checkpoint/LoRA) is rejected — the
 *      modal never opens and no reply is posted;
 *   5. concurrent requestIds don't cross.
 *
 * The native modal is a dynamic import that needs real providers, so — exactly
 * like the OPEN_BUZZ_PURCHASE test — we assert against the shared dialogStore
 * (where openResourceSelectModal triggers) and invoke the captured
 * onSelect/onClose callbacks to simulate the user's pick/dismiss.
 */

// PageBlockHost wires the workflow + storage bridges too; stub trpc so it mounts
// network-free (the resource picker itself makes NO tRPC call — it reuses the
// native modal which talks to Meili in the parent context).
// AppBlockChrome (in the host frame) calls useCurrentUser() for the platform-nav
// moderator gate; these suites render the real host without a CivitaiSessionProvider.
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));

vi.mock('~/utils/trpc', () => ({
  // FeatureFlagsProvider (in PageBlockHost's real render graph) statically imports
  // `setTrpcBatchingEnabled` from this module (#2946). vi.mock replaces the module
  // wholesale, so the factory must re-declare it or the ESM link fails and the whole
  // test file fails to import.
  setTrpcBatchingEnabled: vi.fn(),
  trpc: {
    // W13 wildcard-pack import: PageBlockHost now calls this at render; stub so the mount succeeds (behavior covered in PageBlockHostWildcardPack.browser.test.tsx).
    generation: { resolveWildcardPack: { useMutation: () => ({ mutateAsync: vi.fn() }) } },
    blocks: {
      submitWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      getMyBuzzBalance: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      getMyViewer: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      getMyBuzzTransactions: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      getMyBuzzAccounts: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      getMyDailyCompensation: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      estimateWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      pollWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      cancelWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      queryAppWorkflows: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      cancelAppWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
  
      },
    apps: {
      shared: {
        append: { useMutation: () => ({ mutateAsync: vi.fn() }) },
        update: { useMutation: () => ({ mutateAsync: vi.fn() }) },
        vote: { useMutation: () => ({ mutateAsync: vi.fn() }) },
        unvote: { useMutation: () => ({ mutateAsync: vi.fn() }) },
        withdraw: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      },
      storage: {
        set: { useMutation: () => ({ mutateAsync: vi.fn() }) },
        delete: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      },
    },
    useUtils: () => ({
      apps: {
        shared: {
          list: { fetch: vi.fn() },
          getCount: { fetch: vi.fn() },
          getCounts: { fetch: vi.fn() },
        },
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

describe('PageBlockHost resource picker (Design 1 host-chrome)', () => {
  beforeEach(() => {
    useDialogStore.getState().closeAll();
  });

  test('OPEN_RESOURCE_PICKER (Checkpoint) opens the native modal with the right filters', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();

    postFromBlock('OPEN_RESOURCE_PICKER', {
      requestId: 'rq_ckpt',
      resourceType: 'Checkpoint',
      baseModelGroup: 'Flux1',
    });

    await vi.waitFor(() => {
      expect(useDialogStore.getState().dialogs).toHaveLength(1);
    });
    const props = lastResourceModalProps();
    // Right type + canGenerate floor (native modal reused UNMODIFIED).
    expect(props.options?.resources).toHaveLength(1);
    expect(props.options?.resources?.[0].type).toBe('Checkpoint');
    expect(props.options?.canGenerate).toBe(true);
    // A family hint resolved to a non-empty baseModels list (Flux1 → Flux.1 D…).
    expect((props.options?.resources?.[0].baseModels ?? []).length).toBeGreaterThan(0);
  });

  test('on select posts back ONLY the narrow pick — no catalog / private / early-access leak', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('OPEN_RESOURCE_PICKER', { requestId: 'rq_pick', resourceType: 'Checkpoint' });
    await vi.waitFor(() => expect(useDialogStore.getState().dialogs).toHaveLength(1));

    // Simulate the user picking a resource in the host modal.
    const props = lastResourceModalProps();
    props.onSelect(fakeResource());

    await vi.waitFor(() => {
      const r = replies.last('RESOURCE_PICKER_RESULT');
      if (!r) throw new Error('no reply yet');
      // EXACTLY the six-field allowlist — IDs + the public display names of the
      // user-picked resource — nothing else.
      expect(r.payload).toEqual({
        requestId: 'rq_pick',
        selected: {
          versionId: 9001,
          modelId: 700,
          modelName: 'My Checkpoint',
          versionName: 'v1.0',
          baseModel: 'Flux.1 D',
          modelType: 'Checkpoint',
        },
      });
    });

    // Adversarial leak check: the reply payload must NOT carry any of the
    // sensitive fields present on the source GenerationResource. The two public
    // display names (modelName/versionName) ARE allowed now — everything else
    // (availability/access/early-access/nsfw/poi/minor/cover-image/userId/the
    // full model object) must STILL be dropped; the leak-prevention property
    // holds, only the two name fields were added.
    const payload = replies.last('RESOURCE_PICKER_RESULT')!.payload as {
      selected: Record<string, unknown>;
    };
    const sel = payload.selected;
    const sensitiveAbsent = ['availability', 'hasAccess', 'canGenerate', 'image', 'name',
      'nsfw', 'nsfwLevel', 'poi', 'minor', 'sfwOnly', 'userId', 'trainedWords', 'model'];
    for (const k of sensitiveAbsent) expect(sel).not.toHaveProperty(k);
    expect(Object.keys(sel).sort()).toEqual(
      ['baseModel', 'modelId', 'modelName', 'modelType', 'versionId', 'versionName']
    );
    replies.stop();
  });

  test('on cancel (close without pick) posts a cancelled result (no `selected`)', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('OPEN_RESOURCE_PICKER', { requestId: 'rq_cancel', resourceType: 'LORA' });
    await vi.waitFor(() => expect(useDialogStore.getState().dialogs).toHaveLength(1));

    const props = lastResourceModalProps();
    props.onClose?.(); // user dismissed without selecting

    await vi.waitFor(() => {
      const r = replies.last('RESOURCE_PICKER_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({ requestId: 'rq_cancel' });
    });
    replies.stop();
  });

  test('a pick does NOT also emit a spurious cancel (onClose after onSelect is a no-op)', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('OPEN_RESOURCE_PICKER', { requestId: 'rq_once', resourceType: 'LORA' });
    await vi.waitFor(() => expect(useDialogStore.getState().dialogs).toHaveLength(1));

    const props = lastResourceModalProps();
    props.onSelect(fakeResource({ model: { id: 1, name: 'L', type: 'LORA' } as any }));
    props.onClose?.(); // the modal closes itself after a pick — must not double-fire

    await vi.waitFor(() => {
      const r = replies.last('RESOURCE_PICKER_RESULT');
      if (!r) throw new Error('no reply yet');
      expect((r.payload as { selected?: unknown }).selected).toBeDefined();
    });
    // EXACTLY one result for this requestId (the pick), no trailing cancel.
    const all = replies.received.filter(
      (m) => m.type === 'RESOURCE_PICKER_RESULT' && (m.payload as any)?.requestId === 'rq_once'
    );
    expect(all).toHaveLength(1);
    replies.stop();
  });

  test('an UNSUPPORTED requested type (VAE) is rejected — modal never opens, no reply', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('OPEN_RESOURCE_PICKER', { requestId: 'rq_vae', resourceType: 'VAE' });

    await new Promise((r) => setTimeout(r, 150));
    expect(useDialogStore.getState().dialogs).toHaveLength(0);
    expect(replies.last('RESOURCE_PICKER_RESULT')).toBeUndefined();
    replies.stop();
  });

  test('a request with no requestId is dropped (no modal, no reply)', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('OPEN_RESOURCE_PICKER', { resourceType: 'Checkpoint' });

    await new Promise((r) => setTimeout(r, 150));
    expect(useDialogStore.getState().dialogs).toHaveLength(0);
    expect(replies.last('RESOURCE_PICKER_RESULT')).toBeUndefined();
    replies.stop();
  });

  test('each request resolves with its OWN requestId — picks never cross', async () => {
    // The native resource modal is one-at-a-time (the dialogStore holds a single
    // modal; the real flow is open→pick→close→open). The cross-talk guarantee
    // that matters is that each handler invocation captures its OWN requestId in
    // its closure — so two sequential picks resolve to distinct requestIds, never
    // the wrong one. (The fully-concurrent two-promises-in-flight case is proven
    // on the SDK side, where the transport matches results by requestId.)
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    // Pick A (Checkpoint).
    postFromBlock('OPEN_RESOURCE_PICKER', { requestId: 'rq_a', resourceType: 'Checkpoint' });
    await vi.waitFor(() => expect(useDialogStore.getState().dialogs).toHaveLength(1));
    lastResourceModalProps().onSelect(
      fakeResource({ id: 111, baseModel: 'Flux.1 D', model: { id: 11, name: 'CK', type: 'Checkpoint' } as any })
    );
    await vi.waitFor(() => {
      const r = replies.last('RESOURCE_PICKER_RESULT');
      if (!(r && (r.payload as any)?.requestId === 'rq_a')) throw new Error('A not resolved');
    });
    useDialogStore.getState().closeAll();

    // Pick B (LoRA) — a fresh request with a DIFFERENT requestId.
    postFromBlock('OPEN_RESOURCE_PICKER', { requestId: 'rq_b', resourceType: 'LORA' });
    await vi.waitFor(() => expect(useDialogStore.getState().dialogs).toHaveLength(1));
    lastResourceModalProps().onSelect(
      fakeResource({ id: 222, baseModel: 'SDXL 1.0', model: { id: 22, name: 'LoRA', type: 'LORA' } as any })
    );

    await vi.waitFor(() => {
      expect(replies.received.filter((m) => m.type === 'RESOURCE_PICKER_RESULT')).toHaveLength(2);
    });
    const byId = (id: string) =>
      replies.received.find(
        (m) => m.type === 'RESOURCE_PICKER_RESULT' && (m.payload as any)?.requestId === id
      )?.payload as { selected: { versionId: number; modelType: string } };
    // Each result carries its own requestId + its own pick — no cross-talk.
    expect(byId('rq_a').selected).toMatchObject({ versionId: 111, modelType: 'Checkpoint' });
    expect(byId('rq_b').selected).toMatchObject({ versionId: 222, modelType: 'LORA' });
    replies.stop();
  });
});
