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
  const { token, expiresAt, error, pending } = useBlockToken(blockInstall, slotContext);

  if (error) {
    return <BlockFallback reason="token_error" blockName={blockInstall.manifest.name} />;
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

  return (
    <IframeHost
      install={blockInstall}
      context={slotContext}
      token={token}
      expiresAt={expiresAt}
    />
  );
}
