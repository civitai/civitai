-- AlterTable
ALTER TABLE "Image" ADD COLUMN     "metadata" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "type" "MediaType" NOT NULL DEFAULT 'image';

UPDATE "Image"
SET metadata = json_build_object('hash', hash, 'width', width, 'height', height)

UPDATE "Image"
SET type = 'video'
WHERE "mimeType" = 'image/gif'

