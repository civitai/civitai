import { describe, expect, it } from 'vitest';
import { hubExcludedFilterKeys } from '~/components/Filters/FeedFilters/HubFeedFilters';
import { mediaFilterKeys } from '~/components/Image/Filters/MediaFiltersDropdown';
import { hubFeedFiltersSchema } from '~/server/schema/user-hub.schema';

/**
 * A hub's filters live on the row, so every control the dropdown offers inside a
 * hub has to have somewhere to be stored. A control with no home is not a visible
 * failure — it applies for the session, then silently forgets itself on reload,
 * which reads as a bug in the hub rather than a missing field.
 *
 * The failure this guards is a NEW chip added to the dropdown: it would be neither
 * excluded here nor persistable, and nothing else would say so.
 */

// Stored in their own columns rather than in `metadata.filters`, so they are
// persistable without appearing in the schema below.
const HUB_COLUMNS = ['period', 'types'] as const;

describe('every hub filter control can be persisted', () => {
  const persistable = new Set<string>([...HUB_COLUMNS, ...Object.keys(hubFeedFiltersSchema.shape)]);

  it('has no offered control without a home', () => {
    const offered = mediaFilterKeys.filter((key) => !hubExcludedFilterKeys.includes(key));
    const homeless = offered.filter((key) => !persistable.has(key));

    expect(homeless).toEqual([]);
    // The guard on the guard: excluding everything would pass the assertion above
    // while leaving the hub with no filter menu at all.
    expect(offered.length).toBeGreaterThan(5);
  });

  it('excludes only keys the dropdown actually renders', () => {
    // A stale key in the exclusion list hides nothing and reads as deliberate.
    const unknown = hubExcludedFilterKeys.filter(
      (key) => !(mediaFilterKeys as readonly string[]).includes(key)
    );

    expect(unknown).toEqual([]);
  });
});
