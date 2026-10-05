import { BlockFallback } from './BlockFallback';
import { IframeHost } from './IframeHost';
import { useBlockToken } from './useBlockToken';
import type { BlockInstall, SlotContext } from './types';

interface BlockHostProps {
  blockInstall: BlockInstall;
  slotContext: SlotContext;
}

/**
 * Dispatches a single block install to the correct host implementation.
 *
 * ⚠️ RETRACTED (#5209): this used to claim "in v1 every approved block has
 * `trustTier='unverified'`", and the codebase itself refutes it. See
 * `~/server/services/blocks/app-cap-limits.constants.ts`, which records a live-DB
 * measurement from 2026-07-31: **3 rows at `trust_tier='internal'`** against 18
 * `unverified`. The tier is not uniform and never was.
 *
 * The dispatcher always routes to IframeHost regardless, because the InlineHost
 * path is not lit up yet — that is the real reason, and it is unrelated to the
 * tier. The InlineHost code path is in the file tree so v2 can light it up
 * without a structural refactor.
 *
 * Why the correction matters rather than being pedantry: `internal`/`verified`
 * tiers get `allow-same-origin` (`intersectSandbox`), so such a frame runs at a
 * REAL origin with cookies. Anyone reasoning about what a link, a popup or a
 * postMessage transport can do in a block frame gets the opposite answer for
 * those 3 rows, and the retracted sentence said there were none.
 */
export function BlockHost({ blockInstall, slotContext }: BlockHostProps) {
  const {
    token,
    expiresAt,
    kind,
    terminal,
    pending,
    missingScopes,
    // 🔴 THE MINT ALREADY REPORTED THIS AND NOTHING HERE READ IT. `useBlockToken`
    // has surfaced `needsConsent` since A6, but this dispatcher destructured every
    // sibling field and dropped this one — so the model slot's host had no
    // server-side verdict to key a consent affordance on, and its ONLY route back to
    // consent was the block choosing to send REQUEST_CONSENT. A field that exists on
    // a DTO is not a guard; a consumer BRANCHING on it is.
    needsConsent,
    domain,
    maxBrowsingLevel,
    refresh,
  } = useBlockToken(blockInstall, slotContext);

  // TERMINAL token-mint failure → collapse (render null, take no space) rather
  // than show a visible "authorization error" card. Matches the IframeHost
  // terminal-failure collapse (`hostRenderDecision`): an error card for a block
  // the viewer never asked for, on someone else's model page, is worse than
  // silence. The brief loading skeleton below is preserved.
  //
  // 🔴 GATE ON `terminal`, NOT `error`. This used to read `if (error) return null`,
  // which collapsed the slot on ANY mint failure — including a TRANSIENT
  // mid-session refresh blip. That unmounted IframeHost, destroying whatever the
  // user had in progress, and the eventual recovery REMOUNTED it: a fresh
  // BLOCK_INIT and a SECOND impression beacon for one logical view (the beacon's
  // emit-once guard is per IframeHost mount). `terminal` is true only once the
  // hook has exhausted its bounded automatic retries AND no usable token remains,
  // so a recoverable failure now keeps the block alive instead of erasing it.
  if (terminal) {
    return null;
  }
  if (pending || !token || !expiresAt) {
    return (
      <BlockFallback
        reason="loading"
        blockName={blockInstall.manifest.name}
        minHeight={blockInstall.manifest.iframe?.minHeight ?? 200}
      />
    );
  }

  // v1: always iframe. The canUseInline branch lives in InlineHost (stub).
  const canUseInline =
    (blockInstall.renderMode === 'inline' || blockInstall.manifest.renderMode === 'hybrid') &&
    blockInstall.trustTier !== 'unverified';

  if (canUseInline) {
    // Importing InlineHost statically would explode v1 because it throws on
    // mount. Keep the v2 stub usable via dynamic import; in v1 we never get here.
    throw new Error('InlineHost is not enabled in v1');
  }

  // A6 lazy consent: the block renders in FULL even when the viewer hasn't
  // granted every consent-gated scope. We pass `missingScopes` so IframeHost
  // (a) trims the wrapped token's `scopes` to what was actually signed (so the
  // block's "do I have ai:write:budgeted?" check is accurate) and (b) handles
  // the block's REQUEST_CONSENT — opening the consent modal on the action click
  // (e.g. Generate), not on load. On grant we re-mint via `refresh` so the new
  // scopes reach the iframe through TOKEN_REFRESH and the block retries.
  //
  // (c) — and `needsConsent` so the host can offer consent WITHOUT the block asking.
  // (a) and (b) both depend on the block doing something: (a) only informs it, and
  // (b) only fires if it calls `requestGrants`. Neither is a route the viewer has
  // when the block never asks — an older SDK, or block UI that simply does not make
  // the call. This is the term that makes the host recoverable on its own.
  return (
    <IframeHost
      install={blockInstall}
      context={slotContext}
      token={token}
      expiresAt={expiresAt}
      tokenKind={kind}
      missingScopes={missingScopes}
      needsConsent={needsConsent}
      domain={domain}
      maxBrowsingLevel={maxBrowsingLevel}
      onConsentGranted={() => {
        void refresh();
      }}
    />
  );
}
