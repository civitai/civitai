import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import { useImageQueryParams } from '~/components/Image/image.utils';
import type { TagChipRowItem } from '~/components/Tags/TagChipRow';
import { TagChipRow } from '~/components/Tags/TagChipRow';
import { ActiveTagFilter } from '~/components/Tags/ActiveTagFilter';
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
 * The `All` chip is not decoration — it is what widens a `?tags=` deep link back out on
 * these feeds. It clears whatever is in `?tags=`, including ids that are not chips on
 * this bar.
 *
 * So `ActiveTagFilter` stands in wherever that chip is NOT on the page — the flag being
 * off, and the chip row being held for its loading reservation, which is also the state a
 * failed chip-list fetch leaves the bar in permanently. Neither may take the only escape
 * hatch from a `?tags=` deep link with it (ClickUp 868kuq3jk).
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

  // `!!` is load-bearing: FeatureAccess is sparse, so an off flag is `undefined` rather
  // than `false`, and react-query reads `enabled: undefined` as enabled.
  const { data, isLoading: chipsLoading } = trpc.tag.getFeedTagBar.useQuery(undefined, {
    enabled: !!features.feedTagBar,
  });
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

  if (!features.feedTagBar) return <ActiveTagFilter tagIds={tagIds} />;

  // Holding the row until preferences resolve keeps a tag the viewer has personally
  // hidden from flashing as a chip: the chip list is edge-cached and the preferences are
  // a per-user fetch, so the list usually wins the race. `TagChipRow` draws the height
  // reservation and NO chips in that state — the All chip included.
  const chipsHeld = loadingPreferences || !tags.length;

  // SETTLED and still empty — a failed or empty chip fetch, which is permanent, not the
  // in-flight state. `chipsHeld` alone would put the control on screen for every viewer's
  // first paint (`loadingPreferences` is the preferences query's `isLoading`, true on
  // mount for everyone) and take it away again a moment later.
  const chipsGone = !chipsLoading && !loadingPreferences && !tags.length;

  return (
    <TagChipRow
      items={tags.map((tag) => ({ id: tag.id, label: tag.name }))}
      activeId={activeId}
      onSelect={handleSelect}
      onClear={handleClear}
      loading={chipsHeld}
      // Inside the reservation, so standing in for the chips costs no extra height.
      // Uninstrumented on purpose: `Feed_TagBar_Click` measures the BAR, and the bar's
      // fate is being decided on that series (868kv1b9m). Counting a press of a control
      // that appears only when the bar has no chips would inflate the number the decision
      // reads.
      placeholder={chipsGone ? <ActiveTagFilter tagIds={tagIds} /> : null}
    />
  );
}
