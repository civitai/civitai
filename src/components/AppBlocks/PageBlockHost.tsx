import { Box, Center, Loader } from '@mantine/core';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { sanitizeAppChromeName } from './appChromeName';
import { BlockFallback } from './BlockFallback';
import { failureSnapshot } from './failureSnapshot';
import { AppBlockChrome } from './IframeHost';
import { IframeInitController, shouldStartInit } from './iframeInitController';
import { resolveBuzzPurchaseRequest } from './openBuzzPurchaseGate';
import {
  grantedPageScopes,
  pageFallbackReason,
  resolveCheckpointPickerRequest,
  resolveResourcePickerRequest,
} from './pageBlockHostLogic';
import { projectBlockInitMaturity } from './projectBlockInit';
import { sendBlockRender } from './sendBlockRender';
import { resolveRequestConsent } from './requestConsentGate';
import { resolveRequestSignIn } from './requestSignInGate';
import { effectiveSandboxIsOpaque, intersectSandbox } from './sandbox';
import { PAGE_SLOT_ID } from '~/shared/constants/slot-registry';
import { usePostMessage } from './usePostMessage';
import type { BlockInitPayload, PageContext } from './types';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { openLoginPopup } from '~/utils/auth-helpers';
import type { BuyBuzzModalProps } from '~/components/Modals/BuyBuzzModal';
import { openResourceSelectModal } from '~/components/Dialog/triggers/resource-select';
import { getBaseModelGroup, getBaseModelsByGroup } from '~/shared/constants/basemodel.constants';
import { deriveScopeFromInstanceId } from '~/server/schema/blocks/attribution.schema';
import { trpc } from '~/utils/trpc';

// Lazy-consent UI (REQUEST_CONSENT). Opened on demand when a logged-in viewer
// clicks an action whose consent-gated scope the page token is missing. Mirrors
// IframeHost's dynamic import (SSR-disabled).
const BlockConsentModal = dynamic(() => import('./BlockConsentModal'), { ssr: false });

// Buy-Buzz modal for the page money path's OPEN_BUZZ_PURCHASE handler (the
// insufficient-Buzz top-up CTA). Mirrors IframeHost's dynamic import.
const BuyBuzzModal = dynamic(() => import('~/components/Modals/BuyBuzzModal'));

// Login flow for anonymous-conversion (REQUEST_SIGN_IN). The page route renders
// for logged-out viewers (the BLOCK_INIT context is viewer-scoped, viewer:null),
// so a block can ask the host to start the civitai login flow when the user
// clicks an action that needs auth/money. Login is now hub-driven (a popup to
// auth.civitai.com) — see openLoginPopup; the old in-page LoginModal was removed
// in the auth cutover.

// Normalise a thrown storage error into a string the block can surface. Mirrors
// IframeHost.storageErrorMessage EXACTLY — the apps.storage.* procs throw
// TRPCErrors with explicit code+message strings (UNAUTHORIZED, PAYLOAD_TOO_LARGE,
// quota_exceeded, …); we forward the message and never throw upward, so the
// block's host-mediated storage request rejects cleanly instead of hanging to
// the SDK's 30s timeout.
function storageErrorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string' && message.length > 0) return message;
  }
  return 'storage request failed';
}

/**
 * W10 — full-page App Block host. Renders a block as a FULL-VIEWPORT surface
 * (not a model-column panel) under the same W7 trust chrome, driving the same
 * BLOCK_INIT / postMessage handshake the model IframeHost uses — but with a
 * PAGE context (entity=none, viewer-scoped, NO money scopes) and a deep-link
 * bridge (subPath forwarding + block-requested navigation).
 *
 * Deliberately a SEPARATE component from IframeHost (which is model-coupled:
 * checkpoint / showcase queries gated on modelId, model-only chrome) so the
 * behavior-preserving gate on the model path is not at risk. It reuses the
 * shared primitives: usePostMessage (origin-pinned transport),
 * IframeInitController (retry-until-BLOCK_READY), AppBlockChrome (spoof-proof
 * trust frame), intersectSandbox (client-side sandbox allowlist).
 *
 * Security posture (mirrors IframeHost):
 *   - BLOCK_INIT is posted to `new URL(iframeSrc).origin` (explicit target,
 *     never "*"); incoming messages from other origins are dropped.
 *   - Sandbox is the manifest ∩ trust-tier allowlist (client-side belt).
 *   - referrerPolicy=no-referrer; the page never carries a model/money scope.
 *   - Block-requested navigation (NAVIGATE) is constrained to the page's own
 *     sub-path space and uses shallow routing — a block can deep-link WITHIN
 *     its page but can't push the host off to an arbitrary route.
 */

const BLOCK_READY_TIMEOUT_MS = 10_000;
const TOKEN_WAIT_TIMEOUT_MS = 15_000;

// Hard cap on a block-suggested Buy-Buzz amount (mirrors IframeHost) — clamps a
// malicious/huge `suggestedAmount` so the spend modal can't be pre-seeded with
// an absurd value. The user still picks freely.
const BUZZ_PURCHASE_AMOUNT_CAP = 50_000;

type Status = 'loading' | 'ready' | 'timeout' | 'fatal' | 'no_token' | 'error';

export interface PageBlockHostProps {
  /** AppBlock id (`apb_*`) — used to build the BLOCK_INIT ids + trust chrome. */
  appBlockId: string;
  blockId: string;
  appId: string;
  /** The synthetic `page_<appBlockId>` instance id the token was minted for. */
  blockInstanceId: string;
  appName: string;
  /** The `<slug>.civit.ai` bundle URL (manifest.iframe.src), server-resolved. */
  iframeSrc: string;
  /** manifest.iframe.sandbox, server-resolved. */
  sandbox: string;
  trustTier: 'unverified' | 'verified' | 'internal';
  /** The page slug (== blockId). Forwarded in context for the block. */
  slug: string;
  /** The minted, viewer-scoped page token (no money scopes). */
  token: string | null;
  expiresAt: string | null;
  /** #3/#6: the page manifest's declared scopes. The host posts the ACTUAL
   *  granted set (declared − missingScopes) in BLOCK_INIT so the block sees the
   *  scopes the JWT actually carries (e.g. `apps:storage:*`), not `[]`. */
  declaredScopes: string[];
  /** #3/#6: consent-gated scopes withheld from the token (reported by the mint).
   *  Trimmed from the wrapped `token.scopes` so the block's capability check is
   *  accurate, and used to surface a consent-needed terminal state. */
  missingScopes?: string[];
  /** #3/#6: true when the app's approved manifest declares scopes the viewer has
   *  not granted (the token still mints with the granted subset). */
  needsConsent?: boolean;
  /** #3/#6: the token mint errored. Surface an error state instead of hanging at
   *  `no_token`. */
  tokenError?: boolean;
  /** Advisory color-domain maturity signal (BLOCK_INIT). Server-authoritative
   *  values from the token mint — forwarded, never derived client-side. */
  domain?: 'green' | 'blue' | 'red' | null;
  maxBrowsingLevel?: number;
  viewer: { id: number; username: string | null } | null;
  theme: 'light' | 'dark';
  /** Re-mint the page token after a consent grant so it carries the newly
   *  granted scopes (pushed to the iframe via TOKEN_REFRESH). Mirrors
   *  IframeHost.onConsentGranted → useBlockToken.refresh. */
  onConsentGranted?: () => void;
  /** Re-mint the page token on a Retry from an AUTH-failure terminal state
   *  (`error` / `no_token`). The token is a PROP minted by useBlockToken in the
   *  route; `handleRetry`'s local reset alone can never clear an auth failure
   *  because `token`/`tokenError` are owned upstream — only re-minting can. Wired
   *  to the same useBlockToken.refresh as onConsentGranted (it aborts any
   *  in-flight mint; the endpoint is rate-limited 60/min). Omitted → Retry on an
   *  auth error only remounts (the pre-fix dead-end), so the route MUST pass it. */
  onRetryToken?: () => void;
}

