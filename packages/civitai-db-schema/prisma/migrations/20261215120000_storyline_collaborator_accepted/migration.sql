-- A collaborator must accept the owner's invitation before they are shown on the storyline or get
-- collaborator rights. NULL is a pending invitation.
--
-- Everyone already a collaborator is kept, as accepted when they were added. Apply just before the
-- deploy: a collaborator the previous build adds after this runs arrives pending, and may not be
-- notified, though the storyline's page still asks them.
--
-- The backfill runs only with the ADD COLUMN: re-running this file once real invitations exist
-- must not accept them.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'StorylineCollaborator' AND column_name = 'acceptedAt'
  ) THEN
    ALTER TABLE "StorylineCollaborator" ADD COLUMN "acceptedAt" TIMESTAMP(3);
    UPDATE "StorylineCollaborator" SET "acceptedAt" = "createdAt";
  END IF;
END
$$;
