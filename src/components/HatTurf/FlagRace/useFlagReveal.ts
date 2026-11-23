import { useMemo, useState } from 'react';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { Flags } from '~/shared/utils/flags';

export type HiddenFlagReason = 'preferences' | 'browsingLevel';

type FlagImage = { id: number; nsfwLevel?: number };

/**
 * For today's flags the viewer's hidden preferences took out (`hidden`): which ones only their own
 * hidden users, images or tags hid (`revealable`, from `ignoreViewerHidden`), which they may show
 * anyway for this page only, and which ones they have. A flag a creator's block or the browsing
 * level hides is never revealable.
 */
export function useFlagReveal<T extends FlagImage>(hidden: T[], revealable: FlagImage[]) {
  const browsingLevel = useBrowsingLevelDebounced();
  const [revealedIds, setRevealedIds] = useState<ReadonlySet<number>>(new Set());

  return useMemo(() => {
    const revealableIds = new Set(revealable.map((image) => image.id));
    const reasons = new Map<number, HiddenFlagReason | undefined>(
      hidden.map((image) => [
        image.id,
        revealableIds.has(image.id)
          ? 'preferences'
          : image.nsfwLevel && !Flags.intersects(image.nsfwLevel, browsingLevel)
          ? 'browsingLevel'
          : undefined,
      ])
    );
    const revealed = hidden.filter(
      (image) => revealedIds.has(image.id) && reasons.get(image.id) === 'preferences'
    );
    const revealedSet = new Set(revealed.map((image) => image.id));
    return {
      reasons,
      revealed,
      stillHidden: hidden.filter((image) => !revealedSet.has(image.id)),
      reveal: (id: number) => setRevealedIds((ids) => new Set(ids).add(id)),
    };
  }, [hidden, revealable, revealedIds, browsingLevel]);
}
