import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import { useImageQueryParams } from '~/components/Image/image.utils';
import type { TagChipRowItem } from '~/components/Tags/TagChipRow';
import { TagChipRow } from '~/components/Tags/TagChipRow';
import { useTrackEvent } from '~/components/TrackView/track.utils';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { trpc } from '~/utils/trpc';

type FeedTagBarFeed = 'images' | 'videos';

/**
 * Single-select tag row for `/images` and `/videos`, writing `?tags=<id>`.
 *
 * Single-select rather than the ctrl-click stacking the old `TagScroller` had: two chips
 * is an AND across tags, which lands on an empty feed for most pairs here, and it was
 * undiscoverable anyway.
 *
 * The `All` chip is not decoration — it is the only UI on these feeds that can widen a
 * `?tags=` deep link back out (`ActiveTagFilter`, written for that job, is mounted
 * nowhere; ClickUp 868kuq3jk). It clears whatever is in `?tags=`, including ids that are
 * not chips on this bar.
 */
export function ImageFeedTagBar({ feed }: { feed: FeedTagBarFeed }) {
  const { trackAction } = useTrackEvent();
  const features = useFeatureFlags();

  // The same hook the feed itself filters through (`useImageFilters` → `query.tags`).
  // Reading `router.query` directly here instead would give the chips and the feed two
  // different parsers for one param, and the symptom of them drifting is a chip that
  // looks unselected while the feed is filtered.
  const { query, replace } = useImageQueryParams();
  const tagIds = query.tags ?? [];

  const { data } = trpc.tag.getFeedTagBar.useQuery(undefined, { enabled: features.feedTagBar });
  const { items: tags, loadingPreferences } = useApplyHiddenPreferences({
    type: 'tags',
    data,
  });

  // A chip is active only when it is the sole filter — anything else came from a deep
  // link this bar cannot represent, and lighting one chip of several would misdescribe it.
  const activeId = tagIds.length === 1 ? tagIds[0] : undefined;

  const emit = (item: { id: number; name: string } | undefined) =>
    trackAction({
      type: 'Feed_TagBar_Click',
      details: {
        feed,
        tag: item?.name ?? null,
        tagId: item?.id ?? null,
        action: item ? 'select' : 'clear',
      },
    }).catch(() => undefined);

  const handleSelect = (item: TagChipRowItem) => {
    const id = item.id as number;
    const active = activeId === id;
    emit(active ? undefined : { id, name: item.label });
    replace({ tags: active ? [] : [id] });
  };

  const handleClear = () => {
    emit(undefined);
    replace({ tags: [] });
  };

  if (!features.feedTagBar) return null;

  return (
    <TagChipRow
      items={tags.map((tag) => ({ id: tag.id, label: tag.name }))}
      activeId={activeId}
      onSelect={handleSelect}
      onClear={handleClear}
      // Holding the row until preferences resolve keeps a tag the viewer has personally
      // hidden from flashing as a chip: the chip list is edge-cached and the preferences
      // are a per-user fetch, so the list usually wins the race.
      loading={loadingPreferences || !tags.length}
    />
  );
}
