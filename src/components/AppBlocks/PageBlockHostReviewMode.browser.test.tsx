import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
import { useDialogStore } from '~/components/Dialog/dialogStore';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
// Type-only (erased at runtime, so it can't defeat vi.mock hoisting) — lets the
// `importOriginal` generic below be written without an inline `import()` type,
// which the repo's `consistent-type-imports` rule forbids.
import type * as MantineNotifications from '@mantine/notifications';

/**
 * MOD REVIEW SANDBOX (#2831) — PageBlockHost `reviewMode` read-only gate.
 *
 * The review preview runs UNAPPROVED, untrusted code with the mod's session. This
 * suite drives the REAL postMessage bridge and proves, for each class of handler:
 *   - reviewMode: every side-effecting / money / private / cross-user message
 *     replies with a KNOWN-SHAPE, fail-fast NACK (never a hang) AND never reaches
 *     the underlying tRPC mutation;
 *   - reviewMode: a render-safe read (GET_VIEWER) still works (mutation reached);
 *   - the NON-reviewMode (prod) path is UNCHANGED — the same message reaches the
 *     mutation;
 *   - the opaque-origin handshake: at trustTier='unverified' the iframe sandbox
 *     drops allow-same-origin and BLOCK_INIT (carrying the review token) still
 *     reaches BLOCK_READY (the path unverified prod blocks already use).
 */

const mocks = vi.hoisted(() => ({
  submit: vi.fn(async () => ({ snapshot: { workflowId: 'w', status: 'ok' } })),
  buzzBalance: vi.fn(async () => ({ balance: 5 })),
  viewer: vi.fn(async () => ({ id: 42, username: 'mod' })),
  storageSet: vi.fn(async () => ({ sizeBytes: 1 })),
  sharedAppend: vi.fn(async () => ({ key: 'k' })),
  // Session-authed (protectedProcedure) wildcard resolve — the token-INDEPENDENT
  // handler. Returns an over-cap size so the non-reviewMode path short-circuits at
  // the pre-download cap and never actually fetches (keeps the test network-free).
  wildcard: vi.fn(async () => ({ sizeBytes: 10 ** 9, signedUrl: 'x', meta: {}, maturity: {} })),
}));

// AppBlockChrome (in the host frame) calls useCurrentUser() for the platform-nav
// moderator gate; render the real host without a CivitaiSessionProvider.
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));

// Spy on the toast so the reviewMode consent-feedback path is assertable without
// mounting the full Notifications provider. Preserve the module's other exports.
const showNotificationSpy = vi.fn();
// `hideNotification` is the generic→named UPGRADE path: the named notice carries
// its OWN id (Mantine no-ops a duplicate id, and `updateNotification` would drop
// the upgrade once the generic auto-closed), so it retires the generic explicitly.
const hideNotificationSpy = vi.fn();
vi.mock('@mantine/notifications', async (importOriginal) => {
  const actual = await importOriginal<typeof MantineNotifications>();
  return {
    ...actual,
    showNotification: (args: unknown) => showNotificationSpy(args),
    hideNotification: (id: unknown) => hideNotificationSpy(id),
  };
});

