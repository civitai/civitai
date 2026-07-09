-- CreateTable
CREATE TABLE "BuildGuide" (
    "id" SERIAL NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "name" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "components" JSONB NOT NULL,
    "capabilities" JSONB NOT NULL,

    CONSTRAINT "BuildGuide_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "BuildGuide" ADD CONSTRAINT "BuildGuide_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
