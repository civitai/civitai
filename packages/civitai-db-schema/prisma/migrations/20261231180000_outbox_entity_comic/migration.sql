-- Lets the site forward comic search updates through "Outbox" (event 'search.update'). Applied by hand.
-- Deploy the regenerated client first. Leave Comic out of SEARCH_OUTBOX_FORWARD until this is applied
-- and read back: SELECT unnest(enum_range(NULL::"OutboxEntity"));
-- Additive: no existing row changes.
ALTER TYPE "OutboxEntity" ADD VALUE IF NOT EXISTS 'Comic';
