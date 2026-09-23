-- Drops the decision log for `rewards-abuse-prevention`, removed in this same change.
--
-- APPLY BY HAND. Migrations in this repo are never auto-run, and this one is destructive:
-- it discards the audit rows for every run the job ever logged. There is exactly one at the
-- time of writing (a dry run that disabled nobody), so nothing enforced is being erased --
-- but re-check before running, because a row written after this file was committed would go
-- with it.
--
-- Safe to defer. With the job gone the table has no writer, so leaving it costs only the
-- disk its existing rows occupy. Drop it when you are satisfied nothing wants them.

DROP TABLE IF EXISTS rewards_abuse_decisions;