vi.mock('~/utils/trpc', () => ({
  setTrpcBatchingEnabled: vi.fn(),
  trpc: {
    generation: { resolveWildcardPack: { useMutation: () => ({ mutateAsync: mocks.wildcard }) } },
    blocks: {
      submitWorkflow: { useMutation: () => ({ mutateAsync: mocks.submit }) },
      getMyBuzzBalance: { useMutation: () => ({ mutateAsync: mocks.buzzBalance }) },
      getMyViewer: { useMutation: () => ({ mutateAsync: mocks.viewer }) },
      getMyBuzzTransactions: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      getMyBuzzAccounts: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      getMyDailyCompensation: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      estimateWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      pollWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      cancelWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      queryAppWorkflows: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      cancelAppWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      // PageBlockHost also wires these at render (image-scan republish path);
      // stub so the mount succeeds. Missing → `trpc.blocks.<x>` is undefined →
      // `.useMutation()` throws at render, crashing the whole file's setup.
      publishGenerationOutputs: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      getImagesByIds: { useMutation: () => ({ mutateAsync: vi.fn() }) },
    },
    apps: {
      shared: {
        append: { useMutation: () => ({ mutateAsync: mocks.sharedAppend }) },
        update: { useMutation: () => ({ mutateAsync: vi.fn() }) },
        vote: { useMutation: () => ({ mutateAsync: vi.fn() }) },
        unvote: { useMutation: () => ({ mutateAsync: vi.fn() }) },
        withdraw: { useMutation: () => ({ mutateAsync: vi.fn() }) },
        report: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      },
      storage: {
        set: { useMutation: () => ({ mutateAsync: mocks.storageSet }) },
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

function postFromBlock(type: string, payload?: unknown, origin: string = window.location.origin) {
  const iframeEl = page.getByTestId('app-page-iframe').element() as HTMLIFrameElement;
  const cw = iframeEl.contentWindow;
  if (!cw) throw new Error('iframe contentWindow missing');
  // NB: we pass `cw` as `source` but never READ its properties — safe even when the
  // frame is cross-origin (opaque). `origin` selects the pinned vs opaque path.
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { type, payload },
      origin,
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

const SAME_ORIGIN_SRC = `${window.location.origin}/`;
const REVIEW_TOKEN = 'review.jwt.self-bound';

const baseProps = {
  appBlockId: 'pubreq_TEST',
  blockId: 'my-page-app',
  appId: 'pending-pubreq_TEST',
  blockInstanceId: 'page_pubreq_TEST',
  appName: 'Reviewed App',
  iframeSrc: SAME_ORIGIN_SRC,
  sandbox: 'allow-scripts',
  // Pinned transport (internal) for deterministic delivery — reviewMode is
  // independent of trust tier. The opaque-origin path has its own test below.
  trustTier: 'internal' as const,
  slug: 'my-page-app',
  token: REVIEW_TOKEN,
  expiresAt: new Date(Date.now() + 4 * 3_600_000).toISOString(),
  declaredScopes: ['models:read:self', 'user:read:self'],
  missingScopes: [] as string[],
  needsConsent: false,
  tokenError: false,
  viewer: { id: 42, username: 'mod' },
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

beforeEach(() => {
  useDialogStore.getState().closeAll();
  mocks.submit.mockClear();
  mocks.buzzBalance.mockClear();
  mocks.viewer.mockClear();
  mocks.storageSet.mockClear();
  mocks.sharedAppend.mockClear();
  mocks.wildcard.mockClear();
  showNotificationSpy.mockClear();
  hideNotificationSpy.mockClear();
});

describe('PageBlockHost reviewMode — side-effecting handlers fail-fast NACK, never reach the mutation', () => {
  test('SUBMIT_WORKFLOW → failed snapshot, submitWorkflow NOT called', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} reviewMode onConsentGranted={vi.fn()} />);
    await driveToReady();
    const l = listenForReply();

    postFromBlock('SUBMIT_WORKFLOW', { requestId: 'r1', body: { anything: true } });

    await vi.waitFor(() => expect(l.last('WORKFLOW_SUBMITTED')).toBeTruthy());
    const reply = l.last('WORKFLOW_SUBMITTED')!.payload as {
      requestId: string;
      snapshot: { status: string; error: string; workflowId: string };
    };
    expect(reply.requestId).toBe('r1');
    expect(reply.snapshot.status).toBe('failed');
    expect(reply.snapshot.error).toBe('not available in review preview');
    expect(mocks.submit).not.toHaveBeenCalled();
    l.stop();
  });

  test('GET_BUZZ_BALANCE → error reply, getMyBuzzBalance NOT called', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} reviewMode onConsentGranted={vi.fn()} />);
    await driveToReady();
    const l = listenForReply();

    postFromBlock('GET_BUZZ_BALANCE', { requestId: 'b1' });

    await vi.waitFor(() => expect(l.last('BUZZ_BALANCE_RESULT')).toBeTruthy());
    const reply = l.last('BUZZ_BALANCE_RESULT')!.payload as { requestId: string; error: string };
    expect(reply.requestId).toBe('b1');
    expect(reply.error).toBe('not available in review preview');
    expect(mocks.buzzBalance).not.toHaveBeenCalled();
    l.stop();
  });

  test('APP_STORAGE_SET → ok:false error reply, storage.set NOT called', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} reviewMode onConsentGranted={vi.fn()} />);
    await driveToReady();
    const l = listenForReply();

    postFromBlock('APP_STORAGE_SET', { requestId: 's1', key: 'k', value: 'v' });

    await vi.waitFor(() => expect(l.last('APP_STORAGE_SET_RESULT')).toBeTruthy());
    const reply = l.last('APP_STORAGE_SET_RESULT')!.payload as {
      requestId: string;
      ok: boolean;
      error: string;
    };
    expect(reply.requestId).toBe('s1');
    expect(reply.ok).toBe(false);
    expect(reply.error).toBe('not available in review preview');
    expect(mocks.storageSet).not.toHaveBeenCalled();
    l.stop();
  });

  test('SHARED_APPEND (cross-user write) → error reply, shared.append NOT called', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} reviewMode onConsentGranted={vi.fn()} />);
    await driveToReady();
    const l = listenForReply();

    postFromBlock('SHARED_APPEND', { requestId: 'sa1', value: { title: 'x' } });

    await vi.waitFor(() => expect(l.last('SHARED_APPEND_RESULT')).toBeTruthy());
    const reply = l.last('SHARED_APPEND_RESULT')!.payload as { requestId: string; error: string };
    expect(reply.requestId).toBe('sa1');
    expect(reply.error).toBe('not available in review preview');
    expect(mocks.sharedAppend).not.toHaveBeenCalled();
    l.stop();
  });

  test('OPEN_BUZZ_PURCHASE → purchased:false, never opens the Buy-Buzz dialog', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} reviewMode onConsentGranted={vi.fn()} />);
    await driveToReady();
    const l = listenForReply();
    expect(useDialogStore.getState().dialogs).toHaveLength(0);

    postFromBlock('OPEN_BUZZ_PURCHASE', { requestId: 'p1', suggestedAmount: 500 });

    await vi.waitFor(() => expect(l.last('BUZZ_PURCHASE_RESULT')).toBeTruthy());
    const reply = l.last('BUZZ_PURCHASE_RESULT')!.payload as {
      requestId: string;
      purchased: boolean;
    };
    expect(reply.purchased).toBe(false);
    // No spend modal ever opened at the mod.
    expect(useDialogStore.getState().dialogs).toHaveLength(0);
    l.stop();
  });

  test('GET_WILDCARD_PACK (session-authed, token-INDEPENDENT) → NACK, resolveWildcardPack NOT called', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} reviewMode onConsentGranted={vi.fn()} />);
    await driveToReady();
    const l = listenForReply();

    postFromBlock('GET_WILDCARD_PACK', { requestId: 'wp1', modelVersionId: 9001 });

    await vi.waitFor(() => expect(l.last('WILDCARD_PACK_RESULT')).toBeTruthy());
    const reply = l.last('WILDCARD_PACK_RESULT')!.payload as { requestId: string; error: string };
    expect(reply.requestId).toBe('wp1');
    expect(reply.error).toBe('not available in review preview');
    // The mod's session-authed download entitlement is NEVER exercised in review.
    expect(mocks.wildcard).not.toHaveBeenCalled();
    l.stop();
  });

  test('render-safe GET_VIEWER STILL works in reviewMode (mutation reached)', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} reviewMode onConsentGranted={vi.fn()} />);
    await driveToReady();
    const l = listenForReply();

    postFromBlock('GET_VIEWER', { requestId: 'v1' });

    await vi.waitFor(() => expect(mocks.viewer).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(l.last('VIEWER_RESULT')).toBeTruthy());
    l.stop();
  });
});

