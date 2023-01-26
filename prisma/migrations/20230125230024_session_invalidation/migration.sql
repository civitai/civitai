-- CreateTable
CREATE TABLE "SessionInvalidation" (
    "userId" INTEGER NOT NULL,
    "invalidatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SessionInvalidation_pkey" PRIMARY KEY ("userId","invalidatedAt")
);

-- AddForeignKey
ALTER TABLE "SessionInvalidation" ADD CONSTRAINT "SessionInvalidation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
