import type { dbRead } from '~/server/db/client';
import { getModelWithheldImageIds } from '~/server/services/collection-cover-visibility';
import {
  getReportListedHiddenImageIds,
  SIGNED_OUT_REPORT_LISTED,
  type ReportListedViewer,
} from '~/server/services/report-listed-visibility';

/**
 * An article's images a viewer may not be shown: `withheldByModel` among `coverIds` (unless
 * `skipModel`, as for a moderator), and `listedHidden` among `coverIds` and `bodyIds`.
 */
export async function getArticleImageHolds({
  coverIds,
  bodyIds = [],
  viewer = SIGNED_OUT_REPORT_LISTED,
  skipModel = false,
  db,
}: {
  coverIds: number[];
  bodyIds?: number[];
  viewer?: ReportListedViewer;
  skipModel?: boolean;
  db?: Pick<typeof dbRead, '$queryRaw'>;
}) {
  const [withheldByModel, listedHidden] = await Promise.all([
    skipModel ? new Set<number>() : getModelWithheldImageIds(coverIds, db),
    getReportListedHiddenImageIds([...coverIds, ...bodyIds], viewer, db),
  ]);
  return { withheldByModel, listedHidden };
}

/** Images no signed-out reader is shown: withheld by their model, or listed on a report. */
export async function getPublicWithheldImageIds(
  imageIds: number[],
  db?: Pick<typeof dbRead, '$queryRaw'>
) {
  const { withheldByModel, listedHidden } = await getArticleImageHolds({ coverIds: imageIds, db });
  return new Set([...withheldByModel, ...listedHidden]);
}
