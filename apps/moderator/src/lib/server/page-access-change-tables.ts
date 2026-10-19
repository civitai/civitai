import type { Generated, Timestamp } from './moderator-db/types';

export type PageAccessVia = 'admin-page' | 'api';
/** `pending` until the grant transaction ends; a row left there is unconfirmed. */
export type PageAccessOutcome = 'pending' | 'applied' | 'refused';

/** Hand-declared: the table is hand-applied (`apps/moderator/page-access/schema.sql`), not pulled. */
export type PageAccessChangeTables = {
  page_access_change: {
    id: Generated<string>;
    at: Generated<Timestamp>;
    actor_id: number;
    via: PageAccessVia;
    gate_ref: string | null;
    path: string;
    roles_before: string[];
    roles_after: string[];
    reason: string | null;
    outcome: Generated<PageAccessOutcome>;
  };
};
