-- CreateTable
CREATE TABLE "CollectionItemScore" (
    "userId" INTEGER NOT NULL,
    "collectionItemId" INTEGER NOT NULL,
    "score" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CollectionItemScore_pkey" PRIMARY KEY ("userId","collectionItemId")
);

-- AddForeignKey
ALTER TABLE "CollectionItemScore" ADD CONSTRAINT "CollectionItemScore_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionItemScore" ADD CONSTRAINT "CollectionItemScore_collectionItemId_fkey" FOREIGN KEY ("collectionItemId") REFERENCES "CollectionItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
