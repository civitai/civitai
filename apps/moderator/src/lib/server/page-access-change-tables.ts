import type { Generated, Timestamp } from './moderator-db/types';

/**
 * `page_access_change`, declared here rather than in the generated `moderator-db/types.ts` for the
 * reason `abuse-detection-tables.ts` gives: that file mirrors the database, and this table is
 * hand-designed and hand-applied (`apps/moderator/page-access/schema.sql`).
 */
export type PageAccessChangeTables = {
  page_access_change: {
    id: Generated<string>;
    at: Generated<Timestamp>;
    actor_id: number;
    via: 'admin-page' | 'api';
    gate_ref: string | null;
    path: string;
    roles_before: string[];
    roles_after: string[];
    reason: string | null;
    applied: Generated<boolean>;
  };
};
