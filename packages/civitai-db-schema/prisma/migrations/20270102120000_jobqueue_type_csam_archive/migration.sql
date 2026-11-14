-- Additive enum value for the CSAM report archiver's queue rows. Apply only after the client that
-- knows the value is deployed (see .claude/rules/database.md, "Adding an enum value").
-- Run it on its own: the new label cannot be used until this statement commits.
ALTER TYPE "JobQueueType" ADD VALUE IF NOT EXISTS 'CsamArchive';
