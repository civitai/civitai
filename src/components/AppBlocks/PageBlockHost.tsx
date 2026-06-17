import { Box } from '@mantine/core';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BlockFallback } from './BlockFallback';
import { AppBlockChrome } from './IframeHost';
import { IframeInitController, shouldStartInit } from './iframeInitController';
import { grantedPageScopes, pageFallbackReason } from './pageBlockHostLogic';
import { resolveRequestConsent } from './requestConsentGate';
import { effectiveSandboxIsOpaque, intersectSandbox } from './sandbox';
import { usePostMessage } from './usePostMessage';
import type { BlockInitPayload, PageContext } from './types';
import { dialogStore } from '~/components/Dialog/dialogStore';

// Lazy-consent UI (REQUEST_CONSENT). Opened on demand when a logged-in viewer
// clicks an action whose consent-gated scope the page token is missing. Mirrors
// IframeHost's dynamic import (SSR-disabled).
const BlockConsentModal = dynamic(() => import('./BlockConsentModal'), { ssr: false });

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
  viewer: { id: number; username: string | null } | null;
  theme: 'light' | 'dark';
  /** Re-mint the page token after a consent grant so it carries the newly
   *  granted scopes (pushed to the iframe via TOKEN_REFRESH). Mirrors
   *  IframeHost.onConsentGranted → useBlockToken.refresh. */
  onConsentGranted?: () => void;
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
  viewer,
  theme,
  onConsentGranted,
}: PageBlockHostProps) {
  const router = useRouter();
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const initSentRef = useRef<boolean>(false);
  const controllerRef = useRef<IframeInitController | null>(null);
  const buildInitPayloadRef = useRef<() => BlockInitPayload>();

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
    }),
    [appId, blockId, blockInstanceId, buildContext, expiresAt, grantedScopes, token, viewer, theme]
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
      if (acked) controllerRef.current?.notifyReady();
    });
    return off;
  }, [onMessage]);

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

  const showIframe = status === 'loading' || status === 'ready';
  const isReady = status === 'ready';

  // #4: terminal-state fallback — render a BlockFallback message INSIDE the page
  // frame instead of a blank viewport. See pageBlockHostLogic.pageFallbackReason
  // for the status→reason mapping + the anti-spoof rationale.
  const fallbackReason = pageFallbackReason(status);

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
      <AppBlockChrome blockInstanceId={blockInstanceId} appName={appName} />
      {showIframe ? (
        <iframe
          ref={iframeRef}
          src={iframeSrc}
          sandbox={effectiveSandbox}
          referrerPolicy="no-referrer"
          title={appName || blockId}
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
      ) : fallbackReason ? (
        <Box style={{ flex: 1, padding: 'var(--mantine-spacing-md)' }} data-testid="app-page-fallback">
          <BlockFallback reason={fallbackReason} blockName={appName} />
        </Box>
      ) : null}
    </Box>
  );
}
