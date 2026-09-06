import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
import { useDialogStore } from '~/components/Dialog/dialogStore';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
// Type-only namespace import for the `importOriginal` spread below (the repo's
// local-rules/no-wholesale-module-mock cure).
import type * as TrpcMod from '~/utils/trpc';

/**
 * SET_COLLECTION_FOLLOW → COLLECTION_FOLLOW_RESULT on the MODEL-SLOT host.
 *
 * 🔴 THIS SUITE IS HALF THE COVERAGE. `PageBlockHost` is a SEPARATE surface with
 * its own postMessage bridge; the two hosts share only the pure decision module
 * (`collectionFollowGate.ts`), so wiring one and not the other is invisible to
 * either suite alone. The structural half of that is
 * `hostHandlerParity.test.ts`, which requires BOTH hosts to register a handler;
 * this file is the behavioural half for the model slot, mirrored by
 * `PageBlockHostCollectionFollow.browser.test.tsx`.
 *
 * The property under test is the CONSENT boundary: this bridge exists so a block
 * no longer needs the `collections:write:self` scope (whose grant used to BE the
 * viewer's consent), so nothing may be written until the viewer clicks through
 * host chrome the sandboxed iframe cannot fake.
 */

const { followMutate, unfollowMutate, currentUser } = vi.hoisted(() => ({
  followMutate: vi.fn(),
  unfollowMutate: vi.fn(),
  // Mutable so one file can cover BOTH the signed-in and the anonymous viewer —
  // the anonymous refusal is a security property, not an edge case, so it must
  // be exercised against the real host rather than only in the gate's unit test.
  currentUser: { value: null as { id: number } | null },
}));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => currentUser.value }));

