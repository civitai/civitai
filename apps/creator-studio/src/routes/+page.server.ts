import type { PageServerLoad } from './$types';

// Earnings summary (ClickHouse owner-keyed rollup, decision A1) lands here later; the layout load already
// resolved user + membership.
export const load: PageServerLoad = () => ({});
