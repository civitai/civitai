# Table to Metrics Mapping

This document maps database tables to the metrics they affect based on the event mappings in initial.md.

## PostgreSQL Tables

### userEngagement ✅
**Events**: create, delete
**Affected Metrics**:
- `UserMetric.followingCount`
- `UserMetric.followerCount`
- `UserMetric.hiddenCount`

### imageReaction ✅
**Events**: create, delete
**Affected Metrics**:
- `UserMetric.reactionCount`
- `PostMetric.likeCount`
- `PostMetric.dislikeCount`
- `PostMetric.laughCount`
- `PostMetric.cryCount`
- `PostMetric.heartCount`
- `ImageMetric.likeCount`
- `ImageMetric.dislikeCount`
- `ImageMetric.laughCount`
- `ImageMetric.cryCount`
- `ImageMetric.heartCount`
- `ImageMetric.reactionCount`

### modelVersion (via outbox)
**Events**: create, update, delete
**Affected Metrics**:
- `UserMetric.uploadCount`

### resourceReview ✅
**Events**: create, update, delete
**Affected Metrics**:
- `UserMetric.reviewCount`
- `ModelMetric.rating`
- `ModelMetric.ratingCount`
- `ModelMetric.thumbsUpCount`
- `ModelMetric.thumbsDownCount`
- `ModelVersionMetric.rating`
- `ModelVersionMetric.ratingCount`
- `ModelVersionMetric.thumbsUpCount`
- `ModelVersionMetric.thumbsDownCount`

### collectionItem ✅
**Events**: create, delete
**Affected Metrics**:
- `ModelMetric.favoriteCount`
- `ModelMetric.collectedCount`
- `ModelVersionMetric.favoriteCount`
- `ModelVersionMetric.collectedCount`
- `PostMetric.collectedCount`
- `ImageMetric.collectedCount`
- `ArticleMetric.favoriteCount`
- `ArticleMetric.collectedCount`
- `CollectionMetric.itemCount`

### comment ✅
**Events**: create, delete
**Affected Metrics**:
- `ModelMetric.commentCount`
- `ModelVersionMetric.commentCount`

### commentv2 ✅
**Events**: create, delete
**Affected Metrics**:
- `PostMetric.commentCount`
- `ImageMetric.commentCount`
- `ArticleMetric.commentCount`
- `BountyMetric.commentCount`

### imageResourceNew ✅
**Events**: create, delete
**Affected Metrics**:
- `ModelMetric.imageCount`
- `ModelVersionMetric.imageCount`

### buzzTip ✅
**Events**: create
**Affected Metrics**:
- `ModelMetric.tippedCount`
- `ModelMetric.tippedAmountCount`
- `ModelVersionMetric.tippedCount`
- `ModelVersionMetric.tippedAmountCount`
- `ImageMetric.tippedCount`
- `ImageMetric.tippedAmountCount`
- `ArticleMetric.tippedCount`
- `ArticleMetric.tippedAmountCount`
- `BountyEntryMetric.tippedCount`
- `BountyEntryMetric.tippedAmountCount`

### collectionContributor ✅
**Events**: create, delete
**Affected Metrics**:
- `CollectionMetric.followerCount`
- `CollectionMetric.contributorCount`

### tagEngagement ✅
**Events**: create, delete
**Affected Metrics**:
- `TagMetric.hiddenCount`
- `TagMetric.followerCount`

### articleReaction ✅
**Events**: create, delete
**Affected Metrics**:
- `ArticleMetric.likeCount`
- `ArticleMetric.dislikeCount`
- `ArticleMetric.laughCount`
- `ArticleMetric.cryCount`
- `ArticleMetric.heartCount`

### articleEngagement ✅
**Events**: create, delete
**Affected Metrics**:
- `ArticleMetric.hideCount`

### bountyEngagement ✅
**Events**: create, delete
**Affected Metrics**:
- `BountyMetric.favoriteCount`
- `BountyMetric.trackCount`

### bountyEntry ✅
**Events**: create, delete
**Affected Metrics**:
- `BountyMetric.entryCount`

### bountyBenefactor ✅
**Events**: create, delete, update
**Affected Metrics**:
- `BountyMetric.benefactorCount`
- `BountyMetric.unitAmountCount`
- `BountyEntryMetric.unitAmountCount` (update only)

### bountyEntryReaction ✅
**Events**: create, delete
**Affected Metrics**:
- `BountyEntryMetric.likeCount`
- `BountyEntryMetric.dislikeCount`
- `BountyEntryMetric.laughCount`
- `BountyEntryMetric.cryCount`
- `BountyEntryMetric.heartCount`

You can see what properties are available for each of these tables and how they relate to other tables in this prisma schema:
docs\reference\schema-minimal.prisma

---

**Don't worry about the part below for now**

### outbox_events
**Events**: create
**Affected Metrics**:
- Various metrics depending on the event type (used for tracking specific entity changes)

## ClickHouse Tables

### modelVersionEvent
**Events**: create
**Affected Metrics**:
- `ModelMetric.downloadCount`
- `ModelVersionMetric.downloadCount`

### orchestration.jobs
**Events**: create
**Affected Metrics**:
- `ModelMetric.generationCount`
- `ModelVersionMetric.generationCount`

### buzz_resource_compensation
**Events**: create
**Affected Metrics**:
- `ModelMetric.earnedAmount`
- `ModelVersionMetric.earnedAmount`

### entityMetricEvents
**Events**: create
**Affected Metrics**:
- Triggers search index updates for all entity types