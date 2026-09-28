import type { ReactNode } from 'react';
import { ViewerBrowsingLevelScope } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { BrowsingSettingsAddonsProvider } from '~/providers/BrowsingSettingsAddonsProvider';

/**
 * Search lists other people's content, so it follows the viewer, not the page: the homepage's PG
 * override wraps the header search too.
 *
 * 🔴 The nested addons provider is not optional. The addons (`disableMinor`, `disablePoi`, excluded
 * tags) are resolved from the browsing level, and the outer provider resolved them at the PAGE
 * level. Without re-resolving here, search widens to the viewer's NSFW levels while keeping the
 * PG-level addons, which switch the minor and POI exclusions off.
 */
export function SearchBrowsingScope({ children }: { children: ReactNode }) {
  return (
    <ViewerBrowsingLevelScope>
      <BrowsingSettingsAddonsProvider>{children}</BrowsingSettingsAddonsProvider>
    </ViewerBrowsingLevelScope>
  );
}
