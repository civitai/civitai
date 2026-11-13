-- Moderator app, Models -> Model Flags, Needs review: models the text scan rated NSFW while their owner
-- had them marked minor, a real person or SFW-only (Model.meta.restrictedNsfwVerdict). The list and the
-- sidebar badge filter "Model" on the predicate below; without the index each is a seq scan.
--
-- HAND-APPLIED. Additive; the queue is correct without it, only slow. The predicate must match
-- `pendingPredicate` in apps/moderator/src/lib/server/restricted-nsfw-verdicts.ts exactly.
-- RUN OUTSIDE ANY TRANSACTION (CONCURRENTLY). A failed build leaves an INVALID index:
-- DROP INDEX IF EXISTS "Model_restrictedNsfwVerdict_idx", then re-run.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Model_restrictedNsfwVerdict_idx"
  ON "Model" (id)
  WHERE (meta ? 'restrictedNsfwVerdict');
