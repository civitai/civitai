-- CreateTable
CREATE TABLE "FavoriteModel" (
    "userId" INTEGER NOT NULL,
    "modelId" INTEGER NOT NULL,

    CONSTRAINT "FavoriteModel_pkey" PRIMARY KEY ("userId","modelId")
);

-- AddForeignKey
ALTER TABLE "FavoriteModel" ADD CONSTRAINT "FavoriteModel_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FavoriteModel" ADD CONSTRAINT "FavoriteModel_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "Model"("id") ON DELETE CASCADE ON UPDATE CASCADE;
