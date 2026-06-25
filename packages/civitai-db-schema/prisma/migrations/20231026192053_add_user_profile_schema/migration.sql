BEGIN;
-- CreateTable
CREATE TABLE "UserProfile" (
    "userId" INTEGER NOT NULL,
    "coverImageId" INTEGER,
    "bio" TEXT,
    "message" TEXT,
    "messageAddedAt" TIMESTAMP(3),
    "privacySettings" JSONB NOT NULL DEFAULT '{"showFollowerCount":true,"showFollowingCount":true,"showReviewsRating":true}',
    "profileSectionsSettings" JSONB NOT NULL DEFAULT '{"showcase":{"enabled":true,"index":0},"popularModels":{"enabled":true,"index":1},"popularImages":{"enabled":true,"index":2},"recent":{"enabled":true,"index":3},"models":{"enabled":true,"index":4},"images":{"enabled":true,"index":4},"articles":{"enabled":true,"index":4},"reviews":{"enabled":true,"index":5}}',

    CONSTRAINT "UserProfile_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "UserProfileShowcaseItem" (
    "profileId" INTEGER NOT NULL,
    "entityId" INTEGER NOT NULL,
    "entityType" TEXT NOT NULL,
    "index" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "UserProfileShowcaseItem_pkey" PRIMARY KEY ("entityType","entityId","profileId")
);

-- CreateIndex
CREATE INDEX "UserProfileShowcaseItem_profileId_idx" ON "UserProfileShowcaseItem"("profileId");

-- AddForeignKey
ALTER TABLE "UserProfile" ADD CONSTRAINT "UserProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserProfile" ADD CONSTRAINT "UserProfile_coverImageId_fkey" FOREIGN KEY ("coverImageId") REFERENCES "Image"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserProfileShowcaseItem" ADD CONSTRAINT "UserProfileShowcaseItem_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "UserProfile"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
