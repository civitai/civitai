/**
 * The DBOS calls a reply makes, as `reply-dbos-calls.pg.test.ts` reads them back from DBOS's own
 * tables: what a crashed run's recovery replays against. Recorded on the runner as it was before
 * its generic code moved to `src/core/`; that move must not change a line of it.
 *
 * A change here changes what a recovered run replays: bump `WORKFLOW_VERSION` with it.
 */
export const GOLDEN: Record<string, unknown> = {};
