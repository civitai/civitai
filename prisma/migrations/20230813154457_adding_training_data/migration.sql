CREATE TYPE "TrainingStatus" AS ENUM ('Pending', 'Submitted', 'Processing', 'InReview', 'Failed', 'Approved');
CREATE TYPE "ModelUploadType" AS ENUM ('Created', 'Trained');
CREATE TYPE "ModelFileVisibility" AS ENUM ('Sensitive', 'Private', 'Public');
ALTER TYPE "ModelStatus" ADD VALUE 'Training';

ALTER TABLE "Model" ADD COLUMN     "uploadType" "ModelUploadType" NOT NULL DEFAULT 'Created';
ALTER TABLE "ModelFile" ADD COLUMN     "visibility" "ModelFileVisibility" NOT NULL DEFAULT 'Public';
ALTER TABLE "ModelVersion" ADD COLUMN     "trainingDetails" JSONB,
ADD COLUMN     "trainingStatus" "TrainingStatus";
