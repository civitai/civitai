import type { UpsertUserHubInput } from '~/server/schema/user-hub.schema';
import { hubFeedFiltersSchema } from '~/server/schema/user-hub.schema';
import { MetricTimeframe } from '~/shared/utils/prisma/enums';
import type { MediaType } from '~/shared/utils/prisma/enums';

/**
 * What a media-filter change saves. Extracted so the absence of `sort` is something a
 * test can assert: the value the filter menu has to hand is the RESOLVED one, so
 * sending it would persist a clamped Most Reactions over the owner's stored Newest,
 * for good, the first time a viewer without NSFW touched any filter.
 */
export function buildHubFilterSave(
  hubId: number,
  next: Record<string, unknown>
): UpsertUserHubInput {
  return {
    id: hubId,
    // Clear omits `period` to mean "back to the default"; falling back to the hub's
    // current value would leave the one filter Clear names.
    period: (next.period ?? MetricTimeframe.AllTime) as MetricTimeframe,
    mediaTypes: (next.types ?? []) as MediaType[],
    filters: hubFeedFiltersSchema.parse(next),
  };
}
