-- CreateEnum
CREATE TYPE "EntityCollaboratorStatus" AS ENUM ('Pending', 'Approved', 'Rejected');

-- CreateTable
CREATE TABLE "EntityCollaborator" (
    "entityType" "EntityType" NOT NULL,
    "entityId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "status" "EntityCollaboratorStatus" NOT NULL DEFAULT 'Pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" INTEGER NOT NULL,

    CONSTRAINT "EntityCollaborator_pkey" PRIMARY KEY ("entityType","entityId","userId")
);

-- CreateIndex
CREATE INDEX "EntityCollaborator_userId_entityType_entityId_idx" ON "EntityCollaborator"("userId", "entityType", "entityId") INCLUDE ("status");

-- AddForeignKey
ALTER TABLE "EntityCollaborator" ADD CONSTRAINT "EntityCollaborator_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EntityCollaborator" ADD CONSTRAINT "EntityCollaborator_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
