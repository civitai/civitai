import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
// Explicit mid-test unmount, for the "the budget is per block INSTANCE" pin. The
// harness's own `afterEach` uses the same helper.
import { cleanup } from 'vitest-browser-react';
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
 * The property under test is the CONSENT boundary. ⚠️ An earlier version of this
 * header said the dropped `collections:write:self` scope's grant "used to BE the
 * viewer's consent" — RETRACTED, and false: that scope is in
 * `CONSENT_EXEMPT_SCOPES` (`src/server/services/blocks/scope-grant.service.ts`),
 * so it always minted WITHOUT a prompt and no grant row exists. The HTTP path had
 * zero prompts; this confirm is the only consent this operation has ever had, so
 * these tests are pinning a TIGHTENING, not policing a loosening. Nothing may be
 * written until the viewer clicks through host chrome the sandboxed iframe cannot
 * fake — and that chrome must NAME the collection the host itself resolved, or it
 * asserts nothing the block's own UI could contradict.
 */

const { followMutate, unfollowMutate, getByIdFetch, currentUser } = vi.hoisted(() => ({
  followMutate: vi.fn(),
  unfollowMutate: vi.fn(),
  // The HOST-SIDE collection lookup that makes the consent dialog name its
  // object. Mocked per-test so a suite can exercise the found / not-visible /
  // lookup-failed arms independently of any block-supplied string.
  getByIdFetch: vi.fn(),
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

/**
 * Mount and take a listener, but DELIBERATELY never send `BLOCK_READY` — the
 * pre-handshake state a block reaches on load, before the viewer has interacted
 * with it at all.
 */
async function mountWithoutHandshake() {
  renderWithProviders(<IframeHost {...baseProps} />);
  await vi.waitFor(() => {
    if (!iframeEl().contentWindow) throw new Error('not mounted yet');
  });
  const replies = listenForReply();
  // Same positive control as `mountAndReady`: prove the channel is live before
  // any assertion rests on what it does or does not carry.
  await vi.waitFor(() => {
    if (replies.of('BLOCK_INIT').length === 0) throw new Error('listener saw no BLOCK_INIT');
  });
  expect(iframeEl().getAttribute('data-block-ready')).not.toBe('true');
  return replies;
}

describe('IframeHost SET_COLLECTION_FOLLOW (consent-gated follow, model slot)', () => {
  beforeEach(() => {
    useDialogStore.getState().closeAll();
    followMutate.mockReset();
    unfollowMutate.mockReset();
    getByIdFetch.mockReset();
    getByIdFetch.mockResolvedValue(VISIBLE_COLLECTION);
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

/**
 * 🔴 F1 REGRESSION (model slot). The dialog previously named NO collection: a
 * block could render "Follow ⭐ Cute Cats", post a different id, and host chrome
 * would assert nothing that could contradict it.
 */
describe('IframeHost SET_COLLECTION_FOLLOW — the confirm names the HOST-RESOLVED collection', () => {
  beforeEach(() => {
    useDialogStore.getState().closeAll();
    followMutate.mockReset();
    unfollowMutate.mockReset();
    getByIdFetch.mockReset();
    getByIdFetch.mockResolvedValue(VISIBLE_COLLECTION);
    currentUser.value = { id: 42 };
  });

  test('🔴 fetches the collection by the SAME id it will act on and names it in the dialog', async () => {
    const replies = await mountAndReady();
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
    expect(msg).toContain('“Cute Cats” by alice');
    expect(msg).not.toContain('Totally Safe Kittens');
    replies.stop();
  });

  test('🔴 a collection the viewer cannot see is REFUSED with a reply and NO dialog', async () => {
    getByIdFetch.mockResolvedValue(UNAVAILABLE_COLLECTION);
    const replies = await mountAndReady();
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
    const replies = await mountAndReady();
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
 * 🔴 F2 REGRESSION (model slot). A pre-handshake block could pop a permission
 * modal with zero user interaction. This is the only ungated REQUEST-style
 * handler that performs an account WRITE.
 */
describe('IframeHost SET_COLLECTION_FOLLOW — pre-handshake gate', () => {
  beforeEach(() => {
    useDialogStore.getState().closeAll();
    followMutate.mockReset();
    unfollowMutate.mockReset();
    getByIdFetch.mockReset();
    getByIdFetch.mockResolvedValue(VISIBLE_COLLECTION);
    currentUser.value = { id: 42 };
  });

  test('🔴 a block that never sent BLOCK_READY gets `not-ready` and NO dialog', async () => {
    const replies = await mountWithoutHandshake();
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
 * 🔴 F4 REGRESSION (model slot) — THE BOUND ON THE VISIBILITY ORACLE.
 *
 * F1 moved the `collection.getById` lookup BEFORE the dialog so the confirm can
 * name its object. That is right, and it handed the block a capability: it now
 * learns `collection-unavailable` vs. dialog-shown with no click at all, i.e. per
 * id, "can this viewer see it?" — an AUTHENTICATED read a sandboxed cross-origin
 * block cannot perform itself, driven at the transport's 30 messages/second.
 *
 * The bound is a per-block-instance cap on DISTINCT collection ids, held in a ref
 * by EACH host separately. The page host's copy is invisible to this suite and
 * vice versa, so both are pinned.
 */

const OVER_BUDGET_FIRST_ID = 500_001;

function replyFor(replies: ReturnType<typeof listenForReply>, requestId: string) {
  return replies
    .of('COLLECTION_FOLLOW_RESULT')
    .map((m) => m.payload as Record<string, unknown>)
    .find((p) => p?.requestId === requestId);
}

async function awaitReply(replies: ReturnType<typeof listenForReply>, requestId: string) {
  let found: Record<string, unknown> | undefined;
  await vi.waitFor(() => {
    found = replyFor(replies, requestId);
    if (!found) throw new Error(`no reply for ${requestId} yet`);
  });
  return found as Record<string, unknown>;
}

/**
 * The transport drops inbound messages past 30 per rolling second
 * (`RATE_LIMIT_MAX_MESSAGES`, usePostMessage.ts) and a dropped message never
 * replies — which would look exactly like the budget refusing. These suites post
 * 20+ messages, so they pace themselves well under that ceiling. Without this the
 * tests below would be measuring the transport, not the budget.
 */
let paceMarks: number[] = [];
async function pacedPost(type: string, payload: unknown) {
  const now = Date.now();
  paceMarks = paceMarks.filter((t) => now - t < 1200);
  if (paceMarks.length >= 18) {
    await new Promise((r) => setTimeout(r, Math.max(0, 1200 - (now - paceMarks[0]))));
    paceMarks = [];
  }
  postFromBlock(type, payload);
  paceMarks.push(Date.now());
}

async function mountReadyAndSettled() {
  const replies = await mountAndReady();
  // The handshake's own posts count against the same 30/s inbound budget. Drain
  // the window before the burst.
  await new Promise((r) => setTimeout(r, 1200));
  paceMarks = [];
  return replies;
}

/** Spend the whole budget on 20 DISTINCT ids the viewer cannot see. */
async function spendBudgetOnUnseeableIds(replies: ReturnType<typeof listenForReply>) {
  for (let i = 1; i <= 20; i++) {
    const requestId = `rq_budget_${i}`;
    await pacedPost('SET_COLLECTION_FOLLOW', {
      requestId,
      collectionId: OVER_BUDGET_FIRST_ID + i - 1,
      follow: true,
    });
    await awaitReply(replies, requestId);
  }
}

describe('IframeHost SET_COLLECTION_FOLLOW — per-instance distinct-id lookup budget', () => {
  beforeEach(() => {
    useDialogStore.getState().closeAll();
    followMutate.mockReset();
    unfollowMutate.mockReset();
    getByIdFetch.mockReset();
    getByIdFetch.mockResolvedValue(UNAVAILABLE_COLLECTION);
    currentUser.value = { id: 42 };
    paceMarks = [];
  });

  test('🔴 past the cap the host STOPS LOOKING UP — the 21st distinct id costs no authed read', async () => {
    const replies = await mountReadyAndSettled();

    await spendBudgetOnUnseeableIds(replies);
    // Positive control: those 20 were genuinely resolved, so the unchanged count
    // below is a measurement and not a handler that was never wired.
    expect(getByIdFetch).toHaveBeenCalledTimes(20);

    await pacedPost('SET_COLLECTION_FOLLOW', {
      requestId: 'rq_budget_21',
      collectionId: OVER_BUDGET_FIRST_ID + 20,
      follow: true,
    });
    const over = await awaitReply(replies, 'rq_budget_21');

    // 🔴 THE BOUND: the reply came back, and NO lookup was spent producing it.
    expect(getByIdFetch).toHaveBeenCalledTimes(20);
    expect(over).toEqual({ requestId: 'rq_budget_21', error: 'collection-unavailable' });
    expect(useDialogStore.getState().dialogs).toHaveLength(0);
    expect(followMutate).not.toHaveBeenCalled();
    replies.stop();
  }, 30_000);

  // ⚠️ SHAPE GUARD, NOT A REGRESSION TEST — labelled rather than counted. It is
  // GREEN at `25efb688b2` (measured), and necessarily so: with no budget there is
  // no second refusal path to be distinguishable from. What it guards is the
  // FUTURE — a maintainer adding a `lookup-budget-exhausted` code, a `retryAfter`,
  // or any other field that would tell "I am capped" from "you cannot see it".
  // Mutation-checked in that direction rather than against the base.
  test('🔴 the over-budget refusal is INDISTINGUISHABLE from "you cannot see it"', async () => {
    const replies = await mountReadyAndSettled();

    await spendBudgetOnUnseeableIds(replies);
    await pacedPost('SET_COLLECTION_FOLLOW', {
      requestId: 'rq_budget_21',
      collectionId: OVER_BUDGET_FIRST_ID + 20,
      follow: true,
    });

    // `rq_budget_1` was a REAL lookup that came back not-visible; `rq_budget_21`
    // was refused unlooked. A block must not be able to tell them apart, or the
    // cap hands back the very bit it exists to withhold.
    const notVisible = await awaitReply(replies, 'rq_budget_1');
    const overBudget = await awaitReply(replies, 'rq_budget_21');
    const withoutId = (p: Record<string, unknown>) => {
      const { requestId: _drop, ...rest } = p;
      return rest;
    };
    expect(withoutId(overBudget)).toEqual(withoutId(notVisible));
    expect(overBudget).toEqual({ requestId: 'rq_budget_21', error: 'collection-unavailable' });
    replies.stop();
  }, 30_000);

  test('🔴 an ALREADY-RESOLVED id still works past the cap — re-following never breaks', async () => {
    getByIdFetch.mockImplementation((input: { id: number }) =>
      Promise.resolve(input.id === 77 ? VISIBLE_COLLECTION : UNAVAILABLE_COLLECTION)
    );
    followMutate.mockResolvedValue(undefined);
    const replies = await mountReadyAndSettled();

    // 1 of 20: a collection the viewer really can see, followed for real.
    await pacedPost('SET_COLLECTION_FOLLOW', {
      requestId: 'rq_keep_1',
      collectionId: 77,
      follow: true,
    });
    await vi.waitFor(() => expect(useDialogStore.getState().dialogs).toHaveLength(1));
    await (lastDialog().props as ConfirmProps).onConfirm();
    await awaitReply(replies, 'rq_keep_1');
    useDialogStore.getState().closeAll();

    // 19 more distinct ids exhaust the rest of the budget.
    for (let i = 1; i <= 19; i++) {
      const requestId = `rq_fill_${i}`;
      await pacedPost('SET_COLLECTION_FOLLOW', {
        requestId,
        collectionId: OVER_BUDGET_FIRST_ID + i,
        follow: true,
      });
      await awaitReply(replies, requestId);
    }
    const spent = getByIdFetch.mock.calls.length;
    expect(spent).toBe(20);

    // A NEW id is now refused unlooked…
    await pacedPost('SET_COLLECTION_FOLLOW', {
      requestId: 'rq_new_after_cap',
      collectionId: 999_777,
      follow: true,
    });
    expect(await awaitReply(replies, 'rq_new_after_cap')).toEqual({
      requestId: 'rq_new_after_cap',
      error: 'collection-unavailable',
    });
    expect(getByIdFetch).toHaveBeenCalledTimes(spent);

    // …while the collection the viewer already consented about resolves, opens a
    // named dialog and writes, exactly as before. This is the half a naive
    // per-call rate limit would have broken.
    await pacedPost('SET_COLLECTION_FOLLOW', {
      requestId: 'rq_keep_2',
      collectionId: 77,
      follow: false,
    });
    await vi.waitFor(() => expect(useDialogStore.getState().dialogs).toHaveLength(1));
    expect(getByIdFetch).toHaveBeenCalledTimes(spent + 1);
    const props = lastDialog().props as ConfirmProps;
    // 🔴 F1 is NOT regressed by the budget: the dialog still names the object.
    expect(props.message).toContain('“Cute Cats” by alice');
    unfollowMutate.mockResolvedValue(undefined);
    await props.onConfirm();
    expect(unfollowMutate).toHaveBeenCalledWith({ collectionId: 77 });
    expect(await awaitReply(replies, 'rq_keep_2')).toEqual({
      requestId: 'rq_keep_2',
      result: { collectionId: 77, followed: false },
    });
    replies.stop();
  }, 30_000);

  test('🔴 the budget is PER BLOCK INSTANCE — a remount starts fresh', async () => {
    const first = await mountReadyAndSettled();
    await spendBudgetOnUnseeableIds(first);
    await pacedPost('SET_COLLECTION_FOLLOW', {
      requestId: 'rq_budget_21',
      collectionId: OVER_BUDGET_FIRST_ID + 20,
      follow: true,
    });
    await awaitReply(first, 'rq_budget_21');
    expect(getByIdFetch).toHaveBeenCalledTimes(20);
    first.stop();

    // A module-scope ledger would survive this; a ref does not.
    await cleanup();
    const second = await mountReadyAndSettled();

    await pacedPost('SET_COLLECTION_FOLLOW', {
      requestId: 'rq_remount',
      collectionId: OVER_BUDGET_FIRST_ID + 20,
      follow: true,
    });
    await awaitReply(second, 'rq_remount');
    // The fresh instance looked it up — 21 total across the two mounts.
    expect(getByIdFetch).toHaveBeenCalledTimes(21);
    second.stop();
  }, 30_000);
});