describe('PageBlockHost reviewMode — REQUEST_CONSENT gives the mod feedback, never a modal', () => {
  // THE BUG: reviewMode dropped REQUEST_CONSENT with a bare `return` ABOVE the
  // "permission unavailable" toast, so a moderator clicking a consent-gated action
  // in the review preview got NOTHING — no modal, no toast, no error — while the
  // app parked forever on its consent card. The modal ban is correct and stays
  // (a grant would re-mint the mod's token with WIDER scopes at the request of
  // unapproved code, and the review mint's scope-stripping is deliberate); only
  // the silence is fixed, with a passive notice pointing at "Run for real…".
  const lastNotification = () =>
    showNotificationSpy.mock.calls.at(-1)?.[0] as
      | { id?: string; title?: string; message?: string }
      | undefined;

  test('a consent request the preview can never grant surfaces a notice (and NO consent modal)', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} reviewMode onConsentGranted={vi.fn()} />);
    await driveToReady();

    // Re-post inside waitFor: `data-block-ready` can lead the host's message-gate
    // state by a tick, and a dropped fire-and-forget message is never retried.
    await vi.waitFor(() => {
      postFromBlock('REQUEST_CONSENT', { scopes: ['buzz:read:self'] });
      expect(showNotificationSpy).toHaveBeenCalledTimes(1);
    });

    const notice = lastNotification();
    // Names the specific requested scope (useful to a reviewer) …
    expect(notice?.message).toContain('buzz:read:self');
    // … and points at the existing opt-in escape hatch …
    expect(notice?.message).toContain('Run for real');
    // … while saying what that opt-in COSTS the mod. Untrusted code can emit this
    // toast unprompted, and "Run for real…" re-mints against the moderator's OWN
    // account and spends the moderator's OWN Buzz (`ai:write:budgeted`, session-
    // capped) — so it must not read as a free "make it work" button.
    expect(notice?.message).toContain('your own account and Buzz');
    // 🔴 The security invariant: untrusted review code still cannot pop a
    // permission modal at the moderator.
    expect(useDialogStore.getState().dialogs).toHaveLength(0);
  });

  test('a hint-less REQUEST_CONSENT (the fire-and-forget SDK call) still notifies', async () => {
    // `useRequestConsent()` sends no requestId and need not send a `scopes` hint.
    // The prod path stays silent without one (it cannot tell "already granted"
    // from "clamped"); in review there is nothing to tell apart — consent is
    // structurally unavailable — so the mod is told regardless.
    renderWithProviders(<PageBlockHost {...baseProps} reviewMode onConsentGranted={vi.fn()} />);
    await driveToReady();

    await vi.waitFor(() => {
      postFromBlock('REQUEST_CONSENT', {});
      expect(showNotificationSpy).toHaveBeenCalledTimes(1);
    });
    expect(useDialogStore.getState().dialogs).toHaveLength(0);
  });

  test('🔴 ANTI-SPAM: a flood AFTER the scope-named notice produces no further notices', async () => {
    // The reviewed app is UNTRUSTED code and can post in a loop; one toast per
    // message would let a hostile submission carpet-bomb the reviewing mod's
    // screen and bury the review chrome. The transport's generic 30-msg/s limiter
    // is NOT sufficient on its own — 30 toasts a second is still a carpet bomb —
    // so the host latches. Once the NAMED (most informative) notice is out there
    // is nothing left to say, so the latch is closed for the rest of the mount.
    // The flood below is deliberately kept UNDER the transport budget so this
    // asserts the LATCH, not the rate limiter.
    renderWithProviders(<PageBlockHost {...baseProps} reviewMode onConsentGranted={vi.fn()} />);
    await driveToReady();

    await vi.waitFor(() => {
      postFromBlock('REQUEST_CONSENT', { scopes: ['buzz:read:self'] });
      expect(showNotificationSpy).toHaveBeenCalledTimes(1);
    });

    for (let i = 0; i < 4; i++) {
      postFromBlock('REQUEST_CONSENT', { scopes: ['buzz:read:self'] });
      postFromBlock('REQUEST_CONSENT', {});
      postFromBlock('REQUEST_CONSENT', { scopes: ['social:tip:self'] });
    }
    await new Promise((r) => setTimeout(r, 150));
    expect(showNotificationSpy).toHaveBeenCalledTimes(1);
    expect(useDialogStore.getState().dialogs).toHaveLength(0);
  });

  test('🔴 a hint-less request first does NOT bury the later scope-NAMED one (one upgrade allowed)', async () => {
    // THE FIRST-NOTICE-WINS BUG. `useRequestConsent()`'s `scopes` hint is
    // OPTIONAL, so a hint-less REQUEST_CONSENT on load is an ordinary path. With
    // a plain "already notified" latch it won, the mod got only the generic copy,
    // and the app's later specific request was suppressed for the whole mount —
    // the reviewer never learned WHICH permission was blocked.
    renderWithProviders(<PageBlockHost {...baseProps} reviewMode onConsentGranted={vi.fn()} />);
    await driveToReady();

    await vi.waitFor(() => {
      postFromBlock('REQUEST_CONSENT', {});
      expect(showNotificationSpy).toHaveBeenCalledTimes(1);
    });
    const generic = lastNotification();
    expect(generic?.message).not.toContain('buzz:read:self');

    postFromBlock('REQUEST_CONSENT', { scopes: ['buzz:read:self'] });
    await vi.waitFor(() => expect(showNotificationSpy).toHaveBeenCalledTimes(2));

    const named = lastNotification();
    expect(named?.message).toContain('buzz:read:self');
    // Distinct id, or Mantine would silently dedupe the upgrade away …
    expect(named?.id).not.toBe(generic?.id);
    // … and the superseded generic is retired so the mod sees ONE notice.
    expect(hideNotificationSpy).toHaveBeenCalledWith(generic?.id);
    expect(useDialogStore.getState().dialogs).toHaveLength(0);
  });

  test('🔴 ANTI-SPAM BOUND: generic-then-flood is capped at TWO notices for the whole mount', async () => {
    // The upgrade must not reopen an unbounded path: after the named notice the
    // latch is closed again, so a hostile loop mixing hint-less and hinted (and
    // differently-hinted) requests still tops out at two toasts per mount.
    renderWithProviders(<PageBlockHost {...baseProps} reviewMode onConsentGranted={vi.fn()} />);
    await driveToReady();

    await vi.waitFor(() => {
      postFromBlock('REQUEST_CONSENT', {});
      expect(showNotificationSpy).toHaveBeenCalledTimes(1);
    });

    for (let i = 0; i < 4; i++) {
      postFromBlock('REQUEST_CONSENT', {});
      postFromBlock('REQUEST_CONSENT', { scopes: ['buzz:read:self'] });
      postFromBlock('REQUEST_CONSENT', { scopes: ['social:tip:self'] });
      postFromBlock('REQUEST_CONSENT', { scopes: ['ai:write:budgeted', 'buzz:read:self'] });
    }
    await new Promise((r) => setTimeout(r, 200));
    expect(showNotificationSpy).toHaveBeenCalledTimes(2);
    expect(useDialogStore.getState().dialogs).toHaveLength(0);
  });

  test('🔴 the notice id is MODE-SPECIFIC (render-only and run-for-real cannot dedupe each other)', async () => {
    // Mantine no-ops showNotification for an id already displayed or queued
    // (default autoClose 4000ms). With one shared id the realistic sequence
    // "notice fires in render-only → mod clicks Run for real… → the chrome
    // REMOUNTS the host → the latch resets by design → the app re-requests within
    // 4s" silently swallowed the run-for-real notice — the original bug, in the
    // other mode. The ids must differ per mode.
    // `render` is async in vitest-browser-react v2 — await it to get `unmount`.
    const first = await renderWithProviders(
      <PageBlockHost {...baseProps} reviewMode onConsentGranted={vi.fn()} />
    );
    await driveToReady();
    await vi.waitFor(() => {
      postFromBlock('REQUEST_CONSENT', { scopes: ['buzz:read:self'] });
      expect(showNotificationSpy).toHaveBeenCalledTimes(1);
    });
    const renderOnlyId = lastNotification()?.id;
    expect(renderOnlyId).toBeTruthy();
    await first.unmount();

    // The run-for-real flip: same appBlockId, fresh mount.
    renderWithProviders(
      <PageBlockHost {...baseProps} reviewMode reviewRunForReal onConsentGranted={vi.fn()} />
    );
    await driveToReady();
    await vi.waitFor(() => {
      postFromBlock('REQUEST_CONSENT', { scopes: ['buzz:read:self'] });
      expect(showNotificationSpy).toHaveBeenCalledTimes(2);
    });
    const runForRealId = lastNotification()?.id;

    expect(runForRealId).toBeTruthy();
    expect(runForRealId).not.toBe(renderOnlyId);
  });

  test('🔴 the mod-facing copy can only contain KNOWN scope strings (untrusted manifest text is dropped)', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} reviewMode onConsentGranted={vi.fn()} />);
    await driveToReady();

    await vi.waitFor(() => {
      postFromBlock('REQUEST_CONSENT', {
        scopes: ['<img src=x onerror=alert(1)>', 'totally:made:up', 'buzz:read:self'],
      });
      expect(showNotificationSpy).toHaveBeenCalledTimes(1);
    });

    const message = lastNotification()?.message ?? '';
    expect(message).toContain('buzz:read:self');
    expect(message).not.toContain('onerror');
    expect(message).not.toContain('totally:made:up');
  });

  test('a benign re-request of an ALREADY-GRANTED scope stays silent', async () => {
    // baseProps.declaredScopes carries models:read:self with nothing withheld, so
    // the block already holds it — nothing is blocked, so nothing to report.
    renderWithProviders(<PageBlockHost {...baseProps} reviewMode onConsentGranted={vi.fn()} />);
    await driveToReady();

    postFromBlock('REQUEST_CONSENT', { scopes: ['models:read:self'] });

    await new Promise((r) => setTimeout(r, 150));
    expect(showNotificationSpy).not.toHaveBeenCalled();
    expect(useDialogStore.getState().dialogs).toHaveLength(0);
  });

  test('in run-for-real the copy does NOT tell the mod to use "Run for real…" (they already did)', async () => {
    renderWithProviders(
      <PageBlockHost {...baseProps} reviewMode reviewRunForReal onConsentGranted={vi.fn()} />
    );
    await driveToReady();

    await vi.waitFor(() => {
      postFromBlock('REQUEST_CONSENT', { scopes: ['buzz:read:self'] });
      expect(showNotificationSpy).toHaveBeenCalledTimes(1);
    });

    const message = lastNotification()?.message ?? '';
    expect(message).toContain('buzz:read:self');
    expect(message).not.toContain('Run for real');
  });

  test('the NON-review path is unchanged (generic #3190 toast, and the modal path still works)', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} onConsentGranted={vi.fn()} />);
    await driveToReady();

    await vi.waitFor(() => {
      postFromBlock('REQUEST_CONSENT', { scopes: ['buzz:read:self'] });
      expect(showNotificationSpy).toHaveBeenCalledTimes(1);
    });

    // The prod un-grantable toast, NOT the review copy.
    const notice = lastNotification();
    expect(notice?.title).toBe('Permission unavailable');
    expect(notice?.message).not.toContain('Run for real');
    expect(notice?.message).not.toContain('buzz:read:self');
  });
});

