-- CreateTable
CREATE TABLE "QuerySqlLog" (
    "id" SERIAL NOT NULL,
    "hash" TEXT NOT NULL,
    "sql" TEXT NOT NULL,

    CONSTRAINT "QuerySqlLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QueryParamsLog" (
    "id" SERIAL NOT NULL,
    "hash" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "sqlId" INTEGER NOT NULL,

    CONSTRAINT "QueryParamsLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QueryDurationLog" (
    "id" SERIAL NOT NULL,
    "duration" INTEGER NOT NULL,
    "sqlId" INTEGER NOT NULL,
    "paramsId" INTEGER NOT NULL,

    CONSTRAINT "QueryDurationLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "QuerySqlLog_hash_key" ON "QuerySqlLog"("hash");

-- CreateIndex
CREATE UNIQUE INDEX "QueryParamsLog_sqlId_hash_key" ON "QueryParamsLog"("sqlId", "hash");

-- AddForeignKey
ALTER TABLE "QueryParamsLog" ADD CONSTRAINT "QueryParamsLog_sqlId_fkey" FOREIGN KEY ("sqlId") REFERENCES "QuerySqlLog"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QueryDurationLog" ADD CONSTRAINT "QueryDurationLog_sqlId_fkey" FOREIGN KEY ("sqlId") REFERENCES "QuerySqlLog"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QueryDurationLog" ADD CONSTRAINT "QueryDurationLog_paramsId_fkey" FOREIGN KEY ("paramsId") REFERENCES "QueryParamsLog"("id") ON DELETE CASCADE ON UPDATE CASCADE;
