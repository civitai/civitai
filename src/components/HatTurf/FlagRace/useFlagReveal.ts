import { useMemo, useState } from 'react';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import { Flags } from '~/shared/utils/flags';

export type HiddenFlagReason = 'preferences' | 'browsingLevel';

type FlagImage = { id: number; nsfwLevel?: number };

/**
 * For today's flags the viewer's hidden preferences took out: which one only their own hidden users,
 * images or tags hide (they may show it anyway, for this page only), and which ones are revealed.
 * A flag a creator's block or the browsing level hides is never revealable.
 */
export function useFlagReveal<T extends FlagImage>(hidden: T[]) {
  const browsingLevel = useBrowsingLevelDebounced();
  const { items: showable } = useApplyHiddenPreferences({
    type: 'images',
    data: hidden as never,
    ignoreViewerHidden: true,
  });
  const [revealedIds, setRevealedIds] = useState<ReadonlySet<number>>(new Set());

  return useMemo(() => {
    const showableIds = new Set((showable as FlagImage[]).map((image) => image.id));
    const reasons = new Map<number, HiddenFlagReason | undefined>(
      hidden.map((image) => [
        image.id,
        showableIds.has(image.id)
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
  }, [hidden, showable, revealedIds, browsingLevel]);
}
