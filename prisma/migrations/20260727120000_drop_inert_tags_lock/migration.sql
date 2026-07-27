-- Drops the inert 'tags' entry from Model."lockedProperties".
--
-- 'tags' was offered in the model edit form's lockable-properties list but never did
-- anything: the tags input is named `tagsOnModels`, so the moderator watch effect could
-- not auto-apply it, the input carried no locked state, and no server code read it. The
-- option has been removed from the form; this clears the 8 rows a moderator had ticked it
-- on by hand so the data does not outlive the option.
--
-- Safe to run before or after the code deploy — the value is inert either way.
--
-- Applied MANUALLY (this repo does NOT use `prisma migrate deploy`).

UPDATE "Model"
SET "lockedProperties" = array_remove("lockedProperties", 'tags')
WHERE 'tags' = ANY("lockedProperties");