describe('PageBlockHost reviewMode + reviewRunForReal — side-effects run the REAL mutation', () => {
  // The mod opted in (consent-gated) to run the unapproved app for real against
  // their OWN account. The self-bound / money-in / own-Buzz / per-user-storage
  // handlers now reach the mutation (the token carries the scopes + budget) —
  // proving reviewRunForReal flips the NACK. CROSS-USER writes stay NACKed below.
  test('SUBMIT_WORKFLOW reaches submitWorkflow (no NACK)', async () => {
    renderWithProviders(
      <PageBlockHost {...baseProps} reviewMode reviewRunForReal onConsentGranted={vi.fn()} />
    );
    await driveToReady();

    postFromBlock('SUBMIT_WORKFLOW', { requestId: 'rfr1', body: { ok: true } });

    await vi.waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(1));
  });

  test('GET_BUZZ_BALANCE reaches getMyBuzzBalance (own, self-bound)', async () => {
    renderWithProviders(
      <PageBlockHost {...baseProps} reviewMode reviewRunForReal onConsentGranted={vi.fn()} />
    );
    await driveToReady();

    postFromBlock('GET_BUZZ_BALANCE', { requestId: 'rfrb1' });

    await vi.waitFor(() => expect(mocks.buzzBalance).toHaveBeenCalledTimes(1));
  });

  test('APP_STORAGE_SET reaches storage.set (per-user, own)', async () => {
    renderWithProviders(
      <PageBlockHost {...baseProps} reviewMode reviewRunForReal onConsentGranted={vi.fn()} />
    );
    await driveToReady();

    postFromBlock('APP_STORAGE_SET', { requestId: 'rfrs1', key: 'k', value: 'v' });

    await vi.waitFor(() => expect(mocks.storageSet).toHaveBeenCalledTimes(1));
  });

  test('SHARED_APPEND (cross-user write) STILL NACKs even in run-for-real, shared.append NOT called', async () => {
    renderWithProviders(
      <PageBlockHost {...baseProps} reviewMode reviewRunForReal onConsentGranted={vi.fn()} />
    );
    await driveToReady();
    const l = listenForReply();

    postFromBlock('SHARED_APPEND', { requestId: 'rfrsa1', value: { title: 'x' } });

    await vi.waitFor(() => expect(l.last('SHARED_APPEND_RESULT')).toBeTruthy());
    const reply = l.last('SHARED_APPEND_RESULT')!.payload as { requestId: string; error: string };
    expect(reply.error).toBe('not available in review preview');
    expect(mocks.sharedAppend).not.toHaveBeenCalled();
    l.stop();
  });

  test('render-safe GET_VIEWER still works in run-for-real (read stays live in BOTH sub-modes)', async () => {
    renderWithProviders(
      <PageBlockHost {...baseProps} reviewMode reviewRunForReal onConsentGranted={vi.fn()} />
    );
    await driveToReady();

    postFromBlock('GET_VIEWER', { requestId: 'rfrv1' });

    await vi.waitFor(() => expect(mocks.viewer).toHaveBeenCalledTimes(1));
  });
});

