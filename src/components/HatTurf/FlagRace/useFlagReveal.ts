import { useMemo, useState } from 'react';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { Flags } from '~/shared/utils/flags';

export type HiddenFlagReason = 'preferences' | 'browsingLevel';

type FlagImage = { id: number; nsfwLevel?: number };

/**
 * Show anyway on the Flag Race row (#10115): only a `revealable` flag (see useRevealableImages) can be
 * shown. A flag hidden by a creator's block or the browsing level is never revealable.
 */
export function useFlagReveal<T extends FlagImage>(
  served: T[],
  kept: { id: number }[],
  revealable: { id: number }[]
) {
  const browsingLevel = useBrowsingLevelDebounced();
  const [revealedIds, setRevealedIds] = useState<ReadonlySet<number>>(new Set());

  return useMemo(() => {
    const keptIds = new Set(kept.map((image) => image.id));
    const hidden = served.filter((image) => !keptIds.has(image.id));
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
  }, [served, kept, revealable, revealedIds, browsingLevel]);
}
