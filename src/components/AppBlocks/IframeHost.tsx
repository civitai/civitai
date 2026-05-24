import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BlockFallback } from './BlockFallback';
import { usePostMessage } from './usePostMessage';
import type {
  BlockInitPayload,
  BlockInstall,
  ModelSlotContext,
  SlotContext,
} from './types';

interface IframeHostProps {
  install: BlockInstall;
  context: SlotContext;
  token: string;
  /** ISO-8601 — surfaces in BLOCK_INIT.token.expiresAt for the iframe. */
  expiresAt: string;
}

const BLOCK_READY_TIMEOUT_MS = 10_000;
// If the token never arrives within this window, surface a token_error so the
// user isn't stuck behind an indefinite skeleton.
const TOKEN_WAIT_TIMEOUT_MS = 15_000;
// Hard ceiling on iframe height — independent of the manifest's maxHeight.
// A malicious or buggy block sending {height: 1e9} on RESIZE_IFRAME would
// otherwise OOM the tab. 8000px is well above any legitimate block.
const HARD_HEIGHT_CEILING = 8_000;

type Status = 'loading' | 'ready' | 'timeout' | 'fatal' | 'no_token';

// H-6: client-side allowlist intersection. The server validator already
// gates sandbox tokens by trust tier, but a future server-side bypass or
// stored-XSS in the manifest column would otherwise let dangerous tokens
// reach the iframe attribute. This is the second wall.
const ALLOWED_SANDBOX_TOKENS = new Set([
  'allow-scripts',
  'allow-forms',
  'allow-popups',
  'allow-modals',
  'allow-pointer-lock',
  'allow-downloads',
]);

// Auto-injected for trusted publishers. Unverified blocks still get an
// opaque origin; verified/internal blocks need their real origin so the
// host's explicit-targetOrigin postMessage + host-side origin allowlist
// work as designed.
const TRUSTED_TIERS: ReadonlySet<string> = new Set(['internal', 'verified']);

function intersectSandbox(raw: string | undefined, trustTier: string): string {
  const declared = (raw ?? '').split(/\s+/).filter((t) => ALLOWED_SANDBOX_TOKENS.has(t));
  const tokens = new Set(declared.length > 0 ? declared : ['allow-scripts']);
  if (TRUSTED_TIERS.has(trustTier)) tokens.add('allow-same-origin');
  return Array.from(tokens).join(' ');
}

/**
 * Renders a block inside a sandboxed iframe and drives the postMessage
 * lifecycle. Implements the @civitai/app-sdk/blocks v1 contract — see
 * docs/features/app-blocks.md "BLOCK_INIT contract" for the payload shape.
 *
 *   1. iframe `load` event → if token already in state, send BLOCK_INIT.
 *      Otherwise wait. Both conditions must hold before BLOCK_INIT fires.
 *   2. Wait for BLOCK_READY (≤10s). Timeout shows BlockFallback("timeout").
 *   3. BLOCK_ERROR with `fatal: true` shows BlockFallback("fatal_block_error").
 *   4. RESIZE_IFRAME updates the iframe height, clamped to manifest bounds.
 *   5. Page-visibility change drives SUSPEND / RESUME.
 *   6. Token rotation triggers TOKEN_REFRESH (host-pushed) with the new
 *      wrapped token. REQUEST_TOKEN from the iframe is answered with
 *      TOKEN_REFRESH_RESPONSE so block-initiated refreshes also work.
 *   7. Unmount sends SUSPEND and removes listeners.
 *
 * Origin security: BLOCK_INIT is posted to `new URL(manifest.iframe.src).origin`
 * (explicit target, never "*"). Incoming messages from other origins are dropped.
 */