export function PageBlockHost({
  appBlockId,
  blockId,
  appId,
  blockInstanceId,
  appName,
  iframeSrc,
  sandbox,
  trustTier,
  slug,
  token,
  expiresAt,
  declaredScopes,
  missingScopes,
  needsConsent,
  tokenError,
  domain,
  maxBrowsingLevel,
  viewer,
  theme,
  onConsentGranted,
  onRetryToken,
}: PageBlockHostProps) {
  const router = useRouter();
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  // Mirror of `status` for the Retry handler to read the prior terminal state
  // WITHOUT putting a side-effect (onRetryToken) inside the setStatus updater
  // (which React may double-invoke under StrictMode → a double re-mint). Kept in
  // sync via the effect below.
  const statusRef = useRef<Status>('loading');
  // #4 Retry: bumped by the terminal-fallback Retry button to re-key the
  // <iframe> below. Re-keying forces React to unmount + remount the iframe (a
  // fresh `contentWindow`), so the re-armed init handshake talks to a clean
  // frame instead of a wedged one. See `handleRetry`.
  const [reloadNonce, setReloadNonce] = useState<number>(0);
  const initSentRef = useRef<boolean>(false);
  const controllerRef = useRef<IframeInitController | null>(null);
  const buildInitPayloadRef = useRef<() => BlockInitPayload>();
  // Analytics Phase 2: emit-once guard for the block-render beacon. The
  // status-transition gate ('loading' → 'ready') is the primary dedup, but a
  // burst of duplicate BLOCK_READY acks arriving before React commits the
  // 'ready' state could each still observe `current === 'loading'`. This ref
  // makes the per-mount emit deterministic regardless of ack timing.
  const blockRenderEmittedRef = useRef<boolean>(false);

  // Keep statusRef tracking the live status so handleRetry can branch on the
  // prior terminal state without reading it inside the setStatus updater.
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  const expectedOrigin = useMemo(() => {
    try {
      return new URL(iframeSrc).origin;
    } catch {
      return '';
    }
  }, [iframeSrc]);

  // The EFFECTIVE sandbox handed to the iframe attribute below. Derive the
  // transport's opaque-origin mode from the SAME string so the two can never
  // drift: unverified (no allow-same-origin) → opaque frame → opaque transport;
  // internal/verified (has allow-same-origin) → real origin → pinned transport.
  const effectiveSandbox = useMemo(
    () => intersectSandbox(sandbox, trustTier),
    [sandbox, trustTier]
  );
  const opaqueOrigin = useMemo(
    () => effectiveSandboxIsOpaque(effectiveSandbox),
    [effectiveSandbox]
  );

  const { send, onMessage } = usePostMessage({ iframeRef, expectedOrigin, opaqueOrigin });

  // App Blocks Analytics Phase 2 — fire-and-forget block render/impression.
  // Emitted exactly once per mount at the BLOCK_READY transition (see the
  // BLOCK_READY effect below) via the lightweight /api/track/block-render beacon
  // (NOT a tRPC mutation — this fires per model-page-with-a-block view and per
  // /apps/run load, so at GA it must skip the full tRPC middleware chain; mirrors
  // the #2680 addView -> beacon move). `isAnon`/`userId` are derived/stamped
  // server-side in the route; the client only passes the three identifiers. This
  // host only mounts behind the `appBlocks` (+ `appBlocksPages`) gate (SSR
  // fail-closed in [[...path]].tsx), so the event is dark behind the same flag as
  // the rest of App Blocks.

  // #3/#6: the scopes the minted JWT ACTUALLY carries (declared − missing).
  // See pageBlockHostLogic.grantedPageScopes. Posting `[]` (the old hardcode)
  // lied to the block about its capabilities.
  const grantedScopes = useMemo<string[]>(
    () => grantedPageScopes(declaredScopes, missingScopes),
    [declaredScopes, missingScopes]
  );

  // Current sub-path under /apps/run/<slug>/<...path> (no leading slash). Read
  // from the router so a popstate / back-forward reflects into the block.
  const subPath = useMemo(() => {
    const raw = router.query.path;
    if (Array.isArray(raw)) return raw.join('/');
    if (typeof raw === 'string') return raw;
    return '';
  }, [router.query.path]);

  const buildContext = useCallback(
    (): PageContext => ({
      slotId: 'app.page',
      entityType: 'none',
      slug,
      subPath,
      viewerUserId: viewer?.id ?? null,
      viewerUsername: viewer?.username ?? null,
      theme,
    }),
    [slug, subPath, viewer, theme]
  );

  const buildInitPayload = useCallback(
    (): BlockInitPayload => ({
      blockInstanceId,
      blockId,
      appId,
      token: {
        // initSent only fires after token is present (gated below); the
        // controller posts the freshest payload via the ref.
        raw: token ?? '',
        // #3/#6: the REAL granted scopes the JWT carries (page = viewer-scoped
        // ambient `apps:storage:*`; never money). Posting `[]` lied to the block
        // about the capabilities it holds.
        scopes: grantedScopes,
        expiresAt: expiresAt ?? '',
      },
      context: buildContext(),
      settings: { publisherSettings: {}, userSettings: {} },
      viewer,
      theme,
      renderMode: 'iframe',
      // Advisory maturity signal — server-authoritative values from the mint.
      ...projectBlockInitMaturity({ domain, maxBrowsingLevel }),
    }),
    [
      appId,
      blockId,
      blockInstanceId,
      buildContext,
      expiresAt,
      grantedScopes,
      token,
      viewer,
      theme,
      domain,
      maxBrowsingLevel,
    ]
  );
  buildInitPayloadRef.current = buildInitPayload;

  const sendInitOnce = useCallback(() => {
    initSentRef.current = true;
    send('BLOCK_INIT', (buildInitPayloadRef.current ?? (() => undefined as never))());
  }, [send]);

  // Init handshake — start once token is present (no checkpoint dependency for
  // a page). Retry-until-BLOCK_READY via the shared controller.
  useEffect(() => {
    if (!shouldStartInit({ status, hasToken: !!token, checkpointLoading: false })) return;
    if (controllerRef.current) return;
    const controller = new IframeInitController({
      sendInit: sendInitOnce,
      readyTimeoutMs: BLOCK_READY_TIMEOUT_MS,
      onReadyTimeout: () => {
        setStatus((current) => (current === 'loading' ? 'timeout' : current));
      },
    });
    controllerRef.current = controller;
    controller.start();
    return () => {
      controller.dispose();
      controllerRef.current = null;
    };
  }, [token, status, sendInitOnce]);

  // #3/#6: the mint errored (no token will arrive). Surface an `error` state
  // immediately rather than waiting out the no_token timeout — a hard mint
  // failure is terminal. (`needsConsent` is NOT terminal: the token still mints
  // with the granted subset, so the block loads; we only thread the consent
  // signal into the wrapped scopes above.)
  useEffect(() => {
    if (!tokenError || token) return;
    setStatus((current) => (current === 'loading' ? 'error' : current));
  }, [tokenError, token]);

  // Token never resolves → surface a no_token state instead of an endless
  // skeleton.
  useEffect(() => {
    if (status !== 'loading' || token) return;
    const t = setTimeout(() => {
      setStatus((current) => (current === 'loading' && !token ? 'no_token' : current));
    }, TOKEN_WAIT_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [status, token]);

  // Push a TOKEN_REFRESH when the token rotates after init.
  useEffect(() => {
    if (!initSentRef.current || !token) return;
    send('TOKEN_REFRESH', {
      token: { raw: token, scopes: grantedScopes, expiresAt: expiresAt ?? '' },
    });
  }, [token, expiresAt, grantedScopes, send]);

  // Answer a block-initiated REQUEST_TOKEN.
  useEffect(() => {
    const off = onMessage<{ requestId?: string } | undefined>('REQUEST_TOKEN', (raw) => {
      if (!token || !initSentRef.current) return;
      const requestId =
        raw && typeof raw === 'object' && typeof raw.requestId === 'string'
          ? raw.requestId
          : undefined;
      send('TOKEN_REFRESH_RESPONSE', {
        ...(requestId ? { requestId } : {}),
        token: { raw: token, scopes: grantedScopes, expiresAt: expiresAt ?? '' },
      });
    });
    return off;
  }, [token, expiresAt, grantedScopes, send, onMessage]);

  // BLOCK_READY → ready.
  useEffect(() => {
    const off = onMessage<unknown>('BLOCK_READY', () => {
      let acked = false;
      setStatus((current) => {
        if (current === 'loading') {
          acked = true;
          return 'ready';
        }
        return current;
      });
      if (acked) {
        controllerRef.current?.notifyReady();
        // Analytics Phase 2: one render/impression per mount. The `acked` gate
        // flips on the loading→ready transition; the emit-once ref makes it
        // deterministic even if duplicate acks land before React commits 'ready'
        // (so it fires exactly once per mount and never on re-render).
        // Fire-and-forget beacon — failures are a no-op (and a harmless no-op
        // until the `blockRenders` ClickHouse table exists; see PR body).
        if (!blockRenderEmittedRef.current) {
          blockRenderEmittedRef.current = true;
          sendBlockRender({ appBlockId, blockInstanceId, slotId: 'app.page' });
        }
      }
    });
    return off;
  }, [onMessage, appBlockId, blockInstanceId]);

  // BLOCK_ERROR{fatal:true} → fatal.
  useEffect(() => {
    const off = onMessage<unknown>('BLOCK_ERROR', (raw) => {
      if (raw && typeof raw === 'object' && (raw as { fatal?: unknown }).fatal === true) {
        setStatus((current) => (current === 'loading' || current === 'ready' ? 'fatal' : current));
      }
    });
    return off;
  }, [onMessage]);

  // Lazy consent (A6): the block (rendered in full for a logged-in viewer whose
  // page token is missing a consent-gated scope, e.g. `ai:write:budgeted` once
  // the page money scope is enabled) asks the host to open the consent UI when
  // the user clicks an action that needs that capability (e.g. Generate),
  // instead of a prompt on load. Mirrors IframeHost's REQUEST_CONSENT handler
  // exactly: we grant ONLY the missing set the MINT computed (`missingScopes` —
  // server-known truth), NOT any scopes the block claims; the gate also pins
  // status === 'ready' so a pre-handshake block can't pop a permission modal
  // before any interaction (same posture as NAVIGATE). On grant we re-mint the
  // token (onConsentGranted → useBlockToken.refresh); the new scopes flow to the
  // iframe via the TOKEN_REFRESH push above and the block retries — there is no
  // host→block reply (fire-and-forget).
  //
  // This was the W10 page-consent gap: the page surface (#2606) carried no money
  // scopes, so no consent handler was needed; #2612 enabled the page money scope
  // but never ported this handler from IframeHost, so REQUEST_CONSENT fired into
  // the void and the block hung on "confirm in the Civitai dialog".
  useEffect(() => {
    const off = onMessage<{ scopes?: unknown } | undefined>('REQUEST_CONSENT', () => {
      // PageBlockHost's local Status carries an extra terminal `'error'` variant
      // (a hard mint failure) the shared gate's HostStatus union doesn't model.
      // The gate only ever grants when status === 'ready', and `'error'` is a
      // disjoint terminal state (the iframe isn't even rendered), so collapse it
      // to a non-ready sentinel before delegating — semantics are unchanged (it
      // would return null either way), this just satisfies the union type.
      const gateStatus = status === 'error' ? 'no_token' : status;
      const scopesToGrant = resolveRequestConsent(gateStatus, missingScopes ?? []);
      if (scopesToGrant == null) return; // not ready, or nothing missing — drop
      dialogStore.trigger({
        component: BlockConsentModal,
        props: {
          appBlockId,
          // PageBlockHost surfaces the app name as `appName` (the model host
          // uses `install.manifest.name`).
          blockName: appName,
          missingScopes: scopesToGrant,
          onGranted: () => {
            onConsentGranted?.();
          },
        },
      });
    });
    return off;
  }, [onMessage, status, missingScopes, appBlockId, appName, onConsentGranted]);

  // Deep-link bridge — block requests in-page navigation. The block may push a
  // new sub-path WITHIN its own page space; we constrain it to the page route so
  // a block can't navigate the host off to an arbitrary path. `path` is an
  // untrusted same-origin sub-path: reject absolute URLs, protocol-relative
  // (`//`), and `..` traversal. Shallow routing keeps the page mounted (no SSR
  // round-trip) and the subPath change reflects back into the block via the
  // popstate handler below.
  useEffect(() => {
    const off = onMessage<{ path?: unknown } | undefined>('NAVIGATE', (raw) => {
      if (status !== 'ready') return; // pre-handshake blocks can't drive nav
      const rawPath = raw && typeof raw === 'object' ? (raw as { path?: unknown }).path : undefined;
      if (typeof rawPath !== 'string') return;
      // Normalize: strip a single leading slash; reject anything unsafe.
      const cleaned = rawPath.replace(/^\/+/, '');
      if (cleaned.startsWith('/') || cleaned.includes('//') || cleaned.split('/').includes('..')) {
        return;
      }
      const target = cleaned ? `/apps/run/${encodeURIComponent(slug)}/${cleaned}` : `/apps/run/${encodeURIComponent(slug)}`;
      void router.push(target, undefined, { shallow: true });
    });
    return off;
  }, [onMessage, status, router, slug]);

  // Forward host-side navigation (back/forward, or our own shallow push) into
  // the block so it can re-render the right view. Fires whenever the resolved
  // subPath changes AFTER init.
  useEffect(() => {
    if (!initSentRef.current || status !== 'ready') return;
    send('ROUTE_CHANGED', { subPath });
  }, [subPath, status, send]);

  // #5: page-visibility SUSPEND / RESUME — tell the block to pause work when its
  // tab is hidden and resume when shown (mirrors IframeHost). Only wired once the
  // block is ready so a pre-handshake block isn't told to suspend/resume before
  // it can listen.
  useEffect(() => {
    if (status !== 'ready') return;
    const handler = () => {
      if (document.visibilityState === 'visible') send('RESUME');
      else send('SUSPEND');
    };
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, [status, send]);

  // SUSPEND on unmount.
  useEffect(() => {
    return () => {
      if (initSentRef.current) send('SUSPEND');
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Money path: the @civitai/blocks-react useBuzzWorkflow bridge ───────────
  //
  // This was the SECOND W10 page gap (after consent). #2606 shipped pages with
  // NO money scopes, so the workflow bridge wasn't needed; #2612 added the
  // page-money server runtime + #2615 ported consent — but this host never
  // ported the workflow handlers from IframeHost. A page block calling
  // estimate/submit/poll/cancel (via useBuzzWorkflow) posts
  // ESTIMATE_WORKFLOW / SUBMIT_WORKFLOW / POLL_WORKFLOW / CANCEL_WORKFLOW into
  // the void → no blocks.* tRPC call → the SDK request hung to its 120s timeout
  // with no network call and no error. We mirror IframeHost EXACTLY: forward to
  // the same blocks.* mutations with the page `token` prop as `blockToken`, and
  // every path (success OR thrown) MUST post a reply (failure-shape snapshot via
  // failureSnapshot on throw) so the block's transport never hangs.
  //
  // Server-side blocks.{estimate,submit,poll,cancel}Workflow already enforce the
  // page token's scope + budget + entitlement gate (#2612); the host just
  // forwards the (untrusted, server-schema-validated) `body`/`workflowId` + the
  // token. No client-side gating is added here.
  //
  // token is a PROP here (string | null) — PageBlockHost does NOT use
  // useBlockToken (that's the page route). A null token means the block never
  // rendered a usable money surface; we drop such a request without a reply (the
  // block can't have legitimately fired a workflow without a token, and the mint
  // path surfaces no_token/error terminal states above). A missing requestId is
  // likewise dropped without replying — mirrors IframeHost.
  const submitWorkflowMutation = trpc.blocks.submitWorkflow.useMutation();
  const estimateWorkflowMutation = trpc.blocks.estimateWorkflow.useMutation();
  const pollWorkflowMutation = trpc.blocks.pollWorkflow.useMutation();
  const cancelWorkflowMutation = trpc.blocks.cancelWorkflow.useMutation();
  // getMyBuzzBalance is a MUTATION (not a query) DELIBERATELY: the block JWT is a
  // bearer credential a .query would leak into the ?input=… URL / logs / Referer
  // where it's replayable within its TTL. See blocks.router getMyBuzzBalance.
  const getMyBuzzBalanceMutation = trpc.blocks.getMyBuzzBalance.useMutation();

  // SUBMIT_WORKFLOW → blocks.submitWorkflow → WORKFLOW_SUBMITTED.
  useEffect(() => {
    const off = onMessage<{ requestId?: unknown; body?: unknown } | undefined>(
      'SUBMIT_WORKFLOW',
      async (raw) => {
        if (!raw || typeof raw.requestId !== 'string' || !token) return;
        const requestId = raw.requestId;
        try {
          const { snapshot } = await submitWorkflowMutation.mutateAsync({
            blockToken: token,
            // Schema-validated server-side; the host never trusts this shape.
            body: raw.body as never,
          });
          send('WORKFLOW_SUBMITTED', { requestId, snapshot });
        } catch (err) {
          send('WORKFLOW_SUBMITTED', { requestId, snapshot: failureSnapshot(err) });
        }
      }
    );
    return off;
  }, [onMessage, send, token, submitWorkflowMutation]);

  // ESTIMATE_WORKFLOW → blocks.estimateWorkflow → ESTIMATE_RESULT.
  useEffect(() => {
    const off = onMessage<{ requestId?: unknown; body?: unknown } | undefined>(
      'ESTIMATE_WORKFLOW',
      async (raw) => {
        if (!raw || typeof raw.requestId !== 'string' || !token) return;
        const requestId = raw.requestId;
        try {
          const { snapshot } = await estimateWorkflowMutation.mutateAsync({
            blockToken: token,
            body: raw.body as never,
          });
          send('ESTIMATE_RESULT', { requestId, snapshot });
        } catch (err) {
          send('ESTIMATE_RESULT', { requestId, snapshot: failureSnapshot(err) });
        }
      }
    );
    return off;
  }, [onMessage, send, token, estimateWorkflowMutation]);

  // POLL_WORKFLOW → blocks.pollWorkflow → WORKFLOW_STATUS.
  useEffect(() => {
    const off = onMessage<{ requestId?: unknown; workflowId?: unknown } | undefined>(
      'POLL_WORKFLOW',
      async (raw) => {
        if (
          !raw ||
          typeof raw.requestId !== 'string' ||
          typeof raw.workflowId !== 'string' ||
          raw.workflowId.length === 0 ||
          !token
        ) {
          return;
        }
        const requestId = raw.requestId;
        try {
          const { snapshot } = await pollWorkflowMutation.mutateAsync({
            blockToken: token,
            workflowId: raw.workflowId,
          });
          send('WORKFLOW_STATUS', { requestId, snapshot });
        } catch (err) {
          send('WORKFLOW_STATUS', { requestId, snapshot: failureSnapshot(err) });
        }
      }
    );
    return off;
  }, [onMessage, send, token, pollWorkflowMutation]);

  // CANCEL_WORKFLOW → blocks.cancelWorkflow → WORKFLOW_CANCELED. Ownership is
  // enforced server-side by the viewer's orchestrator token.
  useEffect(() => {
    const off = onMessage<{ requestId?: unknown; workflowId?: unknown } | undefined>(
      'CANCEL_WORKFLOW',
      async (raw) => {
        if (
          !raw ||
          typeof raw.requestId !== 'string' ||
          typeof raw.workflowId !== 'string' ||
          raw.workflowId.length === 0 ||
          !token
        ) {
          return;
        }
        const requestId = raw.requestId;
        try {
          const { snapshot } = await cancelWorkflowMutation.mutateAsync({
            blockToken: token,
            workflowId: raw.workflowId,
          });
          send('WORKFLOW_CANCELED', { requestId, snapshot });
        } catch (err) {
          send('WORKFLOW_CANCELED', { requestId, snapshot: failureSnapshot(err) });
        }
      }
    );
    return off;
  }, [onMessage, send, token, cancelWorkflowMutation]);

  // GET_BUZZ_BALANCE → blocks.getMyBuzzBalance → BUZZ_BALANCE_RESULT. The block's
  // per-account (blue/green/yellow) balance read that backs the SDK
  // `useBuzzBalance()` hook + the account-picker UI, so a money page block can
  // show the viewer which wallet a generation will draw from. Host-MEDIATED: the
  // iframe never sees a session; the balance is derived from the token's SELF-
  // BOUND `sub` server-side (never client input). REQUEST-style ⇒ every path MUST
  // post a reply or the block hangs to its SDK timeout.
  //
  // DEVIATION from the workflow handlers (which DROP a `!token` request silently):
  // a balance read is a pure UI affordance, not a spend — dropping it strands the
  // hook with no data and no error. So on a null token we reply with the ERROR
  // variant (`error: <message>`) instead of dropping, mirroring the storage
  // handlers' error-carrying result shape. A missing requestId is still dropped
  // without replying (mirrors every other handler — there's nothing to reply to).
  useEffect(() => {
    const off = onMessage<{ requestId?: unknown } | undefined>(
      'GET_BUZZ_BALANCE',
      async (raw) => {
        if (!raw || typeof raw.requestId !== 'string') return;
        const requestId = raw.requestId;
        if (!token) {
          send('BUZZ_BALANCE_RESULT', { requestId, error: 'no block token' });
          return;
        }
        try {
          const balance = await getMyBuzzBalanceMutation.mutateAsync({ blockToken: token });
          send('BUZZ_BALANCE_RESULT', { requestId, balance });
        } catch (err) {
          send('BUZZ_BALANCE_RESULT', {
            requestId,
            error: err instanceof Error ? err.message : 'unknown',
          });
        }
      }
    );
    return off;
  }, [onMessage, send, token, getMyBuzzBalanceMutation]);

  // OPEN_BUZZ_PURCHASE → BUZZ_PURCHASE_RESULT. The generator's insufficient-Buzz
  // top-up CTA. Gate on BLOCK_READY (+ payload validity) via the shared
  // resolveBuzzPurchaseRequest predicate so a pre-handshake block can't summon
  // the spend modal before any interaction (same posture as the model host).
  //
  // DEVIATION from IframeHost (intentional, documented): the model host derives
  // earnings attribution from the install context (deriveScopeFromInstanceId on
  // the `mbi_*`/`bus_*`/`pdb_*` instanceId prefix + modelId/slotId). The PAGE
  // instanceId is `page_<appBlockId>`, which deriveScopeFromInstanceId does NOT
  // recognise → returns null → attribution is omitted, exactly as IframeHost
  // already handles an unknown prefix ("skip attribution; the webhook treats it
  // as a regular buzz purchase"). There is no page-scoped earnings bucket today,
  // so a page top-up is an unattributed purchase. We invent NO new attribution
  // behavior — when/if a page earnings scope exists, extend
  // deriveScopeFromInstanceId (the single client-side prefix→scope mapper) and
  // this falls through automatically.
  useEffect(() => {
    const off = onMessage<{ requestId?: unknown; suggestedAmount?: unknown } | undefined>(
      'OPEN_BUZZ_PURCHASE',
      (raw) => {
        // PageBlockHost's local Status carries an extra terminal `'error'`
        // variant the shared gate's HostStatus union doesn't model; collapse it
        // to a non-ready sentinel (the gate only ever opens when status ===
        // 'ready', so this is semantics-preserving) — same shim as the consent
        // gate above.
        const gateStatus = status === 'error' ? 'no_token' : status;
        const requestId = resolveBuzzPurchaseRequest(gateStatus, raw);
        if (requestId == null || !raw) return; // !raw implied; narrows for TS
        const rawAmount =
          typeof raw.suggestedAmount === 'number' && Number.isFinite(raw.suggestedAmount)
            ? raw.suggestedAmount
            : undefined;
        const amount =
          rawAmount != null
            ? Math.min(Math.max(Math.floor(rawAmount), 0), BUZZ_PURCHASE_AMOUNT_CAP)
            : undefined;
        // Page instanceId prefix is unrecognised → null → no attribution (see
        // the DEVIATION note above). Kept structurally identical to IframeHost
        // so a future page-scope only needs the prefix mapper extended.
        const scope = deriveScopeFromInstanceId(blockInstanceId);
        const attribution = scope
          ? {
              appId,
              appBlockId,
              blockInstanceId,
              scope,
            }
          : undefined;
        let purchased = false;
        dialogStore.trigger<BuyBuzzModalProps>({
          // Per-request id so multiple OPEN_BUZZ_PURCHASE calls don't dedup
          // against each other in the dialog store's exists-check.
          id: `block-buy-buzz-${requestId}`,
          component: BuyBuzzModal,
          props: {
            minBuzzAmount: amount,
            attribution,
            onPurchaseSuccess: () => {
              purchased = true;
            },
          },
          options: {
            onClose: () => {
              send('BUZZ_PURCHASE_RESULT', { requestId, purchased });
            },
          },
        });
      }
    );
    return off;
  }, [onMessage, send, status, appId, appBlockId, blockInstanceId]);

  // ── Sign-in bridge: REQUEST_SIGN_IN (anonymous conversion) ─────────────────
  //
  // This was the THIRD W10 page gap. The page route renders for LOGGED-OUT
  // viewers (the BLOCK_INIT context is viewer-scoped with viewer:null when anon),
  // but PageBlockHost had no REQUEST_SIGN_IN handler — so a logged-out viewer who
  // clicks an action needing auth/money (e.g. Generate) dead-ended: the block
  // posted REQUEST_SIGN_IN into the void and the login modal never opened. We
  // mirror IframeHost EXACTLY: the shared resolveRequestSignIn gate pins
  // status === 'ready' (a pre-handshake block can't pop a login modal before any
  // interaction) and sanitises a block-supplied returnUrl to a same-origin in-app
  // path (absolute / protocol-relative values are dropped → LoginModal defaults
  // returnUrl to the current page). Fire-and-forget — there is no host→block
  // reply. The `'error' → 'no_token'` status shim is reused (PageBlockHost's local
  // Status carries the extra terminal 'error' variant the shared HostStatus union
  // doesn't model; the gate only ever opens when status === 'ready', so this is
  // semantics-preserving — same shim as the consent + buzz handlers).
  useEffect(() => {
    const off = onMessage<{ returnUrl?: unknown } | undefined>('REQUEST_SIGN_IN', (raw) => {
      const gateStatus = status === 'error' ? 'no_token' : status;
      const resolved = resolveRequestSignIn(gateStatus, raw);
      if (resolved == null) return; // not ready — drop (gate centralises the rules)
      // Hub-driven login (popup to auth.civitai.com). Falls back to the current page when the
      // block didn't supply a sanitised same-origin returnUrl. `reason` rides to the hub for the
      // LoginRedirect funnel analytics.
      const here = window.location.pathname + window.location.search + window.location.hash;
      openLoginPopup(resolved.returnUrl ?? here, 'image-gen');
    });
    return off;
  }, [onMessage, status]);

  // ── App Blocks KV datastore bridge (W4-v0) ─────────────────────────────────
  //
  // This was the FOURTH W10 page gap (the next message-into-the-void after
  // consent + workflow). PageBlockHost advertises `apps:storage:*` in BLOCK_INIT
  // and the page mint signs `apps:storage:read/write`, but the host had NO
  // storage handlers — so a storage-using page block (e.g. the Notepad page)
  // posting APP_STORAGE_GET/SET/DELETE/LIST/QUOTA fired into the void and hung to
  // the SDK's 30s timeout. We mirror IframeHost EXACTLY: five host-mediated
  // handlers (the iframe never sees the apps DB credentials), each replying with
  // the SAME requestId on BOTH the success and the error path — errors are
  // reported as `error: <string>` on the result payload (never thrown upward) so
  // the block-side hook rejects instead of stranding the bridge.
  //
  // token is a PROP here (string | null) — PageBlockHost does NOT use
  // useBlockToken (that's the page route). apps.storage.* require a non-null
  // blockToken (z.string().min(1)); a null token means the block never rendered a
  // usable surface, so each handler drops a `!token` request without replying
  // (consistent with the #2618 workflow handlers — the mint path surfaces
  // no_token/error terminal states above). A missing requestId is likewise
  // dropped without replying (mirrors IframeHost).
  const trpcUtils = trpc.useUtils();
  const storageSetMutation = trpc.apps.storage.set.useMutation();
  const storageDeleteMutation = trpc.apps.storage.delete.useMutation();

  // APP_STORAGE_GET → apps.storage.get → APP_STORAGE_GET_RESULT.
  useEffect(() => {
    const off = onMessage<{ requestId?: unknown; key?: unknown } | undefined>(
      'APP_STORAGE_GET',
      async (raw) => {
        if (!raw || typeof raw.requestId !== 'string' || typeof raw.key !== 'string' || !token)
          return;
        const requestId = raw.requestId;
        try {
          const result = await trpcUtils.apps.storage.get.fetch({
            blockToken: token,
            key: raw.key,
          });
          send('APP_STORAGE_GET_RESULT', { requestId, value: result.value });
        } catch (err) {
          send('APP_STORAGE_GET_RESULT', {
            requestId,
            value: null,
            error: storageErrorMessage(err),
          });
        }
      }
    );
    return off;
  }, [onMessage, send, token, trpcUtils]);

  // APP_STORAGE_SET → apps.storage.set → APP_STORAGE_SET_RESULT.
  useEffect(() => {
    const off = onMessage<{ requestId?: unknown; key?: unknown; value?: unknown } | undefined>(
      'APP_STORAGE_SET',
      async (raw) => {
        if (!raw || typeof raw.requestId !== 'string' || typeof raw.key !== 'string' || !token)
          return;
        const requestId = raw.requestId;
        try {
          const result = await storageSetMutation.mutateAsync({
            blockToken: token,
            key: raw.key,
            value: raw.value,
          });
          send('APP_STORAGE_SET_RESULT', {
            requestId,
            ok: true,
            sizeBytes: result.sizeBytes,
          });
        } catch (err) {
          send('APP_STORAGE_SET_RESULT', {
            requestId,
            ok: false,
            error: storageErrorMessage(err),
          });
        }
      }
    );
    return off;
  }, [onMessage, send, token, storageSetMutation]);

  // APP_STORAGE_DELETE → apps.storage.delete → APP_STORAGE_DELETE_RESULT.
  useEffect(() => {
    const off = onMessage<{ requestId?: unknown; key?: unknown } | undefined>(
      'APP_STORAGE_DELETE',
      async (raw) => {
        if (!raw || typeof raw.requestId !== 'string' || typeof raw.key !== 'string' || !token)
          return;
        const requestId = raw.requestId;
        try {
          const result = await storageDeleteMutation.mutateAsync({
            blockToken: token,
            key: raw.key,
          });
          send('APP_STORAGE_DELETE_RESULT', {
            requestId,
            ok: true,
            deleted: result.deleted,
          });
        } catch (err) {
          send('APP_STORAGE_DELETE_RESULT', {
            requestId,
            ok: false,
            deleted: false,
            error: storageErrorMessage(err),
          });
        }
      }
    );
    return off;
  }, [onMessage, send, token, storageDeleteMutation]);

  // APP_STORAGE_LIST → apps.storage.list → APP_STORAGE_LIST_RESULT.
  useEffect(() => {
    const off = onMessage<
      | {
          requestId?: unknown;
          prefix?: unknown;
          limit?: unknown;
          cursor?: unknown;
        }
      | undefined
    >('APP_STORAGE_LIST', async (raw) => {
      if (!raw || typeof raw.requestId !== 'string' || !token) return;
      const requestId = raw.requestId;
      try {
        const prefix = typeof raw.prefix === 'string' ? raw.prefix : undefined;
        const limit =
          typeof raw.limit === 'number' && Number.isFinite(raw.limit)
            ? Math.min(Math.max(Math.floor(raw.limit), 1), 200)
            : 50;
        const cursor = typeof raw.cursor === 'string' ? raw.cursor : undefined;
        const result = await trpcUtils.apps.storage.list.fetch({
          blockToken: token,
          prefix,
          limit,
          cursor,
        });
        send('APP_STORAGE_LIST_RESULT', {
          requestId,
          keys: result.keys.map((k) => ({
            key: k.key,
            updatedAt: k.updatedAt instanceof Date ? k.updatedAt.toISOString() : String(k.updatedAt),
          })),
          nextCursor: result.nextCursor,
        });
      } catch (err) {
        send('APP_STORAGE_LIST_RESULT', {
          requestId,
          keys: [],
          error: storageErrorMessage(err),
        });
      }
    });
    return off;
  }, [onMessage, send, token, trpcUtils]);

  // APP_STORAGE_QUOTA → apps.storage.getQuota → APP_STORAGE_QUOTA_RESULT.
  useEffect(() => {
    const off = onMessage<{ requestId?: unknown } | undefined>(
      'APP_STORAGE_QUOTA',
      async (raw) => {
        if (!raw || typeof raw.requestId !== 'string' || !token) return;
        const requestId = raw.requestId;
        try {
          const result = await trpcUtils.apps.storage.getQuota.fetch({ blockToken: token });
          send('APP_STORAGE_QUOTA_RESULT', {
            requestId,
            usedBytes: result.usedBytes,
            rowCount: result.rowCount,
            limitBytes: result.limitBytes,
            limitRows: result.limitRows,
          });
        } catch (err) {
          send('APP_STORAGE_QUOTA_RESULT', {
            requestId,
            usedBytes: 0,
            rowCount: 0,
            limitBytes: 0,
            limitRows: 0,
            error: storageErrorMessage(err),
          });
        }
      }
    );
    return off;
  }, [onMessage, send, token, trpcUtils]);

  // ── OPEN_RESOURCE_PICKER → RESOURCE_PICKER_RESULT (Design 1 host-chrome) ────
  //
  // Generalizes the model-slot OPEN_CHECKPOINT_PICKER (IframeHost) to the page
  // surface and widens it from Checkpoint-only to a typed allowlist (v1:
  // Checkpoint + LoRA only). The block asks the HOST to open its OWN native
  // ResourceSelectModal as host chrome; the viewer searches in host chrome (NOT
  // the iframe); the host posts back ONLY the single chosen resource. The
  // untrusted iframe NEVER receives a list, the search API, or the catalog — it
  // only ever learns about the one resource the user physically picked.
  //
  // This feeds the merged page-LoRA `additionalResources` plumbing: the block
  // puts a Checkpoint pick into body.modelVersionId and each LoRA pick into
  // body.additionalResources. The picker is DISCOVERY ONLY — every chosen ID is
  // re-validated server-side at estimate/submit by the page gate
  // (assertViewerCanGeneratePageResources) + the orchestrator belt. Nothing the
  // iframe says about a resource is trusted at spend time.
  //
  // The picker reuses the host's native ResourceSelectModal UNMODIFIED. The
  // block never sees the catalog or the search API — it only ever receives the
  // ONE resource the user physically picked (host chrome can't be enumerated by
  // the iframe). The real authorization boundary is the SERVER gate
  // (assertViewerCanGeneratePageResources) at estimate/submit, NOT the picker UI.
  //  - `canGenerate: true` (UX floor) + the spend-time re-gate (authoritative).
  //  - resourceType allowlist enforced in resolveResourcePickerRequest (pure,
  //    unit-tested): an unsupported type is DROPPED and the modal never opens.
  // NSFW-by-domain is inherited from the native modal's existing parent-context
  // browsing-level handling, exactly as the model checkpoint picker already
  // relies on.
  //
  // MEDIUM-2 (deferred — documented, NOT wired): that inherited handling is the
  // SITE-WIDE browsing level, where `blue` is mature. So on a blue (or green)
  // block — which generation clamps to SFW via `domainBrowsingCeiling` — the
  // picker UI can still SURFACE mature resources, an inconsistent SFW
  // experience. This is NOT an iframe leak: the RESOURCE_PICKER_RESULT below is
  // name/id-only (no thumbnails/meta), and every picked id is re-gated SFW
  // server-side at estimate/submit (assertViewerCanGeneratePageResources +
  // domainBrowsingCeiling off the RAW request color) before any spend.
  //
  // Why not wired here: `openResourceSelectModal`'s `ResourceSelectOptions`
  // (resource-select.types.ts) exposes NO browsing-level / sfwOnly / nsfw
  // constraint — only `canGenerate`, `resources`, `excludeIds`. NSFW filtering
  // is done purely client-side in the SHARED `ResourceHitList` via
  // `useApplyHiddenPreferences`, which defaults to the site-wide
  // `useBrowsingLevelDebounced()` context (the Meili query in
  // useResourceSelectFilters doesn't filter by browsing level at all). Passing a
  // block-SFW ceiling in would require adding a new option to
  // `ResourceSelectOptions`, threading it through `ResourceSelectProvider` /
  // `useResourceSelectContext`, and feeding it to that `useApplyHiddenPreferences`
  // call — i.e. modifying the shared modal's filtering internals (higher blast
  // radius, affects every generation-form picker), and even then the hook's
  // `isModerator && nsfwLevel===0` carve-out leaves gaps for the currently
  // mod-gated audience. Deferred as a follow-up in the same bucket as the
  // Phase-3 REST clamp; tracked in the PR body.
  //
  // requestId threads each pick so concurrent requests (e.g. a checkpoint pick
  // and a LoRA pick open back-to-back) never cross — the SDK hook resolves only
  // the RESOURCE_PICKER_RESULT whose requestId matches its own request.
  useEffect(() => {
    const off = onMessage<unknown>('OPEN_RESOURCE_PICKER', (raw) => {
      const req = resolveResourcePickerRequest(raw);
      if (!req) return; // invalid / unsupported type → drop, never open the modal
      const { requestId, resourceType, baseModelGroup } = req;

      // Normalize an optional family hint through getBaseModelGroup (accepts an
      // ecosystem key like 'Flux1' OR a baseModel name like 'Flux.1 D'). An
      // unresolved/empty baseModelGroup applies NO baseModel narrowing — the
      // modal emits the bare `type = <T>` clause, so it returns ALL resources of
      // that type (still gated by `canGenerate`), NOT a subset.
      // That's intentional and safe: the server is the authority on family
      // compatibility at spend (it family-checks the resources at submit), so an
      // incompatible pick is rejected there rather than being silently filtered
      // out of the picker here.
      const groupKey = baseModelGroup ? getBaseModelGroup(baseModelGroup) : null;
      const baseModels = groupKey ? getBaseModelsByGroup(groupKey) : [];

      let answered = false;
      openResourceSelectModal({
        title: resourceType === 'Checkpoint' ? 'Choose a checkpoint' : 'Choose a resource',
        options: {
          canGenerate: true,
          resources: [{ type: resourceType, baseModels }],
        },
        onSelect: (resource) => {
          answered = true;
          // Post back ONLY the narrow single-pick allowlist. Never spread the
          // full GenerationResource — no availability/hasAccess/early-access/
          // usageControl/minor/poi/sfwOnly/cover-image internals reach the
          // iframe, only what the block needs to build a body + display it.
          send('RESOURCE_PICKER_RESULT', {
            requestId,
            selected: {
              // GenerationResource.id is the modelVersionId at the wire.
              versionId: resource.id,
              modelId: resource.model.id,
              // Public display names of the user-chosen resource — the user
              // picked it, so surfacing its name is safe (mirrors the
              // CHECKPOINT_PICKER_RESULT projection in IframeHost.tsx).
              modelName: resource.model.name,
              versionName: resource.name,
              baseModel: resource.baseModel,
              modelType: resource.model.type,
            },
          });
        },
        onClose: () => {
          // Dialog dismiss fires after onSelect when the user picks (the modal
          // closes itself); only emit the "cancelled" result if onSelect never
          // ran. answered=true short-circuits so a pick isn't followed by a
          // spurious cancel.
          if (answered) return;
          send('RESOURCE_PICKER_RESULT', { requestId });
        },
      });
    });
    return off;
  }, [onMessage, send]);

  // ── OPEN_CHECKPOINT_PICKER → CHECKPOINT_PICKER_RESULT (dev:live↔prod parity) ─
  //
  // The SDK hook `useCheckpointPicker()` posts OPEN_CHECKPOINT_PICKER. The
  // model-slot host (IframeHost) handles it, AND the dev:live SDK host serves it
  // — but this PAGE host only ever handled the newer/wider OPEN_RESOURCE_PICKER,
  // so a page block calling `useCheckpointPicker()` had its request hit NO host
  // handler (gotcha-#73): the "Change model" button spun forever — no network
  // call, no error. Authors tested it working locally (dev:live serves it) then
  // it silently broke in prod. This handler MIRRORS IframeHost's so that hook
  // works identically on pages; it is purely additive (OPEN_RESOURCE_PICKER is
  // unchanged) and a deliberately narrow checkpoint-only superset of it.
  useEffect(() => {
    const off = onMessage<unknown>('OPEN_CHECKPOINT_PICKER', (raw) => {
      const req = resolveCheckpointPickerRequest(raw);
      if (!req) return; // missing / non-string requestId → drop, never open the modal
      const { requestId, baseModelGroup } = req;

      // Normalize the optional family hint through getBaseModelGroup (accepts an
      // ecosystem key like 'Flux1' OR a baseModel name like 'Flux.1 D'). Empty /
      // unresolved group → baseModels:[] → no checkpoints rather than all
      // families (matching IframeHost: "all" would include incompatible families
      // that 400 at submit).
      const groupKey = baseModelGroup ? getBaseModelGroup(baseModelGroup) : null;
      const baseModels = groupKey ? getBaseModelsByGroup(groupKey) : [];

      let answered = false;
      openResourceSelectModal({
        title: 'Choose a checkpoint',
        options: {
          canGenerate: true,
          resources: [{ type: 'Checkpoint', baseModels }],
        },
        onSelect: (resource) => {
          answered = true;
          // Same name/id-only projection IframeHost's CHECKPOINT_PICKER_RESULT
          // uses — the public display names of the user-picked resource plus the
          // body-building IDs; NO full GenerationResource spread, so no
          // availability/access/early-access/nsfw/poi/minor internals reach the
          // iframe.
          send('CHECKPOINT_PICKER_RESULT', {
            requestId,
            selected: {
              // GenerationResource.id is the modelVersionId at the wire.
              versionId: resource.id,
              modelId: resource.model.id,
              modelName: resource.model.name,
              versionName: resource.name,
              baseModel: resource.baseModel,
            },
          });
        },
        onClose: () => {
          // Dialog dismiss fires after onSelect when the user picks (the modal
          // closes itself); only emit the "closed without picking" result if
          // onSelect never ran. answered=true short-circuits so a pick isn't
          // followed by a spurious cancel.
          if (answered) return;
          send('CHECKPOINT_PICKER_RESULT', { requestId });
        },
      });
    });
    return off;
  }, [onMessage, send]);

  // ── SET_USER_CHECKPOINT → USER_CHECKPOINT_SET (fail-fast NACK on a page) ──────
  //
  // `useCheckpointPicker().persist(versionId)` posts SET_USER_CHECKPOINT and
  // AWAITS USER_CHECKPOINT_SET (it's a request, not fire-and-forget). The
  // model-slot host (IframeHost) handles it by writing `checkpoint_version_id`
  // into `block_user_settings` for the (blockInstance, viewer) row, AND the
  // dev:live SDK host serves it — so a block author who calls `persist()` sees
  // it resolve locally, then (before this handler existed) had the SAME call
  // hit NO page-host handler in prod: the persist promise hung to the SDK's
  // request timeout (gotcha-#73, the "spins forever, no network call, no
  // console error" class). This handler closes that silent hang.
  //
  // CRUCIAL: a page CANNOT persist a checkpoint override the way the model slot
  // can. The server proc `blocks.updateUserSettings` HARD-REQUIRES `modelId`
  // in the block-token ctx (it resolves a model-bound install via
  // resolveBlockInstance({ modelId, slotId, ... })). A PAGE token's ctx is
  // `{ slotId, entityType:'none' }` with NO modelId (isPageToken) — a page is
  // stateless and binds to no model — so driving updateUserSettings with the
  // page token would throw BAD_REQUEST ("block token lacks modelId context").
  // There is no page-scoped user-settings row to write into today.
  //
  // So rather than INVENT a persistence target (a guess), this replies with an
  // explicit, KNOWN-shape NACK: `USER_CHECKPOINT_SET { ok:false, error }`. That
  // is the exact reply type+shape `persist()` awaits (it throws the `error`
  // string when `ok:false`), so the block fails FAST and surfaces a clear
  // message instead of hanging. The page's checkpoint flow is the in-memory
  // OPEN_CHECKPOINT_PICKER result (above), which the block already holds — it
  // does not need a persisted override.
  //
  // OPEN DECISION for a human (documented in
  // claudedocs/app-blocks-host-handler-parity-2026-06-29.md): if pages should
  // ever persist a viewer checkpoint preference, that needs a NEW page-scoped
  // storage target (e.g. via the app-storage KV the page token already
  // authorises) + a server proc that doesn't demand modelId — out of scope
  // here. Until then a NACK is the correct, non-guessing behavior.
  useEffect(() => {
    const off = onMessage<{ requestId?: unknown } | undefined>('SET_USER_CHECKPOINT', (raw) => {
      // NOTE: `payload.versionId` is intentionally NOT read or validated here —
      // the page path always NACKs regardless of which checkpoint was requested
      // (there is no page-scoped persistence target), so the versionId is moot.
      // Mirror IframeHost's drop rule: a missing / non-string requestId can't be
      // answered (no correlation id), so drop it silently rather than reply.
      if (!raw || typeof raw.requestId !== 'string' || raw.requestId.length === 0) return;
      send('USER_CHECKPOINT_SET', {
        requestId: raw.requestId,
        ok: false,
        error: 'page blocks cannot persist a checkpoint override (no model binding)',
      });
    });
    return off;
  }, [onMessage, send]);

  const showIframe = status === 'loading' || status === 'ready';
  const isReady = status === 'ready';

  // #4: terminal-state fallback — render a BlockFallback message INSIDE the page
  // frame instead of a blank viewport. See pageBlockHostLogic.pageFallbackReason
  // for the status→reason mapping + the anti-spoof rationale.
  const fallbackReason = pageFallbackReason(status);

  // #4 Retry: re-attempt the load from a terminal fallback. The full re-arm in
  // one place so there's no stuck state and no timer leak across retries:
  //   1. Dispose any controller the terminal cleanup may not have torn down yet
  //      (defensive — the init effect's cleanup already disposes + nulls it when
  //      status left 'loading'; this guarantees no orphaned interval/timeout
  //      survives a retry).
  //   2. Reset the per-mount handshake/analytics guards so init re-fires and a
  //      successful retry re-emits exactly one impression.
  //   3. Bump `reloadNonce` → re-keys the <iframe> → React remounts it (fresh
  //      contentWindow), so the re-armed handshake talks to a clean frame.
  //   4. Flip status back to 'loading'. shouldStartInit then re-passes and the
  //      init effect (controllerRef now null) builds a NEW controller whose
  //      start() re-posts BLOCK_INIT and re-arms the readiness timeout — so a
  //      second failure routes back to the fallback (no stuck state), and a
  //      BLOCK_READY clears it (success-after-retry).
  // Only meaningful from a terminal state; a no-op while loading/ready (status
  // stays put, nonce churn is harmless but we still gate to avoid a spurious
  // iframe remount mid-handshake).
  //
  // AUTH-FAILURE branch (the HIGH this fix closes): the `error` (hard mint
  // failure) and `no_token` (token never arrived) terminals are AUTH failures —
  // the iframe never received a usable token. A local-only retry (reset +
  // reloadNonce) can NEVER recover them: the token is a PROP minted upstream by
  // useBlockToken (route), and `shouldStartInit` gates on `hasToken`. With
  // `token`/`tokenError` unchanged, the re-armed handshake just times out to the
  // SAME terminal again (the 15s dead-end). So for `error`/`no_token` we ALSO
  // call onRetryToken (= useBlockToken.refresh) to re-mint the token; the rotated
  // token flips the props, init re-fires, and a successful mint loads the block.
  // For `fatal`/`timeout` the token was fine — the block crashed or didn't ack —
  // so remount-only (no re-mint) is the right, unchanged behavior. refresh()
  // aborts any in-flight mint and the endpoint is rate-limited (60/min); Retry is
  // user-initiated, so no auto-retry loop is added.
  const handleRetry = useCallback(() => {
    const prior = statusRef.current;
    // Double-click no-op guard (mirrors the pre-fix gate): a Retry while the
    // status is already loading/ready does nothing — no re-mint, no remount.
    if (prior === 'loading' || prior === 'ready') return;
    // AUTH failures (`error`/`no_token`) need a token re-mint — the local reset
    // below alone can't change the upstream `token`/`tokenError` props. Fire it
    // BEFORE the local re-arm (the rotated token then flips props → init
    // re-fires). `fatal`/`timeout` are not auth failures → remount only.
    if (prior === 'error' || prior === 'no_token') onRetryToken?.();
    controllerRef.current?.dispose();
    controllerRef.current = null;
    initSentRef.current = false;
    blockRenderEmittedRef.current = false;
    setReloadNonce((n) => n + 1);
    setStatus('loading');
  }, [onRetryToken]);

  return (
    <Box
      style={{
        display: 'flex',
        flexDirection: 'column',
        // Full viewport under the global header. The host chrome sits on top;
        // the iframe fills the rest.
        height: '100%',
        minHeight: 'calc(100dvh - 60px)',
        width: '100%',
      }}
      data-testid="app-page-frame"
      data-block-instance-id={blockInstanceId}
      // #3/#6: surface the consent signal as an observable attribute. The page
      // token still mints with the granted subset (so the block loads — consent
      // is NOT terminal here), but a block requesting an ungranted consent-gated
      // scope drives its own REQUEST_CONSENT against the missing set. This makes
      // the host-known signal visible to the block frame / debugging rather than
      // silently swallowed.
      data-needs-consent={needsConsent ? 'true' : 'false'}
    >
      <AppBlockChrome blockInstanceId={blockInstanceId} appName={appName} slotId={PAGE_SLOT_ID} />
      {showIframe ? (
        // The iframe fills the remaining viewport. While the block is still
        // handshaking (status === 'loading', before BLOCK_READY), the surface
        // would otherwise be blank — the iframe is mounted but visually empty and
        // non-interactive (pointerEvents:none). Overlay a centered Loader on top
        // so the user sees a loading state instead of a blank page. The overlay
        // is gated purely on `status === 'loading'`: it unmounts the instant the
        // status machine leaves loading — on BLOCK_READY (→ ready) AND on every
        // terminal path (timeout / fatal / no_token / error, which also flip
        // `showIframe` to false and render the BlockFallback below) — so it can
        // never spin forever.
        <Box style={{ position: 'relative', flex: 1, display: 'flex' }}>
          <iframe
            // #4 Retry: re-key on `reloadNonce` so a retry UNMOUNTS + REMOUNTS
            // the iframe (fresh contentWindow), not just reloads its src — the
            // re-armed init handshake then talks to a clean frame.
            key={reloadNonce}
            ref={iframeRef}
            src={iframeSrc}
            sandbox={effectiveSandbox}
            referrerPolicy="no-referrer"
            // Sanitize the publisher-controlled appName for the iframe title too
            // (same sanitizer as the visible chrome + the loader aria-label), so
            // every appName-derived plain-text attribute is consistent. Falls
            // back to blockId when nothing legible remains.
            title={sanitizeAppChromeName(appName) || blockId}
            data-testid="app-page-iframe"
            data-block-instance-id={blockInstanceId}
            data-block-ready={isReady ? 'true' : 'false'}
            style={{
              flex: 1,
              display: 'block',
              width: '100%',
              border: 0,
              pointerEvents: isReady ? 'auto' : 'none',
            }}
          />
          {status === 'loading' && (
            <Center
              data-testid="app-page-loading"
              // Announce the loading state on the REGION, not just the graphic:
              // role="status" + aria-busy mark the overlay container as a live
              // busy region so a screen reader announces "loading" when it
              // appears (the bare <Loader> below only exposes a labeled graphic).
              role="status"
              aria-busy={true}
              aria-live="polite"
              style={{ position: 'absolute', inset: 0, background: 'var(--mantine-color-body)' }}
            >
              {/* Run the publisher-controlled appName through the SAME sanitizer
                  the visible chrome uses (sanitizeAppChromeName) so the accessible
                  name a screen reader reads can't carry control/bidi/zalgo
                  spoofing — consistency with AppBlockChrome, not a new gate. Falls
                  back to 'app' when nothing legible remains. */}
              <Loader aria-label={`Loading ${sanitizeAppChromeName(appName) || 'app'}`} />
            </Center>
          )}
        </Box>
      ) : fallbackReason ? (
        <Box style={{ flex: 1, padding: 'var(--mantine-spacing-md)' }} data-testid="app-page-fallback">
          <BlockFallback
            reason={fallbackReason}
            blockName={sanitizeAppChromeName(appName) || blockId}
            onRetry={handleRetry}
          />
        </Box>
      ) : null}
    </Box>
  );
}
