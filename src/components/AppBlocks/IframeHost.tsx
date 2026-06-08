import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ActionIcon, Box, Group, Menu } from '@mantine/core';
import { IconApps, IconDots } from '@tabler/icons-react';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { BlockFallback } from './BlockFallback';
import { failureSnapshot } from './failureSnapshot';
import { resolveBuzzPurchaseRequest } from './openBuzzPurchaseGate';
import { resolveRequestSignIn } from './requestSignInGate';
import { intersectSandbox } from './sandbox';
import { usePostMessage } from './usePostMessage';
import type { BlockInitPayload, BlockInstall, ModelSlotContext, SlotContext } from './types';
import { dialogStore } from '~/components/Dialog/dialogStore';
import type { BuyBuzzModalProps } from '~/components/Modals/BuyBuzzModal';
import { openResourceSelectModal } from '~/components/Dialog/triggers/resource-select';
import { getBaseModelGroup, getBaseModelsByGroup } from '~/shared/constants/basemodel.constants';
import { trpc } from '~/utils/trpc';
import { deriveScopeFromInstanceId } from '~/server/schema/blocks/attribution.schema';

const BuyBuzzModal = dynamic(() => import('~/components/Modals/BuyBuzzModal'));
// Login flow for anonymous-conversion (REQUEST_SIGN_IN). SSR-disabled to match
// requireLogin()'s own dynamic import — LoginContent touches window/router.
const LoginModal = dynamic(() => import('~/components/Login/LoginModal'), { ssr: false });

// Hard cap on the suggested top-up amount a block can pre-fill in the
// BuyBuzzModal (security audit #10). Without this a malicious block could
// trick the user into a 10M-buzz purchase by sending `{suggestedAmount: 1e7}`.
const BUZZ_PURCHASE_AMOUNT_CAP = 50_000;

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

// Reduce a thrown tRPC error to a single short string the block can surface.
// TRPCClientError exposes `.message` which is already the server message
// (apps.storage.* throws with explicit code + message strings); everything
// else gets a generic fallback. Keep this conservative — the iframe is
// untrusted and we don't want to leak server stack traces.
function storageErrorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string' && message.length > 0) return message;
  }
  return 'storage request failed';
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
/**
 * Host-rendered trust frame around an app block. This lives in civitai-web
 * (the parent document), NOT inside the block iframe — so a third-party
 * block can't fake, restyle, or hide it. It's the user-facing safety
 * signal that says "this is a sandboxed app block, not native Civitai UI":
 * a thin top bar with the Civitai app-block badge plus a menu whose
 * "Manage apps" item routes to /apps/installed. Rendering it here (vs in
 * the sandboxed iframe) is the whole point — the trust boundary belongs to
 * the host. (Roadmap W7.)
 */
