import { Box } from '@mantine/core';
import { useRouter } from 'next/router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppBlockChrome } from './IframeHost';
import { IframeInitController, shouldStartInit } from './iframeInitController';
import { intersectSandbox } from './sandbox';
import { usePostMessage } from './usePostMessage';
import type { BlockInitPayload, PageContext } from './types';

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

type Status = 'loading' | 'ready' | 'timeout' | 'fatal' | 'no_token';

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
  viewer: { id: number; username: string | null } | null;
  theme: 'light' | 'dark';
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
  viewer,
  theme,
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

  const { send, onMessage } = usePostMessage({ iframeRef, expectedOrigin });

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
        // A page token carries only viewer-scoped ambient scopes (apps:storage:*)
        // — never money scopes. The block reads scopes off the wrapped token.
        scopes: [],
        expiresAt: expiresAt ?? '',
      },
      context: buildContext(),
      settings: { publisherSettings: {}, userSettings: {} },
      viewer,
      theme,
      renderMode: 'iframe',
    }),
    [appId, blockId, blockInstanceId, buildContext, expiresAt, token, viewer, theme]
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
    send('TOKEN_REFRESH', { token: { raw: token, scopes: [], expiresAt: expiresAt ?? '' } });
  }, [token, expiresAt, send]);

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
        token: { raw: token, scopes: [], expiresAt: expiresAt ?? '' },
      });
    });
    return off;
  }, [token, expiresAt, send, onMessage]);

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

  // SUSPEND on unmount.
  useEffect(() => {
    return () => {
      if (initSentRef.current) send('SUSPEND');
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Terminal-failure collapse — same anti-spoof posture as IframeHost: a failed
  // page block shows the trust chrome + nothing (never a fake page).
  const showIframe = status === 'loading' || status === 'ready';
  const isReady = status === 'ready';

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
    >
      <AppBlockChrome blockInstanceId={blockInstanceId} appName={appName} />
      {showIframe ? (
        <iframe
          ref={iframeRef}
          src={iframeSrc}
          sandbox={intersectSandbox(sandbox, trustTier)}
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
      ) : null}
    </Box>
  );
}
