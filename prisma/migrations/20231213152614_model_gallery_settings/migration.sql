-- AlterTable
ALTER TABLE "Model" ADD COLUMN     "gallerySettings" JSONB NOT NULL DEFAULT '{"users": [], "tags": [], "images": []}';
