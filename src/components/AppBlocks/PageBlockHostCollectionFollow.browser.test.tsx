import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { DialogProvider } from '~/components/Dialog/DialogProvider';
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
 * 🔴 THE BRIDGE REMOVES A SCOPE DECLARATION, AND ADDS THE ONLY CONSENT THIS
 * OPERATION HAS EVER HAD. ⚠️ An earlier version of this header said the viewer's
 * grant of `collections:write:self` "WAS the consent" — RETRACTED, and false:
 * that scope is in `CONSENT_EXEMPT_SCOPES`
 * (`src/server/services/blocks/scope-grant.service.ts`), so it minted with no
 * prompt and no grant row was ever recorded. What the bridge gives up is ex-ante
 * REVIEWABILITY (the manifest `scopes` string a moderator reviews and the viewer
 * inspects post-install); what it adds is a HOST-CHROME CONFIRM the sandboxed
 * iframe cannot fake. Every test below that reaches a mutation goes through that
 * confirm first, and the "never calls the mutation" tests are the ones that would
 * catch it being dropped.
 *
 * 🔴 The confirm must also NAME the collection, resolved by the HOST from the id
 * it is about to act on — a dialog that says only "a collection" asserts nothing
 * a block's own "Follow ⭐ Cute Cats" card could contradict.
 *
 * Mirrored on the model-slot surface by `IframeHostCollectionFollow.browser.test.tsx`
 * — the two hosts share the DECISION module but have entirely separate bridges,
 * so neither suite can see the other's wiring.
 */