// This factory REPLACES the module, so it must name every export this file's
// module graph imports — including `useOptionalFeatureFlags`, which the app-block
// chrome reads. Omitting one makes the FILE fail to import, which reports as
// `Tests no tests` rather than as a failure.
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ appBlocks: false, appBlocksPages: false }),
  useOptionalFeatureFlags: () => ({ appBlocks: false, appBlocksPages: false }),
}));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  trpc: {
    collection: {
      follow: { useMutation: () => ({ mutateAsync: followMutate }) },
      unfollow: { useMutation: () => ({ mutateAsync: unfollowMutate }) },
    },
    blocks: {
      getEffectiveCheckpoint: {
        useQuery: () => ({ data: { checkpoint: null }, isLoading: false }),
      },
      getShowcaseImages: { useQuery: () => ({ data: [], isLoading: false }) },
      submitWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      estimateWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      pollWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      cancelWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      updateUserSettings: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      getMyBuzzBalance: { useMutation: () => ({ mutateAsync: vi.fn() }) },
    },
    apps: {
      shared: {
        append: { useMutation: () => ({ mutateAsync: vi.fn() }) },
        update: { useMutation: () => ({ mutateAsync: vi.fn() }) },
        vote: { useMutation: () => ({ mutateAsync: vi.fn() }) },
        unvote: { useMutation: () => ({ mutateAsync: vi.fn() }) },
        withdraw: { useMutation: () => ({ mutateAsync: vi.fn() }) },
        report: { useMutation: () => ({ mutateAsync: vi.fn() }) },
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
          get: { fetch: vi.fn() },
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

vi.mock('~/components/BrowsingLevel/BrowsingLevelProvider', () => ({
  useBrowsingLevelDebounced: () => 1,
}));

// eslint-disable-next-line import/first
import { IframeHost } from '~/components/AppBlocks/IframeHost';
// eslint-disable-next-line import/first
import type { BlockInstall, ModelSlotContext } from '~/components/AppBlocks/types';

const SAME_ORIGIN_SRC = `${window.location.origin}/`;

function iframeEl() {
  return page.getByTestId('block-iframe').element() as HTMLIFrameElement;
}

function postFromBlock(type: string, payload?: unknown) {
  const cw = iframeEl().contentWindow;
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
  const cw = iframeEl().contentWindow;
  if (!cw) throw new Error('iframe contentWindow missing');
  const handler = (e: MessageEvent) => {
    const d = e.data as { type?: string; payload?: unknown } | null;
    if (d && typeof d.type === 'string') received.push({ type: d.type, payload: d.payload });
  };
  cw.addEventListener('message', handler);
  return {
    of: (type: string) => received.filter((m) => m.type === type),
    last: (type: string) => [...received].reverse().find((m) => m.type === type),
    stop: () => cw.removeEventListener('message', handler),
  };
}

function lastDialog() {
  const dialogs = useDialogStore.getState().dialogs;
  if (dialogs.length === 0) throw new Error('no modal opened');
  return dialogs[dialogs.length - 1];
}

const install: BlockInstall = {
  blockInstanceId: 'inst_test',
  blockId: 'my-model-app',
  appId: 'app_test',
  appBlockId: 'apb_test',
  manifest: {
    name: 'Playable Collections',
    scopes: [],
    iframe: {
      src: SAME_ORIGIN_SRC,
      minHeight: 200,
      maxHeight: 800,
      resizable: true,
      sandbox: 'allow-scripts',
    },
  },
  publisherSettings: {},
  enabled: true,
  renderMode: 'iframe',
  trustTier: 'internal',
};

const context: ModelSlotContext = {
  slotId: 'model.sidebar_top',
  entityType: 'model',
  modelId: 123,
  modelVersionId: 456,
  modelName: 'Some Model',
  modelType: 'Checkpoint',
  modelNsfwLevel: 1,
  creatorUserId: 7,
  viewerUserId: 42,
  viewerNsfwEnabled: false,
  viewerUsername: 'tester',
  theme: 'light',
};

const baseProps = {
  install,
  context,
  token: 'tok_abc',
  expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
};

async function mountAndReady() {
  renderWithProviders(<IframeHost {...baseProps} />);
  await vi.waitFor(() => {
    if (!iframeEl().contentWindow) throw new Error('not mounted yet');
  });
  const replies = listenForReply();
  // POSITIVE CONTROL: the listener is proven to observe real host pushes before
  // any assertion rests on it — a `toBeUndefined()` on a channel wired to
  // nothing is indistinguishable from a genuine absence.
  await vi.waitFor(() => {
    if (replies.of('BLOCK_INIT').length === 0) throw new Error('listener saw no BLOCK_INIT');
  });
  await vi.waitFor(() => {
    postFromBlock('BLOCK_READY', {});
    if (iframeEl().getAttribute('data-block-ready') !== 'true') throw new Error('not ready yet');
  });
  return replies;
}

type ConfirmProps = {
  title: string;
  message: string;
  labels: { confirm: string; cancel: string };
  onConfirm: () => Promise<void> | void;
  onCancel: () => void;
};

describe('IframeHost SET_COLLECTION_FOLLOW (consent-gated follow, model slot)', () => {
  beforeEach(() => {
    useDialogStore.getState().closeAll();
    followMutate.mockReset();
    unfollowMutate.mockReset();
    currentUser.value = { id: 42 };
  });

  test('opens a host-chrome consent confirm BEFORE any write; on CONFIRM calls collection.follow', async () => {
    followMutate.mockResolvedValue(undefined);
    const replies = await mountAndReady();

    postFromBlock('SET_COLLECTION_FOLLOW', {
      requestId: 'rq_follow',
      collectionId: 77,
      follow: true,
    });

    await vi.waitFor(() => expect(useDialogStore.getState().dialogs).toHaveLength(1));
    expect(followMutate).not.toHaveBeenCalled();
    const props = lastDialog().props as ConfirmProps;
    expect(props.title).toBe('Follow this collection?');
    // The model host names the app from its INSTALL manifest (the page host uses
    // its `appName` prop) — assert it actually reaches the dialog.
    expect(props.message).toContain('Playable Collections');
    expect(props.labels.confirm).toBe('Follow');

    await props.onConfirm();

    expect(followMutate).toHaveBeenCalledWith({ collectionId: 77 });
    await vi.waitFor(() => {
      const r = replies.last('COLLECTION_FOLLOW_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({
        requestId: 'rq_follow',
        result: { collectionId: 77, followed: true },
      });
    });
    replies.stop();
  });

  test('follow:false routes to collection.unfollow and replies followed:false', async () => {
    unfollowMutate.mockResolvedValue(undefined);
    const replies = await mountAndReady();

    postFromBlock('SET_COLLECTION_FOLLOW', {
      requestId: 'rq_unfollow',
      collectionId: 78,
      follow: false,
    });

    await vi.waitFor(() => expect(useDialogStore.getState().dialogs).toHaveLength(1));
    const props = lastDialog().props as ConfirmProps;
    expect(props.title).toBe('Unfollow this collection?');
    expect(props.labels.confirm).toBe('Unfollow');
    await props.onConfirm();

    expect(unfollowMutate).toHaveBeenCalledWith({ collectionId: 78 });
    expect(followMutate).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      const r = replies.last('COLLECTION_FOLLOW_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({
        requestId: 'rq_unfollow',
        result: { collectionId: 78, followed: false },
      });
    });
    replies.stop();
  });

  test('🔴 on DISMISS (consent declined) replies `declined` and NEVER writes', async () => {
    const replies = await mountAndReady();

    postFromBlock('SET_COLLECTION_FOLLOW', { requestId: 'rq_no', collectionId: 5, follow: true });
    await vi.waitFor(() => expect(useDialogStore.getState().dialogs).toHaveLength(1));

    (lastDialog().props as ConfirmProps).onCancel();

    await vi.waitFor(() => {
      const r = replies.last('COLLECTION_FOLLOW_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({ requestId: 'rq_no', error: 'declined' });
    });
    expect(followMutate).not.toHaveBeenCalled();
    expect(unfollowMutate).not.toHaveBeenCalled();
    replies.stop();
  });

  test('🔴 an ANONYMOUS viewer is refused with sign-in-required — no dialog, no write', async () => {
    currentUser.value = null;
    const replies = await mountAndReady();

    postFromBlock('SET_COLLECTION_FOLLOW', { requestId: 'rq_anon', collectionId: 5, follow: true });

    await vi.waitFor(() => {
      const r = replies.last('COLLECTION_FOLLOW_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({ requestId: 'rq_anon', error: 'sign-in-required' });
    });
    expect(useDialogStore.getState().dialogs).toHaveLength(0);
    expect(followMutate).not.toHaveBeenCalled();
    replies.stop();
  });

  test('a malformed collectionId is REFUSED with a reply (never a silent hang)', async () => {
    const replies = await mountAndReady();

    postFromBlock('SET_COLLECTION_FOLLOW', { requestId: 'rq_bad', collectionId: 0, follow: true });

    await vi.waitFor(() => {
      const r = replies.last('COLLECTION_FOLLOW_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({ requestId: 'rq_bad', error: 'invalid-request' });
    });
    expect(useDialogStore.getState().dialogs).toHaveLength(0);
    replies.stop();
  });

  test('a payload with no requestId is dropped (no dialog, no reply)', async () => {
    const replies = await mountAndReady();

    postFromBlock('SET_COLLECTION_FOLLOW', { collectionId: 5, follow: true });

    await new Promise((r) => setTimeout(r, 150));
    expect(useDialogStore.getState().dialogs).toHaveLength(0);
    expect(replies.last('COLLECTION_FOLLOW_RESULT')).toBeUndefined();
    expect(followMutate).not.toHaveBeenCalled();
    replies.stop();
  });

  test('a server FORBIDDEN comes back as an error reply, exactly once', async () => {
    followMutate.mockRejectedValue(new Error('You do not have permission to follow'));
    const replies = await mountAndReady();

    postFromBlock('SET_COLLECTION_FOLLOW', { requestId: 'rq_403', collectionId: 9, follow: true });
    await vi.waitFor(() => expect(useDialogStore.getState().dialogs).toHaveLength(1));
    await (lastDialog().props as ConfirmProps).onConfirm();

    await vi.waitFor(() => {
      const r = replies.last('COLLECTION_FOLLOW_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({
        requestId: 'rq_403',
        error: 'You do not have permission to follow',
      });
    });
    expect(replies.of('COLLECTION_FOLLOW_RESULT')).toHaveLength(1);
    replies.stop();
  });
});
