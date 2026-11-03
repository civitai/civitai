import type { PageServerLoad } from './$types';
import { parseQueryKeys } from '$lib/server/query';
import { getAgreement, getDailyCounts } from '$lib/server/shadow-sexual-prompt.service';
import { filtersSchema } from '$lib/shadow-sexual-prompt';

// Reads only the keys these two panels use, so paging or narrowing the would-raise list (its own
// endpoint, `./list`) does not rerun them.
const panelFilters = filtersSchema.pick({ days: true, source: true });

// Streamed, not awaited: each panel renders its own pending and failure state, so one slow or failed
// query cannot hold up or blank the other.
export const load: PageServerLoad = ({ url }) => {
  const filters = parseQueryKeys(url, panelFilters);
  return { daily: getDailyCounts(filters), agreement: getAgreement(filters) };
};