const { followMutate, unfollowMutate, getByIdFetch } = vi.hoisted(() => ({
  followMutate: vi.fn(),
  unfollowMutate: vi.fn(),
  // The HOST-SIDE collection lookup that makes the consent dialog name its
  // object. Mocked per-test so a suite can exercise the found / not-visible /
  // lookup-failed arms independently of any block-supplied string.
  getByIdFetch: vi.fn(),
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
      collection: { getById: { fetch: getByIdFetch } },
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

/**
 * What `collection.getById` returns for a collection this viewer CAN see. The
 * host resolves the consent dialog's subject from this — never from anything the
 * block sent.
 */
const VISIBLE_COLLECTION = {
  collection: { id: 77, name: 'Cute Cats', user: { id: 3, username: 'alice' } },
  permissions: { read: true, write: false, manage: false },
  collaborators: [],
  pendingReviewCount: 0,
};

/**
 * What it returns for a collection that does NOT exist, and — identically — for
 * one this viewer may not see. `getCollectionByIdHandler` produces this same
 * shape for both, which is the existence-leak guarantee the host inherits.
 */
const UNAVAILABLE_COLLECTION = {
  collection: null,
  permissions: { read: false, write: false, manage: false },
  collaborators: [],
  pendingReviewCount: 0,
};

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

/**
 * Mount and wait for the iframe, but DELIBERATELY never send `BLOCK_READY` — the
 * pre-handshake state a block reaches on load, before the viewer has interacted
 * with it at all.
 */
async function mountWithoutHandshake() {
  renderWithProviders(<PageBlockHost {...baseProps} />);
  await vi.waitFor(() => {
    const el = page.getByTestId('app-page-iframe').element() as HTMLIFrameElement;
    if (!el.contentWindow) throw new Error('not mounted yet');
  });
  const el = page.getByTestId('app-page-iframe').element() as HTMLIFrameElement;
  expect(el.getAttribute('data-block-ready')).not.toBe('true');
}

describe('PageBlockHost SET_COLLECTION_FOLLOW (consent-gated follow)', () => {
  beforeEach(() => {
    useDialogStore.getState().closeAll();
    followMutate.mockReset();
    unfollowMutate.mockReset();
    getByIdFetch.mockReset();
    getByIdFetch.mockResolvedValue(VISIBLE_COLLECTION);
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

/**
 * 🔴 F1 REGRESSION (page host). The dialog previously named NO collection: a
 * block could render "Follow ⭐ Cute Cats", post a different id, and host chrome
 * would assert nothing that could contradict it.
 */
describe('PageBlockHost SET_COLLECTION_FOLLOW — the confirm names the HOST-RESOLVED collection', () => {
  beforeEach(() => {
    useDialogStore.getState().closeAll();
    followMutate.mockReset();
    unfollowMutate.mockReset();
    getByIdFetch.mockReset();
    getByIdFetch.mockResolvedValue(VISIBLE_COLLECTION);
  });

  test('🔴 fetches the collection by the SAME id it will act on and names it in the dialog', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('SET_COLLECTION_FOLLOW', {
      requestId: 'rq_named',
      collectionId: 900123,
      follow: true,
      // A block-supplied name must NOT reach the dialog — the host has no field
      // for it and must never grow one.
      collectionName: 'Totally Safe Kittens',
    });

    await vi.waitFor(() => expect(useDialogStore.getState().dialogs).toHaveLength(1));
    expect(getByIdFetch).toHaveBeenCalledWith({ id: 900123 }, { staleTime: 0 });
    const msg = (lastDialog().props as ConfirmProps).message;
    // The WHOLE sentence, so a cosmetic reword that drops the object fails here.
    expect(msg).toBe(
      'Playable Collections wants to follow “Cute Cats” by alice with your Civitai account. It will appear in your collections until you unfollow it.'
    );
    expect(msg).not.toContain('Totally Safe Kittens');
    replies.stop();
  });

  test('🔴 a collection the viewer cannot see is REFUSED with a reply and NO dialog', async () => {
    getByIdFetch.mockResolvedValue(UNAVAILABLE_COLLECTION);
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('SET_COLLECTION_FOLLOW', {
      requestId: 'rq_priv',
      collectionId: 4242,
      follow: true,
    });

    await vi.waitFor(() => {
      const r = replies.last('COLLECTION_FOLLOW_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({ requestId: 'rq_priv', error: 'collection-unavailable' });
    });
    expect(useDialogStore.getState().dialogs).toHaveLength(0);
    expect(followMutate).not.toHaveBeenCalled();
    replies.stop();
  });

  test('a FAILED lookup refuses with the same code — never a hang, never a nameless dialog', async () => {
    getByIdFetch.mockRejectedValue(new Error('NOT_FOUND'));
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('SET_COLLECTION_FOLLOW', {
      requestId: 'rq_boom',
      collectionId: 4243,
      follow: true,
    });

    await vi.waitFor(() => {
      const r = replies.last('COLLECTION_FOLLOW_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({ requestId: 'rq_boom', error: 'collection-unavailable' });
    });
    expect(useDialogStore.getState().dialogs).toHaveLength(0);
    replies.stop();
  });
});

/**
 * 🔴 F2 REGRESSION (page host). A pre-handshake block could pop a permission
 * modal with zero user interaction. This is the only ungated REQUEST-style
 * handler that performs an account WRITE.
 */
describe('PageBlockHost SET_COLLECTION_FOLLOW — pre-handshake gate', () => {
  beforeEach(() => {
    useDialogStore.getState().closeAll();
    followMutate.mockReset();
    unfollowMutate.mockReset();
    getByIdFetch.mockReset();
    getByIdFetch.mockResolvedValue(VISIBLE_COLLECTION);
  });

  test('🔴 a block that never sent BLOCK_READY gets `not-ready` and NO dialog', async () => {
    await mountWithoutHandshake();
    const replies = listenForReply();

    postFromBlock('SET_COLLECTION_FOLLOW', { requestId: 'rq_pre', collectionId: 77, follow: true });

    await vi.waitFor(() => {
      const r = replies.last('COLLECTION_FOLLOW_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({ requestId: 'rq_pre', error: 'not-ready' });
    });
    expect(useDialogStore.getState().dialogs).toHaveLength(0);
    expect(getByIdFetch).not.toHaveBeenCalled();
    expect(followMutate).not.toHaveBeenCalled();
    replies.stop();
  });
});

/**
 * 🔴 F3 REGRESSION — driven through the REAL rendered Modal, not through
 * `props.onCancel()`.
 *
 * `ConfirmDialog.handleConfirm` awaits `onConfirm()` BEFORE closing its Modal and
 * leaves escape/overlay dismissal live during that await, so the dismissal used
 * to win the exactly-once latch with `declined` for a follow that completed. The
 * invariant these pin is `declined` ⇒ NO WRITE OCCURRED.
 *
 * `<DialogProvider />` is rendered alongside the host so the dialogStore entry
 * becomes an actual Mantine Modal with real buttons and a real escape handler —
 * the other suites read `props` off the store, which is exactly the "reasoned,
 * not executed" gap this closes.
 */
describe('PageBlockHost SET_COLLECTION_FOLLOW — dismissal vs. an in-flight write (real Modal)', () => {
  beforeEach(() => {
    useDialogStore.getState().closeAll();
    followMutate.mockReset();
    unfollowMutate.mockReset();
    getByIdFetch.mockReset();
    getByIdFetch.mockResolvedValue(VISIBLE_COLLECTION);
  });

  test('🔴 ESC while the mutation is in flight does NOT report `declined` for a write that happens', async () => {
    let release: () => void = () => undefined;
    followMutate.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = () => resolve();
        })
    );
    renderWithProviders(
      <>
        <PageBlockHost {...baseProps} />
        <DialogProvider />
      </>
    );
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('SET_COLLECTION_FOLLOW', {
      requestId: 'rq_race',
      collectionId: 77,
      follow: true,
    });

    // Real chrome: a real button in a real Modal, clicked.
    const confirmBtn = page.getByRole('button', { name: 'Follow' });
    await vi.waitFor(async () => {
      await expect.element(confirmBtn).toBeInTheDocument();
    });
    await confirmBtn.click();
    await vi.waitFor(() => expect(followMutate).toHaveBeenCalledTimes(1));

    // Real dismissal, mid-flight, through Mantine's own escape handling.
    await userEvent.keyboard('{Escape}');
    release();

    await vi.waitFor(() => {
      const r = replies.last('COLLECTION_FOLLOW_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({
        requestId: 'rq_race',
        result: { collectionId: 77, followed: true },
      });
    });
    // Exactly one reply, and it is NOT `declined`.
    expect(replies.of('COLLECTION_FOLLOW_RESULT')).toHaveLength(1);
    replies.stop();
  });

  test('positive control: ESC BEFORE confirming still declines, through the same real Modal', async () => {
    // Without this the test above could pass because escape never reached the
    // Modal at all — a dismissal path wired to nothing looks identical to a
    // dismissal correctly ignored.
    renderWithProviders(
      <>
        <PageBlockHost {...baseProps} />
        <DialogProvider />
      </>
    );
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('SET_COLLECTION_FOLLOW', { requestId: 'rq_esc', collectionId: 77, follow: true });
    const confirmBtn = page.getByRole('button', { name: 'Follow' });
    await vi.waitFor(async () => {
      await expect.element(confirmBtn).toBeInTheDocument();
    });

    await userEvent.keyboard('{Escape}');

    await vi.waitFor(() => {
      const r = replies.last('COLLECTION_FOLLOW_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({ requestId: 'rq_esc', error: 'declined' });
    });
    expect(followMutate).not.toHaveBeenCalled();
    replies.stop();
  });
});
