-- Collaborators endorsed before invitations existed were accepted by the backfill in
-- 20261215120000_storyline_collaborator_accepted, which set "acceptedAt" = "createdAt". They never
-- agreed, so they are asked now: back to pending, with "createdAt" moved so the
-- 'storyline-collaborator-invited' notification, which reads invitations created since its last
-- run, sends each of them the invite.
--
-- "createdAt" is set an hour ahead, in UTC whatever the session's time zone. A notification run
-- that starts while this transaction is open, or reads a lagging replica, records a watermark past
-- now() without seeing the rows; the hour keeps them in every run's window until one does. Runs that
-- find them again send nothing new: the notification's key is per storyline and user.
--
-- Every backfilled row was created before invitations shipped on 2026-10-30. The cutoff keeps out
-- any invitation accepted later in the same millisecond it was made. Re-running changes nothing:
-- the rows re-asked here now have a later "createdAt".
UPDATE "StorylineCollaborator"
SET "acceptedAt" = NULL, "createdAt" = (now() AT TIME ZONE 'UTC') + interval '1 hour'
WHERE "acceptedAt" = "createdAt" AND "createdAt" < '2026-10-30';
