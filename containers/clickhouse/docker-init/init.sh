#!/bin/bash
set -e

clickhouse client -n <<-EOSQL
    CREATE DATABASE IF NOT EXISTS orchestration;

    create table if not exists default.actions
    (
        type Enum16('AddToBounty_Click' = 1, 'AddToBounty_Confirm' = 2, 'AwardBounty_Click' = 3, 'AwardBounty_Confirm' = 4, 'Tip_Click' = 5, 'Tip_Confirm' = 6, 'TipInteractive_Click' = 7, 'TipInteractive_Cancel' = 8, 'NotEnoughFunds' = 9, 'PurchaseFunds_Cancel' = 10, 'PurchaseFunds_Confirm' = 11, 'LoginRedirect' = 12, 'Membership_Cancel' = 13, 'CSAM_Help_Triggered' = 14),
        details     String   default '',
        time        DateTime default now(),
        userId      Int32    default 0,
        ip          String   default '',
        userAgent   String   default '',
        createdDate Date materialized toDate(time),
        reason LowCardinality(String),
        deviceId    String   default ''
    )
        engine = MergeTree()
            ORDER BY (time, type)
            SETTINGS index_granularity = 8192;

    create table if not exists default.activities
    (
        activity LowCardinality(String),
        time        DateTime default now(),
        userId      Int32    default 0,
        ip          String   default '',
        userAgent   String   default '',
        createdDate Date materialized toDate(time),
        deviceId    String   default ''
    )
        engine = MergeTree()
            PARTITION BY toYYYYMM(createdDate)
            ORDER BY (time, activity, userId)
            SETTINGS index_granularity = 8192;

    create table if not exists default.adImpressions
    (
        time        DateTime,
        userId      Int32,
        deviceId    String,
        adId        String,
        duration    Float32,
        impressions Int32 default 1
    )
        engine = SummingMergeTree()
            ORDER BY (time, userId, deviceId)
            SETTINGS index_granularity = 8192;

    create table if not exists default.answers
    (
        type Enum8('Create' = 1, 'Delete' = 2),
        time        DateTime default now(),
        userId      Int32    default 0,
        questionId  Int32,
        answerId    Int32,
        tags Array(String),
        ip          String   default '',
        userAgent   String   default '',
        createdDate Date materialized toDate(time)
    )
        engine = MergeTree()
            ORDER BY (time, answerId, userId)
            SETTINGS index_granularity = 8192;

    create table if not exists default.articleEngagements
    (
        type Enum8('Favorite' = 1, 'Hide' = 2, 'DeleteFavorite' = 3, 'DeleteHide' = 4),
        articleId   Int32,
        time        DateTime default now(),
        userId      Int32    default 0,
        ip          String   default '',
        userAgent   String   default '',
        createdDate Date materialized toDate(time)
    )
        engine = MergeTree()
            ORDER BY (time, type, articleId)
            SETTINGS index_granularity = 8192;

    create table if not exists default.bounties
    (
        type Enum8('Create' = 1, 'Update' = 2, 'Delete' = 3, 'Expire' = 4, 'Refund' = 5),
        bountyId    Int32,
        time        DateTime default now(),
        userId      Int32    default 0,
        ip          String   default '',
        userAgent   String   default '',
        createdDate Date materialized toDate(time),
        deviceId    String   default ''
    )
        engine = MergeTree()
            ORDER BY (time, type, bountyId)
            SETTINGS index_granularity = 8192;

    create table if not exists default.bountyBenefactors
    (
        type Enum8('Create' = 1),
        bountyId    Int32,
        userId      Int32,
        time        DateTime default now(),
        ip          String   default '',
        userAgent   String   default '',
        createdDate Date materialized toDate(time)
    )
        engine = MergeTree()
            ORDER BY (time, type, bountyId)
            SETTINGS index_granularity = 8192;

    create table if not exists default.bountyEngagements
    (
        type Enum8('Favorite' = 1, 'Track' = 2, 'DeleteFavorite' = 3, 'DeleteTrack' = 4),
        bountyId    Int32,
        time        DateTime default now(),
        userId      Int32    default 0,
        ip          String   default '',
        userAgent   String   default '',
        createdDate Date materialized toDate(time),
        deviceId    String   default ''
    )
        engine = MergeTree()
            ORDER BY (time, type, bountyId)
            SETTINGS index_granularity = 8192;

    create table if not exists default.bountyEntries
    (
        type Enum8('Create' = 1, 'Update' = 2, 'Delete' = 3, 'Award' = 4),
        bountyEntryId Int32,
        benefactorId  Int32,
        time          DateTime default now(),
        userId        Int32    default 0,
        ip            String   default '',
        userAgent     String   default '',
        createdDate   Date materialized toDate(time),
        deviceId      String   default ''
    )
        engine = MergeTree()
            ORDER BY (time, type, bountyEntryId)
            SETTINGS index_granularity = 8192;

    create table if not exists default.buzzEvents
    (
        time               DateTime      default now(),
        type               String,
        forId              Int32,
        toUserId           Int32,
        byUserId           Int32,
        awardAmount        Int32         default 0,
        status Enum8('pending' = 1, 'awarded' = 2, 'capped' = 3),
        ip                 String        default '',
        version            Int32         default 0,
        createdDate        Date materialized toDate(time),
        transactionDetails String        default '{}',
        multiplier         Decimal(3, 2) default 1,
        deviceId           String        default ''
    )
        engine = ReplacingMergeTree()
            PARTITION BY toYYYYMM(time)
            ORDER BY (type, toUserId, forId, byUserId)
            SETTINGS index_granularity = 8192;

    create table if not exists default.buzzTransactions
    (
        transactionId         String,
        date                  DateTime,
        fromAccountType LowCardinality(String),
        fromAccountId         Int32,
        toAccountType LowCardinality(String),
        toAccountId           Int32,
        amount                Int32,
        type LowCardinality(String),
        description           String,
        details               String,
        externalTransactionId String
    )
        engine = MergeTree()
            ORDER BY (date, fromAccountId, toAccountId)
            SETTINGS index_granularity = 8192;

    create table if not exists default.buzz_resource_compensation
    (
        date           DateTime,
        modelVersionId Int32,
        comp           UInt32,
        tip            UInt32,
        total          UInt32,
        updated_at     DateTime default now()
    )
        engine = ReplacingMergeTree()
            ORDER BY (date, modelVersionId)
            SETTINGS index_granularity = 8192;

    create table if not exists orchestration.resourceCompensations
    (
        date           DateTime,
        modelVersionId Int32,
        accountType    String,        
        amount         UInt32,
    )
        engine = ReplacingMergeTree()
            ORDER BY (date, modelVersionId)
            SETTINGS index_granularity = 8192;

    create table if not exists default.commentEvents
    (
        type Enum8('Create' = 1, 'Delete' = 2, 'Update' = 3, 'Hide' = 4, 'Unhide' = 5),
        time        DateTime default now(),
        userId      Int32    default 0,
        commentId   Int32,
        ip          String   default '',
        userAgent   String   default '',
        createdDate Date materialized toDate(time),
        deviceId    String   default ''
    )
        engine = MergeTree()
            ORDER BY (time, type)
            SETTINGS index_granularity = 8192;

    create table if not exists default.comments
    (
        type Enum8('Model' = 1, 'Image' = 2, 'Post' = 3, 'Comment' = 4, 'Review' = 5, 'Bounty' = 6, 'BountyEntry' = 7),
        time        DateTime default now(),
        userId      Int32    default 0,
        entityId    Int32,
        nsfw        Bool,
        ip          String   default '',
        userAgent   String   default '',
        createdDate Date materialized toDate(time),
        deviceId    String   default ''
    )
        engine = MergeTree()
            ORDER BY (time, type, entityId, userId)
            SETTINGS index_granularity = 8192;

    create table if not exists default.daily_downloads
    (
        modelId        Int32,
        modelVersionId Int32,
        createdDate    Date,
        downloads      UInt64
    )
        engine = SummingMergeTree()
            ORDER BY (modelId, modelVersionId, createdDate)
            SETTINGS index_granularity = 8192;

    create table if not exists default.daily_downloads_unique
    (
        modelId        Int32,
        modelVersionId Int32,
        createdDate    Date,
        users_state AggregateFunction(uniq, String)
    )
        engine = SummingMergeTree()
            ORDER BY (modelId, modelVersionId, createdDate)
            SETTINGS index_granularity = 8192;

    create table if not exists default.daily_generation_counts
    (
        createdDate Date,
        count       UInt32,
        nsfw        UInt32
    )
        engine = SummingMergeTree()
            ORDER BY createdDate
            SETTINGS index_granularity = 8192;

    create table if not exists orchestration.daily_generation_counts
    (
        createdDate Date,
        count       UInt32
    )
        engine = SummingMergeTree()
            ORDER BY createdDate
            SETTINGS index_granularity = 8192;

    create table if not exists default.daily_generation_user_counts
    (
        createdDate Date,
        users_state AggregateFunction(uniq, Int32),
        users_nsfw_state AggregateFunction(uniqIf, Int32, UInt8)
    )
        engine = AggregatingMergeTree()
            ORDER BY createdDate
            SETTINGS index_granularity = 8192;

    create table if not exists orchestration.daily_generation_user_counts
    (
        createdDate Date,
        users_state AggregateFunction(uniq, Int32)
    )
        engine = AggregatingMergeTree()
            ORDER BY createdDate
            SETTINGS index_granularity = 8192;

    create table if not exists default.daily_resource_generation_counts
    (
        modelVersionId Int32,
        createdDate    Date,
        count          UInt64
    )
        engine = AggregatingMergeTree()
            ORDER BY (modelVersionId, createdDate)
            SETTINGS index_granularity = 8192;

    create table if not exists orchestration.daily_resource_generation_counts
    (
        modelVersionId Int32,
        createdDate    Date,
        count          UInt64
    )
        engine = SummingMergeTree()
            ORDER BY (modelVersionId, createdDate)
            SETTINGS index_granularity = 8192;

    create table if not exists default.daily_resource_generation_counts_all
    (
        modelVersionId Int32,
        createdDate    Date,
        count          UInt64
    )
        engine = AggregatingMergeTree()
            ORDER BY (modelVersionId, createdDate)
            SETTINGS index_granularity = 8192;

    create table if not exists default.daily_resource_generation_user_counts
    (
        modelVersionId Int32,
        createdDate    Date,
        users_state AggregateFunction(uniq, Int32)
    )
        engine = AggregatingMergeTree()
            ORDER BY (modelVersionId, createdDate)
            SETTINGS index_granularity = 8192;

    create table if not exists default.daily_runs
    (
        modelId        Int32,
        modelVersionId Int32,
        partnerId      Int32,
        createdDate    Date,
        runs           UInt64
    )
        engine = SummingMergeTree()
            ORDER BY (modelId, modelVersionId, createdDate)
            SETTINGS index_granularity = 8192;

    create table if not exists default.daily_user_counts
    (
        createdDate Date,
        authed_users_state AggregateFunction(uniqIf, Int32, UInt8),
        unauthed_users_state AggregateFunction(uniqIf, String, UInt8)
    )
        engine = AggregatingMergeTree()
            ORDER BY createdDate
            SETTINGS index_granularity = 8192;

    create table if not exists default.daily_user_downloads
    (
        userKey       String,
        authenticated Bool,
        createdDate   Date,
        count         Int32
    )
        engine = SummingMergeTree()
            ORDER BY (userKey, authenticated, createdDate)
            SETTINGS index_granularity = 8192;

    create table if not exists default.daily_user_generation_counts
    (
        userId      Int32,
        createdDate Date,
        count       UInt64
    )
        engine = SummingMergeTree()
            ORDER BY (userId, createdDate)
            SETTINGS index_granularity = 8192;

    create table if not exists default.daily_user_resource
    (
        userId         Int32,
        modelVersionId Int32,
        date           Date
    )
        engine = MergeTree()
            ORDER BY (modelVersionId, date)
            SETTINGS index_granularity = 8192;

    create table if not exists default.daily_views
    (
        entityType Enum8('User' = 1, 'Image' = 2, 'Post' = 3, 'Model' = 4, 'ModelVersion' = 5, 'Article' = 6, 'Collection' = 7, 'Bounty' = 8, 'BountyEntry' = 9),
        entityId    UInt32,
        createdDate Date,
        views       UInt64
    )
        engine = SummingMergeTree()
            ORDER BY (entityType, entityId, createdDate)
            SETTINGS index_granularity = 8192;

    create table if not exists default.entityMetricEvents
    (
        entityType LowCardinality(String),
        entityId    Int32,
        userId      Int32,
        metricType LowCardinality(String),
        metricValue Int32,
        createdAt   DateTime64(3)
    )
        engine = MergeTree()
            ORDER BY (entityType, entityId, createdAt)
            SETTINGS index_granularity = 8192;

    create table if not exists orchestration.failedTextToImageJobs
    (
        jobId                   String,
        imageHash               String,
        userId                  Int32,
        createdAt               DateTime64(3),
        completedAt             DateTime64(3),
        provider LowCardinality(String),
        prompt                  String,
        negativePrompt          String,
        resourcesUsed Array(Int32),
        claimDurationMS         Int32,
        jobDurationMS           Int32,
        is_csam Nullable(Bool),
        is_nsfw Nullable(Bool),
        actualStartDateOffsetMS Int32,
        jobCost                 Float64,
        issuedBy LowCardinality(String),
        creatorsTip             Float64
    )
        engine = MergeTree()
            ORDER BY createdAt
            SETTINGS index_granularity = 8192;

    create table if not exists default.files
    (
        type Enum8('Download' = 1),
        entityType  String,
        entityId    Int32,
        time        DateTime default now(),
        userId      Int32    default 0,
        ip          String   default '',
        userAgent   String   default '',
        createdDate Date materialized toDate(time),
        deviceId    String   default ''
    )
        engine = MergeTree()
            ORDER BY (time, type, entityId)
            SETTINGS index_granularity = 8192;

    create table if not exists default.files_old
    (
        type Enum8('Download' = 1),
        entityType  String,
        entityId    Int32,
        time        DateTime default now(),
        userId      Int32    default 0,
        ip          String   default '',
        userAgent   String   default '',
        createdDate Date materialized toDate(time)
    )
        engine = MergeTree()
            PARTITION BY toYYYYMM(createdDate)
            ORDER BY (time, type, entityId)
            SETTINGS index_granularity = 8192;

    create table if not exists default.images
    (
        type Enum8('Create' = 1, 'Delete' = 2, 'DeleteTOS' = 3, 'Tags' = 4, 'Resources' = 5, 'Restore' = 6, 'Play' = 7),
        time        DateTime             default now(),
        userId      Int32                default 0,
        imageId     Int32,
        tags Array(String),
        nsfw Enum8('None' = 1, 'Soft' = 2, 'Mature' = 3, 'X' = 4, 'Blocked' = 5),
        ip          String               default '',
        userAgent   String               default '',
        createdDate Date materialized toDate(time),
        ownerId     Int32                default 0,
        tosReason LowCardinality(Nullable(String)),
        resources Array(Int32),
        mediaType LowCardinality(String) default 'image',
        deviceId    String               default ''
    )
        engine = MergeTree()
            ORDER BY (time, imageId, userId)
            SETTINGS index_granularity = 8192;

    create table if not exists default.images_created
    (
        id        Int32,
        mediaType LowCardinality(String) default 'image',
        createdAt DateTime,
        nsfw Enum8('None' = 1, 'Soft' = 2, 'Mature' = 3, 'X' = 4),
        userId    Int32,
        version   UInt8                  default 1
    )
        engine = ReplacingMergeTree()
            ORDER BY id
            SETTINGS index_granularity = 8192;

    create table if not exists orchestration.jobs
    (
        jobId       String,
        userId      Int32,
        jobType LowCardinality(String),
        createdAt   DateTime64(3),
        completedAt DateTime64(3),
        provider LowCardinality(String),
        issuedBy    String,
        cost        Float64,
        creatorsTip Nullable(Float64),
        resourcesUsed Array(Int32) default [],
        remixOfId Nullable(String)
    )
        engine = MergeTree()
            ORDER BY createdAt
            SETTINGS index_granularity = 8192;

    create table if not exists default.labeledPrompts
    (
        time   DateTime                                   default now(),
        prompt String,
        label Enum8('safe' = 1, 'sexual' = 2, 'csam' = 3) default 'csam'
    )
        engine = MergeTree()
            ORDER BY time
            SETTINGS index_granularity = 8192;

    create table if not exists default.modelEngagements
    (
        type Enum8('Hide' = 1, 'Favorite' = 2, 'Delete' = 3, 'Notify' = 4),
        time        DateTime default now(),
        userId      Int32    default 0,
        modelId     Int32,
        ip          String   default '',
        userAgent   String   default '',
        createdDate Date materialized toDate(time),
        deviceId    String   default ''
    )
        engine = MergeTree()
            PARTITION BY toYYYYMM(createdDate)
            ORDER BY (time, type, modelId)
            SETTINGS index_granularity = 8192;

    create table if not exists default.modelEvents
    (
        type Enum8('Create' = 1, 'Publish' = 2, 'Update' = 3, 'Unpublish' = 4, 'Archive' = 5, 'Takedown' = 6, 'Delete' = 7, 'PermanentDelete' = 8),
        time        DateTime default now(),
        userId      Int32    default 0,
        modelId     Int32,
        nsfw        Bool,
        ip          String   default '',
        userAgent   String   default '',
        createdDate Date materialized toDate(time),
        deviceId    String   default ''
    )
        engine = MergeTree()
            ORDER BY (time, modelId, userId)
            SETTINGS index_granularity = 8192;

    create table if not exists default.modelFileEvents
    (
        type Enum8('Create' = 1, 'Update' = 2, 'Delete' = 3),
        time           DateTime default now(),
        userId         Int32    default 0,
        id             Int32,
        modelVersionId Int32,
        ip             String   default '',
        userAgent      String   default '',
        createdDate    Date materialized toDate(time),
        deviceId       String   default ''
    )
        engine = MergeTree()
            ORDER BY (time, type, id, modelVersionId)
            SETTINGS index_granularity = 8192;

    create table if not exists default.modelVersionEvents
    (
        type Enum8('Create' = 1, 'Publish' = 2, 'Download' = 3, 'Unpublish' = 4, 'HideDownload' = 5),
        time           DateTime default now(),
        userId         Int32    default 0,
        modelId        Int32,
        modelVersionId Int32,
        nsfw           Bool,
        ip             String   default '',
        userAgent      String   default '',
        createdDate    Date materialized toDate(time),
        earlyAccess    Bool     default false,
        deviceId       String   default ''
    )
        engine = MergeTree()
            PARTITION BY toYYYYMM(createdDate)
            ORDER BY (time, type, modelId, modelVersionId)
            SETTINGS index_granularity = 8192;

    create table if not exists default.pageViews
    (
        pageId LowCardinality(String),
        time         DateTime default now(),
        userId       Int32    default 0,
        memberType LowCardinality(String),
        host LowCardinality(String),
        path         String,
        duration     UInt32,
        ip           String,
        ads          Bool,
        country LowCardinality(String),
        windowWidth  Int16    default 0,
        windowHeight Int16    default 0
    )
        engine = MergeTree()
            PARTITION BY toYYYYMM(time)
            ORDER BY (time, pageId, userId)
            SETTINGS index_granularity = 8192;

    create table if not exists default.partnerEvents
    (
        type Enum8('Run' = 1, 'Update' = 2),
        time           DateTime default now(),
        userId         Int32    default 0,
        partnerId      Int32,
        modelId        Int32    default 0,
        modelVersionId Int32    default 0,
        nsfw           Bool,
        ip             String   default '',
        userAgent      String   default '',
        createdDate    Date materialized toDate(time),
        deviceId       String   default ''
    )
        engine = MergeTree()
            ORDER BY (time, type, partnerId)
            SETTINGS index_granularity = 8192;

    create table if not exists default.partner_events_temp
    (
        type Enum8('Run' = 1, 'Update' = 2),
        time           DateTime,
        userId         Int32  default 0,
        partnerId      Int32  default 0,
        modelId        Int32  default 0,
        modelVersionId Int32  default 0,
        nsfw           Bool,
        ip             String default '',
        userAgent      String default ''
    )
        engine = MergeTree()
            ORDER BY (time, partnerId)
            SETTINGS index_granularity = 8192;

    create table if not exists default.posts
    (
        type Enum8('Create' = 1, 'Publish' = 2, 'Tags' = 3, 'Delete' = 4),
        time        DateTime default now(),
        userId      Int32    default 0,
        postId      Int32,
        tags Array(String),
        nsfw        Bool,
        ip          String   default '',
        userAgent   String   default '',
        createdDate Date materialized toDate(time),
        deviceId    String   default ''
    )
        engine = MergeTree()
            PARTITION BY toYear(createdDate)
            ORDER BY (time, postId, userId)
            SETTINGS index_granularity = 8192;

    create table if not exists default.prohibitedRequests
    (
        time        DateTime                      default now(),
        userId      Int32                         default 0,
        prompt      String,
        ip          String                        default '',
        userAgent   String                        default '',
        createdDate Date materialized toDate(time),
        source Enum8('Regex' = 1, 'External' = 2) default 'Regex',
        negativePrompt Nullable(String),
        deviceId    String                        default ''
    )
        engine = MergeTree()
            ORDER BY (time, userId)
            SETTINGS index_granularity = 8192;

    create table if not exists default.questions
    (
        type Enum8('Create' = 1, 'Delete' = 2),
        time        DateTime default now(),
        userId      Int32    default 0,
        questionId  Int32,
        tags Array(String),
        ip          String   default '',
        userAgent   String   default '',
        createdDate Date materialized toDate(time)
    )
        engine = MergeTree()
            ORDER BY (time, questionId, userId)
            SETTINGS index_granularity = 8192;

    create table if not exists default.reactions
    (
        type Enum8('Image_Create' = 1, 'Image_Delete' = 2, 'Comment_Create' = 3, 'Comment_Delete' = 4, 'CommentV2_Create' = 5, 'CommentV2_Delete' = 6, 'Review_Create' = 7, 'Review_Delete' = 8, 'Question_Create' = 9, 'Question_Delete' = 10, 'Answer_Create' = 11, 'Answer_Delete' = 12, 'BountyEntry_Create' = 13, 'BountyEntry_Delete' = 14, 'Article_Create' = 15, 'Article_Delete' = 16),
        time        DateTime default now(),
        userId      Int32    default 0,
        entityId    Int32,
        reaction Enum8('Like' = 1, 'Dislike' = 2, 'Laugh' = 3, 'Cry' = 4, 'Heart' = 5),
        nsfw Enum8('Undefined' = 0, 'None' = 1, 'Soft' = 2, 'Mature' = 3, 'X' = 4),
        ip          String   default '',
        userAgent   String   default '',
        createdDate Date materialized toDate(time),
        ownerId     Int32    default -1,
        deviceId    String   default ''
    )
        engine = MergeTree()
            PARTITION BY toYYYYMM(createdDate)
            ORDER BY (time, reaction, entityId, userId)
            SETTINGS index_granularity = 8192;

    create table if not exists default.redeemableCodes
    (
        activity LowCardinality(String),
        code        String,
        quantity    Int32    default 1,
        time        DateTime default now(),
        userId      Int32    default 0,
        ip          String   default '',
        userAgent   String   default '',
        createdDate Date materialized toDate(time)
    )
        engine = MergeTree()
            ORDER BY (time, activity, userId)
            SETTINGS index_granularity = 8192;

    create table if not exists default.reports
    (
        type Enum8('Create' = 1, 'StatusChange' = 2),
        time        DateTime default now(),
        userId      Int32    default 0,
        entityType Enum8('model' = 1, 'comment' = 2, 'commentV2' = 3, 'image' = 4, 'resourceReview' = 5, 'article' = 6, 'post' = 7, 'reportedUser' = 8, 'collection' = 9),
        entityId    Int32,
        reason Enum8('TOSViolation' = 1, 'NSFW' = 2, 'Ownership' = 3, 'AdminAttention' = 4, 'Claim' = 5),
        status Enum8('Pending' = 1, 'Processing' = 2, 'Actioned' = 3, 'Unactioned' = 4),
        ip          String   default '',
        userAgent   String   default '',
        createdDate Date materialized toDate(time),
        deviceId    String   default ''
    )
        engine = MergeTree()
            ORDER BY (time, type, userId, entityId)
            SETTINGS index_granularity = 8192;

    create table if not exists default.resourceReviews
    (
        type Enum8('Create' = 1, 'Delete' = 2, 'Exclude' = 3, 'Include' = 4, 'Update' = 5),
        time           DateTime default now(),
        userId         Int32    default 0,
        modelId        Int32,
        modelVersionId Int32,
        nsfw           Bool,
        rating         Int32,
        ip             String   default '',
        userAgent      String   default '',
        createdDate    Date materialized toDate(time),
        deviceId       String   default ''
    )
        engine = MergeTree()
            PARTITION BY toYear(createdDate)
            ORDER BY (time, type, modelId, modelVersionId, userId)
            SETTINGS index_granularity = 8192;

    create table if not exists default.search
    (
        query       String,
        "index"     String   default '',
        filters     String   default '',
        time        DateTime default now(),
        userId      Int32    default 0,
        ip          String   default '',
        userAgent   String   default '',
        createdDate Date materialized toDate(time),
        deviceId    String   default ''
    )
        engine = MergeTree()
            PARTITION BY toYYYYMM(createdDate)
            ORDER BY time
            SETTINGS index_granularity = 8192;

    create table if not exists default.shares
    (
        url         String,
        platform Enum8('reddit' = 1, 'twitter' = 2, 'clipboard' = 3),
        time        DateTime default now(),
        userId      Int32    default 0,
        ip          String   default '',
        userAgent   String   default '',
        createdDate Date materialized toDate(time),
        deviceId    String   default ''
    )
        engine = MergeTree()
            ORDER BY (time, platform, userId)
            SETTINGS index_granularity = 8192;

    create table if not exists default.tagEngagements
    (
        type Enum8('Hide' = 1, 'Allow' = 2),
        time        DateTime default now(),
        userId      Int32    default 0,
        tagId       Int32,
        ip          String   default '',
        userAgent   String   default '',
        createdDate Date materialized toDate(time)
    )
        engine = MergeTree()
            ORDER BY (time, tagId, userId)
            SETTINGS index_granularity = 8192;

    create table if not exists orchestration.taintedTextToImageJobs
    (
        jobId     String,
        taintedAt DateTime64(3),
        reason    String
    )
        engine = MergeTree()
            ORDER BY taintedAt
            SETTINGS index_granularity = 8192;

    create table if not exists orchestration.textToImageJobs
    (
        jobId                   String,
        imageHash               String,
        userId                  Int32,
        createdAt               DateTime64(3),
        completedAt             DateTime64(3),
        provider LowCardinality(String),
        prompt                  String,
        negativePrompt          String,
        resourcesUsed Array(Int32),
        claimDurationMS         Int32,
        jobDurationMS           Int32,
        is_csam Nullable(Bool),
        is_nsfw Nullable(Bool),
        actualStartDateOffsetMS Int32,
        jobCost                 Float64,
        issuedBy LowCardinality(String),
        movieRatingMS           Int32,
        movieRatingModel LowCardinality(String),
        movieRating LowCardinality(String),
        creatorsTip             Float64
    )
        engine = MergeTree()
            ORDER BY createdAt
            SETTINGS index_granularity = 8192;

    create table if not exists default.userActivities
    (
        type Enum8('Registration' = 1, 'Account closure' = 2, 'Subscribe' = 3, 'Cancel' = 4, 'Donate' = 5, 'Adjust Moderated Content Settings' = 6, 'Banned' = 7, 'Unbanned' = 8, 'Muted' = 9, 'Unmuted' = 10, 'RemoveContent' = 11, 'ExcludedFromLeaderboard' = 12, 'UnexcludedFromLeaderboard' = 13),
        time         DateTime default now(),
        userId       Int32    default 0,
        targetUserId Int32    default 0,
        ip           String   default '',
        userAgent    String   default '',
        createdDate  Date materialized toDate(time),
        landingPage  String,
        deviceId     String   default ''
    )
        engine = MergeTree()
            PARTITION BY toYear(createdDate)
            ORDER BY (time, type, userId)
            SETTINGS index_granularity = 8192;

    create table if not exists default.userEngagements
    (
        type Enum8('Hide' = 1, 'Follow' = 2, 'Delete' = 3),
        time         DateTime default now(),
        userId       Int32    default 0,
        targetUserId Int32,
        ip           String   default '',
        userAgent    String   default '',
        createdDate  Date materialized toDate(time),
        deviceId     String   default ''
    )
        engine = MergeTree()
            PARTITION BY toYear(createdDate)
            ORDER BY (time, type, targetUserId, userId)
            SETTINGS index_granularity = 8192;

    create table if not exists default.views
    (
        type Enum8('ProfileView' = 1, 'ImageView' = 2, 'PostView' = 3, 'ModelView' = 4, 'ModelVersionView' = 5, 'ArticleView' = 6, 'CollectionView' = 7, 'BountyView' = 8, 'BountyEntryView' = 9),
        time          DateTime                                          default now(),
        userId        Int32                                             default 0,
        entityType Enum8('User' = 1, 'Image' = 2, 'Post' = 3, 'Model' = 4, 'ModelVersion' = 5, 'Article' = 6, 'Collection' = 7, 'Bounty' = 8, 'BountyEntry' = 9),
        entityId      Int32,
        ip            String                                            default '',
        userAgent     String                                            default '',
        createdDate   Date materialized toDate(time),
        ads Enum8('Member' = 1, 'Served' = 2, 'Blocked' = 3, 'Off' = 4) default 'Off',
        nsfw          Bool                                              default false,
        browsingLevel Int32,
        deviceId      String                                            default '',
        isMember Nullable(Bool)                                         default NULL
    )
        engine = MergeTree()
            PARTITION BY toYYYYMM(createdDate)
            ORDER BY (time, entityType, entityId, userId)
            SETTINGS index_granularity = 8192;

    create table if not exists default.views_images_counts
    (
        imageId UInt32,
        views   UInt64
    )
        engine = SummingMergeTree()
            ORDER BY imageId
            SETTINGS index_granularity = 8192;

    create table if not exists orchestration.workerResources
    (
        provider LowCardinality(String),
        workerId String,
        resource String,
        size     Int64,
        first    DateTime,
        last     DateTime,
        jobs     Int32,
        reason LowCardinality(String)
    )
        engine = MergeTree()
            ORDER BY (provider, workerId, resource, first)
            SETTINGS index_granularity = 8192;

    create table if not exists orchestration.workers
    (
        provider LowCardinality(String),
        id           String,
        nodeId       String,
        name         String,
        registeredAt DateTime,
        ecosystems Array(LowCardinality(String)),
        onDemandResources Array(LowCardinality(String)),
        type LowCardinality(String),
        totalJobsClaimed Nullable(Int32),
        totalJobsSucceeded Nullable(Int32),
        totalCostClaimed Nullable(Float32),
        totalCostSucceeded Nullable(Float32),
        destroyedAt Nullable(DateTime),
        destroyedReason LowCardinality(String)
    )
        engine = ReplacingMergeTree()
            ORDER BY id
            SETTINGS index_granularity = 8192;

    create table if not exists default.blocked_images
    (
        hash Int64,
        reason LowCardinality(String),
        created_at DateTime DEFAULT now()
    ) engine = ReplacingMergeTree(created_at)
    ORDER BY hash;

    CREATE MATERIALIZED VIEW default.buzz_cohorts_first_seen
                (
                userId Int32,
                purchase_type String,
                firstSeenDate DateTime,
                firstSeenMonth Date
                    )
                ENGINE = AggregatingMergeTree()
                    ORDER BY (userId, purchase_type)
                    SETTINGS index_granularity = 8192
    AS
    SELECT toAccountId                                                                            AS userId,
        if(description IN ('Membership bonus', 'Membership bonus.'), 'membership', 'purchase') AS purchase_type,
        min(date)                                                                              AS firstSeenDate,
        toStartOfMonth(firstSeenDate)                                                          AS firstSeenMonth
    FROM default.buzzTransactions
    WHERE (toAccountId > 0)
    AND (toAccountType = 'user')
    AND ((type = 'purchase') OR ((type = 'reward') AND (description IN ('Membership bonus', 'Membership bonus.'))))
    GROUP BY 1,
            2;

    CREATE MATERIALIZED VIEW default.buzz_cohorts_monthly_activity
                (
                firstSeenMonth Date,
                purchase_type String,
                activityMonth Date,
                users_state AggregateFunction(uniq, Int32)
                    )
                ENGINE = SummingMergeTree()
                    ORDER BY (firstSeenMonth, purchase_type, activityMonth)
                    SETTINGS index_granularity = 8192
    AS
    SELECT fm.firstSeenMonth,
        fm.purchase_type,
        toStartOfMonth(v.date)   AS activityMonth,
        uniqState(v.toAccountId) AS users_state
    FROM default.buzzTransactions AS v
            INNER JOIN default.buzz_cohorts_first_seen AS fm ON (v.toAccountId = fm.userId) AND (if(description IN
                                                                                                    ('Membership bonus',
                                                                                                    'Membership bonus.'),
                                                                                                    'membership',
                                                                                                    'purchase') =
                                                                                                fm.purchase_type)
    WHERE (toAccountId > 0)
    AND (toAccountType = 'user')
    AND ((type = 'purchase') OR ((type = 'reward') AND (description IN ('Membership bonus', 'Membership bonus.'))))
    GROUP BY fm.firstSeenMonth,
            fm.purchase_type,
            activityMonth;

    CREATE MATERIALIZED VIEW default.cohorts_first_seen
                (
                userId Int32,
                firstSeenDate Date,
                firstSeenMonth Date
                    )
                ENGINE = AggregatingMergeTree()
                    ORDER BY userId
                    SETTINGS index_granularity = 8192
    AS
    SELECT userId,
        min(createdDate)              AS firstSeenDate,
        toStartOfMonth(firstSeenDate) AS firstSeenMonth
    FROM default.views
    WHERE (createdDate >= '2023-04-01')
    AND (userId > 0)
    GROUP BY userId;

    CREATE MATERIALIZED VIEW default.cohorts_first_seen_combined
                (
                userId Int32,
                firstSeenMonth Date,
                firstSeenDate Date,
                hasViewedImage Bool,
                hasViewedModel Bool,
                hasViewedProfile Bool,
                hasViewedCollection Bool,
                hasGeneratedImage Bool,
                hasPostedImage Bool,
                hasCreatedModel Bool,
                hasPublishedModel Bool
                    )
                ENGINE = AggregatingMergeTree()
                    ORDER BY userId
                    SETTINGS index_granularity = 8192
    AS
    SELECT v.userId                                            AS userId,
        max(v.firstSeenMonth)                               AS firstSeenMonth,
        max(v.firstSeenDate)                                AS firstSeenDate,
        if(sum(iv.image_views) > 0, true, false)            AS hasViewedImage,
        if(sum(iv.model_views) > 0, true, false)            AS hasViewedModel,
        if(sum(iv.profile_views) > 0, true, false)          AS hasViewedProfile,
        if(sum(iv.collection_views) > 0, true, false)       AS hasViewedCollection,
        if(sum(ig.total_images_generated) > 0, true, false) AS hasGeneratedImage,
        if(sum(ip.total_images_posted) > 0, true, false)    AS hasPostedImage,
        if(sum(mp.models_created) > 0, true, false)         AS hasCreatedModel,
        if(sum(mp.models_published) > 0, true, false)       AS hasPublishedModel
    FROM default.cohorts_first_seen AS v
            LEFT JOIN default.user_views AS iv ON v.userId = iv.userId
            LEFT JOIN default.user_image_generation AS ig ON v.userId = ig.userId
            LEFT JOIN default.user_image_posts AS ip ON v.userId = ip.userId
            LEFT JOIN default.user_model_posts AS mp ON v.userId = mp.userId
    WHERE v.userId > 0
    GROUP BY v.userId;

    CREATE MATERIALIZED VIEW default.cohorts_grouped_by_activity
                (
                firstSeenMonth Date,
                hasViewedImage Bool,
                hasViewedModel Bool,
                hasViewedProfile Bool,
                hasViewedCollection Bool,
                hasGeneratedImage Bool,
                hasPostedImage Bool,
                hasCreatedModel Bool,
                hasPublishedModel Bool,
                userCount AggregateFunction(count, Int32)
                    )
                ENGINE = AggregatingMergeTree()
                    ORDER BY (firstSeenMonth, hasViewedImage, hasViewedModel, hasViewedProfile, hasViewedCollection,
                            hasGeneratedImage, hasPostedImage, hasCreatedModel, hasPublishedModel)
                    SETTINGS index_granularity = 8192
    AS
    SELECT firstSeenMonth,
        hasViewedImage,
        hasViewedModel,
        hasViewedProfile,
        hasViewedCollection,
        hasGeneratedImage,
        hasPostedImage,
        hasCreatedModel,
        hasPublishedModel,
        countState(userId) AS userCount
    FROM default.cohorts_first_seen_combined
    GROUP BY firstSeenMonth,
            hasViewedImage,
            hasViewedModel,
            hasViewedProfile,
            hasViewedCollection,
            hasGeneratedImage,
            hasPostedImage,
            hasCreatedModel,
            hasPublishedModel;

    CREATE MATERIALIZED VIEW default.cohorts_monthly_activity
                (
                firstSeenMonth Date,
                activityMonth Date,
                hasViewedImage Bool,
                hasViewedModel Bool,
                hasViewedProfile Bool,
                hasViewedCollection Bool,
                hasGeneratedImage Bool,
                hasPostedImage Bool,
                hasCreatedModel Bool,
                hasPublishedModel Bool,
                users_state AggregateFunction(uniq, Int32)
                    )
                ENGINE = SummingMergeTree()
                    ORDER BY (firstSeenMonth, activityMonth, hasViewedImage, hasViewedModel, hasViewedProfile,
                            hasViewedCollection, hasGeneratedImage, hasPostedImage, hasCreatedModel, hasPublishedModel)
                    SETTINGS index_granularity = 8192
    AS
    SELECT fm.firstSeenMonth,
        toStartOfMonth(v.createdDate) AS activityMonth,
        hasViewedImage,
        hasViewedModel,
        hasViewedProfile,
        hasViewedCollection,
        hasGeneratedImage,
        hasPostedImage,
        hasCreatedModel,
        hasPublishedModel,
        uniqState(v.userId)           AS users_state
    FROM default.views AS v
            INNER JOIN default.cohorts_first_seen_combined AS fm ON v.userId = fm.userId
    WHERE v.createdDate >= '2023-04-01'
    GROUP BY firstSeenMonth,
            activityMonth,
            hasViewedImage,
            hasViewedModel,
            hasViewedProfile,
            hasViewedCollection,
            hasGeneratedImage,
            hasPostedImage,
            hasCreatedModel,
            hasPublishedModel;

    CREATE MATERIALIZED VIEW default.cohorts_pivoted_activity
                (
                firstSeenMonth Date,
                month_1 UInt64,
                month_2 UInt64,
                month_3 UInt64,
                month_4 UInt64,
                month_5 UInt64,
                month_6 UInt64,
                month_7 UInt64,
                month_8 UInt64,
                month_9 UInt64,
                month_10 UInt64,
                month_11 UInt64,
                month_12 UInt64
                    )
                ENGINE = AggregatingMergeTree()
                    PARTITION BY firstSeenMonth
                    ORDER BY firstSeenMonth
                    SETTINGS index_granularity = 8192
    AS
    SELECT firstSeenMonth,
        countIf(activityMonth = subtractMonths(toStartOfMonth(today()), 11)) AS month_1,
        countIf(activityMonth = subtractMonths(toStartOfMonth(today()), 10)) AS month_2,
        countIf(activityMonth = subtractMonths(toStartOfMonth(today()), 9))  AS month_3,
        countIf(activityMonth = subtractMonths(toStartOfMonth(today()), 8))  AS month_4,
        countIf(activityMonth = subtractMonths(toStartOfMonth(today()), 7))  AS month_5,
        countIf(activityMonth = subtractMonths(toStartOfMonth(today()), 6))  AS month_6,
        countIf(activityMonth = subtractMonths(toStartOfMonth(today()), 5))  AS month_7,
        countIf(activityMonth = subtractMonths(toStartOfMonth(today()), 4))  AS month_8,
        countIf(activityMonth = subtractMonths(toStartOfMonth(today()), 3))  AS month_9,
        countIf(activityMonth = subtractMonths(toStartOfMonth(today()), 2))  AS month_10,
        countIf(activityMonth = subtractMonths(toStartOfMonth(today()), 1))  AS month_11,
        countIf(activityMonth = toStartOfMonth(today()))                     AS month_12
    FROM default.cohorts_monthly_activity
    GROUP BY firstSeenMonth;

    CREATE MATERIALIZED VIEW default.daily_downloads_mv
                TO default.daily_downloads
                (
                modelId Int32,
                modelVersionId Int32,
                createdDate Date,
                downloads UInt64
                    )
    AS
    SELECT modelId,
        modelVersionId,
        createdDate,
        count(*) AS downloads
    FROM default.modelVersionEvents
    WHERE type = 'Download'
    GROUP BY 1,
            2,
            3;

    CREATE MATERIALIZED VIEW default.daily_downloads_unique_mv
                TO default.daily_downloads_unique
                (
                modelId Int32,
                modelVersionId Int32,
                createdDate Date,
                users_state AggregateFunction(uniq, String)
                    )
    AS
    SELECT modelId,
        modelVersionId,
        createdDate,
        uniqState(if(userId = 0, ip, toString(userId))) AS users_state
    FROM default.modelVersionEvents
    WHERE type = 'Download'
    GROUP BY 1,
            2,
            3;

    CREATE MATERIALIZED VIEW default.daily_generation_counts_mv
                TO default.daily_generation_counts
                (
                createdDate DateTime,
                count UInt64,
                nsfw UInt64
                    )
    AS
    SELECT toStartOfDay(createdAt)                                           AS createdDate,
        count(*)                                                          AS count,
        countIf(has(resourcesUsed, 250708) OR has(resourcesUsed, 250712)) AS nsfw
    FROM orchestration.textToImageJobs
    GROUP BY createdDate;

    CREATE MATERIALIZED VIEW default.daily_generation_user_counts_mv
                TO default.daily_generation_user_counts
                (
                createdDate DateTime,
                users_state AggregateFunction(uniq, Int32),
                users_nsfw_state AggregateFunction(uniqIf, Int32, UInt8)
                    )
    AS
    SELECT toStartOfDay(createdAt)                                                       AS createdDate,
        uniqState(userId)                                                             AS users_state,
        uniqIfState(userId, has(resourcesUsed, 250708) OR has(resourcesUsed, 250712)) AS users_nsfw_state
    FROM orchestration.textToImageJobs
    GROUP BY createdDate;

    CREATE MATERIALIZED VIEW default.daily_resource_generation_counts_all_mv
                TO default.daily_resource_generation_counts_all
                (
                modelVersionId Int32,
                createdDate Date,
                count UInt64
                    )
    AS
    SELECT modelVersionId,
        date     AS createdDate,
        count(*) AS count
    FROM default.daily_user_resource
    GROUP BY modelVersionId,
            date;

    CREATE MATERIALIZED VIEW default.daily_resource_generation_counts_mv
                TO default.daily_resource_generation_counts
                (
                modelVersionId Int32,
                createdDate Date,
                count UInt64
                    )
    AS
    SELECT modelVersionId,
        date     AS createdDate,
        count(*) AS count
    FROM default.daily_user_resource
    GROUP BY modelVersionId,
            date;

    CREATE MATERIALIZED VIEW default.daily_resource_generation_user_counts_mv
                TO default.daily_resource_generation_user_counts
                (
                modelVersionId Int32,
                date Date,
                users_state AggregateFunction(uniq, Int32)
                    )
    AS
    SELECT modelVersionId,
        date,
        uniqState(userId) AS users_state
    FROM default.daily_user_resource
    WHERE modelVersionId NOT IN (250708, 250712, 106916)
    GROUP BY modelVersionId,
            date;

    CREATE MATERIALIZED VIEW default.daily_runs_mv
                TO default.daily_runs
                (
                modelId Int32,
                modelVersionId Int32,
                partnerId Int32,
                createdDate Date,
                runs UInt64
                    )
    AS
    SELECT modelId,
        modelVersionId,
        partnerId,
        createdDate,
        count(*) AS runs
    FROM default.partnerEvents
    WHERE type = 'Run'
    GROUP BY 1,
            2,
            3,
            4;

    CREATE MATERIALIZED VIEW default.daily_user_counts_mv
                TO default.daily_user_counts
                (
                createdDate Date,
                authed_users_state AggregateFunction(uniqIf, Int32, UInt8),
                unauthed_users_state AggregateFunction(uniqIf, String, UInt8)
                    )
    AS
    SELECT createdDate,
        uniqIfState(userId, userId != 0) AS authed_users_state,
        uniqIfState(ip, userId = 0)      AS unauthed_users_state
    FROM default.views
    GROUP BY createdDate;

    CREATE MATERIALIZED VIEW default.daily_user_downloads_mv
                TO default.daily_user_downloads
                (
                userKey String,
                authenticated UInt8,
                createdDate Date,
                count UInt64
                    )
    AS
    SELECT if(userId = 0, ip, toString(userId)) AS userKey,
        userId != 0                          AS authenticated,
        createdDate,
        count(*)                             AS count
    FROM default.modelVersionEvents
    WHERE type = 'Download'
    GROUP BY 1,
            2,
            3;

    CREATE MATERIALIZED VIEW default.daily_user_generation_counts_mv
                TO default.daily_user_generation_counts
                (
                userId Int32,
                date DateTime,
                count UInt64
                    )
    AS
    SELECT userId,
        toStartOfDay(createdAt) AS date,
        count(*)                AS count
    FROM orchestration.textToImageJobs
    GROUP BY userId,
            date;

    CREATE MATERIALIZED VIEW default.daily_user_resource_mv
                TO default.daily_user_resource
                (
                userId Int32,
                modelVersionId Int32,
                date DateTime
                    )
    AS
    SELECT userId,
        arrayJoin(resourcesUsed) AS modelVersionId,
        toStartOfDay(createdAt)  AS date
    FROM orchestration.textToImageJobs;

    CREATE MATERIALIZED VIEW default.daily_views_mv
                TO default.daily_views
                (
                entityType Enum8('User' = 1, 'Image' = 2, 'Post' = 3, 'Model' = 4, 'ModelVersion' = 5, 'Article' = 6, 'Collection' = 7, 'Bounty' = 8, 'BountyEntry' = 9),
                entityId Int32,
                createdDate Date,
                views UInt64
                    )
    AS
    SELECT entityType,
        entityId,
        createdDate,
        count(*) AS views
    FROM default.views
    GROUP BY 1,
            2,
            3;

    CREATE MATERIALIZED VIEW default.modelVersionUniqueDownloads
                (
                modelVersionId Int32,
                downloadKey String,
                time SimpleAggregateFunction(max, DateTime)
                    )
                ENGINE = AggregatingMergeTree()
                    PARTITION BY toYYYYMM(time)
                    ORDER BY (modelVersionId, downloadKey)
                    SETTINGS index_granularity = 8192
    AS
    SELECT modelVersionId,
        if(userId = 0, ip, toString(userId)) AS downloadKey,
        max(time)                            AS time
    FROM default.modelVersionEvents
    WHERE type = 'Download'
    GROUP BY modelVersionId,
            downloadKey;

    CREATE MATERIALIZED VIEW default.uniqueViews
                (
                type String,
                entityId Int32,
                viewKey String,
                time SimpleAggregateFunction(max, DateTime)
                    )
                ENGINE = AggregatingMergeTree()
                    PARTITION BY toYYYYMM(time)
                    ORDER BY (type, entityId, viewKey)
                    SETTINGS index_granularity = 8192
    AS
    SELECT type,
        entityId,
        if(userId = 0, ip, toString(userId)) AS viewKey,
        max(time)                            AS time
    FROM default.views
    GROUP BY type,
            entityId,
            viewKey;

    CREATE MATERIALIZED VIEW default.uniqueViewsDaily
                (
                type String,
                entityId Int32,
                date Date,
                view_count UInt32
                    )
                ENGINE = SummingMergeTree()
                    PARTITION BY toYYYYMM(date)
                    ORDER BY (type, entityId, date)
                    SETTINGS index_granularity = 8192
    AS
    SELECT type,
        entityId,
        toDate(time) AS date,
        toUInt32(1) AS view_count
    FROM default.views
    GROUP BY type,
            entityId,
            toDate(time),
            if(userId = 0, ip, toString(userId));

    CREATE MATERIALIZED VIEW default.user_activity_combined_pt1
                (
                userId Int32,
                image_views UInt64,
                model_views UInt64,
                profile_views UInt64,
                collection_views UInt64
                    )
                ENGINE = MergeTree()
                    ORDER BY userId
                    SETTINGS index_granularity = 8192
    AS
    SELECT v.userId,
        ifNull(iv.image_views, 0)      AS image_views,
        ifNull(iv.model_views, 0)      AS model_views,
        ifNull(iv.profile_views, 0)    AS profile_views,
        ifNull(iv.collection_views, 0) AS collection_views
    FROM default.cohorts_first_seen AS v
            LEFT JOIN default.user_views AS iv ON v.userId = iv.userId
    WHERE v.userId > 0;

    CREATE MATERIALIZED VIEW default.user_activity_combined_pt2
                (
                userId Int32,
                image_views UInt64,
                model_views UInt64,
                profile_views UInt64,
                collection_views UInt64,
                images_generated UInt64
                    )
                ENGINE = MergeTree()
                    ORDER BY userId
                    SETTINGS index_granularity = 8192
    AS
    SELECT v.userId,
        v.image_views,
        v.model_views,
        v.profile_views,
        v.collection_views,
        ifNull(ig.total_images_generated, 0) AS images_generated
    FROM default.user_activity_combined_pt1 AS v
            LEFT JOIN default.user_image_generation AS ig ON v.userId = ig.userId
    WHERE v.userId > 0;

    CREATE MATERIALIZED VIEW default.user_activity_combined_pt3
                (
                userId Int32,
                image_views UInt64,
                model_views UInt64,
                profile_views UInt64,
                collection_views UInt64,
                images_generated UInt64,
                images_posted UInt64
                    )
                ENGINE = MergeTree()
                    ORDER BY userId
                    SETTINGS index_granularity = 8192
    AS
    SELECT v.userId,
        v.image_views,
        v.model_views,
        v.profile_views,
        v.collection_views,
        v.images_generated,
        ifNull(ip.total_images_posted, 0) AS images_posted
    FROM default.user_activity_combined_pt2 AS v
            LEFT JOIN default.user_image_posts AS ip ON v.userId = ip.userId
    WHERE v.userId > 0;

    CREATE MATERIALIZED VIEW default.user_image_generation
                (
                userId Int32,
                total_images_generated UInt64
                    )
                ENGINE = SummingMergeTree()
                    ORDER BY userId
                    SETTINGS index_granularity = 8192
    AS
    SELECT userId,
        count() AS total_images_generated
    FROM orchestration.textToImageJobs
    WHERE userId > 0
    GROUP BY userId;

    CREATE MATERIALIZED VIEW default.user_image_posts
                (
                userId Int32,
                total_images_posted UInt64
                    )
                ENGINE = SummingMergeTree()
                    ORDER BY userId
                    SETTINGS index_granularity = 8192
    AS
    SELECT userId,
        count() AS total_images_posted
    FROM default.images_created
    WHERE userId > 0
    GROUP BY userId;

    CREATE MATERIALIZED VIEW default.user_model_posts
                (
                userId Int32,
                models_created UInt64,
                models_published UInt64
                    )
                ENGINE = SummingMergeTree()
                    ORDER BY userId
                    SETTINGS index_granularity = 8192
    AS
    SELECT userId,
        countIf(type = 'Create')  AS models_created,
        countIf(type = 'Publish') AS models_published
    FROM default.modelVersionEvents
    WHERE ((type = 'Create') OR (type = 'Publish'))
    AND (userId > 0)
    GROUP BY userId;

    CREATE MATERIALIZED VIEW default.user_views
                (
                userId Int32,
                image_views UInt64,
                model_views UInt64,
                profile_views UInt64,
                collection_views UInt64
                    )
                ENGINE = SummingMergeTree()
                    ORDER BY userId
                    SETTINGS index_granularity = 8192
    AS
    SELECT userId,
        countIf(type = 'ImageView')      AS image_views,
        countIf(type = 'ModelView')      AS model_views,
        countIf(type = 'ProfileView')    AS profile_views,
        countIf(type = 'CollectionView') AS collection_views
    FROM default.views
    WHERE userId > 0
    GROUP BY userId;

    CREATE MATERIALIZED VIEW default.views_images_counts_mv
                TO default.views_images_counts
                (
                imageId Int32,
                count UInt64
                    )
    AS
    SELECT entityId AS imageId,
        count(*) as count
    FROM default.views
    WHERE entityType = 'Image'
    GROUP BY imageId;

    create table if not exists default.knights_new_order_image_rating
    (
        userId       Int32,
        imageId      Int32,
        rating       Int32,
        damnedReason LowCardinality(String),
        status       LowCardinality(String),
        grantedExp   Int32,
        multiplier   Int32,
        createdAt    Datetime
    )
    engine = MergeTree()
        ORDER BY (createdAt, userId)
        SETTINGS index_granularity = 8192;
EOSQL
