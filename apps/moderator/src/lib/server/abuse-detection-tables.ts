import type { Generated, Timestamp } from './moderator-db/types';
import type { AbuseVerdict } from '../abuse-verdicts';

/**
 * The abuse-detection tables, in the same database as the rest of this app's moderation data.
 *
 * 🔴 Declared HERE rather than in `moderator-db/types.ts`, and that is deliberate. That file is a
 * whole-schema mirror of the moderator database; these two tables are new and hand-designed, and
 * folding them into it would put author-maintained definitions in a file whose value is that it
 * matches the database exactly. `Kysely.withTables<T>()` adds them to the client's type WITHOUT a
 * second connection — see `abuse-detection.service.ts`.
 *
 * Schema: `apps/moderator/abuse-detection/schema.sql`, applied by hand like every other table here.
 *
 * snake_case, unlike the inherited Retool tables: these are new, written to Postgres convention.
 */
/**
 * 🔴 The verdict set lives in `$lib/abuse-verdicts` — client-safe, because the buttons that render
 * it are client code and SvelteKit will not bundle `$lib/server` into those. It is the SAME tuple
 * the table's CHECK constraint admits, and `abuse-detection.schema.test.ts` applies the real DDL to
 * an in-process Postgres and asserts the two agree, in both directions.
 */
export type { AbuseVerdict } from '../abuse-verdicts';

export type AbuseDetectionTables = {
  abuse_detection_run: {
    id: Generated<number>;
    detector: string;
    /** The PRODUCER's clock, not receipt time. */
    started_at: Timestamp;
    finished_at: Timestamp;
    summary: string | null;
    counters: Generated<unknown>;
    received_at: Generated<Timestamp>;
  };
  abuse_detection_finding: {
    id: Generated<number>;
    run_id: number;
    /** The account the finding is ABOUT. Not an actor, and deliberately not FK'd. */
    user_id: number;
    confidence: number;
    reason: string;
    /**
     * 🔴 THE PRODUCER's self-report of what IT did — NOT a moderator's judgement. `verdict` below is
     * the judgement, and the two are independent: `actioned: false` + `verdict: 'tp'` (left alone,
     * and rightly flagged) is the commonest combination of them. Nothing may read one to infer the
     * other, and recording a verdict must leave these two untouched.
     */
    actioned: boolean;
    action: string | null;
    created_at: Generated<Timestamp>;
    /**
     * The MODERATOR's ruling — `tp` / `fp` / `skip`, or NULL for unruled. Constrained by a CHECK in
     * `apps/moderator/abuse-detection/schema.sql`; typed as the union here so a call site cannot
     * write a fourth value the database would then reject at runtime.
     *
     * 🔴 These four are added by the DDL and the DDL is applied BY HAND, so a deployment exists in
     * which the tables are present and these columns are not. Every read of them goes through a
     * branch that treats `42703` as "not applied yet" rather than as an outage.
     */
    verdict: AbuseVerdict | null;
    verdict_by: string | null;
    verdict_at: Timestamp | null;
    /** The producer's cluster key — one ruling covers every finding sharing it WITHIN ONE RUN. NULL
     *  for an ungrouped finding, which is most of them. */
    group_key: string | null;
  };
};
