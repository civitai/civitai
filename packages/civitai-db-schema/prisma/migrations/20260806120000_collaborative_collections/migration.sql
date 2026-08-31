CREATE TYPE "CollectionCollaboratorRole" AS ENUM ('Contributor', 'Manager');
CREATE TYPE "CollectionInviteStatus" AS ENUM ('Pending', 'Accepted', 'Declined');

CREATE TABLE "CollectionInvite" (
    "id" SERIAL NOT NULL,
    "collectionId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "invitedById" INTEGER NOT NULL,
    "role" "CollectionCollaboratorRole" NOT NULL,
    "status" "CollectionInviteStatus" NOT NULL DEFAULT 'Pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" TIMESTAMP(3),
    CONSTRAINT "CollectionInvite_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CollectionInvite_collectionId_userId_key"
    ON "CollectionInvite"("collectionId", "userId");
CREATE INDEX "CollectionInvite_userId_status_idx"
    ON "CollectionInvite"("userId", "status");

ALTER TABLE "CollectionInvite" ADD CONSTRAINT "CollectionInvite_collectionId_fkey"
    FOREIGN KEY ("collectionId") REFERENCES "Collection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CollectionInvite" ADD CONSTRAINT "CollectionInvite_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CollectionInvite" ADD CONSTRAINT "CollectionInvite_invitedById_fkey"
    FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Collection" ADD COLUMN "collaborationDisabledAt" TIMESTAMP(3);
