import { env } from '~/env/server';
import { dbWrite } from '~/server/db/client';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { logToAxiom } from '~/server/logging/client';
import { coocSqlOf } from '~/server/services/resource-intent-cooc/store';
import { runTagIndexJob } from '~/server/services/resource-intent-tags/heartbeat';
import { s3TagIndexObjects } from '~/server/services/resource-intent-tags/objects';
import { runTagIndexBuild } from '~/server/services/resource-intent-tags/pipeline';
import { applyTagIndexRetention } from '~/server/services/resource-intent-tags/retention';
import { RESOURCE_INTENT_TAGS_SPEC_HASH } from '~/server/services/resource-intent-tags/spec';
import { createJob } from './job';

/**
 * Several times a full-coverage build's duration, so retried statements, a slower standby and the
 * eligible set's growth still finish under it without a second build starting
 * (docs/resource-intent-primitive.md, "Build job").
 */
export const LOCK_MINUTES = 120;

export const buildResourceIntentTagIndexJob = createJob(
  'build-resource-intent-tag-index',
  // Weekly, an hour after build-resource-intent-cooc ('0 5 * * 2').
  '0 6 * * 2',
  async () => {
    if (!(await isFlipt(FLIPT_FEATURE_FLAGS.RESOURCE_INTENT_TAG_INDEX_BUILD)))
      return { skipped: 'flag off' };
    // Retention runs here, after the build, rather than as a job of its own: snapshots change only
    // when this job runs. It runs whether or not the build succeeded, and deletes only objects this
    // database's retired rows name (docs/resource-intent-primitive.md, "Retention").
    return runTagIndexJob({
      build: async () => (await runTagIndexBuild({ dryRun: false }, { env })).summary,
      retention: async () => {
        try {
          return await applyTagIndexRetention(
            { sql: coocSqlOf(dbWrite), objects: s3TagIndexObjects() },
            { now: new Date(), specHash: RESOURCE_INTENT_TAGS_SPEC_HASH }
          );
        } catch (e) {
          logToAxiom({
            type: 'resource-intent-tag-index-retention-failed',
            error: e instanceof Error ? e.message : String(e),
          }).catch(() => undefined);
          throw e;
        }
      },
      kv: dbWrite,
      now: () => new Date(),
    });
  },
  // A concurrent second build would repeat every read. See `LOCK_MINUTES`; at a weekly cadence a
  // long hold blocks nothing. The build does not poll `checkIfCanceled`, so it finishes if the
  // scheduler hangs up.
  { lockExpiration: LOCK_MINUTES * 60, keepLockOnDisconnect: true }
);
