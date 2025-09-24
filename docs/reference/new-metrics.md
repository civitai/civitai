# Handler Metric Output Report

Generated: 2025-09-24T15:26:56.969Z

## Summary

- **Total Handlers**: 21
- **Handlers with Debug Config**: 20
- **Total Unique Metric Combinations**: 75

## Handler Details

### userEngagementHandler

**Tables**: UserEngagement
**Operations**: create, delete

**Metric Outputs**:
- `User.followerCount`
- `User.followingCount`
- `User.hiddenCount`

### imageReactionHandler

**Tables**: ImageReaction
**Operations**: create, delete

**Metric Outputs**:
- `Image.Cry`
- `Image.Dislike`
- `Image.Heart`
- `Image.Laugh`
- `Image.Like`
- `Post.Cry`
- `Post.Dislike`
- `Post.Heart`
- `Post.Laugh`
- `Post.Like`
- `Post.reactionCount`
- `User.reactionCount`

### articleReactionHandler

**Tables**: ArticleReaction
**Operations**: create, delete

**Metric Outputs**:
- `Article.Cry`
- `Article.Dislike`
- `Article.Heart`
- `Article.Laugh`
- `Article.Like`
- `User.reactionCount`

### bountyEntryReactionHandler

**Tables**: BountyEntryReaction
**Operations**: create, delete

**Metric Outputs**:
- `BountyEntry.Cry`
- `BountyEntry.Dislike`
- `BountyEntry.Heart`
- `BountyEntry.Laugh`
- `BountyEntry.Like`
- `User.reactionCount`

### articleHandler

**Tables**: Article
**Operations**: update, delete

**Metric Outputs**:
- `User.articleCount`

### resourceReviewHandler

**Tables**: ResourceReview
**Operations**: create, update, delete

**Metric Outputs**:
- `Model.ratingCount`
- `Model.thumbsDownCount`
- `Model.thumbsUpCount`
- `ModelVersion.ratingCount`
- `ModelVersion.thumbsDownCount`
- `ModelVersion.thumbsUpCount`

### collectionItemHandler

**Tables**: CollectionItem
**Operations**: create, delete

**Metric Outputs**:
- `Article.collectedCount`
- `Collection.itemCount`
- `Image.Collection`
- `Model.collectedCount`
- `Post.collectedCount`

### collectionContributorHandler

**Tables**: CollectionContributor
**Operations**: create, delete

**Metric Outputs**:
- `Collection.contributorCount`
- `Collection.followerCount`

### commentHandler

**Tables**: Comment
**Operations**: create, delete

**Metric Outputs**:
- `Model.commentCount`

### commentV2Handler

**Tables**: CommentV2
**Operations**: create, delete

**Metric Outputs**:
- `Article.commentCount`
- `Bounty.commentCount`
- `Image.commentCount`
- `Post.commentCount`

### imageResourceHandler

**Tables**: ImageResourceNew
**Operations**: create, delete

**Metric Outputs**:
- `Model.imageCount`
- `ModelVersion.imageCount`

### buzzTipHandler

**Tables**: BuzzTip
**Operations**: create

**Metric Outputs**:
- `Article.tippedAmount`
- `Article.tippedCount`
- `Image.tippedAmount`
- `Image.tippedCount`
- `Model.tippedAmount`
- `Model.tippedCount`
- `Post.tippedAmount`
- `Post.tippedCount`
- `User.tippedAmount`
- `User.tippedCount`
- `User.tipsGivenAmount`
- `User.tipsGivenCount`

### tagEngagementHandler

**Tables**: TagEngagement
**Operations**: create, delete

**Metric Outputs**:
- `Tag.followerCount`
- `Tag.hiddenCount`

### tagsHandler

**Tables**: TagsOnPost, TagsOnModels, TagsOnImageNew, TagsOnArticle, TagsOnBounty
**Operations**: create, delete

*No debug configuration or no metrics detected*

### bountyEngagementHandler

**Tables**: BountyEngagement
**Operations**: create, delete

**Metric Outputs**:
- `Bounty.favoriteCount`
- `Bounty.trackCount`

### bountyHandler

**Tables**: Bounty
**Operations**: create, update, delete

**Metric Outputs**:
- `User.bountyCount`

### bountyEntryHandler

**Tables**: BountyEntry
**Operations**: create, delete

**Metric Outputs**:
- `Bounty.entryCount`

### bountyBenefactorHandler

**Tables**: BountyBenefactor
**Operations**: create, update, delete

**Metric Outputs**:
- `Bounty.benefactorCount`
- `Bounty.unitAmount`
- `BountyEntry.unitAmount`

### modelVersionEventsHandler

**Tables**: clickhouse.modelVersionEvents
**Operations**: create

**Metric Outputs**:
- `Model.downloadCount`
- `ModelVersion.downloadCount`

### jobsHandler

**Tables**: clickhouse.jobs
**Operations**: create

**Metric Outputs**:
- `Model.generationCount`
- `ModelVersion.generationCount`

### buzzResourceCompensationHandler

**Tables**: clickhouse.buzz_resource_compensation
**Operations**: create

**Metric Outputs**:
- `Model.earnedAmount`
- `ModelVersion.earnedAmount`

## All Unique Metrics

- `Article.Cry`
- `Article.Dislike`
- `Article.Heart`
- `Article.Laugh`
- `Article.Like`
- `Article.collectedCount`
- `Article.commentCount`
- `Article.tippedAmount`
- `Article.tippedCount`
- `Bounty.benefactorCount`
- `Bounty.commentCount`
- `Bounty.entryCount`
- `Bounty.favoriteCount`
- `Bounty.trackCount`
- `Bounty.unitAmount`
- `BountyEntry.Cry`
- `BountyEntry.Dislike`
- `BountyEntry.Heart`
- `BountyEntry.Laugh`
- `BountyEntry.Like`
- `BountyEntry.unitAmount`
- `Collection.contributorCount`
- `Collection.followerCount`
- `Collection.itemCount`
- `Image.Collection`
- `Image.Cry`
- `Image.Dislike`
- `Image.Heart`
- `Image.Laugh`
- `Image.Like`
- `Image.commentCount`
- `Image.tippedAmount`
- `Image.tippedCount`
- `Model.collectedCount`
- `Model.commentCount`
- `Model.downloadCount`
- `Model.earnedAmount`
- `Model.generationCount`
- `Model.imageCount`
- `Model.ratingCount`
- `Model.thumbsDownCount`
- `Model.thumbsUpCount`
- `Model.tippedAmount`
- `Model.tippedCount`
- `ModelVersion.downloadCount`
- `ModelVersion.earnedAmount`
- `ModelVersion.generationCount`
- `ModelVersion.imageCount`
- `ModelVersion.ratingCount`
- `ModelVersion.thumbsDownCount`
- `ModelVersion.thumbsUpCount`
- `Post.Cry`
- `Post.Dislike`
- `Post.Heart`
- `Post.Laugh`
- `Post.Like`
- `Post.collectedCount`
- `Post.commentCount`
- `Post.reactionCount`
- `Post.tippedAmount`
- `Post.tippedCount`
- `Tag.followerCount`
- `Tag.hiddenCount`
- `User.articleCount`
- `User.bountyCount`
- `User.followerCount`
- `User.followingCount`
- `User.hiddenCount`
- `User.reactionCount`
- `User.tippedAmount`
- `User.tippedCount`
- `User.tipsGivenAmount`
- `User.tipsGivenCount`
