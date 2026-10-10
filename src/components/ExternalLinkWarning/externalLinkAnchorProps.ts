import type React from 'react';
import { openExternalLinkWarning } from '~/components/ExternalLinkWarning/openExternalLinkWarning';
import { externalLinkInterstitialHref } from '~/utils/external-link';

/**
 * Props that put the leaving-Civitai warning in front of an off-site anchor on every route out.
 *
 * The href is the `/leaving` page rather than the destination, so a middle-click, cmd-click or
 * copied link reaches the same warning a plain click opens in place. `onActivate` fires once per
 * activation, middle-click included.
 */
export function externalLinkAnchorProps(destination: string, onActivate?: () => void) {
  return {
    href: externalLinkInterstitialHref(destination),
    onClick: (e: React.MouseEvent<HTMLElement>) => {
      onActivate?.();
      if (e.ctrlKey || e.metaKey || e.shiftKey) return;
      e.preventDefault();
      openExternalLinkWarning(destination);
    },
    // Middle-click fires `auxclick`, not `click`. Narrowed to button 1 because right-click fires
    // it too.
    onAuxClick: (e: React.MouseEvent<HTMLElement>) => {
      if (e.button === 1) onActivate?.();
    },
  };
}
