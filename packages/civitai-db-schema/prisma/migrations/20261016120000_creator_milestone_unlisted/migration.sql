-- Idempotent: applied by hand, possibly more than once.
--
-- A hidden Creator Journey milestone can be unlisted: it is left off the journey page's hidden
-- section, tile and count, until the viewer earns it. Display only; the grant job ignores it.
-- Which milestones are unlisted is set on the rows, not here.
--
-- 🔴 APPLY BEFORE THE CODE THAT READS THIS COLUMN DEPLOYS: the journey page selects it.

ALTER TABLE "CreatorMilestone" ADD COLUMN IF NOT EXISTS "unlisted" BOOLEAN NOT NULL DEFAULT false;
