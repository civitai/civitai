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
 * In v1 every approved block has `trustTier='unverified'`, so the dispatcher
 * always routes to IframeHost. The InlineHost code path is in the file tree
 * so v2 can light it up without a structural refactor.
 */
export function BlockHost({ blockInstall, slotContext }: BlockHostProps) {
  const { token, expiresAt, terminal, pending, missingScopes, domain, maxBrowsingLevel, refresh } =
    useBlockToken(blockInstall, slotContext);

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
  return (
    <IframeHost
      install={blockInstall}
      context={slotContext}
      token={token}
      expiresAt={expiresAt}
      missingScopes={missingScopes}
      domain={domain}
      maxBrowsingLevel={maxBrowsingLevel}
      onConsentGranted={() => {
        void refresh();
      }}
    />
  );
}
