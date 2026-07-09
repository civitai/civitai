-- CreateTable
CREATE TABLE "License" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,

    CONSTRAINT "License_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_LicenseToModel" (
    "A" INTEGER NOT NULL,
    "B" INTEGER NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "_LicenseToModel_AB_unique" ON "_LicenseToModel"("A", "B");

-- CreateIndex
CREATE INDEX "_LicenseToModel_B_index" ON "_LicenseToModel"("B");

-- AddForeignKey
ALTER TABLE "_LicenseToModel" ADD CONSTRAINT "_LicenseToModel_A_fkey" FOREIGN KEY ("A") REFERENCES "License"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_LicenseToModel" ADD CONSTRAINT "_LicenseToModel_B_fkey" FOREIGN KEY ("B") REFERENCES "Model"("id") ON DELETE CASCADE ON UPDATE CASCADE;
