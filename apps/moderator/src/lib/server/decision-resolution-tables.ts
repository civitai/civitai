import type { Generated, Timestamp } from './moderator-db/types';
import type { ApplyState, DecisionRuling, DecisionSource } from '../decision-rulings';

/**
 * `decision_resolution`, declared here rather than in the generated `moderator-db/types.ts` for the
 * reason `abuse-detection-tables.ts` gives: that file mirrors the database exactly, and this table is
 * hand-designed and hand-applied (`apps/moderator/decisions/schema.sql`). `withTables` adds it to the
 * shared client's type without a second connection.
 */
export type DecisionResolutionTables = {
  decision_resolution: {
    id: Generated<string>;
    source: DecisionSource;
    item_key: string;
    sub_key: Generated<string>;
    source_version: string;
    area: string | null;
    ruling: DecisionRuling;
    target_key: string | null;
    escalate_to: string | null;
    note: string | null;
    ruled_by: number;
    ruled_at: Generated<Timestamp>;
    apply_state: Generated<ApplyState>;
    shown: unknown;
    answer_text: string | null;
    answer_ticket_id: string | null;
    answer_conversation_id: string | null;
  };
};
