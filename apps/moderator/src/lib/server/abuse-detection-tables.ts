import type { Generated, Timestamp } from './moderator-db/types';

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
    /** `false` is the common case: detected, scored, deliberately NOT acted on. */
    actioned: boolean;
    action: string | null;
    created_at: Generated<Timestamp>;
  };
};
