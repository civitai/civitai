-- AlterTable
ALTER TABLE "Image" ADD COLUMN     "metadata" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "type" "MediaType" NOT NULL DEFAULT 'image';