export function IframeHost({ install, context, token, expiresAt }: IframeHostProps) {
  // Treat the slot context as ModelSlotContext when the optional viewer/theme
  // fields are present; otherwise default conservatively. ModelSlotContext is
  // the only producer in v1 (ModelVersionDetails); other surfaces use the
  // base SlotContext shape.
  const modelCtx = context as Partial<ModelSlotContext>;
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [iframeHeight, setIframeHeight] = useState<number>(
    install.manifest.iframe?.minHeight ?? 200
  );
  // H-1 (audit): tracked as state, not a ref. The BLOCK_READY timeout
  // effect's deps are [token, status, iframeLoaded] — using a ref meant the
  // effect didn't re-run when the iframe's onLoad fired *after* the token
  // had already resolved. That left no 10s timeout armed, so a silent block
  // would sit on an indefinite skeleton.
  const [iframeLoaded, setIframeLoaded] = useState<boolean>(false);
  const initSentRef = useRef<boolean>(false);

  const iframeSrc = install.manifest.iframe?.src ?? '';
  const expectedOrigin = useMemo(() => {
    try {
      return new URL(iframeSrc).origin;
    } catch {
      return '';
    }
  }, [iframeSrc]);

  const { send, onMessage } = usePostMessage({ iframeRef, expectedOrigin });

  // applyHeight is wrapped so the postMessage subscribers keep a stable
  // reference even though install.manifest is stable across renders.
  //
  // Three layers of height defense:
  //   1. isFinite + positive guard — rejects NaN, Infinity, negatives.
  //   2. manifest.maxHeight (publisher's stated ceiling), if set.
  //   3. HARD_HEIGHT_CEILING — independent backstop in case maxHeight is
  //      null (allowed by the manifest validator) and the block sends a
  //      huge number. This is the OOM guard.
  const applyHeight = useCallback(
    (h: unknown) => {
      if (typeof h !== 'number' || !Number.isFinite(h) || h <= 0) return;
      const min = install.manifest.iframe?.minHeight ?? 200;
      const max = install.manifest.iframe?.maxHeight;
      let next = Math.max(h, min);
      if (typeof max === 'number') next = Math.min(next, max);
      next = Math.min(next, HARD_HEIGHT_CEILING);
      setIframeHeight(next);
    },
    [install.manifest.iframe?.minHeight, install.manifest.iframe?.maxHeight]
  );

  // Mirror the server's buzzBudget resolution (publisher's
  // buzz_budget_per_gen → manifest default → 10, capped at 1000) so blocks
  // can display the budget without a JWT decode. Only present when the
  // manifest declares ai:write:budgeted; absent otherwise.
  const buzzBudget = useMemo<number | undefined>(() => {
    const scopes = install.manifest.scopes ?? [];
    if (!scopes.includes('ai:write:budgeted')) return undefined;
    const raw = install.publisherSettings?.buzz_budget_per_gen;
    const candidate = typeof raw === 'number' && Number.isFinite(raw) ? raw : 10;
    if (candidate <= 0) return undefined;
    return Math.min(candidate, 1000);
  }, [install.manifest.scopes, install.publisherSettings]);

  const buildInitPayload = (): BlockInitPayload => ({
    blockInstanceId: install.blockInstanceId,
    blockId: install.blockId,
    appId: install.appId,
    token: {
      raw: token,
      scopes: install.manifest.scopes ?? [],
      expiresAt,
      ...(buzzBudget !== undefined ? { buzzBudget } : {}),
    },
    context,
    settings: {
      publisherSettings: install.publisherSettings,
      // v1 has no per-viewer settings yet (Phase 2 wires the
      // block_user_settings table); ship empty so the SDK contract is
      // stable across versions.
      userSettings: {},
    },
    viewer:
      typeof modelCtx.viewerUserId === 'number'
        ? {
            id: modelCtx.viewerUserId,
            username: modelCtx.viewerUsername ?? null,
            status: modelCtx.viewerStatus ?? 'active',
          }
        : null,
    theme: modelCtx.theme ?? 'light',
    renderMode: install.renderMode,
  });

  const sendInit = () => {
    if (initSentRef.current) return;
    if (!iframeLoaded || !token) return;
    initSentRef.current = true;
    send('BLOCK_INIT', buildInitPayload());
  };

  // H-3: when the token rotates after BLOCK_INIT (every ~13min), send a
  // TOKEN_REFRESH message so the iframe can pick up the new credential
  // without us tearing down the element. useBlockToken now keeps the
  // iframe mounted across refreshes; this hook pushes the new value.
  //
  // Payload mirrors the BLOCK_INIT.token wrapped shape so the iframe can
  // replace its `token` reference with one call. Subsequent calls reuse
  // the same SDK schema.
  useEffect(() => {
    if (!initSentRef.current || !token) return;
    send('TOKEN_REFRESH', {
      token: {
        raw: token,
        scopes: install.manifest.scopes ?? [],
        expiresAt,
        ...(buzzBudget !== undefined ? { buzzBudget } : {}),
      },
    });
  }, [token, expiresAt, buzzBudget, install.manifest.scopes, send]);

  // SDK request-driven flow: iframe asks for the current token (e.g. right
  // before an expensive call) and we reply with the latest wrapped value.
  // Pairs with the push flow above — both produce the same payload shape.
  useEffect(() => {
    const off = onMessage<{ requestId?: string } | undefined>('REQUEST_TOKEN', (raw) => {
      if (!token || !initSentRef.current) return;
      const requestId =
        raw && typeof raw === 'object' && typeof raw.requestId === 'string'
          ? raw.requestId
          : undefined;
      send('TOKEN_REFRESH_RESPONSE', {
        ...(requestId ? { requestId } : {}),
        token: {
          raw: token,
          scopes: install.manifest.scopes ?? [],
          expiresAt,
          ...(buzzBudget !== undefined ? { buzzBudget } : {}),
        },
      });
    });
    return off;
  }, [token, expiresAt, buzzBudget, install.manifest.scopes, send, onMessage]);

  useEffect(() => {
    if (status !== 'loading') return;
    if (!iframeLoaded || !token) return;
    sendInit();
    const t = setTimeout(() => {
      setStatus((current) => (current === 'loading' ? 'timeout' : current));
    }, BLOCK_READY_TIMEOUT_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, status, iframeLoaded]);

  // Independent token-wait timer: catches the case where the iframe loads but
  // the token never resolves (e.g. /api/v1/block-tokens repeatedly 5xx-ing).
  useEffect(() => {
    if (status !== 'loading' || token) return;
    const t = setTimeout(() => {
      setStatus((current) => (current === 'loading' && !token ? 'no_token' : current));
    }, TOKEN_WAIT_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [status, token]);

  useEffect(() => {
    const off = onMessage<unknown>('BLOCK_READY', (raw) => {
      // Validate the shape — payload comes from cross-origin iframe code and
      // is functionally untyped. Reject anything that isn't {height?:number}.
      const payload =
        raw && typeof raw === 'object' && 'height' in raw
          ? (raw as { height?: unknown })
          : {};
      // H-11: only honor the height when the transition actually lands on
      // 'ready'. setStatus's updater returns the *prior* status — we use
      // the next status (which the updater computed) to gate the height
      // application. Late BLOCK_READY arriving after timeout/fatal/no_token
      // must not nudge the iframe height.
      let appliedReady = false;
      setStatus((current) => {
        if (current === 'loading') {
          appliedReady = true;
          return 'ready';
        }
        return current;
      });
      if (appliedReady) applyHeight(payload.height);
    });
    return off;
  }, [onMessage, applyHeight]);

  useEffect(() => {
    const off = onMessage<unknown>('RESIZE_IFRAME', (raw) => {
      if (!raw || typeof raw !== 'object' || !('height' in raw)) return;
      // M-7: only honor RESIZE_IFRAME once BLOCK_READY has landed. Iframe is
      // display:none until ready so visual impact is nil today, but the
      // contract drift will bite the next person who renames the gate.
      if (status !== 'ready') return;
      applyHeight((raw as { height?: unknown }).height);
    });
    return off;
  }, [onMessage, applyHeight, status]);

  useEffect(() => {
    const off = onMessage<unknown>('BLOCK_ERROR', (raw) => {
      if (raw && typeof raw === 'object' && (raw as { fatal?: unknown }).fatal === true) {
        setStatus((current) => (current === 'loading' || current === 'ready' ? 'fatal' : current));
      }
    });
    return off;
  }, [onMessage]);

  useEffect(() => {
    if (status !== 'ready') return;
    const handler = () => {
      if (document.visibilityState === 'visible') send('RESUME');
      else send('SUSPEND');
    };
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, [status, send]);

  useEffect(() => {
    return () => {
      if (initSentRef.current) send('SUSPEND');
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // H-7: malformed manifest with empty iframe.src or invalid origin mounts
  // an about:blank that sits on the skeleton for 10s before timing out.
  // Short-circuit straight to the fatal fallback instead.
  if (!iframeSrc || !expectedOrigin) {
    return <BlockFallback reason="fatal_block_error" blockName={install.manifest.name} />;
  }
  if (status === 'timeout') {
    return <BlockFallback reason="timeout" blockName={install.manifest.name} />;
  }
  if (status === 'fatal') {
    return <BlockFallback reason="fatal_block_error" blockName={install.manifest.name} />;
  }
  if (status === 'no_token') {
    return <BlockFallback reason="token_error" blockName={install.manifest.name} />;
  }

  return (
    <>
      {status === 'loading' && (
        <BlockFallback
          reason="loading"
          blockName={install.manifest.name}
          minHeight={install.manifest.iframe?.minHeight ?? 200}
        />
      )}
      <iframe
        ref={iframeRef}
        src={iframeSrc}
        // H-6: client-side sandbox allowlist intersection — defense in depth
        // against a future server-side bypass that lets a dangerous token
        // reach the iframe attribute.
        sandbox={intersectSandbox(install.manifest.iframe?.sandbox, install.trustTier)}
        // H-6: no-referrer keeps the model page URL out of the publisher's
        // server logs.
        referrerPolicy="no-referrer"
        title={install.manifest.name ?? install.blockId}
        data-testid="block-iframe"
        data-block-instance-id={install.blockInstanceId}
        data-block-ready={status === 'ready' ? 'true' : 'false'}
        style={{
          display: status === 'ready' ? 'block' : 'none',
          width: '100%',
          height: iframeHeight,
          border: 0,
        }}
        onLoad={() => {
          // H-1: setState (not ref) so the BLOCK_READY timeout effect
          // re-runs once both token AND iframeLoaded are true. sendInit
          // still fires synchronously here for the common case where
          // the token resolved first.
          setIframeLoaded(true);
          sendInit();
        }}
      />
    </>
  );
}
