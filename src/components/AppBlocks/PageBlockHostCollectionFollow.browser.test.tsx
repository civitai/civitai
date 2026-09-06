import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
import { useDialogStore } from '~/components/Dialog/dialogStore';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
// Type-only namespace import for the `importOriginal` spread below (the repo's
// local-rules/no-wholesale-module-mock cure). NOT `typeof import(...)`, which
// @typescript-eslint/consistent-type-imports rejects.
import type * as TrpcMod from '~/utils/trpc';

/**
 * SET_COLLECTION_FOLLOW → COLLECTION_FOLLOW_RESULT on the PAGE host.
 *
 * The structural parity guard (`hostHandlerParity.test.ts`) only proves a handler
 * is REGISTERED. These are the behavioural pins for what it does, and in
 * particular for the property that made this bridge worth reviewing:
 *
 * 🔴 THE BRIDGE REMOVES A SCOPE GATE. Over HTTP a follow needed the block scope
 * `collections:write:self`, and the viewer's grant of that scope WAS the consent.
 * On the bridge the host acts as the signed-in session user, so the replacement
 * consent is a HOST-CHROME CONFIRM the sandboxed iframe cannot fake. Every test
 * below that reaches a mutation goes through that confirm first, and the two
 * "never calls the mutation" tests are the ones that would catch it being
 * dropped.
 *
 * Mirrored on the model-slot surface by `IframeHostCollectionFollow.browser.test.tsx`
 * — the two hosts share the DECISION module but have entirely separate bridges,
 * so neither suite can see the other's wiring.
 */

const { followMutate, unfollowMutate } = vi.hoisted(() => ({
  followMutate: vi.fn(),
  unfollowMutate: vi.fn(),
}));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  setTrpcBatchingEnabled: vi.fn(),
  trpc: {
    collection: {
      follow: { useMutation: () => ({ mutateAsync: followMutate }) },
      unfollow: { useMutation: () => ({ mutateAsync: unfollowMutate }) },
    },
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
      publishGenerationOutputs: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      getImagesByIds: { useMutation: () => ({ mutateAsync: vi.fn() }) },
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

const SAME_ORIGIN_SRC = `${window.location.origin}/`;
const baseProps = {
  appBlockId: 'apb_test',
  blockId: 'collections-app',
  appId: 'app_test',
  blockInstanceId: 'page_apb_test',
  appName: 'Playable Collections',
  iframeSrc: SAME_ORIGIN_SRC,
  surface: 'page-run' as const,
  bootSkeleton: false,
  sandbox: 'allow-scripts',
  trustTier: 'internal' as const,
  slug: 'collections-app',
  token: 'tok_abc',
  expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  declaredScopes: [] as string[],
  missingScopes: [] as string[],
  needsConsent: false,
  tokenError: false,
  viewer: { id: 42, username: 'tester' } as { id: number; username: string | null } | null,
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

type ConfirmProps = {
  title: string;
  message: string;
  labels: { confirm: string; cancel: string };
  onConfirm: () => Promise<void> | void;
  onCancel: () => void;
};

describe('PageBlockHost SET_COLLECTION_FOLLOW (consent-gated follow)', () => {
  beforeEach(() => {
    useDialogStore.getState().closeAll();
    followMutate.mockReset();
    unfollowMutate.mockReset();
  });

  test('opens a host-chrome consent confirm BEFORE any write; on CONFIRM calls collection.follow and replies followed:true', async () => {
    followMutate.mockResolvedValue(undefined);
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('SET_COLLECTION_FOLLOW', {
      requestId: 'rq_follow',
      collectionId: 77,
      follow: true,
    });

    // 🔴 THE CONSENT PROPERTY: a dialog, and NO write, before the viewer clicks.
    await vi.waitFor(() => expect(useDialogStore.getState().dialogs).toHaveLength(1));
    expect(followMutate).not.toHaveBeenCalled();
    const props = lastDialog().props as ConfirmProps;
    expect(props.title).toBe('Follow this collection?');
    // The dialog names WHO is asking — a viewer cannot consent to an unnamed party.
    expect(props.message).toContain('Playable Collections');
    expect(props.labels.confirm).toBe('Follow');

    await props.onConfirm();

    // Self-bound: `collectionId` is the ONLY thing that crosses; no user id.
    expect(followMutate).toHaveBeenCalledWith({ collectionId: 77 });
    expect(unfollowMutate).not.toHaveBeenCalled();
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
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

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
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

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
    renderWithProviders(<PageBlockHost {...baseProps} viewer={null} />);
    await driveToReady();
    const replies = listenForReply();

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

  test('🔴 the mod-review sandbox NACKs before any dialog — a pending app cannot drive the reviewing mod', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} reviewMode onConsentGranted={vi.fn()} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('SET_COLLECTION_FOLLOW', {
      requestId: 'rq_review',
      collectionId: 5,
      follow: true,
    });

    await vi.waitFor(() => {
      const r = replies.last('COLLECTION_FOLLOW_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({ requestId: 'rq_review', error: 'review-mode' });
    });
    expect(useDialogStore.getState().dialogs).toHaveLength(0);
    expect(followMutate).not.toHaveBeenCalled();
    replies.stop();
  });

  test('a malformed collectionId is REFUSED with a reply (never a silent hang)', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('SET_COLLECTION_FOLLOW', { requestId: 'rq_bad', collectionId: -1, follow: true });

    await vi.waitFor(() => {
      const r = replies.last('COLLECTION_FOLLOW_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({ requestId: 'rq_bad', error: 'invalid-request' });
    });
    expect(useDialogStore.getState().dialogs).toHaveLength(0);
    replies.stop();
  });

  test('a payload with no requestId is dropped (no dialog, no reply) — nothing to correlate', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('SET_COLLECTION_FOLLOW', { collectionId: 5, follow: true });

    await new Promise((r) => setTimeout(r, 150));
    expect(useDialogStore.getState().dialogs).toHaveLength(0);
    expect(replies.last('COLLECTION_FOLLOW_RESULT')).toBeUndefined();
    expect(followMutate).not.toHaveBeenCalled();
    replies.stop();
  });

  test('a server FORBIDDEN (private collection) comes back as an error reply, exactly once', async () => {
    followMutate.mockRejectedValue(new Error('You do not have permission to follow'));
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

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