function AppBlockChrome() {
  return (
    <Group
      justify="space-between"
      gap="xs"
      px="xs"
      py={4}
      wrap="nowrap"
      data-testid="app-block-chrome"
      style={{
        borderBottom: '1px solid var(--mantine-color-default-border)',
        background: 'var(--mantine-color-default-hover)',
      }}
    >
      <Group gap={6} wrap="nowrap">
        {/* Icon only — the "App block" wordmark was dropped as redundant
            (the icon + the frame itself already signal it). aria-label keeps
            the provenance signal for screen readers. */}
        <IconApps size={14} stroke={1.5} aria-label="App block" />
      </Group>
      <Menu position="bottom-end" shadow="md" width={180}>
        <Menu.Target>
          <ActionIcon variant="subtle" color="gray" size="sm" aria-label="App block menu">
            <IconDots size={16} stroke={1.5} />
          </ActionIcon>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Label>App block</Menu.Label>
          <Menu.Item
            component={Link}
            href="/apps/installed"
            leftSection={<IconApps size={14} stroke={1.5} />}
          >
            Manage apps
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
    </Group>
  );
}

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

  // Effective Checkpoint after publisher-default ∪ viewer-override merge.
  // Anon viewers see publisher default; authenticated viewers see their
  // override if set. We wait for this to resolve before sending BLOCK_INIT
  // so the block never sees a stale `context.checkpoint`. Cached
  // server-side via the query's React Query layer.
  const effectiveCheckpointQuery = trpc.blocks.getEffectiveCheckpoint.useQuery(
    {
      blockInstanceId: install.blockInstanceId,
      // The resolver re-validates synthetic ids against (modelId, slotId).
      // modelCtx is partial-typed but in practice both fields are required
      // by the slot context shape ModelSlotContext mandates them.
      modelId: modelCtx.modelId ?? 0,
      slotId: (modelCtx.slotId ?? 'model.sidebar_top') as
        | 'model.sidebar_top'
        | 'model.below_images'
        | 'model.actions_extra',
    },
    {
      enabled: typeof modelCtx.modelId === 'number' && !!modelCtx.slotId,
      staleTime: 60_000,
    }
  );
  const effectiveCheckpoint = effectiveCheckpointQuery.data?.checkpoint ?? null;

  // Top showcase images for the bound model version. Used by the block to
  // render a carousel + auto-populate gen params from the user's pick.
  // Skip when context doesn't carry a modelVersionId (non-model slots);
  // a 5-min staleTime is fine since reactions move slowly within a session.
  const modelVersionId =
    typeof modelCtx.modelVersionId === 'number' ? modelCtx.modelVersionId : null;
  const showcaseQuery = trpc.blocks.getShowcaseImages.useQuery(
    { modelVersionId: modelVersionId ?? 0 },
    { enabled: modelVersionId != null, staleTime: 5 * 60_000 }
  );
  const showcaseImages = showcaseQuery.data ?? [];

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
    context: {
      ...context,
      // Merge in the resolved checkpoint so the block can render its
      // header ("Generating with: NAME") without an extra round-trip.
      checkpoint: effectiveCheckpoint,
      // Showcase images for the carousel — empty array when the query
      // returns no images or hasn't loaded yet (we don't block init on
      // showcase the way we do on checkpoint; the carousel can re-render
      // later when the query lands).
      showcaseImages,
    },
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
    // Wait for the effective checkpoint to resolve before init — otherwise
    // the block renders without a checkpoint label and re-mounts when the
    // query lands. `isLoading` is false even on error; the error path
    // still lets us init with `checkpoint: null` so the block isn't stuck.
    if (effectiveCheckpointQuery.isLoading) return;
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
    // Re-run when the effective-checkpoint query resolves so sendInit's
    // guard releases. Without this dep the effect doesn't fire after the
    // query lands, leaving the iframe stuck on the loading skeleton.
    sendInit();
    const t = setTimeout(() => {
      setStatus((current) => (current === 'loading' ? 'timeout' : current));
    }, BLOCK_READY_TIMEOUT_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, status, iframeLoaded, effectiveCheckpointQuery.isLoading]);

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
        raw && typeof raw === 'object' && 'height' in raw ? (raw as { height?: unknown }) : {};
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
      // M-7: only honor RESIZE_IFRAME once BLOCK_READY has landed. The iframe
      // is visible-but-non-interactive (pointerEvents:none) before ready and
      // pinned at minHeight, so an early RESIZE would let a pre-ready block
      // push the slot height around before the handshake completes.
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

  // Anonymous conversion: the block (rendered for a logged-out viewer from the
  // scope-free BLOCK_INIT context) asks the host to start the civitai login
  // flow when the user clicks an action that needs auth/money (e.g. Generate).
  // usePostMessage already pins origin + event.source; we additionally gate on
  // status === 'ready' (post-BLOCK_READY) so a pre-handshake block can't pop a
  // login modal before any interaction, matching the OPEN_BUZZ_PURCHASE posture.
  //
  // returnUrl: an untrusted same-origin path the block may supply (must begin
  // with a single '/', no protocol-relative '//', so it can't redirect off-site
  // after login). When absent or unsafe we fall through to undefined and
  // LoginModal defaults returnUrl to the current page (router.asPath).
  useEffect(() => {
    const off = onMessage<{ returnUrl?: unknown } | undefined>('REQUEST_SIGN_IN', (raw) => {
      const resolved = resolveRequestSignIn(status, raw);
      if (resolved == null) return; // not ready — drop (gate centralises the rules)
      dialogStore.trigger({
        component: LoginModal,
        props: {
          reason: 'image-gen',
          ...(resolved.returnUrl ? { returnUrl: resolved.returnUrl } : {}),
        },
      });
    });
    return off;
  }, [onMessage, status]);

  // SDK workflow bridge: receive SUBMIT/ESTIMATE/POLL requests from the block,
  // forward to blocks.* tRPC, echo the response back with matching requestId.
  // The block's transport (`sendTypedRequest`) correlates by requestId and
  // 30s-timeouts if we never reply — so every error path MUST still post a
  // response (failure-shape snapshot), not throw upward.
  const submitWorkflowMutation = trpc.blocks.submitWorkflow.useMutation();
  const estimateWorkflowMutation = trpc.blocks.estimateWorkflow.useMutation();
  const pollWorkflowMutation = trpc.blocks.pollWorkflow.useMutation();
  const cancelWorkflowMutation = trpc.blocks.cancelWorkflow.useMutation();

  useEffect(() => {
    const off = onMessage<{ requestId?: unknown; body?: unknown } | undefined>(
      'SUBMIT_WORKFLOW',
      async (raw) => {
        if (!raw || typeof raw.requestId !== 'string') return;
        const requestId = raw.requestId;
        try {
          const { snapshot } = await submitWorkflowMutation.mutateAsync({
            blockToken: token,
            // Schema-validated server-side; the host never trusts this shape.
            body: raw.body as never,
          });
          send('WORKFLOW_SUBMITTED', { requestId, snapshot });
        } catch (err) {
          send('WORKFLOW_SUBMITTED', {
            requestId,
            snapshot: failureSnapshot(err),
          });
        }
      }
    );
    return off;
  }, [onMessage, send, token, submitWorkflowMutation]);

  useEffect(() => {
    const off = onMessage<{ requestId?: unknown; body?: unknown } | undefined>(
      'ESTIMATE_WORKFLOW',
      async (raw) => {
        if (!raw || typeof raw.requestId !== 'string') return;
        const requestId = raw.requestId;
        try {
          const { snapshot } = await estimateWorkflowMutation.mutateAsync({
            blockToken: token,
            body: raw.body as never,
          });
          send('ESTIMATE_RESULT', { requestId, snapshot });
        } catch (err) {
          send('ESTIMATE_RESULT', {
            requestId,
            snapshot: failureSnapshot(err),
          });
        }
      }
    );
    return off;
  }, [onMessage, send, token, estimateWorkflowMutation]);

  useEffect(() => {
    const off = onMessage<{ requestId?: unknown; suggestedAmount?: unknown } | undefined>(
      'OPEN_BUZZ_PURCHASE',
      (raw) => {
        // M-BUZZMODAL: gate on BLOCK_READY (+ payload validity). A block can
        // post the instant the iframe loads — before the handshake, while it's
        // still visible-but-non-interactive (pointerEvents:none). Summoning the
        // money-spend modal pre-ready would let an untrusted block nag the user
        // before any interaction. resolveBuzzPurchaseRequest returns null
        // (silently dropped) when status !== 'ready' or the payload is bad.
        const requestId = resolveBuzzPurchaseRequest(status, raw);
        if (requestId == null || !raw) return; // !raw is implied by requestId != null; narrows for TS
        const rawAmount =
          typeof raw.suggestedAmount === 'number' && Number.isFinite(raw.suggestedAmount)
            ? raw.suggestedAmount
            : undefined;
        // Floor + clamp into [0, cap]; reject NaN/negative implicitly via
        // Number.isFinite above. The modal accepts undefined for "no
        // suggestion" so the user picks freely.
        const amount =
          rawAmount != null
            ? Math.min(Math.max(Math.floor(rawAmount), 0), BUZZ_PURCHASE_AMOUNT_CAP)
            : undefined;
        // Mutable flag flipped by onPurchaseSuccess; onClose reads it to
        // decide which result to post. The modal calls dialog.onClose first
        // and then onPurchaseSuccess after a successful purchase — but our
        // onClose fires last because it's tied to the dialog teardown, so
        // by the time it runs the flag reflects the final state.
        let purchased = false;
        // Derive attribution from the install context. The iframe never
        // supplies these fields itself — fabricating them server-side
        // (via props) is the only attribution path a malicious block
        // can't forge. Scope is resolved from the blockInstanceId
        // prefix; null means the substrate handed us an instanceId we
        // don't recognise, in which case we skip attribution and the
        // webhook treats it as a regular buzz purchase. Defensive — no
        // observed mints today produce an unknown prefix.
        const scope = deriveScopeFromInstanceId(install.blockInstanceId);
        const attribution = scope
          ? {
              appId: install.appId,
              appBlockId: install.appBlockId,
              blockInstanceId: install.blockInstanceId,
              scope,
              modelId: typeof modelCtx.modelId === 'number' ? modelCtx.modelId : undefined,
              // FIN-1: carry the slot so the server can re-validate the
              // instance via resolveBlockInstance (needs modelId + slotId).
              // Client-supplied + untrusted — a wrong slot just fails to
              // resolve server-side and the attribution is stripped.
              slotId: typeof modelCtx.slotId === 'string' ? modelCtx.slotId : undefined,
            }
          : undefined;
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
  }, [
    onMessage,
    send,
    status,
    install.appId,
    install.appBlockId,
    install.blockInstanceId,
    modelCtx.modelId,
  ]);

  // Checkpoint picker: the block fires OPEN_CHECKPOINT_PICKER with the
  // ecosystem group (e.g. 'Flux1') it wants restricted to. We open the
  // platform's existing ResourceSelectModal filtered to Checkpoints in that
  // family, then post the selection back via CHECKPOINT_PICKER_RESULT.
  // Empty `selected` means the user closed without picking — the block's
  // SDK promise resolves to `{ selected: undefined }`.
  useEffect(() => {
    const off = onMessage<
      { requestId?: unknown; baseModelGroup?: unknown; currentVersionId?: unknown } | undefined
    >('OPEN_CHECKPOINT_PICKER', (raw) => {
      if (!raw || typeof raw.requestId !== 'string') return;
      const requestId = raw.requestId;
      // The block may send either an ecosystem key ('Flux1') or a baseModel
      // name ('Flux.1 D'). Normalize through getBaseModelGroup — it accepts
      // both forms and returns the ecosystem key, which is what
      // getBaseModelsByGroup expects. Empty filter → no checkpoints at all
      // rather than all checkpoints, since "all" includes incompatible
      // families that would 400 at submit.
      const groupKey =
        typeof raw.baseModelGroup === 'string' ? getBaseModelGroup(raw.baseModelGroup) : null;
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
          // Dialog dismiss fires after onSelect when the user picks (the
          // modal closes itself); only emit the "closed without picking"
          // result if onSelect never ran. The 30s SDK timeout otherwise
          // races us either way — answered=true short-circuits.
          if (answered) return;
          send('CHECKPOINT_PICKER_RESULT', { requestId });
        },
      });
    });
    return off;
  }, [onMessage, send]);

  // Persist the viewer's chosen checkpoint via blocks.updateUserSettings.
  // The host owns the auth — the block never touches the block_user_settings
  // row directly. Setting versionId: null clears the override.
  const updateUserSettingsMutation = trpc.blocks.updateUserSettings.useMutation();
  useEffect(() => {
    const off = onMessage<{ requestId?: unknown; versionId?: unknown } | undefined>(
      'SET_USER_CHECKPOINT',
      async (raw) => {
        if (!raw || typeof raw.requestId !== 'string') return;
        const requestId = raw.requestId;
        const versionId =
          raw.versionId === null
            ? null
            : typeof raw.versionId === 'number'
            ? raw.versionId
            : undefined;
        if (versionId === undefined) {
          send('USER_CHECKPOINT_SET', {
            requestId,
            ok: false,
            error: 'versionId must be a number or null',
          });
          return;
        }
        try {
          await updateUserSettingsMutation.mutateAsync({
            blockToken: token,
            settings: { checkpoint_version_id: versionId },
          });
          // Refetch the effective checkpoint so a subsequent BLOCK_INIT
          // (after a hot remount) reflects the new value without a hard
          // page reload.
          effectiveCheckpointQuery.refetch();
          send('USER_CHECKPOINT_SET', { requestId, ok: true });
        } catch (err) {
          send('USER_CHECKPOINT_SET', {
            requestId,
            ok: false,
            error: err instanceof Error ? err.message : 'unknown',
          });
        }
      }
    );
    return off;
  }, [onMessage, send, token, updateUserSettingsMutation, effectiveCheckpointQuery]);

  useEffect(() => {
    const off = onMessage<{ requestId?: unknown; workflowId?: unknown } | undefined>(
      'POLL_WORKFLOW',
      async (raw) => {
        if (
          !raw ||
          typeof raw.requestId !== 'string' ||
          typeof raw.workflowId !== 'string' ||
          raw.workflowId.length === 0
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
          send('WORKFLOW_STATUS', {
            requestId,
            snapshot: failureSnapshot(err),
          });
        }
      }
    );
    return off;
  }, [onMessage, send, token, pollWorkflowMutation]);

  // CANCEL_WORKFLOW → blocks.cancelWorkflow (real server-side cancel on the
  // orchestrator). Mirrors the POLL_WORKFLOW handler; ownership is enforced
  // server-side by the viewer's orchestrator token. Echo back the canceled
  // snapshot (or a failure snapshot) on the matching requestId.
  useEffect(() => {
    const off = onMessage<{ requestId?: unknown; workflowId?: unknown } | undefined>(
      'CANCEL_WORKFLOW',
      async (raw) => {
        if (
          !raw ||
          typeof raw.requestId !== 'string' ||
          typeof raw.workflowId !== 'string' ||
          raw.workflowId.length === 0
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
          send('WORKFLOW_CANCELED', {
            requestId,
            snapshot: failureSnapshot(err),
          });
        }
      }
    );
    return off;
  }, [onMessage, send, token, cancelWorkflowMutation]);

  // App Blocks KV datastore (W4-v0). Five host-mediated handlers; the
  // iframe never sees the apps DB credentials. Every reply MUST come
  // back with the same requestId — the block-side hook times out at
  // 30s otherwise. Errors are reported as `error: <string>` on the
  // result payload so the hook can reject; we never throw upward and
  // strand the bridge.
  const trpcUtils = trpc.useUtils();
  const storageSetMutation = trpc.apps.storage.set.useMutation();
  const storageDeleteMutation = trpc.apps.storage.delete.useMutation();

  useEffect(() => {
    const off = onMessage<{ requestId?: unknown; key?: unknown } | undefined>(
      'APP_STORAGE_GET',
      async (raw) => {
        if (!raw || typeof raw.requestId !== 'string' || typeof raw.key !== 'string') return;
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

  useEffect(() => {
    const off = onMessage<{ requestId?: unknown; key?: unknown; value?: unknown } | undefined>(
      'APP_STORAGE_SET',
      async (raw) => {
        if (!raw || typeof raw.requestId !== 'string' || typeof raw.key !== 'string') return;
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

  useEffect(() => {
    const off = onMessage<{ requestId?: unknown; key?: unknown } | undefined>(
      'APP_STORAGE_DELETE',
      async (raw) => {
        if (!raw || typeof raw.requestId !== 'string' || typeof raw.key !== 'string') return;
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
      if (!raw || typeof raw.requestId !== 'string') return;
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

  useEffect(() => {
    const off = onMessage<{ requestId?: unknown } | undefined>(
      'APP_STORAGE_QUOTA',
      async (raw) => {
        if (!raw || typeof raw.requestId !== 'string') return;
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

  // FRAME-1: host trust frame wraps EVERY state — loading, ready, AND the
  // error/timeout/fatal/no-token fallbacks. Rendered here (around the iframe,
  // not inside it) so a block can't shed the "App block" chrome by never
  // sending BLOCK_READY (→ timeout) or by sending BLOCK_ERROR{fatal}. The
  // provenance label + "Manage apps" escape hatch stay present exactly when
  // something is going wrong.
  const framed = (children: ReactNode) => (
    <Box
      data-testid="app-block-frame"
      data-block-instance-id={install.blockInstanceId}
      style={{
        border: '1px solid var(--mantine-color-default-border)',
        borderRadius: 'var(--mantine-radius-md)',
        overflow: 'hidden',
      }}
    >
      <AppBlockChrome />
      {children}
    </Box>
  );

  // H-7: malformed manifest with empty iframe.src or invalid origin mounts
  // an about:blank that sits on the skeleton for 10s before timing out.
  // Short-circuit straight to the fatal fallback instead.
  if (!iframeSrc || !expectedOrigin) {
    return framed(<BlockFallback reason="fatal_block_error" blockName={install.manifest.name} />);
  }
  if (status === 'timeout') {
    return framed(<BlockFallback reason="timeout" blockName={install.manifest.name} />);
  }
  if (status === 'fatal') {
    return framed(<BlockFallback reason="fatal_block_error" blockName={install.manifest.name} />);
  }
  if (status === 'no_token') {
    return framed(<BlockFallback reason="token_error" blockName={install.manifest.name} />);
  }

  // CLS fix (Source B): collapse the hidden→shown iframe swap. The iframe is
  // rendered VISIBLE from the start, sized at `iframeHeight` (which starts at
  // the manifest minHeight — same as the loading skeleton), with
  // pointerEvents disabled until BLOCK_READY so a pre-ready block can't be
  // interacted with. The loading skeleton is overlaid ON TOP of the iframe at
  // the SAME minHeight (absolute-positioned), so there's exactly one
  // minHeight-tall box while loading and zero height delta when the skeleton
  // unmounts on ready. On READY the iframe grows from minHeight to the
  // reported content height — one bounded change (minHeight → content), not a
  // 0 → content jump.
  const isReady = status === 'ready';
  return framed(
    <div style={{ position: 'relative', width: '100%' }}>
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
        data-block-ready={isReady ? 'true' : 'false'}
        style={{
          display: 'block',
          width: '100%',
          height: iframeHeight,
          border: 0,
          // Block interaction until the block reports ready. Visual-only
          // change — the iframe already occupies its minHeight reserve so
          // there's no layout shift when it becomes interactive.
          pointerEvents: isReady ? 'auto' : 'none',
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
      {status === 'loading' && (
        <div style={{ position: 'absolute', inset: 0 }}>
          <BlockFallback
            reason="loading"
            blockName={install.manifest.name}
            minHeight={install.manifest.iframe?.minHeight ?? 200}
          />
        </div>
      )}
    </div>
  );
}
