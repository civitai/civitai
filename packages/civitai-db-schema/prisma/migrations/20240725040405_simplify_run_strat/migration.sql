ALTER TABLE "RunStrategy" DROP CONSTRAINT "RunStrategy_pkey",
DROP COLUMN "id",
ADD CONSTRAINT "RunStrategy_pkey" PRIMARY KEY ("modelVersionId", "partnerId");