describe('PageBlockHost reviewMode — the NON-reviewMode (prod) path is unchanged', () => {
  test('without reviewMode, SUBMIT_WORKFLOW reaches submitWorkflow', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} onConsentGranted={vi.fn()} />);
    await driveToReady();

    postFromBlock('SUBMIT_WORKFLOW', { requestId: 'r2', body: { ok: true } });

    // The prod path forwards to the mutation exactly as before (no NACK).
    await vi.waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(1));
  });

  test('without reviewMode, GET_WILDCARD_PACK reaches resolveWildcardPack', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} onConsentGranted={vi.fn()} />);
    await driveToReady();

    postFromBlock('GET_WILDCARD_PACK', { requestId: 'wp2', modelVersionId: 9001 });

    // The prod path resolves as before (the mock's over-cap size short-circuits at
    // the pre-download cap → a 'too-large' reply, so no real fetch runs).
    await vi.waitFor(() => expect(mocks.wildcard).toHaveBeenCalledTimes(1));
  });
});

describe('PageBlockHost review preview handshake', () => {
  // BLOCK_INIT carries the review token — asserted in the pinned (same-origin)
  // transport so the test can read the frame's message channel. The token plumbing
  // is trust-tier-independent, so this pins "posts BLOCK_INIT with the review token
  // and the block reaches ready" (mirrors the dev host test).
  test('posts BLOCK_INIT carrying the review token and reaches BLOCK_READY', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} reviewMode onConsentGranted={vi.fn()} />);
    await vi.waitFor(() => {
      const el = page.getByTestId('app-page-iframe').element() as HTMLIFrameElement;
      if (!el.contentWindow) throw new Error('not mounted yet');
    });
    const l = listenForReply();
    // The controller re-posts BLOCK_INIT every 400ms until BLOCK_READY — wait for a
    // re-post to land on our listener, then assert it carries the review token.
    await vi.waitFor(
      () => {
        expect(l.last('BLOCK_INIT')).toBeTruthy();
      },
      { timeout: 3_000, interval: 100 }
    );
    const initPayload = l.last('BLOCK_INIT')!.payload as { token: { raw: string } };
    expect(initPayload.token.raw).toBe(REVIEW_TOKEN);

    // Completing the handshake still works (data-block-ready flips).
    await driveToReady();
    l.stop();
  });

  // The C1 opaque-origin defense: at trustTier='unverified' the iframe drops
  // allow-same-origin (runs at an opaque origin), and the host's postMessage
  // transport ACCEPTS an inbound `origin:'null'` BLOCK_READY (the OriginMatcher
  // opaque path unverified prod blocks already use) — completing the handshake.
  // The frame is genuinely cross-origin here, so we drive it via a synthetic
  // origin:'null' message rather than its contentWindow's listener.
  test('at trustTier=unverified the sandbox is opaque and an origin:null BLOCK_READY completes the handshake', async () => {
    renderWithProviders(
      <PageBlockHost {...baseProps} trustTier="unverified" reviewMode onConsentGranted={vi.fn()} />
    );
    await vi.waitFor(() => {
      const el = page.getByTestId('app-page-iframe').element() as HTMLIFrameElement;
      if (!el.contentWindow) throw new Error('not mounted yet');
    });

    // Opaque origin: allow-same-origin is dropped, allow-scripts remains.
    const iframeEl = page.getByTestId('app-page-iframe').element() as HTMLIFrameElement;
    const sandboxAttr = (iframeEl.getAttribute('sandbox') ?? '').split(/\s+/);
    expect(sandboxAttr).not.toContain('allow-same-origin');
    expect(sandboxAttr).toContain('allow-scripts');

    // An opaque-origin (origin:'null') BLOCK_READY is accepted → handshake done.
    await vi.waitFor(() => {
      postFromBlock('BLOCK_READY', {}, 'null');
      const el = page.getByTestId('app-page-iframe').element() as HTMLIFrameElement;
      if (el.getAttribute('data-block-ready') !== 'true') throw new Error('not ready yet');
    });
  });
});
