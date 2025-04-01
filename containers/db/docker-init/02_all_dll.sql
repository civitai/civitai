select '00_init_db.sql apply starting' as status;

--
-- PostgreSQL database dump
--

-- Dumped from database version 15.8
-- Dumped by pg_dump version 15.8 (Ubuntu 15.8-1.pgdg22.04+1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: citext; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public;


--
-- Name: EXTENSION citext; Type: COMMENT; Schema: -; Owner:
--

COMMENT ON EXTENSION citext IS 'data type for case-insensitive character strings';


--
-- Name: pg_stat_statements; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pg_stat_statements WITH SCHEMA public;


--
-- Name: EXTENSION pg_stat_statements; Type: COMMENT; Schema: -; Owner:
--

COMMENT ON EXTENSION pg_stat_statements IS 'track planning and execution statistics of all SQL statements executed';


--
-- Name: ApiKeyType; Type: TYPE; Schema: public; Owner: doadmin
--

CREATE TYPE public."ApiKeyType" AS ENUM (
    'System',
    'User',
    'Access',
    'Refresh'
);


ALTER TYPE public."ApiKeyType" OWNER TO doadmin;

--
-- Name: ArticleEngagementType; Type: TYPE; Schema: public; Owner: civitai
--

CREATE TYPE public."ArticleEngagementType" AS ENUM (
    'Favorite',
    'Hide'
);


ALTER TYPE public."ArticleEngagementType" OWNER TO civitai;

--
-- Name: AssociationType; Type: TYPE; Schema: public; Owner: civitai
--

CREATE TYPE public."AssociationType" AS ENUM (
    'Suggested'
);


ALTER TYPE public."AssociationType" OWNER TO civitai;

--
-- Name: Availability; Type: TYPE; Schema: public; Owner: civitai
--

CREATE TYPE public."Availability" AS ENUM (
    'Public',
    'Private',
    'Unsearchable',
    'EarlyAccess'
);


ALTER TYPE public."Availability" OWNER TO civitai;

--
-- Name: BlockImageReason; Type: TYPE; Schema: public; Owner: doadmin
--

CREATE TYPE public."BlockImageReason" AS ENUM (
    'Ownership',
    'CSAM',
    'TOS'
);


ALTER TYPE public."BlockImageReason" OWNER TO doadmin;

--
-- Name: BountyEngagementType; Type: TYPE; Schema: public; Owner: civitai
--

CREATE TYPE public."BountyEngagementType" AS ENUM (
    'Favorite',
    'Track'
);


ALTER TYPE public."BountyEngagementType" OWNER TO civitai;

--
-- Name: BountyEntryMode; Type: TYPE; Schema: public; Owner: civitai
--

CREATE TYPE public."BountyEntryMode" AS ENUM (
    'Open',
    'BenefactorsOnly'
);


ALTER TYPE public."BountyEntryMode" OWNER TO civitai;

--
-- Name: BountyMode; Type: TYPE; Schema: public; Owner: civitai
--

CREATE TYPE public."BountyMode" AS ENUM (
    'Individual',
    'Split'
);


ALTER TYPE public."BountyMode" OWNER TO civitai;

--
-- Name: BountyType; Type: TYPE; Schema: public; Owner: civitai
--

CREATE TYPE public."BountyType" AS ENUM (
    'ModelCreation',
    'LoraCreation',
    'EmbedCreation',
    'DataSetCreation',
    'DataSetCaption',
    'ImageCreation',
    'VideoCreation',
    'Other'
);


ALTER TYPE public."BountyType" OWNER TO civitai;

--
-- Name: BuzzWithdrawalRequestStatus; Type: TYPE; Schema: public; Owner: civitai
--

CREATE TYPE public."BuzzWithdrawalRequestStatus" AS ENUM (
    'Requested',
    'Canceled',
    'Rejected',
    'Approved',
    'Reverted',
    'Transferred',
    'ExternallyResolved'
);


ALTER TYPE public."BuzzWithdrawalRequestStatus" OWNER TO civitai;

--
-- Name: ChatMemberStatus; Type: TYPE; Schema: public; Owner: civitai
--

CREATE TYPE public."ChatMemberStatus" AS ENUM (
    'Invited',
    'Joined',
    'Left',
    'Kicked',
    'Ignored'
);


ALTER TYPE public."ChatMemberStatus" OWNER TO civitai;

--
-- Name: ChatMessageType; Type: TYPE; Schema: public; Owner: civitai
--

CREATE TYPE public."ChatMessageType" AS ENUM (
    'Markdown',
    'Image',
    'Video',
    'Audio',
    'Embed'
);


ALTER TYPE public."ChatMessageType" OWNER TO civitai;

--
-- Name: CheckpointType; Type: TYPE; Schema: public; Owner: civitai
--

CREATE TYPE public."CheckpointType" AS ENUM (
    'Trained',
    'Merge'
);


ALTER TYPE public."CheckpointType" OWNER TO civitai;

--
-- Name: ClubAdminPermission; Type: TYPE; Schema: public; Owner: civitai
--

CREATE TYPE public."ClubAdminPermission" AS ENUM (
    'ManageMemberships',
    'ManageTiers',
    'ManagePosts',
    'ManageClub',
    'ManageResources',
    'ViewRevenue',
    'WithdrawRevenue'
);


ALTER TYPE public."ClubAdminPermission" OWNER TO civitai;

--
-- Name: CollectionContributorPermission; Type: TYPE; Schema: public; Owner: civitai
--

CREATE TYPE public."CollectionContributorPermission" AS ENUM (
    'VIEW',
    'ADD',
    'MANAGE',
    'ADD_REVIEW'
);


ALTER TYPE public."CollectionContributorPermission" OWNER TO civitai;

--
-- Name: CollectionItemStatus; Type: TYPE; Schema: public; Owner: civitai
--

CREATE TYPE public."CollectionItemStatus" AS ENUM (
    'ACCEPTED',
    'REVIEW',
    'REJECTED'
);


ALTER TYPE public."CollectionItemStatus" OWNER TO civitai;

--
-- Name: CollectionMode; Type: TYPE; Schema: public; Owner: civitai
--

CREATE TYPE public."CollectionMode" AS ENUM (
    'Contest',
    'Bookmark'
);


ALTER TYPE public."CollectionMode" OWNER TO civitai;

--
-- Name: CollectionReadConfiguration; Type: TYPE; Schema: public; Owner: civitai
--

CREATE TYPE public."CollectionReadConfiguration" AS ENUM (
    'Private',
    'Public',
    'Unlisted'
);


ALTER TYPE public."CollectionReadConfiguration" OWNER TO civitai;

--
-- Name: CollectionType; Type: TYPE; Schema: public; Owner: civitai
--

CREATE TYPE public."CollectionType" AS ENUM (
    'Model',
    'Article',
    'Post',
    'Image'
);


ALTER TYPE public."CollectionType" OWNER TO civitai;

--
-- Name: CollectionWriteConfiguration; Type: TYPE; Schema: public; Owner: civitai
--

CREATE TYPE public."CollectionWriteConfiguration" AS ENUM (
    'Private',
    'Public',
    'Review'
);


ALTER TYPE public."CollectionWriteConfiguration" OWNER TO civitai;

--
-- Name: CommercialUse; Type: TYPE; Schema: public; Owner: civitai
--

CREATE TYPE public."CommercialUse" AS ENUM (
    'None',
    'Image',
    'Rent',
    'Sell',
    'RentCivit'
);


ALTER TYPE public."CommercialUse" OWNER TO civitai;

--
-- Name: ContentType; Type: TYPE; Schema: public; Owner: civitai
--

CREATE TYPE public."ContentType" AS ENUM (
    'Image',
    'Character',
    'Text',
    'Audio'
);


ALTER TYPE public."ContentType" OWNER TO civitai;

--
-- Name: CosmeticEntity; Type: TYPE; Schema: public; Owner: civitai
--

CREATE TYPE public."CosmeticEntity" AS ENUM (
    'Model',
    'Image',
    'Article',
    'Post'
);


ALTER TYPE public."CosmeticEntity" OWNER TO civitai;

--
-- Name: CosmeticSource; Type: TYPE; Schema: public; Owner: civitai
--

CREATE TYPE public."CosmeticSource" AS ENUM (
    'Trophy',
    'Purchase',
    'Event',
    'Membership',
    'Claim'
);


ALTER TYPE public."CosmeticSource" OWNER TO civitai;

--
-- Name: CosmeticType; Type: TYPE; Schema: public; Owner: civitai
--

CREATE TYPE public."CosmeticType" AS ENUM (
    'Badge',
    'NamePlate',
    'ContentDecoration',
    'ProfileDecoration',
    'ProfileBackground'
);


ALTER TYPE public."CosmeticType" OWNER TO civitai;

--
-- Name: CsamReportType; Type: TYPE; Schema: public; Owner: doadmin
--

CREATE TYPE public."CsamReportType" AS ENUM (
    'Image',
    'TrainingData'
);


ALTER TYPE public."CsamReportType" OWNER TO doadmin;

--
-- Name: Currency; Type: TYPE; Schema: public; Owner: civitai
--

CREATE TYPE public."Currency" AS ENUM (
    'USD',
    'BUZZ'
);


ALTER TYPE public."Currency" OWNER TO civitai;

--
-- Name: EntityCollaboratorStatus; Type: TYPE; Schema: public; Owner: civitai
--

CREATE TYPE public."EntityCollaboratorStatus" AS ENUM (
    'Pending',
    'Approved',
    'Rejected'
);


ALTER TYPE public."EntityCollaboratorStatus" OWNER TO civitai;

--
-- Name: EntityMetric_EntityType_Type; Type: TYPE; Schema: public; Owner: civitai
--

CREATE TYPE public."EntityMetric_EntityType_Type" AS ENUM (
    'Image'
);


ALTER TYPE public."EntityMetric_EntityType_Type" OWNER TO civitai;

--
-- Name: EntityMetric_MetricType_Type; Type: TYPE; Schema: public; Owner: civitai
--

CREATE TYPE public."EntityMetric_MetricType_Type" AS ENUM (
    'ReactionLike',
    'ReactionHeart',
    'ReactionLaugh',
    'ReactionCry',
    'Comment',
    'Collection',
    'Buzz'
);


ALTER TYPE public."EntityMetric_MetricType_Type" OWNER TO civitai;

--
-- Name: EntityType; Type: TYPE; Schema: public; Owner: civitai
--

CREATE TYPE public."EntityType" AS ENUM (
    'Image',
    'Post',
    'Article',
    'Bounty',
    'BountyEntry',
    'ModelVersion',
    'Model',
    'Collection'
);


ALTER TYPE public."EntityType" OWNER TO civitai;

--
-- Name: GenerationSchedulers; Type: TYPE; Schema: public; Owner: civitai
--

CREATE TYPE public."GenerationSchedulers" AS ENUM (
    'EulerA',
    'Euler',
    'LMS',
    'Heun',
    'DPM2',
    'DPM2A',
    'DPM2SA',
    'DPM2M',
    'DPMSDE',
    'DPMFast',
    'DPMAdaptive',
    'LMSKarras',
    'DPM2Karras',
    'DPM2AKarras',
    'DPM2SAKarras',
    'DPM2MKarras',
    'DPMSDEKarras',
    'DDIM'
);


ALTER TYPE public."GenerationSchedulers" OWNER TO civitai;

--
-- Name: HomeBlockType; Type: TYPE; Schema: public; Owner: civitai
--

CREATE TYPE public."HomeBlockType" AS ENUM (
    'Collection',
    'Announcement',
    'Leaderboard',
    'Social',
    'Event',
    'CosmeticShop'
);


ALTER TYPE public."HomeBlockType" OWNER TO civitai;

--
-- Name: ImageEngagementType; Type: TYPE; Schema: public; Owner: civitai
--

CREATE TYPE public."ImageEngagementType" AS ENUM (
    'Favorite',
    'Hide'
);


ALTER TYPE public."ImageEngagementType" OWNER TO civitai;

--
-- Name: ImageGenerationProcess; Type: TYPE; Schema: public; Owner: civitai
--

CREATE TYPE public."ImageGenerationProcess" AS ENUM (
    'txt2img',
    'img2img',
    'inpainting',
    'txt2imgHiRes'
);


ALTER TYPE public."ImageGenerationProcess" OWNER TO civitai;

--
-- Name: ImageIngestionStatus; Type: TYPE; Schema: public; Owner: civitai
--

CREATE TYPE public."ImageIngestionStatus" AS ENUM (
    'Pending',
    'Scanned',
    'Error',
    'Blocked',
    'NotFound'
);


ALTER TYPE public."ImageIngestionStatus" OWNER TO civitai;

--
-- Name: ImageOnModelType; Type: TYPE; Schema: public; Owner: civitai
--

CREATE TYPE public."ImageOnModelType" AS ENUM (
    'Example',
    'Training'
);


ALTER TYPE public."ImageOnModelType" OWNER TO civitai;

--
-- Name: ImportStatus; Type: TYPE; Schema: public; Owner: civitai
--

CREATE TYPE public."ImportStatus" AS ENUM (
    'Pending',
    'Processing',
    'Failed',
    'Completed'
);


ALTER TYPE public."ImportStatus" OWNER TO civitai;

--
-- Name: JobQueueType; Type: TYPE; Schema: public; Owner: civitai
--

CREATE TYPE public."JobQueueType" AS ENUM (
    'CleanUp',
    'UpdateMetrics',
    'UpdateNsfwLevel',
    'UpdateSearchIndex',
    'CleanIfEmpty'
);


ALTER TYPE public."JobQueueType" OWNER TO civitai;

--
-- Name: KeyScope; Type: TYPE; Schema: public; Owner: civitai
--

CREATE TYPE public."KeyScope" AS ENUM (
    'Read',
    'Write',
    'Generate'
);


ALTER TYPE public."KeyScope" OWNER TO civitai;

--
-- Name: LinkType; Type: TYPE; Schema: public; Owner: civitai
--

CREATE TYPE public."LinkType" AS ENUM (
    'Sponsorship',
    'Social',
    'Other'
);


ALTER TYPE public."LinkType" OWNER TO civitai;

--
-- Name: MediaType; Type: TYPE; Schema: public; Owner: civitai
--

CREATE TYPE public."MediaType" AS ENUM (
    'image',
    'video',
    'audio'
);


ALTER TYPE public."MediaType" OWNER TO civitai;

--
-- Name: MetricTimeframe; Type: TYPE; Schema: public; Owner: civitai
--

CREATE TYPE public."MetricTimeframe" AS ENUM (
    'Day',
    'Week',
    'Month',
    'Year',
    'AllTime'
);


ALTER TYPE public."MetricTimeframe" OWNER TO civitai;

--
-- Name: ModelEngagementType; Type: TYPE; Schema: public; Owner: civitai
--

CREATE TYPE public."ModelEngagementType" AS ENUM (
    'Favorite',
    'Hide',
    'Mute',
    'Notify'
);


ALTER TYPE public."ModelEngagementType" OWNER TO civitai;

--
-- Name: ModelFileVisibility; Type: TYPE; Schema: public; Owner: civitai
--

CREATE TYPE public."ModelFileVisibility" AS ENUM (
    'Sensitive',
    'Private',
    'Public'
);


ALTER TYPE public."ModelFileVisibility" OWNER TO civitai;

--
-- Name: ModelFlagStatus; Type: TYPE; Schema: public; Owner: civitai
--

CREATE TYPE public."ModelFlagStatus" AS ENUM (
    'Pending',
    'Resolved'
);


ALTER TYPE public."ModelFlagStatus" OWNER TO civitai;

--
-- Name: ModelHashType; Type: TYPE; Schema: public; Owner: civitai
--

CREATE TYPE public."ModelHashType" AS ENUM (
    'AutoV1',
    'AutoV2',
    'SHA256',
    'CRC32',
    'BLAKE3',
    'AutoV3'
);


ALTER TYPE public."ModelHashType" OWNER TO civitai;

--
-- Name: ModelModifier; Type: TYPE; Schema: public; Owner: civitai
--

CREATE TYPE public."ModelModifier" AS ENUM (
    'Archived',
    'TakenDown'
);


ALTER TYPE public."ModelModifier" OWNER TO civitai;

--
-- Name: ModelStatus; Type: TYPE; Schema: public; Owner: civitai
--

CREATE TYPE public."ModelStatus" AS ENUM (
    'Draft',
    'Published',
    'Unpublished',
    'GatherInterest',
    'Deleted',
    'UnpublishedViolation',
    'Scheduled',
    'Training'
);


ALTER TYPE public."ModelStatus" OWNER TO civitai;

--
-- Name: ModelType; Type: TYPE; Schema: public; Owner: civitai
--

CREATE TYPE public."ModelType" AS ENUM (
    'Checkpoint',
    'TextualInversion',
    'Hypernetwork',
    'AestheticGradient',
    'LORA',
    'Controlnet',
    'Poses',
    'LoCon',
    'Wildcards',
    'Other',
    'Upscaler',
    'VAE',
    'Workflows',
    'MotionModule',
    'DoRA'
);


ALTER TYPE public."ModelType" OWNER TO civitai;

--
-- Name: ModelUploadType; Type: TYPE; Schema: public; Owner: civitai
--

CREATE TYPE public."ModelUploadType" AS ENUM (
    'Created',
    'Trained'
);


ALTER TYPE public."ModelUploadType" OWNER TO civitai;

--
-- Name: ModelVersionEngagementType; Type: TYPE; Schema: public; Owner: civitai
--

CREATE TYPE public."ModelVersionEngagementType" AS ENUM (
    'Notify'
);


ALTER TYPE public."ModelVersionEngagementType" OWNER TO civitai;

--
-- Name: ModelVersionMonetizationType; Type: TYPE; Schema: public; Owner: civitai
--

CREATE TYPE public."ModelVersionMonetizationType" AS ENUM (
    'PaidAccess',
    'PaidEarlyAccess',
    'CivitaiClubOnly',
    'MySubscribersOnly',
    'Sponsored',
    'PaidGeneration'
);


ALTER TYPE public."ModelVersionMonetizationType" OWNER TO civitai;

--
-- Name: ModelVersionSponsorshipSettingsType; Type: TYPE; Schema: public; Owner: civitai
--

CREATE TYPE public."ModelVersionSponsorshipSettingsType" AS ENUM (
    'FixedPrice',
    'Bidding'
);


ALTER TYPE public."ModelVersionSponsorshipSettingsType" OWNER TO civitai;

--
-- Name: NotificationCategory; Type: TYPE; Schema: public; Owner: doadmin
--

CREATE TYPE public."NotificationCategory" AS ENUM (
    'Comment',
    'Update',
    'Milestone',
    'Bounty',
    'Other',
    'Buzz',
    'System'
);


ALTER TYPE public."NotificationCategory" OWNER TO doadmin;

--
-- Name: NsfwLevel; Type: TYPE; Schema: public; Owner: civitai
--

CREATE TYPE public."NsfwLevel" AS ENUM (
    'None',
    'Soft',
    'Mature',
    'X',
    'Blocked'
);


ALTER TYPE public."NsfwLevel" OWNER TO civitai;

--
-- Name: OauthTokenType; Type: TYPE; Schema: public; Owner: doadmin
--

CREATE TYPE public."OauthTokenType" AS ENUM (
    'Access',
    'Refresh'
);


ALTER TYPE public."OauthTokenType" OWNER TO doadmin;

--
-- Name: OnboardingStep; Type: TYPE; Schema: public; Owner: civitai
--

CREATE TYPE public."OnboardingStep" AS ENUM (
    'Moderation',
    'Buzz'
);


ALTER TYPE public."OnboardingStep" OWNER TO civitai;

--
-- Name: PartnerPricingModel; Type: TYPE; Schema: public; Owner: civitai
--

CREATE TYPE public."PartnerPricingModel" AS ENUM (
    'Duration',
    'PerImage'
);


ALTER TYPE public."PartnerPricingModel" OWNER TO civitai;

--
-- Name: PaymentProvider; Type: TYPE; Schema: public; Owner: civitai
--

CREATE TYPE public."PaymentProvider" AS ENUM (
    'Stripe',
    'Paddle'
);


ALTER TYPE public."PaymentProvider" OWNER TO civitai;

--
-- Name: PurchasableRewardUsage; Type: TYPE; Schema: public; Owner: civitai
--

CREATE TYPE public."PurchasableRewardUsage" AS ENUM (
    'SingleUse',
    'MultiUse'
);


ALTER TYPE public."PurchasableRewardUsage" OWNER TO civitai;

--
-- Name: RedeemableCodeType; Type: TYPE; Schema: public; Owner: doadmin
--

CREATE TYPE public."RedeemableCodeType" AS ENUM (
    'Buzz',
    'Membership'
);


ALTER TYPE public."RedeemableCodeType" OWNER TO doadmin;

--
-- Name: ReportReason; Type: TYPE; Schema: public; Owner: civitai
--

CREATE TYPE public."ReportReason" AS ENUM (
    'TOSViolation',
    'NSFW',
    'Ownership',
    'AdminAttention',
    'Claim',
    'CSAM'
);


ALTER TYPE public."ReportReason" OWNER TO civitai;

--
-- Name: ReportStatus; Type: TYPE; Schema: public; Owner: civitai
--

CREATE TYPE public."ReportStatus" AS ENUM (
    'Pending',
    'Processing',
    'Actioned',
    'Unactioned'
);


ALTER TYPE public."ReportStatus" OWNER TO civitai;

--
-- Name: ReviewReactions; Type: TYPE; Schema: public; Owner: civitai
--

CREATE TYPE public."ReviewReactions" AS ENUM (
    'Like',
    'Dislike',
    'Laugh',
    'Cry',
    'Heart'
);


ALTER TYPE public."ReviewReactions" OWNER TO civitai;

--
-- Name: RewardsEligibility; Type: TYPE; Schema: public; Owner: doadmin
--

CREATE TYPE public."RewardsEligibility" AS ENUM (
    'Eligible',
    'Ineligible',
    'Protected'
);


ALTER TYPE public."RewardsEligibility" OWNER TO doadmin;

--
-- Name: ScanResultCode; Type: TYPE; Schema: public; Owner: civitai
--

CREATE TYPE public."ScanResultCode" AS ENUM (
    'Pending',
    'Success',
    'Danger',
    'Error'
);


ALTER TYPE public."ScanResultCode" OWNER TO civitai;

--
-- Name: SearchIndexUpdateQueueAction; Type: TYPE; Schema: public; Owner: civitai
--

CREATE TYPE public."SearchIndexUpdateQueueAction" AS ENUM (
    'Update',
    'Delete'
);


ALTER TYPE public."SearchIndexUpdateQueueAction" OWNER TO civitai;

--
-- Name: StripeConnectStatus; Type: TYPE; Schema: public; Owner: civitai
--

CREATE TYPE public."StripeConnectStatus" AS ENUM (
    'PendingOnboarding',
    'Approved',
    'PendingVerification',
    'Rejected'
);


ALTER TYPE public."StripeConnectStatus" OWNER TO civitai;

--
-- Name: TagDisabledReason; Type: TYPE; Schema: public; Owner: civitai
--

CREATE TYPE public."TagDisabledReason" AS ENUM (
    'Voted',
    'Replaced'
);


ALTER TYPE public."TagDisabledReason" OWNER TO civitai;

--
-- Name: TagEngagementType; Type: TYPE; Schema: public; Owner: civitai
--

CREATE TYPE public."TagEngagementType" AS ENUM (
    'Hide',
    'Follow',
    'Allow'
);


ALTER TYPE public."TagEngagementType" OWNER TO civitai;

--
-- Name: TagSource; Type: TYPE; Schema: public; Owner: civitai
--

CREATE TYPE public."TagSource" AS ENUM (
    'User',
    'Rekognition',
    'WD14',
    'Computed',
    'ImageHash'
);


ALTER TYPE public."TagSource" OWNER TO civitai;

--
-- Name: TagTarget; Type: TYPE; Schema: public; Owner: civitai
--

CREATE TYPE public."TagTarget" AS ENUM (
    'Model',
    'Question',
    'Image',
    'Post',
    'Tag',
    'Article',
    'Bounty',
    'Collection'
);


ALTER TYPE public."TagTarget" OWNER TO civitai;

--
-- Name: TagType; Type: TYPE; Schema: public; Owner: civitai
--

CREATE TYPE public."TagType" AS ENUM (
    'UserGenerated',
    'Label',
    'Moderation',
    'System'
);


ALTER TYPE public."TagType" OWNER TO civitai;

--
-- Name: TagsOnTagsType; Type: TYPE; Schema: public; Owner: civitai
--

CREATE TYPE public."TagsOnTagsType" AS ENUM (
    'Parent',
    'Replace',
    'Append'
);


ALTER TYPE public."TagsOnTagsType" OWNER TO civitai;

--
-- Name: TechniqueType; Type: TYPE; Schema: public; Owner: doadmin
--

CREATE TYPE public."TechniqueType" AS ENUM (
    'Image',
    'Video'
);


ALTER TYPE public."TechniqueType" OWNER TO doadmin;

--
-- Name: ToolType; Type: TYPE; Schema: public; Owner: civitai
--

CREATE TYPE public."ToolType" AS ENUM (
    'Image',
    'Video',
    'MotionCapture',
    'Upscalers',
    'Audio',
    'Compute',
    'GameEngines',
    'Editor'
);


ALTER TYPE public."ToolType" OWNER TO civitai;

--
-- Name: TrainingStatus; Type: TYPE; Schema: public; Owner: civitai
--

CREATE TYPE public."TrainingStatus" AS ENUM (
    'Pending',
    'Submitted',
    'Processing',
    'InReview',
    'Failed',
    'Approved',
    'Paused',
    'Denied'
);


ALTER TYPE public."TrainingStatus" OWNER TO civitai;

--
-- Name: UserEngagementType; Type: TYPE; Schema: public; Owner: civitai
--

CREATE TYPE public."UserEngagementType" AS ENUM (
    'Follow',
    'Hide',
    'Block'
);


ALTER TYPE public."UserEngagementType" OWNER TO civitai;

--
-- Name: VaultItemStatus; Type: TYPE; Schema: public; Owner: civitai
--

CREATE TYPE public."VaultItemStatus" AS ENUM (
    'Pending',
    'Stored',
    'Failed'
);


ALTER TYPE public."VaultItemStatus" OWNER TO civitai;

--
-- Name: get_column_stats(); Type: FUNCTION; Schema: pganalyze; Owner: doadmin
--

CREATE FUNCTION pganalyze.get_column_stats() RETURNS SETOF pg_stats
    LANGUAGE sql SECURITY DEFINER
    AS $$
  /* pganalyze-collector */ SELECT schemaname, tablename, attname, inherited, null_frac, avg_width,
    n_distinct, NULL::anyarray, most_common_freqs, NULL::anyarray, correlation, NULL::anyarray,
    most_common_elem_freqs, elem_count_histogram
  FROM pg_catalog.pg_stats;
$$;


ALTER FUNCTION pganalyze.get_column_stats() OWNER TO doadmin;

--
-- Name: get_relation_stats_ext(); Type: FUNCTION; Schema: pganalyze; Owner: doadmin
--

CREATE FUNCTION pganalyze.get_relation_stats_ext() RETURNS TABLE(statistics_schemaname text, statistics_name text, inherited boolean, n_distinct pg_ndistinct, dependencies pg_dependencies, most_common_val_nulls boolean[], most_common_freqs double precision[], most_common_base_freqs double precision[])
    LANGUAGE sql SECURITY DEFINER
    AS $$
  /* pganalyze-collector */ SELECT statistics_schemaname, statistics_name,
  (row_to_json(se.*)::jsonb ->> 'inherited')::boolean AS inherited, n_distinct, dependencies,
  most_common_val_nulls, most_common_freqs, most_common_base_freqs
  FROM pg_catalog.pg_stats_ext se;
$$;


ALTER FUNCTION pganalyze.get_relation_stats_ext() OWNER TO doadmin;

--
-- Name: get_stat_replication(); Type: FUNCTION; Schema: pganalyze; Owner: doadmin
--

CREATE FUNCTION pganalyze.get_stat_replication() RETURNS SETOF pg_stat_replication
    LANGUAGE sql SECURITY DEFINER
    AS $$
  /* pganalyze-collector */ SELECT * FROM pg_catalog.pg_stat_replication;
$$;


ALTER FUNCTION pganalyze.get_stat_replication() OWNER TO doadmin;

--
-- Name: get_stat_statements(boolean); Type: FUNCTION; Schema: pganalyze; Owner: doadmin
--

CREATE FUNCTION pganalyze.get_stat_statements(showtext boolean DEFAULT true) RETURNS SETOF public.pg_stat_statements
    LANGUAGE sql SECURITY DEFINER
    AS $$
  SELECT * FROM pganalyze.get_stat_statements_civitai(showtext)
    UNION ALL
  SELECT * FROM pganalyze.get_stat_statements_civitai_read(showtext)
    UNION ALL
  SELECT * FROM pganalyze.get_stat_statements_doadmin(showtext)
$$;


ALTER FUNCTION pganalyze.get_stat_statements(showtext boolean) OWNER TO doadmin;

--
-- Name: get_stat_statements_civitai(boolean); Type: FUNCTION; Schema: pganalyze; Owner: civitai
--

CREATE FUNCTION pganalyze.get_stat_statements_civitai(showtext boolean DEFAULT true) RETURNS SETOF public.pg_stat_statements
    LANGUAGE sql SECURITY DEFINER
    AS $$
  SELECT * FROM public.pg_stat_statements(showtext) WHERE userid = 'civitai'::regrole;
$$;


ALTER FUNCTION pganalyze.get_stat_statements_civitai(showtext boolean) OWNER TO civitai;

--
-- Name: get_stat_statements_civitai_read(boolean); Type: FUNCTION; Schema: pganalyze; Owner: civitai-read
--

CREATE FUNCTION pganalyze.get_stat_statements_civitai_read(showtext boolean DEFAULT true) RETURNS SETOF public.pg_stat_statements
    LANGUAGE sql SECURITY DEFINER
    AS $$
  SELECT * FROM public.pg_stat_statements(showtext) WHERE userid = 'civitai-read'::regrole;
$$;


ALTER FUNCTION pganalyze.get_stat_statements_civitai_read(showtext boolean) OWNER TO "civitai-read";

--
-- Name: get_stat_statements_doadmin(boolean); Type: FUNCTION; Schema: pganalyze; Owner: doadmin
--

CREATE FUNCTION pganalyze.get_stat_statements_doadmin(showtext boolean DEFAULT true) RETURNS SETOF public.pg_stat_statements
    LANGUAGE sql SECURITY DEFINER
    AS $$
  SELECT * FROM public.pg_stat_statements(showtext) WHERE userid = 'doadmin'::regrole;
$$;


ALTER FUNCTION pganalyze.get_stat_statements_doadmin(showtext boolean) OWNER TO doadmin;

--
-- Name: pg_stat_activity(); Type: FUNCTION; Schema: pghero; Owner: doadmin
--

CREATE FUNCTION pghero.pg_stat_activity() RETURNS SETOF pg_stat_activity
    LANGUAGE sql SECURITY DEFINER
    AS $$
  SELECT * FROM pg_catalog.pg_stat_activity;
$$;


ALTER FUNCTION pghero.pg_stat_activity() OWNER TO doadmin;

--
-- Name: pg_stat_statements(); Type: FUNCTION; Schema: pghero; Owner: doadmin
--

CREATE FUNCTION pghero.pg_stat_statements() RETURNS SETOF public.pg_stat_statements
    LANGUAGE sql SECURITY DEFINER
    AS $$
  SELECT * FROM public.pg_stat_statements;
$$;


ALTER FUNCTION pghero.pg_stat_statements() OWNER TO doadmin;

--
-- Name: pg_stats(); Type: FUNCTION; Schema: pghero; Owner: doadmin
--

CREATE FUNCTION pghero.pg_stats() RETURNS TABLE(schemaname name, tablename name, attname name, null_frac real, avg_width integer, n_distinct real)
    LANGUAGE sql SECURITY DEFINER
    AS $$
  SELECT schemaname, tablename, attname, null_frac, avg_width, n_distinct FROM pg_catalog.pg_stats;
$$;


ALTER FUNCTION pghero.pg_stats() OWNER TO doadmin;

--
-- Name: add_image_metrics(); Type: FUNCTION; Schema: public; Owner: civitai
--

CREATE FUNCTION public.add_image_metrics() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    INSERT INTO "ImageMetric" ("imageId", timeframe, "createdAt")
    SELECT
      NEW.id,
      timeframe,
      NEW."createdAt"
    FROM (
      SELECT UNNEST(ENUM_RANGE(NULL::"MetricTimeframe")) AS timeframe
    ) tf(timeframe);
    RETURN NEW;
END;
$$;


ALTER FUNCTION public.add_image_metrics() OWNER TO civitai;

--
-- Name: add_model_metrics(); Type: FUNCTION; Schema: public; Owner: doadmin
--

CREATE FUNCTION public.add_model_metrics() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    INSERT INTO "ModelMetric" ("modelId", timeframe, "updatedAt")
    SELECT
      NEW.id,
      timeframe,
      NEW."createdAt"
    FROM (
      SELECT UNNEST(ENUM_RANGE(NULL::"MetricTimeframe")) AS timeframe
    ) tf(timeframe);
    RETURN NEW;
END;
$$;


ALTER FUNCTION public.add_model_metrics() OWNER TO doadmin;

--
-- Name: create_buzz_withdrawal_request_history_on_insert(); Type: FUNCTION; Schema: public; Owner: civitai
--

CREATE FUNCTION public.create_buzz_withdrawal_request_history_on_insert() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    -- Update status to be the latest
    INSERT INTO "BuzzWithdrawalRequestHistory" ("id", "requestId", "updatedById", "status", "createdAt", "metadata")
    -- NOTE: cuid is something out of Postgres so it does not work here. Because of that, the we'll use the origina requestId as the id of the history record
    	VALUES (NEW."id", NEW."id", NEW."userId", NEW."status", NEW."createdAt", NEW."metadata");
	RETURN NEW;
END;
$$;


ALTER FUNCTION public.create_buzz_withdrawal_request_history_on_insert() OWNER TO civitai;

--
-- Name: create_job_queue_record(integer, text, text); Type: FUNCTION; Schema: public; Owner: civitai
--

CREATE FUNCTION public.create_job_queue_record(entityid integer, entitytype text, type text) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
  INSERT INTO "JobQueue" ("entityId", "entityType", "type")
  VALUES (entityId, entityType::"EntityType", type::"JobQueueType")
  ON CONFLICT DO NOTHING;
END;
$$;


ALTER FUNCTION public.create_job_queue_record(entityid integer, entitytype text, type text) OWNER TO civitai;

--
-- Name: create_redeemable_codes(text, integer, integer, public."RedeemableCodeType", timestamp without time zone); Type: FUNCTION; Schema: public; Owner: doadmin
--

CREATE FUNCTION public.create_redeemable_codes(prefix text, unit_value integer, quantity integer DEFAULT 1, code_type public."RedeemableCodeType" DEFAULT 'Buzz'::public."RedeemableCodeType", expires_at timestamp without time zone DEFAULT NULL::timestamp without time zone) RETURNS SETOF text
    LANGUAGE plpgsql
    AS $$
DECLARE
  i INTEGER;
  generated_code TEXT;
  max_attempts INTEGER := 3;
  current_attempt INTEGER;
BEGIN
  FOR i IN 1..quantity LOOP
    current_attempt := 0;
    WHILE current_attempt < max_attempts LOOP
      BEGIN
        generated_code := generate_redeemable_code(prefix);
        INSERT INTO "RedeemableCode" ("code", "unitValue", "type", "expiresAt")
        VALUES (generated_code, unit_value, code_type, expires_at);

        RETURN NEXT generated_code;
        EXIT;
      EXCEPTION
        WHEN unique_violation THEN
          current_attempt := current_attempt + 1;
          CONTINUE;
      END;
    END LOOP;

    IF current_attempt = max_attempts THEN
      RAISE EXCEPTION 'Failed to generate unique code after % attempts', max_attempts;
    END IF;
  END LOOP;
END;
$$;


ALTER FUNCTION public.create_redeemable_codes(prefix text, unit_value integer, quantity integer, code_type public."RedeemableCodeType", expires_at timestamp without time zone) OWNER TO doadmin;

--
-- Name: early_access_ends_at(); Type: FUNCTION; Schema: public; Owner: doadmin
--

CREATE FUNCTION public.early_access_ends_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW."publishedAt" IS NOT NULL
        AND NEW."earlyAccessConfig" IS NOT NULL
        -- Ensure the user has paid for early access
        AND NEW."earlyAccessConfig"->>'timeframe' IS NOT NULL
        AND (NEW."earlyAccessConfig"->>'timeframe')::int > 0
    THEN
        UPDATE "ModelVersion"
        SET "earlyAccessEndsAt" = COALESCE(NEW."publishedAt", now()) + CONCAT(NEW."earlyAccessConfig"->>'timeframe', ' days')::interval,
            "availability" = 'EarlyAccess'
        WHERE id = NEW.id;
    ELSE
        IF NEW."publishedAt" IS NOT NULL
            THEN
                UPDATE "ModelVersion"
                SET "earlyAccessEndsAt" = NULL,
                    "availability" = 'Public'
                WHERE id = NEW.id;
        END IF;
    END IF;

    RETURN NEW;
END;
$$;


ALTER FUNCTION public.early_access_ends_at() OWNER TO doadmin;

--
-- Name: feature_images(integer); Type: FUNCTION; Schema: public; Owner: civitai
--

CREATE FUNCTION public.feature_images(num_images_per_category integer) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
    WITH image_score AS (
        SELECT
          i.id,
          t.name category,
          (
            stat."reactionCountAllTime" * 0.3 +
            stat."likeCountAllTime" * 1 +
            stat."heartCountAllTime" * 1.3 +
            stat."laughCountAllTime" * 0.5 +
            stat."cryCountAllTime" * 0.3 +
            stat."dislikeCountAllTime" * -1 +
            stat."commentCountAllTime" * 1.3
          ) score
        FROM "Image" i
        JOIN "TagsOnImage" toi ON toi."imageId" = i.id
        JOIN "Tag" t ON toi."tagId" = t.id AND t."isCategory" = true AND NOT t."unfeatured"
        JOIN "ImageStat" stat ON stat."imageId" = i.id
        WHERE i.nsfw = false AND i."featuredAt" IS NULL
    ), to_feature AS (
        SELECT
          id
        FROM (
            SELECT
              id,
              row_number() OVER (PARTITION BY category ORDER BY score DESC) featured_rank
            FROM image_score
        ) ranked
        WHERE featured_rank <= num_images_per_category
    )
    UPDATE "Image" i SET "featuredAt" = now()
    FROM to_feature tf
    WHERE i.id = tf.id;
END;
$$;


ALTER FUNCTION public.feature_images(num_images_per_category integer) OWNER TO civitai;

--
-- Name: feature_images(text, integer); Type: FUNCTION; Schema: public; Owner: civitai
--

CREATE FUNCTION public.feature_images(tags_to_exclude text, num_images_per_category integer) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    tag_list text[] := string_to_array(tags_to_exclude, ',');
BEGIN
    WITH image_score AS (
        SELECT
          i.id,
          t.name category,
          (
            stat."reactionCountAllTime" * 0.3 +
            stat."likeCountAllTime" * 1 +
            stat."heartCountAllTime" * 1.3 +
            stat."laughCountAllTime" * 0.5 +
            stat."cryCountAllTime" * 0.3 +
            stat."dislikeCountAllTime" * -1 +
            stat."commentCountAllTime" * 1.3
          ) score
        FROM "Image" i
        JOIN "TagsOnImage" toi ON toi."imageId" = i.id
        JOIN "Tag" t ON toi."tagId" = t.id AND t."isCategory" = true AND t.name NOT IN (SELECT UNNEST(tag_list))
        JOIN "ImageStat" stat ON stat."imageId" = i.id
        WHERE i.nsfw = false AND i."featuredAt" IS NULL
    ), to_feature AS (
        SELECT
          id
        FROM (
            SELECT
              id,
              row_number() OVER (PARTITION BY category ORDER BY score DESC) featured_rank
            FROM image_score
        ) ranked
        WHERE featured_rank <= num_images_per_category
    )
    UPDATE "Image" i SET "featuredAt" = now()
    FROM to_feature tf
    WHERE i.id = tf.id;
END;
$$;


ALTER FUNCTION public.feature_images(tags_to_exclude text, num_images_per_category integer) OWNER TO civitai;

--
-- Name: generate_redeemable_code(text); Type: FUNCTION; Schema: public; Owner: doadmin
--

CREATE FUNCTION public.generate_redeemable_code(prefix text DEFAULT 'db'::text) RETURNS text
    LANGUAGE plpgsql
    AS $$
BEGIN
  RETURN UPPER(prefix || '-' || generate_token(4) || '-' || generate_token(4));
END;
$$;


ALTER FUNCTION public.generate_redeemable_code(prefix text) OWNER TO doadmin;

--
-- Name: generate_token(integer); Type: FUNCTION; Schema: public; Owner: doadmin
--

CREATE FUNCTION public.generate_token(length integer) RETURNS text
    LANGUAGE plpgsql
    AS $$
DECLARE
  token_characters TEXT := 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  result TEXT := '';
  i INTEGER;
BEGIN
  FOR i IN 1..length LOOP
    result := result || substr(token_characters, floor(random() * length(token_characters) + 1)::INTEGER, 1);
  END LOOP;
  RETURN result;
END;
$$;


ALTER FUNCTION public.generate_token(length integer) OWNER TO doadmin;

--
-- Name: get_image_resources(integer); Type: FUNCTION; Schema: public; Owner: doadmin
--

CREATE FUNCTION public.get_image_resources(image_id integer) RETURNS TABLE(id integer, modelversionid integer, name text, hash text, strength integer, detected boolean)
    LANGUAGE plpgsql
    AS $$
BEGIN
  RETURN QUERY
  WITH image_resource_hashes AS (
    SELECT
      i.id,
      null::int as model_version_id,
      resource->>'name' as name,
      LOWER(resource->>'hash') as hash,
      iif(resource->>'weight' IS NOT NULL, round((resource->>'weight')::double precision * 100)::int, 100) as strength,
      true as detected
    FROM
      "Image" i,
      jsonb_array_elements(i.meta->'resources') AS resource
    WHERE jsonb_typeof(i.meta->'resources') = 'array' AND i.id = image_id

    UNION ALL

    SELECT
      i.id,
      null::int model_version_id,
      (jsonb_each_text(i.meta->'hashes')).key as name,
      LOWER((jsonb_each_text(i.meta->'hashes')).value) as hash,
      null::int as strength,
      true as detected
    FROM "Image" i
    WHERE jsonb_typeof(i.meta->'hashes') = 'object'
      AND i.id = image_id

    UNION ALL

    SELECT
      i.id,
      null::int model_version_id,
      COALESCE(i.meta->>'Model','model') as name,
      LOWER(i.meta->>'Model hash') as hash,
      null::int as strength,
      true as detected
    FROM "Image" i
    WHERE jsonb_typeof(i.meta->'Model hash') = 'string'
      AND jsonb_typeof(i.meta->'hashes') != 'object'
      AND i.id = image_id

    UNION ALL

    SELECT
      i.id,
      (civitai_resource->>'modelVersionId')::int as model_version_id,
      civitai_resource->>'type' as name,
      null as hash,
      iif(civitai_resource->>'weight' IS NOT NULL, round((civitai_resource->>'weight')::double precision * 100)::int, 100) as strength,
      true as detected
    FROM
      "Image" i,
      jsonb_array_elements(i.meta->'civitaiResources') AS civitai_resource
    WHERE jsonb_typeof(i.meta->'civitaiResources') = 'array' AND i.id = image_id

    UNION ALL

    SELECT
      i.id,
      mv.id model_version_id,
      CONCAT(m.name,' - ', mv.name) as name,
      (
        SELECT DISTINCT ON ("modelVersionId")
          LOWER(mfh.hash)
        FROM "ModelFile" mf
        JOIN "ModelFileHash" mfh ON mfh."fileId" = mf.id
        WHERE mf.type = 'Model' AND mfh.type = 'AutoV2'
        AND mf."modelVersionId" = mv.id
      ) as hash,
      null::int as strength,
      false as detected
    FROM "Image" i
    JOIN "Post" p ON i."postId" = p.id
    JOIN "ModelVersion" mv ON mv.id = p."modelVersionId"
    JOIN "Model" m ON m.id = mv."modelId" AND m.status NOT IN ('Deleted', 'Unpublished', 'UnpublishedViolation')
    WHERE i.id = image_id
  ), image_resource_merge AS (
    SELECT
      irh.id,
      COALESCE(irh.model_version_id, mf."modelVersionId") AS "modelVersionId",
      irh.name,
      irh.hash,
      irh.strength,
      irh.detected,
      mv.status = 'Published' AS version_published,
      COALESCE(mv."publishedAt", mv."createdAt") AS version_date,
      mf.id AS file_id
    FROM image_resource_hashes irh
    LEFT JOIN "ModelFileHash" mfh ON mfh.hash = irh.hash::citext
    LEFT JOIN "ModelFile" mf ON mf.id = mfh."fileId"
    LEFT JOIN "ModelVersion" mv ON mv.id = mf."modelVersionId"
    LEFT JOIN "Model" m ON m.id = mv."modelId"
    WHERE (irh.name IS NULL OR irh.name != 'vae')
      AND (m.id IS NULL OR m.status NOT IN ('Deleted', 'Unpublished', 'UnpublishedViolation'))
      AND (irh.hash IS NULL OR irh.hash != 'e3b0c44298fc') -- Exclude empty hash
  ), image_resource_id AS (
    SELECT
      irh.id,
      irh."modelVersionId",
      irh.name,
      irh.hash,
      irh.strength,
      irh.detected,
      row_number() OVER (PARTITION BY irh.id, irh.hash ORDER BY IIF(irh.detected,0,1), IIF(irh.strength IS NOT NULL,0,1), IIF(version_published,0,1), version_date, file_id) AS row_number,
      row_number() OVER (PARTITION BY irh.id, irh."modelVersionId" ORDER BY IIF(irh.detected,0,1), IIF(irh.strength IS NOT NULL,0,1), IIF(version_published,0,1), version_date, file_id) AS row_number_version
    FROM image_resource_merge irh
  )
  SELECT
    iri.id,
    iri."modelVersionId",
    REPLACE(REPLACE(REPLACE(iri.name, 'hypernet:', ''), 'embed:', ''), 'lora:', '') AS name,
    iri.hash,
    iri.strength,
    iri.detected
  FROM image_resource_id iri
  LEFT JOIN "ModelVersion" mv ON mv.id = iri."modelVersionId"
  WHERE ((iri.row_number = 1 AND iri.row_number_version = 1) OR iri.hash IS NULL)
    AND (
      mv.id IS NULL OR
      mv.meta IS NULL OR
      mv.meta->>'excludeFromAutoDetection' IS NULL
    );
END;
$$;


ALTER FUNCTION public.get_image_resources(image_id integer) OWNER TO doadmin;

--
-- Name: get_image_resources2(integer); Type: FUNCTION; Schema: public; Owner: civitai
--

CREATE FUNCTION public.get_image_resources2(image_id integer) RETURNS TABLE(id integer, modelversionid integer, name text, hash text, strength integer, detected boolean)
    LANGUAGE plpgsql
    AS $$
BEGIN
  RETURN QUERY
  WITH image_resource_hashes AS (
    SELECT
      i.id,
      null::int as model_version_id,
      resource->>'name' as name,
      LOWER(resource->>'hash') as hash,
      iif(resource->>'weight' IS NOT NULL, round((resource->>'weight')::double precision * 100)::int, 100) as strength,
      true as detected
    FROM
      "Image" i,
      jsonb_array_elements(i.meta->'resources') AS resource
    WHERE jsonb_typeof(i.meta->'resources') = 'array' AND i.id = image_id

    UNION ALL

    SELECT
      i.id,
      null::int model_version_id,
      (jsonb_each_text(i.meta->'hashes')).key as name,
      LOWER((jsonb_each_text(i.meta->'hashes')).value) as hash,
      null::int as strength,
      true as detected
    FROM "Image" i
    WHERE jsonb_typeof(i.meta->'hashes') = 'object'
      AND i.id = image_id

    UNION ALL

    SELECT
      i.id,
      null::int model_version_id,
      COALESCE(i.meta->>'Model','model') as name,
      LOWER(i.meta->>'Model hash') as hash,
      null::int as strength,
      true as detected
    FROM "Image" i
    WHERE jsonb_typeof(i.meta->'Model hash') = 'string'
      AND jsonb_typeof(i.meta->'hashes') != 'object'
      AND i.id = image_id

    UNION ALL

    SELECT
      i.id,
      (civitai_resource->>'modelVersionId')::int as model_version_id,
      civitai_resource->>'type' as name,
      null as hash,
      iif(civitai_resource->>'weight' IS NOT NULL, round((civitai_resource->>'weight')::double precision * 100)::int, 100) as strength,
      true as detected
    FROM
      "Image" i,
      jsonb_array_elements(i.meta->'civitaiResources') AS civitai_resource
    WHERE jsonb_typeof(i.meta->'civitaiResources') = 'array' AND i.id = image_id

    UNION ALL

    SELECT
      i.id,
      mv.id model_version_id,
      CONCAT(m.name,' - ', mv.name) as name,
      (
        SELECT DISTINCT ON ("modelVersionId")
          LOWER(mfh.hash)
        FROM "ModelFile" mf
        JOIN "ModelFileHash" mfh ON mfh."fileId" = mf.id
        WHERE mf.type = 'Model' AND mfh.type = 'AutoV2'
        AND mf."modelVersionId" = mv.id
      ) as hash,
      null::int as strength,
      false as detected
    FROM "Image" i
    JOIN "Post" p ON i."postId" = p.id
    JOIN "ModelVersion" mv ON mv.id = p."modelVersionId"
    JOIN "Model" m ON m.id = mv."modelId" AND m.status != 'Deleted'
    WHERE i.id = image_id
  ), image_resource_merge AS (
    SELECT
      irh.id,
      COALESCE(irh.model_version_id, mf."modelVersionId") AS "modelVersionId",
      irh.name,
      irh.hash,
      irh.strength,
      irh.detected,
      mv.status = 'Published' AS version_published,
      COALESCE(mv."publishedAt", mv."createdAt") AS version_date,
      mf.id AS file_id
    FROM image_resource_hashes irh
    LEFT JOIN "ModelFileHash" mfh ON mfh.hash = irh.hash::citext
    LEFT JOIN "ModelFile" mf ON mf.id = mfh."fileId"
    LEFT JOIN "ModelVersion" mv ON mv.id = mf."modelVersionId"
    LEFT JOIN "Model" m ON m.id = mv."modelId"
    WHERE (irh.name IS NULL OR irh.name != 'vae')
      AND (m.id IS NULL OR m.status != 'Deleted')
--       AND irh.hash != 'E3B0C44298FC' -- Exclude empty hash
  ), image_resource_id AS (
    SELECT
      irh.id,
      irh."modelVersionId",
      irh.name,
      irh.hash,
      irh.strength,
      irh.detected,
      row_number() OVER (PARTITION BY irh.id, irh.hash ORDER BY IIF(irh.detected,0,1), IIF(irh.strength IS NOT NULL,0,1), IIF(version_published,0,1), version_date, file_id) AS row_number,
      row_number() OVER (PARTITION BY irh.id, irh."modelVersionId" ORDER BY IIF(irh.detected,0,1), IIF(irh.strength IS NOT NULL,0,1), IIF(version_published,0,1), version_date, file_id) AS row_number_version
    FROM image_resource_merge irh
  )
  SELECT
    iri.id,
    iri."modelVersionId",
    REPLACE(REPLACE(REPLACE(iri.name, 'hypernet:', ''), 'embed:', ''), 'lora:', '') AS name,
    iri.hash,
    iri.strength,
    iri.detected
  FROM image_resource_id iri
  LEFT JOIN "ModelVersion" mv ON mv.id = iri."modelVersionId"
  WHERE ((iri.row_number = 1 AND iri.row_number_version = 1) OR iri.hash IS NULL)
    AND (
      mv.id IS NULL OR
      mv.meta IS NULL OR
      mv.meta->>'excludeFromAutoDetection' IS NULL
    );
END;
$$;


ALTER FUNCTION public.get_image_resources2(image_id integer) OWNER TO civitai;

--
-- Name: get_nsfw_level_name(integer); Type: FUNCTION; Schema: public; Owner: doadmin
--

CREATE FUNCTION public.get_nsfw_level_name(nsfw_level_id integer) RETURNS character varying
    LANGUAGE plpgsql IMMUTABLE
    AS $$
BEGIN
    CASE nsfw_level_id
        WHEN 1 THEN RETURN 'PG';
        WHEN 2 THEN RETURN 'PG13';
        WHEN 4 THEN RETURN 'R';
        WHEN 8 THEN RETURN 'X';
        WHEN 16 THEN RETURN 'XXX';
        WHEN 32 THEN RETURN 'Blocked';
        ELSE RETURN 'Unknown'; -- Handles unexpected values
    END CASE;
END;
$$;


ALTER FUNCTION public.get_nsfw_level_name(nsfw_level_id integer) OWNER TO doadmin;

--
-- Name: hamming_distance(bigint, bigint); Type: FUNCTION; Schema: public; Owner: civitai
--

CREATE FUNCTION public.hamming_distance(hash1 bigint, hash2 bigint) RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE
    xor_result bigint;
    bit_count INTEGER := 0;
    bit_pos INTEGER;
BEGIN
    -- Compute XOR of the two bigint hashes
    xor_result := hash1 # hash2;

    -- Loop through each bit position (from 1 to 64)
    FOR bit_pos IN 0..63 LOOP
        -- Check if the bit at the current position is set
        IF (xor_result >> bit_pos) & 1 = 1 THEN
            bit_count := bit_count + 1;
        END IF;
    END LOOP;

    RETURN bit_count;
END;
$$;


ALTER FUNCTION public.hamming_distance(hash1 bigint, hash2 bigint) OWNER TO civitai;

--
-- Name: hamming_distance_bigint(bigint, bigint); Type: FUNCTION; Schema: public; Owner: civitai
--

CREATE FUNCTION public.hamming_distance_bigint(hash1 bigint, hash2 bigint) RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE
    xor_result bigint;
    bit_count INTEGER := 0;
    bit_pos INTEGER;
BEGIN
    -- Compute XOR of the two bigint hashes
    xor_result := hash1 # hash2;

    -- Loop through each bit position (from 1 to 64)
    FOR bit_pos IN 0..63 LOOP
        -- Check if the bit at the current position is set
        IF (xor_result >> bit_pos) & 1 = 1 THEN
            bit_count := bit_count + 1;
        END IF;
    END LOOP;

    RETURN bit_count;
END;
$$;


ALTER FUNCTION public.hamming_distance_bigint(hash1 bigint, hash2 bigint) OWNER TO civitai;

--
-- Name: iif(boolean, anyelement, anyelement); Type: FUNCTION; Schema: public; Owner: civitai
--

CREATE FUNCTION public.iif(condition boolean, true_result anyelement, false_result anyelement) RETURNS anyelement
    LANGUAGE sql IMMUTABLE
    AS $$
SELECT CASE WHEN condition THEN true_result ELSE false_result END
$$;


ALTER FUNCTION public.iif(condition boolean, true_result anyelement, false_result anyelement) OWNER TO civitai;

--
-- Name: insert_image_resource(integer); Type: FUNCTION; Schema: public; Owner: civitai
--

CREATE FUNCTION public.insert_image_resource(image_id integer) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
	WITH image_resource_hashes AS (
    SELECT
      id,
      null::int as model_version_id,
      resource->>'name' as name,
      UPPER(resource->>'hash') as hash,
      iif(resource->>'weight' IS NOT NULL, round((resource->>'weight')::double precision * 100)::int, 100) as strength,
      true as detected
    FROM
      "Image" i,
      jsonb_array_elements(meta->'resources') AS resource
    WHERE jsonb_typeof(meta->'resources') = 'array' AND i.id = image_id

    UNION ALL

    SELECT
      id,
      null::int model_version_id,
      (jsonb_each_text(meta->'hashes')).key as name,
      UPPER((jsonb_each_text(meta->'hashes')).value) as hash,
      null::int as strength,
      true as detected
    FROM "Image"
    WHERE jsonb_typeof(meta->'hashes') = 'object'
      AND id = image_id

    UNION ALL

    SELECT
      id,
      null::int model_version_id,
      COALESCE(meta->>'Model','model') as name,
      UPPER(meta->>'Model hash') as hash,
      null::int as strength,
      true as detected
    FROM "Image"
    WHERE jsonb_typeof(meta->'Model hash') = 'string'
      AND jsonb_typeof(meta->'hashes') != 'object'
      AND id = image_id

    UNION ALL

    SELECT
      id,
      (civitai_resource->>'modelVersionId')::int as model_version_id,
      civitai_resource->>'type' as name,
      null as hash,
      iif(civitai_resource->>'weight' IS NOT NULL, round((civitai_resource->>'weight')::double precision * 100)::int, 100) as strength,
      true as detected
    FROM
      "Image" i,
      jsonb_array_elements(meta->'civitaiResources') AS civitai_resource
    WHERE jsonb_typeof(meta->'civitaiResources') = 'array' AND i.id = image_id

    UNION ALL

    SELECT
      i.id,
      mv.id model_version_id,
      CONCAT(m.name,' - ', mv.name),
      UPPER(mf.hash) "hash",
      null::int as strength,
      false as detected
    FROM "Image" i
    JOIN "Post" p ON i."postId" = p.id
    JOIN "ModelVersion" mv ON mv.id = p."modelVersionId"
    JOIN "Model" m ON m.id = mv."modelId" AND m.status != 'Deleted'
    LEFT JOIN (
      SELECT mf."modelVersionId", MIN(mfh.hash) hash
      FROM "ModelFile" mf
      JOIN "ModelFileHash" mfh ON mfh."fileId" = mf.id
      WHERE mf.type = 'Model' AND mfh.type = 'AutoV2'
      GROUP BY mf."modelVersionId"
    ) mf ON mf."modelVersionId" = p."modelVersionId"
    WHERE i.id = image_id
  ), image_resource_merge AS (
    SELECT
      irh.id,
      COALESCE(irh.model_version_id, mf."modelVersionId") "modelVersionId",
      irh.name,
      irh.hash,
      irh.strength,
      irh.detected,
      mv.status = 'Published' as version_published,
      COALESCE(mv."publishedAt", mv."createdAt") as version_date,
      mf.id as file_id
    FROM image_resource_hashes irh
    LEFT JOIN "ModelFileHash" mfh ON mfh.hash = irh.hash
    LEFT JOIN "ModelFile" mf ON mf.id = mfh."fileId"
    LEFT JOIN "ModelVersion" mv ON mv.id = mf."modelVersionId"
    LEFT JOIN "Model" m ON m.id = mv."modelId"
    WHERE (irh.name IS NULL OR irh.name != 'vae')
      AND (m.id IS NULL OR m.status != 'Deleted')
  ), image_resource_id AS (
    SELECT
      *,
      row_number() OVER (PARTITION BY id, "hash" ORDER BY IIF(detected,0,1), IIF(strength IS NOT NULL,0,1), IIF(version_published,0,1), version_date, file_id) row_number,
      row_number() OVER (PARTITION BY id, "modelVersionId" ORDER BY IIF(detected,0,1), IIF(strength IS NOT NULL,0,1), IIF(version_published,0,1), version_date, file_id) row_number_version
    FROM image_resource_merge
  )
  INSERT INTO "ImageResource"("imageId", "modelVersionId", name, hash, strength, detected)
  SELECT
    iri.id,
    iri."modelVersionId",
    REPLACE(REPLACE(REPLACE(iri.name, 'hypernet:', ''), 'embed:', ''), 'lora:', '') as "name",
    iri.hash,
    iri.strength,
    iri.detected
  FROM image_resource_id iri
  LEFT JOIN "ModelVersion" mv ON mv.id = iri."modelVersionId"
  WHERE ((row_number = 1 AND row_number_version = 1) OR iri.hash IS NULL)
    AND NOT EXISTS (
      SELECT 1 FROM "ImageResource" ir
      WHERE "imageId" = iri.id
        AND (ir.hash = iri.hash OR ir."modelVersionId" = iri."modelVersionId")
    )
    AND (
      mv.id IS NULL OR
      mv.meta IS NULL OR
      mv.meta->>'excludeFromAutoDetection' IS NULL
    )
  ON CONFLICT ("imageId", "modelVersionId", "name") DO UPDATE SET detected = true, hash = excluded.hash, strength = excluded.strength;
END;
$$;


ALTER FUNCTION public.insert_image_resource(image_id integer) OWNER TO civitai;

--
-- Name: is_new_user(integer); Type: FUNCTION; Schema: public; Owner: doadmin
--

CREATE FUNCTION public.is_new_user(userid integer) RETURNS boolean
    LANGUAGE plpgsql
    AS $$
DECLARE
    isNew BOOLEAN;
BEGIN
    SELECT "createdAt" > now() - interval '6 hours'
    INTO isNew
    FROM "User"
    WHERE id = userId;

    RETURN isNew;
END;
$$;


ALTER FUNCTION public.is_new_user(userid integer) OWNER TO doadmin;

--
-- Name: months_between(timestamp without time zone, timestamp without time zone); Type: FUNCTION; Schema: public; Owner: civitai
--

CREATE FUNCTION public.months_between(from_date timestamp without time zone, to_date timestamp without time zone) RETURNS integer
    LANGUAGE plpgsql
    AS $$
BEGIN
  RETURN CEIL(EXTRACT(YEAR FROM AGE(to_date, from_date)) * 12 + EXTRACT(MONTH FROM AGE(to_date, from_date)));
END;
$$;


ALTER FUNCTION public.months_between(from_date timestamp without time zone, to_date timestamp without time zone) OWNER TO civitai;

--
-- Name: publish_post_metrics(); Type: FUNCTION; Schema: public; Owner: civitai
--

CREATE FUNCTION public.publish_post_metrics() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  ageGroup "MetricTimeframe";
BEGIN
  -- Determine the age group based on the publishedAt timestamp
  ageGroup := CASE
                WHEN NEW."publishedAt" IS NULL OR NEW."publishedAt" > now() + interval '10 seconds' THEN NULL
                ELSE 'Day'::"MetricTimeframe"
              END;

  -- Insert into PostMetric for different timeframes
  INSERT INTO "PostMetric" ("postId", "timeframe", "createdAt", "updatedAt", "likeCount", "dislikeCount", "laughCount", "cryCount", "heartCount", "commentCount", "collectedCount", "ageGroup")
  VALUES
    (NEW."id", 'Day'::"MetricTimeframe", now(), now(), 0, 0, 0, 0, 0, 0, 0, ageGroup),
    (NEW."id", 'Week'::"MetricTimeframe", now(), now(), 0, 0, 0, 0, 0, 0, 0, ageGroup),
    (NEW."id", 'Month'::"MetricTimeframe", now(), now(), 0, 0, 0, 0, 0, 0, 0, ageGroup),
    (NEW."id", 'Year'::"MetricTimeframe", now(), now(), 0, 0, 0, 0, 0, 0, 0, ageGroup),
    (NEW."id", 'AllTime'::"MetricTimeframe", now(), now(), 0, 0, 0, 0, 0, 0, 0, ageGroup)
  ON CONFLICT ("postId", "timeframe") DO UPDATE SET "ageGroup" = ageGroup;
  RETURN NEW;
END;
$$;


ALTER FUNCTION public.publish_post_metrics() OWNER TO civitai;

--
-- Name: refresh_covered_checkpoint_details(); Type: FUNCTION; Schema: public; Owner: civitai
--

CREATE FUNCTION public.refresh_covered_checkpoint_details() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
BEGIN
    REFRESH MATERIALIZED VIEW public."CoveredCheckpointDetails";
END;
$$;


ALTER FUNCTION public.refresh_covered_checkpoint_details() OWNER TO civitai;

--
-- Name: slugify(text); Type: FUNCTION; Schema: public; Owner: civitai
--

CREATE FUNCTION public.slugify(input_string text) RETURNS text
    LANGUAGE plpgsql
    AS $$
BEGIN
    -- Replace spaces with underscores
    input_string := replace(input_string, ' ', '_');

    -- Remove non-alphanumeric characters
    input_string := regexp_replace(input_string, '[^a-zA-Z0-9_]', '', 'g');

    -- Convert to lowercase
    input_string := lower(input_string);

    RETURN input_string;
END;
$$;


ALTER FUNCTION public.slugify(input_string text) OWNER TO civitai;

--
-- Name: truncate_autov3_hash(); Type: FUNCTION; Schema: public; Owner: doadmin
--

CREATE FUNCTION public.truncate_autov3_hash() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.type = 'AutoV3' THEN
    NEW.hash = SUBSTRING(NEW.hash FROM 1 FOR 12);
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION public.truncate_autov3_hash() OWNER TO doadmin;

--
-- Name: update_article_nsfw_level(); Type: FUNCTION; Schema: public; Owner: civitai
--

CREATE FUNCTION public.update_article_nsfw_level() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF (TG_OP = 'DELETE') THEN
    -- When an article is deleted, schedule removal of FKs (collectionItems)
    PERFORM create_job_queue_record(OLD.id, 'Article', 'CleanUp');
  -- On article publish, create a job to update the nsfw level of the related entities (collectionItems)
  ELSIF ((NEW."publishedAt" IS NOT NULL AND OLD."publishedAt" IS NULL) OR (NEW."userNsfwLevel" != OLD."userNsfwLevel" AND NEW."publishedAt" IS NOT NULL)) THEN
    PERFORM create_job_queue_record(OLD."id", 'Article', 'UpdateNsfwLevel');
  END IF;
  RETURN NULL;
END;
$$;


ALTER FUNCTION public.update_article_nsfw_level() OWNER TO civitai;

--
-- Name: update_bounty_nsfw_level(); Type: FUNCTION; Schema: public; Owner: civitai
--

CREATE FUNCTION public.update_bounty_nsfw_level() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  -- On bounty nsfw toggle, create a job to update the nsfw level
  PERFORM create_job_queue_record(NEW."id", 'Bounty', 'UpdateNsfwLevel');
  RETURN NULL;
END;
$$;


ALTER FUNCTION public.update_bounty_nsfw_level() OWNER TO civitai;

--
-- Name: update_buzz_withdrawal_request_status(); Type: FUNCTION; Schema: public; Owner: civitai
--

CREATE FUNCTION public.update_buzz_withdrawal_request_status() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    -- Update status to be the latest
    UPDATE "BuzzWithdrawalRequest" SET "status" = NEW."status", "updatedAt" = now() WHERE "id" = NEW."requestId";
    RETURN NEW;
END;
$$;


ALTER FUNCTION public.update_buzz_withdrawal_request_status() OWNER TO civitai;

--
-- Name: update_collection_nsfw_level(); Type: FUNCTION; Schema: public; Owner: civitai
--

CREATE FUNCTION public.update_collection_nsfw_level() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF (TG_OP = 'DELETE') THEN
    -- When a collection item is deleted, schedule update of collection nsfw level
    PERFORM create_job_queue_record(OLD."collectionId", 'Collection', 'UpdateNsfwLevel');
  -- On collection item publish, schedule update of collection nsfw level
  ELSIF ((TG_OP = 'UPDATE' AND OLD.status != 'ACCEPTED' AND NEW.status = 'ACCEPTED')) THEN
    PERFORM create_job_queue_record(OLD."collectionId", 'Collection', 'UpdateNsfwLevel');
  -- When a collection item is added, schedule update of collection nsfw level
  ELSIF (TG_OP = 'INSERT' AND NEW.status = 'ACCEPTED') THEN
    PERFORM create_job_queue_record(NEW."collectionId", 'Collection', 'UpdateNsfwLevel');
  END IF;
  RETURN NULL;
END;
$$;


ALTER FUNCTION public.update_collection_nsfw_level() OWNER TO civitai;

--
-- Name: update_image_nsfw_level(); Type: FUNCTION; Schema: public; Owner: civitai
--

CREATE FUNCTION public.update_image_nsfw_level() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  -- On image delete
  IF (TG_OP = 'DELETE') THEN

    -- If the image has an nsfw level, create a job to update the nsfw level of the post
    IF (OLD."postId" IS NOT NULL AND OLD."nsfwLevel" != 0) THEN
      PERFORM create_job_queue_record(OLD."postId", 'Post', 'UpdateNsfwLevel');
    END IF;

    IF (OLD."postId" IS NOT NULL) THEN
      PERFORM create_job_queue_record(OLD."postId", 'Post', 'CleanIfEmpty');
    END IF;

    -- Create a job to clean up the FKs of the image
    PERFORM create_job_queue_record(OLD.id, 'Image', 'CleanUp');

  -- On change nsfw level, create a job to update the nsfw level of related entities (imageConnections, collectionItems, articles)
  ELSIF (NEW."nsfwLevel" != OLD."nsfwLevel") THEN
    PERFORM create_job_queue_record(NEW.id, 'Image', 'UpdateNsfwLevel');
  END IF;
  RETURN NULL;
END;
$$;


ALTER FUNCTION public.update_image_nsfw_level() OWNER TO civitai;

--
-- Name: update_image_poi(); Type: FUNCTION; Schema: public; Owner: civitai
--

CREATE FUNCTION public.update_image_poi() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.poi THEN
        -- If poi is true, mark related images for review
        UPDATE "Image" i SET "needsReview" = 'poi'
        FROM "ImageResource" ir
        JOIN "ModelVersion" mv ON mv.id = ir."modelVersionId"
        JOIN "Model" m ON m.id = mv."modelId"
        WHERE ir."imageId" = i.id AND m.id = NEW.id AND i."needsReview" IS NULL
          AND i.nsfw != 'None'::"NsfwLevel"; -- Assuming 'None' is a valid value in "NsfwLevel" enum
    ELSE
        -- If poi is false, remove the review mark if no other POI models are associated
        UPDATE "Image" i SET "needsReview" = null
        FROM "ImageResource" ir
        JOIN "ModelVersion" mv ON mv.id = ir."modelVersionId"
        JOIN "Model" m ON m.id = mv."modelId"
        WHERE ir."imageId" = i.id AND m.id = NEW.id AND i."needsReview" = 'poi'
          AND NOT EXISTS (
              SELECT 1
              FROM "ImageResource" irr
              JOIN "ModelVersion" mvv ON mvv.id = irr."modelVersionId"
              JOIN "Model" mm ON mm.id = mvv."modelId"
              WHERE mm.poi AND mm.id != NEW.id AND irr."imageId" = i.id
          );
    END IF;
    RETURN NEW;
END;
$$;


ALTER FUNCTION public.update_image_poi() OWNER TO civitai;

--
-- Name: update_image_rank(integer); Type: PROCEDURE; Schema: public; Owner: civitai
--

CREATE PROCEDURE public.update_image_rank(IN batch_size integer)
    LANGUAGE plpgsql
    AS $$
DECLARE
    total_rows     INT;
    rows_processed INT := 0;
BEGIN
    RETURN;

    RAISE NOTICE 'Preparing temp table';
    -- Create a temporary table to store the new data
    -- The 'hope' of using a temp table would be that it doesn't replicate to the read replicas
    DROP TABLE IF EXISTS "ImageRank_Temp";
    CREATE LOCAL TEMP TABLE "ImageRank_Temp" AS
    SELECT * FROM "ImageRank_Live";

    RAISE NOTICE 'Adding a primary key';
    ALTER TABLE "ImageRank_Temp" ADD PRIMARY KEY ("imageId");

    RAISE NOTICE 'Determining number of rows';

    -- Get the total number of rows in the temporary table
    SELECT COUNT(*) INTO total_rows FROM "ImageRank_Temp";

    RAISE NOTICE 'Inserting % rows in batch size %', total_rows, batch_size;

    -- Loop through the data in batches
    FOR batch_offset IN 1..total_rows BY batch_size
        LOOP
            -- Insert data from the temporary table into the permanent table
            INSERT INTO "ImageRank"
            SELECT *
            FROM "ImageRank_Temp"
            ORDER BY "imageId" -- Order by a column to ensure consistent results
            LIMIT batch_size OFFSET batch_offset
            ON CONFLICT ("imageId") DO UPDATE SET
              "heartCountDayRank"             = EXCLUDED."heartCountDayRank",
              "heartCountWeekRank"            = EXCLUDED."heartCountWeekRank",
              "heartCountMonthRank"           = EXCLUDED."heartCountMonthRank",
              "heartCountYearRank"            = EXCLUDED."heartCountYearRank",
              "heartCountAllTimeRank"         = EXCLUDED."heartCountAllTimeRank",
              "likeCountDayRank"              = EXCLUDED."likeCountDayRank",
              "likeCountWeekRank"             = EXCLUDED."likeCountWeekRank",
              "likeCountMonthRank"            = EXCLUDED."likeCountMonthRank",
              "likeCountYearRank"             = EXCLUDED."likeCountYearRank",
              "likeCountAllTimeRank"          = EXCLUDED."likeCountAllTimeRank",
              "dislikeCountDayRank"           = EXCLUDED."dislikeCountDayRank",
              "dislikeCountWeekRank"          = EXCLUDED."dislikeCountWeekRank",
              "dislikeCountMonthRank"         = EXCLUDED."dislikeCountMonthRank",
              "dislikeCountYearRank"          = EXCLUDED."dislikeCountYearRank",
              "dislikeCountAllTimeRank"       = EXCLUDED."dislikeCountAllTimeRank",
              "laughCountDayRank"             = EXCLUDED."laughCountDayRank",
              "laughCountWeekRank"            = EXCLUDED."laughCountWeekRank",
              "laughCountMonthRank"           = EXCLUDED."laughCountMonthRank",
              "laughCountYearRank"            = EXCLUDED."laughCountYearRank",
              "laughCountAllTimeRank"         = EXCLUDED."laughCountAllTimeRank",
              "cryCountDayRank"               = EXCLUDED."cryCountDayRank",
              "cryCountWeekRank"              = EXCLUDED."cryCountWeekRank",
              "cryCountMonthRank"             = EXCLUDED."cryCountMonthRank",
              "cryCountYearRank"              = EXCLUDED."cryCountYearRank",
              "cryCountAllTimeRank"           = EXCLUDED."cryCountAllTimeRank",
              "reactionCountDayRank"          = EXCLUDED."reactionCountDayRank",
              "reactionCountWeekRank"         = EXCLUDED."reactionCountWeekRank",
              "reactionCountMonthRank"        = EXCLUDED."reactionCountMonthRank",
              "reactionCountYearRank"         = EXCLUDED."reactionCountYearRank",
              "reactionCountAllTimeRank"      = EXCLUDED."reactionCountAllTimeRank",
              "commentCountDayRank"           = EXCLUDED."commentCountDayRank",
              "commentCountWeekRank"          = EXCLUDED."commentCountWeekRank",
              "commentCountMonthRank"         = EXCLUDED."commentCountMonthRank",
              "commentCountYearRank"          = EXCLUDED."commentCountYearRank",
              "commentCountAllTimeRank"       = EXCLUDED."commentCountAllTimeRank",
              "collectedCountDayRank"         = EXCLUDED."collectedCountDayRank",
              "collectedCountWeekRank"        = EXCLUDED."collectedCountWeekRank",
              "collectedCountMonthRank"       = EXCLUDED."collectedCountMonthRank",
              "collectedCountYearRank"        = EXCLUDED."collectedCountYearRank",
              "collectedCountAllTimeRank"     = EXCLUDED."collectedCountAllTimeRank",
              "tippedCountDayRank"            = EXCLUDED."tippedCountDayRank",
              "tippedCountWeekRank"           = EXCLUDED."tippedCountWeekRank",
              "tippedCountMonthRank"          = EXCLUDED."tippedCountMonthRank",
              "tippedCountYearRank"           = EXCLUDED."tippedCountYearRank",
              "tippedCountAllTimeRank"        = EXCLUDED."tippedCountAllTimeRank",
              "tippedAmountCountDayRank"      = EXCLUDED."tippedAmountCountDayRank",
              "tippedAmountCountWeekRank"     = EXCLUDED."tippedAmountCountWeekRank",
              "tippedAmountCountMonthRank"    = EXCLUDED."tippedAmountCountMonthRank",
              "tippedAmountCountYearRank"     = EXCLUDED."tippedAmountCountYearRank",
              "tippedAmountCountAllTimeRank"  = EXCLUDED."tippedAmountCountAllTimeRank";

            -- Update the number of rows processed
            rows_processed := rows_processed + batch_size;

            -- Optional: Take a small break
            -- pg_sleep(1)

            RAISE NOTICE 'Batch: % / %', rows_processed, total_rows;
            COMMIT;

            -- Exit the loop if all rows have been processed
            EXIT WHEN rows_processed >= total_rows;
        END LOOP;

    -- Cleanup in case of session reuse
    DROP TABLE IF EXISTS "ImageRank_Temp";
END ;
$$;


ALTER PROCEDURE public.update_image_rank(IN batch_size integer) OWNER TO civitai;

--
-- Name: update_image_sort_at(); Type: FUNCTION; Schema: public; Owner: civitai
--

CREATE FUNCTION public.update_image_sort_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE "Image" SET "updatedAt" = now() WHERE "postId" = NEW."id";
  RETURN NEW;
END;
$$;


ALTER FUNCTION public.update_image_sort_at() OWNER TO civitai;

--
-- Name: FUNCTION update_image_sort_at(); Type: COMMENT; Schema: public; Owner: civitai
--

COMMENT ON FUNCTION public.update_image_sort_at() IS 'When a post is created or its publishedAt is updated, set sortAt for related images. If publishedAt is null, use createdAt.';


--
-- Name: update_model_nsfw_level(); Type: FUNCTION; Schema: public; Owner: civitai
--

CREATE FUNCTION public.update_model_nsfw_level() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF (TG_OP = 'DELETE') THEN
    -- When a model is deleted, schedule removal of FKs (collectionItems)
    PERFORM create_job_queue_record(OLD.id, 'Model', 'CleanUp');
  -- On model publish, create a job to update the nsfw level of the related entities (collectionItems)
  ELSIF ((NEW.status = 'Published' AND OLD.status != 'Published') OR (NEW."nsfw" != OLD."nsfw" AND NEW.status = 'Published')) THEN
    PERFORM create_job_queue_record(OLD."id", 'Model', 'UpdateNsfwLevel');
  END IF;
  RETURN NULL;
END;
$$;


ALTER FUNCTION public.update_model_nsfw_level() OWNER TO civitai;

--
-- Name: update_model_rank(integer); Type: PROCEDURE; Schema: public; Owner: civitai
--

CREATE PROCEDURE public.update_model_rank(IN batch_size integer)
    LANGUAGE plpgsql
    AS $$
DECLARE
    total_rows     INT;
    rows_processed INT := 0;
BEGIN
    RAISE NOTICE 'Preparing temp table';
    -- Create a temporary table to store the new data
    -- The 'hope' of using a temp table would be that it doesn't replicate to the read replicas
    DROP TABLE IF EXISTS "ModelRank_Temp";
    CREATE LOCAL TEMP TABLE "ModelRank_Temp" AS
    SELECT * FROM "ModelRank_Live";

    RAISE NOTICE 'Adding a primary key';
    ALTER TABLE "ModelRank_Temp" ADD PRIMARY KEY ("modelId");

    RAISE NOTICE 'Determining number of rows';

    -- Get the total number of rows in the temporary table
    SELECT COUNT(*) INTO total_rows FROM "ModelRank_Temp";

    RAISE NOTICE 'Inserting % rows in batch size %', total_rows, batch_size;

    -- Loop through the data in batches
    FOR batch_offset IN 1..total_rows BY batch_size
        LOOP
            -- Insert data from the temporary table into the permanent table
            INSERT INTO "ModelRank"
            SELECT *
            FROM "ModelRank_Temp"
            ORDER BY "modelId" -- Order by a column to ensure consistent results
            LIMIT batch_size OFFSET batch_offset
            ON CONFLICT ("modelId") DO UPDATE SET
              "downloadCountDay"             = EXCLUDED."downloadCountDay",
              "downloadCountWeek"            = EXCLUDED."downloadCountWeek",
              "downloadCountMonth"           = EXCLUDED."downloadCountMonth",
              "downloadCountYear"            = EXCLUDED."downloadCountYear",
              "downloadCountAllTime"         = EXCLUDED."downloadCountAllTime",
              "downloadCountDayRank"         = EXCLUDED."downloadCountDayRank",
              "downloadCountWeekRank"        = EXCLUDED."downloadCountWeekRank",
              "downloadCountMonthRank"       = EXCLUDED."downloadCountMonthRank",
              "downloadCountYearRank"        = EXCLUDED."downloadCountYearRank",
              "downloadCountAllTimeRank"     = EXCLUDED."downloadCountAllTimeRank",
              "ratingCountDay"               = EXCLUDED."ratingCountDay",
              "ratingCountWeek"              = EXCLUDED."ratingCountWeek",
              "ratingCountMonth"             = EXCLUDED."ratingCountMonth",
              "ratingCountYear"              = EXCLUDED."ratingCountYear",
              "ratingCountAllTime"           = EXCLUDED."ratingCountAllTime",
              "ratingCountDayRank"           = EXCLUDED."ratingCountDayRank",
              "ratingCountWeekRank"          = EXCLUDED."ratingCountWeekRank",
              "ratingCountMonthRank"         = EXCLUDED."ratingCountMonthRank",
              "ratingCountYearRank"          = EXCLUDED."ratingCountYearRank",
              "ratingCountAllTimeRank"       = EXCLUDED."ratingCountAllTimeRank",
              "ratingDay"                    = EXCLUDED."ratingDay",
              "ratingWeek"                   = EXCLUDED."ratingWeek",
              "ratingMonth"                  = EXCLUDED."ratingMonth",
              "ratingYear"                   = EXCLUDED."ratingYear",
              "ratingAllTime"                = EXCLUDED."ratingAllTime",
              "ratingDayRank"                = EXCLUDED."ratingDayRank",
              "ratingWeekRank"               = EXCLUDED."ratingWeekRank",
              "ratingMonthRank"              = EXCLUDED."ratingMonthRank",
              "ratingYearRank"               = EXCLUDED."ratingYearRank",
              "ratingAllTimeRank"            = EXCLUDED."ratingAllTimeRank",
              "favoriteCountDay"             = EXCLUDED."favoriteCountDay",
              "favoriteCountWeek"            = EXCLUDED."favoriteCountWeek",
              "favoriteCountMonth"           = EXCLUDED."favoriteCountMonth",
              "favoriteCountYear"            = EXCLUDED."favoriteCountYear",
              "favoriteCountAllTime"         = EXCLUDED."favoriteCountAllTime",
              "favoriteCountDayRank"         = EXCLUDED."favoriteCountDayRank",
              "favoriteCountWeekRank"        = EXCLUDED."favoriteCountWeekRank",
              "favoriteCountMonthRank"       = EXCLUDED."favoriteCountMonthRank",
              "favoriteCountYearRank"        = EXCLUDED."favoriteCountYearRank",
              "favoriteCountAllTimeRank"     = EXCLUDED."favoriteCountAllTimeRank",
              "commentCountDay"              = EXCLUDED."commentCountDay",
              "commentCountWeek"             = EXCLUDED."commentCountWeek",
              "commentCountMonth"            = EXCLUDED."commentCountMonth",
              "commentCountYear"             = EXCLUDED."commentCountYear",
              "commentCountAllTime"          = EXCLUDED."commentCountAllTime",
              "commentCountDayRank"          = EXCLUDED."commentCountDayRank",
              "commentCountWeekRank"         = EXCLUDED."commentCountWeekRank",
              "commentCountMonthRank"        = EXCLUDED."commentCountMonthRank",
              "commentCountYearRank"         = EXCLUDED."commentCountYearRank",
              "commentCountAllTimeRank"      = EXCLUDED."commentCountAllTimeRank",
              "imageCountDay"                = EXCLUDED."imageCountDay",
              "imageCountWeek"               = EXCLUDED."imageCountWeek",
              "imageCountMonth"              = EXCLUDED."imageCountMonth",
              "imageCountYear"               = EXCLUDED."imageCountYear",
              "imageCountAllTime"            = EXCLUDED."imageCountAllTime",
              "imageCountDayRank"            = EXCLUDED."imageCountDayRank",
              "imageCountWeekRank"           = EXCLUDED."imageCountWeekRank",
              "imageCountMonthRank"          = EXCLUDED."imageCountMonthRank",
              "imageCountYearRank"           = EXCLUDED."imageCountYearRank",
              "imageCountAllTimeRank"        = EXCLUDED."imageCountAllTimeRank",
              "collectedCountDay"            = EXCLUDED."collectedCountDay",
              "collectedCountWeek"           = EXCLUDED."collectedCountWeek",
              "collectedCountMonth"          = EXCLUDED."collectedCountMonth",
              "collectedCountYear"           = EXCLUDED."collectedCountYear",
              "collectedCountAllTime"        = EXCLUDED."collectedCountAllTime",
              "collectedCountDayRank"        = EXCLUDED."collectedCountDayRank",
              "collectedCountWeekRank"       = EXCLUDED."collectedCountWeekRank",
              "collectedCountMonthRank"      = EXCLUDED."collectedCountMonthRank",
              "collectedCountYearRank"       = EXCLUDED."collectedCountYearRank",
              "collectedCountAllTimeRank"    = EXCLUDED."collectedCountAllTimeRank",
              "newRank"                      = EXCLUDED."newRank",
              "age_days"                     = EXCLUDED."age_days",
              "tippedCountDay"               = EXCLUDED."tippedCountDay",
              "tippedCountWeek"              = EXCLUDED."tippedCountWeek",
              "tippedCountMonth"             = EXCLUDED."tippedCountMonth",
              "tippedCountYear"              = EXCLUDED."tippedCountYear",
              "tippedCountAllTime"           = EXCLUDED."tippedCountAllTime",
              "tippedCountDayRank"           = EXCLUDED."tippedCountDayRank",
              "tippedCountWeekRank"          = EXCLUDED."tippedCountWeekRank",
              "tippedCountMonthRank"         = EXCLUDED."tippedCountMonthRank",
              "tippedCountYearRank"          = EXCLUDED."tippedCountYearRank",
              "tippedCountAllTimeRank"       = EXCLUDED."tippedCountAllTimeRank",
              "tippedAmountCountDay"         = EXCLUDED."tippedAmountCountDay",
              "tippedAmountCountWeek"        = EXCLUDED."tippedAmountCountWeek",
              "tippedAmountCountMonth"       = EXCLUDED."tippedAmountCountMonth",
              "tippedAmountCountYear"        = EXCLUDED."tippedAmountCountYear",
              "tippedAmountCountAllTime"     = EXCLUDED."tippedAmountCountAllTime",
              "tippedAmountCountDayRank"     = EXCLUDED."tippedAmountCountDayRank",
              "tippedAmountCountWeekRank"    = EXCLUDED."tippedAmountCountWeekRank",
              "tippedAmountCountMonthRank"   = EXCLUDED."tippedAmountCountMonthRank",
              "tippedAmountCountYearRank"    = EXCLUDED."tippedAmountCountYearRank",
              "tippedAmountCountAllTimeRank" = EXCLUDED."tippedAmountCountAllTimeRank",
              "generationCountDayRank"       = EXCLUDED."generationCountDayRank",
              "generationCountWeekRank"      = EXCLUDED."generationCountWeekRank",
              "generationCountMonthRank"     = EXCLUDED."generationCountMonthRank",
              "generationCountYearRank"      = EXCLUDED."generationCountYearRank",
              "generationCountAllTimeRank"   = EXCLUDED."generationCountAllTimeRank",
              "generationCountDay"           = EXCLUDED."generationCountDay",
              "generationCountWeek"          = EXCLUDED."generationCountWeek",
              "generationCountMonth"         = EXCLUDED."generationCountMonth",
              "generationCountYear"          = EXCLUDED."generationCountYear",
              "generationCountAllTime"       = EXCLUDED."generationCountAllTime";

            -- Update the number of rows processed
            rows_processed := rows_processed + batch_size;

            -- Optional: Take a small break
            -- pg_sleep(1)

            RAISE NOTICE 'Batch: % / %', rows_processed, total_rows;
            COMMIT;

            -- Exit the loop if all rows have been processed
            EXIT WHEN rows_processed >= total_rows;
        END LOOP;

    -- Cleanup in case of session reuse
    DROP TABLE IF EXISTS "ModelRank_Temp";
END ;
$$;


ALTER PROCEDURE public.update_model_rank(IN batch_size integer) OWNER TO civitai;

--
-- Name: update_model_version_nsfw_level(); Type: FUNCTION; Schema: public; Owner: civitai
--

CREATE FUNCTION public.update_model_version_nsfw_level() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF (TG_OP = 'DELETE') THEN
    -- When a model version is deleted, schedule nsfw level update for the model
    PERFORM create_job_queue_record(OLD."modelId", 'Model', 'UpdateNsfwLevel');
  -- On model version publish, create a job to update the nsfw level of the related entities (model)
  ELSIF (NEW.status = 'Published' AND OLD.status != 'Published') THEN
    PERFORM create_job_queue_record(NEW.id, 'ModelVersion', 'UpdateNsfwLevel');
  END IF;
  RETURN NULL;
END;
$$;


ALTER FUNCTION public.update_model_version_nsfw_level() OWNER TO civitai;

--
-- Name: update_muted_at(); Type: FUNCTION; Schema: public; Owner: civitai
--

CREATE FUNCTION public.update_muted_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    -- Check if muted is set to true and update mutedAt to now()
    IF NEW.muted THEN
        NEW."mutedAt" := now();
    -- Check if muted is set to false and clear mutedAt
    ELSIF NOT NEW.muted THEN
        NEW."mutedAt" := NULL;
    END IF;
    RETURN NEW;
END;
$$;


ALTER FUNCTION public.update_muted_at() OWNER TO civitai;

--
-- Name: update_nsfw_level(integer[]); Type: FUNCTION; Schema: public; Owner: civitai
--

CREATE FUNCTION public.update_nsfw_level(VARIADIC image_ids integer[]) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
	PERFORM update_nsfw_levels(image_ids);
END;
$$;


ALTER FUNCTION public.update_nsfw_level(VARIADIC image_ids integer[]) OWNER TO civitai;

--
-- Name: update_nsfw_levels(integer[]); Type: FUNCTION; Schema: public; Owner: civitai
--

CREATE FUNCTION public.update_nsfw_levels(image_ids integer[]) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
  WITH image_level AS (
    SELECT
      toi."imageId",
      CASE
        WHEN bool_or(t.nsfw = 'X') THEN 'X'::"NsfwLevel"
        WHEN bool_or(t.nsfw = 'Mature') THEN 'Mature'::"NsfwLevel"
        WHEN bool_or(t.nsfw = 'Soft') THEN 'Soft'::"NsfwLevel"
        ELSE 'None'::"NsfwLevel"
      END "nsfw",
      CASE
        WHEN bool_or(t."nsfwLevel" = 32) THEN 32
        WHEN bool_or(t."nsfwLevel" = 16) THEN 16
        WHEN bool_or(t."nsfwLevel" = 8) THEN 8
        WHEN bool_or(t."nsfwLevel" = 4) THEN 4
        WHEN bool_or(t."nsfwLevel" = 2) THEN 2
        ELSE 1
      END "nsfwLevel"
    FROM "TagsOnImage" toi
    LEFT JOIN "Tag" t ON t.id = toi."tagId" AND (t.nsfw != 'None' OR t."nsfwLevel" > 1)
    WHERE toi."imageId" = ANY(image_ids) AND NOT toi.disabled
    GROUP BY toi."imageId"
  )
  UPDATE "Image" i SET nsfw = il.nsfw, "nsfwLevel" = il."nsfwLevel"
  FROM image_level il
  WHERE il."imageId" = i.id AND NOT i."nsfwLevelLocked" AND (il."nsfwLevel" != i."nsfwLevel" OR il.nsfw != i.nsfw) AND i.ingestion = 'Scanned' AND i."nsfwLevel" != 32;
END;
$$;


ALTER FUNCTION public.update_nsfw_levels(image_ids integer[]) OWNER TO civitai;

--
-- Name: update_post_nsfw_level(); Type: FUNCTION; Schema: public; Owner: civitai
--

CREATE FUNCTION public.update_post_nsfw_level() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF (TG_OP = 'DELETE') THEN

    -- If the post has a model version, create a job to update the nsfw level of the model version
    IF (OLD."modelVersionId" IS NOT NULL AND OLD."publishedAt" IS NOT NULL) THEN
      PERFORM create_job_queue_record(OLD."modelVersionId", 'ModelVersion', 'UpdateNsfwLevel');
    END IF;

    -- Create a job to clean up the FKs of the post (collectionItems)
    PERFORM create_job_queue_record(OLD.id, 'Post', 'CleanUp');

  -- On post publish, create a job to update the nsfw level of the related entities (modelVersions, collectionItems)
  ELSIF (NEW."publishedAt" IS NOT NULL AND OLD."publishedAt" IS NULL) THEN
    PERFORM create_job_queue_record(NEW.id, 'Post', 'UpdateNsfwLevel');
  END IF;
  RETURN NULL;
END;
$$;


ALTER FUNCTION public.update_post_nsfw_level() OWNER TO civitai;

--
-- Name: update_post_nsfw_level(integer[]); Type: FUNCTION; Schema: public; Owner: civitai
--

CREATE FUNCTION public.update_post_nsfw_level(VARIADIC post_ids integer[]) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
	PERFORM update_post_nsfw_levels(post_ids);
END;
$$;


ALTER FUNCTION public.update_post_nsfw_level(VARIADIC post_ids integer[]) OWNER TO civitai;

--
-- Name: update_post_nsfw_levels(integer[]); Type: FUNCTION; Schema: public; Owner: civitai
--

CREATE FUNCTION public.update_post_nsfw_levels(post_ids integer[]) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
  WITH post_nsfw_level AS (
	  SELECT DISTINCT ON (p.id) p.id, i.nsfw
		FROM "Post" p
		JOIN "Image" i ON i."postId" = p.id
		WHERE p.id = ANY(post_ids)
		ORDER BY p.id, i.index
	)
	UPDATE "Post" p
	SET
	  metadata = CASE
       WHEN jsonb_typeof(metadata) = 'null' OR metadata IS NULL THEN jsonb_build_object('imageNsfw', COALESCE(pnl.nsfw, 'None'))
       ELSE p.metadata || jsonb_build_object('imageNsfw', COALESCE(pnl.nsfw, 'None'))
	  END
	FROM post_nsfw_level pnl
	WHERE pnl.id = p.id;
END;
$$;


ALTER FUNCTION public.update_post_nsfw_levels(post_ids integer[]) OWNER TO civitai;

--
-- Name: pg_stat_activity; Type: VIEW; Schema: pghero; Owner: doadmin
--

CREATE VIEW pghero.pg_stat_activity AS
 SELECT pg_stat_activity.datid,
    pg_stat_activity.datname,
    pg_stat_activity.pid,
    pg_stat_activity.leader_pid,
    pg_stat_activity.usesysid,
    pg_stat_activity.usename,
    pg_stat_activity.application_name,
    pg_stat_activity.client_addr,
    pg_stat_activity.client_hostname,
    pg_stat_activity.client_port,
    pg_stat_activity.backend_start,
    pg_stat_activity.xact_start,
    pg_stat_activity.query_start,
    pg_stat_activity.state_change,
    pg_stat_activity.wait_event_type,
    pg_stat_activity.wait_event,
    pg_stat_activity.state,
    pg_stat_activity.backend_xid,
    pg_stat_activity.backend_xmin,
    pg_stat_activity.query_id,
    pg_stat_activity.query,
    pg_stat_activity.backend_type
   FROM pghero.pg_stat_activity() pg_stat_activity(datid, datname, pid, leader_pid, usesysid, usename, application_name, client_addr, client_hostname, client_port, backend_start, xact_start, query_start, state_change, wait_event_type, wait_event, state, backend_xid, backend_xmin, query_id, query, backend_type);


ALTER TABLE pghero.pg_stat_activity OWNER TO doadmin;

--
-- Name: pg_stats; Type: VIEW; Schema: pghero; Owner: doadmin
--

CREATE VIEW pghero.pg_stats AS
 SELECT pg_stats.schemaname,
    pg_stats.tablename,
    pg_stats.attname,
    pg_stats.null_frac,
    pg_stats.avg_width,
    pg_stats.n_distinct
   FROM pghero.pg_stats() pg_stats(schemaname, tablename, attname, null_frac, avg_width, n_distinct);


ALTER TABLE pghero.pg_stats OWNER TO doadmin;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: Account; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."Account" (
    type text NOT NULL,
    provider text NOT NULL,
    "providerAccountId" text NOT NULL,
    refresh_token text,
    access_token text,
    expires_at integer,
    token_type text,
    scope text,
    id_token text,
    session_state text,
    id integer NOT NULL,
    "userId" integer NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL
);


ALTER TABLE public."Account" OWNER TO civitai;

--
-- Name: Account_id_seq; Type: SEQUENCE; Schema: public; Owner: civitai
--

CREATE SEQUENCE public."Account_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public."Account_id_seq" OWNER TO civitai;

--
-- Name: Account_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: civitai
--

ALTER SEQUENCE public."Account_id_seq" OWNED BY public."Account".id;


--
-- Name: Announcement; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."Announcement" (
    id integer NOT NULL,
    title text NOT NULL,
    content text NOT NULL,
    emoji text,
    color text DEFAULT 'blue'::text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "startsAt" timestamp(3) without time zone,
    "endsAt" timestamp(3) without time zone,
    metadata jsonb
);


ALTER TABLE public."Announcement" OWNER TO civitai;

--
-- Name: Announcement_id_seq; Type: SEQUENCE; Schema: public; Owner: civitai
--

CREATE SEQUENCE public."Announcement_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public."Announcement_id_seq" OWNER TO civitai;

--
-- Name: Announcement_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: civitai
--

ALTER SEQUENCE public."Announcement_id_seq" OWNED BY public."Announcement".id;


--
-- Name: Answer; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."Answer" (
    id integer NOT NULL,
    "questionId" integer NOT NULL,
    "userId" integer NOT NULL,
    content text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


ALTER TABLE public."Answer" OWNER TO civitai;

--
-- Name: AnswerMetric; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."AnswerMetric" (
    "answerId" integer NOT NULL,
    timeframe public."MetricTimeframe" NOT NULL,
    "checkCount" integer NOT NULL,
    "crossCount" integer NOT NULL,
    "heartCount" integer NOT NULL,
    "commentCount" integer NOT NULL
);


ALTER TABLE public."AnswerMetric" OWNER TO civitai;

--
-- Name: AnswerRank; Type: VIEW; Schema: public; Owner: civitai
--

CREATE VIEW public."AnswerRank" AS
 SELECT t."answerId",
    max(public.iif((t.timeframe = 'Day'::public."MetricTimeframe"), t."heartCount", NULL::integer)) AS "heartCountDay",
    max(public.iif((t.timeframe = 'Day'::public."MetricTimeframe"), t."heartCountRank", NULL::bigint)) AS "heartCountDayRank",
    max(public.iif((t.timeframe = 'Week'::public."MetricTimeframe"), t."heartCount", NULL::integer)) AS "heartCountWeek",
    max(public.iif((t.timeframe = 'Week'::public."MetricTimeframe"), t."heartCountRank", NULL::bigint)) AS "heartCountWeekRank",
    max(public.iif((t.timeframe = 'Month'::public."MetricTimeframe"), t."heartCount", NULL::integer)) AS "heartCountMonth",
    max(public.iif((t.timeframe = 'Month'::public."MetricTimeframe"), t."heartCountRank", NULL::bigint)) AS "heartCountMonthRank",
    max(public.iif((t.timeframe = 'Year'::public."MetricTimeframe"), t."heartCount", NULL::integer)) AS "heartCountYear",
    max(public.iif((t.timeframe = 'Year'::public."MetricTimeframe"), t."heartCountRank", NULL::bigint)) AS "heartCountYearRank",
    max(public.iif((t.timeframe = 'AllTime'::public."MetricTimeframe"), t."heartCount", NULL::integer)) AS "heartCountAllTime",
    max(public.iif((t.timeframe = 'AllTime'::public."MetricTimeframe"), t."heartCountRank", NULL::bigint)) AS "heartCountAllTimeRank",
    max(public.iif((t.timeframe = 'Day'::public."MetricTimeframe"), t."commentCount", NULL::integer)) AS "commentCountDay",
    max(public.iif((t.timeframe = 'Day'::public."MetricTimeframe"), t."commentCountRank", NULL::bigint)) AS "commentCountDayRank",
    max(public.iif((t.timeframe = 'Week'::public."MetricTimeframe"), t."commentCount", NULL::integer)) AS "commentCountWeek",
    max(public.iif((t.timeframe = 'Week'::public."MetricTimeframe"), t."commentCountRank", NULL::bigint)) AS "commentCountWeekRank",
    max(public.iif((t.timeframe = 'Month'::public."MetricTimeframe"), t."commentCount", NULL::integer)) AS "commentCountMonth",
    max(public.iif((t.timeframe = 'Month'::public."MetricTimeframe"), t."commentCountRank", NULL::bigint)) AS "commentCountMonthRank",
    max(public.iif((t.timeframe = 'Year'::public."MetricTimeframe"), t."commentCount", NULL::integer)) AS "commentCountYear",
    max(public.iif((t.timeframe = 'Year'::public."MetricTimeframe"), t."commentCountRank", NULL::bigint)) AS "commentCountYearRank",
    max(public.iif((t.timeframe = 'AllTime'::public."MetricTimeframe"), t."commentCount", NULL::integer)) AS "commentCountAllTime",
    max(public.iif((t.timeframe = 'AllTime'::public."MetricTimeframe"), t."commentCountRank", NULL::bigint)) AS "commentCountAllTimeRank",
    max(public.iif((t.timeframe = 'Day'::public."MetricTimeframe"), t."checkCount", NULL::integer)) AS "checkCountDay",
    max(public.iif((t.timeframe = 'Day'::public."MetricTimeframe"), t."checkCountRank", NULL::bigint)) AS "checkCountDayRank",
    max(public.iif((t.timeframe = 'Week'::public."MetricTimeframe"), t."checkCount", NULL::integer)) AS "checkCountWeek",
    max(public.iif((t.timeframe = 'Week'::public."MetricTimeframe"), t."checkCountRank", NULL::bigint)) AS "checkCountWeekRank",
    max(public.iif((t.timeframe = 'Month'::public."MetricTimeframe"), t."checkCount", NULL::integer)) AS "checkCountMonth",
    max(public.iif((t.timeframe = 'Month'::public."MetricTimeframe"), t."checkCountRank", NULL::bigint)) AS "checkCountMonthRank",
    max(public.iif((t.timeframe = 'Year'::public."MetricTimeframe"), t."checkCount", NULL::integer)) AS "checkCountYear",
    max(public.iif((t.timeframe = 'Year'::public."MetricTimeframe"), t."checkCountRank", NULL::bigint)) AS "checkCountYearRank",
    max(public.iif((t.timeframe = 'AllTime'::public."MetricTimeframe"), t."checkCount", NULL::integer)) AS "checkCountAllTime",
    max(public.iif((t.timeframe = 'AllTime'::public."MetricTimeframe"), t."checkCountRank", NULL::bigint)) AS "checkCountAllTimeRank",
    max(public.iif((t.timeframe = 'Day'::public."MetricTimeframe"), t."crossCount", NULL::integer)) AS "crossCountDay",
    max(public.iif((t.timeframe = 'Day'::public."MetricTimeframe"), t."crossCountRank", NULL::bigint)) AS "crossCountDayRank",
    max(public.iif((t.timeframe = 'Week'::public."MetricTimeframe"), t."crossCount", NULL::integer)) AS "crossCountWeek",
    max(public.iif((t.timeframe = 'Week'::public."MetricTimeframe"), t."crossCountRank", NULL::bigint)) AS "crossCountWeekRank",
    max(public.iif((t.timeframe = 'Month'::public."MetricTimeframe"), t."crossCount", NULL::integer)) AS "crossCountMonth",
    max(public.iif((t.timeframe = 'Month'::public."MetricTimeframe"), t."crossCountRank", NULL::bigint)) AS "crossCountMonthRank",
    max(public.iif((t.timeframe = 'Year'::public."MetricTimeframe"), t."crossCount", NULL::integer)) AS "crossCountYear",
    max(public.iif((t.timeframe = 'Year'::public."MetricTimeframe"), t."crossCountRank", NULL::bigint)) AS "crossCountYearRank",
    max(public.iif((t.timeframe = 'AllTime'::public."MetricTimeframe"), t."crossCount", NULL::integer)) AS "crossCountAllTime",
    max(public.iif((t.timeframe = 'AllTime'::public."MetricTimeframe"), t."crossCountRank", NULL::bigint)) AS "crossCountAllTimeRank"
   FROM ( SELECT a.id AS "answerId",
            COALESCE(am."heartCount", 0) AS "heartCount",
            row_number() OVER (PARTITION BY tf.timeframe ORDER BY COALESCE(am."heartCount", 0) DESC, COALESCE(am."checkCount", 0) DESC, COALESCE(am."crossCount", 0), COALESCE(am."commentCount", 0) DESC, a.id DESC) AS "heartCountRank",
            COALESCE(am."commentCount", 0) AS "commentCount",
            row_number() OVER (PARTITION BY tf.timeframe ORDER BY COALESCE(am."commentCount", 0) DESC, COALESCE(am."heartCount", 0) DESC, COALESCE(am."checkCount", 0) DESC, a.id DESC) AS "commentCountRank",
            COALESCE(am."checkCount", 0) AS "checkCount",
            row_number() OVER (PARTITION BY tf.timeframe ORDER BY COALESCE(am."checkCount", 0) DESC, COALESCE(am."crossCount", 0), COALESCE(am."heartCount", 0) DESC, COALESCE(am."commentCount", 0) DESC, a.id DESC) AS "checkCountRank",
            COALESCE(am."crossCount", 0) AS "crossCount",
            row_number() OVER (PARTITION BY tf.timeframe ORDER BY COALESCE(am."crossCount", 0) DESC, COALESCE(am."checkCount", 0), COALESCE(am."heartCount", 0) DESC, COALESCE(am."commentCount", 0) DESC, a.id DESC) AS "crossCountRank",
            tf.timeframe
           FROM ((public."Answer" a
             CROSS JOIN ( SELECT unnest(enum_range(NULL::public."MetricTimeframe")) AS timeframe) tf)
             LEFT JOIN public."AnswerMetric" am ON (((am."answerId" = a.id) AND (am.timeframe = tf.timeframe))))) t
  GROUP BY t."answerId";


ALTER TABLE public."AnswerRank" OWNER TO civitai;

--
-- Name: AnswerReaction; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."AnswerReaction" (
    id integer NOT NULL,
    "answerId" integer NOT NULL,
    "userId" integer NOT NULL,
    reaction public."ReviewReactions" NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


ALTER TABLE public."AnswerReaction" OWNER TO civitai;

--
-- Name: AnswerReaction_id_seq; Type: SEQUENCE; Schema: public; Owner: civitai
--

CREATE SEQUENCE public."AnswerReaction_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public."AnswerReaction_id_seq" OWNER TO civitai;

--
-- Name: AnswerReaction_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: civitai
--

ALTER SEQUENCE public."AnswerReaction_id_seq" OWNED BY public."AnswerReaction".id;


--
-- Name: AnswerVote; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."AnswerVote" (
    "answerId" integer NOT NULL,
    "userId" integer NOT NULL,
    vote boolean,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


ALTER TABLE public."AnswerVote" OWNER TO civitai;

--
-- Name: Answer_id_seq; Type: SEQUENCE; Schema: public; Owner: civitai
--

CREATE SEQUENCE public."Answer_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public."Answer_id_seq" OWNER TO civitai;

--
-- Name: Answer_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: civitai
--

ALTER SEQUENCE public."Answer_id_seq" OWNED BY public."Answer".id;


--
-- Name: ApiKey; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."ApiKey" (
    key text NOT NULL,
    name text NOT NULL,
    scope public."KeyScope"[],
    "userId" integer NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "expiresAt" timestamp(3) without time zone,
    type public."ApiKeyType" DEFAULT 'User'::public."ApiKeyType" NOT NULL,
    "clientId" text,
    id integer NOT NULL
);


ALTER TABLE public."ApiKey" OWNER TO civitai;

--
-- Name: ApiKey_id_seq; Type: SEQUENCE; Schema: public; Owner: civitai
--

CREATE SEQUENCE public."ApiKey_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public."ApiKey_id_seq" OWNER TO civitai;

--
-- Name: ApiKey_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: civitai
--

ALTER SEQUENCE public."ApiKey_id_seq" OWNED BY public."ApiKey".id;


--
-- Name: Article; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."Article" (
    id integer NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" timestamp(3) without time zone,
    nsfw boolean DEFAULT false NOT NULL,
    "tosViolation" boolean DEFAULT false NOT NULL,
    metadata jsonb,
    title text NOT NULL,
    content text NOT NULL,
    cover text,
    "publishedAt" timestamp(3) without time zone,
    "userId" integer NOT NULL,
    availability public."Availability" DEFAULT 'Public'::public."Availability" NOT NULL,
    unlisted boolean DEFAULT false NOT NULL,
    "coverId" integer,
    "nsfwLevel" integer DEFAULT 0 NOT NULL,
    "userNsfwLevel" integer DEFAULT 0 NOT NULL,
    "lockedProperties" text[] DEFAULT ARRAY[]::text[]
);


ALTER TABLE public."Article" OWNER TO civitai;

--
-- Name: ArticleEngagement; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."ArticleEngagement" (
    "userId" integer NOT NULL,
    "articleId" integer NOT NULL,
    type public."ArticleEngagementType" NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


ALTER TABLE public."ArticleEngagement" OWNER TO civitai;

--
-- Name: ArticleMetric; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."ArticleMetric" (
    "articleId" integer NOT NULL,
    timeframe public."MetricTimeframe" NOT NULL,
    "likeCount" integer DEFAULT 0 NOT NULL,
    "dislikeCount" integer DEFAULT 0 NOT NULL,
    "laughCount" integer DEFAULT 0 NOT NULL,
    "cryCount" integer DEFAULT 0 NOT NULL,
    "heartCount" integer DEFAULT 0 NOT NULL,
    "commentCount" integer DEFAULT 0 NOT NULL,
    "viewCount" integer DEFAULT 0 NOT NULL,
    "favoriteCount" integer DEFAULT 0 NOT NULL,
    "hideCount" integer DEFAULT 0 NOT NULL,
    "collectedCount" integer DEFAULT 0 NOT NULL,
    "tippedAmountCount" integer DEFAULT 0 NOT NULL,
    "tippedCount" integer DEFAULT 0 NOT NULL,
    "updatedAt" timestamp(3) without time zone DEFAULT now()
);


ALTER TABLE public."ArticleMetric" OWNER TO civitai;

--
-- Name: ArticleRank; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."ArticleRank" (
    "articleId" integer NOT NULL,
    "heartCountDayRank" bigint,
    "heartCountWeekRank" bigint,
    "heartCountMonthRank" bigint,
    "heartCountYearRank" bigint,
    "heartCountAllTimeRank" bigint,
    "likeCountDayRank" bigint,
    "likeCountWeekRank" bigint,
    "likeCountMonthRank" bigint,
    "likeCountYearRank" bigint,
    "likeCountAllTimeRank" bigint,
    "dislikeCountDayRank" bigint,
    "dislikeCountWeekRank" bigint,
    "dislikeCountMonthRank" bigint,
    "dislikeCountYearRank" bigint,
    "dislikeCountAllTimeRank" bigint,
    "laughCountDayRank" bigint,
    "laughCountWeekRank" bigint,
    "laughCountMonthRank" bigint,
    "laughCountYearRank" bigint,
    "laughCountAllTimeRank" bigint,
    "cryCountDayRank" bigint,
    "cryCountWeekRank" bigint,
    "cryCountMonthRank" bigint,
    "cryCountYearRank" bigint,
    "cryCountAllTimeRank" bigint,
    "reactionCountDayRank" bigint,
    "reactionCountWeekRank" bigint,
    "reactionCountMonthRank" bigint,
    "reactionCountYearRank" bigint,
    "reactionCountAllTimeRank" bigint,
    "commentCountDayRank" bigint,
    "commentCountWeekRank" bigint,
    "commentCountMonthRank" bigint,
    "commentCountYearRank" bigint,
    "commentCountAllTimeRank" bigint,
    "viewCountDayRank" bigint,
    "viewCountWeekRank" bigint,
    "viewCountMonthRank" bigint,
    "viewCountYearRank" bigint,
    "viewCountAllTimeRank" bigint,
    "favoriteCountDayRank" bigint,
    "favoriteCountWeekRank" bigint,
    "favoriteCountMonthRank" bigint,
    "favoriteCountYearRank" bigint,
    "favoriteCountAllTimeRank" bigint,
    "hideCountDayRank" bigint,
    "hideCountWeekRank" bigint,
    "hideCountMonthRank" bigint,
    "hideCountYearRank" bigint,
    "hideCountAllTimeRank" bigint,
    "collectedCountDayRank" bigint,
    "collectedCountWeekRank" bigint,
    "collectedCountMonthRank" bigint,
    "collectedCountYearRank" bigint,
    "collectedCountAllTimeRank" bigint,
    "tippedCountDayRank" bigint,
    "tippedCountWeekRank" bigint,
    "tippedCountMonthRank" bigint,
    "tippedCountYearRank" bigint,
    "tippedCountAllTimeRank" bigint,
    "tippedAmountCountDayRank" bigint,
    "tippedAmountCountWeekRank" bigint,
    "tippedAmountCountMonthRank" bigint,
    "tippedAmountCountYearRank" bigint,
    "tippedAmountCountAllTimeRank" bigint
);


ALTER TABLE public."ArticleRank" OWNER TO civitai;

--
-- Name: ArticleRank_Live; Type: VIEW; Schema: public; Owner: civitai
--

CREATE VIEW public."ArticleRank_Live" AS
 WITH timeframe_stats AS (
         SELECT m."articleId",
            m."heartCount",
            m."likeCount",
            m."dislikeCount",
            m."laughCount",
            m."cryCount",
            m."commentCount",
            ((((m."heartCount" + m."likeCount") + m."dislikeCount") + m."laughCount") + m."cryCount") AS "reactionCount",
            m."viewCount",
            m."favoriteCount",
            m."hideCount",
            m."collectedCount",
            m."tippedCount",
            m."tippedAmountCount",
            m.timeframe
           FROM public."ArticleMetric" m
        ), timeframe_rank AS (
         SELECT timeframe_stats."articleId",
            row_number() OVER (PARTITION BY timeframe_stats.timeframe ORDER BY COALESCE(timeframe_stats."heartCount", 0) DESC, COALESCE(timeframe_stats."likeCount", 0) DESC, COALESCE(timeframe_stats."commentCount", 0) DESC, COALESCE(timeframe_stats."reactionCount", 0) DESC, timeframe_stats."articleId" DESC) AS "heartCountRank",
            row_number() OVER (PARTITION BY timeframe_stats.timeframe ORDER BY COALESCE(timeframe_stats."likeCount", 0) DESC, COALESCE(timeframe_stats."heartCount", 0) DESC, COALESCE(timeframe_stats."commentCount", 0) DESC, COALESCE(timeframe_stats."reactionCount", 0) DESC, timeframe_stats."articleId" DESC) AS "likeCountRank",
            row_number() OVER (PARTITION BY timeframe_stats.timeframe ORDER BY COALESCE(timeframe_stats."dislikeCount", 0) DESC, COALESCE(timeframe_stats."reactionCount", 0) DESC, COALESCE(timeframe_stats."commentCount", 0) DESC, timeframe_stats."articleId" DESC) AS "dislikeCountRank",
            row_number() OVER (PARTITION BY timeframe_stats.timeframe ORDER BY COALESCE(timeframe_stats."laughCount", 0) DESC, COALESCE(timeframe_stats."heartCount", 0) DESC, COALESCE(timeframe_stats."likeCount", 0) DESC, COALESCE(timeframe_stats."reactionCount", 0) DESC, COALESCE(timeframe_stats."commentCount", 0) DESC, timeframe_stats."articleId" DESC) AS "laughCountRank",
            row_number() OVER (PARTITION BY timeframe_stats.timeframe ORDER BY COALESCE(timeframe_stats."cryCount", 0) DESC, COALESCE(timeframe_stats."heartCount", 0) DESC, COALESCE(timeframe_stats."likeCount", 0) DESC, COALESCE(timeframe_stats."reactionCount", 0) DESC, COALESCE(timeframe_stats."commentCount", 0) DESC, timeframe_stats."articleId" DESC) AS "cryCountRank",
            row_number() OVER (PARTITION BY timeframe_stats.timeframe ORDER BY COALESCE(timeframe_stats."reactionCount", 0) DESC, COALESCE(timeframe_stats."heartCount", 0) DESC, COALESCE(timeframe_stats."likeCount", 0) DESC, COALESCE(timeframe_stats."commentCount", 0) DESC, timeframe_stats."articleId" DESC) AS "reactionCountRank",
            row_number() OVER (PARTITION BY timeframe_stats.timeframe ORDER BY COALESCE(timeframe_stats."commentCount", 0) DESC, COALESCE(timeframe_stats."reactionCount", 0) DESC, COALESCE(timeframe_stats."heartCount", 0) DESC, COALESCE(timeframe_stats."likeCount", 0) DESC, COALESCE(timeframe_stats."laughCount", 0) DESC, timeframe_stats."articleId" DESC) AS "commentCountRank",
            row_number() OVER (PARTITION BY timeframe_stats.timeframe ORDER BY COALESCE(timeframe_stats."viewCount", 0) DESC, COALESCE(timeframe_stats."reactionCount", 0) DESC, COALESCE(timeframe_stats."heartCount", 0) DESC, COALESCE(timeframe_stats."likeCount", 0) DESC, COALESCE(timeframe_stats."laughCount", 0) DESC, timeframe_stats."articleId" DESC) AS "viewCountRank",
            row_number() OVER (PARTITION BY timeframe_stats.timeframe ORDER BY COALESCE(timeframe_stats."favoriteCount", 0) DESC, COALESCE(timeframe_stats."reactionCount", 0) DESC, COALESCE(timeframe_stats."heartCount", 0) DESC, COALESCE(timeframe_stats."likeCount", 0) DESC, COALESCE(timeframe_stats."laughCount", 0) DESC, timeframe_stats."articleId" DESC) AS "favoriteCountRank",
            row_number() OVER (PARTITION BY timeframe_stats.timeframe ORDER BY COALESCE(timeframe_stats."hideCount", 0) DESC, COALESCE(timeframe_stats."reactionCount", 0) DESC, COALESCE(timeframe_stats."heartCount", 0) DESC, COALESCE(timeframe_stats."likeCount", 0) DESC, COALESCE(timeframe_stats."laughCount", 0) DESC, timeframe_stats."articleId" DESC) AS "hideCountRank",
            row_number() OVER (PARTITION BY timeframe_stats.timeframe ORDER BY COALESCE(timeframe_stats."collectedCount", 0) DESC, COALESCE(timeframe_stats."reactionCount", 0) DESC, COALESCE(timeframe_stats."heartCount", 0) DESC, COALESCE(timeframe_stats."likeCount", 0) DESC, COALESCE(timeframe_stats."laughCount", 0) DESC, timeframe_stats."articleId" DESC) AS "collectedCountRank",
            row_number() OVER (PARTITION BY timeframe_stats.timeframe ORDER BY COALESCE(timeframe_stats."tippedCount", 0) DESC, COALESCE(timeframe_stats."reactionCount", 0) DESC, COALESCE(timeframe_stats."heartCount", 0) DESC, COALESCE(timeframe_stats."likeCount", 0) DESC, COALESCE(timeframe_stats."laughCount", 0) DESC, timeframe_stats."articleId" DESC) AS "tippedCountRank",
            row_number() OVER (PARTITION BY timeframe_stats.timeframe ORDER BY COALESCE(timeframe_stats."tippedAmountCount", 0) DESC, COALESCE(timeframe_stats."reactionCount", 0) DESC, COALESCE(timeframe_stats."heartCount", 0) DESC, COALESCE(timeframe_stats."likeCount", 0) DESC, COALESCE(timeframe_stats."laughCount", 0) DESC, timeframe_stats."articleId" DESC) AS "tippedAmountCountRank",
            timeframe_stats.timeframe
           FROM timeframe_stats
        )
 SELECT timeframe_rank."articleId",
    max(public.iif((timeframe_rank.timeframe = 'Day'::public."MetricTimeframe"), timeframe_rank."heartCountRank", NULL::bigint)) AS "heartCountDayRank",
    max(public.iif((timeframe_rank.timeframe = 'Week'::public."MetricTimeframe"), timeframe_rank."heartCountRank", NULL::bigint)) AS "heartCountWeekRank",
    max(public.iif((timeframe_rank.timeframe = 'Month'::public."MetricTimeframe"), timeframe_rank."heartCountRank", NULL::bigint)) AS "heartCountMonthRank",
    max(public.iif((timeframe_rank.timeframe = 'Year'::public."MetricTimeframe"), timeframe_rank."heartCountRank", NULL::bigint)) AS "heartCountYearRank",
    max(public.iif((timeframe_rank.timeframe = 'AllTime'::public."MetricTimeframe"), timeframe_rank."heartCountRank", NULL::bigint)) AS "heartCountAllTimeRank",
    max(public.iif((timeframe_rank.timeframe = 'Day'::public."MetricTimeframe"), timeframe_rank."likeCountRank", NULL::bigint)) AS "likeCountDayRank",
    max(public.iif((timeframe_rank.timeframe = 'Week'::public."MetricTimeframe"), timeframe_rank."likeCountRank", NULL::bigint)) AS "likeCountWeekRank",
    max(public.iif((timeframe_rank.timeframe = 'Month'::public."MetricTimeframe"), timeframe_rank."likeCountRank", NULL::bigint)) AS "likeCountMonthRank",
    max(public.iif((timeframe_rank.timeframe = 'Year'::public."MetricTimeframe"), timeframe_rank."likeCountRank", NULL::bigint)) AS "likeCountYearRank",
    max(public.iif((timeframe_rank.timeframe = 'AllTime'::public."MetricTimeframe"), timeframe_rank."likeCountRank", NULL::bigint)) AS "likeCountAllTimeRank",
    max(public.iif((timeframe_rank.timeframe = 'Day'::public."MetricTimeframe"), timeframe_rank."dislikeCountRank", NULL::bigint)) AS "dislikeCountDayRank",
    max(public.iif((timeframe_rank.timeframe = 'Week'::public."MetricTimeframe"), timeframe_rank."dislikeCountRank", NULL::bigint)) AS "dislikeCountWeekRank",
    max(public.iif((timeframe_rank.timeframe = 'Month'::public."MetricTimeframe"), timeframe_rank."dislikeCountRank", NULL::bigint)) AS "dislikeCountMonthRank",
    max(public.iif((timeframe_rank.timeframe = 'Year'::public."MetricTimeframe"), timeframe_rank."dislikeCountRank", NULL::bigint)) AS "dislikeCountYearRank",
    max(public.iif((timeframe_rank.timeframe = 'AllTime'::public."MetricTimeframe"), timeframe_rank."dislikeCountRank", NULL::bigint)) AS "dislikeCountAllTimeRank",
    max(public.iif((timeframe_rank.timeframe = 'Day'::public."MetricTimeframe"), timeframe_rank."laughCountRank", NULL::bigint)) AS "laughCountDayRank",
    max(public.iif((timeframe_rank.timeframe = 'Week'::public."MetricTimeframe"), timeframe_rank."laughCountRank", NULL::bigint)) AS "laughCountWeekRank",
    max(public.iif((timeframe_rank.timeframe = 'Month'::public."MetricTimeframe"), timeframe_rank."laughCountRank", NULL::bigint)) AS "laughCountMonthRank",
    max(public.iif((timeframe_rank.timeframe = 'Year'::public."MetricTimeframe"), timeframe_rank."laughCountRank", NULL::bigint)) AS "laughCountYearRank",
    max(public.iif((timeframe_rank.timeframe = 'AllTime'::public."MetricTimeframe"), timeframe_rank."laughCountRank", NULL::bigint)) AS "laughCountAllTimeRank",
    max(public.iif((timeframe_rank.timeframe = 'Day'::public."MetricTimeframe"), timeframe_rank."cryCountRank", NULL::bigint)) AS "cryCountDayRank",
    max(public.iif((timeframe_rank.timeframe = 'Week'::public."MetricTimeframe"), timeframe_rank."cryCountRank", NULL::bigint)) AS "cryCountWeekRank",
    max(public.iif((timeframe_rank.timeframe = 'Month'::public."MetricTimeframe"), timeframe_rank."cryCountRank", NULL::bigint)) AS "cryCountMonthRank",
    max(public.iif((timeframe_rank.timeframe = 'Year'::public."MetricTimeframe"), timeframe_rank."cryCountRank", NULL::bigint)) AS "cryCountYearRank",
    max(public.iif((timeframe_rank.timeframe = 'AllTime'::public."MetricTimeframe"), timeframe_rank."cryCountRank", NULL::bigint)) AS "cryCountAllTimeRank",
    max(public.iif((timeframe_rank.timeframe = 'Day'::public."MetricTimeframe"), timeframe_rank."reactionCountRank", NULL::bigint)) AS "reactionCountDayRank",
    max(public.iif((timeframe_rank.timeframe = 'Week'::public."MetricTimeframe"), timeframe_rank."reactionCountRank", NULL::bigint)) AS "reactionCountWeekRank",
    max(public.iif((timeframe_rank.timeframe = 'Month'::public."MetricTimeframe"), timeframe_rank."reactionCountRank", NULL::bigint)) AS "reactionCountMonthRank",
    max(public.iif((timeframe_rank.timeframe = 'Year'::public."MetricTimeframe"), timeframe_rank."reactionCountRank", NULL::bigint)) AS "reactionCountYearRank",
    max(public.iif((timeframe_rank.timeframe = 'AllTime'::public."MetricTimeframe"), timeframe_rank."reactionCountRank", NULL::bigint)) AS "reactionCountAllTimeRank",
    max(public.iif((timeframe_rank.timeframe = 'Day'::public."MetricTimeframe"), timeframe_rank."commentCountRank", NULL::bigint)) AS "commentCountDayRank",
    max(public.iif((timeframe_rank.timeframe = 'Week'::public."MetricTimeframe"), timeframe_rank."commentCountRank", NULL::bigint)) AS "commentCountWeekRank",
    max(public.iif((timeframe_rank.timeframe = 'Month'::public."MetricTimeframe"), timeframe_rank."commentCountRank", NULL::bigint)) AS "commentCountMonthRank",
    max(public.iif((timeframe_rank.timeframe = 'Year'::public."MetricTimeframe"), timeframe_rank."commentCountRank", NULL::bigint)) AS "commentCountYearRank",
    max(public.iif((timeframe_rank.timeframe = 'AllTime'::public."MetricTimeframe"), timeframe_rank."commentCountRank", NULL::bigint)) AS "commentCountAllTimeRank",
    max(public.iif((timeframe_rank.timeframe = 'Day'::public."MetricTimeframe"), timeframe_rank."viewCountRank", NULL::bigint)) AS "viewCountDayRank",
    max(public.iif((timeframe_rank.timeframe = 'Week'::public."MetricTimeframe"), timeframe_rank."viewCountRank", NULL::bigint)) AS "viewCountWeekRank",
    max(public.iif((timeframe_rank.timeframe = 'Month'::public."MetricTimeframe"), timeframe_rank."viewCountRank", NULL::bigint)) AS "viewCountMonthRank",
    max(public.iif((timeframe_rank.timeframe = 'Year'::public."MetricTimeframe"), timeframe_rank."viewCountRank", NULL::bigint)) AS "viewCountYearRank",
    max(public.iif((timeframe_rank.timeframe = 'AllTime'::public."MetricTimeframe"), timeframe_rank."viewCountRank", NULL::bigint)) AS "viewCountAllTimeRank",
    max(public.iif((timeframe_rank.timeframe = 'Day'::public."MetricTimeframe"), timeframe_rank."favoriteCountRank", NULL::bigint)) AS "favoriteCountDayRank",
    max(public.iif((timeframe_rank.timeframe = 'Week'::public."MetricTimeframe"), timeframe_rank."favoriteCountRank", NULL::bigint)) AS "favoriteCountWeekRank",
    max(public.iif((timeframe_rank.timeframe = 'Month'::public."MetricTimeframe"), timeframe_rank."favoriteCountRank", NULL::bigint)) AS "favoriteCountMonthRank",
    max(public.iif((timeframe_rank.timeframe = 'Year'::public."MetricTimeframe"), timeframe_rank."favoriteCountRank", NULL::bigint)) AS "favoriteCountYearRank",
    max(public.iif((timeframe_rank.timeframe = 'AllTime'::public."MetricTimeframe"), timeframe_rank."favoriteCountRank", NULL::bigint)) AS "favoriteCountAllTimeRank",
    max(public.iif((timeframe_rank.timeframe = 'Day'::public."MetricTimeframe"), timeframe_rank."hideCountRank", NULL::bigint)) AS "hideCountDayRank",
    max(public.iif((timeframe_rank.timeframe = 'Week'::public."MetricTimeframe"), timeframe_rank."hideCountRank", NULL::bigint)) AS "hideCountWeekRank",
    max(public.iif((timeframe_rank.timeframe = 'Month'::public."MetricTimeframe"), timeframe_rank."hideCountRank", NULL::bigint)) AS "hideCountMonthRank",
    max(public.iif((timeframe_rank.timeframe = 'Year'::public."MetricTimeframe"), timeframe_rank."hideCountRank", NULL::bigint)) AS "hideCountYearRank",
    max(public.iif((timeframe_rank.timeframe = 'AllTime'::public."MetricTimeframe"), timeframe_rank."hideCountRank", NULL::bigint)) AS "hideCountAllTimeRank",
    max(public.iif((timeframe_rank.timeframe = 'Day'::public."MetricTimeframe"), timeframe_rank."collectedCountRank", NULL::bigint)) AS "collectedCountDayRank",
    max(public.iif((timeframe_rank.timeframe = 'Week'::public."MetricTimeframe"), timeframe_rank."collectedCountRank", NULL::bigint)) AS "collectedCountWeekRank",
    max(public.iif((timeframe_rank.timeframe = 'Month'::public."MetricTimeframe"), timeframe_rank."collectedCountRank", NULL::bigint)) AS "collectedCountMonthRank",
    max(public.iif((timeframe_rank.timeframe = 'Year'::public."MetricTimeframe"), timeframe_rank."collectedCountRank", NULL::bigint)) AS "collectedCountYearRank",
    max(public.iif((timeframe_rank.timeframe = 'AllTime'::public."MetricTimeframe"), timeframe_rank."collectedCountRank", NULL::bigint)) AS "collectedCountAllTimeRank",
    max(public.iif((timeframe_rank.timeframe = 'Day'::public."MetricTimeframe"), timeframe_rank."tippedCountRank", NULL::bigint)) AS "tippedCountDayRank",
    max(public.iif((timeframe_rank.timeframe = 'Week'::public."MetricTimeframe"), timeframe_rank."tippedCountRank", NULL::bigint)) AS "tippedCountWeekRank",
    max(public.iif((timeframe_rank.timeframe = 'Month'::public."MetricTimeframe"), timeframe_rank."tippedCountRank", NULL::bigint)) AS "tippedCountMonthRank",
    max(public.iif((timeframe_rank.timeframe = 'Year'::public."MetricTimeframe"), timeframe_rank."tippedCountRank", NULL::bigint)) AS "tippedCountYearRank",
    max(public.iif((timeframe_rank.timeframe = 'AllTime'::public."MetricTimeframe"), timeframe_rank."tippedCountRank", NULL::bigint)) AS "tippedCountAllTimeRank",
    max(public.iif((timeframe_rank.timeframe = 'Day'::public."MetricTimeframe"), timeframe_rank."tippedAmountCountRank", NULL::bigint)) AS "tippedAmountCountDayRank",
    max(public.iif((timeframe_rank.timeframe = 'Week'::public."MetricTimeframe"), timeframe_rank."tippedAmountCountRank", NULL::bigint)) AS "tippedAmountCountWeekRank",
    max(public.iif((timeframe_rank.timeframe = 'Month'::public."MetricTimeframe"), timeframe_rank."tippedAmountCountRank", NULL::bigint)) AS "tippedAmountCountMonthRank",
    max(public.iif((timeframe_rank.timeframe = 'Year'::public."MetricTimeframe"), timeframe_rank."tippedAmountCountRank", NULL::bigint)) AS "tippedAmountCountYearRank",
    max(public.iif((timeframe_rank.timeframe = 'AllTime'::public."MetricTimeframe"), timeframe_rank."tippedAmountCountRank", NULL::bigint)) AS "tippedAmountCountAllTimeRank"
   FROM timeframe_rank
  GROUP BY timeframe_rank."articleId";


ALTER TABLE public."ArticleRank_Live" OWNER TO civitai;

--
-- Name: ArticleReaction; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."ArticleReaction" (
    id integer NOT NULL,
    "articleId" integer NOT NULL,
    "userId" integer NOT NULL,
    reaction public."ReviewReactions" NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


ALTER TABLE public."ArticleReaction" OWNER TO civitai;

--
-- Name: ArticleReaction_id_seq; Type: SEQUENCE; Schema: public; Owner: civitai
--

CREATE SEQUENCE public."ArticleReaction_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public."ArticleReaction_id_seq" OWNER TO civitai;

--
-- Name: ArticleReaction_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: civitai
--

ALTER SEQUENCE public."ArticleReaction_id_seq" OWNED BY public."ArticleReaction".id;


--
-- Name: ArticleReport; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."ArticleReport" (
    "articleId" integer NOT NULL,
    "reportId" integer NOT NULL
);


ALTER TABLE public."ArticleReport" OWNER TO civitai;

--
-- Name: ArticleStat; Type: VIEW; Schema: public; Owner: civitai
--

CREATE VIEW public."ArticleStat" AS
 WITH timeframe_stats AS (
         SELECT m."articleId",
            COALESCE(m."heartCount", 0) AS "heartCount",
            COALESCE(m."likeCount", 0) AS "likeCount",
            COALESCE(m."dislikeCount", 0) AS "dislikeCount",
            COALESCE(m."laughCount", 0) AS "laughCount",
            COALESCE(m."cryCount", 0) AS "cryCount",
            COALESCE(m."commentCount", 0) AS "commentCount",
            COALESCE(m."viewCount", 0) AS "viewCount",
            COALESCE(m."favoriteCount", 0) AS "favoriteCount",
            COALESCE(m."hideCount", 0) AS "hideCount",
            COALESCE(m."tippedCount", 0) AS "tippedCount",
            COALESCE(m."tippedAmountCount", 0) AS "tippedAmountCount",
            COALESCE(m."collectedCount", 0) AS "collectedCount",
            m.timeframe
           FROM public."ArticleMetric" m
        )
 SELECT ts."articleId",
    max(public.iif((ts.timeframe = 'Day'::public."MetricTimeframe"), ts."heartCount", NULL::integer)) AS "heartCountDay",
    max(public.iif((ts.timeframe = 'Week'::public."MetricTimeframe"), ts."heartCount", NULL::integer)) AS "heartCountWeek",
    max(public.iif((ts.timeframe = 'Month'::public."MetricTimeframe"), ts."heartCount", NULL::integer)) AS "heartCountMonth",
    max(public.iif((ts.timeframe = 'Year'::public."MetricTimeframe"), ts."heartCount", NULL::integer)) AS "heartCountYear",
    max(public.iif((ts.timeframe = 'AllTime'::public."MetricTimeframe"), ts."heartCount", NULL::integer)) AS "heartCountAllTime",
    max(public.iif((ts.timeframe = 'Day'::public."MetricTimeframe"), ts."likeCount", NULL::integer)) AS "likeCountDay",
    max(public.iif((ts.timeframe = 'Week'::public."MetricTimeframe"), ts."likeCount", NULL::integer)) AS "likeCountWeek",
    max(public.iif((ts.timeframe = 'Month'::public."MetricTimeframe"), ts."likeCount", NULL::integer)) AS "likeCountMonth",
    max(public.iif((ts.timeframe = 'Year'::public."MetricTimeframe"), ts."likeCount", NULL::integer)) AS "likeCountYear",
    max(public.iif((ts.timeframe = 'AllTime'::public."MetricTimeframe"), ts."likeCount", NULL::integer)) AS "likeCountAllTime",
    max(public.iif((ts.timeframe = 'Day'::public."MetricTimeframe"), ts."dislikeCount", NULL::integer)) AS "dislikeCountDay",
    max(public.iif((ts.timeframe = 'Week'::public."MetricTimeframe"), ts."dislikeCount", NULL::integer)) AS "dislikeCountWeek",
    max(public.iif((ts.timeframe = 'Month'::public."MetricTimeframe"), ts."dislikeCount", NULL::integer)) AS "dislikeCountMonth",
    max(public.iif((ts.timeframe = 'Year'::public."MetricTimeframe"), ts."dislikeCount", NULL::integer)) AS "dislikeCountYear",
    max(public.iif((ts.timeframe = 'AllTime'::public."MetricTimeframe"), ts."dislikeCount", NULL::integer)) AS "dislikeCountAllTime",
    max(public.iif((ts.timeframe = 'Day'::public."MetricTimeframe"), ts."laughCount", NULL::integer)) AS "laughCountDay",
    max(public.iif((ts.timeframe = 'Week'::public."MetricTimeframe"), ts."laughCount", NULL::integer)) AS "laughCountWeek",
    max(public.iif((ts.timeframe = 'Month'::public."MetricTimeframe"), ts."laughCount", NULL::integer)) AS "laughCountMonth",
    max(public.iif((ts.timeframe = 'Year'::public."MetricTimeframe"), ts."laughCount", NULL::integer)) AS "laughCountYear",
    max(public.iif((ts.timeframe = 'AllTime'::public."MetricTimeframe"), ts."laughCount", NULL::integer)) AS "laughCountAllTime",
    max(public.iif((ts.timeframe = 'Day'::public."MetricTimeframe"), ts."cryCount", NULL::integer)) AS "cryCountDay",
    max(public.iif((ts.timeframe = 'Week'::public."MetricTimeframe"), ts."cryCount", NULL::integer)) AS "cryCountWeek",
    max(public.iif((ts.timeframe = 'Month'::public."MetricTimeframe"), ts."cryCount", NULL::integer)) AS "cryCountMonth",
    max(public.iif((ts.timeframe = 'Year'::public."MetricTimeframe"), ts."cryCount", NULL::integer)) AS "cryCountYear",
    max(public.iif((ts.timeframe = 'AllTime'::public."MetricTimeframe"), ts."cryCount", NULL::integer)) AS "cryCountAllTime",
    max(public.iif((ts.timeframe = 'Day'::public."MetricTimeframe"), ts."commentCount", NULL::integer)) AS "commentCountDay",
    max(public.iif((ts.timeframe = 'Week'::public."MetricTimeframe"), ts."commentCount", NULL::integer)) AS "commentCountWeek",
    max(public.iif((ts.timeframe = 'Month'::public."MetricTimeframe"), ts."commentCount", NULL::integer)) AS "commentCountMonth",
    max(public.iif((ts.timeframe = 'Year'::public."MetricTimeframe"), ts."commentCount", NULL::integer)) AS "commentCountYear",
    max(public.iif((ts.timeframe = 'AllTime'::public."MetricTimeframe"), ts."commentCount", NULL::integer)) AS "commentCountAllTime",
    max(public.iif((ts.timeframe = 'Day'::public."MetricTimeframe"), ((((ts."heartCount" + ts."dislikeCount") + ts."likeCount") + ts."cryCount") + ts."laughCount"), NULL::integer)) AS "reactionCountDay",
    max(public.iif((ts.timeframe = 'Week'::public."MetricTimeframe"), ((((ts."heartCount" + ts."dislikeCount") + ts."likeCount") + ts."cryCount") + ts."laughCount"), NULL::integer)) AS "reactionCountWeek",
    max(public.iif((ts.timeframe = 'Month'::public."MetricTimeframe"), ((((ts."heartCount" + ts."dislikeCount") + ts."likeCount") + ts."cryCount") + ts."laughCount"), NULL::integer)) AS "reactionCountMonth",
    max(public.iif((ts.timeframe = 'Year'::public."MetricTimeframe"), ((((ts."heartCount" + ts."dislikeCount") + ts."likeCount") + ts."cryCount") + ts."laughCount"), NULL::integer)) AS "reactionCountYear",
    max(public.iif((ts.timeframe = 'AllTime'::public."MetricTimeframe"), ((((ts."heartCount" + ts."dislikeCount") + ts."likeCount") + ts."cryCount") + ts."laughCount"), NULL::integer)) AS "reactionCountAllTime",
    max(public.iif((ts.timeframe = 'Day'::public."MetricTimeframe"), ts."viewCount", NULL::integer)) AS "viewCountDay",
    max(public.iif((ts.timeframe = 'Week'::public."MetricTimeframe"), ts."viewCount", NULL::integer)) AS "viewCountWeek",
    max(public.iif((ts.timeframe = 'Month'::public."MetricTimeframe"), ts."viewCount", NULL::integer)) AS "viewCountMonth",
    max(public.iif((ts.timeframe = 'Year'::public."MetricTimeframe"), ts."viewCount", NULL::integer)) AS "viewCountYear",
    max(public.iif((ts.timeframe = 'AllTime'::public."MetricTimeframe"), ts."viewCount", NULL::integer)) AS "viewCountAllTime",
    max(public.iif((ts.timeframe = 'Day'::public."MetricTimeframe"), ts."favoriteCount", NULL::integer)) AS "favoriteCountDay",
    max(public.iif((ts.timeframe = 'Week'::public."MetricTimeframe"), ts."favoriteCount", NULL::integer)) AS "favoriteCountWeek",
    max(public.iif((ts.timeframe = 'Month'::public."MetricTimeframe"), ts."favoriteCount", NULL::integer)) AS "favoriteCountMonth",
    max(public.iif((ts.timeframe = 'Year'::public."MetricTimeframe"), ts."favoriteCount", NULL::integer)) AS "favoriteCountYear",
    max(public.iif((ts.timeframe = 'AllTime'::public."MetricTimeframe"), ts."favoriteCount", NULL::integer)) AS "favoriteCountAllTime",
    max(public.iif((ts.timeframe = 'Day'::public."MetricTimeframe"), ts."collectedCount", NULL::integer)) AS "collectedCountDay",
    max(public.iif((ts.timeframe = 'Week'::public."MetricTimeframe"), ts."collectedCount", NULL::integer)) AS "collectedCountWeek",
    max(public.iif((ts.timeframe = 'Month'::public."MetricTimeframe"), ts."collectedCount", NULL::integer)) AS "collectedCountMonth",
    max(public.iif((ts.timeframe = 'Year'::public."MetricTimeframe"), ts."collectedCount", NULL::integer)) AS "collectedCountYear",
    max(public.iif((ts.timeframe = 'AllTime'::public."MetricTimeframe"), ts."collectedCount", NULL::integer)) AS "collectedCountAllTime",
    max(public.iif((ts.timeframe = 'Day'::public."MetricTimeframe"), ts."hideCount", NULL::integer)) AS "hideCountDay",
    max(public.iif((ts.timeframe = 'Week'::public."MetricTimeframe"), ts."hideCount", NULL::integer)) AS "hideCountWeek",
    max(public.iif((ts.timeframe = 'Month'::public."MetricTimeframe"), ts."hideCount", NULL::integer)) AS "hideCountMonth",
    max(public.iif((ts.timeframe = 'Year'::public."MetricTimeframe"), ts."hideCount", NULL::integer)) AS "hideCountYear",
    max(public.iif((ts.timeframe = 'AllTime'::public."MetricTimeframe"), ts."hideCount", NULL::integer)) AS "hideCountAllTime",
    max(public.iif((ts.timeframe = 'Day'::public."MetricTimeframe"), ts."tippedCount", NULL::integer)) AS "tippedCountDay",
    max(public.iif((ts.timeframe = 'Week'::public."MetricTimeframe"), ts."tippedCount", NULL::integer)) AS "tippedCountWeek",
    max(public.iif((ts.timeframe = 'Month'::public."MetricTimeframe"), ts."tippedCount", NULL::integer)) AS "tippedCountMonth",
    max(public.iif((ts.timeframe = 'Year'::public."MetricTimeframe"), ts."tippedCount", NULL::integer)) AS "tippedCountYear",
    max(public.iif((ts.timeframe = 'AllTime'::public."MetricTimeframe"), ts."tippedCount", NULL::integer)) AS "tippedCountAllTime",
    max(public.iif((ts.timeframe = 'Day'::public."MetricTimeframe"), ts."tippedAmountCount", NULL::integer)) AS "tippedAmountCountDay",
    max(public.iif((ts.timeframe = 'Week'::public."MetricTimeframe"), ts."tippedAmountCount", NULL::integer)) AS "tippedAmountCountWeek",
    max(public.iif((ts.timeframe = 'Month'::public."MetricTimeframe"), ts."tippedAmountCount", NULL::integer)) AS "tippedAmountCountMonth",
    max(public.iif((ts.timeframe = 'Year'::public."MetricTimeframe"), ts."tippedAmountCount", NULL::integer)) AS "tippedAmountCountYear",
    max(public.iif((ts.timeframe = 'AllTime'::public."MetricTimeframe"), ts."tippedAmountCount", NULL::integer)) AS "tippedAmountCountAllTime"
   FROM timeframe_stats ts
  GROUP BY ts."articleId";


ALTER TABLE public."ArticleStat" OWNER TO civitai;

--
-- Name: Article_id_seq; Type: SEQUENCE; Schema: public; Owner: civitai
--

CREATE SEQUENCE public."Article_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public."Article_id_seq" OWNER TO civitai;

--
-- Name: Article_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: civitai
--

ALTER SEQUENCE public."Article_id_seq" OWNED BY public."Article".id;

--
-- Name: Bounty; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."Bounty" (
    id integer NOT NULL,
    "userId" integer,
    name text NOT NULL,
    description text NOT NULL,
    "startsAt" date NOT NULL,
    "expiresAt" date NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    details jsonb,
    mode public."BountyMode" DEFAULT 'Individual'::public."BountyMode" NOT NULL,
    "entryMode" public."BountyEntryMode" DEFAULT 'Open'::public."BountyEntryMode" NOT NULL,
    type public."BountyType" NOT NULL,
    "minBenefactorUnitAmount" integer NOT NULL,
    "maxBenefactorUnitAmount" integer,
    "entryLimit" integer DEFAULT 1 NOT NULL,
    nsfw boolean DEFAULT false NOT NULL,
    complete boolean DEFAULT false NOT NULL,
    poi boolean DEFAULT false NOT NULL,
    refunded boolean DEFAULT false NOT NULL,
    availability public."Availability" DEFAULT 'Public'::public."Availability" NOT NULL,
    "nsfwLevel" integer DEFAULT 0 NOT NULL,
    "lockedProperties" text[] DEFAULT ARRAY[]::text[]
);


ALTER TABLE public."Bounty" OWNER TO civitai;

--
-- Name: BountyBenefactor; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."BountyBenefactor" (
    "userId" integer NOT NULL,
    "bountyId" integer NOT NULL,
    "unitAmount" integer NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "awardedAt" timestamp(3) without time zone,
    "awardedToId" integer,
    currency public."Currency" DEFAULT 'BUZZ'::public."Currency" NOT NULL
);


ALTER TABLE public."BountyBenefactor" OWNER TO civitai;

--
-- Name: BountyEngagement; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."BountyEngagement" (
    "userId" integer NOT NULL,
    "bountyId" integer NOT NULL,
    type public."BountyEngagementType" NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


ALTER TABLE public."BountyEngagement" OWNER TO civitai;

--
-- Name: BountyEntry; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."BountyEntry" (
    id integer NOT NULL,
    "userId" integer,
    "bountyId" integer NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    locked boolean DEFAULT false NOT NULL,
    description text,
    "nsfwLevel" integer DEFAULT 0 NOT NULL
);


ALTER TABLE public."BountyEntry" OWNER TO civitai;

--
-- Name: BountyEntryMetric; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."BountyEntryMetric" (
    "bountyEntryId" integer NOT NULL,
    timeframe public."MetricTimeframe" NOT NULL,
    "likeCount" integer DEFAULT 0 NOT NULL,
    "dislikeCount" integer DEFAULT 0 NOT NULL,
    "laughCount" integer DEFAULT 0 NOT NULL,
    "cryCount" integer DEFAULT 0 NOT NULL,
    "heartCount" integer DEFAULT 0 NOT NULL,
    "unitAmountCount" integer DEFAULT 0 NOT NULL,
    "tippedAmountCount" integer DEFAULT 0 NOT NULL,
    "tippedCount" integer DEFAULT 0 NOT NULL,
    "updatedAt" timestamp(3) without time zone DEFAULT now()
);


ALTER TABLE public."BountyEntryMetric" OWNER TO civitai;

--
-- Name: BountyEntryRank; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."BountyEntryRank" (
    "bountyEntryId" integer NOT NULL,
    "heartCountDayRank" bigint,
    "heartCountWeekRank" bigint,
    "heartCountMonthRank" bigint,
    "heartCountYearRank" bigint,
    "heartCountAllTimeRank" bigint,
    "likeCountDayRank" bigint,
    "likeCountWeekRank" bigint,
    "likeCountMonthRank" bigint,
    "likeCountYearRank" bigint,
    "likeCountAllTimeRank" bigint,
    "dislikeCountDayRank" bigint,
    "dislikeCountWeekRank" bigint,
    "dislikeCountMonthRank" bigint,
    "dislikeCountYearRank" bigint,
    "dislikeCountAllTimeRank" bigint,
    "laughCountDayRank" bigint,
    "laughCountWeekRank" bigint,
    "laughCountMonthRank" bigint,
    "laughCountYearRank" bigint,
    "laughCountAllTimeRank" bigint,
    "cryCountDayRank" bigint,
    "cryCountWeekRank" bigint,
    "cryCountMonthRank" bigint,
    "cryCountYearRank" bigint,
    "cryCountAllTimeRank" bigint,
    "reactionCountDayRank" bigint,
    "reactionCountWeekRank" bigint,
    "reactionCountMonthRank" bigint,
    "reactionCountYearRank" bigint,
    "reactionCountAllTimeRank" bigint,
    "unitAmountCountDayRank" bigint,
    "unitAmountCountWeekRank" bigint,
    "unitAmountCountMonthRank" bigint,
    "unitAmountCountYearRank" bigint,
    "unitAmountCountAllTimeRank" bigint,
    "tippedCountDayRank" bigint,
    "tippedCountWeekRank" bigint,
    "tippedCountMonthRank" bigint,
    "tippedCountYearRank" bigint,
    "tippedCountAllTimeRank" bigint,
    "tippedAmountCountDayRank" bigint,
    "tippedAmountCountWeekRank" bigint,
    "tippedAmountCountMonthRank" bigint,
    "tippedAmountCountYearRank" bigint,
    "tippedAmountCountAllTimeRank" bigint
);


ALTER TABLE public."BountyEntryRank" OWNER TO civitai;

--
-- Name: BountyEntryRank_Live; Type: VIEW; Schema: public; Owner: civitai
--

CREATE VIEW public."BountyEntryRank_Live" AS
 WITH timeframe_stats AS (
         SELECT m."bountyEntryId",
            m."heartCount",
            m."likeCount",
            m."dislikeCount",
            m."laughCount",
            m."cryCount",
            ((((m."heartCount" + m."likeCount") + m."dislikeCount") + m."laughCount") + m."cryCount") AS "reactionCount",
            m."unitAmountCount",
            m."tippedCount",
            m."tippedAmountCount",
            m.timeframe
           FROM public."BountyEntryMetric" m
        ), timeframe_rank AS (
         SELECT timeframe_stats."bountyEntryId",
            row_number() OVER (PARTITION BY timeframe_stats.timeframe ORDER BY COALESCE(timeframe_stats."heartCount", 0) DESC, COALESCE(timeframe_stats."likeCount", 0) DESC, COALESCE(timeframe_stats."reactionCount", 0) DESC, timeframe_stats."bountyEntryId" DESC) AS "heartCountRank",
            row_number() OVER (PARTITION BY timeframe_stats.timeframe ORDER BY COALESCE(timeframe_stats."likeCount", 0) DESC, COALESCE(timeframe_stats."heartCount", 0) DESC, COALESCE(timeframe_stats."reactionCount", 0) DESC, timeframe_stats."bountyEntryId" DESC) AS "likeCountRank",
            row_number() OVER (PARTITION BY timeframe_stats.timeframe ORDER BY COALESCE(timeframe_stats."dislikeCount", 0) DESC, COALESCE(timeframe_stats."reactionCount", 0) DESC, timeframe_stats."bountyEntryId" DESC) AS "dislikeCountRank",
            row_number() OVER (PARTITION BY timeframe_stats.timeframe ORDER BY COALESCE(timeframe_stats."laughCount", 0) DESC, COALESCE(timeframe_stats."heartCount", 0) DESC, COALESCE(timeframe_stats."likeCount", 0) DESC, COALESCE(timeframe_stats."reactionCount", 0) DESC, timeframe_stats."bountyEntryId" DESC) AS "laughCountRank",
            row_number() OVER (PARTITION BY timeframe_stats.timeframe ORDER BY COALESCE(timeframe_stats."cryCount", 0) DESC, COALESCE(timeframe_stats."heartCount", 0) DESC, COALESCE(timeframe_stats."likeCount", 0) DESC, COALESCE(timeframe_stats."reactionCount", 0) DESC, timeframe_stats."bountyEntryId" DESC) AS "cryCountRank",
            row_number() OVER (PARTITION BY timeframe_stats.timeframe ORDER BY COALESCE(timeframe_stats."reactionCount", 0) DESC, COALESCE(timeframe_stats."heartCount", 0) DESC, COALESCE(timeframe_stats."likeCount", 0) DESC, timeframe_stats."bountyEntryId" DESC) AS "reactionCountRank",
            row_number() OVER (PARTITION BY timeframe_stats.timeframe ORDER BY COALESCE(timeframe_stats."unitAmountCount", 0) DESC, COALESCE(timeframe_stats."reactionCount", 0) DESC, timeframe_stats."bountyEntryId" DESC) AS "unitAmountCountRank",
            row_number() OVER (PARTITION BY timeframe_stats.timeframe ORDER BY COALESCE(timeframe_stats."tippedCount", 0) DESC, COALESCE(timeframe_stats."reactionCount", 0) DESC, COALESCE(timeframe_stats."heartCount", 0) DESC, COALESCE(timeframe_stats."likeCount", 0) DESC, COALESCE(timeframe_stats."laughCount", 0) DESC, timeframe_stats."bountyEntryId" DESC) AS "tippedCountRank",
            row_number() OVER (PARTITION BY timeframe_stats.timeframe ORDER BY COALESCE(timeframe_stats."tippedAmountCount", 0) DESC, COALESCE(timeframe_stats."reactionCount", 0) DESC, COALESCE(timeframe_stats."heartCount", 0) DESC, COALESCE(timeframe_stats."likeCount", 0) DESC, COALESCE(timeframe_stats."laughCount", 0) DESC, timeframe_stats."bountyEntryId" DESC) AS "tippedAmountCountRank",
            timeframe_stats.timeframe
           FROM timeframe_stats
        )
 SELECT timeframe_rank."bountyEntryId",
    max(public.iif((timeframe_rank.timeframe = 'Day'::public."MetricTimeframe"), timeframe_rank."heartCountRank", NULL::bigint)) AS "heartCountDayRank",
    max(public.iif((timeframe_rank.timeframe = 'Week'::public."MetricTimeframe"), timeframe_rank."heartCountRank", NULL::bigint)) AS "heartCountWeekRank",
    max(public.iif((timeframe_rank.timeframe = 'Month'::public."MetricTimeframe"), timeframe_rank."heartCountRank", NULL::bigint)) AS "heartCountMonthRank",
    max(public.iif((timeframe_rank.timeframe = 'Year'::public."MetricTimeframe"), timeframe_rank."heartCountRank", NULL::bigint)) AS "heartCountYearRank",
    max(public.iif((timeframe_rank.timeframe = 'AllTime'::public."MetricTimeframe"), timeframe_rank."heartCountRank", NULL::bigint)) AS "heartCountAllTimeRank",
    max(public.iif((timeframe_rank.timeframe = 'Day'::public."MetricTimeframe"), timeframe_rank."likeCountRank", NULL::bigint)) AS "likeCountDayRank",
    max(public.iif((timeframe_rank.timeframe = 'Week'::public."MetricTimeframe"), timeframe_rank."likeCountRank", NULL::bigint)) AS "likeCountWeekRank",
    max(public.iif((timeframe_rank.timeframe = 'Month'::public."MetricTimeframe"), timeframe_rank."likeCountRank", NULL::bigint)) AS "likeCountMonthRank",
    max(public.iif((timeframe_rank.timeframe = 'Year'::public."MetricTimeframe"), timeframe_rank."likeCountRank", NULL::bigint)) AS "likeCountYearRank",
    max(public.iif((timeframe_rank.timeframe = 'AllTime'::public."MetricTimeframe"), timeframe_rank."likeCountRank", NULL::bigint)) AS "likeCountAllTimeRank",
    max(public.iif((timeframe_rank.timeframe = 'Day'::public."MetricTimeframe"), timeframe_rank."dislikeCountRank", NULL::bigint)) AS "dislikeCountDayRank",
    max(public.iif((timeframe_rank.timeframe = 'Week'::public."MetricTimeframe"), timeframe_rank."dislikeCountRank", NULL::bigint)) AS "dislikeCountWeekRank",
    max(public.iif((timeframe_rank.timeframe = 'Month'::public."MetricTimeframe"), timeframe_rank."dislikeCountRank", NULL::bigint)) AS "dislikeCountMonthRank",
    max(public.iif((timeframe_rank.timeframe = 'Year'::public."MetricTimeframe"), timeframe_rank."dislikeCountRank", NULL::bigint)) AS "dislikeCountYearRank",
    max(public.iif((timeframe_rank.timeframe = 'AllTime'::public."MetricTimeframe"), timeframe_rank."dislikeCountRank", NULL::bigint)) AS "dislikeCountAllTimeRank",
    max(public.iif((timeframe_rank.timeframe = 'Day'::public."MetricTimeframe"), timeframe_rank."laughCountRank", NULL::bigint)) AS "laughCountDayRank",
    max(public.iif((timeframe_rank.timeframe = 'Week'::public."MetricTimeframe"), timeframe_rank."laughCountRank", NULL::bigint)) AS "laughCountWeekRank",
    max(public.iif((timeframe_rank.timeframe = 'Month'::public."MetricTimeframe"), timeframe_rank."laughCountRank", NULL::bigint)) AS "laughCountMonthRank",
    max(public.iif((timeframe_rank.timeframe = 'Year'::public."MetricTimeframe"), timeframe_rank."laughCountRank", NULL::bigint)) AS "laughCountYearRank",
    max(public.iif((timeframe_rank.timeframe = 'AllTime'::public."MetricTimeframe"), timeframe_rank."laughCountRank", NULL::bigint)) AS "laughCountAllTimeRank",
    max(public.iif((timeframe_rank.timeframe = 'Day'::public."MetricTimeframe"), timeframe_rank."cryCountRank", NULL::bigint)) AS "cryCountDayRank",
    max(public.iif((timeframe_rank.timeframe = 'Week'::public."MetricTimeframe"), timeframe_rank."cryCountRank", NULL::bigint)) AS "cryCountWeekRank",
    max(public.iif((timeframe_rank.timeframe = 'Month'::public."MetricTimeframe"), timeframe_rank."cryCountRank", NULL::bigint)) AS "cryCountMonthRank",
    max(public.iif((timeframe_rank.timeframe = 'Year'::public."MetricTimeframe"), timeframe_rank."cryCountRank", NULL::bigint)) AS "cryCountYearRank",
    max(public.iif((timeframe_rank.timeframe = 'AllTime'::public."MetricTimeframe"), timeframe_rank."cryCountRank", NULL::bigint)) AS "cryCountAllTimeRank",
    max(public.iif((timeframe_rank.timeframe = 'Day'::public."MetricTimeframe"), timeframe_rank."reactionCountRank", NULL::bigint)) AS "reactionCountDayRank",
    max(public.iif((timeframe_rank.timeframe = 'Week'::public."MetricTimeframe"), timeframe_rank."reactionCountRank", NULL::bigint)) AS "reactionCountWeekRank",
    max(public.iif((timeframe_rank.timeframe = 'Month'::public."MetricTimeframe"), timeframe_rank."reactionCountRank", NULL::bigint)) AS "reactionCountMonthRank",
    max(public.iif((timeframe_rank.timeframe = 'Year'::public."MetricTimeframe"), timeframe_rank."reactionCountRank", NULL::bigint)) AS "reactionCountYearRank",
    max(public.iif((timeframe_rank.timeframe = 'AllTime'::public."MetricTimeframe"), timeframe_rank."reactionCountRank", NULL::bigint)) AS "reactionCountAllTimeRank",
    max(public.iif((timeframe_rank.timeframe = 'Day'::public."MetricTimeframe"), timeframe_rank."unitAmountCountRank", NULL::bigint)) AS "unitAmountCountDayRank",
    max(public.iif((timeframe_rank.timeframe = 'Week'::public."MetricTimeframe"), timeframe_rank."unitAmountCountRank", NULL::bigint)) AS "unitAmountCountWeekRank",
    max(public.iif((timeframe_rank.timeframe = 'Month'::public."MetricTimeframe"), timeframe_rank."unitAmountCountRank", NULL::bigint)) AS "unitAmountCountMonthRank",
    max(public.iif((timeframe_rank.timeframe = 'Year'::public."MetricTimeframe"), timeframe_rank."unitAmountCountRank", NULL::bigint)) AS "unitAmountCountYearRank",
    max(public.iif((timeframe_rank.timeframe = 'AllTime'::public."MetricTimeframe"), timeframe_rank."unitAmountCountRank", NULL::bigint)) AS "unitAmountCountAllTimeRank",
    max(public.iif((timeframe_rank.timeframe = 'Day'::public."MetricTimeframe"), timeframe_rank."tippedCountRank", NULL::bigint)) AS "tippedCountDayRank",
    max(public.iif((timeframe_rank.timeframe = 'Week'::public."MetricTimeframe"), timeframe_rank."tippedCountRank", NULL::bigint)) AS "tippedCountWeekRank",
    max(public.iif((timeframe_rank.timeframe = 'Month'::public."MetricTimeframe"), timeframe_rank."tippedCountRank", NULL::bigint)) AS "tippedCountMonthRank",
    max(public.iif((timeframe_rank.timeframe = 'Year'::public."MetricTimeframe"), timeframe_rank."tippedCountRank", NULL::bigint)) AS "tippedCountYearRank",
    max(public.iif((timeframe_rank.timeframe = 'AllTime'::public."MetricTimeframe"), timeframe_rank."tippedCountRank", NULL::bigint)) AS "tippedCountAllTimeRank",
    max(public.iif((timeframe_rank.timeframe = 'Day'::public."MetricTimeframe"), timeframe_rank."tippedAmountCountRank", NULL::bigint)) AS "tippedAmountCountDayRank",
    max(public.iif((timeframe_rank.timeframe = 'Week'::public."MetricTimeframe"), timeframe_rank."tippedAmountCountRank", NULL::bigint)) AS "tippedAmountCountWeekRank",
    max(public.iif((timeframe_rank.timeframe = 'Month'::public."MetricTimeframe"), timeframe_rank."tippedAmountCountRank", NULL::bigint)) AS "tippedAmountCountMonthRank",
    max(public.iif((timeframe_rank.timeframe = 'Year'::public."MetricTimeframe"), timeframe_rank."tippedAmountCountRank", NULL::bigint)) AS "tippedAmountCountYearRank",
    max(public.iif((timeframe_rank.timeframe = 'AllTime'::public."MetricTimeframe"), timeframe_rank."tippedAmountCountRank", NULL::bigint)) AS "tippedAmountCountAllTimeRank"
   FROM timeframe_rank
  GROUP BY timeframe_rank."bountyEntryId";


ALTER TABLE public."BountyEntryRank_Live" OWNER TO civitai;

--
-- Name: BountyEntryRank_New; Type: TABLE; Schema: public; Owner: civitai-jobs
--

CREATE TABLE public."BountyEntryRank_New" (
    "bountyEntryId" integer NOT NULL,
    "heartCountDayRank" bigint,
    "heartCountWeekRank" bigint,
    "heartCountMonthRank" bigint,
    "heartCountYearRank" bigint,
    "heartCountAllTimeRank" bigint,
    "likeCountDayRank" bigint,
    "likeCountWeekRank" bigint,
    "likeCountMonthRank" bigint,
    "likeCountYearRank" bigint,
    "likeCountAllTimeRank" bigint,
    "dislikeCountDayRank" bigint,
    "dislikeCountWeekRank" bigint,
    "dislikeCountMonthRank" bigint,
    "dislikeCountYearRank" bigint,
    "dislikeCountAllTimeRank" bigint,
    "laughCountDayRank" bigint,
    "laughCountWeekRank" bigint,
    "laughCountMonthRank" bigint,
    "laughCountYearRank" bigint,
    "laughCountAllTimeRank" bigint,
    "cryCountDayRank" bigint,
    "cryCountWeekRank" bigint,
    "cryCountMonthRank" bigint,
    "cryCountYearRank" bigint,
    "cryCountAllTimeRank" bigint,
    "reactionCountDayRank" bigint,
    "reactionCountWeekRank" bigint,
    "reactionCountMonthRank" bigint,
    "reactionCountYearRank" bigint,
    "reactionCountAllTimeRank" bigint,
    "unitAmountCountDayRank" bigint,
    "unitAmountCountWeekRank" bigint,
    "unitAmountCountMonthRank" bigint,
    "unitAmountCountYearRank" bigint,
    "unitAmountCountAllTimeRank" bigint,
    "tippedCountDayRank" bigint,
    "tippedCountWeekRank" bigint,
    "tippedCountMonthRank" bigint,
    "tippedCountYearRank" bigint,
    "tippedCountAllTimeRank" bigint,
    "tippedAmountCountDayRank" bigint,
    "tippedAmountCountWeekRank" bigint,
    "tippedAmountCountMonthRank" bigint,
    "tippedAmountCountYearRank" bigint,
    "tippedAmountCountAllTimeRank" bigint
);


ALTER TABLE public."BountyEntryRank_New" OWNER TO "civitai-jobs";

--
-- Name: BountyEntryReaction; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."BountyEntryReaction" (
    "bountyEntryId" integer NOT NULL,
    "userId" integer NOT NULL,
    reaction public."ReviewReactions" NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


ALTER TABLE public."BountyEntryReaction" OWNER TO civitai;

--
-- Name: BountyEntryReport; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."BountyEntryReport" (
    "bountyEntryId" integer NOT NULL,
    "reportId" integer NOT NULL
);


ALTER TABLE public."BountyEntryReport" OWNER TO civitai;

--
-- Name: BountyEntryStat; Type: VIEW; Schema: public; Owner: civitai
--

CREATE VIEW public."BountyEntryStat" AS
SELECT
    NULL::integer AS "bountyEntryId",
    NULL::integer AS "heartCountDay",
    NULL::integer AS "heartCountWeek",
    NULL::integer AS "heartCountMonth",
    NULL::integer AS "heartCountYear",
    NULL::integer AS "heartCountAllTime",
    NULL::integer AS "likeCountDay",
    NULL::integer AS "likeCountWeek",
    NULL::integer AS "likeCountMonth",
    NULL::integer AS "likeCountYear",
    NULL::integer AS "likeCountAllTime",
    NULL::integer AS "dislikeCountDay",
    NULL::integer AS "dislikeCountWeek",
    NULL::integer AS "dislikeCountMonth",
    NULL::integer AS "dislikeCountYear",
    NULL::integer AS "dislikeCountAllTime",
    NULL::integer AS "laughCountDay",
    NULL::integer AS "laughCountWeek",
    NULL::integer AS "laughCountMonth",
    NULL::integer AS "laughCountYear",
    NULL::integer AS "laughCountAllTime",
    NULL::integer AS "cryCountDay",
    NULL::integer AS "cryCountWeek",
    NULL::integer AS "cryCountMonth",
    NULL::integer AS "cryCountYear",
    NULL::integer AS "cryCountAllTime",
    NULL::integer AS "reactionCountDay",
    NULL::integer AS "reactionCountWeek",
    NULL::integer AS "reactionCountMonth",
    NULL::integer AS "reactionCountYear",
    NULL::integer AS "reactionCountAllTime",
    NULL::integer AS "unitAmountCountDay",
    NULL::integer AS "unitAmountCountWeek",
    NULL::integer AS "unitAmountCountMonth",
    NULL::integer AS "unitAmountCountYear",
    NULL::integer AS "unitAmountCountAllTime",
    NULL::integer AS "tippedCountDay",
    NULL::integer AS "tippedCountWeek",
    NULL::integer AS "tippedCountMonth",
    NULL::integer AS "tippedCountYear",
    NULL::integer AS "tippedCountAllTime",
    NULL::integer AS "tippedAmountCountDay",
    NULL::integer AS "tippedAmountCountWeek",
    NULL::integer AS "tippedAmountCountMonth",
    NULL::integer AS "tippedAmountCountYear",
    NULL::integer AS "tippedAmountCountAllTime";


ALTER TABLE public."BountyEntryStat" OWNER TO civitai;

--
-- Name: BountyEntry_id_seq; Type: SEQUENCE; Schema: public; Owner: civitai
--

CREATE SEQUENCE public."BountyEntry_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public."BountyEntry_id_seq" OWNER TO civitai;

--
-- Name: BountyEntry_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: civitai
--

ALTER SEQUENCE public."BountyEntry_id_seq" OWNED BY public."BountyEntry".id;


--
-- Name: BountyMetric; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."BountyMetric" (
    "bountyId" integer NOT NULL,
    timeframe public."MetricTimeframe" NOT NULL,
    "favoriteCount" integer DEFAULT 0 NOT NULL,
    "trackCount" integer DEFAULT 0 NOT NULL,
    "entryCount" integer DEFAULT 0 NOT NULL,
    "benefactorCount" integer DEFAULT 0 NOT NULL,
    "unitAmountCount" integer DEFAULT 0 NOT NULL,
    "commentCount" integer DEFAULT 0 NOT NULL,
    "updatedAt" timestamp(3) without time zone DEFAULT now()
);


ALTER TABLE public."BountyMetric" OWNER TO civitai;

--
-- Name: BountyRank; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."BountyRank" (
    "bountyId" integer NOT NULL,
    "favoriteCountDayRank" bigint,
    "favoriteCountWeekRank" bigint,
    "favoriteCountMonthRank" bigint,
    "favoriteCountYearRank" bigint,
    "favoriteCountAllTimeRank" bigint,
    "trackCountDayRank" bigint,
    "trackCountWeekRank" bigint,
    "trackCountMonthRank" bigint,
    "trackCountYearRank" bigint,
    "trackCountAllTimeRank" bigint,
    "entryCountDayRank" bigint,
    "entryCountWeekRank" bigint,
    "entryCountMonthRank" bigint,
    "entryCountYearRank" bigint,
    "entryCountAllTimeRank" bigint,
    "benefactorCountDayRank" bigint,
    "benefactorCountWeekRank" bigint,
    "benefactorCountMonthRank" bigint,
    "benefactorCountYearRank" bigint,
    "benefactorCountAllTimeRank" bigint,
    "unitAmountCountDayRank" bigint,
    "unitAmountCountWeekRank" bigint,
    "unitAmountCountMonthRank" bigint,
    "unitAmountCountYearRank" bigint,
    "unitAmountCountAllTimeRank" bigint,
    "commentCountDayRank" bigint,
    "commentCountWeekRank" bigint,
    "commentCountMonthRank" bigint,
    "commentCountYearRank" bigint,
    "commentCountAllTimeRank" bigint
);


ALTER TABLE public."BountyRank" OWNER TO civitai;

--
-- Name: BountyRank_Live; Type: VIEW; Schema: public; Owner: civitai
--

CREATE VIEW public."BountyRank_Live" AS
 WITH timeframe_stats AS (
         SELECT m."bountyId",
            m."favoriteCount",
            m."trackCount",
            m."entryCount",
            m."benefactorCount",
            m."unitAmountCount",
            m."commentCount",
            (((m."favoriteCount" + m."trackCount") + m."entryCount") + m."benefactorCount") AS "engagementCount",
            m.timeframe
           FROM public."BountyMetric" m
        ), timeframe_rank AS (
         SELECT timeframe_stats."bountyId",
            row_number() OVER (PARTITION BY timeframe_stats.timeframe ORDER BY COALESCE(timeframe_stats."favoriteCount", 0) DESC, COALESCE(timeframe_stats."engagementCount", 0) DESC, timeframe_stats."bountyId" DESC) AS "favoriteCountRank",
            row_number() OVER (PARTITION BY timeframe_stats.timeframe ORDER BY COALESCE(timeframe_stats."trackCount", 0) DESC, COALESCE(timeframe_stats."engagementCount", 0) DESC, timeframe_stats."bountyId" DESC) AS "trackCountRank",
            row_number() OVER (PARTITION BY timeframe_stats.timeframe ORDER BY COALESCE(timeframe_stats."entryCount", 0) DESC, COALESCE(timeframe_stats."engagementCount", 0) DESC, timeframe_stats."bountyId" DESC) AS "entryCountRank",
            row_number() OVER (PARTITION BY timeframe_stats.timeframe ORDER BY COALESCE(timeframe_stats."benefactorCount", 0) DESC, COALESCE(timeframe_stats."engagementCount", 0) DESC, timeframe_stats."bountyId" DESC) AS "benefactorCountRank",
            row_number() OVER (PARTITION BY timeframe_stats.timeframe ORDER BY COALESCE(timeframe_stats."unitAmountCount", 0) DESC, COALESCE(timeframe_stats."engagementCount", 0) DESC, timeframe_stats."bountyId" DESC) AS "unitAmountCountRank",
            row_number() OVER (PARTITION BY timeframe_stats.timeframe ORDER BY COALESCE(timeframe_stats."commentCount", 0) DESC, COALESCE(timeframe_stats."engagementCount", 0) DESC, timeframe_stats."bountyId" DESC) AS "commentCountRank",
            timeframe_stats.timeframe
           FROM timeframe_stats
        )
 SELECT timeframe_rank."bountyId",
    max(public.iif((timeframe_rank.timeframe = 'Day'::public."MetricTimeframe"), timeframe_rank."favoriteCountRank", NULL::bigint)) AS "favoriteCountDayRank",
    max(public.iif((timeframe_rank.timeframe = 'Week'::public."MetricTimeframe"), timeframe_rank."favoriteCountRank", NULL::bigint)) AS "favoriteCountWeekRank",
    max(public.iif((timeframe_rank.timeframe = 'Month'::public."MetricTimeframe"), timeframe_rank."favoriteCountRank", NULL::bigint)) AS "favoriteCountMonthRank",
    max(public.iif((timeframe_rank.timeframe = 'Year'::public."MetricTimeframe"), timeframe_rank."favoriteCountRank", NULL::bigint)) AS "favoriteCountYearRank",
    max(public.iif((timeframe_rank.timeframe = 'AllTime'::public."MetricTimeframe"), timeframe_rank."favoriteCountRank", NULL::bigint)) AS "favoriteCountAllTimeRank",
    max(public.iif((timeframe_rank.timeframe = 'Day'::public."MetricTimeframe"), timeframe_rank."trackCountRank", NULL::bigint)) AS "trackCountDayRank",
    max(public.iif((timeframe_rank.timeframe = 'Week'::public."MetricTimeframe"), timeframe_rank."trackCountRank", NULL::bigint)) AS "trackCountWeekRank",
    max(public.iif((timeframe_rank.timeframe = 'Month'::public."MetricTimeframe"), timeframe_rank."trackCountRank", NULL::bigint)) AS "trackCountMonthRank",
    max(public.iif((timeframe_rank.timeframe = 'Year'::public."MetricTimeframe"), timeframe_rank."trackCountRank", NULL::bigint)) AS "trackCountYearRank",
    max(public.iif((timeframe_rank.timeframe = 'AllTime'::public."MetricTimeframe"), timeframe_rank."trackCountRank", NULL::bigint)) AS "trackCountAllTimeRank",
    max(public.iif((timeframe_rank.timeframe = 'Day'::public."MetricTimeframe"), timeframe_rank."entryCountRank", NULL::bigint)) AS "entryCountDayRank",
    max(public.iif((timeframe_rank.timeframe = 'Week'::public."MetricTimeframe"), timeframe_rank."entryCountRank", NULL::bigint)) AS "entryCountWeekRank",
    max(public.iif((timeframe_rank.timeframe = 'Month'::public."MetricTimeframe"), timeframe_rank."entryCountRank", NULL::bigint)) AS "entryCountMonthRank",
    max(public.iif((timeframe_rank.timeframe = 'Year'::public."MetricTimeframe"), timeframe_rank."entryCountRank", NULL::bigint)) AS "entryCountYearRank",
    max(public.iif((timeframe_rank.timeframe = 'AllTime'::public."MetricTimeframe"), timeframe_rank."entryCountRank", NULL::bigint)) AS "entryCountAllTimeRank",
    max(public.iif((timeframe_rank.timeframe = 'Day'::public."MetricTimeframe"), timeframe_rank."benefactorCountRank", NULL::bigint)) AS "benefactorCountDayRank",
    max(public.iif((timeframe_rank.timeframe = 'Week'::public."MetricTimeframe"), timeframe_rank."benefactorCountRank", NULL::bigint)) AS "benefactorCountWeekRank",
    max(public.iif((timeframe_rank.timeframe = 'Month'::public."MetricTimeframe"), timeframe_rank."benefactorCountRank", NULL::bigint)) AS "benefactorCountMonthRank",
    max(public.iif((timeframe_rank.timeframe = 'Year'::public."MetricTimeframe"), timeframe_rank."benefactorCountRank", NULL::bigint)) AS "benefactorCountYearRank",
    max(public.iif((timeframe_rank.timeframe = 'AllTime'::public."MetricTimeframe"), timeframe_rank."benefactorCountRank", NULL::bigint)) AS "benefactorCountAllTimeRank",
    max(public.iif((timeframe_rank.timeframe = 'Day'::public."MetricTimeframe"), timeframe_rank."unitAmountCountRank", NULL::bigint)) AS "unitAmountCountDayRank",
    max(public.iif((timeframe_rank.timeframe = 'Week'::public."MetricTimeframe"), timeframe_rank."unitAmountCountRank", NULL::bigint)) AS "unitAmountCountWeekRank",
    max(public.iif((timeframe_rank.timeframe = 'Month'::public."MetricTimeframe"), timeframe_rank."unitAmountCountRank", NULL::bigint)) AS "unitAmountCountMonthRank",
    max(public.iif((timeframe_rank.timeframe = 'Year'::public."MetricTimeframe"), timeframe_rank."unitAmountCountRank", NULL::bigint)) AS "unitAmountCountYearRank",
    max(public.iif((timeframe_rank.timeframe = 'AllTime'::public."MetricTimeframe"), timeframe_rank."unitAmountCountRank", NULL::bigint)) AS "unitAmountCountAllTimeRank",
    max(public.iif((timeframe_rank.timeframe = 'Day'::public."MetricTimeframe"), timeframe_rank."commentCountRank", NULL::bigint)) AS "commentCountDayRank",
    max(public.iif((timeframe_rank.timeframe = 'Week'::public."MetricTimeframe"), timeframe_rank."commentCountRank", NULL::bigint)) AS "commentCountWeekRank",
    max(public.iif((timeframe_rank.timeframe = 'Month'::public."MetricTimeframe"), timeframe_rank."commentCountRank", NULL::bigint)) AS "commentCountMonthRank",
    max(public.iif((timeframe_rank.timeframe = 'Year'::public."MetricTimeframe"), timeframe_rank."commentCountRank", NULL::bigint)) AS "commentCountYearRank",
    max(public.iif((timeframe_rank.timeframe = 'AllTime'::public."MetricTimeframe"), timeframe_rank."commentCountRank", NULL::bigint)) AS "commentCountAllTimeRank"
   FROM timeframe_rank
  GROUP BY timeframe_rank."bountyId";


ALTER TABLE public."BountyRank_Live" OWNER TO civitai;

--
-- Name: BountyReport; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."BountyReport" (
    "bountyId" integer NOT NULL,
    "reportId" integer NOT NULL
);


ALTER TABLE public."BountyReport" OWNER TO civitai;

--
-- Name: BountyStat; Type: VIEW; Schema: public; Owner: civitai
--

CREATE VIEW public."BountyStat" AS
SELECT
    NULL::integer AS "bountyId",
    NULL::integer AS "favoriteCountDay",
    NULL::integer AS "favoriteCountWeek",
    NULL::integer AS "favoriteCountMonth",
    NULL::integer AS "favoriteCountYear",
    NULL::integer AS "favoriteCountAllTime",
    NULL::integer AS "trackCountDay",
    NULL::integer AS "trackCountWeek",
    NULL::integer AS "trackCountMonth",
    NULL::integer AS "trackCountYear",
    NULL::integer AS "trackCountAllTime",
    NULL::integer AS "entryCountDay",
    NULL::integer AS "entryCountWeek",
    NULL::integer AS "entryCountMonth",
    NULL::integer AS "entryCountYear",
    NULL::integer AS "entryCountAllTime",
    NULL::integer AS "benefactorCountDay",
    NULL::integer AS "benefactorCountWeek",
    NULL::integer AS "benefactorCountMonth",
    NULL::integer AS "benefactorCountYear",
    NULL::integer AS "benefactorCountAllTime",
    NULL::integer AS "unitAmountCountDay",
    NULL::integer AS "unitAmountCountWeek",
    NULL::integer AS "unitAmountCountMonth",
    NULL::integer AS "unitAmountCountYear",
    NULL::integer AS "unitAmountCountAllTime",
    NULL::integer AS "commentCountDay",
    NULL::integer AS "commentCountWeek",
    NULL::integer AS "commentCountMonth",
    NULL::integer AS "commentCountYear",
    NULL::integer AS "commentCountAllTime";


ALTER TABLE public."BountyStat" OWNER TO civitai;

--
-- Name: Bounty_id_seq; Type: SEQUENCE; Schema: public; Owner: civitai
--

CREATE SEQUENCE public."Bounty_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public."Bounty_id_seq" OWNER TO civitai;

--
-- Name: Bounty_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: civitai
--

ALTER SEQUENCE public."Bounty_id_seq" OWNED BY public."Bounty".id;


--
-- Name: BuildGuide; Type: TABLE; Schema: public; Owner: doadmin
--

CREATE TABLE public."BuildGuide" (
    id integer NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    name text NOT NULL,
    message text NOT NULL,
    "userId" integer NOT NULL,
    components jsonb NOT NULL,
    capabilities jsonb NOT NULL
);


ALTER TABLE public."BuildGuide" OWNER TO doadmin;

--
-- Name: BuildGuide_id_seq; Type: SEQUENCE; Schema: public; Owner: doadmin
--

CREATE SEQUENCE public."BuildGuide_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public."BuildGuide_id_seq" OWNER TO doadmin;

--
-- Name: BuildGuide_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: doadmin
--

ALTER SEQUENCE public."BuildGuide_id_seq" OWNED BY public."BuildGuide".id;


--
-- Name: BuzzClaim; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."BuzzClaim" (
    key text NOT NULL,
    "transactionIdQuery" text NOT NULL,
    amount integer NOT NULL,
    "availableStart" timestamp(3) without time zone,
    "availableEnd" timestamp(3) without time zone,
    description text NOT NULL,
    title text NOT NULL
);


ALTER TABLE public."BuzzClaim" OWNER TO civitai;

--
-- Name: BuzzTip; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."BuzzTip" (
    "entityType" text NOT NULL,
    "entityId" integer NOT NULL,
    "toUserId" integer NOT NULL,
    "fromUserId" integer NOT NULL,
    amount integer NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


ALTER TABLE public."BuzzTip" OWNER TO civitai;

--
-- Name: BuzzWithdrawalRequest; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."BuzzWithdrawalRequest" (
    id text NOT NULL,
    "userId" integer,
    "connectedAccountId" text NOT NULL,
    "buzzWithdrawalTransactionId" text NOT NULL,
    "requestedBuzzAmount" integer NOT NULL,
    "platformFeeRate" integer NOT NULL,
    "transferredAmount" integer,
    "transferId" text,
    currency public."Currency",
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    status public."BuzzWithdrawalRequestStatus" DEFAULT 'Requested'::public."BuzzWithdrawalRequestStatus" NOT NULL
);


ALTER TABLE public."BuzzWithdrawalRequest" OWNER TO civitai;

--
-- Name: BuzzWithdrawalRequestHistory; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."BuzzWithdrawalRequestHistory" (
    id text NOT NULL,
    "requestId" text NOT NULL,
    "updatedById" integer NOT NULL,
    status public."BuzzWithdrawalRequestStatus" DEFAULT 'Requested'::public."BuzzWithdrawalRequestStatus" NOT NULL,
    note text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL
);


ALTER TABLE public."BuzzWithdrawalRequestHistory" OWNER TO civitai;

--
-- Name: Chat; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."Chat" (
    id integer NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    hash text NOT NULL,
    "ownerId" integer NOT NULL
);


ALTER TABLE public."Chat" OWNER TO civitai;

--
-- Name: ChatMember; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."ChatMember" (
    id integer NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "userId" integer NOT NULL,
    "chatId" integer NOT NULL,
    "isOwner" boolean DEFAULT false NOT NULL,
    "isMuted" boolean DEFAULT false NOT NULL,
    status public."ChatMemberStatus" NOT NULL,
    "lastViewedMessageId" integer,
    "joinedAt" timestamp(3) without time zone,
    "leftAt" timestamp(3) without time zone,
    "kickedAt" timestamp(3) without time zone,
    "unkickedAt" timestamp(3) without time zone,
    "ignoredAt" timestamp(3) without time zone
);


ALTER TABLE public."ChatMember" OWNER TO civitai;

--
-- Name: ChatMember_id_seq; Type: SEQUENCE; Schema: public; Owner: civitai
--

CREATE SEQUENCE public."ChatMember_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public."ChatMember_id_seq" OWNER TO civitai;

--
-- Name: ChatMember_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: civitai
--

ALTER SEQUENCE public."ChatMember_id_seq" OWNED BY public."ChatMember".id;


--
-- Name: ChatMessage; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."ChatMessage" (
    id integer NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "userId" integer NOT NULL,
    "chatId" integer NOT NULL,
    content text NOT NULL,
    "contentType" public."ChatMessageType" DEFAULT 'Markdown'::public."ChatMessageType" NOT NULL,
    "referenceMessageId" integer,
    "editedAt" timestamp(3) without time zone
);


ALTER TABLE public."ChatMessage" OWNER TO civitai;

--
-- Name: ChatMessage_id_seq; Type: SEQUENCE; Schema: public; Owner: civitai
--

CREATE SEQUENCE public."ChatMessage_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public."ChatMessage_id_seq" OWNER TO civitai;

--
-- Name: ChatMessage_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: civitai
--

ALTER SEQUENCE public."ChatMessage_id_seq" OWNED BY public."ChatMessage".id;


--
-- Name: ChatReport; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."ChatReport" (
    "chatId" integer NOT NULL,
    "reportId" integer NOT NULL
);


ALTER TABLE public."ChatReport" OWNER TO civitai;

--
-- Name: Chat_id_seq; Type: SEQUENCE; Schema: public; Owner: civitai
--

CREATE SEQUENCE public."Chat_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public."Chat_id_seq" OWNER TO civitai;

--
-- Name: Chat_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: civitai
--

ALTER SEQUENCE public."Chat_id_seq" OWNED BY public."Chat".id;


--
-- Name: Club; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."Club" (
    id integer NOT NULL,
    "userId" integer NOT NULL,
    "coverImageId" integer,
    "headerImageId" integer,
    "avatarId" integer,
    name text NOT NULL,
    description text NOT NULL,
    nsfw boolean DEFAULT false NOT NULL,
    billing boolean DEFAULT true NOT NULL,
    unlisted boolean DEFAULT false NOT NULL
);


ALTER TABLE public."Club" OWNER TO civitai;

--
-- Name: ClubAdmin; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."ClubAdmin" (
    "userId" integer NOT NULL,
    "clubId" integer NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    permissions public."ClubAdminPermission"[]
);


ALTER TABLE public."ClubAdmin" OWNER TO civitai;

--
-- Name: ClubAdminInvite; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."ClubAdminInvite" (
    id text NOT NULL,
    "expiresAt" timestamp(3) without time zone,
    "clubId" integer NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    permissions public."ClubAdminPermission"[]
);


ALTER TABLE public."ClubAdminInvite" OWNER TO civitai;

--
-- Name: ClubMembership; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."ClubMembership" (
    "userId" integer NOT NULL,
    "clubId" integer NOT NULL,
    "clubTierId" integer NOT NULL,
    "startedAt" timestamp(3) without time zone NOT NULL,
    "expiresAt" timestamp(3) without time zone,
    "cancelledAt" timestamp(3) without time zone,
    "nextBillingAt" timestamp(3) without time zone NOT NULL,
    "unitAmount" integer NOT NULL,
    currency public."Currency" DEFAULT 'BUZZ'::public."Currency" NOT NULL,
    "downgradeClubTierId" integer,
    id integer NOT NULL,
    "billingPausedAt" timestamp(3) without time zone
);


ALTER TABLE public."ClubMembership" OWNER TO civitai;

--
-- Name: ClubMembershipCharge; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."ClubMembershipCharge" (
    id integer NOT NULL,
    "userId" integer NOT NULL,
    "clubId" integer NOT NULL,
    "clubTierId" integer NOT NULL,
    "chargedAt" timestamp(3) without time zone NOT NULL,
    status text,
    "invoiceId" text,
    "unitAmount" integer NOT NULL,
    "unitAmountPurchased" integer NOT NULL,
    currency public."Currency" DEFAULT 'BUZZ'::public."Currency" NOT NULL
);


ALTER TABLE public."ClubMembershipCharge" OWNER TO civitai;

--
-- Name: ClubMembershipCharge_id_seq; Type: SEQUENCE; Schema: public; Owner: civitai
--

CREATE SEQUENCE public."ClubMembershipCharge_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public."ClubMembershipCharge_id_seq" OWNER TO civitai;

--
-- Name: ClubMembershipCharge_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: civitai
--

ALTER SEQUENCE public."ClubMembershipCharge_id_seq" OWNED BY public."ClubMembershipCharge".id;


--
-- Name: ClubMembership_id_seq; Type: SEQUENCE; Schema: public; Owner: civitai
--

CREATE SEQUENCE public."ClubMembership_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public."ClubMembership_id_seq" OWNER TO civitai;

--
-- Name: ClubMembership_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: civitai
--

ALTER SEQUENCE public."ClubMembership_id_seq" OWNED BY public."ClubMembership".id;


--
-- Name: ClubMetric; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."ClubMetric" (
    "clubId" integer NOT NULL,
    timeframe public."MetricTimeframe" NOT NULL,
    "clubPostCount" integer DEFAULT 0 NOT NULL,
    "memberCount" integer DEFAULT 0 NOT NULL,
    "resourceCount" integer DEFAULT 0 NOT NULL
);


ALTER TABLE public."ClubMetric" OWNER TO civitai;

--
-- Name: ClubPost; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."ClubPost" (
    id integer NOT NULL,
    "clubId" integer NOT NULL,
    "createdById" integer NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "membersOnly" boolean NOT NULL,
    title text,
    description text,
    "coverImageId" integer,
    "entityId" integer,
    "entityType" text
);


ALTER TABLE public."ClubPost" OWNER TO civitai;

--
-- Name: ClubPostMetric; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."ClubPostMetric" (
    "clubPostId" integer NOT NULL,
    timeframe public."MetricTimeframe" NOT NULL,
    "likeCount" integer DEFAULT 0 NOT NULL,
    "dislikeCount" integer DEFAULT 0 NOT NULL,
    "laughCount" integer DEFAULT 0 NOT NULL,
    "cryCount" integer DEFAULT 0 NOT NULL,
    "heartCount" integer DEFAULT 0 NOT NULL
);


ALTER TABLE public."ClubPostMetric" OWNER TO civitai;

--
-- Name: ClubPostReaction; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."ClubPostReaction" (
    id integer NOT NULL,
    "clubPostId" integer NOT NULL,
    "userId" integer NOT NULL,
    reaction public."ReviewReactions" NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


ALTER TABLE public."ClubPostReaction" OWNER TO civitai;

--
-- Name: ClubPostReaction_id_seq; Type: SEQUENCE; Schema: public; Owner: civitai
--

CREATE SEQUENCE public."ClubPostReaction_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public."ClubPostReaction_id_seq" OWNER TO civitai;

--
-- Name: ClubPostReaction_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: civitai
--

ALTER SEQUENCE public."ClubPostReaction_id_seq" OWNED BY public."ClubPostReaction".id;


--
-- Name: ClubPost_id_seq; Type: SEQUENCE; Schema: public; Owner: civitai
--

CREATE SEQUENCE public."ClubPost_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public."ClubPost_id_seq" OWNER TO civitai;

--
-- Name: ClubPost_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: civitai
--

ALTER SEQUENCE public."ClubPost_id_seq" OWNED BY public."ClubPost".id;


--
-- Name: ClubRank; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."ClubRank" (
    "clubId" integer NOT NULL,
    "memberCountDayRank" bigint,
    "memberCountWeekRank" bigint,
    "memberCountMonthRank" bigint,
    "memberCountYearRank" bigint,
    "memberCountAllTimeRank" bigint,
    "resourceCountDayRank" bigint,
    "resourceCountWeekRank" bigint,
    "resourceCountMonthRank" bigint,
    "resourceCountYearRank" bigint,
    "resourceCountAllTimeRank" bigint,
    "clubPostCountDayRank" bigint,
    "clubPostCountWeekRank" bigint,
    "clubPostCountMonthRank" bigint,
    "clubPostCountYearRank" bigint,
    "clubPostCountAllTimeRank" bigint
);


ALTER TABLE public."ClubRank" OWNER TO civitai;

--
-- Name: ClubRank_Live; Type: VIEW; Schema: public; Owner: civitai
--

CREATE VIEW public."ClubRank_Live" AS
 WITH timeframe_stats AS (
         SELECT m."clubId",
            m."memberCount",
            m."resourceCount",
            m."clubPostCount",
            m.timeframe
           FROM public."ClubMetric" m
        ), timeframe_rank AS (
         SELECT timeframe_stats."clubId",
            row_number() OVER (PARTITION BY timeframe_stats.timeframe ORDER BY COALESCE(timeframe_stats."memberCount", 0) DESC, COALESCE(timeframe_stats."resourceCount", 0) DESC, timeframe_stats."clubId" DESC) AS "memberCountRank",
            row_number() OVER (PARTITION BY timeframe_stats.timeframe ORDER BY COALESCE(timeframe_stats."resourceCount", 0) DESC, COALESCE(timeframe_stats."clubPostCount", 0) DESC, timeframe_stats."clubId" DESC) AS "resourceCountRank",
            row_number() OVER (PARTITION BY timeframe_stats.timeframe ORDER BY COALESCE(timeframe_stats."clubPostCount", 0) DESC, COALESCE(timeframe_stats."memberCount", 0) DESC, timeframe_stats."clubId" DESC) AS "clubPostCountRank",
            timeframe_stats.timeframe
           FROM timeframe_stats
        )
 SELECT timeframe_rank."clubId",
    max(public.iif((timeframe_rank.timeframe = 'Day'::public."MetricTimeframe"), timeframe_rank."memberCountRank", NULL::bigint)) AS "memberCountDayRank",
    max(public.iif((timeframe_rank.timeframe = 'Week'::public."MetricTimeframe"), timeframe_rank."memberCountRank", NULL::bigint)) AS "memberCountWeekRank",
    max(public.iif((timeframe_rank.timeframe = 'Month'::public."MetricTimeframe"), timeframe_rank."memberCountRank", NULL::bigint)) AS "memberCountMonthRank",
    max(public.iif((timeframe_rank.timeframe = 'Year'::public."MetricTimeframe"), timeframe_rank."memberCountRank", NULL::bigint)) AS "memberCountYearRank",
    max(public.iif((timeframe_rank.timeframe = 'AllTime'::public."MetricTimeframe"), timeframe_rank."memberCountRank", NULL::bigint)) AS "memberCountAllTimeRank",
    max(public.iif((timeframe_rank.timeframe = 'Day'::public."MetricTimeframe"), timeframe_rank."resourceCountRank", NULL::bigint)) AS "resourceCountDayRank",
    max(public.iif((timeframe_rank.timeframe = 'Week'::public."MetricTimeframe"), timeframe_rank."resourceCountRank", NULL::bigint)) AS "resourceCountWeekRank",
    max(public.iif((timeframe_rank.timeframe = 'Month'::public."MetricTimeframe"), timeframe_rank."resourceCountRank", NULL::bigint)) AS "resourceCountMonthRank",
    max(public.iif((timeframe_rank.timeframe = 'Year'::public."MetricTimeframe"), timeframe_rank."resourceCountRank", NULL::bigint)) AS "resourceCountYearRank",
    max(public.iif((timeframe_rank.timeframe = 'AllTime'::public."MetricTimeframe"), timeframe_rank."resourceCountRank", NULL::bigint)) AS "resourceCountAllTimeRank",
    max(public.iif((timeframe_rank.timeframe = 'Day'::public."MetricTimeframe"), timeframe_rank."clubPostCountRank", NULL::bigint)) AS "clubPostCountDayRank",
    max(public.iif((timeframe_rank.timeframe = 'Week'::public."MetricTimeframe"), timeframe_rank."clubPostCountRank", NULL::bigint)) AS "clubPostCountWeekRank",
    max(public.iif((timeframe_rank.timeframe = 'Month'::public."MetricTimeframe"), timeframe_rank."clubPostCountRank", NULL::bigint)) AS "clubPostCountMonthRank",
    max(public.iif((timeframe_rank.timeframe = 'Year'::public."MetricTimeframe"), timeframe_rank."clubPostCountRank", NULL::bigint)) AS "clubPostCountYearRank",
    max(public.iif((timeframe_rank.timeframe = 'AllTime'::public."MetricTimeframe"), timeframe_rank."clubPostCountRank", NULL::bigint)) AS "clubPostCountAllTimeRank"
   FROM timeframe_rank
  GROUP BY timeframe_rank."clubId";


ALTER TABLE public."ClubRank_Live" OWNER TO civitai;

--
-- Name: ClubStat; Type: VIEW; Schema: public; Owner: civitai
--

CREATE VIEW public."ClubStat" AS
SELECT
    NULL::integer AS "clubId",
    NULL::integer AS "memberCountDay",
    NULL::integer AS "memberCountWeek",
    NULL::integer AS "memberCountMonth",
    NULL::integer AS "memberCountYear",
    NULL::integer AS "memberCountAllTime",
    NULL::integer AS "resourceCountDay",
    NULL::integer AS "resourceCountWeek",
    NULL::integer AS "resourceCountMonth",
    NULL::integer AS "resourceCountYear",
    NULL::integer AS "resourceCountAllTime",
    NULL::integer AS "clubPostCountDay",
    NULL::integer AS "clubPostCountWeek",
    NULL::integer AS "clubPostCountMonth",
    NULL::integer AS "clubPostCountYear",
    NULL::integer AS "clubPostCountAllTime";


ALTER TABLE public."ClubStat" OWNER TO civitai;

--
-- Name: ClubTier; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."ClubTier" (
    id integer NOT NULL,
    "clubId" integer NOT NULL,
    "unitAmount" integer NOT NULL,
    currency public."Currency" DEFAULT 'BUZZ'::public."Currency" NOT NULL,
    name text NOT NULL,
    description text NOT NULL,
    "coverImageId" integer,
    unlisted boolean DEFAULT false NOT NULL,
    joinable boolean NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "memberLimit" integer,
    "updatedAt" timestamp(3) without time zone,
    "oneTimeFee" boolean DEFAULT false NOT NULL
);


ALTER TABLE public."ClubTier" OWNER TO civitai;

--
-- Name: ClubTier_id_seq; Type: SEQUENCE; Schema: public; Owner: civitai
--

CREATE SEQUENCE public."ClubTier_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public."ClubTier_id_seq" OWNER TO civitai;

--
-- Name: ClubTier_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: civitai
--

ALTER SEQUENCE public."ClubTier_id_seq" OWNED BY public."ClubTier".id;


--
-- Name: Club_id_seq; Type: SEQUENCE; Schema: public; Owner: civitai
--

CREATE SEQUENCE public."Club_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public."Club_id_seq" OWNER TO civitai;

--
-- Name: Club_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: civitai
--

ALTER SEQUENCE public."Club_id_seq" OWNED BY public."Club".id;


--
-- Name: Collection; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."Collection" (
    id integer NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" timestamp(3) without time zone,
    name text NOT NULL,
    description text,
    "userId" integer NOT NULL,
    write public."CollectionWriteConfiguration" DEFAULT 'Private'::public."CollectionWriteConfiguration" NOT NULL,
    read public."CollectionReadConfiguration" DEFAULT 'Private'::public."CollectionReadConfiguration" NOT NULL,
    type public."CollectionType",
    "imageId" integer,
    nsfw boolean DEFAULT false,
    mode public."CollectionMode",
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    availability public."Availability" DEFAULT 'Public'::public."Availability" NOT NULL,
    "nsfwLevel" integer DEFAULT 0 NOT NULL
);


ALTER TABLE public."Collection" OWNER TO civitai;

--
-- Name: CollectionContributor; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."CollectionContributor" (
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" timestamp(3) without time zone,
    "userId" integer NOT NULL,
    "collectionId" integer NOT NULL,
    permissions public."CollectionContributorPermission"[]
);


ALTER TABLE public."CollectionContributor" OWNER TO civitai;

--
-- Name: CollectionItem; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."CollectionItem" (
    id integer NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" timestamp(3) without time zone,
    "collectionId" integer NOT NULL,
    "articleId" integer,
    "postId" integer,
    "imageId" integer,
    "modelId" integer,
    "addedById" integer,
    note text,
    status public."CollectionItemStatus" DEFAULT 'ACCEPTED'::public."CollectionItemStatus" NOT NULL,
    "randomId" integer,
    "reviewedAt" timestamp(3) without time zone,
    "reviewedById" integer,
    "tagId" integer
);


ALTER TABLE public."CollectionItem" OWNER TO civitai;

--
-- Name: CollectionMetric; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."CollectionMetric" (
    "collectionId" integer NOT NULL,
    timeframe public."MetricTimeframe" NOT NULL,
    "followerCount" integer DEFAULT 0 NOT NULL,
    "itemCount" integer DEFAULT 0 NOT NULL,
    "contributorCount" integer DEFAULT 0 NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp(3) without time zone DEFAULT now()
);


ALTER TABLE public."CollectionMetric" OWNER TO civitai;

--
-- Name: CollectionRank; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."CollectionRank" (
    "collectionId" integer NOT NULL,
    "followerCountDayRank" bigint,
    "followerCountWeekRank" bigint,
    "followerCountMonthRank" bigint,
    "followerCountYearRank" bigint,
    "followerCountAllTimeRank" bigint,
    "itemCountDayRank" bigint,
    "itemCountWeekRank" bigint,
    "itemCountMonthRank" bigint,
    "itemCountYearRank" bigint,
    "itemCountAllTimeRank" bigint,
    "contributorCountDayRank" bigint,
    "contributorCountWeekRank" bigint,
    "contributorCountMonthRank" bigint,
    "contributorCountYearRank" bigint,
    "contributorCountAllTimeRank" bigint
);


ALTER TABLE public."CollectionRank" OWNER TO civitai;

--
-- Name: CollectionStat; Type: VIEW; Schema: public; Owner: civitai
--

CREATE VIEW public."CollectionStat" AS
 WITH stats_timeframe AS (
         SELECT m."collectionId",
            m.timeframe,
            COALESCE(sum(m."followerCount"), (0)::bigint) AS "followerCount",
            COALESCE(sum(m."contributorCount"), (0)::bigint) AS "contributorCount",
            COALESCE(sum(m."itemCount"), (0)::bigint) AS "itemCount"
           FROM public."CollectionMetric" m
          GROUP BY m."collectionId", m.timeframe
        )
 SELECT stats_timeframe."collectionId",
    max(public.iif((stats_timeframe.timeframe = 'Day'::public."MetricTimeframe"), stats_timeframe."followerCount", NULL::bigint)) AS "followerCountDay",
    max(public.iif((stats_timeframe.timeframe = 'Week'::public."MetricTimeframe"), stats_timeframe."followerCount", NULL::bigint)) AS "followerCountWeek",
    max(public.iif((stats_timeframe.timeframe = 'Month'::public."MetricTimeframe"), stats_timeframe."followerCount", NULL::bigint)) AS "followerCountMonth",
    max(public.iif((stats_timeframe.timeframe = 'Year'::public."MetricTimeframe"), stats_timeframe."followerCount", NULL::bigint)) AS "followerCountYear",
    max(public.iif((stats_timeframe.timeframe = 'AllTime'::public."MetricTimeframe"), stats_timeframe."followerCount", NULL::bigint)) AS "followerCountAllTime",
    max(public.iif((stats_timeframe.timeframe = 'Day'::public."MetricTimeframe"), stats_timeframe."contributorCount", NULL::bigint)) AS "contributorCountDay",
    max(public.iif((stats_timeframe.timeframe = 'Week'::public."MetricTimeframe"), stats_timeframe."contributorCount", NULL::bigint)) AS "contributorCountWeek",
    max(public.iif((stats_timeframe.timeframe = 'Month'::public."MetricTimeframe"), stats_timeframe."contributorCount", NULL::bigint)) AS "contributorCountMonth",
    max(public.iif((stats_timeframe.timeframe = 'Year'::public."MetricTimeframe"), stats_timeframe."contributorCount", NULL::bigint)) AS "contributorCountYear",
    max(public.iif((stats_timeframe.timeframe = 'AllTime'::public."MetricTimeframe"), stats_timeframe."contributorCount", NULL::bigint)) AS "contributorCountAllTime",
    max(public.iif((stats_timeframe.timeframe = 'Day'::public."MetricTimeframe"), stats_timeframe."itemCount", NULL::bigint)) AS "itemCountDay",
    max(public.iif((stats_timeframe.timeframe = 'Week'::public."MetricTimeframe"), stats_timeframe."itemCount", NULL::bigint)) AS "itemCountWeek",
    max(public.iif((stats_timeframe.timeframe = 'Month'::public."MetricTimeframe"), stats_timeframe."itemCount", NULL::bigint)) AS "itemCountMonth",
    max(public.iif((stats_timeframe.timeframe = 'Year'::public."MetricTimeframe"), stats_timeframe."itemCount", NULL::bigint)) AS "itemCountYear",
    max(public.iif((stats_timeframe.timeframe = 'AllTime'::public."MetricTimeframe"), stats_timeframe."itemCount", NULL::bigint)) AS "itemCountAllTime"
   FROM stats_timeframe
  GROUP BY stats_timeframe."collectionId";


ALTER TABLE public."CollectionStat" OWNER TO civitai;

--
-- Name: CollectionRank_Live; Type: VIEW; Schema: public; Owner: civitai
--

CREATE VIEW public."CollectionRank_Live" AS
 SELECT "CollectionStat"."collectionId",
    row_number() OVER (ORDER BY "CollectionStat"."followerCountDay" DESC, "CollectionStat"."itemCountDay" DESC, "CollectionStat"."collectionId") AS "followerCountDayRank",
    row_number() OVER (ORDER BY "CollectionStat"."followerCountWeek" DESC, "CollectionStat"."itemCountWeek" DESC, "CollectionStat"."collectionId") AS "followerCountWeekRank",
    row_number() OVER (ORDER BY "CollectionStat"."followerCountMonth" DESC, "CollectionStat"."itemCountMonth" DESC, "CollectionStat"."collectionId") AS "followerCountMonthRank",
    row_number() OVER (ORDER BY "CollectionStat"."followerCountYear" DESC, "CollectionStat"."itemCountYear" DESC, "CollectionStat"."collectionId") AS "followerCountYearRank",
    row_number() OVER (ORDER BY "CollectionStat"."followerCountAllTime" DESC, "CollectionStat"."itemCountAllTime" DESC, "CollectionStat"."collectionId") AS "followerCountAllTimeRank",
    row_number() OVER (ORDER BY "CollectionStat"."itemCountDay" DESC, "CollectionStat"."followerCountDay" DESC, "CollectionStat"."collectionId") AS "itemCountDayRank",
    row_number() OVER (ORDER BY "CollectionStat"."itemCountWeek" DESC, "CollectionStat"."followerCountWeek" DESC, "CollectionStat"."collectionId") AS "itemCountWeekRank",
    row_number() OVER (ORDER BY "CollectionStat"."itemCountMonth" DESC, "CollectionStat"."followerCountMonth" DESC, "CollectionStat"."collectionId") AS "itemCountMonthRank",
    row_number() OVER (ORDER BY "CollectionStat"."itemCountYear" DESC, "CollectionStat"."followerCountYear" DESC, "CollectionStat"."collectionId") AS "itemCountYearRank",
    row_number() OVER (ORDER BY "CollectionStat"."itemCountAllTime" DESC, "CollectionStat"."followerCountAllTime" DESC, "CollectionStat"."collectionId") AS "itemCountAllTimeRank",
    row_number() OVER (ORDER BY "CollectionStat"."contributorCountDay" DESC, "CollectionStat"."followerCountDay" DESC, "CollectionStat"."collectionId") AS "contributorCountDayRank",
    row_number() OVER (ORDER BY "CollectionStat"."contributorCountWeek" DESC, "CollectionStat"."followerCountWeek" DESC, "CollectionStat"."collectionId") AS "contributorCountWeekRank",
    row_number() OVER (ORDER BY "CollectionStat"."contributorCountMonth" DESC, "CollectionStat"."followerCountMonth" DESC, "CollectionStat"."collectionId") AS "contributorCountMonthRank",
    row_number() OVER (ORDER BY "CollectionStat"."contributorCountYear" DESC, "CollectionStat"."followerCountYear" DESC, "CollectionStat"."collectionId") AS "contributorCountYearRank",
    row_number() OVER (ORDER BY "CollectionStat"."contributorCountAllTime" DESC, "CollectionStat"."followerCountAllTime" DESC, "CollectionStat"."collectionId") AS "contributorCountAllTimeRank"
   FROM public."CollectionStat";


ALTER TABLE public."CollectionRank_Live" OWNER TO civitai;

--
-- Name: CollectionReport; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."CollectionReport" (
    "collectionId" integer NOT NULL,
    "reportId" integer NOT NULL
);


ALTER TABLE public."CollectionReport" OWNER TO civitai;

--
-- Name: Comment; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."Comment" (
    id integer NOT NULL,
    content text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    nsfw boolean DEFAULT false NOT NULL,
    "tosViolation" boolean DEFAULT false NOT NULL,
    "parentId" integer,
    "userId" integer NOT NULL,
    "modelId" integer NOT NULL,
    locked boolean DEFAULT false,
    hidden boolean DEFAULT false
);


ALTER TABLE public."Comment" OWNER TO civitai;

--
-- Name: CommentReaction; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."CommentReaction" (
    id integer NOT NULL,
    "commentId" integer NOT NULL,
    "userId" integer NOT NULL,
    reaction public."ReviewReactions" NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


ALTER TABLE public."CommentReaction" OWNER TO civitai;

--
-- Name: CommentReaction_id_seq; Type: SEQUENCE; Schema: public; Owner: civitai
--

CREATE SEQUENCE public."CommentReaction_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public."CommentReaction_id_seq" OWNER TO civitai;

--
-- Name: CommentReaction_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: civitai
--

ALTER SEQUENCE public."CommentReaction_id_seq" OWNED BY public."CommentReaction".id;


--
-- Name: CommentReport; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."CommentReport" (
    "commentId" integer NOT NULL,
    "reportId" integer NOT NULL
);


ALTER TABLE public."CommentReport" OWNER TO civitai;

--
-- Name: CommentV2; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."CommentV2" (
    id integer NOT NULL,
    content text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    nsfw boolean DEFAULT false NOT NULL,
    "tosViolation" boolean DEFAULT false NOT NULL,
    "userId" integer NOT NULL,
    "threadId" integer NOT NULL,
    metadata jsonb,
    hidden boolean DEFAULT false
);


ALTER TABLE public."CommentV2" OWNER TO civitai;

--
-- Name: CommentV2Reaction; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."CommentV2Reaction" (
    id integer NOT NULL,
    "commentId" integer NOT NULL,
    "userId" integer NOT NULL,
    reaction public."ReviewReactions" NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


ALTER TABLE public."CommentV2Reaction" OWNER TO civitai;

--
-- Name: CommentV2Reaction_id_seq; Type: SEQUENCE; Schema: public; Owner: civitai
--

CREATE SEQUENCE public."CommentV2Reaction_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public."CommentV2Reaction_id_seq" OWNER TO civitai;

--
-- Name: CommentV2Reaction_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: civitai
--

ALTER SEQUENCE public."CommentV2Reaction_id_seq" OWNED BY public."CommentV2Reaction".id;


--
-- Name: CommentV2Report; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."CommentV2Report" (
    "commentV2Id" integer NOT NULL,
    "reportId" integer NOT NULL
);


ALTER TABLE public."CommentV2Report" OWNER TO civitai;

--
-- Name: CommentV2_id_seq; Type: SEQUENCE; Schema: public; Owner: civitai
--

CREATE SEQUENCE public."CommentV2_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public."CommentV2_id_seq" OWNER TO civitai;

--
-- Name: CommentV2_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: civitai
--

ALTER SEQUENCE public."CommentV2_id_seq" OWNED BY public."CommentV2".id;


--
-- Name: Comment_id_seq; Type: SEQUENCE; Schema: public; Owner: civitai
--

CREATE SEQUENCE public."Comment_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public."Comment_id_seq" OWNER TO civitai;

--
-- Name: Comment_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: civitai
--

ALTER SEQUENCE public."Comment_id_seq" OWNED BY public."Comment".id;


--
-- Name: Cosmetic; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."Cosmetic" (
    id integer NOT NULL,
    name text NOT NULL,
    description text,
    type public."CosmeticType" NOT NULL,
    source public."CosmeticSource" NOT NULL,
    "permanentUnlock" boolean NOT NULL,
    data jsonb NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" timestamp(3) without time zone,
    "availableEnd" timestamp(3) without time zone,
    "availableStart" timestamp(3) without time zone,
    "productId" text,
    "leaderboardId" text,
    "leaderboardPosition" integer,
    "availableQuery" text,
    "videoUrl" text
);


ALTER TABLE public."Cosmetic" OWNER TO civitai;

--
-- Name: CosmeticShopItem; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."CosmeticShopItem" (
    id integer NOT NULL,
    "cosmeticId" integer NOT NULL,
    "addedById" integer,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "availableFrom" timestamp(3) without time zone,
    "availableTo" timestamp(3) without time zone,
    "availableQuantity" integer,
    meta jsonb DEFAULT '{}'::jsonb NOT NULL,
    title text NOT NULL,
    description text,
    "archivedAt" timestamp(3) without time zone,
    "unitAmount" integer NOT NULL
);


ALTER TABLE public."CosmeticShopItem" OWNER TO civitai;

--
-- Name: CosmeticShopItem_id_seq; Type: SEQUENCE; Schema: public; Owner: civitai
--

CREATE SEQUENCE public."CosmeticShopItem_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public."CosmeticShopItem_id_seq" OWNER TO civitai;

--
-- Name: CosmeticShopItem_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: civitai
--

ALTER SEQUENCE public."CosmeticShopItem_id_seq" OWNED BY public."CosmeticShopItem".id;


--
-- Name: CosmeticShopSection; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."CosmeticShopSection" (
    id integer NOT NULL,
    "addedById" integer,
    title text NOT NULL,
    description text,
    placement integer DEFAULT 0 NOT NULL,
    meta jsonb DEFAULT '{}'::jsonb NOT NULL,
    "imageId" integer,
    published boolean DEFAULT true NOT NULL
);


ALTER TABLE public."CosmeticShopSection" OWNER TO civitai;

--
-- Name: CosmeticShopSectionItem; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."CosmeticShopSectionItem" (
    "shopItemId" integer NOT NULL,
    "shopSectionId" integer NOT NULL,
    index integer DEFAULT 0 NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


ALTER TABLE public."CosmeticShopSectionItem" OWNER TO civitai;

--
-- Name: CosmeticShopSection_id_seq; Type: SEQUENCE; Schema: public; Owner: civitai
--

CREATE SEQUENCE public."CosmeticShopSection_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public."CosmeticShopSection_id_seq" OWNER TO civitai;

--
-- Name: CosmeticShopSection_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: civitai
--

ALTER SEQUENCE public."CosmeticShopSection_id_seq" OWNED BY public."CosmeticShopSection".id;


--
-- Name: CoveredCheckpoint; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."CoveredCheckpoint" (
    model_id integer NOT NULL,
    version_id integer
);


ALTER TABLE public."CoveredCheckpoint" OWNER TO civitai;

--
-- Name: Model; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."Model" (
    name public.citext NOT NULL,
    description text,
    type public."ModelType" NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    nsfw boolean DEFAULT false NOT NULL,
    id integer NOT NULL,
    "userId" integer NOT NULL,
    "tosViolation" boolean DEFAULT false NOT NULL,
    status public."ModelStatus" DEFAULT 'Draft'::public."ModelStatus" NOT NULL,
    "fromImportId" integer,
    poi boolean DEFAULT false NOT NULL,
    "publishedAt" timestamp(3) without time zone,
    "lastVersionAt" timestamp(3) without time zone,
    meta jsonb DEFAULT '{}'::jsonb NOT NULL,
    "allowDerivatives" boolean DEFAULT true NOT NULL,
    "allowDifferentLicense" boolean DEFAULT true NOT NULL,
    "allowNoCredit" boolean DEFAULT true NOT NULL,
    "deletedAt" timestamp(3) without time zone,
    "checkpointType" public."CheckpointType",
    locked boolean DEFAULT false NOT NULL,
    "deletedBy" integer,
    "underAttack" boolean DEFAULT false NOT NULL,
    "earlyAccessDeadline" timestamp(3) without time zone,
    mode public."ModelModifier",
    "uploadType" public."ModelUploadType" DEFAULT 'Created'::public."ModelUploadType" NOT NULL,
    unlisted boolean DEFAULT false NOT NULL,
    "gallerySettings" jsonb DEFAULT '{"tags": [], "users": [], "images": []}'::jsonb NOT NULL,
    availability public."Availability" DEFAULT 'Public'::public."Availability" NOT NULL,
    "allowCommercialUse" public."CommercialUse"[] DEFAULT ARRAY['Image'::public."CommercialUse", 'RentCivit'::public."CommercialUse", 'Rent'::public."CommercialUse", 'Sell'::public."CommercialUse"] NOT NULL,
    "nsfwLevel" integer DEFAULT 0 NOT NULL,
    "lockedProperties" text[] DEFAULT ARRAY[]::text[],
    minor boolean DEFAULT false NOT NULL,
    "scannedAt" timestamp(3) without time zone
);


ALTER TABLE public."Model" OWNER TO civitai;

--
-- Name: ModelVersion; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."ModelVersion" (
    name text NOT NULL,
    description text,
    steps integer,
    epochs integer,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    id integer NOT NULL,
    "modelId" integer NOT NULL,
    "trainedWords" text[],
    status public."ModelStatus" DEFAULT 'Draft'::public."ModelStatus" NOT NULL,
    "fromImportId" integer,
    index integer,
    inaccurate boolean DEFAULT false NOT NULL,
    "baseModel" text NOT NULL,
    meta jsonb DEFAULT '{}'::jsonb NOT NULL,
    "earlyAccessTimeFrame" integer DEFAULT 0 NOT NULL,
    "publishedAt" timestamp(3) without time zone,
    "clipSkip" integer,
    "vaeId" integer,
    "baseModelType" text,
    "trainingDetails" jsonb,
    "trainingStatus" public."TrainingStatus",
    "requireAuth" boolean DEFAULT false NOT NULL,
    settings jsonb,
    availability public."Availability" DEFAULT 'Public'::public."Availability" NOT NULL,
    "nsfwLevel" integer DEFAULT 0 NOT NULL,
    "earlyAccessConfig" jsonb,
    "earlyAccessEndsAt" timestamp(3) without time zone,
    "uploadType" public."ModelUploadType" DEFAULT 'Created'::public."ModelUploadType" NOT NULL
);


ALTER TABLE public."ModelVersion" OWNER TO civitai;

--
-- Name: CoveredCheckpointDetails; Type: MATERIALIZED VIEW; Schema: public; Owner: civitai
--

CREATE MATERIALIZED VIEW public."CoveredCheckpointDetails" AS
 WITH newest AS (
         SELECT mv_1."modelId",
            min(mv_1.index) AS index
           FROM public."ModelVersion" mv_1
          WHERE (mv_1."baseModel" = ANY (ARRAY['SD 1.5'::text, 'SD 1.4'::text, 'SD 1.5 LCM'::text, 'SDXL 0.9'::text, 'SDXL 1.0'::text, 'SDXL 1.0 LCM'::text, 'Pony'::text]))
          GROUP BY mv_1."modelId"
        )
 SELECT mv.id AS version_id,
    m.name AS model,
    mv.name AS version,
        CASE
            WHEN (cc.version_id IS NULL) THEN 'latest only'::text
            ELSE 'specific version'::text
        END AS type,
    mv."baseModel"
   FROM (((public."CoveredCheckpoint" cc
     JOIN public."Model" m ON ((m.id = cc.model_id)))
     JOIN newest n ON ((n."modelId" = cc.model_id)))
     JOIN public."ModelVersion" mv ON (((cc.version_id = mv.id) OR ((cc.version_id IS NULL) AND (mv."modelId" = cc.model_id) AND (mv.index = n.index) AND (mv.status = 'Published'::public."ModelStatus")))))
  WITH NO DATA;


ALTER TABLE public."CoveredCheckpointDetails" OWNER TO civitai;

--
-- Name: CsamReport; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."CsamReport" (
    id integer NOT NULL,
    "userId" integer,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "reportedById" integer NOT NULL,
    "reportSentAt" timestamp(3) without time zone,
    "archivedAt" timestamp(3) without time zone,
    "contentRemovedAt" timestamp(3) without time zone,
    "reportId" integer,
    details jsonb DEFAULT '{}'::jsonb NOT NULL,
    images jsonb DEFAULT '[]'::jsonb NOT NULL,
    type public."CsamReportType" DEFAULT 'Image'::public."CsamReportType" NOT NULL
);


ALTER TABLE public."CsamReport" OWNER TO civitai;

--
-- Name: CsamReport_id_seq; Type: SEQUENCE; Schema: public; Owner: civitai
--

CREATE SEQUENCE public."CsamReport_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public."CsamReport_id_seq" OWNER TO civitai;

--
-- Name: CsamReport_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: civitai
--

ALTER SEQUENCE public."CsamReport_id_seq" OWNED BY public."CsamReport".id;


--
-- Name: CustomerSubscription; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."CustomerSubscription" (
    id text NOT NULL,
    "userId" integer NOT NULL,
    metadata jsonb NOT NULL,
    status text NOT NULL,
    "priceId" text NOT NULL,
    "productId" text NOT NULL,
    "cancelAtPeriodEnd" boolean NOT NULL,
    "cancelAt" timestamp(3) without time zone,
    "canceledAt" timestamp(3) without time zone,
    "currentPeriodStart" timestamp(3) without time zone NOT NULL,
    "currentPeriodEnd" timestamp(3) without time zone NOT NULL,
    "createdAt" timestamp(3) without time zone NOT NULL,
    "endedAt" timestamp(3) without time zone,
    "updatedAt" timestamp(3) without time zone
);


ALTER TABLE public."CustomerSubscription" OWNER TO civitai;

--
-- Name: Donation; Type: TABLE; Schema: public; Owner: doadmin
--

CREATE TABLE public."Donation" (
    id integer NOT NULL,
    "userId" integer NOT NULL,
    "donationGoalId" integer NOT NULL,
    amount integer NOT NULL,
    "buzzTransactionId" text NOT NULL,
    notes text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


ALTER TABLE public."Donation" OWNER TO doadmin;

--
-- Name: DonationGoal; Type: TABLE; Schema: public; Owner: doadmin
--

CREATE TABLE public."DonationGoal" (
    id integer NOT NULL,
    "userId" integer NOT NULL,
    title text NOT NULL,
    description text,
    "goalAmount" integer NOT NULL,
    "paidAmount" integer DEFAULT 0 NOT NULL,
    "modelVersionId" integer,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "isEarlyAccess" boolean DEFAULT false NOT NULL,
    active boolean DEFAULT true NOT NULL
);


ALTER TABLE public."DonationGoal" OWNER TO doadmin;

--
-- Name: DonationGoal_id_seq; Type: SEQUENCE; Schema: public; Owner: doadmin
--

CREATE SEQUENCE public."DonationGoal_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public."DonationGoal_id_seq" OWNER TO doadmin;

--
-- Name: DonationGoal_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: doadmin
--

ALTER SEQUENCE public."DonationGoal_id_seq" OWNED BY public."DonationGoal".id;


--
-- Name: Donation_id_seq; Type: SEQUENCE; Schema: public; Owner: doadmin
--

CREATE SEQUENCE public."Donation_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public."Donation_id_seq" OWNER TO doadmin;

--
-- Name: Donation_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: doadmin
--

ALTER SEQUENCE public."Donation_id_seq" OWNED BY public."Donation".id;


--
-- Name: DownloadHistory; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."DownloadHistory" (
    "userId" integer NOT NULL,
    "modelVersionId" integer NOT NULL,
    "downloadAt" timestamp(3) without time zone NOT NULL,
    hidden boolean DEFAULT false NOT NULL
);


ALTER TABLE public."DownloadHistory" OWNER TO civitai;

--
-- Name: EntityAccess; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."EntityAccess" (
    "accessToId" integer NOT NULL,
    "accessToType" text NOT NULL,
    "accessorId" integer NOT NULL,
    "accessorType" text NOT NULL,
    "addedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "addedById" integer NOT NULL,
    meta jsonb DEFAULT '{}'::jsonb,
    permissions integer DEFAULT 0 NOT NULL
);


ALTER TABLE public."EntityAccess" OWNER TO civitai;

--
-- Name: EntityCollaborator; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."EntityCollaborator" (
    "entityType" public."EntityType" NOT NULL,
    "entityId" integer NOT NULL,
    "userId" integer NOT NULL,
    status public."EntityCollaboratorStatus" DEFAULT 'Pending'::public."EntityCollaboratorStatus" NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "createdBy" integer NOT NULL,
    "lastMessageSentAt" timestamp(3) without time zone
);


ALTER TABLE public."EntityCollaborator" OWNER TO civitai;

--
-- Name: EntityMetric; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."EntityMetric" (
    "entityType" public."EntityMetric_EntityType_Type" NOT NULL,
    "entityId" integer NOT NULL,
    "metricType" public."EntityMetric_MetricType_Type" NOT NULL,
    "metricValue" integer DEFAULT 0 NOT NULL
);


ALTER TABLE public."EntityMetric" OWNER TO civitai;

--
-- Name: EntityMetricImage; Type: VIEW; Schema: public; Owner: civitai
--

CREATE VIEW public."EntityMetricImage" AS
 SELECT "EntityMetric"."entityId" AS "imageId",
    sum(
        CASE
            WHEN ("EntityMetric"."metricType" = 'ReactionLike'::public."EntityMetric_MetricType_Type") THEN "EntityMetric"."metricValue"
            ELSE NULL::integer
        END) AS "reactionLike",
    sum(
        CASE
            WHEN ("EntityMetric"."metricType" = 'ReactionHeart'::public."EntityMetric_MetricType_Type") THEN "EntityMetric"."metricValue"
            ELSE NULL::integer
        END) AS "reactionHeart",
    sum(
        CASE
            WHEN ("EntityMetric"."metricType" = 'ReactionLaugh'::public."EntityMetric_MetricType_Type") THEN "EntityMetric"."metricValue"
            ELSE NULL::integer
        END) AS "reactionLaugh",
    sum(
        CASE
            WHEN ("EntityMetric"."metricType" = 'ReactionCry'::public."EntityMetric_MetricType_Type") THEN "EntityMetric"."metricValue"
            ELSE NULL::integer
        END) AS "reactionCry",
    sum(
        CASE
            WHEN ("EntityMetric"."metricType" = ANY (ARRAY['ReactionLike'::public."EntityMetric_MetricType_Type", 'ReactionHeart'::public."EntityMetric_MetricType_Type", 'ReactionLaugh'::public."EntityMetric_MetricType_Type", 'ReactionCry'::public."EntityMetric_MetricType_Type"])) THEN "EntityMetric"."metricValue"
            ELSE NULL::integer
        END) AS "reactionTotal",
    sum(
        CASE
            WHEN ("EntityMetric"."metricType" = 'Comment'::public."EntityMetric_MetricType_Type") THEN "EntityMetric"."metricValue"
            ELSE NULL::integer
        END) AS comment,
    sum(
        CASE
            WHEN ("EntityMetric"."metricType" = 'Collection'::public."EntityMetric_MetricType_Type") THEN "EntityMetric"."metricValue"
            ELSE NULL::integer
        END) AS collection,
    sum(
        CASE
            WHEN ("EntityMetric"."metricType" = 'Buzz'::public."EntityMetric_MetricType_Type") THEN "EntityMetric"."metricValue"
            ELSE NULL::integer
        END) AS buzz
   FROM public."EntityMetric"
  WHERE ("EntityMetric"."entityType" = 'Image'::public."EntityMetric_EntityType_Type")
  GROUP BY "EntityMetric"."entityId";


ALTER TABLE public."EntityMetricImage" OWNER TO civitai;

--
-- Name: File; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."File" (
    id integer NOT NULL,
    name text NOT NULL,
    url text NOT NULL,
    "sizeKB" double precision NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    metadata jsonb,
    "entityId" integer NOT NULL,
    "entityType" text NOT NULL
);


ALTER TABLE public."File" OWNER TO civitai;

--
-- Name: File_id_seq; Type: SEQUENCE; Schema: public; Owner: civitai
--

CREATE SEQUENCE public."File_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public."File_id_seq" OWNER TO civitai;

--
-- Name: File_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: civitai
--

ALTER SEQUENCE public."File_id_seq" OWNED BY public."File".id;


--
-- Name: ModelFile; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."ModelFile" (
    name text NOT NULL,
    url text NOT NULL,
    "sizeKB" double precision NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "modelVersionId" integer NOT NULL,
    "pickleScanResult" public."ScanResultCode" DEFAULT 'Pending'::public."ScanResultCode" NOT NULL,
    "pickleScanMessage" text,
    "virusScanResult" public."ScanResultCode" DEFAULT 'Pending'::public."ScanResultCode" NOT NULL,
    "virusScanMessage" text,
    "scannedAt" timestamp(3) without time zone,
    "rawScanResult" jsonb,
    "scanRequestedAt" timestamp(3) without time zone,
    "exists" boolean,
    id integer NOT NULL,
    type text DEFAULT 'Model'::text NOT NULL,
    metadata jsonb,
    visibility public."ModelFileVisibility" DEFAULT 'Public'::public."ModelFileVisibility" NOT NULL,
    "dataPurged" boolean DEFAULT false NOT NULL,
    "headerData" jsonb,
    "overrideName" text
);


ALTER TABLE public."ModelFile" OWNER TO civitai;

--
-- Name: GenerationCoverage; Type: VIEW; Schema: public; Owner: civitai
--

CREATE VIEW public."GenerationCoverage" AS
 SELECT m.id AS "modelId",
    mv.id AS "modelVersionId",
    true AS covered
   FROM (public."ModelVersion" mv
     JOIN public."Model" m ON ((m.id = mv."modelId")))
  WHERE ((mv.id = ANY (ARRAY[164821, 128713, 128078, 391999, 424706, 106916, 250712, 250708, 691639, 699279, 699332, 922358])) OR ((mv."baseModel" = ANY (ARRAY['SD 1.5'::text, 'SD 1.4'::text, 'SD 1.5 LCM'::text, 'SDXL 0.9'::text, 'SDXL 1.0'::text, 'SDXL 1.0 LCM'::text, 'Pony'::text, 'Flux.1 D'::text])) AND (NOT m.poi) AND ((mv.status = 'Published'::public."ModelStatus") OR (m.availability = 'Private'::public."Availability")) AND (m."allowCommercialUse" && ARRAY['RentCivit'::public."CommercialUse", 'Rent'::public."CommercialUse", 'Sell'::public."CommercialUse"]) AND (((m.type = 'Checkpoint'::public."ModelType") AND (mv."baseModelType" = 'Standard'::text) AND (mv.id IN ( SELECT "CoveredCheckpointDetails".version_id
           FROM public."CoveredCheckpointDetails"))) OR (m.type = 'LORA'::public."ModelType") OR (m.type = 'TextualInversion'::public."ModelType") OR (m.type = 'VAE'::public."ModelType") OR (m.type = 'LoCon'::public."ModelType") OR (m.type = 'DoRA'::public."ModelType")) AND (EXISTS ( SELECT 1
           FROM public."ModelFile" mf
          WHERE ((mf."modelVersionId" = mv.id) AND (mf."scannedAt" IS NOT NULL) AND (mf.type = ANY (ARRAY['Model'::text, 'Pruned Model'::text, 'Negative'::text, 'VAE'::text])))))));


ALTER TABLE public."GenerationCoverage" OWNER TO civitai;

--
-- Name: GenerationServiceProvider; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."GenerationServiceProvider" (
    name text NOT NULL,
    schedulers public."GenerationSchedulers"[]
);


ALTER TABLE public."GenerationServiceProvider" OWNER TO civitai;

--
-- Name: HomeBlock; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."HomeBlock" (
    id integer NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" timestamp(3) without time zone,
    "userId" integer NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    index integer,
    type public."HomeBlockType" NOT NULL,
    permanent boolean DEFAULT false NOT NULL,
    "sourceId" integer
);


ALTER TABLE public."HomeBlock" OWNER TO civitai;

--
-- Name: Image; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."Image" (
    name text,
    url text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    hash text,
    id integer NOT NULL,
    "userId" integer NOT NULL,
    height integer,
    width integer,
    meta jsonb,
    "tosViolation" boolean DEFAULT false NOT NULL,
    analysis jsonb,
    "generationProcess" public."ImageGenerationProcess",
    "featuredAt" timestamp(3) without time zone,
    "hideMeta" boolean DEFAULT false NOT NULL,
    index integer,
    "mimeType" text,
    "postId" integer,
    "scanRequestedAt" timestamp(3) without time zone,
    "scannedAt" timestamp(3) without time zone,
    "sizeKB" integer,
    nsfw public."NsfwLevel" DEFAULT 'None'::public."NsfwLevel" NOT NULL,
    "blockedFor" text,
    ingestion public."ImageIngestionStatus" DEFAULT 'Pending'::public."ImageIngestionStatus" NOT NULL,
    "needsReview" text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    type public."MediaType" DEFAULT 'image'::public."MediaType" NOT NULL,
    "scanJobs" jsonb,
    "nsfwLevel" integer DEFAULT 0 NOT NULL,
    "nsfwLevelLocked" boolean DEFAULT false NOT NULL,
    "aiNsfwLevel" integer DEFAULT 0 NOT NULL,
    "aiModel" text,
    "sortAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "pHash" bigint
);


ALTER TABLE public."Image" OWNER TO civitai;

--
-- Name: ImageConnection; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."ImageConnection" (
    "imageId" integer NOT NULL,
    "entityId" integer NOT NULL,
    "entityType" text NOT NULL
);


ALTER TABLE public."ImageConnection" OWNER TO civitai;

--
-- Name: ImageEngagement; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."ImageEngagement" (
    "userId" integer NOT NULL,
    "imageId" integer NOT NULL,
    type public."ImageEngagementType" NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


ALTER TABLE public."ImageEngagement" OWNER TO civitai;

--
-- Name: ImageFlag; Type: TABLE; Schema: public; Owner: doadmin
--

CREATE TABLE public."ImageFlag" (
    "imageId" integer NOT NULL,
    "promptNsfw" boolean DEFAULT false NOT NULL,
    "resourcesNsfw" boolean DEFAULT false NOT NULL
);


ALTER TABLE public."ImageFlag" OWNER TO doadmin;

--
-- Name: ImageMetric; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."ImageMetric" (
    "imageId" integer NOT NULL,
    timeframe public."MetricTimeframe" NOT NULL,
    "likeCount" integer DEFAULT 0 NOT NULL,
    "dislikeCount" integer DEFAULT 0 NOT NULL,
    "laughCount" integer DEFAULT 0 NOT NULL,
    "cryCount" integer DEFAULT 0 NOT NULL,
    "heartCount" integer DEFAULT 0 NOT NULL,
    "commentCount" integer DEFAULT 0 NOT NULL,
    "collectedCount" integer DEFAULT 0 NOT NULL,
    "tippedAmountCount" integer DEFAULT 0 NOT NULL,
    "tippedCount" integer DEFAULT 0 NOT NULL,
    "viewCount" integer DEFAULT 0 NOT NULL,
    "reactionCount" integer GENERATED ALWAYS AS (((("heartCount" + "likeCount") + "laughCount") + "cryCount")) STORED,
    "ageGroup" public."MetricTimeframe" DEFAULT 'Day'::public."MetricTimeframe" NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone DEFAULT now()
);


ALTER TABLE public."ImageMetric" OWNER TO civitai;

--
-- Name: ImageReport; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."ImageReport" (
    "imageId" integer NOT NULL,
    "reportId" integer NOT NULL
);


ALTER TABLE public."ImageReport" OWNER TO civitai;

--
-- Name: Report; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."Report" (
    id integer NOT NULL,
    "userId" integer NOT NULL,
    reason public."ReportReason" NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    details jsonb,
    "internalNotes" text,
    "alsoReportedBy" integer[] DEFAULT ARRAY[]::integer[],
    "previouslyReviewedCount" integer DEFAULT 0 NOT NULL,
    status public."ReportStatus" NOT NULL,
    "statusSetAt" timestamp(3) without time zone,
    "statusSetBy" integer
);


ALTER TABLE public."Report" OWNER TO civitai;

--
-- Name: ImageModHelper; Type: VIEW; Schema: public; Owner: civitai
--

CREATE VIEW public."ImageModHelper" AS
 WITH image_analysis AS (
         SELECT "Image".id,
            (("Image".analysis -> 'porn'::text))::real AS porn,
            (("Image".analysis -> 'sexy'::text))::real AS sexy,
            (("Image".analysis -> 'hentai'::text))::real AS hentai,
            (("Image".analysis -> 'drawing'::text))::real AS drawing,
            (("Image".analysis -> 'neutral'::text))::real AS neutral
           FROM public."Image"
          WHERE (("Image".analysis IS NOT NULL) AND (("Image".analysis ->> 'neutral'::text) <> '0'::text))
        )
 SELECT i.id AS "imageId",
    public.iif((ia.id IS NOT NULL), (((ia.porn + ia.hentai) + (ia.sexy / (2)::double precision)) > (0.6)::double precision), NULL::boolean) AS "assessedNSFW",
    COALESCE(reports.count, (0)::bigint) AS "nsfwReportCount"
   FROM ((public."Image" i
     LEFT JOIN image_analysis ia ON ((ia.id = i.id)))
     LEFT JOIN ( SELECT ir."imageId",
            count(DISTINCT r."userId") AS count
           FROM (public."ImageReport" ir
             JOIN public."Report" r ON ((r.id = ir."reportId")))
          WHERE (r.reason = 'NSFW'::public."ReportReason")
          GROUP BY ir."imageId") reports ON ((reports."imageId" = i.id)));


ALTER TABLE public."ImageModHelper" OWNER TO civitai;

--
-- Name: ImageRank; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."ImageRank" (
    "imageId" integer NOT NULL,
    "heartCountDayRank" bigint,
    "heartCountWeekRank" bigint,
    "heartCountMonthRank" bigint,
    "heartCountYearRank" bigint,
    "heartCountAllTimeRank" bigint,
    "likeCountDayRank" bigint,
    "likeCountWeekRank" bigint,
    "likeCountMonthRank" bigint,
    "likeCountYearRank" bigint,
    "likeCountAllTimeRank" bigint,
    "dislikeCountDayRank" bigint,
    "dislikeCountWeekRank" bigint,
    "dislikeCountMonthRank" bigint,
    "dislikeCountYearRank" bigint,
    "dislikeCountAllTimeRank" bigint,
    "laughCountDayRank" bigint,
    "laughCountWeekRank" bigint,
    "laughCountMonthRank" bigint,
    "laughCountYearRank" bigint,
    "laughCountAllTimeRank" bigint,
    "cryCountDayRank" bigint,
    "cryCountWeekRank" bigint,
    "cryCountMonthRank" bigint,
    "cryCountYearRank" bigint,
    "cryCountAllTimeRank" bigint,
    "reactionCountDayRank" bigint,
    "reactionCountWeekRank" bigint,
    "reactionCountMonthRank" bigint,
    "reactionCountYearRank" bigint,
    "reactionCountAllTimeRank" bigint,
    "commentCountDayRank" bigint,
    "commentCountWeekRank" bigint,
    "commentCountMonthRank" bigint,
    "commentCountYearRank" bigint,
    "commentCountAllTimeRank" bigint,
    "collectedCountDayRank" bigint,
    "collectedCountWeekRank" bigint,
    "collectedCountMonthRank" bigint,
    "collectedCountYearRank" bigint,
    "collectedCountAllTimeRank" bigint,
    "tippedCountDayRank" bigint,
    "tippedCountWeekRank" bigint,
    "tippedCountMonthRank" bigint,
    "tippedCountYearRank" bigint,
    "tippedCountAllTimeRank" bigint,
    "tippedAmountCountDayRank" bigint,
    "tippedAmountCountWeekRank" bigint,
    "tippedAmountCountMonthRank" bigint,
    "tippedAmountCountYearRank" bigint,
    "tippedAmountCountAllTimeRank" bigint
);


ALTER TABLE public."ImageRank" OWNER TO civitai;

--
-- Name: ImageRank_Live; Type: VIEW; Schema: public; Owner: civitai
--

CREATE VIEW public."ImageRank_Live" AS
 WITH timeframe_stats AS (
         SELECT "ImageMetric"."imageId",
            "ImageMetric"."heartCount",
            "ImageMetric"."likeCount",
            "ImageMetric"."dislikeCount",
            "ImageMetric"."laughCount",
            "ImageMetric"."cryCount",
            "ImageMetric"."commentCount",
            "ImageMetric"."collectedCount",
            (((("ImageMetric"."heartCount" + "ImageMetric"."likeCount") + "ImageMetric"."laughCount") + "ImageMetric"."cryCount") - "ImageMetric"."dislikeCount") AS "reactionCount",
            "ImageMetric"."tippedCount",
            "ImageMetric"."tippedAmountCount",
            "ImageMetric".timeframe
           FROM public."ImageMetric"
        ), timeframe_rank AS (
         SELECT timeframe_stats."imageId",
            row_number() OVER (PARTITION BY timeframe_stats.timeframe ORDER BY COALESCE(timeframe_stats."heartCount", 0) DESC, COALESCE(timeframe_stats."likeCount", 0) DESC, COALESCE(timeframe_stats."commentCount", 0) DESC, COALESCE(timeframe_stats."reactionCount", 0) DESC, timeframe_stats."imageId" DESC) AS "heartCountRank",
            row_number() OVER (PARTITION BY timeframe_stats.timeframe ORDER BY COALESCE(timeframe_stats."likeCount", 0) DESC, COALESCE(timeframe_stats."heartCount", 0) DESC, COALESCE(timeframe_stats."commentCount", 0) DESC, COALESCE(timeframe_stats."reactionCount", 0) DESC, timeframe_stats."imageId" DESC) AS "likeCountRank",
            row_number() OVER (PARTITION BY timeframe_stats.timeframe ORDER BY COALESCE(timeframe_stats."dislikeCount", 0) DESC, COALESCE(timeframe_stats."reactionCount", 0) DESC, COALESCE(timeframe_stats."commentCount", 0) DESC, timeframe_stats."imageId" DESC) AS "dislikeCountRank",
            row_number() OVER (PARTITION BY timeframe_stats.timeframe ORDER BY COALESCE(timeframe_stats."laughCount", 0) DESC, COALESCE(timeframe_stats."heartCount", 0) DESC, COALESCE(timeframe_stats."likeCount", 0) DESC, COALESCE(timeframe_stats."reactionCount", 0) DESC, COALESCE(timeframe_stats."commentCount", 0) DESC, timeframe_stats."imageId" DESC) AS "laughCountRank",
            row_number() OVER (PARTITION BY timeframe_stats.timeframe ORDER BY COALESCE(timeframe_stats."cryCount", 0) DESC, COALESCE(timeframe_stats."heartCount", 0) DESC, COALESCE(timeframe_stats."likeCount", 0) DESC, COALESCE(timeframe_stats."reactionCount", 0) DESC, COALESCE(timeframe_stats."commentCount", 0) DESC, timeframe_stats."imageId" DESC) AS "cryCountRank",
            row_number() OVER (PARTITION BY timeframe_stats.timeframe ORDER BY COALESCE(timeframe_stats."reactionCount", 0) DESC, COALESCE(timeframe_stats."heartCount", 0) DESC, COALESCE(timeframe_stats."likeCount", 0) DESC, COALESCE(timeframe_stats."commentCount", 0) DESC, timeframe_stats."imageId" DESC) AS "reactionCountRank",
            row_number() OVER (PARTITION BY timeframe_stats.timeframe ORDER BY COALESCE(timeframe_stats."commentCount", 0) DESC, COALESCE(timeframe_stats."reactionCount", 0) DESC, COALESCE(timeframe_stats."heartCount", 0) DESC, COALESCE(timeframe_stats."likeCount", 0) DESC, COALESCE(timeframe_stats."laughCount", 0) DESC, timeframe_stats."imageId" DESC) AS "commentCountRank",
            row_number() OVER (PARTITION BY timeframe_stats.timeframe ORDER BY COALESCE(timeframe_stats."collectedCount", 0) DESC, COALESCE(timeframe_stats."reactionCount", 0) DESC, COALESCE(timeframe_stats."heartCount", 0) DESC, COALESCE(timeframe_stats."likeCount", 0) DESC, COALESCE(timeframe_stats."laughCount", 0) DESC, timeframe_stats."imageId" DESC) AS "collectedCountRank",
            row_number() OVER (PARTITION BY timeframe_stats.timeframe ORDER BY COALESCE(timeframe_stats."tippedCount", 0) DESC, COALESCE(timeframe_stats."reactionCount", 0) DESC, COALESCE(timeframe_stats."heartCount", 0) DESC, COALESCE(timeframe_stats."likeCount", 0) DESC, COALESCE(timeframe_stats."laughCount", 0) DESC, timeframe_stats."imageId" DESC) AS "tippedCountRank",
            row_number() OVER (PARTITION BY timeframe_stats.timeframe ORDER BY COALESCE(timeframe_stats."tippedAmountCount", 0) DESC, COALESCE(timeframe_stats."reactionCount", 0) DESC, COALESCE(timeframe_stats."heartCount", 0) DESC, COALESCE(timeframe_stats."likeCount", 0) DESC, COALESCE(timeframe_stats."laughCount", 0) DESC, timeframe_stats."imageId" DESC) AS "tippedAmountCountRank",
            timeframe_stats.timeframe
           FROM timeframe_stats
        )
 SELECT timeframe_rank."imageId",
    max(public.iif((timeframe_rank.timeframe = 'Day'::public."MetricTimeframe"), timeframe_rank."heartCountRank", NULL::bigint)) AS "heartCountDayRank",
    max(public.iif((timeframe_rank.timeframe = 'Week'::public."MetricTimeframe"), timeframe_rank."heartCountRank", NULL::bigint)) AS "heartCountWeekRank",
    max(public.iif((timeframe_rank.timeframe = 'Month'::public."MetricTimeframe"), timeframe_rank."heartCountRank", NULL::bigint)) AS "heartCountMonthRank",
    max(public.iif((timeframe_rank.timeframe = 'Year'::public."MetricTimeframe"), timeframe_rank."heartCountRank", NULL::bigint)) AS "heartCountYearRank",
    max(public.iif((timeframe_rank.timeframe = 'AllTime'::public."MetricTimeframe"), timeframe_rank."heartCountRank", NULL::bigint)) AS "heartCountAllTimeRank",
    max(public.iif((timeframe_rank.timeframe = 'Day'::public."MetricTimeframe"), timeframe_rank."likeCountRank", NULL::bigint)) AS "likeCountDayRank",
    max(public.iif((timeframe_rank.timeframe = 'Week'::public."MetricTimeframe"), timeframe_rank."likeCountRank", NULL::bigint)) AS "likeCountWeekRank",
    max(public.iif((timeframe_rank.timeframe = 'Month'::public."MetricTimeframe"), timeframe_rank."likeCountRank", NULL::bigint)) AS "likeCountMonthRank",
    max(public.iif((timeframe_rank.timeframe = 'Year'::public."MetricTimeframe"), timeframe_rank."likeCountRank", NULL::bigint)) AS "likeCountYearRank",
    max(public.iif((timeframe_rank.timeframe = 'AllTime'::public."MetricTimeframe"), timeframe_rank."likeCountRank", NULL::bigint)) AS "likeCountAllTimeRank",
    max(public.iif((timeframe_rank.timeframe = 'Day'::public."MetricTimeframe"), timeframe_rank."dislikeCountRank", NULL::bigint)) AS "dislikeCountDayRank",
    max(public.iif((timeframe_rank.timeframe = 'Week'::public."MetricTimeframe"), timeframe_rank."dislikeCountRank", NULL::bigint)) AS "dislikeCountWeekRank",
    max(public.iif((timeframe_rank.timeframe = 'Month'::public."MetricTimeframe"), timeframe_rank."dislikeCountRank", NULL::bigint)) AS "dislikeCountMonthRank",
    max(public.iif((timeframe_rank.timeframe = 'Year'::public."MetricTimeframe"), timeframe_rank."dislikeCountRank", NULL::bigint)) AS "dislikeCountYearRank",
    max(public.iif((timeframe_rank.timeframe = 'AllTime'::public."MetricTimeframe"), timeframe_rank."dislikeCountRank", NULL::bigint)) AS "dislikeCountAllTimeRank",
    max(public.iif((timeframe_rank.timeframe = 'Day'::public."MetricTimeframe"), timeframe_rank."laughCountRank", NULL::bigint)) AS "laughCountDayRank",
    max(public.iif((timeframe_rank.timeframe = 'Week'::public."MetricTimeframe"), timeframe_rank."laughCountRank", NULL::bigint)) AS "laughCountWeekRank",
    max(public.iif((timeframe_rank.timeframe = 'Month'::public."MetricTimeframe"), timeframe_rank."laughCountRank", NULL::bigint)) AS "laughCountMonthRank",
    max(public.iif((timeframe_rank.timeframe = 'Year'::public."MetricTimeframe"), timeframe_rank."laughCountRank", NULL::bigint)) AS "laughCountYearRank",
    max(public.iif((timeframe_rank.timeframe = 'AllTime'::public."MetricTimeframe"), timeframe_rank."laughCountRank", NULL::bigint)) AS "laughCountAllTimeRank",
    max(public.iif((timeframe_rank.timeframe = 'Day'::public."MetricTimeframe"), timeframe_rank."cryCountRank", NULL::bigint)) AS "cryCountDayRank",
    max(public.iif((timeframe_rank.timeframe = 'Week'::public."MetricTimeframe"), timeframe_rank."cryCountRank", NULL::bigint)) AS "cryCountWeekRank",
    max(public.iif((timeframe_rank.timeframe = 'Month'::public."MetricTimeframe"), timeframe_rank."cryCountRank", NULL::bigint)) AS "cryCountMonthRank",
    max(public.iif((timeframe_rank.timeframe = 'Year'::public."MetricTimeframe"), timeframe_rank."cryCountRank", NULL::bigint)) AS "cryCountYearRank",
    max(public.iif((timeframe_rank.timeframe = 'AllTime'::public."MetricTimeframe"), timeframe_rank."cryCountRank", NULL::bigint)) AS "cryCountAllTimeRank",
    max(public.iif((timeframe_rank.timeframe = 'Day'::public."MetricTimeframe"), timeframe_rank."reactionCountRank", NULL::bigint)) AS "reactionCountDayRank",
    max(public.iif((timeframe_rank.timeframe = 'Week'::public."MetricTimeframe"), timeframe_rank."reactionCountRank", NULL::bigint)) AS "reactionCountWeekRank",
    max(public.iif((timeframe_rank.timeframe = 'Month'::public."MetricTimeframe"), timeframe_rank."reactionCountRank", NULL::bigint)) AS "reactionCountMonthRank",
    max(public.iif((timeframe_rank.timeframe = 'Year'::public."MetricTimeframe"), timeframe_rank."reactionCountRank", NULL::bigint)) AS "reactionCountYearRank",
    max(public.iif((timeframe_rank.timeframe = 'AllTime'::public."MetricTimeframe"), timeframe_rank."reactionCountRank", NULL::bigint)) AS "reactionCountAllTimeRank",
    max(public.iif((timeframe_rank.timeframe = 'Day'::public."MetricTimeframe"), timeframe_rank."commentCountRank", NULL::bigint)) AS "commentCountDayRank",
    max(public.iif((timeframe_rank.timeframe = 'Week'::public."MetricTimeframe"), timeframe_rank."commentCountRank", NULL::bigint)) AS "commentCountWeekRank",
    max(public.iif((timeframe_rank.timeframe = 'Month'::public."MetricTimeframe"), timeframe_rank."commentCountRank", NULL::bigint)) AS "commentCountMonthRank",
    max(public.iif((timeframe_rank.timeframe = 'Year'::public."MetricTimeframe"), timeframe_rank."commentCountRank", NULL::bigint)) AS "commentCountYearRank",
    max(public.iif((timeframe_rank.timeframe = 'AllTime'::public."MetricTimeframe"), timeframe_rank."commentCountRank", NULL::bigint)) AS "commentCountAllTimeRank",
    max(public.iif((timeframe_rank.timeframe = 'Day'::public."MetricTimeframe"), timeframe_rank."collectedCountRank", NULL::bigint)) AS "collectedCountDayRank",
    max(public.iif((timeframe_rank.timeframe = 'Week'::public."MetricTimeframe"), timeframe_rank."collectedCountRank", NULL::bigint)) AS "collectedCountWeekRank",
    max(public.iif((timeframe_rank.timeframe = 'Month'::public."MetricTimeframe"), timeframe_rank."collectedCountRank", NULL::bigint)) AS "collectedCountMonthRank",
    max(public.iif((timeframe_rank.timeframe = 'Year'::public."MetricTimeframe"), timeframe_rank."collectedCountRank", NULL::bigint)) AS "collectedCountYearRank",
    max(public.iif((timeframe_rank.timeframe = 'AllTime'::public."MetricTimeframe"), timeframe_rank."collectedCountRank", NULL::bigint)) AS "collectedCountAllTimeRank",
    max(public.iif((timeframe_rank.timeframe = 'Day'::public."MetricTimeframe"), timeframe_rank."tippedCountRank", NULL::bigint)) AS "tippedCountDayRank",
    max(public.iif((timeframe_rank.timeframe = 'Week'::public."MetricTimeframe"), timeframe_rank."tippedCountRank", NULL::bigint)) AS "tippedCountWeekRank",
    max(public.iif((timeframe_rank.timeframe = 'Month'::public."MetricTimeframe"), timeframe_rank."tippedCountRank", NULL::bigint)) AS "tippedCountMonthRank",
    max(public.iif((timeframe_rank.timeframe = 'Year'::public."MetricTimeframe"), timeframe_rank."tippedCountRank", NULL::bigint)) AS "tippedCountYearRank",
    max(public.iif((timeframe_rank.timeframe = 'AllTime'::public."MetricTimeframe"), timeframe_rank."tippedCountRank", NULL::bigint)) AS "tippedCountAllTimeRank",
    max(public.iif((timeframe_rank.timeframe = 'Day'::public."MetricTimeframe"), timeframe_rank."tippedAmountCountRank", NULL::bigint)) AS "tippedAmountCountDayRank",
    max(public.iif((timeframe_rank.timeframe = 'Week'::public."MetricTimeframe"), timeframe_rank."tippedAmountCountRank", NULL::bigint)) AS "tippedAmountCountWeekRank",
    max(public.iif((timeframe_rank.timeframe = 'Month'::public."MetricTimeframe"), timeframe_rank."tippedAmountCountRank", NULL::bigint)) AS "tippedAmountCountMonthRank",
    max(public.iif((timeframe_rank.timeframe = 'Year'::public."MetricTimeframe"), timeframe_rank."tippedAmountCountRank", NULL::bigint)) AS "tippedAmountCountYearRank",
    max(public.iif((timeframe_rank.timeframe = 'AllTime'::public."MetricTimeframe"), timeframe_rank."tippedAmountCountRank", NULL::bigint)) AS "tippedAmountCountAllTimeRank"
   FROM timeframe_rank
  GROUP BY timeframe_rank."imageId";


ALTER TABLE public."ImageRank_Live" OWNER TO civitai;

--
-- Name: ImageRatingRequest; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."ImageRatingRequest" (
    "userId" integer NOT NULL,
    "imageId" integer NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "nsfwLevel" integer NOT NULL,
    status public."ReportStatus" DEFAULT 'Pending'::public."ReportStatus" NOT NULL
);


ALTER TABLE public."ImageRatingRequest" OWNER TO civitai;

--
-- Name: ImageReaction; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."ImageReaction" (
    id integer NOT NULL,
    "imageId" integer NOT NULL,
    "userId" integer NOT NULL,
    reaction public."ReviewReactions" NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


ALTER TABLE public."ImageReaction" OWNER TO civitai;

--
-- Name: ImageReaction_id_seq; Type: SEQUENCE; Schema: public; Owner: civitai
--

CREATE SEQUENCE public."ImageReaction_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public."ImageReaction_id_seq" OWNER TO civitai;

--
-- Name: ImageReaction_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: civitai
--

ALTER SEQUENCE public."ImageReaction_id_seq" OWNED BY public."ImageReaction".id;


--
-- Name: ImageResource; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."ImageResource" (
    id integer NOT NULL,
    "modelVersionId" integer,
    name text,
    "imageId" integer NOT NULL,
    detected boolean DEFAULT false NOT NULL,
    hash public.citext,
    strength integer
);


ALTER TABLE public."ImageResource" OWNER TO civitai;

--
-- Name: ModelVersionMetric; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."ModelVersionMetric" (
    "modelVersionId" integer NOT NULL,
    timeframe public."MetricTimeframe" NOT NULL,
    rating double precision DEFAULT 0 NOT NULL,
    "ratingCount" integer DEFAULT 0 NOT NULL,
    "downloadCount" integer DEFAULT 0 NOT NULL,
    "favoriteCount" integer DEFAULT 0 NOT NULL,
    "commentCount" integer DEFAULT 0 NOT NULL,
    "collectedCount" integer DEFAULT 0 NOT NULL,
    "imageCount" integer DEFAULT 0 NOT NULL,
    "tippedAmountCount" integer DEFAULT 0 NOT NULL,
    "tippedCount" integer DEFAULT 0 NOT NULL,
    "updatedAt" timestamp(3) without time zone DEFAULT now(),
    "generationCount" integer DEFAULT 0 NOT NULL,
    "thumbsDownCount" integer DEFAULT 0 NOT NULL,
    "thumbsUpCount" integer DEFAULT 0 NOT NULL
);


ALTER TABLE public."ModelVersionMetric" OWNER TO civitai;

--
-- Name: ResourceReview; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."ResourceReview" (
    id integer NOT NULL,
    "modelVersionId" integer NOT NULL,
    rating integer NOT NULL,
    details text,
    "userId" integer NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "exclude" boolean DEFAULT false NOT NULL,
    metadata jsonb,
    "modelId" integer NOT NULL,
    nsfw boolean DEFAULT false NOT NULL,
    "tosViolation" boolean DEFAULT false NOT NULL,
    recommended boolean DEFAULT true NOT NULL
);


ALTER TABLE public."ResourceReview" OWNER TO civitai;

--
-- Name: ImageResourceHelper; Type: VIEW; Schema: public; Owner: doadmin
--

CREATE VIEW public."ImageResourceHelper" AS
 SELECT ir.id,
    ir."imageId",
    rr.id AS "reviewId",
    rr.rating AS "reviewRating",
    rr.recommended AS "reviewRecommended",
    rr.details AS "reviewDetails",
    rr."createdAt" AS "reviewCreatedAt",
    ir.name,
    ir.hash,
    mv.id AS "modelVersionId",
    mv.name AS "modelVersionName",
    mv."createdAt" AS "modelVersionCreatedAt",
    m.id AS "modelId",
    m.name AS "modelName",
    mvm."thumbsUpCount" AS "modelThumbsUpCount",
    mvm."thumbsDownCount" AS "modelThumbsDownCount",
    mvm."downloadCount" AS "modelDownloadCount",
    mvm."commentCount" AS "modelCommentCount",
    m.type AS "modelType",
    i."postId",
    mvm.rating AS "modelRating",
    mvm."ratingCount" AS "modelRatingCount",
    mvm."favoriteCount" AS "modelFavoriteCount"
   FROM (((((public."ImageResource" ir
     JOIN public."Image" i ON ((i.id = ir."imageId")))
     LEFT JOIN public."ModelVersion" mv ON ((mv.id = ir."modelVersionId")))
     LEFT JOIN public."Model" m ON ((m.id = mv."modelId")))
     LEFT JOIN public."ModelVersionMetric" mvm ON (((mvm."modelVersionId" = ir."modelVersionId") AND (mvm.timeframe = 'AllTime'::public."MetricTimeframe"))))
     LEFT JOIN public."ResourceReview" rr ON (((rr."modelVersionId" = mv.id) AND (rr."userId" = i."userId"))));


ALTER TABLE public."ImageResourceHelper" OWNER TO doadmin;

--
-- Name: ImageResource_id_seq; Type: SEQUENCE; Schema: public; Owner: civitai
--

CREATE SEQUENCE public."ImageResource_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public."ImageResource_id_seq" OWNER TO civitai;

--
-- Name: ImageResource_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: civitai
--

ALTER SEQUENCE public."ImageResource_id_seq" OWNED BY public."ImageResource".id;


--
-- Name: ImageStat; Type: VIEW; Schema: public; Owner: civitai
--

CREATE VIEW public."ImageStat" AS
 WITH timeframe_stats AS (
         SELECT im."imageId",
            COALESCE(im."heartCount", 0) AS "heartCount",
            COALESCE(im."likeCount", 0) AS "likeCount",
            COALESCE(im."dislikeCount", 0) AS "dislikeCount",
            COALESCE(im."laughCount", 0) AS "laughCount",
            COALESCE(im."cryCount", 0) AS "cryCount",
            COALESCE(im."commentCount", 0) AS "commentCount",
            COALESCE(im."collectedCount", 0) AS "collectedCount",
            COALESCE(im."tippedCount", 0) AS "tippedCount",
            COALESCE(im."tippedAmountCount", 0) AS "tippedAmountCount",
            COALESCE(im."viewCount", 0) AS "viewCount",
            im.timeframe
           FROM public."ImageMetric" im
        )
 SELECT timeframe_stats."imageId",
    max(public.iif((timeframe_stats.timeframe = 'Day'::public."MetricTimeframe"), timeframe_stats."heartCount", NULL::integer)) AS "heartCountDay",
    max(public.iif((timeframe_stats.timeframe = 'Week'::public."MetricTimeframe"), timeframe_stats."heartCount", NULL::integer)) AS "heartCountWeek",
    max(public.iif((timeframe_stats.timeframe = 'Month'::public."MetricTimeframe"), timeframe_stats."heartCount", NULL::integer)) AS "heartCountMonth",
    max(public.iif((timeframe_stats.timeframe = 'Year'::public."MetricTimeframe"), timeframe_stats."heartCount", NULL::integer)) AS "heartCountYear",
    max(public.iif((timeframe_stats.timeframe = 'AllTime'::public."MetricTimeframe"), timeframe_stats."heartCount", NULL::integer)) AS "heartCountAllTime",
    max(public.iif((timeframe_stats.timeframe = 'Day'::public."MetricTimeframe"), timeframe_stats."likeCount", NULL::integer)) AS "likeCountDay",
    max(public.iif((timeframe_stats.timeframe = 'Week'::public."MetricTimeframe"), timeframe_stats."likeCount", NULL::integer)) AS "likeCountWeek",
    max(public.iif((timeframe_stats.timeframe = 'Month'::public."MetricTimeframe"), timeframe_stats."likeCount", NULL::integer)) AS "likeCountMonth",
    max(public.iif((timeframe_stats.timeframe = 'Year'::public."MetricTimeframe"), timeframe_stats."likeCount", NULL::integer)) AS "likeCountYear",
    max(public.iif((timeframe_stats.timeframe = 'AllTime'::public."MetricTimeframe"), timeframe_stats."likeCount", NULL::integer)) AS "likeCountAllTime",
    max(public.iif((timeframe_stats.timeframe = 'Day'::public."MetricTimeframe"), timeframe_stats."dislikeCount", NULL::integer)) AS "dislikeCountDay",
    max(public.iif((timeframe_stats.timeframe = 'Week'::public."MetricTimeframe"), timeframe_stats."dislikeCount", NULL::integer)) AS "dislikeCountWeek",
    max(public.iif((timeframe_stats.timeframe = 'Month'::public."MetricTimeframe"), timeframe_stats."dislikeCount", NULL::integer)) AS "dislikeCountMonth",
    max(public.iif((timeframe_stats.timeframe = 'Year'::public."MetricTimeframe"), timeframe_stats."dislikeCount", NULL::integer)) AS "dislikeCountYear",
    max(public.iif((timeframe_stats.timeframe = 'AllTime'::public."MetricTimeframe"), timeframe_stats."dislikeCount", NULL::integer)) AS "dislikeCountAllTime",
    max(public.iif((timeframe_stats.timeframe = 'Day'::public."MetricTimeframe"), timeframe_stats."laughCount", NULL::integer)) AS "laughCountDay",
    max(public.iif((timeframe_stats.timeframe = 'Week'::public."MetricTimeframe"), timeframe_stats."laughCount", NULL::integer)) AS "laughCountWeek",
    max(public.iif((timeframe_stats.timeframe = 'Month'::public."MetricTimeframe"), timeframe_stats."laughCount", NULL::integer)) AS "laughCountMonth",
    max(public.iif((timeframe_stats.timeframe = 'Year'::public."MetricTimeframe"), timeframe_stats."laughCount", NULL::integer)) AS "laughCountYear",
    max(public.iif((timeframe_stats.timeframe = 'AllTime'::public."MetricTimeframe"), timeframe_stats."laughCount", NULL::integer)) AS "laughCountAllTime",
    max(public.iif((timeframe_stats.timeframe = 'Day'::public."MetricTimeframe"), timeframe_stats."cryCount", NULL::integer)) AS "cryCountDay",
    max(public.iif((timeframe_stats.timeframe = 'Week'::public."MetricTimeframe"), timeframe_stats."cryCount", NULL::integer)) AS "cryCountWeek",
    max(public.iif((timeframe_stats.timeframe = 'Month'::public."MetricTimeframe"), timeframe_stats."cryCount", NULL::integer)) AS "cryCountMonth",
    max(public.iif((timeframe_stats.timeframe = 'Year'::public."MetricTimeframe"), timeframe_stats."cryCount", NULL::integer)) AS "cryCountYear",
    max(public.iif((timeframe_stats.timeframe = 'AllTime'::public."MetricTimeframe"), timeframe_stats."cryCount", NULL::integer)) AS "cryCountAllTime",
    max(public.iif((timeframe_stats.timeframe = 'Day'::public."MetricTimeframe"), timeframe_stats."commentCount", NULL::integer)) AS "commentCountDay",
    max(public.iif((timeframe_stats.timeframe = 'Week'::public."MetricTimeframe"), timeframe_stats."commentCount", NULL::integer)) AS "commentCountWeek",
    max(public.iif((timeframe_stats.timeframe = 'Month'::public."MetricTimeframe"), timeframe_stats."commentCount", NULL::integer)) AS "commentCountMonth",
    max(public.iif((timeframe_stats.timeframe = 'Year'::public."MetricTimeframe"), timeframe_stats."commentCount", NULL::integer)) AS "commentCountYear",
    max(public.iif((timeframe_stats.timeframe = 'AllTime'::public."MetricTimeframe"), timeframe_stats."commentCount", NULL::integer)) AS "commentCountAllTime",
    max(public.iif((timeframe_stats.timeframe = 'Day'::public."MetricTimeframe"), timeframe_stats."collectedCount", NULL::integer)) AS "collectedCountDay",
    max(public.iif((timeframe_stats.timeframe = 'Week'::public."MetricTimeframe"), timeframe_stats."collectedCount", NULL::integer)) AS "collectedCountWeek",
    max(public.iif((timeframe_stats.timeframe = 'Month'::public."MetricTimeframe"), timeframe_stats."collectedCount", NULL::integer)) AS "collectedCountMonth",
    max(public.iif((timeframe_stats.timeframe = 'Year'::public."MetricTimeframe"), timeframe_stats."collectedCount", NULL::integer)) AS "collectedCountYear",
    max(public.iif((timeframe_stats.timeframe = 'AllTime'::public."MetricTimeframe"), timeframe_stats."collectedCount", NULL::integer)) AS "collectedCountAllTime",
    max(public.iif((timeframe_stats.timeframe = 'Day'::public."MetricTimeframe"), timeframe_stats."tippedCount", NULL::integer)) AS "tippedCountDay",
    max(public.iif((timeframe_stats.timeframe = 'Week'::public."MetricTimeframe"), timeframe_stats."tippedCount", NULL::integer)) AS "tippedCountWeek",
    max(public.iif((timeframe_stats.timeframe = 'Month'::public."MetricTimeframe"), timeframe_stats."tippedCount", NULL::integer)) AS "tippedCountMonth",
    max(public.iif((timeframe_stats.timeframe = 'Year'::public."MetricTimeframe"), timeframe_stats."tippedCount", NULL::integer)) AS "tippedCountYear",
    max(public.iif((timeframe_stats.timeframe = 'AllTime'::public."MetricTimeframe"), timeframe_stats."tippedCount", NULL::integer)) AS "tippedCountAllTime",
    max(public.iif((timeframe_stats.timeframe = 'Day'::public."MetricTimeframe"), timeframe_stats."tippedAmountCount", NULL::integer)) AS "tippedAmountCountDay",
    max(public.iif((timeframe_stats.timeframe = 'Week'::public."MetricTimeframe"), timeframe_stats."tippedAmountCount", NULL::integer)) AS "tippedAmountCountWeek",
    max(public.iif((timeframe_stats.timeframe = 'Month'::public."MetricTimeframe"), timeframe_stats."tippedAmountCount", NULL::integer)) AS "tippedAmountCountMonth",
    max(public.iif((timeframe_stats.timeframe = 'Year'::public."MetricTimeframe"), timeframe_stats."tippedAmountCount", NULL::integer)) AS "tippedAmountCountYear",
    max(public.iif((timeframe_stats.timeframe = 'AllTime'::public."MetricTimeframe"), timeframe_stats."tippedAmountCount", NULL::integer)) AS "tippedAmountCountAllTime",
    max(public.iif((timeframe_stats.timeframe = 'Day'::public."MetricTimeframe"), timeframe_stats."viewCount", NULL::integer)) AS "viewCountDay",
    max(public.iif((timeframe_stats.timeframe = 'Week'::public."MetricTimeframe"), timeframe_stats."viewCount", NULL::integer)) AS "viewCountWeek",
    max(public.iif((timeframe_stats.timeframe = 'Month'::public."MetricTimeframe"), timeframe_stats."viewCount", NULL::integer)) AS "viewCountMonth",
    max(public.iif((timeframe_stats.timeframe = 'Year'::public."MetricTimeframe"), timeframe_stats."viewCount", NULL::integer)) AS "viewCountYear",
    max(public.iif((timeframe_stats.timeframe = 'AllTime'::public."MetricTimeframe"), timeframe_stats."viewCount", NULL::integer)) AS "viewCountAllTime"
   FROM timeframe_stats
  GROUP BY timeframe_stats."imageId";


ALTER TABLE public."ImageStat" OWNER TO civitai;

--
-- Name: Tag; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."Tag" (
    name public.citext NOT NULL,
    color text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    id integer NOT NULL,
    target public."TagTarget"[] NOT NULL,
    unlisted boolean DEFAULT false NOT NULL,
    "isCategory" boolean DEFAULT false NOT NULL,
    unfeatured boolean DEFAULT false NOT NULL,
    type public."TagType" DEFAULT 'UserGenerated'::public."TagType" NOT NULL,
    nsfw public."NsfwLevel" DEFAULT 'None'::public."NsfwLevel" NOT NULL,
    "adminOnly" boolean DEFAULT false NOT NULL,
    "nsfwLevel" integer DEFAULT 1 NOT NULL
);


ALTER TABLE public."Tag" OWNER TO civitai;

--
-- Name: TagsOnImage; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."TagsOnImage" (
    "imageId" integer NOT NULL,
    "tagId" integer NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    automated boolean DEFAULT false NOT NULL,
    confidence integer,
    disabled boolean DEFAULT false NOT NULL,
    "needsReview" boolean DEFAULT false NOT NULL,
    "disabledAt" timestamp(3) without time zone,
    source public."TagSource" DEFAULT 'User'::public."TagSource" NOT NULL
);


ALTER TABLE public."TagsOnImage" OWNER TO civitai;

--
-- Name: TagsOnImageVote; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."TagsOnImageVote" (
    "imageId" integer NOT NULL,
    "tagId" integer NOT NULL,
    "userId" integer NOT NULL,
    vote integer NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    applied boolean DEFAULT false NOT NULL
);


ALTER TABLE public."TagsOnImageVote" OWNER TO civitai;

--
-- Name: ImageTag; Type: VIEW; Schema: public; Owner: civitai
--

CREATE VIEW public."ImageTag" AS
 SELECT it."imageId",
    it."tagId",
    COALESCE(toi.automated, false) AS automated,
    COALESCE(toi.confidence, 0) AS confidence,
    (COALESCE((((10 * toi.confidence) / 100))::numeric, (0)::numeric) + COALESCE((v.score)::numeric, (0)::numeric)) AS score,
    COALESCE(v."upVotes", (0)::bigint) AS "upVotes",
    COALESCE(v."downVotes", (0)::bigint) AS "downVotes",
    t.name AS "tagName",
    t.type AS "tagType",
    t.nsfw AS "tagNsfw",
    t."nsfwLevel" AS "tagNsfwLevel",
    COALESCE(toi."needsReview", false) AS "needsReview",
    true AS concrete,
    v."lastUpvote",
    COALESCE(toi.source, 'User'::public."TagSource") AS source
   FROM (((( SELECT toi_1."imageId",
            toi_1."tagId"
           FROM public."TagsOnImage" toi_1
        UNION
         SELECT toiv."imageId",
            toiv."tagId"
           FROM public."TagsOnImageVote" toiv) it
     LEFT JOIN public."TagsOnImage" toi ON (((it."imageId" = toi."imageId") AND (it."tagId" = toi."tagId"))))
     CROSS JOIN LATERAL ( SELECT sum(v_1.vote) AS score,
            sum(public.iif((v_1.vote > 0), 1, 0)) AS "upVotes",
            sum(public.iif((v_1.vote < 0), 1, 0)) AS "downVotes",
            max(public.iif((v_1.vote > 0), v_1."createdAt", NULL::timestamp without time zone)) AS "lastUpvote"
           FROM public."TagsOnImageVote" v_1
          WHERE ((v_1."imageId" = it."imageId") AND (v_1."tagId" = it."tagId"))) v)
     CROSS JOIN LATERAL ( SELECT t_1.name,
            t_1.color,
            t_1."createdAt",
            t_1."updatedAt",
            t_1.id,
            t_1.target,
            t_1.unlisted,
            t_1."isCategory",
            t_1.unfeatured,
            t_1.type,
            t_1.nsfw,
            t_1."adminOnly",
            t_1."nsfwLevel"
           FROM public."Tag" t_1
          WHERE (t_1.id = it."tagId")
         LIMIT 1) t)
  WHERE ((t.unlisted IS FALSE) AND ((toi.disabled IS NULL) OR (toi.disabled = false)));


ALTER TABLE public."ImageTag" OWNER TO civitai;

--
-- Name: ImageTechnique; Type: TABLE; Schema: public; Owner: doadmin
--

CREATE TABLE public."ImageTechnique" (
    "imageId" integer NOT NULL,
    "techniqueId" integer NOT NULL,
    notes text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


ALTER TABLE public."ImageTechnique" OWNER TO doadmin;

--
-- Name: ImageTool; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."ImageTool" (
    "imageId" integer NOT NULL,
    "toolId" integer NOT NULL,
    notes text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


ALTER TABLE public."ImageTool" OWNER TO civitai;

--
-- Name: Image_id_seq; Type: SEQUENCE; Schema: public; Owner: civitai
--

CREATE SEQUENCE public."Image_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public."Image_id_seq" OWNER TO civitai;

--
-- Name: Image_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: civitai
--

ALTER SEQUENCE public."Image_id_seq" OWNED BY public."Image".id;


--
-- Name: ImagesOnModels; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."ImagesOnModels" (
    "modelVersionId" integer NOT NULL,
    "imageId" integer NOT NULL,
    index integer
);


ALTER TABLE public."ImagesOnModels" OWNER TO civitai;

--
-- Name: Import; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."Import" (
    id integer NOT NULL,
    "userId" integer,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "startedAt" timestamp(3) without time zone,
    "finishedAt" timestamp(3) without time zone,
    source text NOT NULL,
    status public."ImportStatus" DEFAULT 'Pending'::public."ImportStatus" NOT NULL,
    data jsonb,
    "importId" integer,
    "parentId" integer
);


ALTER TABLE public."Import" OWNER TO civitai;

--
-- Name: Import_id_seq; Type: SEQUENCE; Schema: public; Owner: civitai
--

CREATE SEQUENCE public."Import_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public."Import_id_seq" OWNER TO civitai;

--
-- Name: Import_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: civitai
--

ALTER SEQUENCE public."Import_id_seq" OWNED BY public."Import".id;


--
-- Name: JobQueue; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."JobQueue" (
    type public."JobQueueType" NOT NULL,
    "entityType" public."EntityType" NOT NULL,
    "entityId" integer NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


ALTER TABLE public."JobQueue" OWNER TO civitai;

--
-- Name: KeyValue; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."KeyValue" (
    key text NOT NULL,
    value jsonb NOT NULL
);


ALTER TABLE public."KeyValue" OWNER TO civitai;

--
-- Name: Leaderboard; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."Leaderboard" (
    id text NOT NULL,
    index integer NOT NULL,
    title text NOT NULL,
    description text NOT NULL,
    "scoringDescription" text NOT NULL,
    query text NOT NULL,
    active boolean NOT NULL,
    public boolean NOT NULL
);


ALTER TABLE public."Leaderboard" OWNER TO civitai;

--
-- Name: LeaderboardResult; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."LeaderboardResult" (
    "leaderboardId" text NOT NULL,
    date date NOT NULL,
    "position" integer NOT NULL,
    "userId" integer NOT NULL,
    score integer DEFAULT 0 NOT NULL,
    metrics jsonb DEFAULT '{}'::jsonb NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


ALTER TABLE public."LeaderboardResult" OWNER TO civitai;

--
-- Name: LegendsBoardResult; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."LegendsBoardResult" (
    "userId" integer,
    "leaderboardId" text,
    score numeric,
    metrics jsonb,
    "position" integer
);


ALTER TABLE public."LegendsBoardResult" OWNER TO civitai;

--
-- Name: License; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."License" (
    id integer NOT NULL,
    name text NOT NULL,
    url text NOT NULL
);


ALTER TABLE public."License" OWNER TO civitai;

--
-- Name: License_id_seq; Type: SEQUENCE; Schema: public; Owner: civitai
--

CREATE SEQUENCE public."License_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public."License_id_seq" OWNER TO civitai;

--
-- Name: License_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: civitai
--

ALTER SEQUENCE public."License_id_seq" OWNED BY public."License".id;


--
-- Name: Link; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."Link" (
    id integer NOT NULL,
    url text NOT NULL,
    type public."LinkType" NOT NULL,
    "entityId" integer NOT NULL,
    "entityType" text NOT NULL
);


ALTER TABLE public."Link" OWNER TO civitai;

--
-- Name: Link_id_seq; Type: SEQUENCE; Schema: public; Owner: civitai
--

CREATE SEQUENCE public."Link_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public."Link_id_seq" OWNER TO civitai;

--
-- Name: Link_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: civitai
--

ALTER SEQUENCE public."Link_id_seq" OWNED BY public."Link".id;


--
-- Name: Log; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."Log" (
    id text NOT NULL,
    event text NOT NULL,
    details jsonb,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


ALTER TABLE public."Log" OWNER TO civitai;

--
-- Name: MetricUpdateQueue; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."MetricUpdateQueue" (
    type text NOT NULL,
    id integer NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


ALTER TABLE public."MetricUpdateQueue" OWNER TO civitai;

--
-- Name: ModActivity; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."ModActivity" (
    id integer NOT NULL,
    "userId" integer,
    activity text NOT NULL,
    "entityType" text,
    "entityId" integer,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


ALTER TABLE public."ModActivity" OWNER TO civitai;

--
-- Name: ModActivity_id_seq; Type: SEQUENCE; Schema: public; Owner: civitai
--

CREATE SEQUENCE public."ModActivity_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public."ModActivity_id_seq" OWNER TO civitai;

--
-- Name: ModActivity_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: civitai
--

ALTER SEQUENCE public."ModActivity_id_seq" OWNED BY public."ModActivity".id;


--
-- Name: ModelAssociations; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."ModelAssociations" (
    "fromModelId" integer NOT NULL,
    "toModelId" integer,
    "associatedById" integer,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    type public."AssociationType" NOT NULL,
    index integer,
    id integer NOT NULL,
    "toArticleId" integer
);


ALTER TABLE public."ModelAssociations" OWNER TO civitai;

--
-- Name: ModelAssociations_id_seq; Type: SEQUENCE; Schema: public; Owner: civitai
--

CREATE SEQUENCE public."ModelAssociations_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public."ModelAssociations_id_seq" OWNER TO civitai;

--
-- Name: ModelAssociations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: civitai
--

ALTER SEQUENCE public."ModelAssociations_id_seq" OWNED BY public."ModelAssociations".id;


--
-- Name: ModelEngagement; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."ModelEngagement" (
    "userId" integer NOT NULL,
    "modelId" integer NOT NULL,
    type public."ModelEngagementType" NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


ALTER TABLE public."ModelEngagement" OWNER TO civitai;

--
-- Name: ModelFileHash; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."ModelFileHash" (
    type public."ModelHashType" NOT NULL,
    hash public.citext NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "fileId" integer NOT NULL
);


ALTER TABLE public."ModelFileHash" OWNER TO civitai;

--
-- Name: ModelFile_id_seq; Type: SEQUENCE; Schema: public; Owner: civitai
--

CREATE SEQUENCE public."ModelFile_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public."ModelFile_id_seq" OWNER TO civitai;

--
-- Name: ModelFile_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: civitai
--

ALTER SEQUENCE public."ModelFile_id_seq" OWNED BY public."ModelFile".id;


--
-- Name: ModelFlag; Type: TABLE; Schema: public; Owner: doadmin
--

CREATE TABLE public."ModelFlag" (
    "modelId" integer NOT NULL,
    minor boolean DEFAULT false NOT NULL,
    nsfw boolean DEFAULT false NOT NULL,
    poi boolean DEFAULT false NOT NULL,
    status public."ModelFlagStatus" DEFAULT 'Pending'::public."ModelFlagStatus" NOT NULL,
    "triggerWords" boolean DEFAULT false NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    details jsonb,
    "poiName" boolean DEFAULT false NOT NULL
);


ALTER TABLE public."ModelFlag" OWNER TO doadmin;

--
-- Name: ModelHash; Type: VIEW; Schema: public; Owner: civitai
--

CREATE VIEW public."ModelHash" AS
 SELECT m.id AS "modelId",
    mv.id AS "modelVersionId",
    mf.type AS "fileType",
    mh.type AS "hashType",
    mh.hash
   FROM (((public."Model" m
     JOIN public."ModelVersion" mv ON ((mv."modelId" = m.id)))
     JOIN public."ModelFile" mf ON ((mf."modelVersionId" = mv.id)))
     JOIN public."ModelFileHash" mh ON ((mh."fileId" = mf.id)))
  WHERE (mf.type = ANY (ARRAY['Model'::text, 'Pruned Model'::text]));


ALTER TABLE public."ModelHash" OWNER TO civitai;

--
-- Name: ModelInterest; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."ModelInterest" (
    "userId" integer NOT NULL,
    "modelId" integer NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


ALTER TABLE public."ModelInterest" OWNER TO civitai;

--
-- Name: ModelMetric; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."ModelMetric" (
    "modelId" integer NOT NULL,
    rating double precision DEFAULT 0 NOT NULL,
    "ratingCount" integer DEFAULT 0 NOT NULL,
    "downloadCount" integer DEFAULT 0 NOT NULL,
    timeframe public."MetricTimeframe" NOT NULL,
    "favoriteCount" integer DEFAULT 0 NOT NULL,
    "commentCount" integer DEFAULT 0 NOT NULL,
    "collectedCount" integer DEFAULT 0 NOT NULL,
    "imageCount" integer DEFAULT 0 NOT NULL,
    "tippedAmountCount" integer DEFAULT 0 NOT NULL,
    "tippedCount" integer DEFAULT 0 NOT NULL,
    "generationCount" integer DEFAULT 0 NOT NULL,
    "updatedAt" timestamp(3) without time zone DEFAULT now(),
    "thumbsDownCount" integer DEFAULT 0 NOT NULL,
    "thumbsUpCount" integer DEFAULT 0 NOT NULL
);


ALTER TABLE public."ModelMetric" OWNER TO civitai;

--
-- Name: ModelMetricDaily; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."ModelMetricDaily" (
    "modelId" integer NOT NULL,
    "modelVersionId" integer NOT NULL,
    type text NOT NULL,
    date date NOT NULL,
    count integer NOT NULL
);


ALTER TABLE public."ModelMetricDaily" OWNER TO civitai;

--
-- Name: ModelRank_Live; Type: VIEW; Schema: public; Owner: civitai
--

CREATE VIEW public."ModelRank_Live" AS
 WITH model_timeframe_stats AS (
         SELECT m.id AS "modelId",
            COALESCE(mm."downloadCount", 0) AS "downloadCount",
            row_number() OVER (PARTITION BY tf.timeframe ORDER BY COALESCE(mm."downloadCount", 0) DESC, COALESCE(mm.rating, (0)::double precision) DESC, COALESCE(mm."ratingCount", 0) DESC, m.id DESC) AS "downloadCountRank",
            COALESCE(mm."ratingCount", 0) AS "ratingCount",
            row_number() OVER (PARTITION BY tf.timeframe ORDER BY COALESCE(mm."ratingCount", 0) DESC, COALESCE(mm.rating, (0)::double precision) DESC, COALESCE(mm."downloadCount", 0) DESC, m.id DESC) AS "ratingCountRank",
            COALESCE(mm."favoriteCount", 0) AS "favoriteCount",
            row_number() OVER (PARTITION BY tf.timeframe ORDER BY COALESCE(mm."favoriteCount", 0) DESC, COALESCE(mm.rating, (0)::double precision) DESC, COALESCE(mm."downloadCount", 0) DESC, m.id DESC) AS "favoriteCountRank",
            COALESCE(mm."commentCount", 0) AS "commentCount",
            row_number() OVER (PARTITION BY tf.timeframe ORDER BY COALESCE(mm."commentCount", 0) DESC, COALESCE(mm.rating, (0)::double precision) DESC, COALESCE(mm."downloadCount", 0) DESC, m.id DESC) AS "commentCountRank",
            COALESCE(mm.rating, (0)::double precision) AS rating,
            row_number() OVER (PARTITION BY tf.timeframe ORDER BY (((COALESCE(mm.rating, (0)::double precision) * (COALESCE(mm."ratingCount", 0))::double precision) + ((3.5 * (10)::numeric))::double precision) / ((COALESCE(mm."ratingCount", 0) + 10))::double precision) DESC, COALESCE(mm."downloadCount", 0) DESC, m.id DESC) AS "ratingRank",
            row_number() OVER (ORDER BY GREATEST(m."lastVersionAt", m."publishedAt") DESC, m.id DESC) AS "newRank",
            COALESCE(date_part('day'::text, (now() - (m."publishedAt")::timestamp with time zone)), (0)::double precision) AS age_days,
            COALESCE(mm."imageCount", 0) AS "imageCount",
            row_number() OVER (PARTITION BY tf.timeframe ORDER BY COALESCE(mm."imageCount", 0) DESC, COALESCE(mm.rating, (0)::double precision) DESC, COALESCE(mm."downloadCount", 0) DESC, m.id DESC) AS "imageCountRank",
            COALESCE(mm."collectedCount", 0) AS "collectedCount",
            row_number() OVER (PARTITION BY tf.timeframe ORDER BY COALESCE(mm."collectedCount", 0) DESC, COALESCE(mm.rating, (0)::double precision) DESC, COALESCE(mm."downloadCount", 0) DESC, m.id DESC) AS "collectedCountRank",
            COALESCE(mm."tippedCount", 0) AS "tippedCount",
            row_number() OVER (PARTITION BY tf.timeframe ORDER BY COALESCE(mm."tippedCount", 0) DESC, COALESCE(mm.rating, (0)::double precision) DESC, COALESCE(mm."downloadCount", 0) DESC, m.id DESC) AS "tippedCountRank",
            COALESCE(mm."tippedAmountCount", 0) AS "tippedAmountCount",
            row_number() OVER (PARTITION BY tf.timeframe ORDER BY COALESCE(mm."tippedAmountCount", 0) DESC, COALESCE(mm.rating, (0)::double precision) DESC, COALESCE(mm."downloadCount", 0) DESC, m.id DESC) AS "tippedAmountCountRank",
            COALESCE(mm."generationCount", 0) AS "generationCount",
            row_number() OVER (PARTITION BY tf.timeframe ORDER BY COALESCE(mm."generationCount", 0) DESC, COALESCE(mm.rating, (0)::double precision) DESC, COALESCE(mm."downloadCount", 0) DESC, m.id DESC) AS "generationCountRank",
            tf.timeframe
           FROM ((public."Model" m
             CROSS JOIN ( SELECT unnest(enum_range(NULL::public."MetricTimeframe")) AS timeframe) tf)
             LEFT JOIN public."ModelMetric" mm ON (((mm."modelId" = m.id) AND (mm.timeframe = tf.timeframe))))
        )
 SELECT model_timeframe_stats."modelId",
    max(public.iif((model_timeframe_stats.timeframe = 'Day'::public."MetricTimeframe"), model_timeframe_stats."downloadCount", NULL::integer)) AS "downloadCountDay",
    max(public.iif((model_timeframe_stats.timeframe = 'Week'::public."MetricTimeframe"), model_timeframe_stats."downloadCount", NULL::integer)) AS "downloadCountWeek",
    max(public.iif((model_timeframe_stats.timeframe = 'Month'::public."MetricTimeframe"), model_timeframe_stats."downloadCount", NULL::integer)) AS "downloadCountMonth",
    max(public.iif((model_timeframe_stats.timeframe = 'Year'::public."MetricTimeframe"), model_timeframe_stats."downloadCount", NULL::integer)) AS "downloadCountYear",
    max(public.iif((model_timeframe_stats.timeframe = 'AllTime'::public."MetricTimeframe"), model_timeframe_stats."downloadCount", NULL::integer)) AS "downloadCountAllTime",
    max(public.iif((model_timeframe_stats.timeframe = 'Day'::public."MetricTimeframe"), model_timeframe_stats."downloadCountRank", NULL::bigint)) AS "downloadCountDayRank",
    max(public.iif((model_timeframe_stats.timeframe = 'Week'::public."MetricTimeframe"), model_timeframe_stats."downloadCountRank", NULL::bigint)) AS "downloadCountWeekRank",
    max(public.iif((model_timeframe_stats.timeframe = 'Month'::public."MetricTimeframe"), model_timeframe_stats."downloadCountRank", NULL::bigint)) AS "downloadCountMonthRank",
    max(public.iif((model_timeframe_stats.timeframe = 'Year'::public."MetricTimeframe"), model_timeframe_stats."downloadCountRank", NULL::bigint)) AS "downloadCountYearRank",
    max(public.iif((model_timeframe_stats.timeframe = 'AllTime'::public."MetricTimeframe"), model_timeframe_stats."downloadCountRank", NULL::bigint)) AS "downloadCountAllTimeRank",
    max(public.iif((model_timeframe_stats.timeframe = 'Day'::public."MetricTimeframe"), model_timeframe_stats."ratingCount", NULL::integer)) AS "ratingCountDay",
    max(public.iif((model_timeframe_stats.timeframe = 'Week'::public."MetricTimeframe"), model_timeframe_stats."ratingCount", NULL::integer)) AS "ratingCountWeek",
    max(public.iif((model_timeframe_stats.timeframe = 'Month'::public."MetricTimeframe"), model_timeframe_stats."ratingCount", NULL::integer)) AS "ratingCountMonth",
    max(public.iif((model_timeframe_stats.timeframe = 'Year'::public."MetricTimeframe"), model_timeframe_stats."ratingCount", NULL::integer)) AS "ratingCountYear",
    max(public.iif((model_timeframe_stats.timeframe = 'AllTime'::public."MetricTimeframe"), model_timeframe_stats."ratingCount", NULL::integer)) AS "ratingCountAllTime",
    max(public.iif((model_timeframe_stats.timeframe = 'Day'::public."MetricTimeframe"), model_timeframe_stats."ratingCountRank", NULL::bigint)) AS "ratingCountDayRank",
    max(public.iif((model_timeframe_stats.timeframe = 'Week'::public."MetricTimeframe"), model_timeframe_stats."ratingCountRank", NULL::bigint)) AS "ratingCountWeekRank",
    max(public.iif((model_timeframe_stats.timeframe = 'Month'::public."MetricTimeframe"), model_timeframe_stats."ratingCountRank", NULL::bigint)) AS "ratingCountMonthRank",
    max(public.iif((model_timeframe_stats.timeframe = 'Year'::public."MetricTimeframe"), model_timeframe_stats."ratingCountRank", NULL::bigint)) AS "ratingCountYearRank",
    max(public.iif((model_timeframe_stats.timeframe = 'AllTime'::public."MetricTimeframe"), model_timeframe_stats."ratingCountRank", NULL::bigint)) AS "ratingCountAllTimeRank",
    max(public.iif((model_timeframe_stats.timeframe = 'Day'::public."MetricTimeframe"), model_timeframe_stats.rating, NULL::double precision)) AS "ratingDay",
    max(public.iif((model_timeframe_stats.timeframe = 'Week'::public."MetricTimeframe"), model_timeframe_stats.rating, NULL::double precision)) AS "ratingWeek",
    max(public.iif((model_timeframe_stats.timeframe = 'Month'::public."MetricTimeframe"), model_timeframe_stats.rating, NULL::double precision)) AS "ratingMonth",
    max(public.iif((model_timeframe_stats.timeframe = 'Year'::public."MetricTimeframe"), model_timeframe_stats.rating, NULL::double precision)) AS "ratingYear",
    max(public.iif((model_timeframe_stats.timeframe = 'AllTime'::public."MetricTimeframe"), model_timeframe_stats.rating, NULL::double precision)) AS "ratingAllTime",
    max(public.iif((model_timeframe_stats.timeframe = 'Day'::public."MetricTimeframe"), model_timeframe_stats."ratingRank", NULL::bigint)) AS "ratingDayRank",
    max(public.iif((model_timeframe_stats.timeframe = 'Week'::public."MetricTimeframe"), model_timeframe_stats."ratingRank", NULL::bigint)) AS "ratingWeekRank",
    max(public.iif((model_timeframe_stats.timeframe = 'Month'::public."MetricTimeframe"), model_timeframe_stats."ratingRank", NULL::bigint)) AS "ratingMonthRank",
    max(public.iif((model_timeframe_stats.timeframe = 'Year'::public."MetricTimeframe"), model_timeframe_stats."ratingRank", NULL::bigint)) AS "ratingYearRank",
    max(public.iif((model_timeframe_stats.timeframe = 'AllTime'::public."MetricTimeframe"), model_timeframe_stats."ratingRank", NULL::bigint)) AS "ratingAllTimeRank",
    max(public.iif((model_timeframe_stats.timeframe = 'Day'::public."MetricTimeframe"), model_timeframe_stats."favoriteCount", NULL::integer)) AS "favoriteCountDay",
    max(public.iif((model_timeframe_stats.timeframe = 'Week'::public."MetricTimeframe"), model_timeframe_stats."favoriteCount", NULL::integer)) AS "favoriteCountWeek",
    max(public.iif((model_timeframe_stats.timeframe = 'Month'::public."MetricTimeframe"), model_timeframe_stats."favoriteCount", NULL::integer)) AS "favoriteCountMonth",
    max(public.iif((model_timeframe_stats.timeframe = 'Year'::public."MetricTimeframe"), model_timeframe_stats."favoriteCount", NULL::integer)) AS "favoriteCountYear",
    max(public.iif((model_timeframe_stats.timeframe = 'AllTime'::public."MetricTimeframe"), model_timeframe_stats."favoriteCount", NULL::integer)) AS "favoriteCountAllTime",
    max(public.iif((model_timeframe_stats.timeframe = 'Day'::public."MetricTimeframe"), model_timeframe_stats."favoriteCountRank", NULL::bigint)) AS "favoriteCountDayRank",
    max(public.iif((model_timeframe_stats.timeframe = 'Week'::public."MetricTimeframe"), model_timeframe_stats."favoriteCountRank", NULL::bigint)) AS "favoriteCountWeekRank",
    max(public.iif((model_timeframe_stats.timeframe = 'Month'::public."MetricTimeframe"), model_timeframe_stats."favoriteCountRank", NULL::bigint)) AS "favoriteCountMonthRank",
    max(public.iif((model_timeframe_stats.timeframe = 'Year'::public."MetricTimeframe"), model_timeframe_stats."favoriteCountRank", NULL::bigint)) AS "favoriteCountYearRank",
    max(public.iif((model_timeframe_stats.timeframe = 'AllTime'::public."MetricTimeframe"), model_timeframe_stats."favoriteCountRank", NULL::bigint)) AS "favoriteCountAllTimeRank",
    max(public.iif((model_timeframe_stats.timeframe = 'Day'::public."MetricTimeframe"), model_timeframe_stats."commentCount", NULL::integer)) AS "commentCountDay",
    max(public.iif((model_timeframe_stats.timeframe = 'Week'::public."MetricTimeframe"), model_timeframe_stats."commentCount", NULL::integer)) AS "commentCountWeek",
    max(public.iif((model_timeframe_stats.timeframe = 'Month'::public."MetricTimeframe"), model_timeframe_stats."commentCount", NULL::integer)) AS "commentCountMonth",
    max(public.iif((model_timeframe_stats.timeframe = 'Year'::public."MetricTimeframe"), model_timeframe_stats."commentCount", NULL::integer)) AS "commentCountYear",
    max(public.iif((model_timeframe_stats.timeframe = 'AllTime'::public."MetricTimeframe"), model_timeframe_stats."commentCount", NULL::integer)) AS "commentCountAllTime",
    max(public.iif((model_timeframe_stats.timeframe = 'Day'::public."MetricTimeframe"), model_timeframe_stats."commentCountRank", NULL::bigint)) AS "commentCountDayRank",
    max(public.iif((model_timeframe_stats.timeframe = 'Week'::public."MetricTimeframe"), model_timeframe_stats."commentCountRank", NULL::bigint)) AS "commentCountWeekRank",
    max(public.iif((model_timeframe_stats.timeframe = 'Month'::public."MetricTimeframe"), model_timeframe_stats."commentCountRank", NULL::bigint)) AS "commentCountMonthRank",
    max(public.iif((model_timeframe_stats.timeframe = 'Year'::public."MetricTimeframe"), model_timeframe_stats."commentCountRank", NULL::bigint)) AS "commentCountYearRank",
    max(public.iif((model_timeframe_stats.timeframe = 'AllTime'::public."MetricTimeframe"), model_timeframe_stats."commentCountRank", NULL::bigint)) AS "commentCountAllTimeRank",
    max(public.iif((model_timeframe_stats.timeframe = 'Day'::public."MetricTimeframe"), model_timeframe_stats."imageCount", NULL::integer)) AS "imageCountDay",
    max(public.iif((model_timeframe_stats.timeframe = 'Week'::public."MetricTimeframe"), model_timeframe_stats."imageCount", NULL::integer)) AS "imageCountWeek",
    max(public.iif((model_timeframe_stats.timeframe = 'Month'::public."MetricTimeframe"), model_timeframe_stats."imageCount", NULL::integer)) AS "imageCountMonth",
    max(public.iif((model_timeframe_stats.timeframe = 'Year'::public."MetricTimeframe"), model_timeframe_stats."imageCount", NULL::integer)) AS "imageCountYear",
    max(public.iif((model_timeframe_stats.timeframe = 'AllTime'::public."MetricTimeframe"), model_timeframe_stats."imageCount", NULL::integer)) AS "imageCountAllTime",
    max(public.iif((model_timeframe_stats.timeframe = 'Day'::public."MetricTimeframe"), model_timeframe_stats."imageCountRank", NULL::bigint)) AS "imageCountDayRank",
    max(public.iif((model_timeframe_stats.timeframe = 'Week'::public."MetricTimeframe"), model_timeframe_stats."imageCountRank", NULL::bigint)) AS "imageCountWeekRank",
    max(public.iif((model_timeframe_stats.timeframe = 'Month'::public."MetricTimeframe"), model_timeframe_stats."imageCountRank", NULL::bigint)) AS "imageCountMonthRank",
    max(public.iif((model_timeframe_stats.timeframe = 'Year'::public."MetricTimeframe"), model_timeframe_stats."imageCountRank", NULL::bigint)) AS "imageCountYearRank",
    max(public.iif((model_timeframe_stats.timeframe = 'AllTime'::public."MetricTimeframe"), model_timeframe_stats."imageCountRank", NULL::bigint)) AS "imageCountAllTimeRank",
    max(public.iif((model_timeframe_stats.timeframe = 'Day'::public."MetricTimeframe"), model_timeframe_stats."collectedCount", NULL::integer)) AS "collectedCountDay",
    max(public.iif((model_timeframe_stats.timeframe = 'Week'::public."MetricTimeframe"), model_timeframe_stats."collectedCount", NULL::integer)) AS "collectedCountWeek",
    max(public.iif((model_timeframe_stats.timeframe = 'Month'::public."MetricTimeframe"), model_timeframe_stats."collectedCount", NULL::integer)) AS "collectedCountMonth",
    max(public.iif((model_timeframe_stats.timeframe = 'Year'::public."MetricTimeframe"), model_timeframe_stats."collectedCount", NULL::integer)) AS "collectedCountYear",
    max(public.iif((model_timeframe_stats.timeframe = 'AllTime'::public."MetricTimeframe"), model_timeframe_stats."collectedCount", NULL::integer)) AS "collectedCountAllTime",
    max(public.iif((model_timeframe_stats.timeframe = 'Day'::public."MetricTimeframe"), model_timeframe_stats."collectedCountRank", NULL::bigint)) AS "collectedCountDayRank",
    max(public.iif((model_timeframe_stats.timeframe = 'Week'::public."MetricTimeframe"), model_timeframe_stats."collectedCountRank", NULL::bigint)) AS "collectedCountWeekRank",
    max(public.iif((model_timeframe_stats.timeframe = 'Month'::public."MetricTimeframe"), model_timeframe_stats."collectedCountRank", NULL::bigint)) AS "collectedCountMonthRank",
    max(public.iif((model_timeframe_stats.timeframe = 'Year'::public."MetricTimeframe"), model_timeframe_stats."collectedCountRank", NULL::bigint)) AS "collectedCountYearRank",
    max(public.iif((model_timeframe_stats.timeframe = 'AllTime'::public."MetricTimeframe"), model_timeframe_stats."collectedCountRank", NULL::bigint)) AS "collectedCountAllTimeRank",
    max(public.iif((model_timeframe_stats.timeframe = 'AllTime'::public."MetricTimeframe"), model_timeframe_stats."newRank", NULL::bigint)) AS "newRank",
    max(model_timeframe_stats.age_days) AS age_days,
    max(public.iif((model_timeframe_stats.timeframe = 'Day'::public."MetricTimeframe"), model_timeframe_stats."tippedCount", NULL::integer)) AS "tippedCountDay",
    max(public.iif((model_timeframe_stats.timeframe = 'Week'::public."MetricTimeframe"), model_timeframe_stats."tippedCount", NULL::integer)) AS "tippedCountWeek",
    max(public.iif((model_timeframe_stats.timeframe = 'Month'::public."MetricTimeframe"), model_timeframe_stats."tippedCount", NULL::integer)) AS "tippedCountMonth",
    max(public.iif((model_timeframe_stats.timeframe = 'Year'::public."MetricTimeframe"), model_timeframe_stats."tippedCount", NULL::integer)) AS "tippedCountYear",
    max(public.iif((model_timeframe_stats.timeframe = 'AllTime'::public."MetricTimeframe"), model_timeframe_stats."tippedCount", NULL::integer)) AS "tippedCountAllTime",
    max(public.iif((model_timeframe_stats.timeframe = 'Day'::public."MetricTimeframe"), model_timeframe_stats."tippedCountRank", NULL::bigint)) AS "tippedCountDayRank",
    max(public.iif((model_timeframe_stats.timeframe = 'Week'::public."MetricTimeframe"), model_timeframe_stats."tippedCountRank", NULL::bigint)) AS "tippedCountWeekRank",
    max(public.iif((model_timeframe_stats.timeframe = 'Month'::public."MetricTimeframe"), model_timeframe_stats."tippedCountRank", NULL::bigint)) AS "tippedCountMonthRank",
    max(public.iif((model_timeframe_stats.timeframe = 'Year'::public."MetricTimeframe"), model_timeframe_stats."tippedCountRank", NULL::bigint)) AS "tippedCountYearRank",
    max(public.iif((model_timeframe_stats.timeframe = 'AllTime'::public."MetricTimeframe"), model_timeframe_stats."tippedCountRank", NULL::bigint)) AS "tippedCountAllTimeRank",
    max(public.iif((model_timeframe_stats.timeframe = 'Day'::public."MetricTimeframe"), model_timeframe_stats."tippedAmountCount", NULL::integer)) AS "tippedAmountCountDay",
    max(public.iif((model_timeframe_stats.timeframe = 'Week'::public."MetricTimeframe"), model_timeframe_stats."tippedAmountCount", NULL::integer)) AS "tippedAmountCountWeek",
    max(public.iif((model_timeframe_stats.timeframe = 'Month'::public."MetricTimeframe"), model_timeframe_stats."tippedAmountCount", NULL::integer)) AS "tippedAmountCountMonth",
    max(public.iif((model_timeframe_stats.timeframe = 'Year'::public."MetricTimeframe"), model_timeframe_stats."tippedAmountCount", NULL::integer)) AS "tippedAmountCountYear",
    max(public.iif((model_timeframe_stats.timeframe = 'AllTime'::public."MetricTimeframe"), model_timeframe_stats."tippedAmountCount", NULL::integer)) AS "tippedAmountCountAllTime",
    max(public.iif((model_timeframe_stats.timeframe = 'Day'::public."MetricTimeframe"), model_timeframe_stats."tippedAmountCountRank", NULL::bigint)) AS "tippedAmountCountDayRank",
    max(public.iif((model_timeframe_stats.timeframe = 'Week'::public."MetricTimeframe"), model_timeframe_stats."tippedAmountCountRank", NULL::bigint)) AS "tippedAmountCountWeekRank",
    max(public.iif((model_timeframe_stats.timeframe = 'Month'::public."MetricTimeframe"), model_timeframe_stats."tippedAmountCountRank", NULL::bigint)) AS "tippedAmountCountMonthRank",
    max(public.iif((model_timeframe_stats.timeframe = 'Year'::public."MetricTimeframe"), model_timeframe_stats."tippedAmountCountRank", NULL::bigint)) AS "tippedAmountCountYearRank",
    max(public.iif((model_timeframe_stats.timeframe = 'AllTime'::public."MetricTimeframe"), model_timeframe_stats."tippedAmountCountRank", NULL::bigint)) AS "tippedAmountCountAllTimeRank",
    max(public.iif((model_timeframe_stats.timeframe = 'Day'::public."MetricTimeframe"), model_timeframe_stats."generationCountRank", NULL::bigint)) AS "generationCountDayRank",
    max(public.iif((model_timeframe_stats.timeframe = 'Week'::public."MetricTimeframe"), model_timeframe_stats."generationCountRank", NULL::bigint)) AS "generationCountWeekRank",
    max(public.iif((model_timeframe_stats.timeframe = 'Month'::public."MetricTimeframe"), model_timeframe_stats."generationCountRank", NULL::bigint)) AS "generationCountMonthRank",
    max(public.iif((model_timeframe_stats.timeframe = 'Year'::public."MetricTimeframe"), model_timeframe_stats."generationCountRank", NULL::bigint)) AS "generationCountYearRank",
    max(public.iif((model_timeframe_stats.timeframe = 'AllTime'::public."MetricTimeframe"), model_timeframe_stats."generationCountRank", NULL::bigint)) AS "generationCountAllTimeRank",
    max(public.iif((model_timeframe_stats.timeframe = 'Day'::public."MetricTimeframe"), model_timeframe_stats."generationCount", NULL::integer)) AS "generationCountDay",
    max(public.iif((model_timeframe_stats.timeframe = 'Week'::public."MetricTimeframe"), model_timeframe_stats."generationCount", NULL::integer)) AS "generationCountWeek",
    max(public.iif((model_timeframe_stats.timeframe = 'Month'::public."MetricTimeframe"), model_timeframe_stats."generationCount", NULL::integer)) AS "generationCountMonth",
    max(public.iif((model_timeframe_stats.timeframe = 'Year'::public."MetricTimeframe"), model_timeframe_stats."generationCount", NULL::integer)) AS "generationCountYear",
    max(public.iif((model_timeframe_stats.timeframe = 'AllTime'::public."MetricTimeframe"), model_timeframe_stats."generationCount", NULL::integer)) AS "generationCountAllTime"
   FROM model_timeframe_stats
  GROUP BY model_timeframe_stats."modelId";


ALTER TABLE public."ModelRank_Live" OWNER TO civitai;

--
-- Name: ModelRank_New; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."ModelRank_New" (
    "modelId" integer NOT NULL,
    "downloadCountDay" integer,
    "downloadCountWeek" integer,
    "downloadCountMonth" integer,
    "downloadCountYear" integer,
    "downloadCountAllTime" integer,
    "downloadCountDayRank" bigint,
    "downloadCountWeekRank" bigint,
    "downloadCountMonthRank" bigint,
    "downloadCountYearRank" bigint,
    "downloadCountAllTimeRank" bigint,
    "ratingCountDay" integer,
    "ratingCountWeek" integer,
    "ratingCountMonth" integer,
    "ratingCountYear" integer,
    "ratingCountAllTime" integer,
    "ratingCountDayRank" bigint,
    "ratingCountWeekRank" bigint,
    "ratingCountMonthRank" bigint,
    "ratingCountYearRank" bigint,
    "ratingCountAllTimeRank" bigint,
    "ratingDay" double precision,
    "ratingWeek" double precision,
    "ratingMonth" double precision,
    "ratingYear" double precision,
    "ratingAllTime" double precision,
    "ratingDayRank" bigint,
    "ratingWeekRank" bigint,
    "ratingMonthRank" bigint,
    "ratingYearRank" bigint,
    "ratingAllTimeRank" bigint,
    "favoriteCountDay" integer,
    "favoriteCountWeek" integer,
    "favoriteCountMonth" integer,
    "favoriteCountYear" integer,
    "favoriteCountAllTime" integer,
    "favoriteCountDayRank" bigint,
    "favoriteCountWeekRank" bigint,
    "favoriteCountMonthRank" bigint,
    "favoriteCountYearRank" bigint,
    "favoriteCountAllTimeRank" bigint,
    "commentCountDay" integer,
    "commentCountWeek" integer,
    "commentCountMonth" integer,
    "commentCountYear" integer,
    "commentCountAllTime" integer,
    "commentCountDayRank" bigint,
    "commentCountWeekRank" bigint,
    "commentCountMonthRank" bigint,
    "commentCountYearRank" bigint,
    "commentCountAllTimeRank" bigint,
    "imageCountDay" integer,
    "imageCountWeek" integer,
    "imageCountMonth" integer,
    "imageCountYear" integer,
    "imageCountAllTime" integer,
    "imageCountDayRank" bigint,
    "imageCountWeekRank" bigint,
    "imageCountMonthRank" bigint,
    "imageCountYearRank" bigint,
    "imageCountAllTimeRank" bigint,
    "collectedCountDay" integer,
    "collectedCountWeek" integer,
    "collectedCountMonth" integer,
    "collectedCountYear" integer,
    "collectedCountAllTime" integer,
    "collectedCountDayRank" bigint,
    "collectedCountWeekRank" bigint,
    "collectedCountMonthRank" bigint,
    "collectedCountYearRank" bigint,
    "collectedCountAllTimeRank" bigint,
    "newRank" bigint,
    age_days double precision,
    "tippedCountDay" integer,
    "tippedCountWeek" integer,
    "tippedCountMonth" integer,
    "tippedCountYear" integer,
    "tippedCountAllTime" integer,
    "tippedCountDayRank" bigint,
    "tippedCountWeekRank" bigint,
    "tippedCountMonthRank" bigint,
    "tippedCountYearRank" bigint,
    "tippedCountAllTimeRank" bigint,
    "tippedAmountCountDay" integer,
    "tippedAmountCountWeek" integer,
    "tippedAmountCountMonth" integer,
    "tippedAmountCountYear" integer,
    "tippedAmountCountAllTime" integer,
    "tippedAmountCountDayRank" bigint,
    "tippedAmountCountWeekRank" bigint,
    "tippedAmountCountMonthRank" bigint,
    "tippedAmountCountYearRank" bigint,
    "tippedAmountCountAllTimeRank" bigint,
    "generationCountDayRank" bigint,
    "generationCountWeekRank" bigint,
    "generationCountMonthRank" bigint,
    "generationCountYearRank" bigint,
    "generationCountAllTimeRank" bigint,
    "generationCountDay" integer,
    "generationCountWeek" integer,
    "generationCountMonth" integer,
    "generationCountYear" integer,
    "generationCountAllTime" integer
);


ALTER TABLE public."ModelRank_New" OWNER TO civitai;

--
-- Name: ModelReport; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."ModelReport" (
    "modelId" integer NOT NULL,
    "reportId" integer NOT NULL
);


ALTER TABLE public."ModelReport" OWNER TO civitai;

--
-- Name: ModelReportStat; Type: VIEW; Schema: public; Owner: civitai
--

CREATE VIEW public."ModelReportStat" AS
 SELECT m.id AS "modelId",
    sum(public.iif(((r.reason = 'TOSViolation'::public."ReportReason") AND (r.status = 'Pending'::public."ReportStatus")), 1, 0)) AS "tosViolationPending",
    sum(public.iif(((r.reason = 'TOSViolation'::public."ReportReason") AND (r.status = 'Actioned'::public."ReportStatus")), 1, 0)) AS "tosViolationActioned",
    sum(public.iif(((r.reason = 'TOSViolation'::public."ReportReason") AND (r.status = 'Unactioned'::public."ReportStatus")), 1, 0)) AS "tosViolationUnactioned",
    sum(public.iif(((r.reason = 'NSFW'::public."ReportReason") AND (r.status = 'Pending'::public."ReportStatus")), 1, 0)) AS "nsfwPending",
    sum(public.iif(((r.reason = 'NSFW'::public."ReportReason") AND (r.status = 'Actioned'::public."ReportStatus")), 1, 0)) AS "nsfwActioned",
    sum(public.iif(((r.reason = 'NSFW'::public."ReportReason") AND (r.status = 'Unactioned'::public."ReportStatus")), 1, 0)) AS "nsfwUnactioned",
    sum(public.iif(((r.reason = 'Ownership'::public."ReportReason") AND (r.status = 'Pending'::public."ReportStatus")), 1, 0)) AS "ownershipPending",
    sum(public.iif(((r.reason = 'Ownership'::public."ReportReason") AND (r.status = 'Processing'::public."ReportStatus")), 1, 0)) AS "ownershipProcessing",
    sum(public.iif(((r.reason = 'Ownership'::public."ReportReason") AND (r.status = 'Actioned'::public."ReportStatus")), 1, 0)) AS "ownershipActioned",
    sum(public.iif(((r.reason = 'Ownership'::public."ReportReason") AND (r.status = 'Unactioned'::public."ReportStatus")), 1, 0)) AS "ownershipUnactioned",
    sum(public.iif(((r.reason = 'AdminAttention'::public."ReportReason") AND (r.status = 'Pending'::public."ReportStatus")), 1, 0)) AS "adminAttentionPending",
    sum(public.iif(((r.reason = 'AdminAttention'::public."ReportReason") AND (r.status = 'Actioned'::public."ReportStatus")), 1, 0)) AS "adminAttentionActioned",
    sum(public.iif(((r.reason = 'AdminAttention'::public."ReportReason") AND (r.status = 'Unactioned'::public."ReportStatus")), 1, 0)) AS "adminAttentionUnactioned",
    sum(public.iif(((r.reason = 'Claim'::public."ReportReason") AND (r.status = 'Pending'::public."ReportStatus")), 1, 0)) AS "claimPending",
    sum(public.iif(((r.reason = 'Claim'::public."ReportReason") AND (r.status = 'Actioned'::public."ReportStatus")), 1, 0)) AS "claimActioned",
    sum(public.iif(((r.reason = 'Claim'::public."ReportReason") AND (r.status = 'Unactioned'::public."ReportStatus")), 1, 0)) AS "claimUnactioned"
   FROM ((public."Model" m
     LEFT JOIN public."ModelReport" mr ON ((mr."modelId" = m.id)))
     JOIN public."Report" r ON ((r.id = mr."reportId")))
  GROUP BY m.id;


ALTER TABLE public."ModelReportStat" OWNER TO civitai;

--
-- Name: TagsOnModels; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."TagsOnModels" (
    "modelId" integer NOT NULL,
    "tagId" integer NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


ALTER TABLE public."TagsOnModels" OWNER TO civitai;

--
-- Name: TagsOnModelsVote; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."TagsOnModelsVote" (
    "modelId" integer NOT NULL,
    "tagId" integer NOT NULL,
    "userId" integer NOT NULL,
    vote integer NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


ALTER TABLE public."TagsOnModelsVote" OWNER TO civitai;

--
-- Name: ModelTag; Type: VIEW; Schema: public; Owner: civitai
--

CREATE VIEW public."ModelTag" AS
 WITH model_tags AS (
         SELECT "TagsOnModels"."modelId",
            "TagsOnModels"."tagId",
            5 AS score,
            1 AS "upVotes",
            0 AS "downVotes"
           FROM public."TagsOnModels"
        UNION
         SELECT "TagsOnModelsVote"."modelId",
            "TagsOnModelsVote"."tagId",
            sum("TagsOnModelsVote".vote) AS score,
            sum(public.iif(("TagsOnModelsVote".vote > 0), 1, 0)) AS "upVotes",
            sum(public.iif(("TagsOnModelsVote".vote < 0), 1, 0)) AS "downVotes"
           FROM public."TagsOnModelsVote"
          GROUP BY "TagsOnModelsVote"."tagId", "TagsOnModelsVote"."modelId"
        )
 SELECT mt."modelId",
    mt."tagId",
    sum(mt.score) AS score,
    sum(mt."upVotes") AS "upVotes",
    sum(mt."downVotes") AS "downVotes",
    t.name AS "tagName",
    t.type AS "tagType"
   FROM (model_tags mt
     JOIN public."Tag" t ON ((t.id = mt."tagId")))
  GROUP BY mt."modelId", mt."tagId", t.name, t.type;


ALTER TABLE public."ModelTag" OWNER TO civitai;

--
-- Name: ModelVersionEngagement; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."ModelVersionEngagement" (
    "userId" integer NOT NULL,
    "modelVersionId" integer NOT NULL,
    type public."ModelVersionEngagementType" NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


ALTER TABLE public."ModelVersionEngagement" OWNER TO civitai;

--
-- Name: ModelVersionExploration; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."ModelVersionExploration" (
    index integer NOT NULL,
    name text NOT NULL,
    prompt text NOT NULL,
    "modelVersionId" integer NOT NULL
);


ALTER TABLE public."ModelVersionExploration" OWNER TO civitai;

--
-- Name: ModelVersionMonetization; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."ModelVersionMonetization" (
    id integer NOT NULL,
    "modelVersionId" integer NOT NULL,
    type public."ModelVersionMonetizationType" DEFAULT 'PaidAccess'::public."ModelVersionMonetizationType" NOT NULL,
    "unitAmount" integer,
    currency public."Currency" DEFAULT 'BUZZ'::public."Currency" NOT NULL
);


ALTER TABLE public."ModelVersionMonetization" OWNER TO civitai;

--
-- Name: ModelVersionMonetization_id_seq; Type: SEQUENCE; Schema: public; Owner: civitai
--

CREATE SEQUENCE public."ModelVersionMonetization_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public."ModelVersionMonetization_id_seq" OWNER TO civitai;

--
-- Name: ModelVersionMonetization_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: civitai
--

ALTER SEQUENCE public."ModelVersionMonetization_id_seq" OWNED BY public."ModelVersionMonetization".id;


--
-- Name: ModelVersionRank; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."ModelVersionRank" (
    "modelVersionId" integer NOT NULL,
    "downloadCountDay" integer,
    "downloadCountWeek" integer,
    "downloadCountMonth" integer,
    "downloadCountYear" integer,
    "downloadCountAllTime" integer,
    "downloadCountDayRank" bigint,
    "downloadCountWeekRank" bigint,
    "downloadCountMonthRank" bigint,
    "downloadCountYearRank" bigint,
    "downloadCountAllTimeRank" bigint,
    "ratingCountDay" integer,
    "ratingCountWeek" integer,
    "ratingCountMonth" integer,
    "ratingCountYear" integer,
    "ratingCountAllTime" integer,
    "ratingCountDayRank" bigint,
    "ratingCountWeekRank" bigint,
    "ratingCountMonthRank" bigint,
    "ratingCountYearRank" bigint,
    "ratingCountAllTimeRank" bigint,
    "ratingDay" double precision,
    "ratingWeek" double precision,
    "ratingMonth" double precision,
    "ratingYear" double precision,
    "ratingAllTime" double precision,
    "ratingDayRank" bigint,
    "ratingWeekRank" bigint,
    "ratingMonthRank" bigint,
    "ratingYearRank" bigint,
    "ratingAllTimeRank" bigint,
    "imageCountDay" integer,
    "imageCountWeek" integer,
    "imageCountMonth" integer,
    "imageCountYear" integer,
    "imageCountAllTime" integer,
    "imageCountDayRank" bigint,
    "imageCountWeekRank" bigint,
    "imageCountMonthRank" bigint,
    "imageCountYearRank" bigint,
    "imageCountAllTimeRank" bigint,
    "generationCountDay" integer,
    "generationCountWeek" integer,
    "generationCountMonth" integer,
    "generationCountYear" integer,
    "generationCountAllTime" integer,
    "generationCountDayRank" bigint,
    "generationCountWeekRank" bigint,
    "generationCountMonthRank" bigint,
    "generationCountYearRank" bigint,
    "generationCountAllTimeRank" bigint
);


ALTER TABLE public."ModelVersionRank" OWNER TO civitai;

--
-- Name: ModelVersionRank_Live; Type: VIEW; Schema: public; Owner: civitai
--

CREATE VIEW public."ModelVersionRank_Live" AS
 SELECT t."modelVersionId",
    max(public.iif((t.timeframe = 'Day'::public."MetricTimeframe"), t."downloadCount", NULL::integer)) AS "downloadCountDay",
    max(public.iif((t.timeframe = 'Week'::public."MetricTimeframe"), t."downloadCount", NULL::integer)) AS "downloadCountWeek",
    max(public.iif((t.timeframe = 'Month'::public."MetricTimeframe"), t."downloadCount", NULL::integer)) AS "downloadCountMonth",
    max(public.iif((t.timeframe = 'Year'::public."MetricTimeframe"), t."downloadCount", NULL::integer)) AS "downloadCountYear",
    max(public.iif((t.timeframe = 'AllTime'::public."MetricTimeframe"), t."downloadCount", NULL::integer)) AS "downloadCountAllTime",
    max(public.iif((t.timeframe = 'Day'::public."MetricTimeframe"), t."downloadCountRank", NULL::bigint)) AS "downloadCountDayRank",
    max(public.iif((t.timeframe = 'Week'::public."MetricTimeframe"), t."downloadCountRank", NULL::bigint)) AS "downloadCountWeekRank",
    max(public.iif((t.timeframe = 'Month'::public."MetricTimeframe"), t."downloadCountRank", NULL::bigint)) AS "downloadCountMonthRank",
    max(public.iif((t.timeframe = 'Year'::public."MetricTimeframe"), t."downloadCountRank", NULL::bigint)) AS "downloadCountYearRank",
    max(public.iif((t.timeframe = 'AllTime'::public."MetricTimeframe"), t."downloadCountRank", NULL::bigint)) AS "downloadCountAllTimeRank",
    max(public.iif((t.timeframe = 'Day'::public."MetricTimeframe"), t."ratingCount", NULL::integer)) AS "ratingCountDay",
    max(public.iif((t.timeframe = 'Week'::public."MetricTimeframe"), t."ratingCount", NULL::integer)) AS "ratingCountWeek",
    max(public.iif((t.timeframe = 'Month'::public."MetricTimeframe"), t."ratingCount", NULL::integer)) AS "ratingCountMonth",
    max(public.iif((t.timeframe = 'Year'::public."MetricTimeframe"), t."ratingCount", NULL::integer)) AS "ratingCountYear",
    max(public.iif((t.timeframe = 'AllTime'::public."MetricTimeframe"), t."ratingCount", NULL::integer)) AS "ratingCountAllTime",
    max(public.iif((t.timeframe = 'Day'::public."MetricTimeframe"), t."ratingCountRank", NULL::bigint)) AS "ratingCountDayRank",
    max(public.iif((t.timeframe = 'Week'::public."MetricTimeframe"), t."ratingCountRank", NULL::bigint)) AS "ratingCountWeekRank",
    max(public.iif((t.timeframe = 'Month'::public."MetricTimeframe"), t."ratingCountRank", NULL::bigint)) AS "ratingCountMonthRank",
    max(public.iif((t.timeframe = 'Year'::public."MetricTimeframe"), t."ratingCountRank", NULL::bigint)) AS "ratingCountYearRank",
    max(public.iif((t.timeframe = 'AllTime'::public."MetricTimeframe"), t."ratingCountRank", NULL::bigint)) AS "ratingCountAllTimeRank",
    max(public.iif((t.timeframe = 'Day'::public."MetricTimeframe"), t.rating, NULL::double precision)) AS "ratingDay",
    max(public.iif((t.timeframe = 'Week'::public."MetricTimeframe"), t.rating, NULL::double precision)) AS "ratingWeek",
    max(public.iif((t.timeframe = 'Month'::public."MetricTimeframe"), t.rating, NULL::double precision)) AS "ratingMonth",
    max(public.iif((t.timeframe = 'Year'::public."MetricTimeframe"), t.rating, NULL::double precision)) AS "ratingYear",
    max(public.iif((t.timeframe = 'AllTime'::public."MetricTimeframe"), t.rating, NULL::double precision)) AS "ratingAllTime",
    max(public.iif((t.timeframe = 'Day'::public."MetricTimeframe"), t."ratingRank", NULL::bigint)) AS "ratingDayRank",
    max(public.iif((t.timeframe = 'Week'::public."MetricTimeframe"), t."ratingRank", NULL::bigint)) AS "ratingWeekRank",
    max(public.iif((t.timeframe = 'Month'::public."MetricTimeframe"), t."ratingRank", NULL::bigint)) AS "ratingMonthRank",
    max(public.iif((t.timeframe = 'Year'::public."MetricTimeframe"), t."ratingRank", NULL::bigint)) AS "ratingYearRank",
    max(public.iif((t.timeframe = 'AllTime'::public."MetricTimeframe"), t."ratingRank", NULL::bigint)) AS "ratingAllTimeRank",
    max(public.iif((t.timeframe = 'Day'::public."MetricTimeframe"), t."imageCount", NULL::integer)) AS "imageCountDay",
    max(public.iif((t.timeframe = 'Week'::public."MetricTimeframe"), t."imageCount", NULL::integer)) AS "imageCountWeek",
    max(public.iif((t.timeframe = 'Month'::public."MetricTimeframe"), t."imageCount", NULL::integer)) AS "imageCountMonth",
    max(public.iif((t.timeframe = 'Year'::public."MetricTimeframe"), t."imageCount", NULL::integer)) AS "imageCountYear",
    max(public.iif((t.timeframe = 'AllTime'::public."MetricTimeframe"), t."imageCount", NULL::integer)) AS "imageCountAllTime",
    max(public.iif((t.timeframe = 'Day'::public."MetricTimeframe"), t."imageCountRank", NULL::bigint)) AS "imageCountDayRank",
    max(public.iif((t.timeframe = 'Week'::public."MetricTimeframe"), t."imageCountRank", NULL::bigint)) AS "imageCountWeekRank",
    max(public.iif((t.timeframe = 'Month'::public."MetricTimeframe"), t."imageCountRank", NULL::bigint)) AS "imageCountMonthRank",
    max(public.iif((t.timeframe = 'Year'::public."MetricTimeframe"), t."imageCountRank", NULL::bigint)) AS "imageCountYearRank",
    max(public.iif((t.timeframe = 'AllTime'::public."MetricTimeframe"), t."imageCountRank", NULL::bigint)) AS "imageCountAllTimeRank",
    max(public.iif((t.timeframe = 'Day'::public."MetricTimeframe"), t."generationCount", NULL::integer)) AS "generationCountDay",
    max(public.iif((t.timeframe = 'Week'::public."MetricTimeframe"), t."generationCount", NULL::integer)) AS "generationCountWeek",
    max(public.iif((t.timeframe = 'Month'::public."MetricTimeframe"), t."generationCount", NULL::integer)) AS "generationCountMonth",
    max(public.iif((t.timeframe = 'Year'::public."MetricTimeframe"), t."generationCount", NULL::integer)) AS "generationCountYear",
    max(public.iif((t.timeframe = 'AllTime'::public."MetricTimeframe"), t."generationCount", NULL::integer)) AS "generationCountAllTime",
    max(public.iif((t.timeframe = 'Day'::public."MetricTimeframe"), t."generationCountRank", NULL::bigint)) AS "generationCountDayRank",
    max(public.iif((t.timeframe = 'Week'::public."MetricTimeframe"), t."generationCountRank", NULL::bigint)) AS "generationCountWeekRank",
    max(public.iif((t.timeframe = 'Month'::public."MetricTimeframe"), t."generationCountRank", NULL::bigint)) AS "generationCountMonthRank",
    max(public.iif((t.timeframe = 'Year'::public."MetricTimeframe"), t."generationCountRank", NULL::bigint)) AS "generationCountYearRank",
    max(public.iif((t.timeframe = 'AllTime'::public."MetricTimeframe"), t."generationCountRank", NULL::bigint)) AS "generationCountAllTimeRank"
   FROM ( SELECT m.id AS "modelVersionId",
            COALESCE(mm."downloadCount", 0) AS "downloadCount",
            row_number() OVER (PARTITION BY tf.timeframe ORDER BY COALESCE(mm."downloadCount", 0) DESC, m.id DESC) AS "downloadCountRank",
            COALESCE(mm."ratingCount", 0) AS "ratingCount",
            row_number() OVER (PARTITION BY tf.timeframe ORDER BY COALESCE(mm."ratingCount", 0) DESC, m.id DESC) AS "ratingCountRank",
            COALESCE(mm.rating, (0)::double precision) AS rating,
            row_number() OVER (PARTITION BY tf.timeframe ORDER BY COALESCE(mm.rating, (0)::double precision) DESC, m.id DESC) AS "ratingRank",
            COALESCE(mm."imageCount", 0) AS "imageCount",
            row_number() OVER (PARTITION BY tf.timeframe ORDER BY COALESCE(mm."imageCount", 0) DESC, m.id DESC) AS "imageCountRank",
            COALESCE(mm."generationCount", 0) AS "generationCount",
            row_number() OVER (PARTITION BY tf.timeframe ORDER BY COALESCE(mm."generationCount", 0) DESC, m.id DESC) AS "generationCountRank",
            tf.timeframe
           FROM ((public."ModelVersion" m
             CROSS JOIN ( SELECT unnest(enum_range(NULL::public."MetricTimeframe")) AS timeframe) tf)
             LEFT JOIN public."ModelVersionMetric" mm ON (((mm."modelVersionId" = m.id) AND (mm.timeframe = tf.timeframe))))) t
  GROUP BY t."modelVersionId";


ALTER TABLE public."ModelVersionRank_Live" OWNER TO civitai;

--
-- Name: ModelVersionSponsorshipSettings; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."ModelVersionSponsorshipSettings" (
    id integer NOT NULL,
    "modelVersionMonetizationId" integer NOT NULL,
    type public."ModelVersionSponsorshipSettingsType" DEFAULT 'FixedPrice'::public."ModelVersionSponsorshipSettingsType" NOT NULL,
    "unitAmount" integer NOT NULL,
    currency public."Currency" DEFAULT 'BUZZ'::public."Currency" NOT NULL
);


ALTER TABLE public."ModelVersionSponsorshipSettings" OWNER TO civitai;

--
-- Name: ModelVersionSponsorshipSettings_id_seq; Type: SEQUENCE; Schema: public; Owner: civitai
--

CREATE SEQUENCE public."ModelVersionSponsorshipSettings_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public."ModelVersionSponsorshipSettings_id_seq" OWNER TO civitai;

--
-- Name: ModelVersionSponsorshipSettings_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: civitai
--

ALTER SEQUENCE public."ModelVersionSponsorshipSettings_id_seq" OWNED BY public."ModelVersionSponsorshipSettings".id;


--
-- Name: ModelVersion_id_seq; Type: SEQUENCE; Schema: public; Owner: civitai
--

CREATE SEQUENCE public."ModelVersion_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public."ModelVersion_id_seq" OWNER TO civitai;

--
-- Name: ModelVersion_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: civitai
--

ALTER SEQUENCE public."ModelVersion_id_seq" OWNED BY public."ModelVersion".id;


--
-- Name: Model_id_seq; Type: SEQUENCE; Schema: public; Owner: civitai
--

CREATE SEQUENCE public."Model_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public."Model_id_seq" OWNER TO civitai;

--
-- Name: Model_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: civitai
--

ALTER SEQUENCE public."Model_id_seq" OWNED BY public."Model".id;


--
-- Name: OauthClient; Type: TABLE; Schema: public; Owner: doadmin
--

CREATE TABLE public."OauthClient" (
    id text NOT NULL,
    secret text NOT NULL,
    name text NOT NULL,
    "redirectUris" text[],
    grants text[],
    "userId" integer NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


ALTER TABLE public."OauthClient" OWNER TO doadmin;

--
-- Name: OauthToken; Type: TABLE; Schema: public; Owner: doadmin
--

CREATE TABLE public."OauthToken" (
    token text NOT NULL,
    type public."OauthTokenType" NOT NULL,
    "expiresAt" timestamp(3) without time zone,
    scope text[],
    "clientId" text NOT NULL,
    "userId" integer NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


ALTER TABLE public."OauthToken" OWNER TO doadmin;

--
-- Name: Partner; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."Partner" (
    id integer NOT NULL,
    name text NOT NULL,
    homepage text,
    tos text,
    privacy text,
    "startupTime" integer,
    "onDemand" boolean NOT NULL,
    "stepsPerSecond" integer NOT NULL,
    "pricingModel" public."PartnerPricingModel" NOT NULL,
    price text NOT NULL,
    about text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    nsfw boolean DEFAULT false NOT NULL,
    poi boolean DEFAULT false NOT NULL,
    token text,
    "onDemandStrategy" text,
    personal boolean DEFAULT false NOT NULL,
    "onDemandTypes" public."ModelType"[] DEFAULT ARRAY[]::public."ModelType"[],
    "onDemandBaseModels" text[] DEFAULT ARRAY[]::text[],
    tier integer DEFAULT 0 NOT NULL,
    logo text
);


ALTER TABLE public."Partner" OWNER TO civitai;

--
-- Name: OnDemandRunStrategy; Type: VIEW; Schema: public; Owner: doadmin
--

CREATE VIEW public."OnDemandRunStrategy" AS
 SELECT p.id AS "partnerId",
    mv.id AS "modelVersionId",
    replace(replace(replace(p."onDemandStrategy", '{downloadUrl}'::text, 'https://civitai.com/api/download/models/{modelVersionId}'::text), '{modelVersionId}'::text, (mv.id)::text), '{modelId}'::text, (mv."modelId")::text) AS url
   FROM ((public."ModelVersion" mv
     JOIN public."Model" m ON (((m.id = mv."modelId") AND (m.status = 'Published'::public."ModelStatus"))))
     JOIN public."Partner" p ON (((p."onDemand" = true) AND (p."onDemandStrategy" IS NOT NULL) AND (m.type = ANY (p."onDemandTypes")) AND (mv."baseModel" = ANY (p."onDemandBaseModels")))))
  WHERE (((p.nsfw = true) OR (m.nsfw = false)) AND (m.poi = false) AND (p.personal OR (m."allowCommercialUse" && ARRAY['Rent'::public."CommercialUse", 'Sell'::public."CommercialUse"])));


ALTER TABLE public."OnDemandRunStrategy" OWNER TO doadmin;

--
-- Name: Partner_id_seq; Type: SEQUENCE; Schema: public; Owner: civitai
--

CREATE SEQUENCE public."Partner_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public."Partner_id_seq" OWNER TO civitai;

--
-- Name: Partner_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: civitai
--

ALTER SEQUENCE public."Partner_id_seq" OWNED BY public."Partner".id;


--
-- Name: Post; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."Post" (
    id integer NOT NULL,
    nsfw boolean DEFAULT false NOT NULL,
    title text,
    detail text,
    "userId" integer NOT NULL,
    "modelVersionId" integer,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "publishedAt" timestamp(3) without time zone,
    metadata jsonb,
    "tosViolation" boolean DEFAULT false NOT NULL,
    "collectionId" integer,
    availability public."Availability" DEFAULT 'Public'::public."Availability" NOT NULL,
    unlisted boolean DEFAULT false NOT NULL,
    "nsfwLevel" integer DEFAULT 0 NOT NULL
);


ALTER TABLE public."Post" OWNER TO civitai;

--
-- Name: PostHelper; Type: VIEW; Schema: public; Owner: civitai
--

CREATE VIEW public."PostHelper" AS
 SELECT "Image"."postId",
    bool_or(("Image".ingestion = 'Scanned'::public."ImageIngestionStatus")) AS scanned
   FROM public."Image"
  GROUP BY "Image"."postId";


ALTER TABLE public."PostHelper" OWNER TO civitai;

--
-- Name: PostImageTag; Type: VIEW; Schema: public; Owner: civitai
--

CREATE VIEW public."PostImageTag" AS
 SELECT DISTINCT i."postId" AS post_id,
    toi."tagId" AS tag_id
   FROM (public."TagsOnImage" toi
     JOIN public."Image" i ON ((i.id = toi."imageId")));


ALTER TABLE public."PostImageTag" OWNER TO civitai;

--
-- Name: PostMetric; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."PostMetric" (
    "postId" integer NOT NULL,
    timeframe public."MetricTimeframe" NOT NULL,
    "likeCount" integer DEFAULT 0 NOT NULL,
    "dislikeCount" integer DEFAULT 0 NOT NULL,
    "laughCount" integer DEFAULT 0 NOT NULL,
    "cryCount" integer DEFAULT 0 NOT NULL,
    "heartCount" integer DEFAULT 0 NOT NULL,
    "commentCount" integer DEFAULT 0 NOT NULL,
    "collectedCount" integer DEFAULT 0 NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp(3) without time zone DEFAULT now(),
    "reactionCount" integer GENERATED ALWAYS AS (((("likeCount" + "heartCount") + "laughCount") + "cryCount")) STORED,
    "ageGroup" public."MetricTimeframe"
)
WITH (autovacuum_vacuum_scale_factor='0.1');


ALTER TABLE public."PostMetric" OWNER TO civitai;

--
-- Name: PostRank; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."PostRank" (
    "postId" integer NOT NULL,
    "heartCountDayRank" bigint,
    "heartCountWeekRank" bigint,
    "heartCountMonthRank" bigint,
    "heartCountYearRank" bigint,
    "heartCountAllTimeRank" bigint,
    "likeCountDayRank" bigint,
    "likeCountWeekRank" bigint,
    "likeCountMonthRank" bigint,
    "likeCountYearRank" bigint,
    "likeCountAllTimeRank" bigint,
    "dislikeCountDayRank" bigint,
    "dislikeCountWeekRank" bigint,
    "dislikeCountMonthRank" bigint,
    "dislikeCountYearRank" bigint,
    "dislikeCountAllTimeRank" bigint,
    "laughCountDayRank" bigint,
    "laughCountWeekRank" bigint,
    "laughCountMonthRank" bigint,
    "laughCountYearRank" bigint,
    "laughCountAllTimeRank" bigint,
    "cryCountDayRank" bigint,
    "cryCountWeekRank" bigint,
    "cryCountMonthRank" bigint,
    "cryCountYearRank" bigint,
    "cryCountAllTimeRank" bigint,
    "reactionCountDayRank" bigint,
    "reactionCountWeekRank" bigint,
    "reactionCountMonthRank" bigint,
    "reactionCountYearRank" bigint,
    "reactionCountAllTimeRank" bigint,
    "commentCountDayRank" bigint,
    "commentCountWeekRank" bigint,
    "commentCountMonthRank" bigint,
    "commentCountYearRank" bigint,
    "commentCountAllTimeRank" bigint,
    "collectedCountDayRank" bigint,
    "collectedCountWeekRank" bigint,
    "collectedCountMonthRank" bigint,
    "collectedCountYearRank" bigint,
    "collectedCountAllTimeRank" bigint
);


ALTER TABLE public."PostRank" OWNER TO civitai;

--
-- Name: PostRank_Live; Type: VIEW; Schema: public; Owner: civitai
--

CREATE VIEW public."PostRank_Live" AS
 WITH timeframe_stats AS (
         SELECT "PostMetric"."postId",
            "PostMetric"."heartCount",
            "PostMetric"."likeCount",
            "PostMetric"."dislikeCount",
            "PostMetric"."laughCount",
            "PostMetric"."cryCount",
            "PostMetric"."commentCount",
            (((("PostMetric"."heartCount" + "PostMetric"."likeCount") + "PostMetric"."dislikeCount") + "PostMetric"."laughCount") + "PostMetric"."cryCount") AS "reactionCount",
            "PostMetric"."collectedCount",
            "PostMetric".timeframe
           FROM public."PostMetric"
        ), timeframe_rank AS (
         SELECT timeframe_stats."postId",
            row_number() OVER (PARTITION BY timeframe_stats.timeframe ORDER BY COALESCE(timeframe_stats."heartCount", 0) DESC, COALESCE(timeframe_stats."likeCount", 0) DESC, COALESCE(timeframe_stats."commentCount", 0) DESC, COALESCE(timeframe_stats."reactionCount", 0) DESC, timeframe_stats."postId" DESC) AS "heartCountRank",
            row_number() OVER (PARTITION BY timeframe_stats.timeframe ORDER BY COALESCE(timeframe_stats."likeCount", 0) DESC, COALESCE(timeframe_stats."heartCount", 0) DESC, COALESCE(timeframe_stats."commentCount", 0) DESC, COALESCE(timeframe_stats."reactionCount", 0) DESC, timeframe_stats."postId" DESC) AS "likeCountRank",
            row_number() OVER (PARTITION BY timeframe_stats.timeframe ORDER BY COALESCE(timeframe_stats."dislikeCount", 0) DESC, COALESCE(timeframe_stats."reactionCount", 0) DESC, COALESCE(timeframe_stats."commentCount", 0) DESC, timeframe_stats."postId" DESC) AS "dislikeCountRank",
            row_number() OVER (PARTITION BY timeframe_stats.timeframe ORDER BY COALESCE(timeframe_stats."laughCount", 0) DESC, COALESCE(timeframe_stats."heartCount", 0) DESC, COALESCE(timeframe_stats."likeCount", 0) DESC, COALESCE(timeframe_stats."reactionCount", 0) DESC, COALESCE(timeframe_stats."commentCount", 0) DESC, timeframe_stats."postId" DESC) AS "laughCountRank",
            row_number() OVER (PARTITION BY timeframe_stats.timeframe ORDER BY COALESCE(timeframe_stats."cryCount", 0) DESC, COALESCE(timeframe_stats."heartCount", 0) DESC, COALESCE(timeframe_stats."likeCount", 0) DESC, COALESCE(timeframe_stats."reactionCount", 0) DESC, COALESCE(timeframe_stats."commentCount", 0) DESC, timeframe_stats."postId" DESC) AS "cryCountRank",
            row_number() OVER (PARTITION BY timeframe_stats.timeframe ORDER BY COALESCE(timeframe_stats."reactionCount", 0) DESC, COALESCE(timeframe_stats."heartCount", 0) DESC, COALESCE(timeframe_stats."likeCount", 0) DESC, COALESCE(timeframe_stats."commentCount", 0) DESC, timeframe_stats."postId" DESC) AS "reactionCountRank",
            row_number() OVER (PARTITION BY timeframe_stats.timeframe ORDER BY COALESCE(timeframe_stats."commentCount", 0) DESC, COALESCE(timeframe_stats."reactionCount", 0) DESC, COALESCE(timeframe_stats."heartCount", 0) DESC, COALESCE(timeframe_stats."likeCount", 0) DESC, COALESCE(timeframe_stats."laughCount", 0) DESC, timeframe_stats."postId" DESC) AS "commentCountRank",
            row_number() OVER (PARTITION BY timeframe_stats.timeframe ORDER BY COALESCE(timeframe_stats."collectedCount", 0) DESC, COALESCE(timeframe_stats."reactionCount", 0) DESC, COALESCE(timeframe_stats."heartCount", 0) DESC, COALESCE(timeframe_stats."likeCount", 0) DESC, COALESCE(timeframe_stats."laughCount", 0) DESC, timeframe_stats."postId" DESC) AS "collectedCountRank",
            timeframe_stats.timeframe
           FROM timeframe_stats
        )
 SELECT timeframe_rank."postId",
    max(public.iif((timeframe_rank.timeframe = 'Day'::public."MetricTimeframe"), timeframe_rank."heartCountRank", NULL::bigint)) AS "heartCountDayRank",
    max(public.iif((timeframe_rank.timeframe = 'Week'::public."MetricTimeframe"), timeframe_rank."heartCountRank", NULL::bigint)) AS "heartCountWeekRank",
    max(public.iif((timeframe_rank.timeframe = 'Month'::public."MetricTimeframe"), timeframe_rank."heartCountRank", NULL::bigint)) AS "heartCountMonthRank",
    max(public.iif((timeframe_rank.timeframe = 'Year'::public."MetricTimeframe"), timeframe_rank."heartCountRank", NULL::bigint)) AS "heartCountYearRank",
    max(public.iif((timeframe_rank.timeframe = 'AllTime'::public."MetricTimeframe"), timeframe_rank."heartCountRank", NULL::bigint)) AS "heartCountAllTimeRank",
    max(public.iif((timeframe_rank.timeframe = 'Day'::public."MetricTimeframe"), timeframe_rank."likeCountRank", NULL::bigint)) AS "likeCountDayRank",
    max(public.iif((timeframe_rank.timeframe = 'Week'::public."MetricTimeframe"), timeframe_rank."likeCountRank", NULL::bigint)) AS "likeCountWeekRank",
    max(public.iif((timeframe_rank.timeframe = 'Month'::public."MetricTimeframe"), timeframe_rank."likeCountRank", NULL::bigint)) AS "likeCountMonthRank",
    max(public.iif((timeframe_rank.timeframe = 'Year'::public."MetricTimeframe"), timeframe_rank."likeCountRank", NULL::bigint)) AS "likeCountYearRank",
    max(public.iif((timeframe_rank.timeframe = 'AllTime'::public."MetricTimeframe"), timeframe_rank."likeCountRank", NULL::bigint)) AS "likeCountAllTimeRank",
    max(public.iif((timeframe_rank.timeframe = 'Day'::public."MetricTimeframe"), timeframe_rank."dislikeCountRank", NULL::bigint)) AS "dislikeCountDayRank",
    max(public.iif((timeframe_rank.timeframe = 'Week'::public."MetricTimeframe"), timeframe_rank."dislikeCountRank", NULL::bigint)) AS "dislikeCountWeekRank",
    max(public.iif((timeframe_rank.timeframe = 'Month'::public."MetricTimeframe"), timeframe_rank."dislikeCountRank", NULL::bigint)) AS "dislikeCountMonthRank",
    max(public.iif((timeframe_rank.timeframe = 'Year'::public."MetricTimeframe"), timeframe_rank."dislikeCountRank", NULL::bigint)) AS "dislikeCountYearRank",
    max(public.iif((timeframe_rank.timeframe = 'AllTime'::public."MetricTimeframe"), timeframe_rank."dislikeCountRank", NULL::bigint)) AS "dislikeCountAllTimeRank",
    max(public.iif((timeframe_rank.timeframe = 'Day'::public."MetricTimeframe"), timeframe_rank."laughCountRank", NULL::bigint)) AS "laughCountDayRank",
    max(public.iif((timeframe_rank.timeframe = 'Week'::public."MetricTimeframe"), timeframe_rank."laughCountRank", NULL::bigint)) AS "laughCountWeekRank",
    max(public.iif((timeframe_rank.timeframe = 'Month'::public."MetricTimeframe"), timeframe_rank."laughCountRank", NULL::bigint)) AS "laughCountMonthRank",
    max(public.iif((timeframe_rank.timeframe = 'Year'::public."MetricTimeframe"), timeframe_rank."laughCountRank", NULL::bigint)) AS "laughCountYearRank",
    max(public.iif((timeframe_rank.timeframe = 'AllTime'::public."MetricTimeframe"), timeframe_rank."laughCountRank", NULL::bigint)) AS "laughCountAllTimeRank",
    max(public.iif((timeframe_rank.timeframe = 'Day'::public."MetricTimeframe"), timeframe_rank."cryCountRank", NULL::bigint)) AS "cryCountDayRank",
    max(public.iif((timeframe_rank.timeframe = 'Week'::public."MetricTimeframe"), timeframe_rank."cryCountRank", NULL::bigint)) AS "cryCountWeekRank",
    max(public.iif((timeframe_rank.timeframe = 'Month'::public."MetricTimeframe"), timeframe_rank."cryCountRank", NULL::bigint)) AS "cryCountMonthRank",
    max(public.iif((timeframe_rank.timeframe = 'Year'::public."MetricTimeframe"), timeframe_rank."cryCountRank", NULL::bigint)) AS "cryCountYearRank",
    max(public.iif((timeframe_rank.timeframe = 'AllTime'::public."MetricTimeframe"), timeframe_rank."cryCountRank", NULL::bigint)) AS "cryCountAllTimeRank",
    max(public.iif((timeframe_rank.timeframe = 'Day'::public."MetricTimeframe"), timeframe_rank."reactionCountRank", NULL::bigint)) AS "reactionCountDayRank",
    max(public.iif((timeframe_rank.timeframe = 'Week'::public."MetricTimeframe"), timeframe_rank."reactionCountRank", NULL::bigint)) AS "reactionCountWeekRank",
    max(public.iif((timeframe_rank.timeframe = 'Month'::public."MetricTimeframe"), timeframe_rank."reactionCountRank", NULL::bigint)) AS "reactionCountMonthRank",
    max(public.iif((timeframe_rank.timeframe = 'Year'::public."MetricTimeframe"), timeframe_rank."reactionCountRank", NULL::bigint)) AS "reactionCountYearRank",
    max(public.iif((timeframe_rank.timeframe = 'AllTime'::public."MetricTimeframe"), timeframe_rank."reactionCountRank", NULL::bigint)) AS "reactionCountAllTimeRank",
    max(public.iif((timeframe_rank.timeframe = 'Day'::public."MetricTimeframe"), timeframe_rank."commentCountRank", NULL::bigint)) AS "commentCountDayRank",
    max(public.iif((timeframe_rank.timeframe = 'Week'::public."MetricTimeframe"), timeframe_rank."commentCountRank", NULL::bigint)) AS "commentCountWeekRank",
    max(public.iif((timeframe_rank.timeframe = 'Month'::public."MetricTimeframe"), timeframe_rank."commentCountRank", NULL::bigint)) AS "commentCountMonthRank",
    max(public.iif((timeframe_rank.timeframe = 'Year'::public."MetricTimeframe"), timeframe_rank."commentCountRank", NULL::bigint)) AS "commentCountYearRank",
    max(public.iif((timeframe_rank.timeframe = 'AllTime'::public."MetricTimeframe"), timeframe_rank."commentCountRank", NULL::bigint)) AS "commentCountAllTimeRank",
    max(public.iif((timeframe_rank.timeframe = 'Day'::public."MetricTimeframe"), timeframe_rank."collectedCountRank", NULL::bigint)) AS "collectedCountDayRank",
    max(public.iif((timeframe_rank.timeframe = 'Week'::public."MetricTimeframe"), timeframe_rank."collectedCountRank", NULL::bigint)) AS "collectedCountWeekRank",
    max(public.iif((timeframe_rank.timeframe = 'Month'::public."MetricTimeframe"), timeframe_rank."collectedCountRank", NULL::bigint)) AS "collectedCountMonthRank",
    max(public.iif((timeframe_rank.timeframe = 'Year'::public."MetricTimeframe"), timeframe_rank."collectedCountRank", NULL::bigint)) AS "collectedCountYearRank",
    max(public.iif((timeframe_rank.timeframe = 'AllTime'::public."MetricTimeframe"), timeframe_rank."collectedCountRank", NULL::bigint)) AS "collectedCountAllTimeRank"
   FROM timeframe_rank
  GROUP BY timeframe_rank."postId";


ALTER TABLE public."PostRank_Live" OWNER TO civitai;

--
-- Name: PostReaction; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."PostReaction" (
    id integer NOT NULL,
    "postId" integer NOT NULL,
    "userId" integer NOT NULL,
    reaction public."ReviewReactions" NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


ALTER TABLE public."PostReaction" OWNER TO civitai;

--
-- Name: PostReaction_id_seq; Type: SEQUENCE; Schema: public; Owner: civitai
--

CREATE SEQUENCE public."PostReaction_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public."PostReaction_id_seq" OWNER TO civitai;

--
-- Name: PostReaction_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: civitai
--

ALTER SEQUENCE public."PostReaction_id_seq" OWNED BY public."PostReaction".id;


--
-- Name: PostReport; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."PostReport" (
    "postId" integer NOT NULL,
    "reportId" integer NOT NULL
);


ALTER TABLE public."PostReport" OWNER TO civitai;

--
-- Name: PostResourceHelper; Type: VIEW; Schema: public; Owner: doadmin
--

CREATE VIEW public."PostResourceHelper" AS
 SELECT DISTINCT ON ("ImageResourceHelper"."postId", "ImageResourceHelper".name, "ImageResourceHelper"."modelVersionId") "ImageResourceHelper".id,
    "ImageResourceHelper"."imageId",
    "ImageResourceHelper"."reviewId",
    "ImageResourceHelper"."reviewRating",
    "ImageResourceHelper"."reviewRecommended",
    "ImageResourceHelper"."reviewDetails",
    "ImageResourceHelper"."reviewCreatedAt",
    "ImageResourceHelper".name,
    "ImageResourceHelper"."modelVersionId",
    "ImageResourceHelper"."modelVersionName",
    "ImageResourceHelper"."modelVersionCreatedAt",
    "ImageResourceHelper"."modelId",
    "ImageResourceHelper"."modelName",
    "ImageResourceHelper"."modelThumbsUpCount",
    "ImageResourceHelper"."modelThumbsDownCount",
    "ImageResourceHelper"."modelDownloadCount",
    "ImageResourceHelper"."modelCommentCount",
    "ImageResourceHelper"."modelType",
    "ImageResourceHelper"."postId",
    "ImageResourceHelper"."modelRating",
    "ImageResourceHelper"."modelRatingCount",
    "ImageResourceHelper"."modelFavoriteCount"
   FROM public."ImageResourceHelper";


ALTER TABLE public."PostResourceHelper" OWNER TO doadmin;

--
-- Name: PostStat; Type: VIEW; Schema: public; Owner: civitai
--

CREATE VIEW public."PostStat" AS
 WITH timeframe_stats AS (
         SELECT p.id AS "postId",
            COALESCE(mm."heartCount", 0) AS "heartCount",
            COALESCE(mm."likeCount", 0) AS "likeCount",
            0 AS "dislikeCount",
            COALESCE(mm."laughCount", 0) AS "laughCount",
            COALESCE(mm."cryCount", 0) AS "cryCount",
            COALESCE(mm."commentCount", 0) AS "commentCount",
            tf.timeframe
           FROM ((public."Post" p
             CROSS JOIN ( SELECT unnest(enum_range(NULL::public."MetricTimeframe")) AS timeframe) tf)
             LEFT JOIN public."PostMetric" mm ON (((mm."postId" = p.id) AND (mm.timeframe = tf.timeframe))))
        )
 SELECT ts."postId",
    max(public.iif((ts.timeframe = 'Day'::public."MetricTimeframe"), ts."heartCount", NULL::integer)) AS "heartCountDay",
    max(public.iif((ts.timeframe = 'Week'::public."MetricTimeframe"), ts."heartCount", NULL::integer)) AS "heartCountWeek",
    max(public.iif((ts.timeframe = 'Month'::public."MetricTimeframe"), ts."heartCount", NULL::integer)) AS "heartCountMonth",
    max(public.iif((ts.timeframe = 'Year'::public."MetricTimeframe"), ts."heartCount", NULL::integer)) AS "heartCountYear",
    max(public.iif((ts.timeframe = 'AllTime'::public."MetricTimeframe"), ts."heartCount", NULL::integer)) AS "heartCountAllTime",
    max(public.iif((ts.timeframe = 'Day'::public."MetricTimeframe"), ts."likeCount", NULL::integer)) AS "likeCountDay",
    max(public.iif((ts.timeframe = 'Week'::public."MetricTimeframe"), ts."likeCount", NULL::integer)) AS "likeCountWeek",
    max(public.iif((ts.timeframe = 'Month'::public."MetricTimeframe"), ts."likeCount", NULL::integer)) AS "likeCountMonth",
    max(public.iif((ts.timeframe = 'Year'::public."MetricTimeframe"), ts."likeCount", NULL::integer)) AS "likeCountYear",
    max(public.iif((ts.timeframe = 'AllTime'::public."MetricTimeframe"), ts."likeCount", NULL::integer)) AS "likeCountAllTime",
    max(public.iif((ts.timeframe = 'Day'::public."MetricTimeframe"), ts."dislikeCount", NULL::integer)) AS "dislikeCountDay",
    max(public.iif((ts.timeframe = 'Week'::public."MetricTimeframe"), ts."dislikeCount", NULL::integer)) AS "dislikeCountWeek",
    max(public.iif((ts.timeframe = 'Month'::public."MetricTimeframe"), ts."dislikeCount", NULL::integer)) AS "dislikeCountMonth",
    max(public.iif((ts.timeframe = 'Year'::public."MetricTimeframe"), ts."dislikeCount", NULL::integer)) AS "dislikeCountYear",
    max(public.iif((ts.timeframe = 'AllTime'::public."MetricTimeframe"), ts."dislikeCount", NULL::integer)) AS "dislikeCountAllTime",
    max(public.iif((ts.timeframe = 'Day'::public."MetricTimeframe"), ts."laughCount", NULL::integer)) AS "laughCountDay",
    max(public.iif((ts.timeframe = 'Week'::public."MetricTimeframe"), ts."laughCount", NULL::integer)) AS "laughCountWeek",
    max(public.iif((ts.timeframe = 'Month'::public."MetricTimeframe"), ts."laughCount", NULL::integer)) AS "laughCountMonth",
    max(public.iif((ts.timeframe = 'Year'::public."MetricTimeframe"), ts."laughCount", NULL::integer)) AS "laughCountYear",
    max(public.iif((ts.timeframe = 'AllTime'::public."MetricTimeframe"), ts."laughCount", NULL::integer)) AS "laughCountAllTime",
    max(public.iif((ts.timeframe = 'Day'::public."MetricTimeframe"), ts."cryCount", NULL::integer)) AS "cryCountDay",
    max(public.iif((ts.timeframe = 'Week'::public."MetricTimeframe"), ts."cryCount", NULL::integer)) AS "cryCountWeek",
    max(public.iif((ts.timeframe = 'Month'::public."MetricTimeframe"), ts."cryCount", NULL::integer)) AS "cryCountMonth",
    max(public.iif((ts.timeframe = 'Year'::public."MetricTimeframe"), ts."cryCount", NULL::integer)) AS "cryCountYear",
    max(public.iif((ts.timeframe = 'AllTime'::public."MetricTimeframe"), ts."cryCount", NULL::integer)) AS "cryCountAllTime",
    max(public.iif((ts.timeframe = 'Day'::public."MetricTimeframe"), ts."commentCount", NULL::integer)) AS "commentCountDay",
    max(public.iif((ts.timeframe = 'Week'::public."MetricTimeframe"), ts."commentCount", NULL::integer)) AS "commentCountWeek",
    max(public.iif((ts.timeframe = 'Month'::public."MetricTimeframe"), ts."commentCount", NULL::integer)) AS "commentCountMonth",
    max(public.iif((ts.timeframe = 'Year'::public."MetricTimeframe"), ts."commentCount", NULL::integer)) AS "commentCountYear",
    max(public.iif((ts.timeframe = 'AllTime'::public."MetricTimeframe"), ts."commentCount", NULL::integer)) AS "commentCountAllTime",
    max(public.iif((ts.timeframe = 'Day'::public."MetricTimeframe"), (((ts."heartCount" + ts."likeCount") + ts."cryCount") + ts."laughCount"), NULL::integer)) AS "reactionCountDay",
    max(public.iif((ts.timeframe = 'Week'::public."MetricTimeframe"), (((ts."heartCount" + ts."likeCount") + ts."cryCount") + ts."laughCount"), NULL::integer)) AS "reactionCountWeek",
    max(public.iif((ts.timeframe = 'Month'::public."MetricTimeframe"), (((ts."heartCount" + ts."likeCount") + ts."cryCount") + ts."laughCount"), NULL::integer)) AS "reactionCountMonth",
    max(public.iif((ts.timeframe = 'Year'::public."MetricTimeframe"), (((ts."heartCount" + ts."likeCount") + ts."cryCount") + ts."laughCount"), NULL::integer)) AS "reactionCountYear",
    max(public.iif((ts.timeframe = 'AllTime'::public."MetricTimeframe"), (((ts."heartCount" + ts."likeCount") + ts."cryCount") + ts."laughCount"), NULL::integer)) AS "reactionCountAllTime"
   FROM timeframe_stats ts
  GROUP BY ts."postId";


ALTER TABLE public."PostStat" OWNER TO civitai;

--
-- Name: TagsOnPost; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."TagsOnPost" (
    "postId" integer NOT NULL,
    "tagId" integer NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    confidence integer,
    disabled boolean DEFAULT false NOT NULL,
    "needsReview" boolean DEFAULT false NOT NULL
);


ALTER TABLE public."TagsOnPost" OWNER TO civitai;

--
-- Name: TagsOnPostVote; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."TagsOnPostVote" (
    "postId" integer NOT NULL,
    "tagId" integer NOT NULL,
    "userId" integer NOT NULL,
    vote integer NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


ALTER TABLE public."TagsOnPostVote" OWNER TO civitai;

--
-- Name: PostTag; Type: VIEW; Schema: public; Owner: civitai
--

CREATE VIEW public."PostTag" AS
 WITH post_tags AS (
         SELECT toi."postId",
            toi."tagId",
            5 AS score,
            0 AS "upVotes",
            0 AS "downVotes"
           FROM public."TagsOnPost" toi
          WHERE (NOT toi.disabled)
        UNION
         SELECT "TagsOnPostVote"."postId",
            "TagsOnPostVote"."tagId",
            sum("TagsOnPostVote".vote) AS score,
            sum(public.iif(("TagsOnPostVote".vote > 0), 1, 0)) AS "upVotes",
            sum(public.iif(("TagsOnPostVote".vote < 0), 1, 0)) AS "downVotes"
           FROM public."TagsOnPostVote"
          GROUP BY "TagsOnPostVote"."tagId", "TagsOnPostVote"."postId"
        )
 SELECT pt."postId",
    pt."tagId",
    sum(pt.score) AS score,
    max(pt."upVotes") AS "upVotes",
    max(pt."downVotes") AS "downVotes",
    t.name AS "tagName",
    t.type AS "tagType"
   FROM (post_tags pt
     JOIN public."Tag" t ON ((t.id = pt."tagId")))
  GROUP BY pt."postId", pt."tagId", t.name, t.type;


ALTER TABLE public."PostTag" OWNER TO civitai;

--
-- Name: Post_id_seq; Type: SEQUENCE; Schema: public; Owner: civitai
--

CREATE SEQUENCE public."Post_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public."Post_id_seq" OWNER TO civitai;

--
-- Name: Post_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: civitai
--

ALTER SEQUENCE public."Post_id_seq" OWNED BY public."Post".id;


--
-- Name: PressMention; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."PressMention" (
    id integer NOT NULL,
    title text NOT NULL,
    url text NOT NULL,
    source text NOT NULL,
    "publishedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


ALTER TABLE public."PressMention" OWNER TO civitai;

--
-- Name: PressMention_id_seq; Type: SEQUENCE; Schema: public; Owner: civitai
--

CREATE SEQUENCE public."PressMention_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public."PressMention_id_seq" OWNER TO civitai;

--
-- Name: PressMention_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: civitai
--

ALTER SEQUENCE public."PressMention_id_seq" OWNED BY public."PressMention".id;


--
-- Name: Price; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."Price" (
    id text NOT NULL,
    "productId" text NOT NULL,
    active boolean NOT NULL,
    currency text NOT NULL,
    description text,
    type text NOT NULL,
    "unitAmount" integer,
    "interval" text,
    "intervalCount" integer,
    metadata jsonb NOT NULL,
    provider public."PaymentProvider" DEFAULT 'Stripe'::public."PaymentProvider" NOT NULL
);


ALTER TABLE public."Price" OWNER TO civitai;

--
-- Name: Product; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."Product" (
    id text NOT NULL,
    active boolean NOT NULL,
    name text NOT NULL,
    description text,
    metadata jsonb NOT NULL,
    "defaultPriceId" text,
    provider public."PaymentProvider" DEFAULT 'Stripe'::public."PaymentProvider" NOT NULL
);


ALTER TABLE public."Product" OWNER TO civitai;

--
-- Name: PurchasableReward; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."PurchasableReward" (
    id integer NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    title text NOT NULL,
    "unitPrice" integer NOT NULL,
    about text NOT NULL,
    "redeemDetails" text NOT NULL,
    "termsOfUse" text NOT NULL,
    usage public."PurchasableRewardUsage" NOT NULL,
    codes text[],
    archived boolean DEFAULT false NOT NULL,
    "availableFrom" timestamp(3) without time zone,
    "availableTo" timestamp(3) without time zone,
    "availableCount" integer,
    "addedById" integer,
    "coverImageId" integer
);


ALTER TABLE public."PurchasableReward" OWNER TO civitai;

--
-- Name: PurchasableReward_id_seq; Type: SEQUENCE; Schema: public; Owner: civitai
--

CREATE SEQUENCE public."PurchasableReward_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public."PurchasableReward_id_seq" OWNER TO civitai;

--
-- Name: PurchasableReward_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: civitai
--

ALTER SEQUENCE public."PurchasableReward_id_seq" OWNED BY public."PurchasableReward".id;


--
-- Name: Purchase; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."Purchase" (
    id integer NOT NULL,
    "customerId" text,
    "productId" text,
    "priceId" text,
    status text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "userId" integer
);


ALTER TABLE public."Purchase" OWNER TO civitai;

--
-- Name: Purchase_id_seq; Type: SEQUENCE; Schema: public; Owner: civitai
--

CREATE SEQUENCE public."Purchase_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public."Purchase_id_seq" OWNER TO civitai;

--
-- Name: Purchase_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: civitai
--

ALTER SEQUENCE public."Purchase_id_seq" OWNED BY public."Purchase".id;


--
-- Name: QueryDurationLog; Type: TABLE; Schema: public; Owner: doadmin
--

CREATE TABLE public."QueryDurationLog" (
    id integer NOT NULL,
    duration integer NOT NULL,
    "sqlId" integer NOT NULL,
    "paramsId" integer NOT NULL
);


ALTER TABLE public."QueryDurationLog" OWNER TO doadmin;

--
-- Name: QueryDurationLog_id_seq; Type: SEQUENCE; Schema: public; Owner: doadmin
--

CREATE SEQUENCE public."QueryDurationLog_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public."QueryDurationLog_id_seq" OWNER TO doadmin;

--
-- Name: QueryDurationLog_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: doadmin
--

ALTER SEQUENCE public."QueryDurationLog_id_seq" OWNED BY public."QueryDurationLog".id;


--
-- Name: QueryParamsLog; Type: TABLE; Schema: public; Owner: doadmin
--

CREATE TABLE public."QueryParamsLog" (
    id integer NOT NULL,
    hash text NOT NULL,
    params jsonb NOT NULL,
    "sqlId" integer NOT NULL
);


ALTER TABLE public."QueryParamsLog" OWNER TO doadmin;

--
-- Name: QueryParamsLog_id_seq; Type: SEQUENCE; Schema: public; Owner: doadmin
--

CREATE SEQUENCE public."QueryParamsLog_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public."QueryParamsLog_id_seq" OWNER TO doadmin;

--
-- Name: QueryParamsLog_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: doadmin
--

ALTER SEQUENCE public."QueryParamsLog_id_seq" OWNED BY public."QueryParamsLog".id;


--
-- Name: QuerySqlLog; Type: TABLE; Schema: public; Owner: doadmin
--

CREATE TABLE public."QuerySqlLog" (
    id integer NOT NULL,
    hash text NOT NULL,
    sql text NOT NULL
);


ALTER TABLE public."QuerySqlLog" OWNER TO doadmin;

--
-- Name: QuerySqlLog_id_seq; Type: SEQUENCE; Schema: public; Owner: doadmin
--

CREATE SEQUENCE public."QuerySqlLog_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public."QuerySqlLog_id_seq" OWNER TO doadmin;

--
-- Name: QuerySqlLog_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: doadmin
--

ALTER SEQUENCE public."QuerySqlLog_id_seq" OWNED BY public."QuerySqlLog".id;


--
-- Name: Question; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."Question" (
    id integer NOT NULL,
    "userId" integer NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    title public.citext NOT NULL,
    content text NOT NULL,
    "selectedAnswerId" integer
);


ALTER TABLE public."Question" OWNER TO civitai;

--
-- Name: QuestionMetric; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."QuestionMetric" (
    "questionId" integer NOT NULL,
    timeframe public."MetricTimeframe" NOT NULL,
    "heartCount" integer DEFAULT 0 NOT NULL,
    "commentCount" integer DEFAULT 0 NOT NULL,
    "answerCount" integer DEFAULT 0 NOT NULL
);


ALTER TABLE public."QuestionMetric" OWNER TO civitai;

--
-- Name: QuestionRank; Type: VIEW; Schema: public; Owner: civitai
--

CREATE VIEW public."QuestionRank" AS
 SELECT t."questionId",
    max(public.iif((t.timeframe = 'Day'::public."MetricTimeframe"), t."heartCount", NULL::integer)) AS "heartCountDay",
    max(public.iif((t.timeframe = 'Day'::public."MetricTimeframe"), t."heartCountRank", NULL::bigint)) AS "heartCountDayRank",
    max(public.iif((t.timeframe = 'Week'::public."MetricTimeframe"), t."heartCount", NULL::integer)) AS "heartCountWeek",
    max(public.iif((t.timeframe = 'Week'::public."MetricTimeframe"), t."heartCountRank", NULL::bigint)) AS "heartCountWeekRank",
    max(public.iif((t.timeframe = 'Month'::public."MetricTimeframe"), t."heartCount", NULL::integer)) AS "heartCountMonth",
    max(public.iif((t.timeframe = 'Month'::public."MetricTimeframe"), t."heartCountRank", NULL::bigint)) AS "heartCountMonthRank",
    max(public.iif((t.timeframe = 'Year'::public."MetricTimeframe"), t."heartCount", NULL::integer)) AS "heartCountYear",
    max(public.iif((t.timeframe = 'Year'::public."MetricTimeframe"), t."heartCountRank", NULL::bigint)) AS "heartCountYearRank",
    max(public.iif((t.timeframe = 'AllTime'::public."MetricTimeframe"), t."heartCount", NULL::integer)) AS "heartCountAllTime",
    max(public.iif((t.timeframe = 'AllTime'::public."MetricTimeframe"), t."heartCountRank", NULL::bigint)) AS "heartCountAllTimeRank",
    max(public.iif((t.timeframe = 'Day'::public."MetricTimeframe"), t."commentCount", NULL::integer)) AS "commentCountDay",
    max(public.iif((t.timeframe = 'Day'::public."MetricTimeframe"), t."commentCountRank", NULL::bigint)) AS "commentCountDayRank",
    max(public.iif((t.timeframe = 'Week'::public."MetricTimeframe"), t."commentCount", NULL::integer)) AS "commentCountWeek",
    max(public.iif((t.timeframe = 'Week'::public."MetricTimeframe"), t."commentCountRank", NULL::bigint)) AS "commentCountWeekRank",
    max(public.iif((t.timeframe = 'Month'::public."MetricTimeframe"), t."commentCount", NULL::integer)) AS "commentCountMonth",
    max(public.iif((t.timeframe = 'Month'::public."MetricTimeframe"), t."commentCountRank", NULL::bigint)) AS "commentCountMonthRank",
    max(public.iif((t.timeframe = 'Year'::public."MetricTimeframe"), t."commentCount", NULL::integer)) AS "commentCountYear",
    max(public.iif((t.timeframe = 'Year'::public."MetricTimeframe"), t."commentCountRank", NULL::bigint)) AS "commentCountYearRank",
    max(public.iif((t.timeframe = 'AllTime'::public."MetricTimeframe"), t."commentCount", NULL::integer)) AS "commentCountAllTime",
    max(public.iif((t.timeframe = 'AllTime'::public."MetricTimeframe"), t."commentCountRank", NULL::bigint)) AS "commentCountAllTimeRank",
    max(public.iif((t.timeframe = 'Day'::public."MetricTimeframe"), t."answerCount", NULL::integer)) AS "answerCountDay",
    max(public.iif((t.timeframe = 'Day'::public."MetricTimeframe"), t."answerCountRank", NULL::bigint)) AS "answerCountDayRank",
    max(public.iif((t.timeframe = 'Week'::public."MetricTimeframe"), t."answerCount", NULL::integer)) AS "answerCountWeek",
    max(public.iif((t.timeframe = 'Week'::public."MetricTimeframe"), t."answerCountRank", NULL::bigint)) AS "answerCountWeekRank",
    max(public.iif((t.timeframe = 'Month'::public."MetricTimeframe"), t."answerCount", NULL::integer)) AS "answerCountMonth",
    max(public.iif((t.timeframe = 'Month'::public."MetricTimeframe"), t."answerCountRank", NULL::bigint)) AS "answerCountMonthRank",
    max(public.iif((t.timeframe = 'Year'::public."MetricTimeframe"), t."answerCount", NULL::integer)) AS "answerCountYear",
    max(public.iif((t.timeframe = 'Year'::public."MetricTimeframe"), t."answerCountRank", NULL::bigint)) AS "answerCountYearRank",
    max(public.iif((t.timeframe = 'AllTime'::public."MetricTimeframe"), t."answerCount", NULL::integer)) AS "answerCountAllTime",
    max(public.iif((t.timeframe = 'AllTime'::public."MetricTimeframe"), t."answerCountRank", NULL::bigint)) AS "answerCountAllTimeRank"
   FROM ( SELECT q.id AS "questionId",
            COALESCE(qm."heartCount", 0) AS "heartCount",
            row_number() OVER (PARTITION BY tf.timeframe ORDER BY COALESCE(qm."heartCount", 0) DESC, COALESCE(qm."answerCount", 0) DESC, COALESCE(qm."commentCount", 0) DESC, q.id DESC) AS "heartCountRank",
            COALESCE(qm."commentCount", 0) AS "commentCount",
            row_number() OVER (PARTITION BY tf.timeframe ORDER BY COALESCE(qm."commentCount", 0) DESC, COALESCE(qm."heartCount", 0) DESC, COALESCE(qm."answerCount", 0) DESC, q.id DESC) AS "commentCountRank",
            COALESCE(qm."answerCount", 0) AS "answerCount",
            row_number() OVER (PARTITION BY tf.timeframe ORDER BY COALESCE(qm."answerCount", 0) DESC, COALESCE(qm."heartCount", 0) DESC, COALESCE(qm."commentCount", 0) DESC, q.id DESC) AS "answerCountRank",
            tf.timeframe
           FROM ((public."Question" q
             CROSS JOIN ( SELECT unnest(enum_range(NULL::public."MetricTimeframe")) AS timeframe) tf)
             LEFT JOIN public."QuestionMetric" qm ON (((qm."questionId" = q.id) AND (qm.timeframe = tf.timeframe))))) t
  GROUP BY t."questionId";


ALTER TABLE public."QuestionRank" OWNER TO civitai;

--
-- Name: QuestionReaction; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."QuestionReaction" (
    id integer NOT NULL,
    "questionId" integer NOT NULL,
    "userId" integer NOT NULL,
    reaction public."ReviewReactions" NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


ALTER TABLE public."QuestionReaction" OWNER TO civitai;

--
-- Name: QuestionReaction_id_seq; Type: SEQUENCE; Schema: public; Owner: civitai
--

CREATE SEQUENCE public."QuestionReaction_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public."QuestionReaction_id_seq" OWNER TO civitai;

--
-- Name: QuestionReaction_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: civitai
--

ALTER SEQUENCE public."QuestionReaction_id_seq" OWNED BY public."QuestionReaction".id;


--
-- Name: Question_id_seq; Type: SEQUENCE; Schema: public; Owner: civitai
--

CREATE SEQUENCE public."Question_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public."Question_id_seq" OWNER TO civitai;

--
-- Name: Question_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: civitai
--

ALTER SEQUENCE public."Question_id_seq" OWNED BY public."Question".id;


--
-- Name: RecommendedResource; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."RecommendedResource" (
    id integer NOT NULL,
    "resourceId" integer NOT NULL,
    "sourceId" integer,
    settings jsonb
);


ALTER TABLE public."RecommendedResource" OWNER TO civitai;

--
-- Name: RecommendedResource_id_seq; Type: SEQUENCE; Schema: public; Owner: civitai
--

CREATE SEQUENCE public."RecommendedResource_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public."RecommendedResource_id_seq" OWNER TO civitai;

--
-- Name: RecommendedResource_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: civitai
--

ALTER SEQUENCE public."RecommendedResource_id_seq" OWNED BY public."RecommendedResource".id;


--
-- Name: RedeemableCode; Type: TABLE; Schema: public; Owner: doadmin
--

CREATE TABLE public."RedeemableCode" (
    code public.citext DEFAULT public.generate_redeemable_code() NOT NULL,
    "unitValue" integer NOT NULL,
    "userId" integer,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    type public."RedeemableCodeType" NOT NULL,
    "expiresAt" timestamp(3) without time zone,
    "redeemedAt" timestamp(3) without time zone,
    "transactionId" text
);


ALTER TABLE public."RedeemableCode" OWNER TO doadmin;

--
-- Name: Report_id_seq; Type: SEQUENCE; Schema: public; Owner: civitai
--

CREATE SEQUENCE public."Report_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public."Report_id_seq" OWNER TO civitai;

--
-- Name: Report_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: civitai
--

ALTER SEQUENCE public."Report_id_seq" OWNED BY public."Report".id;


--
-- Name: ResourceReviewHelper; Type: VIEW; Schema: public; Owner: civitai
--

CREATE VIEW public."ResourceReviewHelper" AS
 SELECT rr.id AS "resourceReviewId",
    count(DISTINCT i.id) AS "imageCount"
   FROM ((public."ResourceReview" rr
     JOIN public."ImageResource" ir ON ((ir."modelVersionId" = rr."modelVersionId")))
     JOIN public."Image" i ON (((i.id = ir."imageId") AND (i."userId" = rr."userId"))))
  WHERE (ir."modelVersionId" = rr."modelVersionId")
  GROUP BY rr.id;


ALTER TABLE public."ResourceReviewHelper" OWNER TO civitai;

--
-- Name: ResourceReviewReaction; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."ResourceReviewReaction" (
    id integer NOT NULL,
    "reviewId" integer NOT NULL,
    "userId" integer NOT NULL,
    reaction public."ReviewReactions" NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


ALTER TABLE public."ResourceReviewReaction" OWNER TO civitai;

--
-- Name: ResourceReviewReaction_id_seq; Type: SEQUENCE; Schema: public; Owner: civitai
--

CREATE SEQUENCE public."ResourceReviewReaction_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public."ResourceReviewReaction_id_seq" OWNER TO civitai;

--
-- Name: ResourceReviewReaction_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: civitai
--

ALTER SEQUENCE public."ResourceReviewReaction_id_seq" OWNED BY public."ResourceReviewReaction".id;


--
-- Name: ResourceReviewReport; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."ResourceReviewReport" (
    "resourceReviewId" integer NOT NULL,
    "reportId" integer NOT NULL
);


ALTER TABLE public."ResourceReviewReport" OWNER TO civitai;

--
-- Name: ResourceReview_id_seq; Type: SEQUENCE; Schema: public; Owner: civitai
--

CREATE SEQUENCE public."ResourceReview_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public."ResourceReview_id_seq" OWNER TO civitai;

--
-- Name: ResourceReview_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: civitai
--

ALTER SEQUENCE public."ResourceReview_id_seq" OWNED BY public."ResourceReview".id;


--
-- Name: RunStrategy; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."RunStrategy" (
    "modelVersionId" integer NOT NULL,
    "partnerId" integer NOT NULL,
    url text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


ALTER TABLE public."RunStrategy" OWNER TO civitai;

--
-- Name: SavedModel; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."SavedModel" (
    "modelId" integer NOT NULL,
    "userId" integer NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


ALTER TABLE public."SavedModel" OWNER TO civitai;

--
-- Name: SearchIndexUpdateQueue; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."SearchIndexUpdateQueue" (
    type text NOT NULL,
    id integer NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    action public."SearchIndexUpdateQueueAction" DEFAULT 'Update'::public."SearchIndexUpdateQueueAction" NOT NULL
);


ALTER TABLE public."SearchIndexUpdateQueue" OWNER TO civitai;

--
-- Name: Session; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."Session" (
    "sessionToken" text NOT NULL,
    expires timestamp(3) without time zone NOT NULL,
    id integer NOT NULL,
    "userId" integer NOT NULL
);


ALTER TABLE public."Session" OWNER TO civitai;

--
-- Name: SessionInvalidation; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."SessionInvalidation" (
    "userId" integer NOT NULL,
    "invalidatedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


ALTER TABLE public."SessionInvalidation" OWNER TO civitai;

--
-- Name: Session_id_seq; Type: SEQUENCE; Schema: public; Owner: civitai
--

CREATE SEQUENCE public."Session_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public."Session_id_seq" OWNER TO civitai;

--
-- Name: Session_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: civitai
--

ALTER SEQUENCE public."Session_id_seq" OWNED BY public."Session".id;


--
-- Name: TagEngagement; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."TagEngagement" (
    "userId" integer NOT NULL,
    "tagId" integer NOT NULL,
    type public."TagEngagementType" NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


ALTER TABLE public."TagEngagement" OWNER TO civitai;

--
-- Name: TagMetric; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."TagMetric" (
    "tagId" integer NOT NULL,
    timeframe public."MetricTimeframe" NOT NULL,
    "modelCount" integer DEFAULT 0 NOT NULL,
    "hiddenCount" integer DEFAULT 0 NOT NULL,
    "followerCount" integer DEFAULT 0 NOT NULL,
    "imageCount" integer DEFAULT 0 NOT NULL,
    "postCount" integer DEFAULT 0 NOT NULL,
    "articleCount" integer DEFAULT 0 NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp(3) without time zone DEFAULT now()
);


ALTER TABLE public."TagMetric" OWNER TO civitai;

--
-- Name: TagRank; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."TagRank" (
    "tagId" integer NOT NULL,
    "followerCountDayRank" integer,
    "followerCountWeekRank" integer,
    "followerCountMonthRank" integer,
    "followerCountYearRank" integer,
    "followerCountAllTimeRank" integer,
    "hiddenCountDayRank" integer,
    "hiddenCountWeekRank" integer,
    "hiddenCountMonthRank" integer,
    "hiddenCountYearRank" integer,
    "hiddenCountAllTimeRank" integer,
    "modelCountDayRank" integer,
    "modelCountWeekRank" integer,
    "modelCountMonthRank" integer,
    "modelCountYearRank" integer,
    "modelCountAllTimeRank" integer,
    "imageCountDayRank" integer,
    "imageCountWeekRank" integer,
    "imageCountMonthRank" integer,
    "imageCountYearRank" integer,
    "imageCountAllTimeRank" integer,
    "postCountDayRank" integer,
    "postCountWeekRank" integer,
    "postCountMonthRank" integer,
    "postCountYearRank" integer,
    "postCountAllTimeRank" integer,
    "articleCountDayRank" integer,
    "articleCountWeekRank" integer,
    "articleCountMonthRank" integer,
    "articleCountYearRank" integer,
    "articleCountAllTimeRank" integer
);


ALTER TABLE public."TagRank" OWNER TO civitai;

--
-- Name: TagStat; Type: VIEW; Schema: public; Owner: civitai
--

CREATE VIEW public."TagStat" AS
 SELECT "TagMetric"."tagId",
    max(public.iif(("TagMetric".timeframe = 'Day'::public."MetricTimeframe"), "TagMetric"."followerCount", NULL::integer)) AS "followerCountDay",
    max(public.iif(("TagMetric".timeframe = 'Week'::public."MetricTimeframe"), "TagMetric"."followerCount", NULL::integer)) AS "followerCountWeek",
    max(public.iif(("TagMetric".timeframe = 'Month'::public."MetricTimeframe"), "TagMetric"."followerCount", NULL::integer)) AS "followerCountMonth",
    max(public.iif(("TagMetric".timeframe = 'Year'::public."MetricTimeframe"), "TagMetric"."followerCount", NULL::integer)) AS "followerCountYear",
    max(public.iif(("TagMetric".timeframe = 'AllTime'::public."MetricTimeframe"), "TagMetric"."followerCount", NULL::integer)) AS "followerCountAllTime",
    max(public.iif(("TagMetric".timeframe = 'Day'::public."MetricTimeframe"), "TagMetric"."hiddenCount", NULL::integer)) AS "hiddenCountDay",
    max(public.iif(("TagMetric".timeframe = 'Week'::public."MetricTimeframe"), "TagMetric"."hiddenCount", NULL::integer)) AS "hiddenCountWeek",
    max(public.iif(("TagMetric".timeframe = 'Month'::public."MetricTimeframe"), "TagMetric"."hiddenCount", NULL::integer)) AS "hiddenCountMonth",
    max(public.iif(("TagMetric".timeframe = 'Year'::public."MetricTimeframe"), "TagMetric"."hiddenCount", NULL::integer)) AS "hiddenCountYear",
    max(public.iif(("TagMetric".timeframe = 'AllTime'::public."MetricTimeframe"), "TagMetric"."hiddenCount", NULL::integer)) AS "hiddenCountAllTime",
    max(public.iif(("TagMetric".timeframe = 'Day'::public."MetricTimeframe"), "TagMetric"."modelCount", NULL::integer)) AS "modelCountDay",
    max(public.iif(("TagMetric".timeframe = 'Week'::public."MetricTimeframe"), "TagMetric"."modelCount", NULL::integer)) AS "modelCountWeek",
    max(public.iif(("TagMetric".timeframe = 'Month'::public."MetricTimeframe"), "TagMetric"."modelCount", NULL::integer)) AS "modelCountMonth",
    max(public.iif(("TagMetric".timeframe = 'Year'::public."MetricTimeframe"), "TagMetric"."modelCount", NULL::integer)) AS "modelCountYear",
    max(public.iif(("TagMetric".timeframe = 'AllTime'::public."MetricTimeframe"), "TagMetric"."modelCount", NULL::integer)) AS "modelCountAllTime",
    max(public.iif(("TagMetric".timeframe = 'Day'::public."MetricTimeframe"), "TagMetric"."imageCount", NULL::integer)) AS "imageCountDay",
    max(public.iif(("TagMetric".timeframe = 'Week'::public."MetricTimeframe"), "TagMetric"."imageCount", NULL::integer)) AS "imageCountWeek",
    max(public.iif(("TagMetric".timeframe = 'Month'::public."MetricTimeframe"), "TagMetric"."imageCount", NULL::integer)) AS "imageCountMonth",
    max(public.iif(("TagMetric".timeframe = 'Year'::public."MetricTimeframe"), "TagMetric"."imageCount", NULL::integer)) AS "imageCountYear",
    max(public.iif(("TagMetric".timeframe = 'AllTime'::public."MetricTimeframe"), "TagMetric"."imageCount", NULL::integer)) AS "imageCountAllTime",
    max(public.iif(("TagMetric".timeframe = 'Day'::public."MetricTimeframe"), "TagMetric"."postCount", NULL::integer)) AS "postCountDay",
    max(public.iif(("TagMetric".timeframe = 'Week'::public."MetricTimeframe"), "TagMetric"."postCount", NULL::integer)) AS "postCountWeek",
    max(public.iif(("TagMetric".timeframe = 'Month'::public."MetricTimeframe"), "TagMetric"."postCount", NULL::integer)) AS "postCountMonth",
    max(public.iif(("TagMetric".timeframe = 'Year'::public."MetricTimeframe"), "TagMetric"."postCount", NULL::integer)) AS "postCountYear",
    max(public.iif(("TagMetric".timeframe = 'AllTime'::public."MetricTimeframe"), "TagMetric"."postCount", NULL::integer)) AS "postCountAllTime",
    max(public.iif(("TagMetric".timeframe = 'Day'::public."MetricTimeframe"), "TagMetric"."articleCount", NULL::integer)) AS "articleCountDay",
    max(public.iif(("TagMetric".timeframe = 'Week'::public."MetricTimeframe"), "TagMetric"."articleCount", NULL::integer)) AS "articleCountWeek",
    max(public.iif(("TagMetric".timeframe = 'Month'::public."MetricTimeframe"), "TagMetric"."articleCount", NULL::integer)) AS "articleCountMonth",
    max(public.iif(("TagMetric".timeframe = 'Year'::public."MetricTimeframe"), "TagMetric"."articleCount", NULL::integer)) AS "articleCountYear",
    max(public.iif(("TagMetric".timeframe = 'AllTime'::public."MetricTimeframe"), "TagMetric"."articleCount", NULL::integer)) AS "articleCountAllTime"
   FROM public."TagMetric"
  GROUP BY "TagMetric"."tagId";


ALTER TABLE public."TagStat" OWNER TO civitai;

--
-- Name: TagRank_Live; Type: VIEW; Schema: public; Owner: civitai
--

CREATE VIEW public."TagRank_Live" AS
 SELECT "TagStat"."tagId",
    (row_number() OVER (ORDER BY "TagStat"."followerCountDay" DESC, "TagStat"."modelCountDay" DESC, "TagStat"."hiddenCountDay", "TagStat"."tagId"))::integer AS "followerCountDayRank",
    (row_number() OVER (ORDER BY "TagStat"."followerCountWeek" DESC, "TagStat"."modelCountWeek" DESC, "TagStat"."hiddenCountWeek", "TagStat"."tagId"))::integer AS "followerCountWeekRank",
    (row_number() OVER (ORDER BY "TagStat"."followerCountMonth" DESC, "TagStat"."modelCountMonth" DESC, "TagStat"."hiddenCountMonth", "TagStat"."tagId"))::integer AS "followerCountMonthRank",
    (row_number() OVER (ORDER BY "TagStat"."followerCountYear" DESC, "TagStat"."modelCountYear" DESC, "TagStat"."hiddenCountYear", "TagStat"."tagId"))::integer AS "followerCountYearRank",
    (row_number() OVER (ORDER BY "TagStat"."followerCountAllTime" DESC, "TagStat"."modelCountAllTime" DESC, "TagStat"."hiddenCountAllTime", "TagStat"."tagId"))::integer AS "followerCountAllTimeRank",
    (row_number() OVER (ORDER BY "TagStat"."hiddenCountDay" DESC, "TagStat"."modelCountDay" DESC, "TagStat"."followerCountDay", "TagStat"."tagId"))::integer AS "hiddenCountDayRank",
    (row_number() OVER (ORDER BY "TagStat"."hiddenCountWeek" DESC, "TagStat"."modelCountWeek" DESC, "TagStat"."followerCountWeek", "TagStat"."tagId"))::integer AS "hiddenCountWeekRank",
    (row_number() OVER (ORDER BY "TagStat"."hiddenCountMonth" DESC, "TagStat"."modelCountMonth" DESC, "TagStat"."followerCountMonth", "TagStat"."tagId"))::integer AS "hiddenCountMonthRank",
    (row_number() OVER (ORDER BY "TagStat"."hiddenCountYear" DESC, "TagStat"."modelCountYear" DESC, "TagStat"."followerCountYear", "TagStat"."tagId"))::integer AS "hiddenCountYearRank",
    (row_number() OVER (ORDER BY "TagStat"."hiddenCountAllTime" DESC, "TagStat"."modelCountAllTime" DESC, "TagStat"."followerCountAllTime", "TagStat"."tagId"))::integer AS "hiddenCountAllTimeRank",
    (row_number() OVER (ORDER BY "TagStat"."modelCountDay" DESC, "TagStat"."followerCountDay" DESC, "TagStat"."hiddenCountDay", "TagStat"."tagId"))::integer AS "modelCountDayRank",
    (row_number() OVER (ORDER BY "TagStat"."modelCountWeek" DESC, "TagStat"."followerCountWeek" DESC, "TagStat"."hiddenCountWeek", "TagStat"."tagId"))::integer AS "modelCountWeekRank",
    (row_number() OVER (ORDER BY "TagStat"."modelCountMonth" DESC, "TagStat"."followerCountMonth" DESC, "TagStat"."hiddenCountMonth", "TagStat"."tagId"))::integer AS "modelCountMonthRank",
    (row_number() OVER (ORDER BY "TagStat"."modelCountYear" DESC, "TagStat"."followerCountYear" DESC, "TagStat"."hiddenCountYear", "TagStat"."tagId"))::integer AS "modelCountYearRank",
    (row_number() OVER (ORDER BY "TagStat"."modelCountAllTime" DESC, "TagStat"."followerCountAllTime" DESC, "TagStat"."hiddenCountAllTime", "TagStat"."tagId"))::integer AS "modelCountAllTimeRank",
    (row_number() OVER (ORDER BY "TagStat"."imageCountDay" DESC, "TagStat"."followerCountDay" DESC, "TagStat"."hiddenCountDay", "TagStat"."tagId"))::integer AS "imageCountDayRank",
    (row_number() OVER (ORDER BY "TagStat"."imageCountWeek" DESC, "TagStat"."followerCountWeek" DESC, "TagStat"."hiddenCountWeek", "TagStat"."tagId"))::integer AS "imageCountWeekRank",
    (row_number() OVER (ORDER BY "TagStat"."imageCountMonth" DESC, "TagStat"."followerCountMonth" DESC, "TagStat"."hiddenCountMonth", "TagStat"."tagId"))::integer AS "imageCountMonthRank",
    (row_number() OVER (ORDER BY "TagStat"."imageCountYear" DESC, "TagStat"."followerCountYear" DESC, "TagStat"."hiddenCountYear", "TagStat"."tagId"))::integer AS "imageCountYearRank",
    (row_number() OVER (ORDER BY "TagStat"."imageCountAllTime" DESC, "TagStat"."followerCountAllTime" DESC, "TagStat"."hiddenCountAllTime", "TagStat"."tagId"))::integer AS "imageCountAllTimeRank",
    (row_number() OVER (ORDER BY "TagStat"."postCountDay" DESC, "TagStat"."imageCountDay" DESC, "TagStat"."hiddenCountDay", "TagStat"."tagId"))::integer AS "postCountDayRank",
    (row_number() OVER (ORDER BY "TagStat"."postCountWeek" DESC, "TagStat"."imageCountWeek" DESC, "TagStat"."hiddenCountWeek", "TagStat"."tagId"))::integer AS "postCountWeekRank",
    (row_number() OVER (ORDER BY "TagStat"."postCountMonth" DESC, "TagStat"."imageCountMonth" DESC, "TagStat"."hiddenCountMonth", "TagStat"."tagId"))::integer AS "postCountMonthRank",
    (row_number() OVER (ORDER BY "TagStat"."postCountYear" DESC, "TagStat"."imageCountYear" DESC, "TagStat"."hiddenCountYear", "TagStat"."tagId"))::integer AS "postCountYearRank",
    (row_number() OVER (ORDER BY "TagStat"."postCountAllTime" DESC, "TagStat"."imageCountAllTime" DESC, "TagStat"."hiddenCountAllTime", "TagStat"."tagId"))::integer AS "postCountAllTimeRank",
    (row_number() OVER (ORDER BY "TagStat"."articleCountDay" DESC, "TagStat"."imageCountDay" DESC, "TagStat"."hiddenCountDay", "TagStat"."tagId"))::integer AS "articleCountDayRank",
    (row_number() OVER (ORDER BY "TagStat"."articleCountWeek" DESC, "TagStat"."imageCountWeek" DESC, "TagStat"."hiddenCountWeek", "TagStat"."tagId"))::integer AS "articleCountWeekRank",
    (row_number() OVER (ORDER BY "TagStat"."articleCountMonth" DESC, "TagStat"."imageCountMonth" DESC, "TagStat"."hiddenCountMonth", "TagStat"."tagId"))::integer AS "articleCountMonthRank",
    (row_number() OVER (ORDER BY "TagStat"."articleCountYear" DESC, "TagStat"."imageCountYear" DESC, "TagStat"."hiddenCountYear", "TagStat"."tagId"))::integer AS "articleCountYearRank",
    (row_number() OVER (ORDER BY "TagStat"."articleCountAllTime" DESC, "TagStat"."imageCountAllTime" DESC, "TagStat"."hiddenCountAllTime", "TagStat"."tagId"))::integer AS "articleCountAllTimeRank"
   FROM public."TagStat";


ALTER TABLE public."TagRank_Live" OWNER TO civitai;

--
-- Name: Tag_id_seq; Type: SEQUENCE; Schema: public; Owner: civitai
--

CREATE SEQUENCE public."Tag_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public."Tag_id_seq" OWNER TO civitai;

--
-- Name: Tag_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: civitai
--

ALTER SEQUENCE public."Tag_id_seq" OWNED BY public."Tag".id;


--
-- Name: TagsOnArticle; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."TagsOnArticle" (
    "articleId" integer NOT NULL,
    "tagId" integer NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


ALTER TABLE public."TagsOnArticle" OWNER TO civitai;

--
-- Name: TagsOnBounty; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."TagsOnBounty" (
    "bountyId" integer NOT NULL,
    "tagId" integer NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


ALTER TABLE public."TagsOnBounty" OWNER TO civitai;

--
-- Name: TagsOnCollection; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."TagsOnCollection" (
    "collectionId" integer NOT NULL,
    "tagId" integer NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP
);


ALTER TABLE public."TagsOnCollection" OWNER TO civitai;

--
-- Name: TagsOnQuestions; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."TagsOnQuestions" (
    "questionId" integer NOT NULL,
    "tagId" integer NOT NULL
);


ALTER TABLE public."TagsOnQuestions" OWNER TO civitai;

--
-- Name: TagsOnTags; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."TagsOnTags" (
    "fromTagId" integer NOT NULL,
    "toTagId" integer NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    type public."TagsOnTagsType" DEFAULT 'Parent'::public."TagsOnTagsType" NOT NULL
);


ALTER TABLE public."TagsOnTags" OWNER TO civitai;

--
-- Name: Technique; Type: TABLE; Schema: public; Owner: doadmin
--

CREATE TABLE public."Technique" (
    id integer NOT NULL,
    name text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    type public."TechniqueType" NOT NULL
);


ALTER TABLE public."Technique" OWNER TO doadmin;

--
-- Name: Technique_id_seq; Type: SEQUENCE; Schema: public; Owner: doadmin
--

CREATE SEQUENCE public."Technique_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public."Technique_id_seq" OWNER TO doadmin;

--
-- Name: Technique_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: doadmin
--

ALTER SEQUENCE public."Technique_id_seq" OWNED BY public."Technique".id;


--
-- Name: Thread; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."Thread" (
    id integer NOT NULL,
    locked boolean DEFAULT false NOT NULL,
    "questionId" integer,
    "answerId" integer,
    "imageId" integer,
    "postId" integer,
    "reviewId" integer,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    "modelId" integer,
    "commentId" integer,
    "articleId" integer,
    "bountyEntryId" integer,
    "bountyId" integer,
    "clubPostId" integer,
    "parentThreadId" integer,
    "rootThreadId" integer
);


ALTER TABLE public."Thread" OWNER TO civitai;

--
-- Name: Thread_id_seq; Type: SEQUENCE; Schema: public; Owner: civitai
--

CREATE SEQUENCE public."Thread_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public."Thread_id_seq" OWNER TO civitai;

--
-- Name: Thread_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: civitai
--

ALTER SEQUENCE public."Thread_id_seq" OWNED BY public."Thread".id;


--
-- Name: TipConnection; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."TipConnection" (
    "transactionId" text NOT NULL,
    "entityId" integer NOT NULL,
    "entityType" text NOT NULL
);


ALTER TABLE public."TipConnection" OWNER TO civitai;

--
-- Name: Tool; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."Tool" (
    id integer NOT NULL,
    name text NOT NULL,
    icon text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    type public."ToolType" NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    domain text,
    description text,
    homepage text,
    company text,
    priority integer,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL
);


ALTER TABLE public."Tool" OWNER TO civitai;

--
-- Name: Tool_id_seq; Type: SEQUENCE; Schema: public; Owner: civitai
--

CREATE SEQUENCE public."Tool_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public."Tool_id_seq" OWNER TO civitai;

--
-- Name: Tool_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: civitai
--

ALTER SEQUENCE public."Tool_id_seq" OWNED BY public."Tool".id;


--
-- Name: User; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."User" (
    name text,
    email public.citext,
    "emailVerified" timestamp(3) without time zone,
    image text,
    id integer NOT NULL,
    "blurNsfw" boolean DEFAULT true NOT NULL,
    "showNsfw" boolean DEFAULT false NOT NULL,
    username public.citext,
    "isModerator" boolean DEFAULT false,
    tos boolean DEFAULT false,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "deletedAt" timestamp(3) without time zone,
    "bannedAt" timestamp(3) without time zone,
    "customerId" text,
    "subscriptionId" text,
    "autoplayGifs" boolean DEFAULT true,
    "filePreferences" jsonb DEFAULT '{"fp": "fp16", "size": "pruned", "format": "SafeTensor"}'::jsonb NOT NULL,
    "leaderboardShowcase" text,
    "onboardingSteps" public."OnboardingStep"[] DEFAULT ARRAY['Moderation'::public."OnboardingStep", 'Buzz'::public."OnboardingStep"],
    "profilePictureId" integer,
    meta jsonb DEFAULT '{}'::jsonb,
    settings jsonb DEFAULT '{}'::jsonb,
    "mutedAt" timestamp(3) without time zone,
    muted boolean DEFAULT false NOT NULL,
    "browsingLevel" integer DEFAULT 1 NOT NULL,
    onboarding integer DEFAULT 0 NOT NULL,
    "publicSettings" jsonb DEFAULT '{}'::jsonb,
    "muteConfirmedAt" timestamp(3) without time zone,
    "excludeFromLeaderboards" boolean DEFAULT false NOT NULL,
    "eligibilityChangedAt" timestamp(3) without time zone,
    "rewardsEligibility" public."RewardsEligibility" DEFAULT 'Eligible'::public."RewardsEligibility" NOT NULL,
    "paddleCustomerId" text
);


ALTER TABLE public."User" OWNER TO civitai;

--
-- Name: UserCosmetic; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."UserCosmetic" (
    "userId" integer NOT NULL,
    "cosmeticId" integer NOT NULL,
    "obtainedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "equippedAt" timestamp(3) without time zone,
    data jsonb,
    "claimKey" text DEFAULT 'claimed'::text NOT NULL,
    "equippedToId" integer,
    "equippedToType" public."CosmeticEntity",
    "forId" integer,
    "forType" public."CosmeticEntity"
);


ALTER TABLE public."UserCosmetic" OWNER TO civitai;

--
-- Name: UserCosmeticShopPurchases; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."UserCosmeticShopPurchases" (
    "userId" integer NOT NULL,
    "cosmeticId" integer NOT NULL,
    "shopItemId" integer NOT NULL,
    "purchasedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "buzzTransactionId" text NOT NULL,
    refunded boolean NOT NULL,
    "unitAmount" integer NOT NULL
);


ALTER TABLE public."UserCosmeticShopPurchases" OWNER TO civitai;

--
-- Name: UserEngagement; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."UserEngagement" (
    "userId" integer NOT NULL,
    "targetUserId" integer NOT NULL,
    type public."UserEngagementType" NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


ALTER TABLE public."UserEngagement" OWNER TO civitai;

--
-- Name: UserLink; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."UserLink" (
    id integer NOT NULL,
    "userId" integer NOT NULL,
    url text NOT NULL,
    type public."LinkType" NOT NULL
);


ALTER TABLE public."UserLink" OWNER TO civitai;

--
-- Name: UserLink_id_seq; Type: SEQUENCE; Schema: public; Owner: civitai
--

CREATE SEQUENCE public."UserLink_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public."UserLink_id_seq" OWNER TO civitai;

--
-- Name: UserLink_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: civitai
--

ALTER SEQUENCE public."UserLink_id_seq" OWNED BY public."UserLink".id;


--
-- Name: UserMetric; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."UserMetric" (
    "userId" integer NOT NULL,
    timeframe public."MetricTimeframe" NOT NULL,
    "followingCount" integer DEFAULT 0 NOT NULL,
    "followerCount" integer DEFAULT 0 NOT NULL,
    "hiddenCount" integer DEFAULT 0 NOT NULL,
    "reviewCount" integer DEFAULT 0 NOT NULL,
    "uploadCount" integer DEFAULT 0 NOT NULL,
    "answerAcceptCount" integer DEFAULT 0 NOT NULL,
    "answerCount" integer DEFAULT 0 NOT NULL,
    "updatedAt" timestamp(3) without time zone DEFAULT now(),
    "reactionCount" integer DEFAULT 0 NOT NULL
);


ALTER TABLE public."UserMetric" OWNER TO civitai;

--
-- Name: UserNotificationSettings; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."UserNotificationSettings" (
    id integer NOT NULL,
    "userId" integer NOT NULL,
    type text NOT NULL,
    "disabledAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


ALTER TABLE public."UserNotificationSettings" OWNER TO civitai;

--
-- Name: UserNotificationSettings_id_seq; Type: SEQUENCE; Schema: public; Owner: civitai
--

CREATE SEQUENCE public."UserNotificationSettings_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public."UserNotificationSettings_id_seq" OWNER TO civitai;

--
-- Name: UserNotificationSettings_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: civitai
--

ALTER SEQUENCE public."UserNotificationSettings_id_seq" OWNED BY public."UserNotificationSettings".id;


--
-- Name: UserProfile; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."UserProfile" (
    "userId" integer NOT NULL,
    "coverImageId" integer,
    bio text,
    message text,
    "messageAddedAt" timestamp(3) without time zone,
    "privacySettings" jsonb DEFAULT '{"showFollowerCount": true, "showReviewsRating": true, "showFollowingCount": true}'::jsonb NOT NULL,
    "profileSectionsSettings" jsonb DEFAULT '[{"key": "showcase", "enabled": true}, {"key": "popularModels", "enabled": true}, {"key": "popularArticles", "enabled": true}, {"key": "modelsOverview", "enabled": true}, {"key": "imagesOverview", "enabled": true}, {"key": "recentReviews", "enabled": true}]'::jsonb NOT NULL,
    location text,
    nsfw boolean DEFAULT false NOT NULL,
    "showcaseItems" jsonb DEFAULT '[]'::jsonb NOT NULL
);


ALTER TABLE public."UserProfile" OWNER TO civitai;

--
-- Name: UserPurchasedRewards; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."UserPurchasedRewards" (
    "buzzTransactionId" text NOT NULL,
    "userId" integer,
    "purchasableRewardId" integer,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    meta jsonb DEFAULT '{}'::jsonb NOT NULL,
    code text NOT NULL
);


ALTER TABLE public."UserPurchasedRewards" OWNER TO civitai;

--
-- Name: UserRank; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."UserRank" (
    "userId" integer NOT NULL,
    "leaderboardRank" integer,
    "leaderboardId" text,
    "leaderboardTitle" text,
    "leaderboardCosmetic" text,
    "downloadCountDayRank" bigint,
    "favoriteCountDayRank" bigint,
    "ratingCountDayRank" bigint,
    "ratingDayRank" bigint,
    "followerCountDayRank" bigint,
    "downloadCountWeekRank" bigint,
    "favoriteCountWeekRank" bigint,
    "ratingCountWeekRank" bigint,
    "ratingWeekRank" bigint,
    "followerCountWeekRank" bigint,
    "downloadCountMonthRank" bigint,
    "favoriteCountMonthRank" bigint,
    "ratingCountMonthRank" bigint,
    "ratingMonthRank" bigint,
    "followerCountMonthRank" bigint,
    "downloadCountYearRank" bigint,
    "favoriteCountYearRank" bigint,
    "ratingCountYearRank" bigint,
    "ratingYearRank" bigint,
    "followerCountYearRank" bigint,
    "downloadCountAllTimeRank" bigint,
    "favoriteCountAllTimeRank" bigint,
    "ratingCountAllTimeRank" bigint,
    "ratingAllTimeRank" bigint,
    "followerCountAllTimeRank" bigint,
    "answerCountDayRank" bigint,
    "answerCountWeekRank" bigint,
    "answerCountMonthRank" bigint,
    "answerCountYearRank" bigint,
    "answerCountAllTimeRank" bigint,
    "answerAcceptCountDayRank" bigint,
    "answerAcceptCountWeekRank" bigint,
    "answerAcceptCountMonthRank" bigint,
    "answerAcceptCountYearRank" bigint,
    "answerAcceptCountAllTimeRank" bigint
);


ALTER TABLE public."UserRank" OWNER TO civitai;

--
-- Name: UserStat; Type: VIEW; Schema: public; Owner: doadmin
--

CREATE VIEW public."UserStat" AS
 WITH user_model_metrics_timeframe AS (
         SELECT m."userId",
            mm.timeframe,
            sum(mm."downloadCount") AS "downloadCount",
            sum(mm."generationCount") AS "generationCount",
            sum(mm."favoriteCount") AS "favoriteCount",
            sum(mm."ratingCount") AS "ratingCount",
            public.iif(((sum(mm."ratingCount") IS NULL) OR (sum(mm."ratingCount") <= 0)), (0)::double precision, (sum((mm.rating * (mm."ratingCount")::double precision)) / (sum(mm."ratingCount"))::double precision)) AS rating,
            sum(mm."thumbsUpCount") AS "thumbsUpCount"
           FROM (public."ModelMetric" mm
             JOIN public."Model" m ON ((m.id = mm."modelId")))
          GROUP BY m."userId", mm.timeframe
        ), user_model_metrics AS (
         SELECT user_model_metrics_timeframe."userId",
            max(public.iif((user_model_metrics_timeframe.timeframe = 'Day'::public."MetricTimeframe"), user_model_metrics_timeframe."downloadCount", NULL::bigint)) AS "downloadCountDay",
            max(public.iif((user_model_metrics_timeframe.timeframe = 'Week'::public."MetricTimeframe"), user_model_metrics_timeframe."downloadCount", NULL::bigint)) AS "downloadCountWeek",
            max(public.iif((user_model_metrics_timeframe.timeframe = 'Month'::public."MetricTimeframe"), user_model_metrics_timeframe."downloadCount", NULL::bigint)) AS "downloadCountMonth",
            max(public.iif((user_model_metrics_timeframe.timeframe = 'Year'::public."MetricTimeframe"), user_model_metrics_timeframe."downloadCount", NULL::bigint)) AS "downloadCountYear",
            max(public.iif((user_model_metrics_timeframe.timeframe = 'AllTime'::public."MetricTimeframe"), user_model_metrics_timeframe."downloadCount", NULL::bigint)) AS "downloadCountAllTime",
            max(public.iif((user_model_metrics_timeframe.timeframe = 'Day'::public."MetricTimeframe"), user_model_metrics_timeframe."generationCount", NULL::bigint)) AS "generationCountDay",
            max(public.iif((user_model_metrics_timeframe.timeframe = 'Week'::public."MetricTimeframe"), user_model_metrics_timeframe."generationCount", NULL::bigint)) AS "generationCountWeek",
            max(public.iif((user_model_metrics_timeframe.timeframe = 'Month'::public."MetricTimeframe"), user_model_metrics_timeframe."generationCount", NULL::bigint)) AS "generationCountMonth",
            max(public.iif((user_model_metrics_timeframe.timeframe = 'Year'::public."MetricTimeframe"), user_model_metrics_timeframe."generationCount", NULL::bigint)) AS "generationCountYear",
            max(public.iif((user_model_metrics_timeframe.timeframe = 'AllTime'::public."MetricTimeframe"), user_model_metrics_timeframe."generationCount", NULL::bigint)) AS "generationCountAllTime",
            max(public.iif((user_model_metrics_timeframe.timeframe = 'Day'::public."MetricTimeframe"), user_model_metrics_timeframe."favoriteCount", NULL::bigint)) AS "favoriteCountDay",
            max(public.iif((user_model_metrics_timeframe.timeframe = 'Week'::public."MetricTimeframe"), user_model_metrics_timeframe."favoriteCount", NULL::bigint)) AS "favoriteCountWeek",
            max(public.iif((user_model_metrics_timeframe.timeframe = 'Month'::public."MetricTimeframe"), user_model_metrics_timeframe."favoriteCount", NULL::bigint)) AS "favoriteCountMonth",
            max(public.iif((user_model_metrics_timeframe.timeframe = 'Year'::public."MetricTimeframe"), user_model_metrics_timeframe."favoriteCount", NULL::bigint)) AS "favoriteCountYear",
            max(public.iif((user_model_metrics_timeframe.timeframe = 'AllTime'::public."MetricTimeframe"), user_model_metrics_timeframe."favoriteCount", NULL::bigint)) AS "favoriteCountAllTime",
            max(public.iif((user_model_metrics_timeframe.timeframe = 'Day'::public."MetricTimeframe"), user_model_metrics_timeframe."ratingCount", NULL::bigint)) AS "ratingCountDay",
            max(public.iif((user_model_metrics_timeframe.timeframe = 'Week'::public."MetricTimeframe"), user_model_metrics_timeframe."ratingCount", NULL::bigint)) AS "ratingCountWeek",
            max(public.iif((user_model_metrics_timeframe.timeframe = 'Month'::public."MetricTimeframe"), user_model_metrics_timeframe."ratingCount", NULL::bigint)) AS "ratingCountMonth",
            max(public.iif((user_model_metrics_timeframe.timeframe = 'Year'::public."MetricTimeframe"), user_model_metrics_timeframe."ratingCount", NULL::bigint)) AS "ratingCountYear",
            max(public.iif((user_model_metrics_timeframe.timeframe = 'AllTime'::public."MetricTimeframe"), user_model_metrics_timeframe."ratingCount", NULL::bigint)) AS "ratingCountAllTime",
            max(public.iif((user_model_metrics_timeframe.timeframe = 'Day'::public."MetricTimeframe"), user_model_metrics_timeframe.rating, NULL::double precision)) AS "ratingDay",
            max(public.iif((user_model_metrics_timeframe.timeframe = 'Week'::public."MetricTimeframe"), user_model_metrics_timeframe.rating, NULL::double precision)) AS "ratingWeek",
            max(public.iif((user_model_metrics_timeframe.timeframe = 'Month'::public."MetricTimeframe"), user_model_metrics_timeframe.rating, NULL::double precision)) AS "ratingMonth",
            max(public.iif((user_model_metrics_timeframe.timeframe = 'Year'::public."MetricTimeframe"), user_model_metrics_timeframe.rating, NULL::double precision)) AS "ratingYear",
            max(public.iif((user_model_metrics_timeframe.timeframe = 'AllTime'::public."MetricTimeframe"), user_model_metrics_timeframe.rating, NULL::double precision)) AS "ratingAllTime",
            max(public.iif((user_model_metrics_timeframe.timeframe = 'Day'::public."MetricTimeframe"), user_model_metrics_timeframe."thumbsUpCount", NULL::bigint)) AS "thumbsUpCountDay",
            max(public.iif((user_model_metrics_timeframe.timeframe = 'Week'::public."MetricTimeframe"), user_model_metrics_timeframe."thumbsUpCount", NULL::bigint)) AS "thumbsUpCountWeek",
            max(public.iif((user_model_metrics_timeframe.timeframe = 'Month'::public."MetricTimeframe"), user_model_metrics_timeframe."thumbsUpCount", NULL::bigint)) AS "thumbsUpCountMonth",
            max(public.iif((user_model_metrics_timeframe.timeframe = 'Year'::public."MetricTimeframe"), user_model_metrics_timeframe."thumbsUpCount", NULL::bigint)) AS "thumbsUpCountYear",
            max(public.iif((user_model_metrics_timeframe.timeframe = 'AllTime'::public."MetricTimeframe"), user_model_metrics_timeframe."thumbsUpCount", NULL::bigint)) AS "thumbsUpCountAllTime"
           FROM user_model_metrics_timeframe
          GROUP BY user_model_metrics_timeframe."userId"
        ), user_counts_timeframe AS (
         SELECT um."userId",
            um.timeframe,
            COALESCE(sum(um."followingCount"), (0)::bigint) AS "followingCount",
            COALESCE(sum(um."followerCount"), (0)::bigint) AS "followerCount",
            COALESCE(sum(um."hiddenCount"), (0)::bigint) AS "hiddenCount",
            COALESCE(sum(um."uploadCount"), (0)::bigint) AS "uploadCount",
            COALESCE(sum(um."reviewCount"), (0)::bigint) AS "reviewCount",
            COALESCE(sum(um."answerCount"), (0)::bigint) AS "answerCount",
            COALESCE(sum(um."answerAcceptCount"), (0)::bigint) AS "answerAcceptCount",
            COALESCE(sum(um."reactionCount"), (0)::bigint) AS "reactionCount"
           FROM public."UserMetric" um
          GROUP BY um."userId", um.timeframe
        ), user_counts AS (
         SELECT user_counts_timeframe."userId",
            max(public.iif((user_counts_timeframe.timeframe = 'Day'::public."MetricTimeframe"), user_counts_timeframe."followerCount", NULL::bigint)) AS "followerCountDay",
            max(public.iif((user_counts_timeframe.timeframe = 'Day'::public."MetricTimeframe"), user_counts_timeframe."followingCount", NULL::bigint)) AS "followingCountDay",
            max(public.iif((user_counts_timeframe.timeframe = 'Day'::public."MetricTimeframe"), user_counts_timeframe."hiddenCount", NULL::bigint)) AS "hiddenCountDay",
            max(public.iif((user_counts_timeframe.timeframe = 'Week'::public."MetricTimeframe"), user_counts_timeframe."followerCount", NULL::bigint)) AS "followerCountWeek",
            max(public.iif((user_counts_timeframe.timeframe = 'Week'::public."MetricTimeframe"), user_counts_timeframe."followingCount", NULL::bigint)) AS "followingCountWeek",
            max(public.iif((user_counts_timeframe.timeframe = 'Week'::public."MetricTimeframe"), user_counts_timeframe."hiddenCount", NULL::bigint)) AS "hiddenCountWeek",
            max(public.iif((user_counts_timeframe.timeframe = 'Month'::public."MetricTimeframe"), user_counts_timeframe."followerCount", NULL::bigint)) AS "followerCountMonth",
            max(public.iif((user_counts_timeframe.timeframe = 'Month'::public."MetricTimeframe"), user_counts_timeframe."followingCount", NULL::bigint)) AS "followingCountMonth",
            max(public.iif((user_counts_timeframe.timeframe = 'Month'::public."MetricTimeframe"), user_counts_timeframe."hiddenCount", NULL::bigint)) AS "hiddenCountMonth",
            max(public.iif((user_counts_timeframe.timeframe = 'Year'::public."MetricTimeframe"), user_counts_timeframe."followerCount", NULL::bigint)) AS "followerCountYear",
            max(public.iif((user_counts_timeframe.timeframe = 'Year'::public."MetricTimeframe"), user_counts_timeframe."followingCount", NULL::bigint)) AS "followingCountYear",
            max(public.iif((user_counts_timeframe.timeframe = 'Year'::public."MetricTimeframe"), user_counts_timeframe."hiddenCount", NULL::bigint)) AS "hiddenCountYear",
            max(public.iif((user_counts_timeframe.timeframe = 'AllTime'::public."MetricTimeframe"), user_counts_timeframe."followerCount", NULL::bigint)) AS "followerCountAllTime",
            max(public.iif((user_counts_timeframe.timeframe = 'AllTime'::public."MetricTimeframe"), user_counts_timeframe."followingCount", NULL::bigint)) AS "followingCountAllTime",
            max(public.iif((user_counts_timeframe.timeframe = 'AllTime'::public."MetricTimeframe"), user_counts_timeframe."hiddenCount", NULL::bigint)) AS "hiddenCountAllTime",
            max(public.iif((user_counts_timeframe.timeframe = 'Day'::public."MetricTimeframe"), user_counts_timeframe."uploadCount", NULL::bigint)) AS "uploadCountDay",
            max(public.iif((user_counts_timeframe.timeframe = 'Week'::public."MetricTimeframe"), user_counts_timeframe."uploadCount", NULL::bigint)) AS "uploadCountWeek",
            max(public.iif((user_counts_timeframe.timeframe = 'Month'::public."MetricTimeframe"), user_counts_timeframe."uploadCount", NULL::bigint)) AS "uploadCountMonth",
            max(public.iif((user_counts_timeframe.timeframe = 'Year'::public."MetricTimeframe"), user_counts_timeframe."uploadCount", NULL::bigint)) AS "uploadCountYear",
            max(public.iif((user_counts_timeframe.timeframe = 'AllTime'::public."MetricTimeframe"), user_counts_timeframe."uploadCount", NULL::bigint)) AS "uploadCountAllTime",
            max(public.iif((user_counts_timeframe.timeframe = 'Day'::public."MetricTimeframe"), user_counts_timeframe."reviewCount", NULL::bigint)) AS "reviewCountDay",
            max(public.iif((user_counts_timeframe.timeframe = 'Week'::public."MetricTimeframe"), user_counts_timeframe."reviewCount", NULL::bigint)) AS "reviewCountWeek",
            max(public.iif((user_counts_timeframe.timeframe = 'Month'::public."MetricTimeframe"), user_counts_timeframe."reviewCount", NULL::bigint)) AS "reviewCountMonth",
            max(public.iif((user_counts_timeframe.timeframe = 'Year'::public."MetricTimeframe"), user_counts_timeframe."reviewCount", NULL::bigint)) AS "reviewCountYear",
            max(public.iif((user_counts_timeframe.timeframe = 'AllTime'::public."MetricTimeframe"), user_counts_timeframe."reviewCount", NULL::bigint)) AS "reviewCountAllTime",
            max(public.iif((user_counts_timeframe.timeframe = 'Day'::public."MetricTimeframe"), user_counts_timeframe."answerCount", NULL::bigint)) AS "answerCountDay",
            max(public.iif((user_counts_timeframe.timeframe = 'Week'::public."MetricTimeframe"), user_counts_timeframe."answerCount", NULL::bigint)) AS "answerCountWeek",
            max(public.iif((user_counts_timeframe.timeframe = 'Month'::public."MetricTimeframe"), user_counts_timeframe."answerCount", NULL::bigint)) AS "answerCountMonth",
            max(public.iif((user_counts_timeframe.timeframe = 'Year'::public."MetricTimeframe"), user_counts_timeframe."answerCount", NULL::bigint)) AS "answerCountYear",
            max(public.iif((user_counts_timeframe.timeframe = 'AllTime'::public."MetricTimeframe"), user_counts_timeframe."answerCount", NULL::bigint)) AS "answerCountAllTime",
            max(public.iif((user_counts_timeframe.timeframe = 'Day'::public."MetricTimeframe"), user_counts_timeframe."answerAcceptCount", NULL::bigint)) AS "answerAcceptCountDay",
            max(public.iif((user_counts_timeframe.timeframe = 'Week'::public."MetricTimeframe"), user_counts_timeframe."answerAcceptCount", NULL::bigint)) AS "answerAcceptCountWeek",
            max(public.iif((user_counts_timeframe.timeframe = 'Month'::public."MetricTimeframe"), user_counts_timeframe."answerAcceptCount", NULL::bigint)) AS "answerAcceptCountMonth",
            max(public.iif((user_counts_timeframe.timeframe = 'Year'::public."MetricTimeframe"), user_counts_timeframe."answerAcceptCount", NULL::bigint)) AS "answerAcceptCountYear",
            max(public.iif((user_counts_timeframe.timeframe = 'AllTime'::public."MetricTimeframe"), user_counts_timeframe."answerAcceptCount", NULL::bigint)) AS "answerAcceptCountAllTime",
            max(public.iif((user_counts_timeframe.timeframe = 'Day'::public."MetricTimeframe"), user_counts_timeframe."reactionCount", NULL::bigint)) AS "reactionCountDay",
            max(public.iif((user_counts_timeframe.timeframe = 'Week'::public."MetricTimeframe"), user_counts_timeframe."reactionCount", NULL::bigint)) AS "reactionCountWeek",
            max(public.iif((user_counts_timeframe.timeframe = 'Month'::public."MetricTimeframe"), user_counts_timeframe."reactionCount", NULL::bigint)) AS "reactionCountMonth",
            max(public.iif((user_counts_timeframe.timeframe = 'Year'::public."MetricTimeframe"), user_counts_timeframe."reactionCount", NULL::bigint)) AS "reactionCountYear",
            max(public.iif((user_counts_timeframe.timeframe = 'AllTime'::public."MetricTimeframe"), user_counts_timeframe."reactionCount", NULL::bigint)) AS "reactionCountAllTime"
           FROM user_counts_timeframe
          GROUP BY user_counts_timeframe."userId"
        ), full_user_stats AS (
         SELECT u."userId",
            u."followerCountDay",
            u."followingCountDay",
            u."hiddenCountDay",
            u."followerCountWeek",
            u."followingCountWeek",
            u."hiddenCountWeek",
            u."followerCountMonth",
            u."followingCountMonth",
            u."hiddenCountMonth",
            u."followerCountYear",
            u."followingCountYear",
            u."hiddenCountYear",
            u."followerCountAllTime",
            u."followingCountAllTime",
            u."hiddenCountAllTime",
            u."uploadCountDay",
            u."uploadCountWeek",
            u."uploadCountMonth",
            u."uploadCountYear",
            u."uploadCountAllTime",
            u."reviewCountDay",
            u."reviewCountWeek",
            u."reviewCountMonth",
            u."reviewCountYear",
            u."reviewCountAllTime",
            u."answerCountDay",
            u."answerCountWeek",
            u."answerCountMonth",
            u."answerCountYear",
            u."answerCountAllTime",
            u."answerAcceptCountDay",
            u."answerAcceptCountWeek",
            u."answerAcceptCountMonth",
            u."answerAcceptCountYear",
            u."answerAcceptCountAllTime",
            u."reactionCountDay",
            u."reactionCountWeek",
            u."reactionCountMonth",
            u."reactionCountYear",
            u."reactionCountAllTime",
            COALESCE(m."downloadCountDay", (0)::bigint) AS "downloadCountDay",
            COALESCE(m."downloadCountWeek", (0)::bigint) AS "downloadCountWeek",
            COALESCE(m."downloadCountMonth", (0)::bigint) AS "downloadCountMonth",
            COALESCE(m."downloadCountYear", (0)::bigint) AS "downloadCountYear",
            COALESCE(m."downloadCountAllTime", (0)::bigint) AS "downloadCountAllTime",
            COALESCE(m."generationCountDay", (0)::bigint) AS "generationCountDay",
            COALESCE(m."generationCountWeek", (0)::bigint) AS "generationCountWeek",
            COALESCE(m."generationCountMonth", (0)::bigint) AS "generationCountMonth",
            COALESCE(m."generationCountYear", (0)::bigint) AS "generationCountYear",
            COALESCE(m."generationCountAllTime", (0)::bigint) AS "generationCountAllTime",
            COALESCE(m."favoriteCountDay", (0)::bigint) AS "favoriteCountDay",
            COALESCE(m."favoriteCountWeek", (0)::bigint) AS "favoriteCountWeek",
            COALESCE(m."favoriteCountMonth", (0)::bigint) AS "favoriteCountMonth",
            COALESCE(m."favoriteCountYear", (0)::bigint) AS "favoriteCountYear",
            COALESCE(m."favoriteCountAllTime", (0)::bigint) AS "favoriteCountAllTime",
            COALESCE(m."ratingCountDay", (0)::bigint) AS "ratingCountDay",
            COALESCE(m."ratingCountWeek", (0)::bigint) AS "ratingCountWeek",
            COALESCE(m."ratingCountMonth", (0)::bigint) AS "ratingCountMonth",
            COALESCE(m."ratingCountYear", (0)::bigint) AS "ratingCountYear",
            COALESCE(m."ratingCountAllTime", (0)::bigint) AS "ratingCountAllTime",
            COALESCE(m."ratingDay", (0)::double precision) AS "ratingDay",
            COALESCE(m."ratingWeek", (0)::double precision) AS "ratingWeek",
            COALESCE(m."ratingMonth", (0)::double precision) AS "ratingMonth",
            COALESCE(m."ratingYear", (0)::double precision) AS "ratingYear",
            COALESCE(m."ratingAllTime", (0)::double precision) AS "ratingAllTime",
            COALESCE(m."thumbsUpCountDay", (0)::bigint) AS "thumbsUpCountDay",
            COALESCE(m."thumbsUpCountWeek", (0)::bigint) AS "thumbsUpCountWeek",
            COALESCE(m."thumbsUpCountMonth", (0)::bigint) AS "thumbsUpCountMonth",
            COALESCE(m."thumbsUpCountYear", (0)::bigint) AS "thumbsUpCountYear",
            COALESCE(m."thumbsUpCountAllTime", (0)::bigint) AS "thumbsUpCountAllTime"
           FROM (user_counts u
             LEFT JOIN user_model_metrics m ON ((m."userId" = u."userId")))
        )
 SELECT full_user_stats."userId",
    full_user_stats."followerCountDay",
    full_user_stats."followingCountDay",
    full_user_stats."hiddenCountDay",
    full_user_stats."followerCountWeek",
    full_user_stats."followingCountWeek",
    full_user_stats."hiddenCountWeek",
    full_user_stats."followerCountMonth",
    full_user_stats."followingCountMonth",
    full_user_stats."hiddenCountMonth",
    full_user_stats."followerCountYear",
    full_user_stats."followingCountYear",
    full_user_stats."hiddenCountYear",
    full_user_stats."followerCountAllTime",
    full_user_stats."followingCountAllTime",
    full_user_stats."hiddenCountAllTime",
    full_user_stats."uploadCountDay",
    full_user_stats."uploadCountWeek",
    full_user_stats."uploadCountMonth",
    full_user_stats."uploadCountYear",
    full_user_stats."uploadCountAllTime",
    full_user_stats."reviewCountDay",
    full_user_stats."reviewCountWeek",
    full_user_stats."reviewCountMonth",
    full_user_stats."reviewCountYear",
    full_user_stats."reviewCountAllTime",
    full_user_stats."answerCountDay",
    full_user_stats."answerCountWeek",
    full_user_stats."answerCountMonth",
    full_user_stats."answerCountYear",
    full_user_stats."answerCountAllTime",
    full_user_stats."answerAcceptCountDay",
    full_user_stats."answerAcceptCountWeek",
    full_user_stats."answerAcceptCountMonth",
    full_user_stats."answerAcceptCountYear",
    full_user_stats."answerAcceptCountAllTime",
    full_user_stats."downloadCountDay",
    full_user_stats."downloadCountWeek",
    full_user_stats."downloadCountMonth",
    full_user_stats."downloadCountYear",
    full_user_stats."downloadCountAllTime",
    full_user_stats."generationCountDay",
    full_user_stats."generationCountWeek",
    full_user_stats."generationCountMonth",
    full_user_stats."generationCountYear",
    full_user_stats."generationCountAllTime",
    full_user_stats."favoriteCountDay",
    full_user_stats."favoriteCountWeek",
    full_user_stats."favoriteCountMonth",
    full_user_stats."favoriteCountYear",
    full_user_stats."favoriteCountAllTime",
    full_user_stats."ratingCountDay",
    full_user_stats."ratingCountWeek",
    full_user_stats."ratingCountMonth",
    full_user_stats."ratingCountYear",
    full_user_stats."ratingCountAllTime",
    full_user_stats."ratingDay",
    full_user_stats."ratingWeek",
    full_user_stats."ratingMonth",
    full_user_stats."ratingYear",
    full_user_stats."ratingAllTime",
    full_user_stats."thumbsUpCountDay",
    full_user_stats."thumbsUpCountWeek",
    full_user_stats."thumbsUpCountMonth",
    full_user_stats."thumbsUpCountYear",
    full_user_stats."thumbsUpCountAllTime",
    full_user_stats."reactionCountDay",
    full_user_stats."reactionCountWeek",
    full_user_stats."reactionCountMonth",
    full_user_stats."reactionCountYear",
    full_user_stats."reactionCountAllTime"
   FROM full_user_stats;


ALTER TABLE public."UserStat" OWNER TO doadmin;

--
-- Name: UserRank_Live; Type: VIEW; Schema: public; Owner: doadmin
--

CREATE VIEW public."UserRank_Live" AS
 WITH user_positions AS (
         SELECT lr."userId",
            lr."leaderboardId",
            l.title,
            lr."position",
            row_number() OVER (PARTITION BY lr."userId" ORDER BY lr."position") AS row_num
           FROM ((public."User" u_1
             JOIN public."LeaderboardResult" lr ON ((lr."userId" = u_1.id)))
             JOIN public."Leaderboard" l ON (((l.id = lr."leaderboardId") AND l.public)))
          WHERE ((lr.date = CURRENT_DATE) AND ((u_1."leaderboardShowcase" IS NULL) OR (lr."leaderboardId" = u_1."leaderboardShowcase")))
        ), lowest_position AS (
         SELECT up."userId",
            up."position",
            up."leaderboardId",
            up.title AS "leaderboardTitle",
            ( SELECT (c.data ->> 'url'::text)
                   FROM public."Cosmetic" c
                  WHERE ((c."leaderboardId" = up."leaderboardId") AND (up."position" <= c."leaderboardPosition"))
                  ORDER BY c."leaderboardPosition"
                 LIMIT 1) AS "leaderboardCosmetic"
           FROM user_positions up
          WHERE (up.row_num = 1)
        )
 SELECT us."userId",
    lp."position" AS "leaderboardRank",
    lp."leaderboardId",
    lp."leaderboardTitle",
    lp."leaderboardCosmetic",
    row_number() OVER (ORDER BY us."downloadCountDay" DESC, us."ratingDay" DESC, us."ratingCountDay" DESC, us."favoriteCountDay" DESC, us."userId") AS "downloadCountDayRank",
    row_number() OVER (ORDER BY us."favoriteCountDay" DESC, us."ratingDay" DESC, us."ratingCountDay" DESC, us."downloadCountDay" DESC, us."userId") AS "favoriteCountDayRank",
    row_number() OVER (ORDER BY us."ratingCountDay" DESC, us."ratingDay" DESC, us."favoriteCountDay" DESC, us."downloadCountDay" DESC, us."userId") AS "ratingCountDayRank",
    row_number() OVER (ORDER BY us."ratingDay" DESC, us."ratingCountDay" DESC, us."favoriteCountDay" DESC, us."downloadCountDay" DESC, us."userId") AS "ratingDayRank",
    row_number() OVER (ORDER BY us."followerCountDay" DESC, us."downloadCountDay" DESC, us."favoriteCountDay" DESC, us."ratingCountDay" DESC, us."userId") AS "followerCountDayRank",
    row_number() OVER (ORDER BY us."downloadCountWeek" DESC, us."ratingWeek" DESC, us."ratingCountWeek" DESC, us."favoriteCountWeek" DESC, us."userId") AS "downloadCountWeekRank",
    row_number() OVER (ORDER BY us."favoriteCountWeek" DESC, us."ratingWeek" DESC, us."ratingCountWeek" DESC, us."downloadCountWeek" DESC, us."userId") AS "favoriteCountWeekRank",
    row_number() OVER (ORDER BY us."ratingCountWeek" DESC, us."ratingWeek" DESC, us."favoriteCountWeek" DESC, us."downloadCountWeek" DESC, us."userId") AS "ratingCountWeekRank",
    row_number() OVER (ORDER BY us."ratingWeek" DESC, us."ratingCountWeek" DESC, us."favoriteCountWeek" DESC, us."downloadCountWeek" DESC, us."userId") AS "ratingWeekRank",
    row_number() OVER (ORDER BY us."followerCountWeek" DESC, us."downloadCountWeek" DESC, us."favoriteCountWeek" DESC, us."ratingCountWeek" DESC, us."userId") AS "followerCountWeekRank",
    row_number() OVER (ORDER BY us."downloadCountMonth" DESC, us."ratingMonth" DESC, us."ratingCountMonth" DESC, us."favoriteCountMonth" DESC, us."userId") AS "downloadCountMonthRank",
    row_number() OVER (ORDER BY us."favoriteCountMonth" DESC, us."ratingMonth" DESC, us."ratingCountMonth" DESC, us."downloadCountMonth" DESC, us."userId") AS "favoriteCountMonthRank",
    row_number() OVER (ORDER BY us."ratingCountMonth" DESC, us."ratingMonth" DESC, us."favoriteCountMonth" DESC, us."downloadCountMonth" DESC, us."userId") AS "ratingCountMonthRank",
    row_number() OVER (ORDER BY us."ratingMonth" DESC, us."ratingCountMonth" DESC, us."favoriteCountMonth" DESC, us."downloadCountMonth" DESC, us."userId") AS "ratingMonthRank",
    row_number() OVER (ORDER BY us."followerCountMonth" DESC, us."downloadCountMonth" DESC, us."favoriteCountMonth" DESC, us."ratingCountMonth" DESC, us."userId") AS "followerCountMonthRank",
    row_number() OVER (ORDER BY us."downloadCountYear" DESC, us."ratingYear" DESC, us."ratingCountYear" DESC, us."favoriteCountYear" DESC, us."userId") AS "downloadCountYearRank",
    row_number() OVER (ORDER BY us."favoriteCountYear" DESC, us."ratingYear" DESC, us."ratingCountYear" DESC, us."downloadCountYear" DESC, us."userId") AS "favoriteCountYearRank",
    row_number() OVER (ORDER BY us."ratingCountYear" DESC, us."ratingYear" DESC, us."favoriteCountYear" DESC, us."downloadCountYear" DESC, us."userId") AS "ratingCountYearRank",
    row_number() OVER (ORDER BY us."ratingYear" DESC, us."ratingCountYear" DESC, us."favoriteCountYear" DESC, us."downloadCountYear" DESC, us."userId") AS "ratingYearRank",
    row_number() OVER (ORDER BY us."followerCountYear" DESC, us."downloadCountYear" DESC, us."favoriteCountYear" DESC, us."ratingCountYear" DESC, us."userId") AS "followerCountYearRank",
    row_number() OVER (ORDER BY us."downloadCountAllTime" DESC, us."ratingAllTime" DESC, us."ratingCountAllTime" DESC, us."favoriteCountAllTime" DESC, us."userId") AS "downloadCountAllTimeRank",
    row_number() OVER (ORDER BY us."favoriteCountAllTime" DESC, us."ratingAllTime" DESC, us."ratingCountAllTime" DESC, us."downloadCountAllTime" DESC, us."userId") AS "favoriteCountAllTimeRank",
    row_number() OVER (ORDER BY us."ratingCountAllTime" DESC, us."ratingAllTime" DESC, us."favoriteCountAllTime" DESC, us."downloadCountAllTime" DESC, us."userId") AS "ratingCountAllTimeRank",
    row_number() OVER (ORDER BY us."ratingAllTime" DESC, us."ratingCountAllTime" DESC, us."favoriteCountAllTime" DESC, us."downloadCountAllTime" DESC, us."userId") AS "ratingAllTimeRank",
    row_number() OVER (ORDER BY us."followerCountAllTime" DESC, us."downloadCountAllTime" DESC, us."favoriteCountAllTime" DESC, us."ratingCountAllTime" DESC, us."userId") AS "followerCountAllTimeRank",
    row_number() OVER (ORDER BY us."answerCountDay" DESC, us."answerAcceptCountDay" DESC, us."userId") AS "answerCountDayRank",
    row_number() OVER (ORDER BY us."answerCountWeek" DESC, us."answerAcceptCountWeek" DESC, us."userId") AS "answerCountWeekRank",
    row_number() OVER (ORDER BY us."answerCountMonth" DESC, us."answerAcceptCountMonth" DESC, us."userId") AS "answerCountMonthRank",
    row_number() OVER (ORDER BY us."answerCountYear" DESC, us."answerAcceptCountYear" DESC, us."userId") AS "answerCountYearRank",
    row_number() OVER (ORDER BY us."answerCountAllTime" DESC, us."answerAcceptCountAllTime" DESC, us."userId") AS "answerCountAllTimeRank",
    row_number() OVER (ORDER BY us."answerAcceptCountDay" DESC, us."answerCountDay" DESC, us."userId") AS "answerAcceptCountDayRank",
    row_number() OVER (ORDER BY us."answerAcceptCountWeek" DESC, us."answerCountWeek" DESC, us."userId") AS "answerAcceptCountWeekRank",
    row_number() OVER (ORDER BY us."answerAcceptCountMonth" DESC, us."answerCountMonth" DESC, us."userId") AS "answerAcceptCountMonthRank",
    row_number() OVER (ORDER BY us."answerAcceptCountYear" DESC, us."answerCountYear" DESC, us."userId") AS "answerAcceptCountYearRank",
    row_number() OVER (ORDER BY us."answerAcceptCountAllTime" DESC, us."answerCountAllTime" DESC, us."userId") AS "answerAcceptCountAllTimeRank"
   FROM ((public."UserStat" us
     JOIN public."User" u ON ((u.id = us."userId")))
     LEFT JOIN lowest_position lp ON ((lp."userId" = us."userId")));


ALTER TABLE public."UserRank_Live" OWNER TO doadmin;

--
-- Name: UserReferral; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."UserReferral" (
    id integer NOT NULL,
    "userReferralCodeId" integer,
    source text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "userId" integer NOT NULL,
    note text,
    "landingPage" text,
    "loginRedirectReason" text
);


ALTER TABLE public."UserReferral" OWNER TO civitai;

--
-- Name: UserReferralCode; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."UserReferralCode" (
    id integer NOT NULL,
    "userId" integer NOT NULL,
    code text NOT NULL,
    note text,
    "deletedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


ALTER TABLE public."UserReferralCode" OWNER TO civitai;

--
-- Name: UserReferralCode_id_seq; Type: SEQUENCE; Schema: public; Owner: civitai
--

CREATE SEQUENCE public."UserReferralCode_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public."UserReferralCode_id_seq" OWNER TO civitai;

--
-- Name: UserReferralCode_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: civitai
--

ALTER SEQUENCE public."UserReferralCode_id_seq" OWNED BY public."UserReferralCode".id;


--
-- Name: UserReferral_id_seq; Type: SEQUENCE; Schema: public; Owner: civitai
--

CREATE SEQUENCE public."UserReferral_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public."UserReferral_id_seq" OWNER TO civitai;

--
-- Name: UserReferral_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: civitai
--

ALTER SEQUENCE public."UserReferral_id_seq" OWNED BY public."UserReferral".id;


--
-- Name: UserReport; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."UserReport" (
    "userId" integer NOT NULL,
    "reportId" integer NOT NULL
);


ALTER TABLE public."UserReport" OWNER TO civitai;

--
-- Name: UserStripeConnect; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."UserStripeConnect" (
    "userId" integer NOT NULL,
    "connectedAccountId" text NOT NULL,
    status public."StripeConnectStatus" DEFAULT 'PendingOnboarding'::public."StripeConnectStatus" NOT NULL,
    "payoutsEnabled" boolean DEFAULT false NOT NULL,
    "chargesEnabled" boolean DEFAULT false NOT NULL
);


ALTER TABLE public."UserStripeConnect" OWNER TO civitai;

--
-- Name: User_id_seq; Type: SEQUENCE; Schema: public; Owner: civitai
--

CREATE SEQUENCE public."User_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public."User_id_seq" OWNER TO civitai;

--
-- Name: User_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: civitai
--

ALTER SEQUENCE public."User_id_seq" OWNED BY public."User".id;


--
-- Name: Vault; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."Vault" (
    "userId" integer NOT NULL,
    "storageKb" integer NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    meta jsonb DEFAULT '{}'::jsonb NOT NULL
);


ALTER TABLE public."Vault" OWNER TO civitai;

--
-- Name: VaultItem; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."VaultItem" (
    id integer NOT NULL,
    "vaultId" integer NOT NULL,
    status public."VaultItemStatus" DEFAULT 'Pending'::public."VaultItemStatus" NOT NULL,
    "modelVersionId" integer NOT NULL,
    "modelId" integer NOT NULL,
    "modelName" text NOT NULL,
    "versionName" text NOT NULL,
    "creatorId" integer,
    "creatorName" text NOT NULL,
    type public."ModelType" NOT NULL,
    "baseModel" text NOT NULL,
    category text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "addedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "refreshedAt" timestamp(3) without time zone,
    notes text,
    "detailsSizeKb" integer NOT NULL,
    "imagesSizeKb" integer NOT NULL,
    "modelSizeKb" integer NOT NULL,
    meta jsonb DEFAULT '{}'::jsonb NOT NULL,
    files jsonb DEFAULT '[]'::jsonb NOT NULL
);


ALTER TABLE public."VaultItem" OWNER TO civitai;

--
-- Name: VaultItem_id_seq; Type: SEQUENCE; Schema: public; Owner: civitai
--

CREATE SEQUENCE public."VaultItem_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public."VaultItem_id_seq" OWNER TO civitai;

--
-- Name: VaultItem_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: civitai
--

ALTER SEQUENCE public."VaultItem_id_seq" OWNED BY public."VaultItem".id;


--
-- Name: VerificationToken; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."VerificationToken" (
    identifier text NOT NULL,
    token text NOT NULL,
    expires timestamp(3) without time zone NOT NULL
);


ALTER TABLE public."VerificationToken" OWNER TO civitai;

--
-- Name: Webhook; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."Webhook" (
    id integer NOT NULL,
    url text NOT NULL,
    "notifyOn" text[],
    active boolean DEFAULT false NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "userId" integer NOT NULL
);


ALTER TABLE public."Webhook" OWNER TO civitai;

--
-- Name: Webhook_id_seq; Type: SEQUENCE; Schema: public; Owner: civitai
--

CREATE SEQUENCE public."Webhook_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public."Webhook_id_seq" OWNER TO civitai;

--
-- Name: Webhook_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: civitai
--

ALTER SEQUENCE public."Webhook_id_seq" OWNED BY public."Webhook".id;


--
-- Name: _LicenseToModel; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public."_LicenseToModel" (
    "A" integer NOT NULL,
    "B" integer NOT NULL
);


ALTER TABLE public."_LicenseToModel" OWNER TO civitai;

--
-- Name: _prisma_migrations; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public._prisma_migrations (
    id character varying(36) NOT NULL,
    checksum character varying(64) NOT NULL,
    finished_at timestamp with time zone,
    migration_name character varying(255) NOT NULL,
    logs text,
    rolled_back_at timestamp with time zone,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    applied_steps_count integer DEFAULT 0 NOT NULL
);


ALTER TABLE public._prisma_migrations OWNER TO civitai;

--
-- Name: collection_id_seq; Type: SEQUENCE; Schema: public; Owner: civitai
--

CREATE SEQUENCE public.collection_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.collection_id_seq OWNER TO civitai;

--
-- Name: collection_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: civitai
--

ALTER SEQUENCE public.collection_id_seq OWNED BY public."Collection".id;


--
-- Name: collectionitem_id_seq; Type: SEQUENCE; Schema: public; Owner: civitai
--

CREATE SEQUENCE public.collectionitem_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.collectionitem_id_seq OWNER TO civitai;

--
-- Name: collectionitem_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: civitai
--

ALTER SEQUENCE public.collectionitem_id_seq OWNED BY public."CollectionItem".id;


--
-- Name: cosmetic_id_seq; Type: SEQUENCE; Schema: public; Owner: civitai
--

CREATE SEQUENCE public.cosmetic_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.cosmetic_id_seq OWNER TO civitai;

--
-- Name: cosmetic_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: civitai
--

ALTER SEQUENCE public.cosmetic_id_seq OWNED BY public."Cosmetic".id;


--
-- Name: homeblock_id_seq; Type: SEQUENCE; Schema: public; Owner: civitai
--

CREATE SEQUENCE public.homeblock_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.homeblock_id_seq OWNER TO civitai;

--
-- Name: homeblock_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: civitai
--

ALTER SEQUENCE public.homeblock_id_seq OWNED BY public."HomeBlock".id;


--
-- Name: internal_leaderboard_models; Type: VIEW; Schema: public; Owner: doadmin
--

CREATE VIEW public.internal_leaderboard_models AS
 WITH entries AS (
         SELECT m."userId",
            (((((mvm."downloadCount" / 10) + (mvm."thumbsUpCount" * 3)) + (mvm."generationCount" / 100)))::numeric * ((1)::numeric - ((1)::numeric * ((EXTRACT(day FROM (now() - (mv."publishedAt")::timestamp with time zone)) / (30)::numeric) ^ (2)::numeric)))) AS score,
            mvm."thumbsUpCount",
            mvm."generationCount",
            mvm."downloadCount",
            mv."publishedAt",
            (m.meta ->> 'imageNsfw'::text) AS "nsfwLevel"
           FROM ((public."ModelVersionMetric" mvm
             JOIN public."ModelVersion" mv ON ((mv.id = mvm."modelVersionId")))
             JOIN public."Model" m ON ((mv."modelId" = m.id)))
          WHERE ((mv."publishedAt" > (CURRENT_DATE - '30 days'::interval)) AND (mvm.timeframe = 'Month'::public."MetricTimeframe") AND (mv.status = 'Published'::public."ModelStatus") AND (m.status = 'Published'::public."ModelStatus"))
        ), entries_ranked AS (
         SELECT entries."userId",
            entries.score,
            entries."thumbsUpCount",
            entries."generationCount",
            entries."downloadCount",
            entries."publishedAt",
            entries."nsfwLevel",
            row_number() OVER (PARTITION BY entries."userId" ORDER BY entries.score DESC) AS rank
           FROM entries
        ), entries_multiplied AS (
         SELECT entries_ranked."userId",
            entries_ranked.score,
            entries_ranked."thumbsUpCount",
            entries_ranked."generationCount",
            entries_ranked."downloadCount",
            entries_ranked."publishedAt",
            entries_ranked."nsfwLevel",
            entries_ranked.rank,
            GREATEST((0)::double precision, ((1)::double precision - ((entries_ranked.rank)::double precision / (60)::double precision))) AS quantity_multiplier
           FROM entries_ranked
        )
 SELECT entries_multiplied."userId",
    entries_multiplied.score,
    entries_multiplied."thumbsUpCount",
    entries_multiplied."generationCount",
    entries_multiplied."downloadCount",
    entries_multiplied."publishedAt",
    entries_multiplied."nsfwLevel",
    entries_multiplied.rank,
    entries_multiplied.quantity_multiplier
   FROM entries_multiplied;


ALTER TABLE public.internal_leaderboard_models OWNER TO doadmin;

--
-- Name: research_ratings; Type: TABLE; Schema: public; Owner: doadmin
--

CREATE TABLE public.research_ratings (
    "userId" integer NOT NULL,
    "imageId" integer NOT NULL,
    "nsfwLevel" integer NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT now(),
    sane boolean DEFAULT true
);


ALTER TABLE public.research_ratings OWNER TO doadmin;

--
-- Name: research_ratings_resets; Type: TABLE; Schema: public; Owner: doadmin
--

CREATE TABLE public.research_ratings_resets (
    "userId" integer NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.research_ratings_resets OWNER TO doadmin;

--
-- Name: subscriptions; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public.subscriptions (
    id text,
    "Customer ID" text,
    "Customer Description" text,
    "Customer Email" text,
    "Plan" text,
    "Quantity" integer,
    "Interval" text,
    "Amount" double precision,
    "Status" text,
    "Created (UTC)" text,
    "Start Date (UTC)" text,
    "Current Period Start (UTC)" text,
    "Current Period End (UTC)" text,
    "Customer Name" text,
    "manuallyCharged (metadata)" text
);


ALTER TABLE public.subscriptions OWNER TO civitai;

--
-- Name: temp_deleted_user_posts; Type: TABLE; Schema: public; Owner: doadmin
--

CREATE TABLE public.temp_deleted_user_posts (
    id integer
);


ALTER TABLE public.temp_deleted_user_posts OWNER TO doadmin;

--
-- Name: temp_goals; Type: TABLE; Schema: public; Owner: doadmin
--

CREATE TABLE public.temp_goals (
    "modelVersionId" integer,
    "goalAmount" integer,
    "paidAmount" integer,
    total bigint
);


ALTER TABLE public.temp_goals OWNER TO doadmin;

--
-- Name: temp_model_files; Type: TABLE; Schema: public; Owner: doadmin
--

CREATE TABLE public.temp_model_files (
    id integer
);


ALTER TABLE public.temp_model_files OWNER TO doadmin;

--
-- Name: temp_paddle_import; Type: TABLE; Schema: public; Owner: doadmin
--

CREATE TABLE public.temp_paddle_import (
    record_id text,
    external_id text,
    subscription_paddle_id text,
    customer_paddle_id text
);


ALTER TABLE public.temp_paddle_import OWNER TO doadmin;

--
-- Name: tmp_s; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public.tmp_s (
    id text,
    "Customer ID" text,
    "Customer Email" text,
    "Plan" text,
    "Product" text,
    "Status" text,
    "Created (UTC)" timestamp without time zone,
    "Current Period Start (UTC)" timestamp without time zone,
    "Current Period End (UTC)" timestamp without time zone,
    "Canceled At (UTC)" timestamp without time zone,
    "manuallyCharged (metadata)" text
);


ALTER TABLE public.tmp_s OWNER TO civitai;

--
-- Name: untitled_table_419; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public.untitled_table_419 (
    id integer NOT NULL
);


ALTER TABLE public.untitled_table_419 OWNER TO civitai;

--
-- Name: untitled_table_419_id_seq; Type: SEQUENCE; Schema: public; Owner: civitai
--

CREATE SEQUENCE public.untitled_table_419_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.untitled_table_419_id_seq OWNER TO civitai;

--
-- Name: untitled_table_419_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: civitai
--

ALTER SEQUENCE public.untitled_table_419_id_seq OWNED BY public.untitled_table_419.id;


--
-- Name: untitled_table_420; Type: TABLE; Schema: public; Owner: civitai
--

CREATE TABLE public.untitled_table_420 (
    id integer NOT NULL
);


ALTER TABLE public.untitled_table_420 OWNER TO civitai;

--
-- Name: untitled_table_420_id_seq; Type: SEQUENCE; Schema: public; Owner: civitai
--

CREATE SEQUENCE public.untitled_table_420_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.untitled_table_420_id_seq OWNER TO civitai;

--
-- Name: untitled_table_420_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: civitai
--

ALTER SEQUENCE public.untitled_table_420_id_seq OWNED BY public.untitled_table_420.id;


--
-- Name: username_bak; Type: TABLE; Schema: public; Owner: doadmin
--

CREATE TABLE public.username_bak (
    id integer NOT NULL,
    username public.citext,
    email text
);


ALTER TABLE public.username_bak OWNER TO doadmin;

--
-- Name: username_bak_id_seq; Type: SEQUENCE; Schema: public; Owner: doadmin
--

CREATE SEQUENCE public.username_bak_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.username_bak_id_seq OWNER TO doadmin;

--
-- Name: username_bak_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: doadmin
--

ALTER SEQUENCE public.username_bak_id_seq OWNED BY public.username_bak.id;


--
-- Name: Account id; Type: DEFAULT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Account" ALTER COLUMN id SET DEFAULT nextval('public."Account_id_seq"'::regclass);


--
-- Name: Announcement id; Type: DEFAULT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Announcement" ALTER COLUMN id SET DEFAULT nextval('public."Announcement_id_seq"'::regclass);


--
-- Name: Answer id; Type: DEFAULT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Answer" ALTER COLUMN id SET DEFAULT nextval('public."Answer_id_seq"'::regclass);


--
-- Name: AnswerReaction id; Type: DEFAULT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."AnswerReaction" ALTER COLUMN id SET DEFAULT nextval('public."AnswerReaction_id_seq"'::regclass);


--
-- Name: ApiKey id; Type: DEFAULT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ApiKey" ALTER COLUMN id SET DEFAULT nextval('public."ApiKey_id_seq"'::regclass);


--
-- Name: Article id; Type: DEFAULT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Article" ALTER COLUMN id SET DEFAULT nextval('public."Article_id_seq"'::regclass);


--
-- Name: ArticleReaction id; Type: DEFAULT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ArticleReaction" ALTER COLUMN id SET DEFAULT nextval('public."ArticleReaction_id_seq"'::regclass);


--
-- Name: Bounty id; Type: DEFAULT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Bounty" ALTER COLUMN id SET DEFAULT nextval('public."Bounty_id_seq"'::regclass);


--
-- Name: BountyEntry id; Type: DEFAULT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."BountyEntry" ALTER COLUMN id SET DEFAULT nextval('public."BountyEntry_id_seq"'::regclass);


--
-- Name: BuildGuide id; Type: DEFAULT; Schema: public; Owner: doadmin
--

ALTER TABLE ONLY public."BuildGuide" ALTER COLUMN id SET DEFAULT nextval('public."BuildGuide_id_seq"'::regclass);


--
-- Name: Chat id; Type: DEFAULT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Chat" ALTER COLUMN id SET DEFAULT nextval('public."Chat_id_seq"'::regclass);


--
-- Name: ChatMember id; Type: DEFAULT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ChatMember" ALTER COLUMN id SET DEFAULT nextval('public."ChatMember_id_seq"'::regclass);


--
-- Name: ChatMessage id; Type: DEFAULT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ChatMessage" ALTER COLUMN id SET DEFAULT nextval('public."ChatMessage_id_seq"'::regclass);


--
-- Name: Club id; Type: DEFAULT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Club" ALTER COLUMN id SET DEFAULT nextval('public."Club_id_seq"'::regclass);


--
-- Name: ClubMembership id; Type: DEFAULT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ClubMembership" ALTER COLUMN id SET DEFAULT nextval('public."ClubMembership_id_seq"'::regclass);


--
-- Name: ClubMembershipCharge id; Type: DEFAULT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ClubMembershipCharge" ALTER COLUMN id SET DEFAULT nextval('public."ClubMembershipCharge_id_seq"'::regclass);


--
-- Name: ClubPost id; Type: DEFAULT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ClubPost" ALTER COLUMN id SET DEFAULT nextval('public."ClubPost_id_seq"'::regclass);


--
-- Name: ClubPostReaction id; Type: DEFAULT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ClubPostReaction" ALTER COLUMN id SET DEFAULT nextval('public."ClubPostReaction_id_seq"'::regclass);


--
-- Name: ClubTier id; Type: DEFAULT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ClubTier" ALTER COLUMN id SET DEFAULT nextval('public."ClubTier_id_seq"'::regclass);


--
-- Name: Collection id; Type: DEFAULT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Collection" ALTER COLUMN id SET DEFAULT nextval('public.collection_id_seq'::regclass);


--
-- Name: CollectionItem id; Type: DEFAULT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."CollectionItem" ALTER COLUMN id SET DEFAULT nextval('public.collectionitem_id_seq'::regclass);


--
-- Name: Comment id; Type: DEFAULT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Comment" ALTER COLUMN id SET DEFAULT nextval('public."Comment_id_seq"'::regclass);


--
-- Name: CommentReaction id; Type: DEFAULT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."CommentReaction" ALTER COLUMN id SET DEFAULT nextval('public."CommentReaction_id_seq"'::regclass);


--
-- Name: CommentV2 id; Type: DEFAULT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."CommentV2" ALTER COLUMN id SET DEFAULT nextval('public."CommentV2_id_seq"'::regclass);


--
-- Name: CommentV2Reaction id; Type: DEFAULT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."CommentV2Reaction" ALTER COLUMN id SET DEFAULT nextval('public."CommentV2Reaction_id_seq"'::regclass);


--
-- Name: Cosmetic id; Type: DEFAULT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Cosmetic" ALTER COLUMN id SET DEFAULT nextval('public.cosmetic_id_seq'::regclass);


--
-- Name: CosmeticShopItem id; Type: DEFAULT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."CosmeticShopItem" ALTER COLUMN id SET DEFAULT nextval('public."CosmeticShopItem_id_seq"'::regclass);


--
-- Name: CosmeticShopSection id; Type: DEFAULT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."CosmeticShopSection" ALTER COLUMN id SET DEFAULT nextval('public."CosmeticShopSection_id_seq"'::regclass);


--
-- Name: CsamReport id; Type: DEFAULT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."CsamReport" ALTER COLUMN id SET DEFAULT nextval('public."CsamReport_id_seq"'::regclass);


--
-- Name: Donation id; Type: DEFAULT; Schema: public; Owner: doadmin
--

ALTER TABLE ONLY public."Donation" ALTER COLUMN id SET DEFAULT nextval('public."Donation_id_seq"'::regclass);


--
-- Name: DonationGoal id; Type: DEFAULT; Schema: public; Owner: doadmin
--

ALTER TABLE ONLY public."DonationGoal" ALTER COLUMN id SET DEFAULT nextval('public."DonationGoal_id_seq"'::regclass);


--
-- Name: File id; Type: DEFAULT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."File" ALTER COLUMN id SET DEFAULT nextval('public."File_id_seq"'::regclass);


--
-- Name: HomeBlock id; Type: DEFAULT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."HomeBlock" ALTER COLUMN id SET DEFAULT nextval('public.homeblock_id_seq'::regclass);


--
-- Name: Image id; Type: DEFAULT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Image" ALTER COLUMN id SET DEFAULT nextval('public."Image_id_seq"'::regclass);


--
-- Name: ImageReaction id; Type: DEFAULT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ImageReaction" ALTER COLUMN id SET DEFAULT nextval('public."ImageReaction_id_seq"'::regclass);


--
-- Name: ImageResource id; Type: DEFAULT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ImageResource" ALTER COLUMN id SET DEFAULT nextval('public."ImageResource_id_seq"'::regclass);


--
-- Name: Import id; Type: DEFAULT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Import" ALTER COLUMN id SET DEFAULT nextval('public."Import_id_seq"'::regclass);


--
-- Name: License id; Type: DEFAULT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."License" ALTER COLUMN id SET DEFAULT nextval('public."License_id_seq"'::regclass);


--
-- Name: Link id; Type: DEFAULT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Link" ALTER COLUMN id SET DEFAULT nextval('public."Link_id_seq"'::regclass);


--
-- Name: ModActivity id; Type: DEFAULT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ModActivity" ALTER COLUMN id SET DEFAULT nextval('public."ModActivity_id_seq"'::regclass);


--
-- Name: Model id; Type: DEFAULT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Model" ALTER COLUMN id SET DEFAULT nextval('public."Model_id_seq"'::regclass);


--
-- Name: ModelAssociations id; Type: DEFAULT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ModelAssociations" ALTER COLUMN id SET DEFAULT nextval('public."ModelAssociations_id_seq"'::regclass);


--
-- Name: ModelFile id; Type: DEFAULT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ModelFile" ALTER COLUMN id SET DEFAULT nextval('public."ModelFile_id_seq"'::regclass);


--
-- Name: ModelVersion id; Type: DEFAULT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ModelVersion" ALTER COLUMN id SET DEFAULT nextval('public."ModelVersion_id_seq"'::regclass);


--
-- Name: ModelVersionMonetization id; Type: DEFAULT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ModelVersionMonetization" ALTER COLUMN id SET DEFAULT nextval('public."ModelVersionMonetization_id_seq"'::regclass);


--
-- Name: ModelVersionSponsorshipSettings id; Type: DEFAULT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ModelVersionSponsorshipSettings" ALTER COLUMN id SET DEFAULT nextval('public."ModelVersionSponsorshipSettings_id_seq"'::regclass);


--
-- Name: Partner id; Type: DEFAULT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Partner" ALTER COLUMN id SET DEFAULT nextval('public."Partner_id_seq"'::regclass);


--
-- Name: Post id; Type: DEFAULT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Post" ALTER COLUMN id SET DEFAULT nextval('public."Post_id_seq"'::regclass);


--
-- Name: PostReaction id; Type: DEFAULT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."PostReaction" ALTER COLUMN id SET DEFAULT nextval('public."PostReaction_id_seq"'::regclass);


--
-- Name: PressMention id; Type: DEFAULT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."PressMention" ALTER COLUMN id SET DEFAULT nextval('public."PressMention_id_seq"'::regclass);


--
-- Name: PurchasableReward id; Type: DEFAULT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."PurchasableReward" ALTER COLUMN id SET DEFAULT nextval('public."PurchasableReward_id_seq"'::regclass);


--
-- Name: Purchase id; Type: DEFAULT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Purchase" ALTER COLUMN id SET DEFAULT nextval('public."Purchase_id_seq"'::regclass);


--
-- Name: QueryDurationLog id; Type: DEFAULT; Schema: public; Owner: doadmin
--

ALTER TABLE ONLY public."QueryDurationLog" ALTER COLUMN id SET DEFAULT nextval('public."QueryDurationLog_id_seq"'::regclass);


--
-- Name: QueryParamsLog id; Type: DEFAULT; Schema: public; Owner: doadmin
--

ALTER TABLE ONLY public."QueryParamsLog" ALTER COLUMN id SET DEFAULT nextval('public."QueryParamsLog_id_seq"'::regclass);


--
-- Name: QuerySqlLog id; Type: DEFAULT; Schema: public; Owner: doadmin
--

ALTER TABLE ONLY public."QuerySqlLog" ALTER COLUMN id SET DEFAULT nextval('public."QuerySqlLog_id_seq"'::regclass);


--
-- Name: Question id; Type: DEFAULT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Question" ALTER COLUMN id SET DEFAULT nextval('public."Question_id_seq"'::regclass);


--
-- Name: QuestionReaction id; Type: DEFAULT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."QuestionReaction" ALTER COLUMN id SET DEFAULT nextval('public."QuestionReaction_id_seq"'::regclass);


--
-- Name: RecommendedResource id; Type: DEFAULT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."RecommendedResource" ALTER COLUMN id SET DEFAULT nextval('public."RecommendedResource_id_seq"'::regclass);


--
-- Name: Report id; Type: DEFAULT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Report" ALTER COLUMN id SET DEFAULT nextval('public."Report_id_seq"'::regclass);


--
-- Name: ResourceReview id; Type: DEFAULT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ResourceReview" ALTER COLUMN id SET DEFAULT nextval('public."ResourceReview_id_seq"'::regclass);


--
-- Name: ResourceReviewReaction id; Type: DEFAULT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ResourceReviewReaction" ALTER COLUMN id SET DEFAULT nextval('public."ResourceReviewReaction_id_seq"'::regclass);


--
-- Name: Session id; Type: DEFAULT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Session" ALTER COLUMN id SET DEFAULT nextval('public."Session_id_seq"'::regclass);


--
-- Name: Tag id; Type: DEFAULT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Tag" ALTER COLUMN id SET DEFAULT nextval('public."Tag_id_seq"'::regclass);


--
-- Name: Technique id; Type: DEFAULT; Schema: public; Owner: doadmin
--

ALTER TABLE ONLY public."Technique" ALTER COLUMN id SET DEFAULT nextval('public."Technique_id_seq"'::regclass);


--
-- Name: Thread id; Type: DEFAULT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Thread" ALTER COLUMN id SET DEFAULT nextval('public."Thread_id_seq"'::regclass);


--
-- Name: Tool id; Type: DEFAULT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Tool" ALTER COLUMN id SET DEFAULT nextval('public."Tool_id_seq"'::regclass);


--
-- Name: User id; Type: DEFAULT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."User" ALTER COLUMN id SET DEFAULT nextval('public."User_id_seq"'::regclass);


--
-- Name: UserLink id; Type: DEFAULT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."UserLink" ALTER COLUMN id SET DEFAULT nextval('public."UserLink_id_seq"'::regclass);


--
-- Name: UserNotificationSettings id; Type: DEFAULT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."UserNotificationSettings" ALTER COLUMN id SET DEFAULT nextval('public."UserNotificationSettings_id_seq"'::regclass);


--
-- Name: UserReferral id; Type: DEFAULT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."UserReferral" ALTER COLUMN id SET DEFAULT nextval('public."UserReferral_id_seq"'::regclass);


--
-- Name: UserReferralCode id; Type: DEFAULT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."UserReferralCode" ALTER COLUMN id SET DEFAULT nextval('public."UserReferralCode_id_seq"'::regclass);


--
-- Name: VaultItem id; Type: DEFAULT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."VaultItem" ALTER COLUMN id SET DEFAULT nextval('public."VaultItem_id_seq"'::regclass);


--
-- Name: Webhook id; Type: DEFAULT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Webhook" ALTER COLUMN id SET DEFAULT nextval('public."Webhook_id_seq"'::regclass);


--
-- Name: untitled_table_419 id; Type: DEFAULT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public.untitled_table_419 ALTER COLUMN id SET DEFAULT nextval('public.untitled_table_419_id_seq'::regclass);


--
-- Name: untitled_table_420 id; Type: DEFAULT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public.untitled_table_420 ALTER COLUMN id SET DEFAULT nextval('public.untitled_table_420_id_seq'::regclass);


--
-- Name: username_bak id; Type: DEFAULT; Schema: public; Owner: doadmin
--

ALTER TABLE ONLY public.username_bak ALTER COLUMN id SET DEFAULT nextval('public.username_bak_id_seq'::regclass);


--
-- Name: Account Account_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Account"
    ADD CONSTRAINT "Account_pkey" PRIMARY KEY (id);


--
-- Name: Announcement Announcement_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Announcement"
    ADD CONSTRAINT "Announcement_pkey" PRIMARY KEY (id);


--
-- Name: AnswerMetric AnswerMetric_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."AnswerMetric"
    ADD CONSTRAINT "AnswerMetric_pkey" PRIMARY KEY ("answerId", timeframe);


--
-- Name: AnswerReaction AnswerReaction_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."AnswerReaction"
    ADD CONSTRAINT "AnswerReaction_pkey" PRIMARY KEY (id);


--
-- Name: AnswerVote AnswerVote_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."AnswerVote"
    ADD CONSTRAINT "AnswerVote_pkey" PRIMARY KEY ("answerId", "userId");


--
-- Name: Answer Answer_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Answer"
    ADD CONSTRAINT "Answer_pkey" PRIMARY KEY (id);


--
-- Name: ApiKey ApiKey_key_unique; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ApiKey"
    ADD CONSTRAINT "ApiKey_key_unique" UNIQUE (key);


--
-- Name: ApiKey ApiKey_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ApiKey"
    ADD CONSTRAINT "ApiKey_pkey" PRIMARY KEY (id);


--
-- Name: ArticleEngagement ArticleEngagement_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ArticleEngagement"
    ADD CONSTRAINT "ArticleEngagement_pkey" PRIMARY KEY ("userId", "articleId");


--
-- Name: ArticleMetric ArticleMetric_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ArticleMetric"
    ADD CONSTRAINT "ArticleMetric_pkey" PRIMARY KEY ("articleId", timeframe);


--
-- Name: ArticleReaction ArticleReaction_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ArticleReaction"
    ADD CONSTRAINT "ArticleReaction_pkey" PRIMARY KEY (id);


--
-- Name: ArticleReport ArticleReport_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ArticleReport"
    ADD CONSTRAINT "ArticleReport_pkey" PRIMARY KEY ("reportId", "articleId");


--
-- Name: Article Article_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Article"
    ADD CONSTRAINT "Article_pkey" PRIMARY KEY (id);


--
-- Name: BountyBenefactor BountyBenefactor_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."BountyBenefactor"
    ADD CONSTRAINT "BountyBenefactor_pkey" PRIMARY KEY ("bountyId", "userId");


--
-- Name: BountyEngagement BountyEngagement_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."BountyEngagement"
    ADD CONSTRAINT "BountyEngagement_pkey" PRIMARY KEY (type, "bountyId", "userId");


--
-- Name: BountyEntryMetric BountyEntryMetric_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."BountyEntryMetric"
    ADD CONSTRAINT "BountyEntryMetric_pkey" PRIMARY KEY ("bountyEntryId", timeframe);


--
-- Name: BountyEntryReaction BountyEntryReaction_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."BountyEntryReaction"
    ADD CONSTRAINT "BountyEntryReaction_pkey" PRIMARY KEY ("bountyEntryId", "userId", reaction);


--
-- Name: BountyEntryReport BountyEntryReport_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."BountyEntryReport"
    ADD CONSTRAINT "BountyEntryReport_pkey" PRIMARY KEY ("reportId", "bountyEntryId");


--
-- Name: BountyEntry BountyEntry_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."BountyEntry"
    ADD CONSTRAINT "BountyEntry_pkey" PRIMARY KEY (id);


--
-- Name: BountyMetric BountyMetric_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."BountyMetric"
    ADD CONSTRAINT "BountyMetric_pkey" PRIMARY KEY ("bountyId", timeframe);


--
-- Name: BountyReport BountyReport_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."BountyReport"
    ADD CONSTRAINT "BountyReport_pkey" PRIMARY KEY ("reportId", "bountyId");


--
-- Name: Bounty Bounty_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Bounty"
    ADD CONSTRAINT "Bounty_pkey" PRIMARY KEY (id);


--
-- Name: BuildGuide BuildGuide_pkey; Type: CONSTRAINT; Schema: public; Owner: doadmin
--

ALTER TABLE ONLY public."BuildGuide"
    ADD CONSTRAINT "BuildGuide_pkey" PRIMARY KEY (id);


--
-- Name: BuzzClaim BuzzClaim_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."BuzzClaim"
    ADD CONSTRAINT "BuzzClaim_pkey" PRIMARY KEY (key);


--
-- Name: BuzzTip BuzzTip_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."BuzzTip"
    ADD CONSTRAINT "BuzzTip_pkey" PRIMARY KEY ("entityType", "entityId", "fromUserId");


--
-- Name: BuzzWithdrawalRequestHistory BuzzWithdrawalRequestHistory_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."BuzzWithdrawalRequestHistory"
    ADD CONSTRAINT "BuzzWithdrawalRequestHistory_pkey" PRIMARY KEY (id);


--
-- Name: BuzzWithdrawalRequest BuzzWithdrawalRequest_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."BuzzWithdrawalRequest"
    ADD CONSTRAINT "BuzzWithdrawalRequest_pkey" PRIMARY KEY (id);


--
-- Name: ChatMember ChatMember_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ChatMember"
    ADD CONSTRAINT "ChatMember_pkey" PRIMARY KEY (id);


--
-- Name: ChatMessage ChatMessage_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ChatMessage"
    ADD CONSTRAINT "ChatMessage_pkey" PRIMARY KEY (id);


--
-- Name: ChatReport ChatReport_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ChatReport"
    ADD CONSTRAINT "ChatReport_pkey" PRIMARY KEY ("reportId", "chatId");


--
-- Name: Chat Chat_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Chat"
    ADD CONSTRAINT "Chat_pkey" PRIMARY KEY (id);


--
-- Name: ClubAdminInvite ClubAdminInvite_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ClubAdminInvite"
    ADD CONSTRAINT "ClubAdminInvite_pkey" PRIMARY KEY (id);


--
-- Name: ClubAdmin ClubAdmin_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ClubAdmin"
    ADD CONSTRAINT "ClubAdmin_pkey" PRIMARY KEY ("clubId", "userId");


--
-- Name: ClubMembershipCharge ClubMembershipCharge_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ClubMembershipCharge"
    ADD CONSTRAINT "ClubMembershipCharge_pkey" PRIMARY KEY (id);


--
-- Name: ClubMembership ClubMembership_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ClubMembership"
    ADD CONSTRAINT "ClubMembership_pkey" PRIMARY KEY (id);


--
-- Name: ClubMetric ClubMetric_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ClubMetric"
    ADD CONSTRAINT "ClubMetric_pkey" PRIMARY KEY ("clubId", timeframe);


--
-- Name: ClubPostMetric ClubPostMetric_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ClubPostMetric"
    ADD CONSTRAINT "ClubPostMetric_pkey" PRIMARY KEY ("clubPostId", timeframe);


--
-- Name: ClubPostReaction ClubPostReaction_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ClubPostReaction"
    ADD CONSTRAINT "ClubPostReaction_pkey" PRIMARY KEY (id);


--
-- Name: ClubPost ClubPost_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ClubPost"
    ADD CONSTRAINT "ClubPost_pkey" PRIMARY KEY (id);


--
-- Name: ClubTier ClubTier_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ClubTier"
    ADD CONSTRAINT "ClubTier_pkey" PRIMARY KEY (id);


--
-- Name: Club Club_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Club"
    ADD CONSTRAINT "Club_pkey" PRIMARY KEY (id);


--
-- Name: CollectionContributor CollectionContributor_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."CollectionContributor"
    ADD CONSTRAINT "CollectionContributor_pkey" PRIMARY KEY ("userId", "collectionId");


--
-- Name: CollectionItem CollectionItem_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."CollectionItem"
    ADD CONSTRAINT "CollectionItem_pkey" PRIMARY KEY (id);


--
-- Name: CollectionMetric CollectionMetric_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."CollectionMetric"
    ADD CONSTRAINT "CollectionMetric_pkey" PRIMARY KEY ("collectionId", timeframe);


--
-- Name: CollectionReport CollectionReport_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."CollectionReport"
    ADD CONSTRAINT "CollectionReport_pkey" PRIMARY KEY ("reportId", "collectionId");


--
-- Name: Collection Collection_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Collection"
    ADD CONSTRAINT "Collection_pkey" PRIMARY KEY (id);


--
-- Name: CommentReaction CommentReaction_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."CommentReaction"
    ADD CONSTRAINT "CommentReaction_pkey" PRIMARY KEY (id);


--
-- Name: CommentReport CommentReport_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."CommentReport"
    ADD CONSTRAINT "CommentReport_pkey" PRIMARY KEY ("reportId", "commentId");


--
-- Name: CommentV2Reaction CommentV2Reaction_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."CommentV2Reaction"
    ADD CONSTRAINT "CommentV2Reaction_pkey" PRIMARY KEY (id);


--
-- Name: CommentV2Report CommentV2Report_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."CommentV2Report"
    ADD CONSTRAINT "CommentV2Report_pkey" PRIMARY KEY ("reportId", "commentV2Id");


--
-- Name: CommentV2 CommentV2_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."CommentV2"
    ADD CONSTRAINT "CommentV2_pkey" PRIMARY KEY (id);


--
-- Name: Comment Comment_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Comment"
    ADD CONSTRAINT "Comment_pkey" PRIMARY KEY (id);


--
-- Name: CosmeticShopItem CosmeticShopItem_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."CosmeticShopItem"
    ADD CONSTRAINT "CosmeticShopItem_pkey" PRIMARY KEY (id);


--
-- Name: CosmeticShopSectionItem CosmeticShopSectionItem_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."CosmeticShopSectionItem"
    ADD CONSTRAINT "CosmeticShopSectionItem_pkey" PRIMARY KEY ("shopItemId", "shopSectionId");


--
-- Name: CosmeticShopSection CosmeticShopSection_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."CosmeticShopSection"
    ADD CONSTRAINT "CosmeticShopSection_pkey" PRIMARY KEY (id);


--
-- Name: Cosmetic Cosmetic_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Cosmetic"
    ADD CONSTRAINT "Cosmetic_pkey" PRIMARY KEY (id);


--
-- Name: CsamReport CsamReport_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."CsamReport"
    ADD CONSTRAINT "CsamReport_pkey" PRIMARY KEY (id);


--
-- Name: CustomerSubscription CustomerSubscription_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."CustomerSubscription"
    ADD CONSTRAINT "CustomerSubscription_pkey" PRIMARY KEY (id);


--
-- Name: DonationGoal DonationGoal_pkey; Type: CONSTRAINT; Schema: public; Owner: doadmin
--

ALTER TABLE ONLY public."DonationGoal"
    ADD CONSTRAINT "DonationGoal_pkey" PRIMARY KEY (id);


--
-- Name: Donation Donation_pkey; Type: CONSTRAINT; Schema: public; Owner: doadmin
--

ALTER TABLE ONLY public."Donation"
    ADD CONSTRAINT "Donation_pkey" PRIMARY KEY (id);


--
-- Name: DownloadHistory DownloadHistory_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."DownloadHistory"
    ADD CONSTRAINT "DownloadHistory_pkey" PRIMARY KEY ("userId", "modelVersionId");


--
-- Name: EntityAccess EntityAccess_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."EntityAccess"
    ADD CONSTRAINT "EntityAccess_pkey" PRIMARY KEY ("accessToId", "accessToType", "accessorId", "accessorType");


--
-- Name: EntityCollaborator EntityCollaborator_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."EntityCollaborator"
    ADD CONSTRAINT "EntityCollaborator_pkey" PRIMARY KEY ("entityType", "entityId", "userId");


--
-- Name: EntityMetric EntityMetric_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."EntityMetric"
    ADD CONSTRAINT "EntityMetric_pkey" PRIMARY KEY ("entityType", "entityId", "metricType");


--
-- Name: File File_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."File"
    ADD CONSTRAINT "File_pkey" PRIMARY KEY (id);


--
-- Name: GenerationServiceProvider GenerationServiceProvider_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."GenerationServiceProvider"
    ADD CONSTRAINT "GenerationServiceProvider_pkey" PRIMARY KEY (name);


--
-- Name: HomeBlock HomeBlock_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."HomeBlock"
    ADD CONSTRAINT "HomeBlock_pkey" PRIMARY KEY (id);


--
-- Name: ImageConnection ImageConnection_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ImageConnection"
    ADD CONSTRAINT "ImageConnection_pkey" PRIMARY KEY ("imageId", "entityType", "entityId");


--
-- Name: ImageEngagement ImageEngagement_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ImageEngagement"
    ADD CONSTRAINT "ImageEngagement_pkey" PRIMARY KEY ("userId", "imageId");


--
-- Name: ImageFlag ImageFlag_pkey; Type: CONSTRAINT; Schema: public; Owner: doadmin
--

ALTER TABLE ONLY public."ImageFlag"
    ADD CONSTRAINT "ImageFlag_pkey" PRIMARY KEY ("imageId");


--
-- Name: ImageMetric ImageMetric_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ImageMetric"
    ADD CONSTRAINT "ImageMetric_pkey" PRIMARY KEY ("imageId", timeframe);


--
-- Name: ImageRatingRequest ImageRatingRequest_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ImageRatingRequest"
    ADD CONSTRAINT "ImageRatingRequest_pkey" PRIMARY KEY ("imageId", "userId");


--
-- Name: ImageReaction ImageReaction_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ImageReaction"
    ADD CONSTRAINT "ImageReaction_pkey" PRIMARY KEY (id);


--
-- Name: ImageReport ImageReport_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ImageReport"
    ADD CONSTRAINT "ImageReport_pkey" PRIMARY KEY ("imageId", "reportId");


--
-- Name: ImageResource ImageResource_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ImageResource"
    ADD CONSTRAINT "ImageResource_pkey" PRIMARY KEY (id);


--
-- Name: ImageTechnique ImageTechnique_pkey; Type: CONSTRAINT; Schema: public; Owner: doadmin
--

ALTER TABLE ONLY public."ImageTechnique"
    ADD CONSTRAINT "ImageTechnique_pkey" PRIMARY KEY ("imageId", "techniqueId");


--
-- Name: ImageTool ImageTool_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ImageTool"
    ADD CONSTRAINT "ImageTool_pkey" PRIMARY KEY ("imageId", "toolId");


--
-- Name: Image Image_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Image"
    ADD CONSTRAINT "Image_pkey" PRIMARY KEY (id);


--
-- Name: ImagesOnModels ImagesOnModels_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ImagesOnModels"
    ADD CONSTRAINT "ImagesOnModels_pkey" PRIMARY KEY ("imageId", "modelVersionId");


--
-- Name: Import Import_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Import"
    ADD CONSTRAINT "Import_pkey" PRIMARY KEY (id);


--
-- Name: JobQueue JobQueue_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."JobQueue"
    ADD CONSTRAINT "JobQueue_pkey" PRIMARY KEY ("entityType", "entityId", type);


--
-- Name: KeyValue KeyValue_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."KeyValue"
    ADD CONSTRAINT "KeyValue_pkey" PRIMARY KEY (key);


--
-- Name: LeaderboardResult LeaderboardResult_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."LeaderboardResult"
    ADD CONSTRAINT "LeaderboardResult_pkey" PRIMARY KEY ("leaderboardId", date, "position");


--
-- Name: Leaderboard Leaderboard_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Leaderboard"
    ADD CONSTRAINT "Leaderboard_pkey" PRIMARY KEY (id);


--
-- Name: License License_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."License"
    ADD CONSTRAINT "License_pkey" PRIMARY KEY (id);


--
-- Name: Link Link_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Link"
    ADD CONSTRAINT "Link_pkey" PRIMARY KEY (id);


--
-- Name: Log Log_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Log"
    ADD CONSTRAINT "Log_pkey" PRIMARY KEY (id);


--
-- Name: MetricUpdateQueue MetricUpdateQueue_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."MetricUpdateQueue"
    ADD CONSTRAINT "MetricUpdateQueue_pkey" PRIMARY KEY (type, id);


--
-- Name: ModActivity ModActivity_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ModActivity"
    ADD CONSTRAINT "ModActivity_pkey" PRIMARY KEY (id);


--
-- Name: ModelAssociations ModelAssociations_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ModelAssociations"
    ADD CONSTRAINT "ModelAssociations_pkey" PRIMARY KEY (id);


--
-- Name: ModelEngagement ModelEngagement_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ModelEngagement"
    ADD CONSTRAINT "ModelEngagement_pkey" PRIMARY KEY ("userId", "modelId");


--
-- Name: ModelFileHash ModelFileHash_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ModelFileHash"
    ADD CONSTRAINT "ModelFileHash_pkey" PRIMARY KEY ("fileId", type);


--
-- Name: ModelFile ModelFile_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ModelFile"
    ADD CONSTRAINT "ModelFile_pkey" PRIMARY KEY (id);


--
-- Name: ModelFlag ModelFlag_pkey; Type: CONSTRAINT; Schema: public; Owner: doadmin
--

ALTER TABLE ONLY public."ModelFlag"
    ADD CONSTRAINT "ModelFlag_pkey" PRIMARY KEY ("modelId");


--
-- Name: ModelInterest ModelInterest_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ModelInterest"
    ADD CONSTRAINT "ModelInterest_pkey" PRIMARY KEY ("userId", "modelId");


--
-- Name: ModelMetricDaily ModelMetricDaily_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ModelMetricDaily"
    ADD CONSTRAINT "ModelMetricDaily_pkey" PRIMARY KEY ("modelId", "modelVersionId", type, date);


--
-- Name: ModelMetric ModelMetric_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ModelMetric"
    ADD CONSTRAINT "ModelMetric_pkey" PRIMARY KEY ("modelId", timeframe);


--
-- Name: ModelReport ModelReport_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ModelReport"
    ADD CONSTRAINT "ModelReport_pkey" PRIMARY KEY ("reportId", "modelId");


--
-- Name: ModelVersionEngagement ModelVersionEngagement_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ModelVersionEngagement"
    ADD CONSTRAINT "ModelVersionEngagement_pkey" PRIMARY KEY ("userId", "modelVersionId");


--
-- Name: ModelVersionExploration ModelVersionExploration_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ModelVersionExploration"
    ADD CONSTRAINT "ModelVersionExploration_pkey" PRIMARY KEY ("modelVersionId", name);


--
-- Name: ModelVersionMetric ModelVersionMetric_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ModelVersionMetric"
    ADD CONSTRAINT "ModelVersionMetric_pkey" PRIMARY KEY ("modelVersionId", timeframe);


--
-- Name: ModelVersionMonetization ModelVersionMonetization_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ModelVersionMonetization"
    ADD CONSTRAINT "ModelVersionMonetization_pkey" PRIMARY KEY (id);


--
-- Name: ModelVersionSponsorshipSettings ModelVersionSponsorshipSettings_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ModelVersionSponsorshipSettings"
    ADD CONSTRAINT "ModelVersionSponsorshipSettings_pkey" PRIMARY KEY (id);


--
-- Name: ModelVersion ModelVersion_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ModelVersion"
    ADD CONSTRAINT "ModelVersion_pkey" PRIMARY KEY (id);


--
-- Name: Model Model_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Model"
    ADD CONSTRAINT "Model_pkey" PRIMARY KEY (id);


--
-- Name: OauthClient OauthClient_pkey; Type: CONSTRAINT; Schema: public; Owner: doadmin
--

ALTER TABLE ONLY public."OauthClient"
    ADD CONSTRAINT "OauthClient_pkey" PRIMARY KEY (id);


--
-- Name: OauthToken OauthToken_pkey; Type: CONSTRAINT; Schema: public; Owner: doadmin
--

ALTER TABLE ONLY public."OauthToken"
    ADD CONSTRAINT "OauthToken_pkey" PRIMARY KEY (token);


--
-- Name: Partner Partner_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Partner"
    ADD CONSTRAINT "Partner_pkey" PRIMARY KEY (id);


--
-- Name: PostMetric PostMetric_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."PostMetric"
    ADD CONSTRAINT "PostMetric_pkey" PRIMARY KEY ("postId", timeframe);


--
-- Name: PostReaction PostReaction_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."PostReaction"
    ADD CONSTRAINT "PostReaction_pkey" PRIMARY KEY (id);


--
-- Name: PostReport PostReport_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."PostReport"
    ADD CONSTRAINT "PostReport_pkey" PRIMARY KEY ("reportId", "postId");


--
-- Name: Post Post_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Post"
    ADD CONSTRAINT "Post_pkey" PRIMARY KEY (id);


--
-- Name: PressMention PressMention_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."PressMention"
    ADD CONSTRAINT "PressMention_pkey" PRIMARY KEY (id);


--
-- Name: Price Price_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Price"
    ADD CONSTRAINT "Price_pkey" PRIMARY KEY (id);


--
-- Name: Product Product_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Product"
    ADD CONSTRAINT "Product_pkey" PRIMARY KEY (id);


--
-- Name: PurchasableReward PurchasableReward_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."PurchasableReward"
    ADD CONSTRAINT "PurchasableReward_pkey" PRIMARY KEY (id);


--
-- Name: Purchase Purchase_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Purchase"
    ADD CONSTRAINT "Purchase_pkey" PRIMARY KEY (id);


--
-- Name: QueryDurationLog QueryDurationLog_pkey; Type: CONSTRAINT; Schema: public; Owner: doadmin
--

ALTER TABLE ONLY public."QueryDurationLog"
    ADD CONSTRAINT "QueryDurationLog_pkey" PRIMARY KEY (id);


--
-- Name: QueryParamsLog QueryParamsLog_pkey; Type: CONSTRAINT; Schema: public; Owner: doadmin
--

ALTER TABLE ONLY public."QueryParamsLog"
    ADD CONSTRAINT "QueryParamsLog_pkey" PRIMARY KEY (id);


--
-- Name: QuerySqlLog QuerySqlLog_pkey; Type: CONSTRAINT; Schema: public; Owner: doadmin
--

ALTER TABLE ONLY public."QuerySqlLog"
    ADD CONSTRAINT "QuerySqlLog_pkey" PRIMARY KEY (id);


--
-- Name: QuestionMetric QuestionMetric_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."QuestionMetric"
    ADD CONSTRAINT "QuestionMetric_pkey" PRIMARY KEY ("questionId", timeframe);


--
-- Name: QuestionReaction QuestionReaction_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."QuestionReaction"
    ADD CONSTRAINT "QuestionReaction_pkey" PRIMARY KEY (id);


--
-- Name: Question Question_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Question"
    ADD CONSTRAINT "Question_pkey" PRIMARY KEY (id);


--
-- Name: RecommendedResource RecommendedResource_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."RecommendedResource"
    ADD CONSTRAINT "RecommendedResource_pkey" PRIMARY KEY (id);


--
-- Name: RedeemableCode RedeemableCode_pkey; Type: CONSTRAINT; Schema: public; Owner: doadmin
--

ALTER TABLE ONLY public."RedeemableCode"
    ADD CONSTRAINT "RedeemableCode_pkey" PRIMARY KEY (code);


--
-- Name: Report Report_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Report"
    ADD CONSTRAINT "Report_pkey" PRIMARY KEY (id);


--
-- Name: ResourceReviewReaction ResourceReviewReaction_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ResourceReviewReaction"
    ADD CONSTRAINT "ResourceReviewReaction_pkey" PRIMARY KEY (id);


--
-- Name: ResourceReviewReport ResourceReviewReport_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ResourceReviewReport"
    ADD CONSTRAINT "ResourceReviewReport_pkey" PRIMARY KEY ("reportId", "resourceReviewId");


--
-- Name: ResourceReview ResourceReview_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ResourceReview"
    ADD CONSTRAINT "ResourceReview_pkey" PRIMARY KEY (id);


--
-- Name: RunStrategy RunStrategy_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."RunStrategy"
    ADD CONSTRAINT "RunStrategy_pkey" PRIMARY KEY ("modelVersionId", "partnerId");


--
-- Name: SavedModel SavedModel_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."SavedModel"
    ADD CONSTRAINT "SavedModel_pkey" PRIMARY KEY ("modelId", "userId");


--
-- Name: SearchIndexUpdateQueue SearchIndexUpdateQueue_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."SearchIndexUpdateQueue"
    ADD CONSTRAINT "SearchIndexUpdateQueue_pkey" PRIMARY KEY (type, id, action);


--
-- Name: SessionInvalidation SessionInvalidation_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."SessionInvalidation"
    ADD CONSTRAINT "SessionInvalidation_pkey" PRIMARY KEY ("userId", "invalidatedAt");


--
-- Name: Session Session_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Session"
    ADD CONSTRAINT "Session_pkey" PRIMARY KEY (id);


--
-- Name: TagEngagement TagEngagement_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."TagEngagement"
    ADD CONSTRAINT "TagEngagement_pkey" PRIMARY KEY ("userId", "tagId");


--
-- Name: TagMetric TagMetric_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."TagMetric"
    ADD CONSTRAINT "TagMetric_pkey" PRIMARY KEY ("tagId", timeframe);


--
-- Name: Tag Tag_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Tag"
    ADD CONSTRAINT "Tag_pkey" PRIMARY KEY (id);


--
-- Name: TagsOnArticle TagsOnArticle_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."TagsOnArticle"
    ADD CONSTRAINT "TagsOnArticle_pkey" PRIMARY KEY ("tagId", "articleId");


--
-- Name: TagsOnBounty TagsOnBounty_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."TagsOnBounty"
    ADD CONSTRAINT "TagsOnBounty_pkey" PRIMARY KEY ("tagId", "bountyId");


--
-- Name: TagsOnCollection TagsOnCollection_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."TagsOnCollection"
    ADD CONSTRAINT "TagsOnCollection_pkey" PRIMARY KEY ("tagId", "collectionId");


--
-- Name: TagsOnImageVote TagsOnImageVote_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."TagsOnImageVote"
    ADD CONSTRAINT "TagsOnImageVote_pkey" PRIMARY KEY ("tagId", "imageId", "userId");


--
-- Name: TagsOnImage TagsOnImage_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."TagsOnImage"
    ADD CONSTRAINT "TagsOnImage_pkey" PRIMARY KEY ("tagId", "imageId");


--
-- Name: TagsOnModelsVote TagsOnModelsVote_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."TagsOnModelsVote"
    ADD CONSTRAINT "TagsOnModelsVote_pkey" PRIMARY KEY ("tagId", "modelId", "userId");


--
-- Name: TagsOnModels TagsOnModels_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."TagsOnModels"
    ADD CONSTRAINT "TagsOnModels_pkey" PRIMARY KEY ("modelId", "tagId");


--
-- Name: TagsOnPostVote TagsOnPostVote_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."TagsOnPostVote"
    ADD CONSTRAINT "TagsOnPostVote_pkey" PRIMARY KEY ("tagId", "postId", "userId");


--
-- Name: TagsOnPost TagsOnPost_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."TagsOnPost"
    ADD CONSTRAINT "TagsOnPost_pkey" PRIMARY KEY ("tagId", "postId");


--
-- Name: TagsOnQuestions TagsOnQuestions_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."TagsOnQuestions"
    ADD CONSTRAINT "TagsOnQuestions_pkey" PRIMARY KEY ("tagId", "questionId");


--
-- Name: TagsOnTags TagsOnTags_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."TagsOnTags"
    ADD CONSTRAINT "TagsOnTags_pkey" PRIMARY KEY ("fromTagId", "toTagId");


--
-- Name: Technique Technique_pkey; Type: CONSTRAINT; Schema: public; Owner: doadmin
--

ALTER TABLE ONLY public."Technique"
    ADD CONSTRAINT "Technique_pkey" PRIMARY KEY (id);


--
-- Name: Thread Thread_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Thread"
    ADD CONSTRAINT "Thread_pkey" PRIMARY KEY (id);


--
-- Name: TipConnection TipConnection_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."TipConnection"
    ADD CONSTRAINT "TipConnection_pkey" PRIMARY KEY ("entityType", "entityId", "transactionId");


--
-- Name: Tool Tool_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Tool"
    ADD CONSTRAINT "Tool_pkey" PRIMARY KEY (id);


--
-- Name: UserCosmeticShopPurchases UserCosmeticShopPurchases_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."UserCosmeticShopPurchases"
    ADD CONSTRAINT "UserCosmeticShopPurchases_pkey" PRIMARY KEY ("buzzTransactionId");


--
-- Name: UserCosmetic UserCosmetic_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."UserCosmetic"
    ADD CONSTRAINT "UserCosmetic_pkey" PRIMARY KEY ("userId", "cosmeticId", "claimKey");


--
-- Name: UserEngagement UserEngagement_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."UserEngagement"
    ADD CONSTRAINT "UserEngagement_pkey" PRIMARY KEY ("userId", "targetUserId");


--
-- Name: UserLink UserLink_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."UserLink"
    ADD CONSTRAINT "UserLink_pkey" PRIMARY KEY (id);


--
-- Name: UserMetric UserMetric_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."UserMetric"
    ADD CONSTRAINT "UserMetric_pkey" PRIMARY KEY ("userId", timeframe);


--
-- Name: UserNotificationSettings UserNotificationSettings_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."UserNotificationSettings"
    ADD CONSTRAINT "UserNotificationSettings_pkey" PRIMARY KEY (id);


--
-- Name: UserProfile UserProfile_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."UserProfile"
    ADD CONSTRAINT "UserProfile_pkey" PRIMARY KEY ("userId");


--
-- Name: UserPurchasedRewards UserPurchasedRewards_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."UserPurchasedRewards"
    ADD CONSTRAINT "UserPurchasedRewards_pkey" PRIMARY KEY ("buzzTransactionId");


--
-- Name: UserReferralCode UserReferralCode_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."UserReferralCode"
    ADD CONSTRAINT "UserReferralCode_pkey" PRIMARY KEY (id);


--
-- Name: UserReferral UserReferral_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."UserReferral"
    ADD CONSTRAINT "UserReferral_pkey" PRIMARY KEY (id);


--
-- Name: UserReport UserReport_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."UserReport"
    ADD CONSTRAINT "UserReport_pkey" PRIMARY KEY ("reportId", "userId");


--
-- Name: User User_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."User"
    ADD CONSTRAINT "User_pkey" PRIMARY KEY (id);


--
-- Name: VaultItem VaultItem_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."VaultItem"
    ADD CONSTRAINT "VaultItem_pkey" PRIMARY KEY (id);


--
-- Name: Vault Vault_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Vault"
    ADD CONSTRAINT "Vault_pkey" PRIMARY KEY ("userId");


--
-- Name: VerificationToken VerificationToken_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."VerificationToken"
    ADD CONSTRAINT "VerificationToken_pkey" PRIMARY KEY (token);


--
-- Name: Webhook Webhook_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Webhook"
    ADD CONSTRAINT "Webhook_pkey" PRIMARY KEY (id);


--
-- Name: _LicenseToModel _LicenseToModel_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."_LicenseToModel"
    ADD CONSTRAINT "_LicenseToModel_pkey" PRIMARY KEY ("A", "B");


--
-- Name: _prisma_migrations _prisma_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public._prisma_migrations
    ADD CONSTRAINT _prisma_migrations_pkey PRIMARY KEY (id);


--
-- Name: ArticleRank pk_ArticleRank; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ArticleRank"
    ADD CONSTRAINT "pk_ArticleRank" PRIMARY KEY ("articleId");


--
-- Name: BountyEntryRank pk_BountyEntryRank; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."BountyEntryRank"
    ADD CONSTRAINT "pk_BountyEntryRank" PRIMARY KEY ("bountyEntryId");


--
-- Name: BountyEntryRank_New pk_BountyEntryRank_New; Type: CONSTRAINT; Schema: public; Owner: civitai-jobs
--

ALTER TABLE ONLY public."BountyEntryRank_New"
    ADD CONSTRAINT "pk_BountyEntryRank_New" PRIMARY KEY ("bountyEntryId");


--
-- Name: BountyRank pk_BountyRank; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."BountyRank"
    ADD CONSTRAINT "pk_BountyRank" PRIMARY KEY ("bountyId");


--
-- Name: ClubRank pk_ClubRank; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ClubRank"
    ADD CONSTRAINT "pk_ClubRank" PRIMARY KEY ("clubId");


--
-- Name: CollectionRank pk_CollectionRank; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."CollectionRank"
    ADD CONSTRAINT "pk_CollectionRank" PRIMARY KEY ("collectionId");


--
-- Name: ImageRank pk_ImageRank; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ImageRank"
    ADD CONSTRAINT "pk_ImageRank" PRIMARY KEY ("imageId");


--
-- Name: ModelRank_New pk_ModelRank_New; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ModelRank_New"
    ADD CONSTRAINT "pk_ModelRank_New" PRIMARY KEY ("modelId");


--
-- Name: ModelVersionRank pk_ModelVersionRank; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ModelVersionRank"
    ADD CONSTRAINT "pk_ModelVersionRank" PRIMARY KEY ("modelVersionId");


--
-- Name: PostRank pk_PostRank; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."PostRank"
    ADD CONSTRAINT "pk_PostRank" PRIMARY KEY ("postId");


--
-- Name: TagRank pk_TagRank; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."TagRank"
    ADD CONSTRAINT "pk_TagRank" PRIMARY KEY ("tagId");


--
-- Name: UserRank pk_UserRank; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."UserRank"
    ADD CONSTRAINT "pk_UserRank" PRIMARY KEY ("userId");


--
-- Name: research_ratings research_ratings_pkey; Type: CONSTRAINT; Schema: public; Owner: doadmin
--

ALTER TABLE ONLY public.research_ratings
    ADD CONSTRAINT research_ratings_pkey PRIMARY KEY ("userId", "imageId");


--
-- Name: Tool unique_name; Type: CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Tool"
    ADD CONSTRAINT unique_name UNIQUE (name);


--
-- Name: Account_provider_providerAccountId_key; Type: INDEX; Schema: public; Owner: civitai
--

CREATE UNIQUE INDEX "Account_provider_providerAccountId_key" ON public."Account" USING btree (provider, "providerAccountId");


--
-- Name: Account_provider_userId_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "Account_provider_userId_idx" ON public."Account" USING btree (provider, "userId");


--
-- Name: Account_userId_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "Account_userId_idx" ON public."Account" USING btree ("userId");


--
-- Name: AnswerReaction_answerId_userId_reaction_key; Type: INDEX; Schema: public; Owner: civitai
--

CREATE UNIQUE INDEX "AnswerReaction_answerId_userId_reaction_key" ON public."AnswerReaction" USING btree ("answerId", "userId", reaction);


--
-- Name: ApiKey_key_key; Type: INDEX; Schema: public; Owner: civitai
--

CREATE UNIQUE INDEX "ApiKey_key_key" ON public."ApiKey" USING btree (key);


--
-- Name: ApiKey_userId_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ApiKey_userId_idx" ON public."ApiKey" USING btree ("userId");


--
-- Name: ArticleEngagement_articleId_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ArticleEngagement_articleId_idx" ON public."ArticleEngagement" USING hash ("articleId");


--
-- Name: ArticleRank_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ArticleRank_idx" ON public."ArticleRank" USING btree ("articleId");


--
-- Name: ArticleRank_reactionCountMonthRank_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ArticleRank_reactionCountMonthRank_idx" ON public."ArticleRank" USING btree ("reactionCountMonthRank");


--
-- Name: ArticleReaction_articleId_userId_reaction_key; Type: INDEX; Schema: public; Owner: civitai
--

CREATE UNIQUE INDEX "ArticleReaction_articleId_userId_reaction_key" ON public."ArticleReaction" USING btree ("articleId", "userId", reaction);


--
-- Name: ArticleReport_articleId_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ArticleReport_articleId_idx" ON public."ArticleReport" USING hash ("articleId");


--
-- Name: ArticleReport_reportId_key; Type: INDEX; Schema: public; Owner: civitai
--

CREATE UNIQUE INDEX "ArticleReport_reportId_key" ON public."ArticleReport" USING btree ("reportId");


--
-- Name: Article_coverId_key; Type: INDEX; Schema: public; Owner: civitai
--

CREATE UNIQUE INDEX "Article_coverId_key" ON public."Article" USING btree ("coverId");


--
-- Name: Article_userId; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "Article_userId" ON public."Article" USING btree ("userId");


--
-- Name: BountyBenefactor_bountyId_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "BountyBenefactor_bountyId_idx" ON public."BountyBenefactor" USING hash ("bountyId");


--
-- Name: BountyBenefactor_userId_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "BountyBenefactor_userId_idx" ON public."BountyBenefactor" USING hash ("userId");


--
-- Name: BountyEngagement_bountyId_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "BountyEngagement_bountyId_idx" ON public."BountyEngagement" USING btree ("bountyId");


--
-- Name: BountyEngagement_userId_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "BountyEngagement_userId_idx" ON public."BountyEngagement" USING hash ("userId");


--
-- Name: BountyEntryRank_New_idx; Type: INDEX; Schema: public; Owner: civitai-jobs
--

CREATE INDEX "BountyEntryRank_New_idx" ON public."BountyEntryRank_New" USING btree ("bountyEntryId");


--
-- Name: BountyEntryRank_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "BountyEntryRank_idx" ON public."BountyEntryRank" USING btree ("bountyEntryId");


--
-- Name: BountyEntryReaction_bountyEntryId_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "BountyEntryReaction_bountyEntryId_idx" ON public."BountyEntryReaction" USING hash ("bountyEntryId");


--
-- Name: BountyEntryReport_bountyEntryId_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "BountyEntryReport_bountyEntryId_idx" ON public."BountyEntryReport" USING hash ("bountyEntryId");


--
-- Name: BountyEntryReport_reportId_key; Type: INDEX; Schema: public; Owner: civitai
--

CREATE UNIQUE INDEX "BountyEntryReport_reportId_key" ON public."BountyEntryReport" USING btree ("reportId");


--
-- Name: BountyEntry_bountyId_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "BountyEntry_bountyId_idx" ON public."BountyEntry" USING hash ("bountyId");


--
-- Name: BountyEntry_userId; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "BountyEntry_userId" ON public."BountyEntry" USING btree ("userId");


--
-- Name: BountyRank_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "BountyRank_idx" ON public."BountyRank" USING btree ("bountyId");


--
-- Name: BountyReport_bountyId_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "BountyReport_bountyId_idx" ON public."BountyReport" USING hash ("bountyId");


--
-- Name: BountyReport_reportId_key; Type: INDEX; Schema: public; Owner: civitai
--

CREATE UNIQUE INDEX "BountyReport_reportId_key" ON public."BountyReport" USING btree ("reportId");


--
-- Name: Bounty_mode_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "Bounty_mode_idx" ON public."Bounty" USING btree (mode);


--
-- Name: Bounty_type_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "Bounty_type_idx" ON public."Bounty" USING btree (type);


--
-- Name: Bounty_userId_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "Bounty_userId_idx" ON public."Bounty" USING hash ("userId");


--
-- Name: BuzzTip_toUserId_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "BuzzTip_toUserId_idx" ON public."BuzzTip" USING btree ("toUserId");


--
-- Name: ChatMember_userId_status_muted_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ChatMember_userId_status_muted_idx" ON public."ChatMember" USING btree ("userId", status, "isMuted");


--
-- Name: ChatMessage_chatId_userId_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ChatMessage_chatId_userId_idx" ON public."ChatMessage" USING btree ("chatId", "userId");


--
-- Name: ChatReport_chatId_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ChatReport_chatId_idx" ON public."ChatReport" USING hash ("chatId");


--
-- Name: ChatReport_reportId_key; Type: INDEX; Schema: public; Owner: civitai
--

CREATE UNIQUE INDEX "ChatReport_reportId_key" ON public."ChatReport" USING btree ("reportId");


--
-- Name: Chat_hash_key; Type: INDEX; Schema: public; Owner: civitai
--

CREATE UNIQUE INDEX "Chat_hash_key" ON public."Chat" USING btree (hash);


--
-- Name: ClubMembership_clubId_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ClubMembership_clubId_idx" ON public."ClubMembership" USING btree ("clubId");


--
-- Name: ClubMembership_userId_clubId_key; Type: INDEX; Schema: public; Owner: civitai
--

CREATE UNIQUE INDEX "ClubMembership_userId_clubId_key" ON public."ClubMembership" USING btree ("userId", "clubId");


--
-- Name: ClubMembership_userId_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ClubMembership_userId_idx" ON public."ClubMembership" USING btree ("userId");


--
-- Name: ClubPostReaction_clubPostId_userId_reaction_key; Type: INDEX; Schema: public; Owner: civitai
--

CREATE UNIQUE INDEX "ClubPostReaction_clubPostId_userId_reaction_key" ON public."ClubPostReaction" USING btree ("clubPostId", "userId", reaction);


--
-- Name: ClubRank_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ClubRank_idx" ON public."ClubRank" USING btree ("clubId");


--
-- Name: Club_userId_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "Club_userId_idx" ON public."Club" USING btree ("userId");


--
-- Name: CollectionContributor_userId_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "CollectionContributor_userId_idx" ON public."CollectionContributor" USING hash ("userId");


--
-- Name: CollectionItem_addedById_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "CollectionItem_addedById_idx" ON public."CollectionItem" USING hash ("addedById");


--
-- Name: CollectionItem_article_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE UNIQUE INDEX "CollectionItem_article_idx" ON public."CollectionItem" USING btree ("collectionId", "articleId") WHERE ("articleId" IS NOT NULL);


--
-- Name: CollectionItem_collectionId_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "CollectionItem_collectionId_idx" ON public."CollectionItem" USING hash ("collectionId");


--
-- Name: CollectionItem_imageId_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "CollectionItem_imageId_idx" ON public."CollectionItem" USING hash ("imageId");


--
-- Name: CollectionItem_image_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE UNIQUE INDEX "CollectionItem_image_idx" ON public."CollectionItem" USING btree ("collectionId", "imageId") WHERE ("imageId" IS NOT NULL);


--
-- Name: CollectionItem_modelId_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "CollectionItem_modelId_idx" ON public."CollectionItem" USING hash ("modelId");


--
-- Name: CollectionItem_modelId_idx1; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "CollectionItem_modelId_idx1" ON public."CollectionItem" USING btree ("modelId");


--
-- Name: CollectionItem_model_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE UNIQUE INDEX "CollectionItem_model_idx" ON public."CollectionItem" USING btree ("collectionId", "modelId") WHERE ("modelId" IS NOT NULL);


--
-- Name: CollectionItem_postId_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "CollectionItem_postId_idx" ON public."CollectionItem" USING btree ("postId");


--
-- Name: CollectionItem_post_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE UNIQUE INDEX "CollectionItem_post_idx" ON public."CollectionItem" USING btree ("collectionId", "postId") WHERE ("postId" IS NOT NULL);


--
-- Name: CollectionItem_status_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "CollectionItem_status_idx" ON public."CollectionItem" USING btree (status);


--
-- Name: CollectionRank_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "CollectionRank_idx" ON public."CollectionRank" USING btree ("collectionId");


--
-- Name: CollectionReport_collectionId_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "CollectionReport_collectionId_idx" ON public."CollectionReport" USING hash ("collectionId");


--
-- Name: CollectionReport_reportId_key; Type: INDEX; Schema: public; Owner: civitai
--

CREATE UNIQUE INDEX "CollectionReport_reportId_key" ON public."CollectionReport" USING btree ("reportId");


--
-- Name: Collection_createdAt; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "Collection_createdAt" ON public."CollectionItem" USING btree ("createdAt");


--
-- Name: Collection_mode_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "Collection_mode_idx" ON public."Collection" USING hash (mode);


--
-- Name: Collection_type_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "Collection_type_idx" ON public."Collection" USING hash (type);


--
-- Name: Collection_userId_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "Collection_userId_idx" ON public."Collection" USING btree ("userId");


--
-- Name: CommentReaction_commentId_userId_reaction_key; Type: INDEX; Schema: public; Owner: civitai
--

CREATE UNIQUE INDEX "CommentReaction_commentId_userId_reaction_key" ON public."CommentReaction" USING btree ("commentId", "userId", reaction);


--
-- Name: CommentReport_commentId_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "CommentReport_commentId_idx" ON public."CommentReport" USING hash ("commentId");


--
-- Name: CommentReport_reportId_key; Type: INDEX; Schema: public; Owner: civitai
--

CREATE UNIQUE INDEX "CommentReport_reportId_key" ON public."CommentReport" USING btree ("reportId");


--
-- Name: CommentV2Reaction_commentId_userId_reaction_key; Type: INDEX; Schema: public; Owner: civitai
--

CREATE UNIQUE INDEX "CommentV2Reaction_commentId_userId_reaction_key" ON public."CommentV2Reaction" USING btree ("commentId", "userId", reaction);


--
-- Name: CommentV2Report_commentV2Id_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "CommentV2Report_commentV2Id_idx" ON public."CommentV2Report" USING hash ("commentV2Id");


--
-- Name: CommentV2Report_reportId_key; Type: INDEX; Schema: public; Owner: civitai
--

CREATE UNIQUE INDEX "CommentV2Report_reportId_key" ON public."CommentV2Report" USING btree ("reportId");


--
-- Name: CommentV2_threadId_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "CommentV2_threadId_idx" ON public."CommentV2" USING hash ("threadId");


--
-- Name: Comment_modelId_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "Comment_modelId_idx" ON public."Comment" USING hash ("modelId");


--
-- Name: Comment_parentId_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "Comment_parentId_idx" ON public."Comment" USING hash ("parentId");


--
-- Name: CoveredCheckpoint_modelVersion; Type: INDEX; Schema: public; Owner: civitai
--

CREATE UNIQUE INDEX "CoveredCheckpoint_modelVersion" ON public."CoveredCheckpoint" USING btree (model_id, version_id);


--
-- Name: CustomerSubscription_userId_key; Type: INDEX; Schema: public; Owner: civitai
--

CREATE UNIQUE INDEX "CustomerSubscription_userId_key" ON public."CustomerSubscription" USING btree ("userId");


--
-- Name: DownloadHistory_userId_downloadAt_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "DownloadHistory_userId_downloadAt_idx" ON public."DownloadHistory" USING btree ("userId", "downloadAt");


--
-- Name: EntityCollaborator_userId_entityType_entityId_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "EntityCollaborator_userId_entityType_entityId_idx" ON public."EntityCollaborator" USING btree ("userId", "entityType", "entityId") INCLUDE (status);


--
-- Name: File_entityType_entityId_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "File_entityType_entityId_idx" ON public."File" USING btree ("entityType", "entityId");


--
-- Name: HomeBlock_user; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "HomeBlock_user" ON public."HomeBlock" USING btree ("userId");


--
-- Name: ImageConnection_entityType_entityId_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ImageConnection_entityType_entityId_idx" ON public."ImageConnection" USING btree ("entityType", "entityId");


--
-- Name: ImageEngagement_imageId_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ImageEngagement_imageId_idx" ON public."ImageEngagement" USING btree ("imageId");


--
-- Name: ImageMetric_DayGroup_commentCount; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ImageMetric_DayGroup_commentCount" ON public."ImageMetric" USING btree (timeframe, "commentCount") WHERE ("ageGroup" = 'Day'::public."MetricTimeframe");


--
-- Name: ImageMetric_DayGroup_heartCount; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ImageMetric_DayGroup_heartCount" ON public."ImageMetric" USING btree (timeframe, "heartCount") WHERE ("ageGroup" = 'Day'::public."MetricTimeframe");


--
-- Name: ImageMetric_DayGroup_likeCount; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ImageMetric_DayGroup_likeCount" ON public."ImageMetric" USING btree (timeframe, "likeCount") WHERE ("ageGroup" = 'Day'::public."MetricTimeframe");


--
-- Name: ImageMetric_DayGroup_reactionCount; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ImageMetric_DayGroup_reactionCount" ON public."ImageMetric" USING btree (timeframe, "reactionCount") WHERE ("ageGroup" = 'Day'::public."MetricTimeframe");


--
-- Name: ImageMetric_DayGroup_tippedAmountCount; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ImageMetric_DayGroup_tippedAmountCount" ON public."ImageMetric" USING btree (timeframe, "tippedAmountCount") WHERE ("ageGroup" = 'Day'::public."MetricTimeframe");


--
-- Name: ImageMetric_MonthGroup_commentCount; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ImageMetric_MonthGroup_commentCount" ON public."ImageMetric" USING btree (timeframe, "commentCount") WHERE ("ageGroup" = ANY (ARRAY['Day'::public."MetricTimeframe", 'Week'::public."MetricTimeframe", 'Month'::public."MetricTimeframe"]));


--
-- Name: ImageMetric_MonthGroup_heartCount; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ImageMetric_MonthGroup_heartCount" ON public."ImageMetric" USING btree (timeframe, "heartCount") WHERE ("ageGroup" = ANY (ARRAY['Day'::public."MetricTimeframe", 'Week'::public."MetricTimeframe", 'Month'::public."MetricTimeframe"]));


--
-- Name: ImageMetric_MonthGroup_likeCount; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ImageMetric_MonthGroup_likeCount" ON public."ImageMetric" USING btree (timeframe, "likeCount") WHERE ("ageGroup" = ANY (ARRAY['Day'::public."MetricTimeframe", 'Week'::public."MetricTimeframe", 'Month'::public."MetricTimeframe"]));


--
-- Name: ImageMetric_MonthGroup_reactionCount; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ImageMetric_MonthGroup_reactionCount" ON public."ImageMetric" USING btree (timeframe, "reactionCount") WHERE ("ageGroup" = ANY (ARRAY['Day'::public."MetricTimeframe", 'Week'::public."MetricTimeframe", 'Month'::public."MetricTimeframe"]));


--
-- Name: ImageMetric_MonthGroup_tippedAmountCount; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ImageMetric_MonthGroup_tippedAmountCount" ON public."ImageMetric" USING btree (timeframe, "tippedAmountCount") WHERE ("ageGroup" = ANY (ARRAY['Day'::public."MetricTimeframe", 'Week'::public."MetricTimeframe", 'Month'::public."MetricTimeframe"]));


--
-- Name: ImageMetric_WeekGroup_commentCount; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ImageMetric_WeekGroup_commentCount" ON public."ImageMetric" USING btree (timeframe, "commentCount") WHERE ("ageGroup" = ANY (ARRAY['Day'::public."MetricTimeframe", 'Week'::public."MetricTimeframe"]));


--
-- Name: ImageMetric_WeekGroup_heartCount; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ImageMetric_WeekGroup_heartCount" ON public."ImageMetric" USING btree (timeframe, "heartCount") WHERE ("ageGroup" = ANY (ARRAY['Day'::public."MetricTimeframe", 'Week'::public."MetricTimeframe"]));


--
-- Name: ImageMetric_WeekGroup_likeCount; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ImageMetric_WeekGroup_likeCount" ON public."ImageMetric" USING btree (timeframe, "likeCount") WHERE ("ageGroup" = ANY (ARRAY['Day'::public."MetricTimeframe", 'Week'::public."MetricTimeframe"]));


--
-- Name: ImageMetric_WeekGroup_reactionCount; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ImageMetric_WeekGroup_reactionCount" ON public."ImageMetric" USING btree (timeframe, "reactionCount") WHERE ("ageGroup" = ANY (ARRAY['Day'::public."MetricTimeframe", 'Week'::public."MetricTimeframe"]));


--
-- Name: ImageMetric_WeekGroup_reactionCount_temp; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ImageMetric_WeekGroup_reactionCount_temp" ON public."ImageMetric" USING btree (timeframe, "reactionCount") WHERE ("ageGroup" = ANY (ARRAY['Day'::public."MetricTimeframe", 'Week'::public."MetricTimeframe"]));


--
-- Name: ImageMetric_WeekGroup_tippedAmountCount; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ImageMetric_WeekGroup_tippedAmountCount" ON public."ImageMetric" USING btree (timeframe, "tippedAmountCount") WHERE ("ageGroup" = ANY (ARRAY['Day'::public."MetricTimeframe", 'Week'::public."MetricTimeframe"]));


--
-- Name: ImageMetric_YearGroup_commentCount; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ImageMetric_YearGroup_commentCount" ON public."ImageMetric" USING btree (timeframe, "commentCount") WHERE ("ageGroup" = ANY (ARRAY['Day'::public."MetricTimeframe", 'Week'::public."MetricTimeframe", 'Month'::public."MetricTimeframe", 'Year'::public."MetricTimeframe"]));


--
-- Name: ImageMetric_YearGroup_heartCount; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ImageMetric_YearGroup_heartCount" ON public."ImageMetric" USING btree (timeframe, "heartCount") WHERE ("ageGroup" = ANY (ARRAY['Day'::public."MetricTimeframe", 'Week'::public."MetricTimeframe", 'Month'::public."MetricTimeframe", 'Year'::public."MetricTimeframe"]));


--
-- Name: ImageMetric_YearGroup_likeCount; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ImageMetric_YearGroup_likeCount" ON public."ImageMetric" USING btree (timeframe, "likeCount") WHERE ("ageGroup" = ANY (ARRAY['Day'::public."MetricTimeframe", 'Week'::public."MetricTimeframe", 'Month'::public."MetricTimeframe", 'Year'::public."MetricTimeframe"]));


--
-- Name: ImageMetric_YearGroup_reactionCount; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ImageMetric_YearGroup_reactionCount" ON public."ImageMetric" USING btree (timeframe, "reactionCount") WHERE ("ageGroup" = ANY (ARRAY['Day'::public."MetricTimeframe", 'Week'::public."MetricTimeframe", 'Month'::public."MetricTimeframe", 'Year'::public."MetricTimeframe"]));


--
-- Name: ImageMetric_YearGroup_tippedAmountCount; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ImageMetric_YearGroup_tippedAmountCount" ON public."ImageMetric" USING btree (timeframe, "tippedAmountCount") WHERE ("ageGroup" = ANY (ARRAY['Day'::public."MetricTimeframe", 'Week'::public."MetricTimeframe", 'Month'::public."MetricTimeframe", 'Year'::public."MetricTimeframe"]));


--
-- Name: ImageMetric_ageGroup_createdAt; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ImageMetric_ageGroup_createdAt" ON public."ImageMetric" USING btree ("ageGroup", "createdAt");


--
-- Name: ImageMetric_collectedCount; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ImageMetric_collectedCount" ON public."ImageMetric" USING btree (timeframe, "collectedCount");


--
-- Name: ImageMetric_commentCount; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ImageMetric_commentCount" ON public."ImageMetric" USING btree (timeframe, "commentCount");


--
-- Name: ImageMetric_heartCount; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ImageMetric_heartCount" ON public."ImageMetric" USING btree (timeframe, "heartCount");


--
-- Name: ImageMetric_likeCount; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ImageMetric_likeCount" ON public."ImageMetric" USING btree (timeframe, "likeCount");


--
-- Name: ImageMetric_reactionCount; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ImageMetric_reactionCount" ON public."ImageMetric" USING btree (timeframe, "reactionCount");


--
-- Name: ImageMetric_tippedAmountCount; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ImageMetric_tippedAmountCount" ON public."ImageMetric" USING btree (timeframe, "tippedAmountCount");


--
-- Name: ImageRank_collectedCountAllTimeRank_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ImageRank_collectedCountAllTimeRank_idx" ON public."ImageRank" USING btree ("collectedCountAllTimeRank");


--
-- Name: ImageRank_collectedCountDayRank_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ImageRank_collectedCountDayRank_idx" ON public."ImageRank" USING btree ("collectedCountDayRank");


--
-- Name: ImageRank_collectedCountMonthRank_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ImageRank_collectedCountMonthRank_idx" ON public."ImageRank" USING btree ("collectedCountMonthRank");


--
-- Name: ImageRank_collectedCountWeekRank_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ImageRank_collectedCountWeekRank_idx" ON public."ImageRank" USING btree ("collectedCountWeekRank");


--
-- Name: ImageRank_collectedCountYearRank_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ImageRank_collectedCountYearRank_idx" ON public."ImageRank" USING btree ("collectedCountYearRank");


--
-- Name: ImageRank_commentCountAllTimeRank_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ImageRank_commentCountAllTimeRank_idx" ON public."ImageRank" USING btree ("commentCountAllTimeRank");


--
-- Name: ImageRank_commentCountDayRank_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ImageRank_commentCountDayRank_idx" ON public."ImageRank" USING btree ("commentCountDayRank");


--
-- Name: ImageRank_commentCountMonthRank_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ImageRank_commentCountMonthRank_idx" ON public."ImageRank" USING btree ("commentCountMonthRank");


--
-- Name: ImageRank_commentCountWeekRank_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ImageRank_commentCountWeekRank_idx" ON public."ImageRank" USING btree ("commentCountWeekRank");


--
-- Name: ImageRank_commentCountYearRank_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ImageRank_commentCountYearRank_idx" ON public."ImageRank" USING btree ("commentCountYearRank");


--
-- Name: ImageRank_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ImageRank_idx" ON public."ImageRank" USING btree ("imageId");


--
-- Name: ImageRank_reactionCountAllTimeRank_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ImageRank_reactionCountAllTimeRank_idx" ON public."ImageRank" USING btree ("reactionCountAllTimeRank");


--
-- Name: ImageRank_reactionCountDayRank_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ImageRank_reactionCountDayRank_idx" ON public."ImageRank" USING btree ("reactionCountDayRank");


--
-- Name: ImageRank_reactionCountMonthRank_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ImageRank_reactionCountMonthRank_idx" ON public."ImageRank" USING btree ("reactionCountMonthRank");


--
-- Name: ImageRank_reactionCountWeekRank_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ImageRank_reactionCountWeekRank_idx" ON public."ImageRank" USING btree ("reactionCountWeekRank");


--
-- Name: ImageRank_reactionCountYearRank_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ImageRank_reactionCountYearRank_idx" ON public."ImageRank" USING btree ("reactionCountYearRank");


--
-- Name: ImageRank_tippedAmountCountAllTimeRank_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ImageRank_tippedAmountCountAllTimeRank_idx" ON public."ImageRank" USING btree ("tippedAmountCountAllTimeRank");


--
-- Name: ImageRank_tippedAmountCountDayRank_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ImageRank_tippedAmountCountDayRank_idx" ON public."ImageRank" USING btree ("tippedAmountCountDayRank");


--
-- Name: ImageRank_tippedAmountCountMonthRank_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ImageRank_tippedAmountCountMonthRank_idx" ON public."ImageRank" USING btree ("tippedAmountCountMonthRank");


--
-- Name: ImageRank_tippedAmountCountWeekRank_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ImageRank_tippedAmountCountWeekRank_idx" ON public."ImageRank" USING btree ("tippedAmountCountWeekRank");


--
-- Name: ImageRank_tippedAmountCountYearRank_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ImageRank_tippedAmountCountYearRank_idx" ON public."ImageRank" USING btree ("tippedAmountCountYearRank");


--
-- Name: ImageRank_tippedCountAllTimeRank_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ImageRank_tippedCountAllTimeRank_idx" ON public."ImageRank" USING btree ("tippedCountAllTimeRank");


--
-- Name: ImageRank_tippedCountDayRank_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ImageRank_tippedCountDayRank_idx" ON public."ImageRank" USING btree ("tippedCountDayRank");


--
-- Name: ImageRank_tippedCountMonthRank_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ImageRank_tippedCountMonthRank_idx" ON public."ImageRank" USING btree ("tippedCountMonthRank");


--
-- Name: ImageRank_tippedCountWeekRank_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ImageRank_tippedCountWeekRank_idx" ON public."ImageRank" USING btree ("tippedCountWeekRank");


--
-- Name: ImageRank_tippedCountYearRank_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ImageRank_tippedCountYearRank_idx" ON public."ImageRank" USING btree ("tippedCountYearRank");


--
-- Name: ImageReaction_createdAt_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ImageReaction_createdAt_idx" ON public."ImageReaction" USING btree ("createdAt");


--
-- Name: ImageReaction_imageId_userId_reaction_key; Type: INDEX; Schema: public; Owner: civitai
--

CREATE UNIQUE INDEX "ImageReaction_imageId_userId_reaction_key" ON public."ImageReaction" USING btree ("imageId", "userId", reaction);


--
-- Name: ImageReaction_userId; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ImageReaction_userId" ON public."ImageReaction" USING btree ("userId");


--
-- Name: ImageReport_imageId_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ImageReport_imageId_idx" ON public."ImageReport" USING hash ("imageId");


--
-- Name: ImageReport_reportId_key; Type: INDEX; Schema: public; Owner: civitai
--

CREATE UNIQUE INDEX "ImageReport_reportId_key" ON public."ImageReport" USING btree ("reportId");


--
-- Name: ImageResource_imageId_modelVersionId; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ImageResource_imageId_modelVersionId" ON public."ImageResource" USING btree ("imageId") INCLUDE ("modelVersionId");


--
-- Name: ImageResource_modelVersionId; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ImageResource_modelVersionId" ON public."ImageResource" USING hash ("modelVersionId");


--
-- Name: ImageResource_modelVersionId_imageId; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ImageResource_modelVersionId_imageId" ON public."ImageResource" USING btree ("modelVersionId", "imageId");


--
-- Name: ImageResource_modelVersionId_name_imageId_key; Type: INDEX; Schema: public; Owner: civitai
--

CREATE UNIQUE INDEX "ImageResource_modelVersionId_name_imageId_key" ON public."ImageResource" USING btree ("modelVersionId", name, "imageId");


--
-- Name: ImageTechnique_techniqueId_idx; Type: INDEX; Schema: public; Owner: doadmin
--

CREATE INDEX "ImageTechnique_techniqueId_idx" ON public."ImageTechnique" USING btree ("techniqueId");


--
-- Name: ImageTool_toolId_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ImageTool_toolId_idx" ON public."ImageTool" USING btree ("toolId");


--
-- Name: Image_createdAt; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "Image_createdAt" ON public."Image" USING btree ("createdAt") INCLUDE ("userId", nsfw);


--
-- Name: Image_createdAt_id; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "Image_createdAt_id" ON public."Image" USING btree ("createdAt") INCLUDE (id);


--
-- Name: Image_fromPlatform; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "Image_fromPlatform" ON public."Image" USING btree ("createdAt", id) WHERE ((meta IS NOT NULL) AND (meta ? 'civitaiResources'::text));


--
-- Name: Image_ingestion_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "Image_ingestion_idx" ON public."Image" USING btree (ingestion);


--
-- Name: Image_needsReview_index; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "Image_needsReview_index" ON public."Image" USING btree ("needsReview");


--
-- Name: Image_nsfw; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "Image_nsfw" ON public."Image" USING btree (nsfw) INCLUDE ("postId");


--
-- Name: Image_nsfwLevelLocked; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "Image_nsfwLevelLocked" ON public."Image" USING btree ("nsfwLevelLocked") WHERE "nsfwLevelLocked";


--
-- Name: Image_postId_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "Image_postId_idx" ON public."Image" USING hash ("postId");


--
-- Name: Image_scannedAt; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "Image_scannedAt" ON public."Image" USING btree ("scannedAt");


--
-- Name: Image_type; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "Image_type" ON public."Image" USING btree (type);


--
-- Name: Image_updatedAt_id; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "Image_updatedAt_id" ON public."Image" USING btree ("updatedAt") INCLUDE (id);


--
-- Name: Image_url_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "Image_url_idx" ON public."Image" USING hash (url);


--
-- Name: Image_userId_createdAt; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "Image_userId_createdAt" ON public."Image" USING btree ("userId", "createdAt");


--
-- Name: Image_userId_postId_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "Image_userId_postId_idx" ON public."Image" USING btree ("userId", "postId");


--
-- Name: ImagesOnModels_imageId_key; Type: INDEX; Schema: public; Owner: civitai
--

CREATE UNIQUE INDEX "ImagesOnModels_imageId_key" ON public."ImagesOnModels" USING btree ("imageId");


--
-- Name: ImagesOnModels_modelVersionId_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ImagesOnModels_modelVersionId_idx" ON public."ImagesOnModels" USING hash ("modelVersionId");


--
-- Name: LeaderboardResult_date_id; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "LeaderboardResult_date_id" ON public."LeaderboardResult" USING btree (date);


--
-- Name: LeaderboardResult_leaderboardId_date_userId_key; Type: INDEX; Schema: public; Owner: civitai
--

CREATE UNIQUE INDEX "LeaderboardResult_leaderboardId_date_userId_key" ON public."LeaderboardResult" USING btree ("leaderboardId", date, "userId");


--
-- Name: LeaderboardResult_userId_date_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "LeaderboardResult_userId_date_idx" ON public."LeaderboardResult" USING btree ("userId", date);


--
-- Name: LeaderboardResult_userId_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "LeaderboardResult_userId_idx" ON public."LeaderboardResult" USING hash ("userId");


--
-- Name: ModActivity_activity_entityType_entityId_key; Type: INDEX; Schema: public; Owner: civitai
--

CREATE UNIQUE INDEX "ModActivity_activity_entityType_entityId_key" ON public."ModActivity" USING btree (activity, "entityType", "entityId");


--
-- Name: ModActivity_createdAt_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ModActivity_createdAt_idx" ON public."ModActivity" USING btree ("createdAt");


--
-- Name: ModelAssociations_fromModelId_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ModelAssociations_fromModelId_idx" ON public."ModelAssociations" USING hash ("fromModelId");


--
-- Name: ModelAssociations_toArticleId_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ModelAssociations_toArticleId_idx" ON public."ModelAssociations" USING hash ("toArticleId");


--
-- Name: ModelAssociations_toModelId_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ModelAssociations_toModelId_idx" ON public."ModelAssociations" USING hash ("toModelId");


--
-- Name: ModelEngagement_modelId_createdAt; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ModelEngagement_modelId_createdAt" ON public."ModelEngagement" USING btree ("modelId", "createdAt");


--
-- Name: ModelEngagement_modelId_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ModelEngagement_modelId_idx" ON public."ModelEngagement" USING hash ("modelId");


--
-- Name: ModelEngagement_user_type; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ModelEngagement_user_type" ON public."ModelEngagement" USING btree ("userId", type);


--
-- Name: ModelFile_modelVersionId_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ModelFile_modelVersionId_idx" ON public."ModelFile" USING hash ("modelVersionId");


--
-- Name: ModelFile_type; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ModelFile_type" ON public."ModelFile" USING hash (type);


--
-- Name: ModelFlag_status_idx; Type: INDEX; Schema: public; Owner: doadmin
--

CREATE INDEX "ModelFlag_status_idx" ON public."ModelFlag" USING btree (status);


--
-- Name: ModelMetricDaily_modelVersionId_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ModelMetricDaily_modelVersionId_idx" ON public."ModelMetricDaily" USING btree ("modelVersionId");


--
-- Name: ModelMetric_collectedCount; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ModelMetric_collectedCount" ON public."ModelMetric" USING btree (timeframe, "collectedCount");


--
-- Name: ModelMetric_commentCount; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ModelMetric_commentCount" ON public."ModelMetric" USING btree (timeframe, "commentCount");


--
-- Name: ModelMetric_downloadCount; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ModelMetric_downloadCount" ON public."ModelMetric" USING btree (timeframe, "downloadCount");


--
-- Name: ModelMetric_imageCount; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ModelMetric_imageCount" ON public."ModelMetric" USING btree (timeframe, "imageCount");


--
-- Name: ModelMetric_thumbsUpCount; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ModelMetric_thumbsUpCount" ON public."ModelMetric" USING btree (timeframe, "thumbsUpCount");


--
-- Name: ModelMetric_tippedAmountCount; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ModelMetric_tippedAmountCount" ON public."ModelMetric" USING btree (timeframe, "tippedAmountCount");


--
-- Name: ModelReport_modelId_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ModelReport_modelId_idx" ON public."ModelReport" USING hash ("modelId");


--
-- Name: ModelReport_reportId_key; Type: INDEX; Schema: public; Owner: civitai
--

CREATE UNIQUE INDEX "ModelReport_reportId_key" ON public."ModelReport" USING btree ("reportId");


--
-- Name: ModelVersionMonetization_modelVersionId_key; Type: INDEX; Schema: public; Owner: civitai
--

CREATE UNIQUE INDEX "ModelVersionMonetization_modelVersionId_key" ON public."ModelVersionMonetization" USING btree ("modelVersionId");


--
-- Name: ModelVersionRank_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ModelVersionRank_idx" ON public."ModelVersionRank" USING btree ("modelVersionId");


--
-- Name: ModelVersionSponsorshipSettings_modelVersionMonetizationId_key; Type: INDEX; Schema: public; Owner: civitai
--

CREATE UNIQUE INDEX "ModelVersionSponsorshipSettings_modelVersionMonetizationId_key" ON public."ModelVersionSponsorshipSettings" USING btree ("modelVersionMonetizationId");


--
-- Name: ModelVersion_modelId_baseModel_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ModelVersion_modelId_baseModel_idx" ON public."ModelVersion" USING btree ("modelId", "baseModel");


--
-- Name: ModelVersion_modelId_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ModelVersion_modelId_idx" ON public."ModelVersion" USING hash ("modelId");


--
-- Name: Model_fromImportId_key; Type: INDEX; Schema: public; Owner: civitai
--

CREATE UNIQUE INDEX "Model_fromImportId_key" ON public."Model" USING btree ("fromImportId");


--
-- Name: Model_name_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "Model_name_idx" ON public."Model" USING btree (name text_pattern_ops);


--
-- Name: Model_status_lastVersion; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "Model_status_lastVersion" ON public."Model" USING btree (status, COALESCE("lastVersionAt", 'infinity'::timestamp without time zone));


--
-- Name: Model_status_nsfw_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "Model_status_nsfw_idx" ON public."Model" USING btree (status, nsfw);


--
-- Name: Model_userId; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "Model_userId" ON public."Model" USING btree ("userId");


--
-- Name: Partner_token_key; Type: INDEX; Schema: public; Owner: civitai
--

CREATE UNIQUE INDEX "Partner_token_key" ON public."Partner" USING btree (token);


--
-- Name: PostMetric_collectedCount; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "PostMetric_collectedCount" ON public."PostMetric" USING btree ("ageGroup", "collectedCount") WHERE ((timeframe = 'AllTime'::public."MetricTimeframe") AND ("collectedCount" > 0));


--
-- Name: PostMetric_commentCount; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "PostMetric_commentCount" ON public."PostMetric" USING btree ("ageGroup", "commentCount") WHERE ((timeframe = 'AllTime'::public."MetricTimeframe") AND ("commentCount" > 0));


--
-- Name: PostMetric_reactionCount; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "PostMetric_reactionCount" ON public."PostMetric" USING btree ("ageGroup", "reactionCount") WHERE ((timeframe = 'AllTime'::public."MetricTimeframe") AND ("reactionCount" > 0));


--
-- Name: PostRank_collectedCountAllTimeRank_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "PostRank_collectedCountAllTimeRank_idx" ON public."PostRank" USING btree ("collectedCountAllTimeRank");


--
-- Name: PostRank_collectedCountDayRank_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "PostRank_collectedCountDayRank_idx" ON public."PostRank" USING btree ("collectedCountDayRank");


--
-- Name: PostRank_collectedCountMonthRank_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "PostRank_collectedCountMonthRank_idx" ON public."PostRank" USING btree ("collectedCountMonthRank");


--
-- Name: PostRank_collectedCountWeekRank_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "PostRank_collectedCountWeekRank_idx" ON public."PostRank" USING btree ("collectedCountWeekRank");


--
-- Name: PostRank_collectedCountYearRank_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "PostRank_collectedCountYearRank_idx" ON public."PostRank" USING btree ("collectedCountYearRank");


--
-- Name: PostRank_commentCountAllTimeRank_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "PostRank_commentCountAllTimeRank_idx" ON public."PostRank" USING btree ("commentCountAllTimeRank");


--
-- Name: PostRank_commentCountDayRank_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "PostRank_commentCountDayRank_idx" ON public."PostRank" USING btree ("commentCountDayRank");


--
-- Name: PostRank_commentCountMonthRank_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "PostRank_commentCountMonthRank_idx" ON public."PostRank" USING btree ("commentCountMonthRank");


--
-- Name: PostRank_commentCountWeekRank_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "PostRank_commentCountWeekRank_idx" ON public."PostRank" USING btree ("commentCountWeekRank");


--
-- Name: PostRank_commentCountYearRank_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "PostRank_commentCountYearRank_idx" ON public."PostRank" USING btree ("commentCountYearRank");


--
-- Name: PostRank_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "PostRank_idx" ON public."PostRank" USING btree ("postId");


--
-- Name: PostRank_reactionCountAllTimeRank_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "PostRank_reactionCountAllTimeRank_idx" ON public."PostRank" USING btree ("reactionCountAllTimeRank");


--
-- Name: PostRank_reactionCountDayRank_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "PostRank_reactionCountDayRank_idx" ON public."PostRank" USING btree ("reactionCountDayRank");


--
-- Name: PostRank_reactionCountMonthRank_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "PostRank_reactionCountMonthRank_idx" ON public."PostRank" USING btree ("reactionCountMonthRank");


--
-- Name: PostRank_reactionCountWeekRank_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "PostRank_reactionCountWeekRank_idx" ON public."PostRank" USING btree ("reactionCountWeekRank");


--
-- Name: PostRank_reactionCountYearRank_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "PostRank_reactionCountYearRank_idx" ON public."PostRank" USING btree ("reactionCountYearRank");


--
-- Name: PostReaction_postId_userId_reaction_key; Type: INDEX; Schema: public; Owner: civitai
--

CREATE UNIQUE INDEX "PostReaction_postId_userId_reaction_key" ON public."PostReaction" USING btree ("postId", "userId", reaction);


--
-- Name: PostReport_postId_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "PostReport_postId_idx" ON public."PostReport" USING hash ("postId");


--
-- Name: PostReport_reportId_key; Type: INDEX; Schema: public; Owner: civitai
--

CREATE UNIQUE INDEX "PostReport_reportId_key" ON public."PostReport" USING btree ("reportId");


--
-- Name: Post_availability; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "Post_availability" ON public."Post" USING btree (availability);


--
-- Name: Post_modelVersionId_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "Post_modelVersionId_idx" ON public."Post" USING btree ("modelVersionId");


--
-- Name: Post_modelVersionId_userId_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "Post_modelVersionId_userId_idx" ON public."Post" USING btree ("modelVersionId", "userId");


--
-- Name: Post_publishedAt_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "Post_publishedAt_idx" ON public."Post" USING btree ("publishedAt");


--
-- Name: Post_userId_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "Post_userId_idx" ON public."Post" USING btree ("userId");


--
-- Name: QueryParamsLog_sqlId_hash_key; Type: INDEX; Schema: public; Owner: doadmin
--

CREATE UNIQUE INDEX "QueryParamsLog_sqlId_hash_key" ON public."QueryParamsLog" USING btree ("sqlId", hash);


--
-- Name: QuerySqlLog_hash_key; Type: INDEX; Schema: public; Owner: doadmin
--

CREATE UNIQUE INDEX "QuerySqlLog_hash_key" ON public."QuerySqlLog" USING btree (hash);


--
-- Name: QuestionReaction_questionId_userId_reaction_key; Type: INDEX; Schema: public; Owner: civitai
--

CREATE UNIQUE INDEX "QuestionReaction_questionId_userId_reaction_key" ON public."QuestionReaction" USING btree ("questionId", "userId", reaction);


--
-- Name: Question_selectedAnswerId_key; Type: INDEX; Schema: public; Owner: civitai
--

CREATE UNIQUE INDEX "Question_selectedAnswerId_key" ON public."Question" USING btree ("selectedAnswerId");


--
-- Name: RecommendedResource_sourceId_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "RecommendedResource_sourceId_idx" ON public."RecommendedResource" USING hash ("sourceId");


--
-- Name: ResourceReviewReaction_reviewId_userId_reaction_key; Type: INDEX; Schema: public; Owner: civitai
--

CREATE UNIQUE INDEX "ResourceReviewReaction_reviewId_userId_reaction_key" ON public."ResourceReviewReaction" USING btree ("reviewId", "userId", reaction);


--
-- Name: ResourceReviewReport_reportId_key; Type: INDEX; Schema: public; Owner: civitai
--

CREATE UNIQUE INDEX "ResourceReviewReport_reportId_key" ON public."ResourceReviewReport" USING btree ("reportId");


--
-- Name: ResourceReviewReport_resourceReviewId_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ResourceReviewReport_resourceReviewId_idx" ON public."ResourceReviewReport" USING hash ("resourceReviewId");


--
-- Name: ResourceReview_createdAt_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ResourceReview_createdAt_idx" ON public."ResourceReview" USING btree ("createdAt");


--
-- Name: ResourceReview_modelId_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ResourceReview_modelId_idx" ON public."ResourceReview" USING btree ("modelId") INCLUDE (exclude, "userId", rating);


--
-- Name: ResourceReview_modelVersionId_createdAt_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ResourceReview_modelVersionId_createdAt_idx" ON public."ResourceReview" USING btree ("modelVersionId", "createdAt") INCLUDE (rating, recommended);


--
-- Name: ResourceReview_modelVersionId_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ResourceReview_modelVersionId_idx" ON public."ResourceReview" USING hash ("modelVersionId");


--
-- Name: ResourceReview_modelVersionId_userId_key; Type: INDEX; Schema: public; Owner: civitai
--

CREATE UNIQUE INDEX "ResourceReview_modelVersionId_userId_key" ON public."ResourceReview" USING btree ("modelVersionId", "userId");


--
-- Name: ResourceReview_userId_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "ResourceReview_userId_idx" ON public."ResourceReview" USING hash ("userId");


--
-- Name: RunStrategy_partner_model; Type: INDEX; Schema: public; Owner: civitai
--

CREATE UNIQUE INDEX "RunStrategy_partner_model" ON public."RunStrategy" USING btree ("partnerId", "modelVersionId");


--
-- Name: Session_sessionToken_key; Type: INDEX; Schema: public; Owner: civitai
--

CREATE UNIQUE INDEX "Session_sessionToken_key" ON public."Session" USING btree ("sessionToken");


--
-- Name: TagRank_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "TagRank_idx" ON public."TagRank" USING btree ("tagId");


--
-- Name: Tag_name_key; Type: INDEX; Schema: public; Owner: civitai
--

CREATE UNIQUE INDEX "Tag_name_key" ON public."Tag" USING btree (name);


--
-- Name: Tag_type_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "Tag_type_idx" ON public."Tag" USING btree (type);


--
-- Name: TagsOnArticle_articleId_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "TagsOnArticle_articleId_idx" ON public."TagsOnArticle" USING hash ("articleId");


--
-- Name: TagsOnBounty_bountyId_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "TagsOnBounty_bountyId_idx" ON public."TagsOnBounty" USING hash ("bountyId");


--
-- Name: TagsOnCollection_collectionId_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "TagsOnCollection_collectionId_idx" ON public."TagsOnCollection" USING hash ("collectionId");


--
-- Name: TagsOnImageVote_imageId_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "TagsOnImageVote_imageId_idx" ON public."TagsOnImageVote" USING hash ("imageId");


--
-- Name: TagsOnImageVote_userId_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "TagsOnImageVote_userId_idx" ON public."TagsOnImageVote" USING hash ("userId");


--
-- Name: TagsOnImage_createdAt_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "TagsOnImage_createdAt_idx" ON public."TagsOnImage" USING btree ("createdAt");


--
-- Name: TagsOnImage_disabledAt_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "TagsOnImage_disabledAt_idx" ON public."TagsOnImage" USING btree ("disabledAt");


--
-- Name: TagsOnImage_disabled_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "TagsOnImage_disabled_idx" ON public."TagsOnImage" USING btree (disabled);


--
-- Name: TagsOnImage_imageId_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "TagsOnImage_imageId_idx" ON public."TagsOnImage" USING hash ("imageId");


--
-- Name: TagsOnImage_needsReview; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "TagsOnImage_needsReview" ON public."TagsOnImage" USING btree ("imageId") WHERE "needsReview";


--
-- Name: TagsOnModelsVote_modelId_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "TagsOnModelsVote_modelId_idx" ON public."TagsOnModelsVote" USING hash ("modelId");


--
-- Name: TagsOnModelsVote_userId_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "TagsOnModelsVote_userId_idx" ON public."TagsOnModelsVote" USING hash ("userId");


--
-- Name: TagsOnModels_modelId_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "TagsOnModels_modelId_idx" ON public."TagsOnModels" USING hash ("modelId");


--
-- Name: TagsOnPostVote_postId_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "TagsOnPostVote_postId_idx" ON public."TagsOnPostVote" USING hash ("postId");


--
-- Name: TagsOnPostVote_userId_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "TagsOnPostVote_userId_idx" ON public."TagsOnPostVote" USING hash ("userId");


--
-- Name: TagsOnPost_postId_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "TagsOnPost_postId_idx" ON public."TagsOnPost" USING hash ("postId");


--
-- Name: TagsOnQuestions_questionId_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "TagsOnQuestions_questionId_idx" ON public."TagsOnQuestions" USING hash ("questionId");


--
-- Name: TagsOnTags_toTagId_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "TagsOnTags_toTagId_idx" ON public."TagsOnTags" USING hash ("toTagId");


--
-- Name: Thread_answerId_key; Type: INDEX; Schema: public; Owner: civitai
--

CREATE UNIQUE INDEX "Thread_answerId_key" ON public."Thread" USING btree ("answerId");


--
-- Name: Thread_articleId_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "Thread_articleId_idx" ON public."Thread" USING hash ("articleId");


--
-- Name: Thread_articleId_key; Type: INDEX; Schema: public; Owner: civitai
--

CREATE UNIQUE INDEX "Thread_articleId_key" ON public."Thread" USING btree ("articleId");


--
-- Name: Thread_bountyEntryId_key; Type: INDEX; Schema: public; Owner: civitai
--

CREATE UNIQUE INDEX "Thread_bountyEntryId_key" ON public."Thread" USING btree ("bountyEntryId");


--
-- Name: Thread_bountyId_key; Type: INDEX; Schema: public; Owner: civitai
--

CREATE UNIQUE INDEX "Thread_bountyId_key" ON public."Thread" USING btree ("bountyId");


--
-- Name: Thread_clubPostId_key; Type: INDEX; Schema: public; Owner: civitai
--

CREATE UNIQUE INDEX "Thread_clubPostId_key" ON public."Thread" USING btree ("clubPostId");


--
-- Name: Thread_commentId_key; Type: INDEX; Schema: public; Owner: civitai
--

CREATE UNIQUE INDEX "Thread_commentId_key" ON public."Thread" USING btree ("commentId");


--
-- Name: Thread_imageId_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "Thread_imageId_idx" ON public."Thread" USING hash ("imageId");


--
-- Name: Thread_imageId_key; Type: INDEX; Schema: public; Owner: civitai
--

CREATE UNIQUE INDEX "Thread_imageId_key" ON public."Thread" USING btree ("imageId");


--
-- Name: Thread_modelId_key; Type: INDEX; Schema: public; Owner: civitai
--

CREATE UNIQUE INDEX "Thread_modelId_key" ON public."Thread" USING btree ("modelId");


--
-- Name: Thread_parentThreadId_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "Thread_parentThreadId_idx" ON public."Thread" USING hash ("parentThreadId");


--
-- Name: Thread_postId_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "Thread_postId_idx" ON public."Thread" USING hash ("postId");


--
-- Name: Thread_postId_key; Type: INDEX; Schema: public; Owner: civitai
--

CREATE UNIQUE INDEX "Thread_postId_key" ON public."Thread" USING btree ("postId");


--
-- Name: Thread_questionId_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "Thread_questionId_idx" ON public."Thread" USING hash ("questionId");


--
-- Name: Thread_questionId_key; Type: INDEX; Schema: public; Owner: civitai
--

CREATE UNIQUE INDEX "Thread_questionId_key" ON public."Thread" USING btree ("questionId");


--
-- Name: Thread_reviewId_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "Thread_reviewId_idx" ON public."Thread" USING hash ("reviewId");


--
-- Name: Thread_reviewId_key; Type: INDEX; Schema: public; Owner: civitai
--

CREATE UNIQUE INDEX "Thread_reviewId_key" ON public."Thread" USING btree ("reviewId");


--
-- Name: UserCosmetic_equippedTo; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "UserCosmetic_equippedTo" ON public."UserCosmetic" USING btree ("equippedToType", "equippedToId") WHERE ("equippedToType" IS NOT NULL);


--
-- Name: UserEngagement_type_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "UserEngagement_type_idx" ON public."UserEngagement" USING btree (type);


--
-- Name: UserLink_userId; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "UserLink_userId" ON public."UserLink" USING btree ("userId");


--
-- Name: UserNotificationSettings_userId_type_key; Type: INDEX; Schema: public; Owner: civitai
--

CREATE UNIQUE INDEX "UserNotificationSettings_userId_type_key" ON public."UserNotificationSettings" USING btree ("userId", type);


--
-- Name: UserProfile_coverImageId; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "UserProfile_coverImageId" ON public."UserProfile" USING btree ("coverImageId");


--
-- Name: UserRank_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "UserRank_idx" ON public."UserRank" USING btree ("userId");


--
-- Name: UserRank_leaderboardRank_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "UserRank_leaderboardRank_idx" ON public."UserRank" USING btree ("leaderboardRank");


--
-- Name: UserReferralCode_code_key; Type: INDEX; Schema: public; Owner: civitai
--

CREATE UNIQUE INDEX "UserReferralCode_code_key" ON public."UserReferralCode" USING btree (code);


--
-- Name: UserReferralCode_userId_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "UserReferralCode_userId_idx" ON public."UserReferralCode" USING hash ("userId");


--
-- Name: UserReferral_userId_key; Type: INDEX; Schema: public; Owner: civitai
--

CREATE UNIQUE INDEX "UserReferral_userId_key" ON public."UserReferral" USING btree ("userId");


--
-- Name: UserReport_reportId_key; Type: INDEX; Schema: public; Owner: civitai
--

CREATE UNIQUE INDEX "UserReport_reportId_key" ON public."UserReport" USING btree ("reportId");


--
-- Name: UserReport_userId_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "UserReport_userId_idx" ON public."UserReport" USING hash ("userId");


--
-- Name: UserStripeConnect_connectedAccountId_key; Type: INDEX; Schema: public; Owner: civitai
--

CREATE UNIQUE INDEX "UserStripeConnect_connectedAccountId_key" ON public."UserStripeConnect" USING btree ("connectedAccountId");


--
-- Name: UserStripeConnect_userId_key; Type: INDEX; Schema: public; Owner: civitai
--

CREATE UNIQUE INDEX "UserStripeConnect_userId_key" ON public."UserStripeConnect" USING btree ("userId");


--
-- Name: User_banned; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "User_banned" ON public."User" USING btree ("bannedAt") WHERE ("bannedAt" IS NOT NULL);


--
-- Name: User_bookmark_collection; Type: INDEX; Schema: public; Owner: civitai
--

CREATE UNIQUE INDEX "User_bookmark_collection" ON public."Collection" USING btree ("userId", type, mode) WHERE (mode = 'Bookmark'::public."CollectionMode");


--
-- Name: User_customerId_key; Type: INDEX; Schema: public; Owner: civitai
--

CREATE UNIQUE INDEX "User_customerId_key" ON public."User" USING btree ("customerId");


--
-- Name: User_email_key; Type: INDEX; Schema: public; Owner: civitai
--

CREATE UNIQUE INDEX "User_email_key" ON public."User" USING btree (email);


--
-- Name: User_muted; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "User_muted" ON public."User" USING btree (muted) WHERE muted;


--
-- Name: User_paddleCustomerId_key; Type: INDEX; Schema: public; Owner: civitai
--

CREATE UNIQUE INDEX "User_paddleCustomerId_key" ON public."User" USING btree ("paddleCustomerId");


--
-- Name: User_profilePictureId_key; Type: INDEX; Schema: public; Owner: civitai
--

CREATE UNIQUE INDEX "User_profilePictureId_key" ON public."User" USING btree ("profilePictureId");


--
-- Name: User_rewardsEligibility; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "User_rewardsEligibility" ON public."User" USING btree ("eligibilityChangedAt") WHERE ("eligibilityChangedAt" IS NOT NULL);


--
-- Name: User_username_key; Type: INDEX; Schema: public; Owner: civitai
--

CREATE UNIQUE INDEX "User_username_key" ON public."User" USING btree (username);


--
-- Name: VaultItem_modelVersionId_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "VaultItem_modelVersionId_idx" ON public."VaultItem" USING hash ("modelVersionId");


--
-- Name: VaultItem_vaultId_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "VaultItem_vaultId_idx" ON public."VaultItem" USING hash ("vaultId");


--
-- Name: VerificationToken_identifier_token_key; Type: INDEX; Schema: public; Owner: civitai
--

CREATE UNIQUE INDEX "VerificationToken_identifier_token_key" ON public."VerificationToken" USING btree (identifier, token);


--
-- Name: VerificationToken_token_key; Type: INDEX; Schema: public; Owner: civitai
--

CREATE UNIQUE INDEX "VerificationToken_token_key" ON public."VerificationToken" USING btree (token);


--
-- Name: Webhook_url_userId_key; Type: INDEX; Schema: public; Owner: civitai
--

CREATE UNIQUE INDEX "Webhook_url_userId_key" ON public."Webhook" USING btree (url, "userId");


--
-- Name: _LicenseToModel_AB_unique; Type: INDEX; Schema: public; Owner: civitai
--

CREATE UNIQUE INDEX "_LicenseToModel_AB_unique" ON public."_LicenseToModel" USING btree ("A", "B");


--
-- Name: _LicenseToModel_B_index; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "_LicenseToModel_B_index" ON public."_LicenseToModel" USING btree ("B");


--
-- Name: image_userid_id_idx; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX image_userid_id_idx ON public."Image" USING btree ("userId", id);


--
-- Name: modelFileHash_hash_cs; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "modelFileHash_hash_cs" ON public."ModelFileHash" USING hash (hash);


--
-- Name: modelFile_trainingEnded; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX "modelFile_trainingEnded" ON public."ModelFile" USING btree ((((metadata -> 'trainingResults'::text) ->> 'end_time'::text))) WHERE (type = 'Training Data'::text);


--
-- Name: modelfilehash_hash; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX modelfilehash_hash ON public."ModelFileHash" USING btree (lower((hash)::text));


--
-- Name: user_createdat; Type: INDEX; Schema: public; Owner: civitai
--

CREATE INDEX user_createdat ON public."User" USING btree ("createdAt");


--
-- Name: BountyStat _RETURN; Type: RULE; Schema: public; Owner: civitai
--

CREATE OR REPLACE VIEW public."BountyStat" AS
 WITH stats_timeframe AS (
         SELECT m."bountyId",
            m.timeframe,
            COALESCE(m."favoriteCount", 0) AS "favoriteCount",
            COALESCE(m."trackCount", 0) AS "trackCount",
            COALESCE(m."entryCount", 0) AS "entryCount",
            COALESCE(m."benefactorCount", 0) AS "benefactorCount",
            COALESCE(m."unitAmountCount", 0) AS "unitAmountCount",
            COALESCE(m."commentCount", 0) AS "commentCount"
           FROM public."BountyMetric" m
          GROUP BY m."bountyId", m.timeframe
        )
 SELECT stats_timeframe."bountyId",
    max(public.iif((stats_timeframe.timeframe = 'Day'::public."MetricTimeframe"), stats_timeframe."favoriteCount", NULL::integer)) AS "favoriteCountDay",
    max(public.iif((stats_timeframe.timeframe = 'Week'::public."MetricTimeframe"), stats_timeframe."favoriteCount", NULL::integer)) AS "favoriteCountWeek",
    max(public.iif((stats_timeframe.timeframe = 'Month'::public."MetricTimeframe"), stats_timeframe."favoriteCount", NULL::integer)) AS "favoriteCountMonth",
    max(public.iif((stats_timeframe.timeframe = 'Year'::public."MetricTimeframe"), stats_timeframe."favoriteCount", NULL::integer)) AS "favoriteCountYear",
    max(public.iif((stats_timeframe.timeframe = 'AllTime'::public."MetricTimeframe"), stats_timeframe."favoriteCount", NULL::integer)) AS "favoriteCountAllTime",
    max(public.iif((stats_timeframe.timeframe = 'Day'::public."MetricTimeframe"), stats_timeframe."trackCount", NULL::integer)) AS "trackCountDay",
    max(public.iif((stats_timeframe.timeframe = 'Week'::public."MetricTimeframe"), stats_timeframe."trackCount", NULL::integer)) AS "trackCountWeek",
    max(public.iif((stats_timeframe.timeframe = 'Month'::public."MetricTimeframe"), stats_timeframe."trackCount", NULL::integer)) AS "trackCountMonth",
    max(public.iif((stats_timeframe.timeframe = 'Year'::public."MetricTimeframe"), stats_timeframe."trackCount", NULL::integer)) AS "trackCountYear",
    max(public.iif((stats_timeframe.timeframe = 'AllTime'::public."MetricTimeframe"), stats_timeframe."trackCount", NULL::integer)) AS "trackCountAllTime",
    max(public.iif((stats_timeframe.timeframe = 'Day'::public."MetricTimeframe"), stats_timeframe."entryCount", NULL::integer)) AS "entryCountDay",
    max(public.iif((stats_timeframe.timeframe = 'Week'::public."MetricTimeframe"), stats_timeframe."entryCount", NULL::integer)) AS "entryCountWeek",
    max(public.iif((stats_timeframe.timeframe = 'Month'::public."MetricTimeframe"), stats_timeframe."entryCount", NULL::integer)) AS "entryCountMonth",
    max(public.iif((stats_timeframe.timeframe = 'Year'::public."MetricTimeframe"), stats_timeframe."entryCount", NULL::integer)) AS "entryCountYear",
    max(public.iif((stats_timeframe.timeframe = 'AllTime'::public."MetricTimeframe"), stats_timeframe."entryCount", NULL::integer)) AS "entryCountAllTime",
    max(public.iif((stats_timeframe.timeframe = 'Day'::public."MetricTimeframe"), stats_timeframe."benefactorCount", NULL::integer)) AS "benefactorCountDay",
    max(public.iif((stats_timeframe.timeframe = 'Week'::public."MetricTimeframe"), stats_timeframe."benefactorCount", NULL::integer)) AS "benefactorCountWeek",
    max(public.iif((stats_timeframe.timeframe = 'Month'::public."MetricTimeframe"), stats_timeframe."benefactorCount", NULL::integer)) AS "benefactorCountMonth",
    max(public.iif((stats_timeframe.timeframe = 'Year'::public."MetricTimeframe"), stats_timeframe."benefactorCount", NULL::integer)) AS "benefactorCountYear",
    max(public.iif((stats_timeframe.timeframe = 'AllTime'::public."MetricTimeframe"), stats_timeframe."benefactorCount", NULL::integer)) AS "benefactorCountAllTime",
    max(public.iif((stats_timeframe.timeframe = 'Day'::public."MetricTimeframe"), stats_timeframe."unitAmountCount", NULL::integer)) AS "unitAmountCountDay",
    max(public.iif((stats_timeframe.timeframe = 'Week'::public."MetricTimeframe"), stats_timeframe."unitAmountCount", NULL::integer)) AS "unitAmountCountWeek",
    max(public.iif((stats_timeframe.timeframe = 'Month'::public."MetricTimeframe"), stats_timeframe."unitAmountCount", NULL::integer)) AS "unitAmountCountMonth",
    max(public.iif((stats_timeframe.timeframe = 'Year'::public."MetricTimeframe"), stats_timeframe."unitAmountCount", NULL::integer)) AS "unitAmountCountYear",
    max(public.iif((stats_timeframe.timeframe = 'AllTime'::public."MetricTimeframe"), stats_timeframe."unitAmountCount", NULL::integer)) AS "unitAmountCountAllTime",
    max(public.iif((stats_timeframe.timeframe = 'Day'::public."MetricTimeframe"), stats_timeframe."commentCount", NULL::integer)) AS "commentCountDay",
    max(public.iif((stats_timeframe.timeframe = 'Week'::public."MetricTimeframe"), stats_timeframe."commentCount", NULL::integer)) AS "commentCountWeek",
    max(public.iif((stats_timeframe.timeframe = 'Month'::public."MetricTimeframe"), stats_timeframe."commentCount", NULL::integer)) AS "commentCountMonth",
    max(public.iif((stats_timeframe.timeframe = 'Year'::public."MetricTimeframe"), stats_timeframe."commentCount", NULL::integer)) AS "commentCountYear",
    max(public.iif((stats_timeframe.timeframe = 'AllTime'::public."MetricTimeframe"), stats_timeframe."commentCount", NULL::integer)) AS "commentCountAllTime"
   FROM stats_timeframe
  GROUP BY stats_timeframe."bountyId";


--
-- Name: BountyEntryStat _RETURN; Type: RULE; Schema: public; Owner: civitai
--

CREATE OR REPLACE VIEW public."BountyEntryStat" AS
 WITH stats_timeframe AS (
         SELECT m."bountyEntryId",
            m.timeframe,
            COALESCE(m."heartCount", 0) AS "heartCount",
            COALESCE(m."likeCount", 0) AS "likeCount",
            COALESCE(m."dislikeCount", 0) AS "dislikeCount",
            COALESCE(m."laughCount", 0) AS "laughCount",
            COALESCE(m."cryCount", 0) AS "cryCount",
            ((((COALESCE(m."heartCount", 0) + COALESCE(m."likeCount", 0)) + COALESCE(m."dislikeCount", 0)) + COALESCE(m."laughCount", 0)) + COALESCE(m."cryCount", 0)) AS "reactionCount",
            COALESCE(m."unitAmountCount", 0) AS "unitAmountCount",
            COALESCE(m."tippedCount", 0) AS "tippedCount",
            COALESCE(m."tippedAmountCount", 0) AS "tippedAmountCount"
           FROM public."BountyEntryMetric" m
          GROUP BY m."bountyEntryId", m.timeframe
        )
 SELECT stats_timeframe."bountyEntryId",
    max(public.iif((stats_timeframe.timeframe = 'Day'::public."MetricTimeframe"), stats_timeframe."heartCount", NULL::integer)) AS "heartCountDay",
    max(public.iif((stats_timeframe.timeframe = 'Week'::public."MetricTimeframe"), stats_timeframe."heartCount", NULL::integer)) AS "heartCountWeek",
    max(public.iif((stats_timeframe.timeframe = 'Month'::public."MetricTimeframe"), stats_timeframe."heartCount", NULL::integer)) AS "heartCountMonth",
    max(public.iif((stats_timeframe.timeframe = 'Year'::public."MetricTimeframe"), stats_timeframe."heartCount", NULL::integer)) AS "heartCountYear",
    max(public.iif((stats_timeframe.timeframe = 'AllTime'::public."MetricTimeframe"), stats_timeframe."heartCount", NULL::integer)) AS "heartCountAllTime",
    max(public.iif((stats_timeframe.timeframe = 'Day'::public."MetricTimeframe"), stats_timeframe."likeCount", NULL::integer)) AS "likeCountDay",
    max(public.iif((stats_timeframe.timeframe = 'Week'::public."MetricTimeframe"), stats_timeframe."likeCount", NULL::integer)) AS "likeCountWeek",
    max(public.iif((stats_timeframe.timeframe = 'Month'::public."MetricTimeframe"), stats_timeframe."likeCount", NULL::integer)) AS "likeCountMonth",
    max(public.iif((stats_timeframe.timeframe = 'Year'::public."MetricTimeframe"), stats_timeframe."likeCount", NULL::integer)) AS "likeCountYear",
    max(public.iif((stats_timeframe.timeframe = 'AllTime'::public."MetricTimeframe"), stats_timeframe."likeCount", NULL::integer)) AS "likeCountAllTime",
    max(public.iif((stats_timeframe.timeframe = 'Day'::public."MetricTimeframe"), stats_timeframe."dislikeCount", NULL::integer)) AS "dislikeCountDay",
    max(public.iif((stats_timeframe.timeframe = 'Week'::public."MetricTimeframe"), stats_timeframe."dislikeCount", NULL::integer)) AS "dislikeCountWeek",
    max(public.iif((stats_timeframe.timeframe = 'Month'::public."MetricTimeframe"), stats_timeframe."dislikeCount", NULL::integer)) AS "dislikeCountMonth",
    max(public.iif((stats_timeframe.timeframe = 'Year'::public."MetricTimeframe"), stats_timeframe."dislikeCount", NULL::integer)) AS "dislikeCountYear",
    max(public.iif((stats_timeframe.timeframe = 'AllTime'::public."MetricTimeframe"), stats_timeframe."dislikeCount", NULL::integer)) AS "dislikeCountAllTime",
    max(public.iif((stats_timeframe.timeframe = 'Day'::public."MetricTimeframe"), stats_timeframe."laughCount", NULL::integer)) AS "laughCountDay",
    max(public.iif((stats_timeframe.timeframe = 'Week'::public."MetricTimeframe"), stats_timeframe."laughCount", NULL::integer)) AS "laughCountWeek",
    max(public.iif((stats_timeframe.timeframe = 'Month'::public."MetricTimeframe"), stats_timeframe."laughCount", NULL::integer)) AS "laughCountMonth",
    max(public.iif((stats_timeframe.timeframe = 'Year'::public."MetricTimeframe"), stats_timeframe."laughCount", NULL::integer)) AS "laughCountYear",
    max(public.iif((stats_timeframe.timeframe = 'AllTime'::public."MetricTimeframe"), stats_timeframe."laughCount", NULL::integer)) AS "laughCountAllTime",
    max(public.iif((stats_timeframe.timeframe = 'Day'::public."MetricTimeframe"), stats_timeframe."cryCount", NULL::integer)) AS "cryCountDay",
    max(public.iif((stats_timeframe.timeframe = 'Week'::public."MetricTimeframe"), stats_timeframe."cryCount", NULL::integer)) AS "cryCountWeek",
    max(public.iif((stats_timeframe.timeframe = 'Month'::public."MetricTimeframe"), stats_timeframe."cryCount", NULL::integer)) AS "cryCountMonth",
    max(public.iif((stats_timeframe.timeframe = 'Year'::public."MetricTimeframe"), stats_timeframe."cryCount", NULL::integer)) AS "cryCountYear",
    max(public.iif((stats_timeframe.timeframe = 'AllTime'::public."MetricTimeframe"), stats_timeframe."cryCount", NULL::integer)) AS "cryCountAllTime",
    max(public.iif((stats_timeframe.timeframe = 'Day'::public."MetricTimeframe"), ((((stats_timeframe."heartCount" + stats_timeframe."dislikeCount") + stats_timeframe."likeCount") + stats_timeframe."cryCount") + stats_timeframe."laughCount"), NULL::integer)) AS "reactionCountDay",
    max(public.iif((stats_timeframe.timeframe = 'Week'::public."MetricTimeframe"), ((((stats_timeframe."heartCount" + stats_timeframe."dislikeCount") + stats_timeframe."likeCount") + stats_timeframe."cryCount") + stats_timeframe."laughCount"), NULL::integer)) AS "reactionCountWeek",
    max(public.iif((stats_timeframe.timeframe = 'Month'::public."MetricTimeframe"), ((((stats_timeframe."heartCount" + stats_timeframe."dislikeCount") + stats_timeframe."likeCount") + stats_timeframe."cryCount") + stats_timeframe."laughCount"), NULL::integer)) AS "reactionCountMonth",
    max(public.iif((stats_timeframe.timeframe = 'Year'::public."MetricTimeframe"), ((((stats_timeframe."heartCount" + stats_timeframe."dislikeCount") + stats_timeframe."likeCount") + stats_timeframe."cryCount") + stats_timeframe."laughCount"), NULL::integer)) AS "reactionCountYear",
    max(public.iif((stats_timeframe.timeframe = 'AllTime'::public."MetricTimeframe"), ((((stats_timeframe."heartCount" + stats_timeframe."dislikeCount") + stats_timeframe."likeCount") + stats_timeframe."cryCount") + stats_timeframe."laughCount"), NULL::integer)) AS "reactionCountAllTime",
    max(public.iif((stats_timeframe.timeframe = 'Day'::public."MetricTimeframe"), stats_timeframe."unitAmountCount", NULL::integer)) AS "unitAmountCountDay",
    max(public.iif((stats_timeframe.timeframe = 'Week'::public."MetricTimeframe"), stats_timeframe."unitAmountCount", NULL::integer)) AS "unitAmountCountWeek",
    max(public.iif((stats_timeframe.timeframe = 'Month'::public."MetricTimeframe"), stats_timeframe."unitAmountCount", NULL::integer)) AS "unitAmountCountMonth",
    max(public.iif((stats_timeframe.timeframe = 'Year'::public."MetricTimeframe"), stats_timeframe."unitAmountCount", NULL::integer)) AS "unitAmountCountYear",
    max(public.iif((stats_timeframe.timeframe = 'AllTime'::public."MetricTimeframe"), stats_timeframe."unitAmountCount", NULL::integer)) AS "unitAmountCountAllTime",
    max(public.iif((stats_timeframe.timeframe = 'Day'::public."MetricTimeframe"), stats_timeframe."tippedCount", NULL::integer)) AS "tippedCountDay",
    max(public.iif((stats_timeframe.timeframe = 'Week'::public."MetricTimeframe"), stats_timeframe."tippedCount", NULL::integer)) AS "tippedCountWeek",
    max(public.iif((stats_timeframe.timeframe = 'Month'::public."MetricTimeframe"), stats_timeframe."tippedCount", NULL::integer)) AS "tippedCountMonth",
    max(public.iif((stats_timeframe.timeframe = 'Year'::public."MetricTimeframe"), stats_timeframe."tippedCount", NULL::integer)) AS "tippedCountYear",
    max(public.iif((stats_timeframe.timeframe = 'AllTime'::public."MetricTimeframe"), stats_timeframe."tippedCount", NULL::integer)) AS "tippedCountAllTime",
    max(public.iif((stats_timeframe.timeframe = 'Day'::public."MetricTimeframe"), stats_timeframe."tippedAmountCount", NULL::integer)) AS "tippedAmountCountDay",
    max(public.iif((stats_timeframe.timeframe = 'Week'::public."MetricTimeframe"), stats_timeframe."tippedAmountCount", NULL::integer)) AS "tippedAmountCountWeek",
    max(public.iif((stats_timeframe.timeframe = 'Month'::public."MetricTimeframe"), stats_timeframe."tippedAmountCount", NULL::integer)) AS "tippedAmountCountMonth",
    max(public.iif((stats_timeframe.timeframe = 'Year'::public."MetricTimeframe"), stats_timeframe."tippedAmountCount", NULL::integer)) AS "tippedAmountCountYear",
    max(public.iif((stats_timeframe.timeframe = 'AllTime'::public."MetricTimeframe"), stats_timeframe."tippedAmountCount", NULL::integer)) AS "tippedAmountCountAllTime"
   FROM stats_timeframe
  GROUP BY stats_timeframe."bountyEntryId";


--
-- Name: ClubStat _RETURN; Type: RULE; Schema: public; Owner: civitai
--

CREATE OR REPLACE VIEW public."ClubStat" AS
 WITH stats_timeframe AS (
         SELECT m."clubId",
            m.timeframe,
            COALESCE(m."memberCount", 0) AS "memberCount",
            COALESCE(m."resourceCount", 0) AS "resourceCount",
            COALESCE(m."clubPostCount", 0) AS "clubPostCount"
           FROM public."ClubMetric" m
          GROUP BY m."clubId", m.timeframe
        )
 SELECT stats_timeframe."clubId",
    max(public.iif((stats_timeframe.timeframe = 'Day'::public."MetricTimeframe"), stats_timeframe."memberCount", NULL::integer)) AS "memberCountDay",
    max(public.iif((stats_timeframe.timeframe = 'Week'::public."MetricTimeframe"), stats_timeframe."memberCount", NULL::integer)) AS "memberCountWeek",
    max(public.iif((stats_timeframe.timeframe = 'Month'::public."MetricTimeframe"), stats_timeframe."memberCount", NULL::integer)) AS "memberCountMonth",
    max(public.iif((stats_timeframe.timeframe = 'Year'::public."MetricTimeframe"), stats_timeframe."memberCount", NULL::integer)) AS "memberCountYear",
    max(public.iif((stats_timeframe.timeframe = 'AllTime'::public."MetricTimeframe"), stats_timeframe."memberCount", NULL::integer)) AS "memberCountAllTime",
    max(public.iif((stats_timeframe.timeframe = 'Day'::public."MetricTimeframe"), stats_timeframe."resourceCount", NULL::integer)) AS "resourceCountDay",
    max(public.iif((stats_timeframe.timeframe = 'Week'::public."MetricTimeframe"), stats_timeframe."resourceCount", NULL::integer)) AS "resourceCountWeek",
    max(public.iif((stats_timeframe.timeframe = 'Month'::public."MetricTimeframe"), stats_timeframe."resourceCount", NULL::integer)) AS "resourceCountMonth",
    max(public.iif((stats_timeframe.timeframe = 'Year'::public."MetricTimeframe"), stats_timeframe."resourceCount", NULL::integer)) AS "resourceCountYear",
    max(public.iif((stats_timeframe.timeframe = 'AllTime'::public."MetricTimeframe"), stats_timeframe."resourceCount", NULL::integer)) AS "resourceCountAllTime",
    max(public.iif((stats_timeframe.timeframe = 'Day'::public."MetricTimeframe"), stats_timeframe."clubPostCount", NULL::integer)) AS "clubPostCountDay",
    max(public.iif((stats_timeframe.timeframe = 'Week'::public."MetricTimeframe"), stats_timeframe."clubPostCount", NULL::integer)) AS "clubPostCountWeek",
    max(public.iif((stats_timeframe.timeframe = 'Month'::public."MetricTimeframe"), stats_timeframe."clubPostCount", NULL::integer)) AS "clubPostCountMonth",
    max(public.iif((stats_timeframe.timeframe = 'Year'::public."MetricTimeframe"), stats_timeframe."clubPostCount", NULL::integer)) AS "clubPostCountYear",
    max(public.iif((stats_timeframe.timeframe = 'AllTime'::public."MetricTimeframe"), stats_timeframe."clubPostCount", NULL::integer)) AS "clubPostCountAllTime"
   FROM stats_timeframe
  GROUP BY stats_timeframe."clubId";


--
-- Name: Image add_metrics_after_insert; Type: TRIGGER; Schema: public; Owner: civitai
--

CREATE TRIGGER add_metrics_after_insert AFTER INSERT ON public."Image" FOR EACH ROW EXECUTE FUNCTION public.add_image_metrics();


--
-- Name: Model add_metrics_after_insert; Type: TRIGGER; Schema: public; Owner: civitai
--

CREATE TRIGGER add_metrics_after_insert AFTER INSERT ON public."Model" FOR EACH ROW EXECUTE FUNCTION public.add_model_metrics();


--
-- Name: Article article_nsfw_level_change; Type: TRIGGER; Schema: public; Owner: civitai
--

CREATE TRIGGER article_nsfw_level_change AFTER DELETE OR UPDATE OF "publishedAt", "userNsfwLevel" ON public."Article" FOR EACH ROW EXECUTE FUNCTION public.update_article_nsfw_level();


--
-- Name: Bounty bounty_nsfw_level_change; Type: TRIGGER; Schema: public; Owner: civitai
--

CREATE TRIGGER bounty_nsfw_level_change AFTER UPDATE OF nsfw ON public."Bounty" FOR EACH ROW EXECUTE FUNCTION public.update_bounty_nsfw_level();


--
-- Name: CollectionItem collection_nsfw_level_change; Type: TRIGGER; Schema: public; Owner: civitai
--

CREATE TRIGGER collection_nsfw_level_change AFTER INSERT OR DELETE OR UPDATE OF status ON public."CollectionItem" FOR EACH ROW EXECUTE FUNCTION public.update_collection_nsfw_level();


--
-- Name: Image image_nsfw_level_change; Type: TRIGGER; Schema: public; Owner: civitai
--

CREATE TRIGGER image_nsfw_level_change AFTER DELETE OR UPDATE OF "nsfwLevel" ON public."Image" FOR EACH ROW EXECUTE FUNCTION public.update_image_nsfw_level();


--
-- Name: Model model_nsfw_level_change; Type: TRIGGER; Schema: public; Owner: civitai
--

CREATE TRIGGER model_nsfw_level_change AFTER DELETE OR UPDATE OF status, nsfw ON public."Model" FOR EACH ROW EXECUTE FUNCTION public.update_model_nsfw_level();


--
-- Name: Model model_poi_change; Type: TRIGGER; Schema: public; Owner: civitai
--

CREATE TRIGGER model_poi_change AFTER UPDATE OF poi ON public."Model" FOR EACH ROW WHEN ((old.poi IS DISTINCT FROM new.poi)) EXECUTE FUNCTION public.update_image_poi();


--
-- Name: ModelVersion model_version_nsfw_level_change; Type: TRIGGER; Schema: public; Owner: civitai
--

CREATE TRIGGER model_version_nsfw_level_change AFTER DELETE OR UPDATE OF status ON public."ModelVersion" FOR EACH ROW EXECUTE FUNCTION public.update_model_version_nsfw_level();


--
-- Name: Post post_nsfw_level_change; Type: TRIGGER; Schema: public; Owner: civitai
--

CREATE TRIGGER post_nsfw_level_change AFTER DELETE OR UPDATE OF "publishedAt" ON public."Post" FOR EACH ROW EXECUTE FUNCTION public.update_post_nsfw_level();


--
-- Name: Post post_published_at_change; Type: TRIGGER; Schema: public; Owner: civitai
--

CREATE TRIGGER post_published_at_change AFTER UPDATE OF "publishedAt" ON public."Post" FOR EACH ROW EXECUTE FUNCTION public.update_image_sort_at();


--
-- Name: Post publish_post_metrics_trigger; Type: TRIGGER; Schema: public; Owner: civitai
--

CREATE TRIGGER publish_post_metrics_trigger AFTER UPDATE OF "publishedAt" ON public."Post" FOR EACH ROW WHEN ((new."publishedAt" IS DISTINCT FROM old."publishedAt")) EXECUTE FUNCTION public.publish_post_metrics();


--
-- Name: BuzzWithdrawalRequest trigger_create_buzz_withdrawal_request_history_on_insert; Type: TRIGGER; Schema: public; Owner: civitai
--

CREATE TRIGGER trigger_create_buzz_withdrawal_request_history_on_insert AFTER INSERT ON public."BuzzWithdrawalRequest" FOR EACH ROW EXECUTE FUNCTION public.create_buzz_withdrawal_request_history_on_insert();


--
-- Name: ModelVersion trigger_early_access_ends_at; Type: TRIGGER; Schema: public; Owner: civitai
--

CREATE TRIGGER trigger_early_access_ends_at AFTER INSERT OR UPDATE OF "earlyAccessConfig", "publishedAt" ON public."ModelVersion" FOR EACH ROW EXECUTE FUNCTION public.early_access_ends_at();


--
-- Name: BuzzWithdrawalRequestHistory trigger_update_buzz_withdrawal_request_status; Type: TRIGGER; Schema: public; Owner: civitai
--

CREATE TRIGGER trigger_update_buzz_withdrawal_request_status AFTER INSERT ON public."BuzzWithdrawalRequestHistory" FOR EACH ROW EXECUTE FUNCTION public.update_buzz_withdrawal_request_status();


--
-- Name: User trigger_update_muted_at; Type: TRIGGER; Schema: public; Owner: civitai
--

CREATE TRIGGER trigger_update_muted_at BEFORE UPDATE OF muted ON public."User" FOR EACH ROW EXECUTE FUNCTION public.update_muted_at();


--
-- Name: ModelFileHash truncate_autov3_hash_on_insert; Type: TRIGGER; Schema: public; Owner: civitai
--

CREATE TRIGGER truncate_autov3_hash_on_insert BEFORE INSERT ON public."ModelFileHash" FOR EACH ROW EXECUTE FUNCTION public.truncate_autov3_hash();


--
-- Name: Account Account_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Account"
    ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: AnswerMetric AnswerMetric_answerId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."AnswerMetric"
    ADD CONSTRAINT "AnswerMetric_answerId_fkey" FOREIGN KEY ("answerId") REFERENCES public."Answer"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: AnswerReaction AnswerReaction_answerId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."AnswerReaction"
    ADD CONSTRAINT "AnswerReaction_answerId_fkey" FOREIGN KEY ("answerId") REFERENCES public."Answer"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: AnswerReaction AnswerReaction_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."AnswerReaction"
    ADD CONSTRAINT "AnswerReaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: AnswerVote AnswerVote_answerId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."AnswerVote"
    ADD CONSTRAINT "AnswerVote_answerId_fkey" FOREIGN KEY ("answerId") REFERENCES public."Answer"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: AnswerVote AnswerVote_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."AnswerVote"
    ADD CONSTRAINT "AnswerVote_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: Answer Answer_questionId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Answer"
    ADD CONSTRAINT "Answer_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES public."Question"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: Answer Answer_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Answer"
    ADD CONSTRAINT "Answer_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ApiKey ApiKey_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ApiKey"
    ADD CONSTRAINT "ApiKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ArticleEngagement ArticleEngagement_articleId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ArticleEngagement"
    ADD CONSTRAINT "ArticleEngagement_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES public."Article"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ArticleEngagement ArticleEngagement_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ArticleEngagement"
    ADD CONSTRAINT "ArticleEngagement_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ArticleMetric ArticleMetric_articleId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ArticleMetric"
    ADD CONSTRAINT "ArticleMetric_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES public."Article"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ArticleReaction ArticleReaction_articleId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ArticleReaction"
    ADD CONSTRAINT "ArticleReaction_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES public."Article"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ArticleReaction ArticleReaction_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ArticleReaction"
    ADD CONSTRAINT "ArticleReaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ArticleReport ArticleReport_articleId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ArticleReport"
    ADD CONSTRAINT "ArticleReport_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES public."Article"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ArticleReport ArticleReport_reportId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ArticleReport"
    ADD CONSTRAINT "ArticleReport_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES public."Report"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: Article Article_coverId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Article"
    ADD CONSTRAINT "Article_coverId_fkey" FOREIGN KEY ("coverId") REFERENCES public."Image"(id) ON UPDATE CASCADE;


--
-- Name: Article Article_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Article"
    ADD CONSTRAINT "Article_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: BountyBenefactor BountyBenefactor_awardedToId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."BountyBenefactor"
    ADD CONSTRAINT "BountyBenefactor_awardedToId_fkey" FOREIGN KEY ("awardedToId") REFERENCES public."BountyEntry"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: BountyBenefactor BountyBenefactor_bountyId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."BountyBenefactor"
    ADD CONSTRAINT "BountyBenefactor_bountyId_fkey" FOREIGN KEY ("bountyId") REFERENCES public."Bounty"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: BountyBenefactor BountyBenefactor_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."BountyBenefactor"
    ADD CONSTRAINT "BountyBenefactor_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: BountyEngagement BountyEngagement_bountyId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."BountyEngagement"
    ADD CONSTRAINT "BountyEngagement_bountyId_fkey" FOREIGN KEY ("bountyId") REFERENCES public."Bounty"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: BountyEngagement BountyEngagement_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."BountyEngagement"
    ADD CONSTRAINT "BountyEngagement_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: BountyEntryMetric BountyEntryMetric_bountyEntryId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."BountyEntryMetric"
    ADD CONSTRAINT "BountyEntryMetric_bountyEntryId_fkey" FOREIGN KEY ("bountyEntryId") REFERENCES public."BountyEntry"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: BountyEntryReaction BountyEntryReaction_bountyEntryId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."BountyEntryReaction"
    ADD CONSTRAINT "BountyEntryReaction_bountyEntryId_fkey" FOREIGN KEY ("bountyEntryId") REFERENCES public."BountyEntry"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: BountyEntryReaction BountyEntryReaction_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."BountyEntryReaction"
    ADD CONSTRAINT "BountyEntryReaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: BountyEntryReport BountyEntryReport_bountyEntryId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."BountyEntryReport"
    ADD CONSTRAINT "BountyEntryReport_bountyEntryId_fkey" FOREIGN KEY ("bountyEntryId") REFERENCES public."BountyEntry"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: BountyEntryReport BountyEntryReport_reportId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."BountyEntryReport"
    ADD CONSTRAINT "BountyEntryReport_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES public."Report"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: BountyEntry BountyEntry_bountyId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."BountyEntry"
    ADD CONSTRAINT "BountyEntry_bountyId_fkey" FOREIGN KEY ("bountyId") REFERENCES public."Bounty"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: BountyEntry BountyEntry_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."BountyEntry"
    ADD CONSTRAINT "BountyEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: BountyMetric BountyMetric_bountyId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."BountyMetric"
    ADD CONSTRAINT "BountyMetric_bountyId_fkey" FOREIGN KEY ("bountyId") REFERENCES public."Bounty"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: BountyReport BountyReport_bountyId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."BountyReport"
    ADD CONSTRAINT "BountyReport_bountyId_fkey" FOREIGN KEY ("bountyId") REFERENCES public."Bounty"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: BountyReport BountyReport_reportId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."BountyReport"
    ADD CONSTRAINT "BountyReport_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES public."Report"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: Bounty Bounty_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Bounty"
    ADD CONSTRAINT "Bounty_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: BuildGuide BuildGuide_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: doadmin
--

ALTER TABLE ONLY public."BuildGuide"
    ADD CONSTRAINT "BuildGuide_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: BuzzWithdrawalRequestHistory BuzzWithdrawalRequestHistory_requestId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."BuzzWithdrawalRequestHistory"
    ADD CONSTRAINT "BuzzWithdrawalRequestHistory_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES public."BuzzWithdrawalRequest"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: BuzzWithdrawalRequestHistory BuzzWithdrawalRequestHistory_updatedById_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."BuzzWithdrawalRequestHistory"
    ADD CONSTRAINT "BuzzWithdrawalRequestHistory_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: BuzzWithdrawalRequest BuzzWithdrawalRequest_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."BuzzWithdrawalRequest"
    ADD CONSTRAINT "BuzzWithdrawalRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: ChatMember ChatMember_chatId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ChatMember"
    ADD CONSTRAINT "ChatMember_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES public."Chat"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: ChatMember ChatMember_lastViewedMessageId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ChatMember"
    ADD CONSTRAINT "ChatMember_lastViewedMessageId_fkey" FOREIGN KEY ("lastViewedMessageId") REFERENCES public."ChatMessage"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: ChatMember ChatMember_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ChatMember"
    ADD CONSTRAINT "ChatMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: ChatMessage ChatMessage_chatId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ChatMessage"
    ADD CONSTRAINT "ChatMessage_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES public."Chat"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: ChatMessage ChatMessage_referenceMessageId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ChatMessage"
    ADD CONSTRAINT "ChatMessage_referenceMessageId_fkey" FOREIGN KEY ("referenceMessageId") REFERENCES public."ChatMessage"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: ChatMessage ChatMessage_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ChatMessage"
    ADD CONSTRAINT "ChatMessage_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: ChatReport ChatReport_chatId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ChatReport"
    ADD CONSTRAINT "ChatReport_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES public."Chat"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ChatReport ChatReport_reportId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ChatReport"
    ADD CONSTRAINT "ChatReport_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES public."Report"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: Chat Chat_ownerId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Chat"
    ADD CONSTRAINT "Chat_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: ClubAdminInvite ClubAdminInvite_clubId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ClubAdminInvite"
    ADD CONSTRAINT "ClubAdminInvite_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES public."Club"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ClubAdmin ClubAdmin_clubId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ClubAdmin"
    ADD CONSTRAINT "ClubAdmin_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES public."Club"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ClubAdmin ClubAdmin_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ClubAdmin"
    ADD CONSTRAINT "ClubAdmin_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ClubMembership ClubMembership_clubId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ClubMembership"
    ADD CONSTRAINT "ClubMembership_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES public."Club"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ClubMembership ClubMembership_clubTierId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ClubMembership"
    ADD CONSTRAINT "ClubMembership_clubTierId_fkey" FOREIGN KEY ("clubTierId") REFERENCES public."ClubTier"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ClubMembership ClubMembership_downgradeClubTierId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ClubMembership"
    ADD CONSTRAINT "ClubMembership_downgradeClubTierId_fkey" FOREIGN KEY ("downgradeClubTierId") REFERENCES public."ClubTier"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ClubMembership ClubMembership_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ClubMembership"
    ADD CONSTRAINT "ClubMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ClubMetric ClubMetric_clubId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ClubMetric"
    ADD CONSTRAINT "ClubMetric_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES public."Club"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ClubPostMetric ClubPostMetric_clubPostId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ClubPostMetric"
    ADD CONSTRAINT "ClubPostMetric_clubPostId_fkey" FOREIGN KEY ("clubPostId") REFERENCES public."ClubPost"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ClubPostReaction ClubPostReaction_clubPostId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ClubPostReaction"
    ADD CONSTRAINT "ClubPostReaction_clubPostId_fkey" FOREIGN KEY ("clubPostId") REFERENCES public."ClubPost"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ClubPostReaction ClubPostReaction_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ClubPostReaction"
    ADD CONSTRAINT "ClubPostReaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ClubPost ClubPost_clubId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ClubPost"
    ADD CONSTRAINT "ClubPost_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES public."Club"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: ClubPost ClubPost_coverImageId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ClubPost"
    ADD CONSTRAINT "ClubPost_coverImageId_fkey" FOREIGN KEY ("coverImageId") REFERENCES public."Image"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: ClubPost ClubPost_createdById_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ClubPost"
    ADD CONSTRAINT "ClubPost_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: ClubTier ClubTier_clubId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ClubTier"
    ADD CONSTRAINT "ClubTier_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES public."Club"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ClubTier ClubTier_coverImageId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ClubTier"
    ADD CONSTRAINT "ClubTier_coverImageId_fkey" FOREIGN KEY ("coverImageId") REFERENCES public."Image"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: Club Club_avatarId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Club"
    ADD CONSTRAINT "Club_avatarId_fkey" FOREIGN KEY ("avatarId") REFERENCES public."Image"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: Club Club_coverImageId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Club"
    ADD CONSTRAINT "Club_coverImageId_fkey" FOREIGN KEY ("coverImageId") REFERENCES public."Image"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: Club Club_headerImageId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Club"
    ADD CONSTRAINT "Club_headerImageId_fkey" FOREIGN KEY ("headerImageId") REFERENCES public."Image"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: Club Club_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Club"
    ADD CONSTRAINT "Club_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: CollectionContributor CollectionContributor_collectionId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."CollectionContributor"
    ADD CONSTRAINT "CollectionContributor_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES public."Collection"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: CollectionContributor CollectionContributor_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."CollectionContributor"
    ADD CONSTRAINT "CollectionContributor_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: CollectionItem CollectionItem_addedById_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."CollectionItem"
    ADD CONSTRAINT "CollectionItem_addedById_fkey" FOREIGN KEY ("addedById") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: CollectionItem CollectionItem_collectionId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."CollectionItem"
    ADD CONSTRAINT "CollectionItem_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES public."Collection"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: CollectionItem CollectionItem_reviewedById_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."CollectionItem"
    ADD CONSTRAINT "CollectionItem_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: CollectionItem CollectionItem_tagId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."CollectionItem"
    ADD CONSTRAINT "CollectionItem_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES public."Tag"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: CollectionMetric CollectionMetric_collectionId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."CollectionMetric"
    ADD CONSTRAINT "CollectionMetric_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES public."Collection"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: CollectionReport CollectionReport_collectionId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."CollectionReport"
    ADD CONSTRAINT "CollectionReport_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES public."Collection"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: CollectionReport CollectionReport_reportId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."CollectionReport"
    ADD CONSTRAINT "CollectionReport_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES public."Report"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: Collection Collection_imageId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Collection"
    ADD CONSTRAINT "Collection_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES public."Image"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: Collection Collection_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Collection"
    ADD CONSTRAINT "Collection_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: CommentReaction CommentReaction_commentId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."CommentReaction"
    ADD CONSTRAINT "CommentReaction_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES public."Comment"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: CommentReaction CommentReaction_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."CommentReaction"
    ADD CONSTRAINT "CommentReaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: CommentReport CommentReport_commentId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."CommentReport"
    ADD CONSTRAINT "CommentReport_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES public."Comment"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: CommentReport CommentReport_reportId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."CommentReport"
    ADD CONSTRAINT "CommentReport_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES public."Report"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: CommentV2Reaction CommentV2Reaction_commentId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."CommentV2Reaction"
    ADD CONSTRAINT "CommentV2Reaction_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES public."CommentV2"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: CommentV2Reaction CommentV2Reaction_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."CommentV2Reaction"
    ADD CONSTRAINT "CommentV2Reaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: CommentV2Report CommentV2Report_commentV2Id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."CommentV2Report"
    ADD CONSTRAINT "CommentV2Report_commentV2Id_fkey" FOREIGN KEY ("commentV2Id") REFERENCES public."CommentV2"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: CommentV2Report CommentV2Report_reportId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."CommentV2Report"
    ADD CONSTRAINT "CommentV2Report_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES public."Report"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: CommentV2 CommentV2_threadId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."CommentV2"
    ADD CONSTRAINT "CommentV2_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES public."Thread"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: CommentV2 CommentV2_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."CommentV2"
    ADD CONSTRAINT "CommentV2_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: Comment Comment_modelId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Comment"
    ADD CONSTRAINT "Comment_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES public."Model"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: Comment Comment_parentId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Comment"
    ADD CONSTRAINT "Comment_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES public."Comment"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: Comment Comment_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Comment"
    ADD CONSTRAINT "Comment_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: CosmeticShopItem CosmeticShopItem_addedById_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."CosmeticShopItem"
    ADD CONSTRAINT "CosmeticShopItem_addedById_fkey" FOREIGN KEY ("addedById") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: CosmeticShopItem CosmeticShopItem_cosmeticId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."CosmeticShopItem"
    ADD CONSTRAINT "CosmeticShopItem_cosmeticId_fkey" FOREIGN KEY ("cosmeticId") REFERENCES public."Cosmetic"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: CosmeticShopSectionItem CosmeticShopSectionItem_shopItemId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."CosmeticShopSectionItem"
    ADD CONSTRAINT "CosmeticShopSectionItem_shopItemId_fkey" FOREIGN KEY ("shopItemId") REFERENCES public."CosmeticShopItem"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: CosmeticShopSectionItem CosmeticShopSectionItem_shopSectionId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."CosmeticShopSectionItem"
    ADD CONSTRAINT "CosmeticShopSectionItem_shopSectionId_fkey" FOREIGN KEY ("shopSectionId") REFERENCES public."CosmeticShopSection"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: CosmeticShopSection CosmeticShopSection_addedById_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."CosmeticShopSection"
    ADD CONSTRAINT "CosmeticShopSection_addedById_fkey" FOREIGN KEY ("addedById") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: CosmeticShopSection CosmeticShopSection_imageId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."CosmeticShopSection"
    ADD CONSTRAINT "CosmeticShopSection_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES public."Image"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: CustomerSubscription CustomerSubscription_priceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."CustomerSubscription"
    ADD CONSTRAINT "CustomerSubscription_priceId_fkey" FOREIGN KEY ("priceId") REFERENCES public."Price"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: CustomerSubscription CustomerSubscription_productId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."CustomerSubscription"
    ADD CONSTRAINT "CustomerSubscription_productId_fkey" FOREIGN KEY ("productId") REFERENCES public."Product"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: CustomerSubscription CustomerSubscription_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."CustomerSubscription"
    ADD CONSTRAINT "CustomerSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: DonationGoal DonationGoal_modelVersionId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: doadmin
--

ALTER TABLE ONLY public."DonationGoal"
    ADD CONSTRAINT "DonationGoal_modelVersionId_fkey" FOREIGN KEY ("modelVersionId") REFERENCES public."ModelVersion"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: DonationGoal DonationGoal_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: doadmin
--

ALTER TABLE ONLY public."DonationGoal"
    ADD CONSTRAINT "DonationGoal_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: Donation Donation_donationGoalId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: doadmin
--

ALTER TABLE ONLY public."Donation"
    ADD CONSTRAINT "Donation_donationGoalId_fkey" FOREIGN KEY ("donationGoalId") REFERENCES public."DonationGoal"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: Donation Donation_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: doadmin
--

ALTER TABLE ONLY public."Donation"
    ADD CONSTRAINT "Donation_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: DownloadHistory DownloadHistory_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."DownloadHistory"
    ADD CONSTRAINT "DownloadHistory_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: EntityAccess EntityAccess_addedById_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."EntityAccess"
    ADD CONSTRAINT "EntityAccess_addedById_fkey" FOREIGN KEY ("addedById") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: EntityCollaborator EntityCollaborator_createdBy_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."EntityCollaborator"
    ADD CONSTRAINT "EntityCollaborator_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: EntityCollaborator EntityCollaborator_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."EntityCollaborator"
    ADD CONSTRAINT "EntityCollaborator_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: HomeBlock HomeBlock_sourceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."HomeBlock"
    ADD CONSTRAINT "HomeBlock_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES public."HomeBlock"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: HomeBlock HomeBlock_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."HomeBlock"
    ADD CONSTRAINT "HomeBlock_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ImageEngagement ImageEngagement_imageId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ImageEngagement"
    ADD CONSTRAINT "ImageEngagement_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES public."Image"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ImageEngagement ImageEngagement_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ImageEngagement"
    ADD CONSTRAINT "ImageEngagement_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ImageFlag ImageFlag_imageId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: doadmin
--

ALTER TABLE ONLY public."ImageFlag"
    ADD CONSTRAINT "ImageFlag_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES public."Image"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ImageMetric ImageMetric_imageId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ImageMetric"
    ADD CONSTRAINT "ImageMetric_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES public."Image"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ImageReaction ImageReaction_imageId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ImageReaction"
    ADD CONSTRAINT "ImageReaction_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES public."Image"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ImageReaction ImageReaction_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ImageReaction"
    ADD CONSTRAINT "ImageReaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ImageReport ImageReport_imageId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ImageReport"
    ADD CONSTRAINT "ImageReport_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES public."Image"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ImageReport ImageReport_reportId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ImageReport"
    ADD CONSTRAINT "ImageReport_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES public."Report"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ImageResource ImageResource_imageId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ImageResource"
    ADD CONSTRAINT "ImageResource_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES public."Image"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ImageResource ImageResource_modelVersionId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ImageResource"
    ADD CONSTRAINT "ImageResource_modelVersionId_fkey" FOREIGN KEY ("modelVersionId") REFERENCES public."ModelVersion"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ImageTechnique ImageTechnique_imageId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: doadmin
--

ALTER TABLE ONLY public."ImageTechnique"
    ADD CONSTRAINT "ImageTechnique_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES public."Image"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ImageTechnique ImageTechnique_techniqueId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: doadmin
--

ALTER TABLE ONLY public."ImageTechnique"
    ADD CONSTRAINT "ImageTechnique_techniqueId_fkey" FOREIGN KEY ("techniqueId") REFERENCES public."Technique"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ImageTool ImageTool_imageId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ImageTool"
    ADD CONSTRAINT "ImageTool_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES public."Image"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ImageTool ImageTool_toolId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ImageTool"
    ADD CONSTRAINT "ImageTool_toolId_fkey" FOREIGN KEY ("toolId") REFERENCES public."Tool"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: Image Image_postId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Image"
    ADD CONSTRAINT "Image_postId_fkey" FOREIGN KEY ("postId") REFERENCES public."Post"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: Image Image_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Image"
    ADD CONSTRAINT "Image_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ImagesOnModels ImagesOnModels_imageId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ImagesOnModels"
    ADD CONSTRAINT "ImagesOnModels_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES public."Image"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ImagesOnModels ImagesOnModels_modelVersionId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ImagesOnModels"
    ADD CONSTRAINT "ImagesOnModels_modelVersionId_fkey" FOREIGN KEY ("modelVersionId") REFERENCES public."ModelVersion"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: Import Import_parentId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Import"
    ADD CONSTRAINT "Import_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES public."Import"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: Import Import_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Import"
    ADD CONSTRAINT "Import_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: LeaderboardResult LeaderboardResult_leaderboardId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."LeaderboardResult"
    ADD CONSTRAINT "LeaderboardResult_leaderboardId_fkey" FOREIGN KEY ("leaderboardId") REFERENCES public."Leaderboard"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: LeaderboardResult LeaderboardResult_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."LeaderboardResult"
    ADD CONSTRAINT "LeaderboardResult_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ModelAssociations ModelAssociations_fromModelId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ModelAssociations"
    ADD CONSTRAINT "ModelAssociations_fromModelId_fkey" FOREIGN KEY ("fromModelId") REFERENCES public."Model"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ModelAssociations ModelAssociations_toArticleId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ModelAssociations"
    ADD CONSTRAINT "ModelAssociations_toArticleId_fkey" FOREIGN KEY ("toArticleId") REFERENCES public."Article"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ModelAssociations ModelAssociations_toModelId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ModelAssociations"
    ADD CONSTRAINT "ModelAssociations_toModelId_fkey" FOREIGN KEY ("toModelId") REFERENCES public."Model"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ModelEngagement ModelEngagement_modelId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ModelEngagement"
    ADD CONSTRAINT "ModelEngagement_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES public."Model"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ModelEngagement ModelEngagement_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ModelEngagement"
    ADD CONSTRAINT "ModelEngagement_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ModelFileHash ModelFileHash_fileId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ModelFileHash"
    ADD CONSTRAINT "ModelFileHash_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES public."ModelFile"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ModelFile ModelFile_modelVersionId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ModelFile"
    ADD CONSTRAINT "ModelFile_modelVersionId_fkey" FOREIGN KEY ("modelVersionId") REFERENCES public."ModelVersion"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ModelFlag ModelFlag_modelId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: doadmin
--

ALTER TABLE ONLY public."ModelFlag"
    ADD CONSTRAINT "ModelFlag_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES public."Model"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ModelInterest ModelInterest_modelId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ModelInterest"
    ADD CONSTRAINT "ModelInterest_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES public."Model"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ModelInterest ModelInterest_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ModelInterest"
    ADD CONSTRAINT "ModelInterest_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ModelMetricDaily ModelMetricDaily_modelId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ModelMetricDaily"
    ADD CONSTRAINT "ModelMetricDaily_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES public."Model"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ModelMetricDaily ModelMetricDaily_modelVersionId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ModelMetricDaily"
    ADD CONSTRAINT "ModelMetricDaily_modelVersionId_fkey" FOREIGN KEY ("modelVersionId") REFERENCES public."ModelVersion"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ModelMetric ModelMetric_modelId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ModelMetric"
    ADD CONSTRAINT "ModelMetric_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES public."Model"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ModelReport ModelReport_modelId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ModelReport"
    ADD CONSTRAINT "ModelReport_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES public."Model"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ModelReport ModelReport_reportId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ModelReport"
    ADD CONSTRAINT "ModelReport_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES public."Report"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ModelVersionEngagement ModelVersionEngagement_modelVersionId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ModelVersionEngagement"
    ADD CONSTRAINT "ModelVersionEngagement_modelVersionId_fkey" FOREIGN KEY ("modelVersionId") REFERENCES public."ModelVersion"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ModelVersionEngagement ModelVersionEngagement_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ModelVersionEngagement"
    ADD CONSTRAINT "ModelVersionEngagement_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ModelVersionExploration ModelVersionExploration_modelVersionId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ModelVersionExploration"
    ADD CONSTRAINT "ModelVersionExploration_modelVersionId_fkey" FOREIGN KEY ("modelVersionId") REFERENCES public."ModelVersion"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ModelVersionMetric ModelVersionMetric_modelVersionId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ModelVersionMetric"
    ADD CONSTRAINT "ModelVersionMetric_modelVersionId_fkey" FOREIGN KEY ("modelVersionId") REFERENCES public."ModelVersion"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ModelVersionMonetization ModelVersionMonetization_modelVersionId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ModelVersionMonetization"
    ADD CONSTRAINT "ModelVersionMonetization_modelVersionId_fkey" FOREIGN KEY ("modelVersionId") REFERENCES public."ModelVersion"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ModelVersionSponsorshipSettings ModelVersionSponsorshipSettings_modelVersionMonetizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ModelVersionSponsorshipSettings"
    ADD CONSTRAINT "ModelVersionSponsorshipSettings_modelVersionMonetizationId_fkey" FOREIGN KEY ("modelVersionMonetizationId") REFERENCES public."ModelVersionMonetization"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ModelVersion ModelVersion_fromImportId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ModelVersion"
    ADD CONSTRAINT "ModelVersion_fromImportId_fkey" FOREIGN KEY ("fromImportId") REFERENCES public."Import"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: ModelVersion ModelVersion_modelId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ModelVersion"
    ADD CONSTRAINT "ModelVersion_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES public."Model"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ModelVersion ModelVersion_vaeId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ModelVersion"
    ADD CONSTRAINT "ModelVersion_vaeId_fkey" FOREIGN KEY ("vaeId") REFERENCES public."ModelVersion"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: Model Model_deletedBy_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Model"
    ADD CONSTRAINT "Model_deletedBy_fkey" FOREIGN KEY ("deletedBy") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: Model Model_fromImportId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Model"
    ADD CONSTRAINT "Model_fromImportId_fkey" FOREIGN KEY ("fromImportId") REFERENCES public."Import"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: Model Model_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Model"
    ADD CONSTRAINT "Model_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: OauthClient OauthClient_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: doadmin
--

ALTER TABLE ONLY public."OauthClient"
    ADD CONSTRAINT "OauthClient_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: OauthToken OauthToken_clientId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: doadmin
--

ALTER TABLE ONLY public."OauthToken"
    ADD CONSTRAINT "OauthToken_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES public."OauthClient"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: OauthToken OauthToken_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: doadmin
--

ALTER TABLE ONLY public."OauthToken"
    ADD CONSTRAINT "OauthToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: PostMetric PostMetric_postId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."PostMetric"
    ADD CONSTRAINT "PostMetric_postId_fkey" FOREIGN KEY ("postId") REFERENCES public."Post"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: PostReaction PostReaction_postId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."PostReaction"
    ADD CONSTRAINT "PostReaction_postId_fkey" FOREIGN KEY ("postId") REFERENCES public."Post"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: PostReaction PostReaction_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."PostReaction"
    ADD CONSTRAINT "PostReaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: PostReport PostReport_postId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."PostReport"
    ADD CONSTRAINT "PostReport_postId_fkey" FOREIGN KEY ("postId") REFERENCES public."Post"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: PostReport PostReport_reportId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."PostReport"
    ADD CONSTRAINT "PostReport_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES public."Report"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: Post Post_collectionId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Post"
    ADD CONSTRAINT "Post_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES public."Collection"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: Post Post_modelVersionId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Post"
    ADD CONSTRAINT "Post_modelVersionId_fkey" FOREIGN KEY ("modelVersionId") REFERENCES public."ModelVersion"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: Post Post_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Post"
    ADD CONSTRAINT "Post_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: Price Price_productId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Price"
    ADD CONSTRAINT "Price_productId_fkey" FOREIGN KEY ("productId") REFERENCES public."Product"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: PurchasableReward PurchasableReward_addedById_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."PurchasableReward"
    ADD CONSTRAINT "PurchasableReward_addedById_fkey" FOREIGN KEY ("addedById") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: PurchasableReward PurchasableReward_coverImageId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."PurchasableReward"
    ADD CONSTRAINT "PurchasableReward_coverImageId_fkey" FOREIGN KEY ("coverImageId") REFERENCES public."Image"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: Purchase Purchase_priceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Purchase"
    ADD CONSTRAINT "Purchase_priceId_fkey" FOREIGN KEY ("priceId") REFERENCES public."Price"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: Purchase Purchase_productId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Purchase"
    ADD CONSTRAINT "Purchase_productId_fkey" FOREIGN KEY ("productId") REFERENCES public."Product"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: Purchase Purchase_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Purchase"
    ADD CONSTRAINT "Purchase_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: QueryDurationLog QueryDurationLog_paramsId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: doadmin
--

ALTER TABLE ONLY public."QueryDurationLog"
    ADD CONSTRAINT "QueryDurationLog_paramsId_fkey" FOREIGN KEY ("paramsId") REFERENCES public."QueryParamsLog"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: QueryDurationLog QueryDurationLog_sqlId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: doadmin
--

ALTER TABLE ONLY public."QueryDurationLog"
    ADD CONSTRAINT "QueryDurationLog_sqlId_fkey" FOREIGN KEY ("sqlId") REFERENCES public."QuerySqlLog"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: QueryParamsLog QueryParamsLog_sqlId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: doadmin
--

ALTER TABLE ONLY public."QueryParamsLog"
    ADD CONSTRAINT "QueryParamsLog_sqlId_fkey" FOREIGN KEY ("sqlId") REFERENCES public."QuerySqlLog"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: QuestionMetric QuestionMetric_questionId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."QuestionMetric"
    ADD CONSTRAINT "QuestionMetric_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES public."Question"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: QuestionReaction QuestionReaction_questionId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."QuestionReaction"
    ADD CONSTRAINT "QuestionReaction_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES public."Question"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: QuestionReaction QuestionReaction_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."QuestionReaction"
    ADD CONSTRAINT "QuestionReaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: Question Question_selectedAnswerId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Question"
    ADD CONSTRAINT "Question_selectedAnswerId_fkey" FOREIGN KEY ("selectedAnswerId") REFERENCES public."Answer"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: Question Question_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Question"
    ADD CONSTRAINT "Question_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: RecommendedResource RecommendedResource_resourceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."RecommendedResource"
    ADD CONSTRAINT "RecommendedResource_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES public."ModelVersion"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: RecommendedResource RecommendedResource_sourceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."RecommendedResource"
    ADD CONSTRAINT "RecommendedResource_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES public."ModelVersion"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: RedeemableCode RedeemableCode_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: doadmin
--

ALTER TABLE ONLY public."RedeemableCode"
    ADD CONSTRAINT "RedeemableCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: Report Report_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Report"
    ADD CONSTRAINT "Report_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ResourceReviewReaction ResourceReviewReaction_reviewId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ResourceReviewReaction"
    ADD CONSTRAINT "ResourceReviewReaction_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES public."ResourceReview"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ResourceReviewReaction ResourceReviewReaction_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ResourceReviewReaction"
    ADD CONSTRAINT "ResourceReviewReaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ResourceReviewReport ResourceReviewReport_reportId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ResourceReviewReport"
    ADD CONSTRAINT "ResourceReviewReport_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES public."Report"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ResourceReviewReport ResourceReviewReport_resourceReviewId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ResourceReviewReport"
    ADD CONSTRAINT "ResourceReviewReport_resourceReviewId_fkey" FOREIGN KEY ("resourceReviewId") REFERENCES public."ResourceReview"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ResourceReview ResourceReview_modelId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ResourceReview"
    ADD CONSTRAINT "ResourceReview_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES public."Model"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ResourceReview ResourceReview_modelVersionId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ResourceReview"
    ADD CONSTRAINT "ResourceReview_modelVersionId_fkey" FOREIGN KEY ("modelVersionId") REFERENCES public."ModelVersion"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ResourceReview ResourceReview_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."ResourceReview"
    ADD CONSTRAINT "ResourceReview_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: RunStrategy RunStrategy_modelVersionId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."RunStrategy"
    ADD CONSTRAINT "RunStrategy_modelVersionId_fkey" FOREIGN KEY ("modelVersionId") REFERENCES public."ModelVersion"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: RunStrategy RunStrategy_partnerId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."RunStrategy"
    ADD CONSTRAINT "RunStrategy_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES public."Partner"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: SavedModel SavedModel_modelId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."SavedModel"
    ADD CONSTRAINT "SavedModel_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES public."Model"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: SavedModel SavedModel_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."SavedModel"
    ADD CONSTRAINT "SavedModel_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: SessionInvalidation SessionInvalidation_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."SessionInvalidation"
    ADD CONSTRAINT "SessionInvalidation_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: Session Session_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Session"
    ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: TagEngagement TagEngagement_tagId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."TagEngagement"
    ADD CONSTRAINT "TagEngagement_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES public."Tag"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: TagEngagement TagEngagement_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."TagEngagement"
    ADD CONSTRAINT "TagEngagement_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: TagMetric TagMetric_tagId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."TagMetric"
    ADD CONSTRAINT "TagMetric_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES public."Tag"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: TagsOnArticle TagsOnArticle_articleId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."TagsOnArticle"
    ADD CONSTRAINT "TagsOnArticle_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES public."Article"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: TagsOnArticle TagsOnArticle_tagId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."TagsOnArticle"
    ADD CONSTRAINT "TagsOnArticle_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES public."Tag"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: TagsOnBounty TagsOnBounty_bountyId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."TagsOnBounty"
    ADD CONSTRAINT "TagsOnBounty_bountyId_fkey" FOREIGN KEY ("bountyId") REFERENCES public."Bounty"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: TagsOnBounty TagsOnBounty_tagId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."TagsOnBounty"
    ADD CONSTRAINT "TagsOnBounty_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES public."Tag"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: TagsOnCollection TagsOnCollection_collectionId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."TagsOnCollection"
    ADD CONSTRAINT "TagsOnCollection_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES public."Collection"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: TagsOnCollection TagsOnCollection_tagId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."TagsOnCollection"
    ADD CONSTRAINT "TagsOnCollection_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES public."Tag"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: TagsOnImageVote TagsOnImageVote_imageId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."TagsOnImageVote"
    ADD CONSTRAINT "TagsOnImageVote_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES public."Image"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: TagsOnImageVote TagsOnImageVote_tagId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."TagsOnImageVote"
    ADD CONSTRAINT "TagsOnImageVote_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES public."Tag"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: TagsOnImageVote TagsOnImageVote_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."TagsOnImageVote"
    ADD CONSTRAINT "TagsOnImageVote_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: TagsOnImage TagsOnImage_imageId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."TagsOnImage"
    ADD CONSTRAINT "TagsOnImage_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES public."Image"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: TagsOnImage TagsOnImage_tagId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."TagsOnImage"
    ADD CONSTRAINT "TagsOnImage_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES public."Tag"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: TagsOnModelsVote TagsOnModelsVote_modelId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."TagsOnModelsVote"
    ADD CONSTRAINT "TagsOnModelsVote_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES public."Model"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: TagsOnModelsVote TagsOnModelsVote_tagId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."TagsOnModelsVote"
    ADD CONSTRAINT "TagsOnModelsVote_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES public."Tag"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: TagsOnModelsVote TagsOnModelsVote_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."TagsOnModelsVote"
    ADD CONSTRAINT "TagsOnModelsVote_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: TagsOnModels TagsOnModels_modelId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."TagsOnModels"
    ADD CONSTRAINT "TagsOnModels_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES public."Model"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: TagsOnModels TagsOnModels_tagId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."TagsOnModels"
    ADD CONSTRAINT "TagsOnModels_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES public."Tag"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: TagsOnPostVote TagsOnPostVote_postId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."TagsOnPostVote"
    ADD CONSTRAINT "TagsOnPostVote_postId_fkey" FOREIGN KEY ("postId") REFERENCES public."Post"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: TagsOnPostVote TagsOnPostVote_tagId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."TagsOnPostVote"
    ADD CONSTRAINT "TagsOnPostVote_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES public."Tag"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: TagsOnPostVote TagsOnPostVote_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."TagsOnPostVote"
    ADD CONSTRAINT "TagsOnPostVote_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: TagsOnPost TagsOnPost_postId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."TagsOnPost"
    ADD CONSTRAINT "TagsOnPost_postId_fkey" FOREIGN KEY ("postId") REFERENCES public."Post"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: TagsOnPost TagsOnPost_tagId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."TagsOnPost"
    ADD CONSTRAINT "TagsOnPost_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES public."Tag"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: TagsOnQuestions TagsOnQuestions_questionId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."TagsOnQuestions"
    ADD CONSTRAINT "TagsOnQuestions_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES public."Question"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: TagsOnQuestions TagsOnQuestions_tagId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."TagsOnQuestions"
    ADD CONSTRAINT "TagsOnQuestions_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES public."Tag"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: TagsOnTags TagsOnTags_fromTagId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."TagsOnTags"
    ADD CONSTRAINT "TagsOnTags_fromTagId_fkey" FOREIGN KEY ("fromTagId") REFERENCES public."Tag"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: TagsOnTags TagsOnTags_toTagId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."TagsOnTags"
    ADD CONSTRAINT "TagsOnTags_toTagId_fkey" FOREIGN KEY ("toTagId") REFERENCES public."Tag"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: Thread Thread_answerId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Thread"
    ADD CONSTRAINT "Thread_answerId_fkey" FOREIGN KEY ("answerId") REFERENCES public."Answer"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: Thread Thread_articleId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Thread"
    ADD CONSTRAINT "Thread_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES public."Article"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: Thread Thread_bountyEntryId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Thread"
    ADD CONSTRAINT "Thread_bountyEntryId_fkey" FOREIGN KEY ("bountyEntryId") REFERENCES public."BountyEntry"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: Thread Thread_bountyId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Thread"
    ADD CONSTRAINT "Thread_bountyId_fkey" FOREIGN KEY ("bountyId") REFERENCES public."Bounty"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: Thread Thread_clubPostId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Thread"
    ADD CONSTRAINT "Thread_clubPostId_fkey" FOREIGN KEY ("clubPostId") REFERENCES public."ClubPost"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: Thread Thread_commentId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Thread"
    ADD CONSTRAINT "Thread_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES public."CommentV2"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: Thread Thread_imageId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Thread"
    ADD CONSTRAINT "Thread_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES public."Image"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: Thread Thread_modelId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Thread"
    ADD CONSTRAINT "Thread_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES public."Model"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: Thread Thread_parentThreadId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Thread"
    ADD CONSTRAINT "Thread_parentThreadId_fkey" FOREIGN KEY ("parentThreadId") REFERENCES public."Thread"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: Thread Thread_postId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Thread"
    ADD CONSTRAINT "Thread_postId_fkey" FOREIGN KEY ("postId") REFERENCES public."Post"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: Thread Thread_questionId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Thread"
    ADD CONSTRAINT "Thread_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES public."Question"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: Thread Thread_reviewId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Thread"
    ADD CONSTRAINT "Thread_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES public."ResourceReview"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: Thread Thread_rootThreadId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Thread"
    ADD CONSTRAINT "Thread_rootThreadId_fkey" FOREIGN KEY ("rootThreadId") REFERENCES public."Thread"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: UserCosmeticShopPurchases UserCosmeticShopPurchases_cosmeticId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."UserCosmeticShopPurchases"
    ADD CONSTRAINT "UserCosmeticShopPurchases_cosmeticId_fkey" FOREIGN KEY ("cosmeticId") REFERENCES public."Cosmetic"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: UserCosmeticShopPurchases UserCosmeticShopPurchases_shopItemId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."UserCosmeticShopPurchases"
    ADD CONSTRAINT "UserCosmeticShopPurchases_shopItemId_fkey" FOREIGN KEY ("shopItemId") REFERENCES public."CosmeticShopItem"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: UserCosmeticShopPurchases UserCosmeticShopPurchases_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."UserCosmeticShopPurchases"
    ADD CONSTRAINT "UserCosmeticShopPurchases_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: UserCosmetic UserCosmetic_cosmeticId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."UserCosmetic"
    ADD CONSTRAINT "UserCosmetic_cosmeticId_fkey" FOREIGN KEY ("cosmeticId") REFERENCES public."Cosmetic"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: UserCosmetic UserCosmetic_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."UserCosmetic"
    ADD CONSTRAINT "UserCosmetic_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: UserEngagement UserEngagement_targetUserId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."UserEngagement"
    ADD CONSTRAINT "UserEngagement_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: UserEngagement UserEngagement_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."UserEngagement"
    ADD CONSTRAINT "UserEngagement_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: UserLink UserLink_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."UserLink"
    ADD CONSTRAINT "UserLink_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: UserMetric UserMetric_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."UserMetric"
    ADD CONSTRAINT "UserMetric_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: UserNotificationSettings UserNotificationSettings_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."UserNotificationSettings"
    ADD CONSTRAINT "UserNotificationSettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: UserProfile UserProfile_coverImageId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."UserProfile"
    ADD CONSTRAINT "UserProfile_coverImageId_fkey" FOREIGN KEY ("coverImageId") REFERENCES public."Image"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: UserProfile UserProfile_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."UserProfile"
    ADD CONSTRAINT "UserProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: UserPurchasedRewards UserPurchasedRewards_purchasableRewardId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."UserPurchasedRewards"
    ADD CONSTRAINT "UserPurchasedRewards_purchasableRewardId_fkey" FOREIGN KEY ("purchasableRewardId") REFERENCES public."PurchasableReward"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: UserPurchasedRewards UserPurchasedRewards_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."UserPurchasedRewards"
    ADD CONSTRAINT "UserPurchasedRewards_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: UserReferralCode UserReferralCode_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."UserReferralCode"
    ADD CONSTRAINT "UserReferralCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: UserReferral UserReferral_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."UserReferral"
    ADD CONSTRAINT "UserReferral_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: UserReferral UserReferral_userReferralCodeId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."UserReferral"
    ADD CONSTRAINT "UserReferral_userReferralCodeId_fkey" FOREIGN KEY ("userReferralCodeId") REFERENCES public."UserReferralCode"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: UserReport UserReport_reportId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."UserReport"
    ADD CONSTRAINT "UserReport_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES public."Report"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: UserReport UserReport_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."UserReport"
    ADD CONSTRAINT "UserReport_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: UserStripeConnect UserStripeConnect_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."UserStripeConnect"
    ADD CONSTRAINT "UserStripeConnect_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: User User_profilePictureId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."User"
    ADD CONSTRAINT "User_profilePictureId_fkey" FOREIGN KEY ("profilePictureId") REFERENCES public."Image"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: VaultItem VaultItem_creatorId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."VaultItem"
    ADD CONSTRAINT "VaultItem_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: VaultItem VaultItem_vaultId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."VaultItem"
    ADD CONSTRAINT "VaultItem_vaultId_fkey" FOREIGN KEY ("vaultId") REFERENCES public."Vault"("userId") ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: Vault Vault_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Vault"
    ADD CONSTRAINT "Vault_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: Webhook Webhook_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."Webhook"
    ADD CONSTRAINT "Webhook_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: _LicenseToModel _LicenseToModel_A_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."_LicenseToModel"
    ADD CONSTRAINT "_LicenseToModel_A_fkey" FOREIGN KEY ("A") REFERENCES public."License"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: _LicenseToModel _LicenseToModel_B_fkey; Type: FK CONSTRAINT; Schema: public; Owner: civitai
--

ALTER TABLE ONLY public."_LicenseToModel"
    ADD CONSTRAINT "_LicenseToModel_B_fkey" FOREIGN KEY ("B") REFERENCES public."Model"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: civitai_pg_ch_publication; Type: PUBLICATION; Schema: -; Owner: doadmin
--

CREATE PUBLICATION civitai_pg_ch_publication WITH (publish = 'insert, update, delete, truncate');


ALTER PUBLICATION civitai_pg_ch_publication OWNER TO doadmin;

--
-- Name: civitai_pg_ch_publication Account; Type: PUBLICATION TABLE; Schema: public; Owner: doadmin
--

ALTER PUBLICATION civitai_pg_ch_publication ADD TABLE ONLY public."Account";


--
-- Name: civitai_pg_ch_publication Announcement; Type: PUBLICATION TABLE; Schema: public; Owner: doadmin
--

ALTER PUBLICATION civitai_pg_ch_publication ADD TABLE ONLY public."Announcement";


--
-- Name: civitai_pg_ch_publication Answer; Type: PUBLICATION TABLE; Schema: public; Owner: doadmin
--

ALTER PUBLICATION civitai_pg_ch_publication ADD TABLE ONLY public."Answer";


--
-- Name: civitai_pg_ch_publication AnswerMetric; Type: PUBLICATION TABLE; Schema: public; Owner: doadmin
--

ALTER PUBLICATION civitai_pg_ch_publication ADD TABLE ONLY public."AnswerMetric";


--
-- Name: civitai_pg_ch_publication AnswerReaction; Type: PUBLICATION TABLE; Schema: public; Owner: doadmin
--

ALTER PUBLICATION civitai_pg_ch_publication ADD TABLE ONLY public."AnswerReaction";


--
-- Name: civitai_pg_ch_publication AnswerVote; Type: PUBLICATION TABLE; Schema: public; Owner: doadmin
--

ALTER PUBLICATION civitai_pg_ch_publication ADD TABLE ONLY public."AnswerVote";


--
-- Name: civitai_pg_ch_publication ApiKey; Type: PUBLICATION TABLE; Schema: public; Owner: doadmin
--

ALTER PUBLICATION civitai_pg_ch_publication ADD TABLE ONLY public."ApiKey";


--
-- Name: civitai_pg_ch_publication Comment; Type: PUBLICATION TABLE; Schema: public; Owner: doadmin
--

ALTER PUBLICATION civitai_pg_ch_publication ADD TABLE ONLY public."Comment";


--
-- Name: civitai_pg_ch_publication CommentReaction; Type: PUBLICATION TABLE; Schema: public; Owner: doadmin
--

ALTER PUBLICATION civitai_pg_ch_publication ADD TABLE ONLY public."CommentReaction";


--
-- Name: civitai_pg_ch_publication CommentReport; Type: PUBLICATION TABLE; Schema: public; Owner: doadmin
--

ALTER PUBLICATION civitai_pg_ch_publication ADD TABLE ONLY public."CommentReport";


--
-- Name: civitai_pg_ch_publication CommentV2; Type: PUBLICATION TABLE; Schema: public; Owner: doadmin
--

ALTER PUBLICATION civitai_pg_ch_publication ADD TABLE ONLY public."CommentV2";


--
-- Name: civitai_pg_ch_publication CommentV2Reaction; Type: PUBLICATION TABLE; Schema: public; Owner: doadmin
--

ALTER PUBLICATION civitai_pg_ch_publication ADD TABLE ONLY public."CommentV2Reaction";


--
-- Name: civitai_pg_ch_publication CommentV2Report; Type: PUBLICATION TABLE; Schema: public; Owner: doadmin
--

ALTER PUBLICATION civitai_pg_ch_publication ADD TABLE ONLY public."CommentV2Report";


--
-- Name: civitai_pg_ch_publication Cosmetic; Type: PUBLICATION TABLE; Schema: public; Owner: doadmin
--

ALTER PUBLICATION civitai_pg_ch_publication ADD TABLE ONLY public."Cosmetic";


--
-- Name: civitai_pg_ch_publication CustomerSubscription; Type: PUBLICATION TABLE; Schema: public; Owner: doadmin
--

ALTER PUBLICATION civitai_pg_ch_publication ADD TABLE ONLY public."CustomerSubscription";


--
-- Name: civitai_pg_ch_publication Image; Type: PUBLICATION TABLE; Schema: public; Owner: doadmin
--

ALTER PUBLICATION civitai_pg_ch_publication ADD TABLE ONLY public."Image";


--
-- Name: civitai_pg_ch_publication ImageMetric; Type: PUBLICATION TABLE; Schema: public; Owner: doadmin
--

ALTER PUBLICATION civitai_pg_ch_publication ADD TABLE ONLY public."ImageMetric";


--
-- Name: civitai_pg_ch_publication ImageReaction; Type: PUBLICATION TABLE; Schema: public; Owner: doadmin
--

ALTER PUBLICATION civitai_pg_ch_publication ADD TABLE ONLY public."ImageReaction";


--
-- Name: civitai_pg_ch_publication ImageReport; Type: PUBLICATION TABLE; Schema: public; Owner: doadmin
--

ALTER PUBLICATION civitai_pg_ch_publication ADD TABLE ONLY public."ImageReport";


--
-- Name: civitai_pg_ch_publication ImageResource; Type: PUBLICATION TABLE; Schema: public; Owner: doadmin
--

ALTER PUBLICATION civitai_pg_ch_publication ADD TABLE ONLY public."ImageResource";


--
-- Name: civitai_pg_ch_publication ImagesOnModels; Type: PUBLICATION TABLE; Schema: public; Owner: doadmin
--

ALTER PUBLICATION civitai_pg_ch_publication ADD TABLE ONLY public."ImagesOnModels";


--
-- Name: civitai_pg_ch_publication Import; Type: PUBLICATION TABLE; Schema: public; Owner: doadmin
--

ALTER PUBLICATION civitai_pg_ch_publication ADD TABLE ONLY public."Import";


--
-- Name: civitai_pg_ch_publication KeyValue; Type: PUBLICATION TABLE; Schema: public; Owner: doadmin
--

ALTER PUBLICATION civitai_pg_ch_publication ADD TABLE ONLY public."KeyValue";


--
-- Name: civitai_pg_ch_publication License; Type: PUBLICATION TABLE; Schema: public; Owner: doadmin
--

ALTER PUBLICATION civitai_pg_ch_publication ADD TABLE ONLY public."License";


--
-- Name: civitai_pg_ch_publication Log; Type: PUBLICATION TABLE; Schema: public; Owner: doadmin
--

ALTER PUBLICATION civitai_pg_ch_publication ADD TABLE ONLY public."Log";


--
-- Name: civitai_pg_ch_publication MetricUpdateQueue; Type: PUBLICATION TABLE; Schema: public; Owner: doadmin
--

ALTER PUBLICATION civitai_pg_ch_publication ADD TABLE ONLY public."MetricUpdateQueue";


--
-- Name: civitai_pg_ch_publication Model; Type: PUBLICATION TABLE; Schema: public; Owner: doadmin
--

ALTER PUBLICATION civitai_pg_ch_publication ADD TABLE ONLY public."Model";


--
-- Name: civitai_pg_ch_publication ModelEngagement; Type: PUBLICATION TABLE; Schema: public; Owner: doadmin
--

ALTER PUBLICATION civitai_pg_ch_publication ADD TABLE ONLY public."ModelEngagement";


--
-- Name: civitai_pg_ch_publication ModelFile; Type: PUBLICATION TABLE; Schema: public; Owner: doadmin
--

ALTER PUBLICATION civitai_pg_ch_publication ADD TABLE ONLY public."ModelFile";


--
-- Name: civitai_pg_ch_publication ModelFileHash; Type: PUBLICATION TABLE; Schema: public; Owner: doadmin
--

ALTER PUBLICATION civitai_pg_ch_publication ADD TABLE ONLY public."ModelFileHash";


--
-- Name: civitai_pg_ch_publication ModelInterest; Type: PUBLICATION TABLE; Schema: public; Owner: doadmin
--

ALTER PUBLICATION civitai_pg_ch_publication ADD TABLE ONLY public."ModelInterest";


--
-- Name: civitai_pg_ch_publication ModelMetric; Type: PUBLICATION TABLE; Schema: public; Owner: doadmin
--

ALTER PUBLICATION civitai_pg_ch_publication ADD TABLE ONLY public."ModelMetric";


--
-- Name: civitai_pg_ch_publication ModelMetricDaily; Type: PUBLICATION TABLE; Schema: public; Owner: doadmin
--

ALTER PUBLICATION civitai_pg_ch_publication ADD TABLE ONLY public."ModelMetricDaily";


--
-- Name: civitai_pg_ch_publication ModelReport; Type: PUBLICATION TABLE; Schema: public; Owner: doadmin
--

ALTER PUBLICATION civitai_pg_ch_publication ADD TABLE ONLY public."ModelReport";


--
-- Name: civitai_pg_ch_publication ModelVersion; Type: PUBLICATION TABLE; Schema: public; Owner: doadmin
--

ALTER PUBLICATION civitai_pg_ch_publication ADD TABLE ONLY public."ModelVersion";


--
-- Name: civitai_pg_ch_publication ModelVersionEngagement; Type: PUBLICATION TABLE; Schema: public; Owner: doadmin
--

ALTER PUBLICATION civitai_pg_ch_publication ADD TABLE ONLY public."ModelVersionEngagement";


--
-- Name: civitai_pg_ch_publication ModelVersionMetric; Type: PUBLICATION TABLE; Schema: public; Owner: doadmin
--

ALTER PUBLICATION civitai_pg_ch_publication ADD TABLE ONLY public."ModelVersionMetric";


--
-- Name: civitai_pg_ch_publication Partner; Type: PUBLICATION TABLE; Schema: public; Owner: doadmin
--

ALTER PUBLICATION civitai_pg_ch_publication ADD TABLE ONLY public."Partner";


--
-- Name: civitai_pg_ch_publication Post; Type: PUBLICATION TABLE; Schema: public; Owner: doadmin
--

ALTER PUBLICATION civitai_pg_ch_publication ADD TABLE ONLY public."Post";


--
-- Name: civitai_pg_ch_publication PostMetric; Type: PUBLICATION TABLE; Schema: public; Owner: doadmin
--

ALTER PUBLICATION civitai_pg_ch_publication ADD TABLE ONLY public."PostMetric";


--
-- Name: civitai_pg_ch_publication PostReaction; Type: PUBLICATION TABLE; Schema: public; Owner: doadmin
--

ALTER PUBLICATION civitai_pg_ch_publication ADD TABLE ONLY public."PostReaction";


--
-- Name: civitai_pg_ch_publication Price; Type: PUBLICATION TABLE; Schema: public; Owner: doadmin
--

ALTER PUBLICATION civitai_pg_ch_publication ADD TABLE ONLY public."Price";


--
-- Name: civitai_pg_ch_publication Product; Type: PUBLICATION TABLE; Schema: public; Owner: doadmin
--

ALTER PUBLICATION civitai_pg_ch_publication ADD TABLE ONLY public."Product";


--
-- Name: civitai_pg_ch_publication Purchase; Type: PUBLICATION TABLE; Schema: public; Owner: doadmin
--

ALTER PUBLICATION civitai_pg_ch_publication ADD TABLE ONLY public."Purchase";


--
-- Name: civitai_pg_ch_publication Question; Type: PUBLICATION TABLE; Schema: public; Owner: doadmin
--

ALTER PUBLICATION civitai_pg_ch_publication ADD TABLE ONLY public."Question";


--
-- Name: civitai_pg_ch_publication QuestionMetric; Type: PUBLICATION TABLE; Schema: public; Owner: doadmin
--

ALTER PUBLICATION civitai_pg_ch_publication ADD TABLE ONLY public."QuestionMetric";


--
-- Name: civitai_pg_ch_publication QuestionReaction; Type: PUBLICATION TABLE; Schema: public; Owner: doadmin
--

ALTER PUBLICATION civitai_pg_ch_publication ADD TABLE ONLY public."QuestionReaction";


--
-- Name: civitai_pg_ch_publication Report; Type: PUBLICATION TABLE; Schema: public; Owner: doadmin
--

ALTER PUBLICATION civitai_pg_ch_publication ADD TABLE ONLY public."Report";


--
-- Name: civitai_pg_ch_publication ResourceReview; Type: PUBLICATION TABLE; Schema: public; Owner: doadmin
--

ALTER PUBLICATION civitai_pg_ch_publication ADD TABLE ONLY public."ResourceReview";


--
-- Name: civitai_pg_ch_publication ResourceReviewReaction; Type: PUBLICATION TABLE; Schema: public; Owner: doadmin
--

ALTER PUBLICATION civitai_pg_ch_publication ADD TABLE ONLY public."ResourceReviewReaction";


--
-- Name: civitai_pg_ch_publication ResourceReviewReport; Type: PUBLICATION TABLE; Schema: public; Owner: doadmin
--

ALTER PUBLICATION civitai_pg_ch_publication ADD TABLE ONLY public."ResourceReviewReport";


--
-- Name: civitai_pg_ch_publication RunStrategy; Type: PUBLICATION TABLE; Schema: public; Owner: doadmin
--

ALTER PUBLICATION civitai_pg_ch_publication ADD TABLE ONLY public."RunStrategy";


--
-- Name: civitai_pg_ch_publication SavedModel; Type: PUBLICATION TABLE; Schema: public; Owner: doadmin
--

ALTER PUBLICATION civitai_pg_ch_publication ADD TABLE ONLY public."SavedModel";


--
-- Name: civitai_pg_ch_publication Session; Type: PUBLICATION TABLE; Schema: public; Owner: doadmin
--

ALTER PUBLICATION civitai_pg_ch_publication ADD TABLE ONLY public."Session";


--
-- Name: civitai_pg_ch_publication SessionInvalidation; Type: PUBLICATION TABLE; Schema: public; Owner: doadmin
--

ALTER PUBLICATION civitai_pg_ch_publication ADD TABLE ONLY public."SessionInvalidation";


--
-- Name: civitai_pg_ch_publication Tag; Type: PUBLICATION TABLE; Schema: public; Owner: doadmin
--

ALTER PUBLICATION civitai_pg_ch_publication ADD TABLE ONLY public."Tag";


--
-- Name: civitai_pg_ch_publication TagEngagement; Type: PUBLICATION TABLE; Schema: public; Owner: doadmin
--

ALTER PUBLICATION civitai_pg_ch_publication ADD TABLE ONLY public."TagEngagement";


--
-- Name: civitai_pg_ch_publication TagMetric; Type: PUBLICATION TABLE; Schema: public; Owner: doadmin
--

ALTER PUBLICATION civitai_pg_ch_publication ADD TABLE ONLY public."TagMetric";


--
-- Name: civitai_pg_ch_publication TagsOnImage; Type: PUBLICATION TABLE; Schema: public; Owner: doadmin
--

ALTER PUBLICATION civitai_pg_ch_publication ADD TABLE ONLY public."TagsOnImage";


--
-- Name: civitai_pg_ch_publication TagsOnImageVote; Type: PUBLICATION TABLE; Schema: public; Owner: doadmin
--

ALTER PUBLICATION civitai_pg_ch_publication ADD TABLE ONLY public."TagsOnImageVote";


--
-- Name: civitai_pg_ch_publication TagsOnModels; Type: PUBLICATION TABLE; Schema: public; Owner: doadmin
--

ALTER PUBLICATION civitai_pg_ch_publication ADD TABLE ONLY public."TagsOnModels";


--
-- Name: civitai_pg_ch_publication TagsOnModelsVote; Type: PUBLICATION TABLE; Schema: public; Owner: doadmin
--

ALTER PUBLICATION civitai_pg_ch_publication ADD TABLE ONLY public."TagsOnModelsVote";


--
-- Name: civitai_pg_ch_publication TagsOnPost; Type: PUBLICATION TABLE; Schema: public; Owner: doadmin
--

ALTER PUBLICATION civitai_pg_ch_publication ADD TABLE ONLY public."TagsOnPost";


--
-- Name: civitai_pg_ch_publication TagsOnPostVote; Type: PUBLICATION TABLE; Schema: public; Owner: doadmin
--

ALTER PUBLICATION civitai_pg_ch_publication ADD TABLE ONLY public."TagsOnPostVote";


--
-- Name: civitai_pg_ch_publication TagsOnQuestions; Type: PUBLICATION TABLE; Schema: public; Owner: doadmin
--

ALTER PUBLICATION civitai_pg_ch_publication ADD TABLE ONLY public."TagsOnQuestions";


--
-- Name: civitai_pg_ch_publication TagsOnTags; Type: PUBLICATION TABLE; Schema: public; Owner: doadmin
--

ALTER PUBLICATION civitai_pg_ch_publication ADD TABLE ONLY public."TagsOnTags";


--
-- Name: civitai_pg_ch_publication Thread; Type: PUBLICATION TABLE; Schema: public; Owner: doadmin
--

ALTER PUBLICATION civitai_pg_ch_publication ADD TABLE ONLY public."Thread";


--
-- Name: civitai_pg_ch_publication User; Type: PUBLICATION TABLE; Schema: public; Owner: doadmin
--

ALTER PUBLICATION civitai_pg_ch_publication ADD TABLE ONLY public."User";


--
-- Name: civitai_pg_ch_publication UserCosmetic; Type: PUBLICATION TABLE; Schema: public; Owner: doadmin
--

ALTER PUBLICATION civitai_pg_ch_publication ADD TABLE ONLY public."UserCosmetic";


--
-- Name: civitai_pg_ch_publication UserEngagement; Type: PUBLICATION TABLE; Schema: public; Owner: doadmin
--

ALTER PUBLICATION civitai_pg_ch_publication ADD TABLE ONLY public."UserEngagement";


--
-- Name: civitai_pg_ch_publication UserLink; Type: PUBLICATION TABLE; Schema: public; Owner: doadmin
--

ALTER PUBLICATION civitai_pg_ch_publication ADD TABLE ONLY public."UserLink";


--
-- Name: civitai_pg_ch_publication UserMetric; Type: PUBLICATION TABLE; Schema: public; Owner: doadmin
--

ALTER PUBLICATION civitai_pg_ch_publication ADD TABLE ONLY public."UserMetric";


--
-- Name: civitai_pg_ch_publication UserNotificationSettings; Type: PUBLICATION TABLE; Schema: public; Owner: doadmin
--

ALTER PUBLICATION civitai_pg_ch_publication ADD TABLE ONLY public."UserNotificationSettings";


--
-- Name: civitai_pg_ch_publication VerificationToken; Type: PUBLICATION TABLE; Schema: public; Owner: doadmin
--

ALTER PUBLICATION civitai_pg_ch_publication ADD TABLE ONLY public."VerificationToken";


--
-- Name: civitai_pg_ch_publication Webhook; Type: PUBLICATION TABLE; Schema: public; Owner: doadmin
--

ALTER PUBLICATION civitai_pg_ch_publication ADD TABLE ONLY public."Webhook";


--
-- Name: civitai_pg_ch_publication _LicenseToModel; Type: PUBLICATION TABLE; Schema: public; Owner: doadmin
--

ALTER PUBLICATION civitai_pg_ch_publication ADD TABLE ONLY public."_LicenseToModel";


--
-- Name: civitai_pg_ch_publication _prisma_migrations; Type: PUBLICATION TABLE; Schema: public; Owner: doadmin
--

ALTER PUBLICATION civitai_pg_ch_publication ADD TABLE ONLY public._prisma_migrations;


--
-- Name: SCHEMA pganalyze; Type: ACL; Schema: -; Owner: doadmin
--

GRANT USAGE ON SCHEMA pganalyze TO pganalyze;
GRANT ALL ON SCHEMA pganalyze TO civitai;
GRANT ALL ON SCHEMA pganalyze TO "civitai-read";


--
-- Name: SCHEMA pghero; Type: ACL; Schema: -; Owner: doadmin
--

GRANT USAGE ON SCHEMA pghero TO pghero;


--
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: pg_database_owner
--

GRANT ALL ON SCHEMA public TO civitai;
GRANT USAGE ON SCHEMA public TO "civitai-read";
GRANT USAGE ON SCHEMA public TO pganalyze;
GRANT USAGE ON SCHEMA public TO hasura;
GRANT USAGE ON SCHEMA public TO retool;
GRANT ALL ON SCHEMA public TO "civitai-jobs";


--
-- Name: FUNCTION add_image_metrics(); Type: ACL; Schema: public; Owner: civitai
--

GRANT ALL ON FUNCTION public.add_image_metrics() TO "civitai-jobs";


--
-- Name: FUNCTION add_model_metrics(); Type: ACL; Schema: public; Owner: doadmin
--

GRANT ALL ON FUNCTION public.add_model_metrics() TO "civitai-jobs";


--
-- Name: FUNCTION create_buzz_withdrawal_request_history_on_insert(); Type: ACL; Schema: public; Owner: civitai
--

GRANT ALL ON FUNCTION public.create_buzz_withdrawal_request_history_on_insert() TO "civitai-jobs";


--
-- Name: FUNCTION create_job_queue_record(entityid integer, entitytype text, type text); Type: ACL; Schema: public; Owner: civitai
--

GRANT ALL ON FUNCTION public.create_job_queue_record(entityid integer, entitytype text, type text) TO "civitai-jobs";


--
-- Name: FUNCTION create_redeemable_codes(prefix text, unit_value integer, quantity integer, code_type public."RedeemableCodeType", expires_at timestamp without time zone); Type: ACL; Schema: public; Owner: doadmin
--

GRANT ALL ON FUNCTION public.create_redeemable_codes(prefix text, unit_value integer, quantity integer, code_type public."RedeemableCodeType", expires_at timestamp without time zone) TO "civitai-jobs";


--
-- Name: FUNCTION early_access_ends_at(); Type: ACL; Schema: public; Owner: doadmin
--

GRANT ALL ON FUNCTION public.early_access_ends_at() TO "civitai-jobs";


--
-- Name: FUNCTION feature_images(num_images_per_category integer); Type: ACL; Schema: public; Owner: civitai
--

GRANT ALL ON FUNCTION public.feature_images(num_images_per_category integer) TO "civitai-jobs";


--
-- Name: FUNCTION feature_images(tags_to_exclude text, num_images_per_category integer); Type: ACL; Schema: public; Owner: civitai
--

GRANT ALL ON FUNCTION public.feature_images(tags_to_exclude text, num_images_per_category integer) TO "civitai-jobs";


--
-- Name: FUNCTION generate_redeemable_code(prefix text); Type: ACL; Schema: public; Owner: doadmin
--

GRANT ALL ON FUNCTION public.generate_redeemable_code(prefix text) TO "civitai-jobs";


--
-- Name: FUNCTION generate_token(length integer); Type: ACL; Schema: public; Owner: doadmin
--

GRANT ALL ON FUNCTION public.generate_token(length integer) TO "civitai-jobs";


--
-- Name: FUNCTION get_image_resources(image_id integer); Type: ACL; Schema: public; Owner: doadmin
--

GRANT ALL ON FUNCTION public.get_image_resources(image_id integer) TO "civitai-jobs";


--
-- Name: FUNCTION get_image_resources2(image_id integer); Type: ACL; Schema: public; Owner: civitai
--

GRANT ALL ON FUNCTION public.get_image_resources2(image_id integer) TO "civitai-jobs";


--
-- Name: FUNCTION get_nsfw_level_name(nsfw_level_id integer); Type: ACL; Schema: public; Owner: doadmin
--

GRANT ALL ON FUNCTION public.get_nsfw_level_name(nsfw_level_id integer) TO "civitai-jobs";


--
-- Name: FUNCTION hamming_distance(hash1 bigint, hash2 bigint); Type: ACL; Schema: public; Owner: civitai
--

GRANT ALL ON FUNCTION public.hamming_distance(hash1 bigint, hash2 bigint) TO "civitai-jobs";


--
-- Name: FUNCTION hamming_distance_bigint(hash1 bigint, hash2 bigint); Type: ACL; Schema: public; Owner: civitai
--

GRANT ALL ON FUNCTION public.hamming_distance_bigint(hash1 bigint, hash2 bigint) TO "civitai-jobs";


--
-- Name: FUNCTION iif(condition boolean, true_result anyelement, false_result anyelement); Type: ACL; Schema: public; Owner: civitai
--

GRANT ALL ON FUNCTION public.iif(condition boolean, true_result anyelement, false_result anyelement) TO "civitai-jobs";


--
-- Name: FUNCTION insert_image_resource(image_id integer); Type: ACL; Schema: public; Owner: civitai
--

GRANT ALL ON FUNCTION public.insert_image_resource(image_id integer) TO "civitai-jobs";


--
-- Name: FUNCTION is_new_user(userid integer); Type: ACL; Schema: public; Owner: doadmin
--

GRANT ALL ON FUNCTION public.is_new_user(userid integer) TO "civitai-jobs";


--
-- Name: FUNCTION months_between(from_date timestamp without time zone, to_date timestamp without time zone); Type: ACL; Schema: public; Owner: civitai
--

GRANT ALL ON FUNCTION public.months_between(from_date timestamp without time zone, to_date timestamp without time zone) TO "civitai-jobs";


--
-- Name: FUNCTION publish_post_metrics(); Type: ACL; Schema: public; Owner: civitai
--

GRANT ALL ON FUNCTION public.publish_post_metrics() TO "civitai-jobs";


--
-- Name: FUNCTION refresh_covered_checkpoint_details(); Type: ACL; Schema: public; Owner: civitai
--

GRANT ALL ON FUNCTION public.refresh_covered_checkpoint_details() TO "civitai-jobs";


--
-- Name: FUNCTION slugify(input_string text); Type: ACL; Schema: public; Owner: civitai
--

GRANT ALL ON FUNCTION public.slugify(input_string text) TO "civitai-jobs";


--
-- Name: FUNCTION truncate_autov3_hash(); Type: ACL; Schema: public; Owner: doadmin
--

GRANT ALL ON FUNCTION public.truncate_autov3_hash() TO "civitai-jobs";


--
-- Name: FUNCTION update_article_nsfw_level(); Type: ACL; Schema: public; Owner: civitai
--

GRANT ALL ON FUNCTION public.update_article_nsfw_level() TO "civitai-jobs";


--
-- Name: FUNCTION update_bounty_nsfw_level(); Type: ACL; Schema: public; Owner: civitai
--

GRANT ALL ON FUNCTION public.update_bounty_nsfw_level() TO "civitai-jobs";


--
-- Name: FUNCTION update_buzz_withdrawal_request_status(); Type: ACL; Schema: public; Owner: civitai
--

GRANT ALL ON FUNCTION public.update_buzz_withdrawal_request_status() TO "civitai-jobs";


--
-- Name: FUNCTION update_collection_nsfw_level(); Type: ACL; Schema: public; Owner: civitai
--

GRANT ALL ON FUNCTION public.update_collection_nsfw_level() TO "civitai-jobs";


--
-- Name: FUNCTION update_image_nsfw_level(); Type: ACL; Schema: public; Owner: civitai
--

GRANT ALL ON FUNCTION public.update_image_nsfw_level() TO "civitai-jobs";


--
-- Name: FUNCTION update_image_poi(); Type: ACL; Schema: public; Owner: civitai
--

GRANT ALL ON FUNCTION public.update_image_poi() TO "civitai-jobs";


--
-- Name: FUNCTION update_image_sort_at(); Type: ACL; Schema: public; Owner: civitai
--

GRANT ALL ON FUNCTION public.update_image_sort_at() TO "civitai-jobs";


--
-- Name: FUNCTION update_model_nsfw_level(); Type: ACL; Schema: public; Owner: civitai
--

GRANT ALL ON FUNCTION public.update_model_nsfw_level() TO "civitai-jobs";


--
-- Name: FUNCTION update_model_version_nsfw_level(); Type: ACL; Schema: public; Owner: civitai
--

GRANT ALL ON FUNCTION public.update_model_version_nsfw_level() TO "civitai-jobs";


--
-- Name: FUNCTION update_muted_at(); Type: ACL; Schema: public; Owner: civitai
--

GRANT ALL ON FUNCTION public.update_muted_at() TO "civitai-jobs";


--
-- Name: FUNCTION update_nsfw_level(VARIADIC image_ids integer[]); Type: ACL; Schema: public; Owner: civitai
--

GRANT ALL ON FUNCTION public.update_nsfw_level(VARIADIC image_ids integer[]) TO "civitai-jobs";


--
-- Name: FUNCTION update_nsfw_levels(image_ids integer[]); Type: ACL; Schema: public; Owner: civitai
--

GRANT ALL ON FUNCTION public.update_nsfw_levels(image_ids integer[]) TO "civitai-jobs";


--
-- Name: FUNCTION update_post_nsfw_level(); Type: ACL; Schema: public; Owner: civitai
--

GRANT ALL ON FUNCTION public.update_post_nsfw_level() TO "civitai-jobs";


--
-- Name: FUNCTION update_post_nsfw_level(VARIADIC post_ids integer[]); Type: ACL; Schema: public; Owner: civitai
--

GRANT ALL ON FUNCTION public.update_post_nsfw_level(VARIADIC post_ids integer[]) TO "civitai-jobs";


--
-- Name: FUNCTION update_post_nsfw_levels(post_ids integer[]); Type: ACL; Schema: public; Owner: civitai
--

GRANT ALL ON FUNCTION public.update_post_nsfw_levels(post_ids integer[]) TO "civitai-jobs";


--
-- Name: TABLE pg_stat_activity; Type: ACL; Schema: pghero; Owner: doadmin
--

GRANT SELECT ON TABLE pghero.pg_stat_activity TO pghero;


--
-- Name: TABLE pg_stats; Type: ACL; Schema: pghero; Owner: doadmin
--

GRANT SELECT ON TABLE pghero.pg_stats TO pghero;


--
-- Name: TABLE "Account"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."Account" TO retool;
GRANT ALL ON TABLE public."Account" TO "civitai-read";
GRANT SELECT ON TABLE public."Account" TO hasura;
GRANT ALL ON TABLE public."Account" TO "civitai-jobs";


--
-- Name: SEQUENCE "Account_id_seq"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON SEQUENCE public."Account_id_seq" TO pghero;
GRANT SELECT,USAGE ON SEQUENCE public."Account_id_seq" TO "civitai-read";
GRANT ALL ON SEQUENCE public."Account_id_seq" TO retool;
GRANT ALL ON SEQUENCE public."Account_id_seq" TO "civitai-jobs";


--
-- Name: TABLE "Announcement"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."Announcement" TO retool;
GRANT ALL ON TABLE public."Announcement" TO "civitai-read";
GRANT SELECT ON TABLE public."Announcement" TO hasura;
GRANT ALL ON TABLE public."Announcement" TO "civitai-jobs";


--
-- Name: SEQUENCE "Announcement_id_seq"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON SEQUENCE public."Announcement_id_seq" TO pghero;
GRANT SELECT,USAGE ON SEQUENCE public."Announcement_id_seq" TO "civitai-read";
GRANT ALL ON SEQUENCE public."Announcement_id_seq" TO retool;
GRANT ALL ON SEQUENCE public."Announcement_id_seq" TO "civitai-jobs";


--
-- Name: TABLE "Answer"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."Answer" TO retool;
GRANT ALL ON TABLE public."Answer" TO "civitai-read";
GRANT SELECT ON TABLE public."Answer" TO hasura;
GRANT ALL ON TABLE public."Answer" TO "civitai-jobs";


--
-- Name: TABLE "AnswerMetric"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."AnswerMetric" TO retool;
GRANT ALL ON TABLE public."AnswerMetric" TO "civitai-read";
GRANT SELECT ON TABLE public."AnswerMetric" TO hasura;
GRANT ALL ON TABLE public."AnswerMetric" TO "civitai-jobs";


--
-- Name: TABLE "AnswerRank"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."AnswerRank" TO retool;
GRANT ALL ON TABLE public."AnswerRank" TO "civitai-read";
GRANT SELECT ON TABLE public."AnswerRank" TO hasura;
GRANT ALL ON TABLE public."AnswerRank" TO "civitai-jobs";


--
-- Name: TABLE "AnswerReaction"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."AnswerReaction" TO retool;
GRANT ALL ON TABLE public."AnswerReaction" TO "civitai-read";
GRANT SELECT ON TABLE public."AnswerReaction" TO hasura;
GRANT ALL ON TABLE public."AnswerReaction" TO "civitai-jobs";


--
-- Name: SEQUENCE "AnswerReaction_id_seq"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON SEQUENCE public."AnswerReaction_id_seq" TO pghero;
GRANT SELECT,USAGE ON SEQUENCE public."AnswerReaction_id_seq" TO "civitai-read";
GRANT ALL ON SEQUENCE public."AnswerReaction_id_seq" TO retool;
GRANT ALL ON SEQUENCE public."AnswerReaction_id_seq" TO "civitai-jobs";


--
-- Name: TABLE "AnswerVote"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."AnswerVote" TO retool;
GRANT ALL ON TABLE public."AnswerVote" TO "civitai-read";
GRANT SELECT ON TABLE public."AnswerVote" TO hasura;
GRANT ALL ON TABLE public."AnswerVote" TO "civitai-jobs";


--
-- Name: SEQUENCE "Answer_id_seq"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON SEQUENCE public."Answer_id_seq" TO pghero;
GRANT SELECT,USAGE ON SEQUENCE public."Answer_id_seq" TO "civitai-read";
GRANT ALL ON SEQUENCE public."Answer_id_seq" TO retool;
GRANT ALL ON SEQUENCE public."Answer_id_seq" TO "civitai-jobs";


--
-- Name: TABLE "ApiKey"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."ApiKey" TO retool;
GRANT ALL ON TABLE public."ApiKey" TO "civitai-read";
GRANT SELECT ON TABLE public."ApiKey" TO hasura;
GRANT ALL ON TABLE public."ApiKey" TO "civitai-jobs";


--
-- Name: SEQUENCE "ApiKey_id_seq"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON SEQUENCE public."ApiKey_id_seq" TO pghero;
GRANT SELECT ON SEQUENCE public."ApiKey_id_seq" TO "civitai-read";
GRANT ALL ON SEQUENCE public."ApiKey_id_seq" TO retool;
GRANT ALL ON SEQUENCE public."ApiKey_id_seq" TO "civitai-jobs";


--
-- Name: TABLE "Article"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."Article" TO retool;
GRANT ALL ON TABLE public."Article" TO "civitai-read";
GRANT SELECT ON TABLE public."Article" TO hasura;
GRANT ALL ON TABLE public."Article" TO "civitai-jobs";


--
-- Name: TABLE "ArticleEngagement"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."ArticleEngagement" TO retool;
GRANT ALL ON TABLE public."ArticleEngagement" TO "civitai-read";
GRANT SELECT ON TABLE public."ArticleEngagement" TO hasura;
GRANT ALL ON TABLE public."ArticleEngagement" TO "civitai-jobs";


--
-- Name: TABLE "ArticleMetric"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."ArticleMetric" TO retool;
GRANT ALL ON TABLE public."ArticleMetric" TO "civitai-read";
GRANT SELECT ON TABLE public."ArticleMetric" TO hasura;
GRANT ALL ON TABLE public."ArticleMetric" TO "civitai-jobs";


--
-- Name: TABLE "ArticleRank"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."ArticleRank" TO "civitai-read";


--
-- Name: TABLE "ArticleRank_Live"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."ArticleRank_Live" TO retool;
GRANT ALL ON TABLE public."ArticleRank_Live" TO "civitai-read";
GRANT SELECT ON TABLE public."ArticleRank_Live" TO hasura;
GRANT ALL ON TABLE public."ArticleRank_Live" TO "civitai-jobs";


--
-- Name: TABLE "ArticleReaction"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."ArticleReaction" TO retool;
GRANT ALL ON TABLE public."ArticleReaction" TO "civitai-read";
GRANT SELECT ON TABLE public."ArticleReaction" TO hasura;
GRANT ALL ON TABLE public."ArticleReaction" TO "civitai-jobs";


--
-- Name: SEQUENCE "ArticleReaction_id_seq"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON SEQUENCE public."ArticleReaction_id_seq" TO pghero;
GRANT SELECT,USAGE ON SEQUENCE public."ArticleReaction_id_seq" TO "civitai-read";
GRANT ALL ON SEQUENCE public."ArticleReaction_id_seq" TO retool;
GRANT ALL ON SEQUENCE public."ArticleReaction_id_seq" TO "civitai-jobs";


--
-- Name: TABLE "ArticleReport"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."ArticleReport" TO retool;
GRANT ALL ON TABLE public."ArticleReport" TO "civitai-read";
GRANT SELECT ON TABLE public."ArticleReport" TO hasura;
GRANT ALL ON TABLE public."ArticleReport" TO "civitai-jobs";


--
-- Name: TABLE "ArticleStat"; Type: ACL; Schema: public; Owner: civitai
--

GRANT ALL ON TABLE public."ArticleStat" TO "civitai-read";
GRANT SELECT ON TABLE public."ArticleStat" TO retool;
GRANT SELECT ON TABLE public."ArticleStat" TO hasura;
GRANT ALL ON TABLE public."ArticleStat" TO "civitai-jobs";


--
-- Name: SEQUENCE "Article_id_seq"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON SEQUENCE public."Article_id_seq" TO pghero;
GRANT SELECT,USAGE ON SEQUENCE public."Article_id_seq" TO "civitai-read";
GRANT ALL ON SEQUENCE public."Article_id_seq" TO retool;
GRANT ALL ON SEQUENCE public."Article_id_seq" TO "civitai-jobs";


--
-- Name: TABLE "Bounty"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT,UPDATE ON TABLE public."Bounty" TO retool;
GRANT ALL ON TABLE public."Bounty" TO "civitai-read";
GRANT SELECT ON TABLE public."Bounty" TO hasura;
GRANT ALL ON TABLE public."Bounty" TO "civitai-jobs";


--
-- Name: TABLE "BountyBenefactor"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."BountyBenefactor" TO retool;
GRANT ALL ON TABLE public."BountyBenefactor" TO "civitai-read";
GRANT SELECT ON TABLE public."BountyBenefactor" TO hasura;
GRANT ALL ON TABLE public."BountyBenefactor" TO "civitai-jobs";


--
-- Name: TABLE "BountyEngagement"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."BountyEngagement" TO retool;
GRANT ALL ON TABLE public."BountyEngagement" TO "civitai-read";
GRANT SELECT ON TABLE public."BountyEngagement" TO hasura;
GRANT ALL ON TABLE public."BountyEngagement" TO "civitai-jobs";


--
-- Name: TABLE "BountyEntry"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."BountyEntry" TO retool;
GRANT ALL ON TABLE public."BountyEntry" TO "civitai-read";
GRANT SELECT ON TABLE public."BountyEntry" TO hasura;
GRANT ALL ON TABLE public."BountyEntry" TO "civitai-jobs";


--
-- Name: TABLE "BountyEntryMetric"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."BountyEntryMetric" TO retool;
GRANT ALL ON TABLE public."BountyEntryMetric" TO "civitai-read";
GRANT SELECT ON TABLE public."BountyEntryMetric" TO hasura;
GRANT ALL ON TABLE public."BountyEntryMetric" TO "civitai-jobs";


--
-- Name: TABLE "BountyEntryRank"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."BountyEntryRank" TO "civitai-read";


--
-- Name: TABLE "BountyEntryRank_Live"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."BountyEntryRank_Live" TO retool;
GRANT ALL ON TABLE public."BountyEntryRank_Live" TO "civitai-read";
GRANT SELECT ON TABLE public."BountyEntryRank_Live" TO hasura;
GRANT ALL ON TABLE public."BountyEntryRank_Live" TO "civitai-jobs";


--
-- Name: TABLE "BountyEntryReaction"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."BountyEntryReaction" TO retool;
GRANT ALL ON TABLE public."BountyEntryReaction" TO "civitai-read";
GRANT SELECT ON TABLE public."BountyEntryReaction" TO hasura;
GRANT ALL ON TABLE public."BountyEntryReaction" TO "civitai-jobs";


--
-- Name: TABLE "BountyEntryReport"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."BountyEntryReport" TO retool;
GRANT ALL ON TABLE public."BountyEntryReport" TO "civitai-read";
GRANT SELECT ON TABLE public."BountyEntryReport" TO hasura;
GRANT ALL ON TABLE public."BountyEntryReport" TO "civitai-jobs";


--
-- Name: TABLE "BountyEntryStat"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."BountyEntryStat" TO retool;
GRANT ALL ON TABLE public."BountyEntryStat" TO "civitai-read";
GRANT SELECT ON TABLE public."BountyEntryStat" TO hasura;
GRANT ALL ON TABLE public."BountyEntryStat" TO "civitai-jobs";


--
-- Name: SEQUENCE "BountyEntry_id_seq"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON SEQUENCE public."BountyEntry_id_seq" TO pghero;
GRANT SELECT,USAGE ON SEQUENCE public."BountyEntry_id_seq" TO "civitai-read";
GRANT ALL ON SEQUENCE public."BountyEntry_id_seq" TO retool;
GRANT ALL ON SEQUENCE public."BountyEntry_id_seq" TO "civitai-jobs";


--
-- Name: TABLE "BountyMetric"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."BountyMetric" TO retool;
GRANT ALL ON TABLE public."BountyMetric" TO "civitai-read";
GRANT SELECT ON TABLE public."BountyMetric" TO hasura;
GRANT ALL ON TABLE public."BountyMetric" TO "civitai-jobs";


--
-- Name: TABLE "BountyRank"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."BountyRank" TO "civitai-read";


--
-- Name: TABLE "BountyRank_Live"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."BountyRank_Live" TO retool;
GRANT ALL ON TABLE public."BountyRank_Live" TO "civitai-read";
GRANT SELECT ON TABLE public."BountyRank_Live" TO hasura;
GRANT ALL ON TABLE public."BountyRank_Live" TO "civitai-jobs";


--
-- Name: TABLE "BountyReport"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."BountyReport" TO retool;
GRANT ALL ON TABLE public."BountyReport" TO "civitai-read";
GRANT SELECT ON TABLE public."BountyReport" TO hasura;
GRANT ALL ON TABLE public."BountyReport" TO "civitai-jobs";


--
-- Name: TABLE "BountyStat"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."BountyStat" TO retool;
GRANT ALL ON TABLE public."BountyStat" TO "civitai-read";
GRANT SELECT ON TABLE public."BountyStat" TO hasura;
GRANT ALL ON TABLE public."BountyStat" TO "civitai-jobs";


--
-- Name: SEQUENCE "Bounty_id_seq"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON SEQUENCE public."Bounty_id_seq" TO pghero;
GRANT SELECT,USAGE ON SEQUENCE public."Bounty_id_seq" TO "civitai-read";
GRANT ALL ON SEQUENCE public."Bounty_id_seq" TO retool;
GRANT ALL ON SEQUENCE public."Bounty_id_seq" TO "civitai-jobs";


--
-- Name: TABLE "BuildGuide"; Type: ACL; Schema: public; Owner: doadmin
--

GRANT ALL ON TABLE public."BuildGuide" TO civitai;
GRANT ALL ON TABLE public."BuildGuide" TO "civitai-read";
GRANT SELECT ON TABLE public."BuildGuide" TO hasura;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."BuildGuide" TO retool;
GRANT ALL ON TABLE public."BuildGuide" TO "civitai-jobs";


--
-- Name: SEQUENCE "BuildGuide_id_seq"; Type: ACL; Schema: public; Owner: doadmin
--

GRANT ALL ON SEQUENCE public."BuildGuide_id_seq" TO civitai;
GRANT SELECT ON SEQUENCE public."BuildGuide_id_seq" TO pghero;
GRANT SELECT,USAGE ON SEQUENCE public."BuildGuide_id_seq" TO "civitai-read";
GRANT ALL ON SEQUENCE public."BuildGuide_id_seq" TO retool;
GRANT ALL ON SEQUENCE public."BuildGuide_id_seq" TO "civitai-jobs";


--
-- Name: TABLE "BuzzClaim"; Type: ACL; Schema: public; Owner: civitai
--

GRANT ALL ON TABLE public."BuzzClaim" TO "civitai-read";
GRANT SELECT ON TABLE public."BuzzClaim" TO hasura;
GRANT SELECT ON TABLE public."BuzzClaim" TO retool;
GRANT ALL ON TABLE public."BuzzClaim" TO "civitai-jobs";


--
-- Name: TABLE "BuzzTip"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."BuzzTip" TO retool;
GRANT ALL ON TABLE public."BuzzTip" TO "civitai-read";
GRANT SELECT ON TABLE public."BuzzTip" TO hasura;
GRANT ALL ON TABLE public."BuzzTip" TO "civitai-jobs";


--
-- Name: TABLE "BuzzWithdrawalRequest"; Type: ACL; Schema: public; Owner: civitai
--

GRANT ALL ON TABLE public."BuzzWithdrawalRequest" TO "civitai-read";
GRANT SELECT ON TABLE public."BuzzWithdrawalRequest" TO hasura;
GRANT SELECT ON TABLE public."BuzzWithdrawalRequest" TO retool;
GRANT ALL ON TABLE public."BuzzWithdrawalRequest" TO "civitai-jobs";


--
-- Name: TABLE "BuzzWithdrawalRequestHistory"; Type: ACL; Schema: public; Owner: civitai
--

GRANT ALL ON TABLE public."BuzzWithdrawalRequestHistory" TO "civitai-read";
GRANT SELECT ON TABLE public."BuzzWithdrawalRequestHistory" TO hasura;
GRANT SELECT ON TABLE public."BuzzWithdrawalRequestHistory" TO retool;
GRANT ALL ON TABLE public."BuzzWithdrawalRequestHistory" TO "civitai-jobs";


--
-- Name: TABLE "Chat"; Type: ACL; Schema: public; Owner: civitai
--

GRANT ALL ON TABLE public."Chat" TO "civitai-read";
GRANT SELECT ON TABLE public."Chat" TO hasura;
GRANT SELECT ON TABLE public."Chat" TO retool;
GRANT ALL ON TABLE public."Chat" TO "civitai-jobs";


--
-- Name: TABLE "ChatMember"; Type: ACL; Schema: public; Owner: civitai
--

GRANT ALL ON TABLE public."ChatMember" TO "civitai-read";
GRANT SELECT ON TABLE public."ChatMember" TO hasura;
GRANT SELECT ON TABLE public."ChatMember" TO retool;
GRANT ALL ON TABLE public."ChatMember" TO "civitai-jobs";


--
-- Name: SEQUENCE "ChatMember_id_seq"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON SEQUENCE public."ChatMember_id_seq" TO pghero;
GRANT SELECT,USAGE ON SEQUENCE public."ChatMember_id_seq" TO "civitai-read";
GRANT ALL ON SEQUENCE public."ChatMember_id_seq" TO retool;
GRANT ALL ON SEQUENCE public."ChatMember_id_seq" TO "civitai-jobs";


--
-- Name: TABLE "ChatMessage"; Type: ACL; Schema: public; Owner: civitai
--

GRANT ALL ON TABLE public."ChatMessage" TO "civitai-read";
GRANT SELECT ON TABLE public."ChatMessage" TO hasura;
GRANT SELECT ON TABLE public."ChatMessage" TO retool;
GRANT ALL ON TABLE public."ChatMessage" TO "civitai-jobs";


--
-- Name: SEQUENCE "ChatMessage_id_seq"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON SEQUENCE public."ChatMessage_id_seq" TO pghero;
GRANT SELECT,USAGE ON SEQUENCE public."ChatMessage_id_seq" TO "civitai-read";
GRANT ALL ON SEQUENCE public."ChatMessage_id_seq" TO retool;
GRANT ALL ON SEQUENCE public."ChatMessage_id_seq" TO "civitai-jobs";


--
-- Name: TABLE "ChatReport"; Type: ACL; Schema: public; Owner: civitai
--

GRANT ALL ON TABLE public."ChatReport" TO "civitai-read";
GRANT SELECT ON TABLE public."ChatReport" TO hasura;
GRANT SELECT ON TABLE public."ChatReport" TO retool;
GRANT ALL ON TABLE public."ChatReport" TO "civitai-jobs";


--
-- Name: SEQUENCE "Chat_id_seq"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON SEQUENCE public."Chat_id_seq" TO pghero;
GRANT SELECT,USAGE ON SEQUENCE public."Chat_id_seq" TO "civitai-read";
GRANT ALL ON SEQUENCE public."Chat_id_seq" TO retool;
GRANT ALL ON SEQUENCE public."Chat_id_seq" TO "civitai-jobs";


--
-- Name: TABLE "Club"; Type: ACL; Schema: public; Owner: civitai
--

GRANT ALL ON TABLE public."Club" TO "civitai-read";
GRANT SELECT ON TABLE public."Club" TO hasura;
GRANT SELECT ON TABLE public."Club" TO retool;
GRANT ALL ON TABLE public."Club" TO "civitai-jobs";


--
-- Name: TABLE "ClubAdmin"; Type: ACL; Schema: public; Owner: civitai
--

GRANT ALL ON TABLE public."ClubAdmin" TO "civitai-read";
GRANT SELECT ON TABLE public."ClubAdmin" TO hasura;
GRANT SELECT ON TABLE public."ClubAdmin" TO retool;
GRANT ALL ON TABLE public."ClubAdmin" TO "civitai-jobs";


--
-- Name: TABLE "ClubAdminInvite"; Type: ACL; Schema: public; Owner: civitai
--

GRANT ALL ON TABLE public."ClubAdminInvite" TO "civitai-read";
GRANT SELECT ON TABLE public."ClubAdminInvite" TO hasura;
GRANT SELECT ON TABLE public."ClubAdminInvite" TO retool;
GRANT ALL ON TABLE public."ClubAdminInvite" TO "civitai-jobs";


--
-- Name: TABLE "ClubMembership"; Type: ACL; Schema: public; Owner: civitai
--

GRANT ALL ON TABLE public."ClubMembership" TO "civitai-read";
GRANT SELECT ON TABLE public."ClubMembership" TO hasura;
GRANT SELECT ON TABLE public."ClubMembership" TO retool;
GRANT ALL ON TABLE public."ClubMembership" TO "civitai-jobs";


--
-- Name: TABLE "ClubMembershipCharge"; Type: ACL; Schema: public; Owner: civitai
--

GRANT ALL ON TABLE public."ClubMembershipCharge" TO "civitai-read";
GRANT SELECT ON TABLE public."ClubMembershipCharge" TO hasura;
GRANT SELECT ON TABLE public."ClubMembershipCharge" TO retool;
GRANT ALL ON TABLE public."ClubMembershipCharge" TO "civitai-jobs";


--
-- Name: SEQUENCE "ClubMembershipCharge_id_seq"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON SEQUENCE public."ClubMembershipCharge_id_seq" TO pghero;
GRANT SELECT,USAGE ON SEQUENCE public."ClubMembershipCharge_id_seq" TO "civitai-read";
GRANT ALL ON SEQUENCE public."ClubMembershipCharge_id_seq" TO retool;
GRANT ALL ON SEQUENCE public."ClubMembershipCharge_id_seq" TO "civitai-jobs";


--
-- Name: SEQUENCE "ClubMembership_id_seq"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON SEQUENCE public."ClubMembership_id_seq" TO pghero;
GRANT SELECT,USAGE ON SEQUENCE public."ClubMembership_id_seq" TO "civitai-read";
GRANT ALL ON SEQUENCE public."ClubMembership_id_seq" TO retool;
GRANT ALL ON SEQUENCE public."ClubMembership_id_seq" TO "civitai-jobs";


--
-- Name: TABLE "ClubMetric"; Type: ACL; Schema: public; Owner: civitai
--

GRANT ALL ON TABLE public."ClubMetric" TO "civitai-read";
GRANT SELECT ON TABLE public."ClubMetric" TO hasura;
GRANT SELECT ON TABLE public."ClubMetric" TO retool;
GRANT ALL ON TABLE public."ClubMetric" TO "civitai-jobs";


--
-- Name: TABLE "ClubPost"; Type: ACL; Schema: public; Owner: civitai
--

GRANT ALL ON TABLE public."ClubPost" TO "civitai-read";
GRANT SELECT ON TABLE public."ClubPost" TO hasura;
GRANT SELECT ON TABLE public."ClubPost" TO retool;
GRANT ALL ON TABLE public."ClubPost" TO "civitai-jobs";


--
-- Name: TABLE "ClubPostMetric"; Type: ACL; Schema: public; Owner: civitai
--

GRANT ALL ON TABLE public."ClubPostMetric" TO "civitai-read";
GRANT SELECT ON TABLE public."ClubPostMetric" TO hasura;
GRANT SELECT ON TABLE public."ClubPostMetric" TO retool;
GRANT ALL ON TABLE public."ClubPostMetric" TO "civitai-jobs";


--
-- Name: TABLE "ClubPostReaction"; Type: ACL; Schema: public; Owner: civitai
--

GRANT ALL ON TABLE public."ClubPostReaction" TO "civitai-read";
GRANT SELECT ON TABLE public."ClubPostReaction" TO hasura;
GRANT SELECT ON TABLE public."ClubPostReaction" TO retool;
GRANT ALL ON TABLE public."ClubPostReaction" TO "civitai-jobs";


--
-- Name: SEQUENCE "ClubPostReaction_id_seq"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON SEQUENCE public."ClubPostReaction_id_seq" TO pghero;
GRANT SELECT,USAGE ON SEQUENCE public."ClubPostReaction_id_seq" TO "civitai-read";
GRANT ALL ON SEQUENCE public."ClubPostReaction_id_seq" TO retool;
GRANT ALL ON SEQUENCE public."ClubPostReaction_id_seq" TO "civitai-jobs";


--
-- Name: SEQUENCE "ClubPost_id_seq"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON SEQUENCE public."ClubPost_id_seq" TO pghero;
GRANT SELECT,USAGE ON SEQUENCE public."ClubPost_id_seq" TO "civitai-read";
GRANT ALL ON SEQUENCE public."ClubPost_id_seq" TO retool;
GRANT ALL ON SEQUENCE public."ClubPost_id_seq" TO "civitai-jobs";


--
-- Name: TABLE "ClubRank"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."ClubRank" TO "civitai-read";
GRANT SELECT ON TABLE public."ClubRank" TO hasura;
GRANT SELECT ON TABLE public."ClubRank" TO retool;
GRANT ALL ON TABLE public."ClubRank" TO "civitai-jobs";


--
-- Name: TABLE "ClubRank_Live"; Type: ACL; Schema: public; Owner: civitai
--

GRANT ALL ON TABLE public."ClubRank_Live" TO "civitai-read";
GRANT SELECT ON TABLE public."ClubRank_Live" TO hasura;
GRANT SELECT ON TABLE public."ClubRank_Live" TO retool;
GRANT ALL ON TABLE public."ClubRank_Live" TO "civitai-jobs";


--
-- Name: TABLE "ClubStat"; Type: ACL; Schema: public; Owner: civitai
--

GRANT ALL ON TABLE public."ClubStat" TO "civitai-read";
GRANT SELECT ON TABLE public."ClubStat" TO hasura;
GRANT SELECT ON TABLE public."ClubStat" TO retool;
GRANT ALL ON TABLE public."ClubStat" TO "civitai-jobs";


--
-- Name: TABLE "ClubTier"; Type: ACL; Schema: public; Owner: civitai
--

GRANT ALL ON TABLE public."ClubTier" TO "civitai-read";
GRANT SELECT ON TABLE public."ClubTier" TO hasura;
GRANT SELECT ON TABLE public."ClubTier" TO retool;
GRANT ALL ON TABLE public."ClubTier" TO "civitai-jobs";


--
-- Name: SEQUENCE "ClubTier_id_seq"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON SEQUENCE public."ClubTier_id_seq" TO pghero;
GRANT SELECT,USAGE ON SEQUENCE public."ClubTier_id_seq" TO "civitai-read";
GRANT ALL ON SEQUENCE public."ClubTier_id_seq" TO retool;
GRANT ALL ON SEQUENCE public."ClubTier_id_seq" TO "civitai-jobs";


--
-- Name: SEQUENCE "Club_id_seq"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON SEQUENCE public."Club_id_seq" TO pghero;
GRANT SELECT,USAGE ON SEQUENCE public."Club_id_seq" TO "civitai-read";
GRANT ALL ON SEQUENCE public."Club_id_seq" TO retool;
GRANT ALL ON SEQUENCE public."Club_id_seq" TO "civitai-jobs";


--
-- Name: TABLE "Collection"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."Collection" TO retool;
GRANT ALL ON TABLE public."Collection" TO "civitai-read";
GRANT SELECT ON TABLE public."Collection" TO hasura;
GRANT ALL ON TABLE public."Collection" TO "civitai-jobs";


--
-- Name: TABLE "CollectionContributor"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."CollectionContributor" TO retool;
GRANT ALL ON TABLE public."CollectionContributor" TO "civitai-read";
GRANT SELECT ON TABLE public."CollectionContributor" TO hasura;
GRANT ALL ON TABLE public."CollectionContributor" TO "civitai-jobs";


--
-- Name: TABLE "CollectionItem"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."CollectionItem" TO retool;
GRANT ALL ON TABLE public."CollectionItem" TO "civitai-read";
GRANT SELECT ON TABLE public."CollectionItem" TO hasura;
GRANT ALL ON TABLE public."CollectionItem" TO "civitai-jobs";


--
-- Name: TABLE "CollectionMetric"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."CollectionMetric" TO retool;
GRANT ALL ON TABLE public."CollectionMetric" TO "civitai-read";
GRANT SELECT ON TABLE public."CollectionMetric" TO hasura;
GRANT ALL ON TABLE public."CollectionMetric" TO "civitai-jobs";


--
-- Name: TABLE "CollectionRank"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."CollectionRank" TO "civitai-read";
GRANT SELECT ON TABLE public."CollectionRank" TO retool;
GRANT ALL ON TABLE public."CollectionRank" TO "civitai-jobs";


--
-- Name: TABLE "CollectionStat"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."CollectionStat" TO retool;
GRANT ALL ON TABLE public."CollectionStat" TO "civitai-read";
GRANT SELECT ON TABLE public."CollectionStat" TO hasura;
GRANT ALL ON TABLE public."CollectionStat" TO "civitai-jobs";


--
-- Name: TABLE "CollectionRank_Live"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."CollectionRank_Live" TO retool;
GRANT ALL ON TABLE public."CollectionRank_Live" TO "civitai-read";
GRANT SELECT ON TABLE public."CollectionRank_Live" TO hasura;
GRANT ALL ON TABLE public."CollectionRank_Live" TO "civitai-jobs";


--
-- Name: TABLE "CollectionReport"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."CollectionReport" TO retool;
GRANT ALL ON TABLE public."CollectionReport" TO "civitai-read";
GRANT SELECT ON TABLE public."CollectionReport" TO hasura;
GRANT ALL ON TABLE public."CollectionReport" TO "civitai-jobs";


--
-- Name: TABLE "Comment"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."Comment" TO retool;
GRANT ALL ON TABLE public."Comment" TO "civitai-read";
GRANT SELECT ON TABLE public."Comment" TO hasura;
GRANT ALL ON TABLE public."Comment" TO "civitai-jobs";


--
-- Name: TABLE "CommentReaction"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."CommentReaction" TO retool;
GRANT ALL ON TABLE public."CommentReaction" TO "civitai-read";
GRANT SELECT ON TABLE public."CommentReaction" TO hasura;
GRANT ALL ON TABLE public."CommentReaction" TO "civitai-jobs";


--
-- Name: SEQUENCE "CommentReaction_id_seq"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON SEQUENCE public."CommentReaction_id_seq" TO pghero;
GRANT SELECT,USAGE ON SEQUENCE public."CommentReaction_id_seq" TO "civitai-read";
GRANT ALL ON SEQUENCE public."CommentReaction_id_seq" TO retool;
GRANT ALL ON SEQUENCE public."CommentReaction_id_seq" TO "civitai-jobs";


--
-- Name: TABLE "CommentReport"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."CommentReport" TO retool;
GRANT ALL ON TABLE public."CommentReport" TO "civitai-read";
GRANT SELECT ON TABLE public."CommentReport" TO hasura;
GRANT ALL ON TABLE public."CommentReport" TO "civitai-jobs";


--
-- Name: TABLE "CommentV2"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."CommentV2" TO retool;
GRANT ALL ON TABLE public."CommentV2" TO "civitai-read";
GRANT SELECT ON TABLE public."CommentV2" TO hasura;
GRANT ALL ON TABLE public."CommentV2" TO "civitai-jobs";


--
-- Name: TABLE "CommentV2Reaction"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."CommentV2Reaction" TO retool;
GRANT ALL ON TABLE public."CommentV2Reaction" TO "civitai-read";
GRANT SELECT ON TABLE public."CommentV2Reaction" TO hasura;
GRANT ALL ON TABLE public."CommentV2Reaction" TO "civitai-jobs";


--
-- Name: SEQUENCE "CommentV2Reaction_id_seq"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON SEQUENCE public."CommentV2Reaction_id_seq" TO pghero;
GRANT SELECT,USAGE ON SEQUENCE public."CommentV2Reaction_id_seq" TO "civitai-read";
GRANT ALL ON SEQUENCE public."CommentV2Reaction_id_seq" TO retool;
GRANT ALL ON SEQUENCE public."CommentV2Reaction_id_seq" TO "civitai-jobs";


--
-- Name: TABLE "CommentV2Report"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."CommentV2Report" TO retool;
GRANT ALL ON TABLE public."CommentV2Report" TO "civitai-read";
GRANT SELECT ON TABLE public."CommentV2Report" TO hasura;
GRANT ALL ON TABLE public."CommentV2Report" TO "civitai-jobs";


--
-- Name: SEQUENCE "CommentV2_id_seq"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON SEQUENCE public."CommentV2_id_seq" TO pghero;
GRANT SELECT,USAGE ON SEQUENCE public."CommentV2_id_seq" TO "civitai-read";
GRANT ALL ON SEQUENCE public."CommentV2_id_seq" TO retool;
GRANT ALL ON SEQUENCE public."CommentV2_id_seq" TO "civitai-jobs";


--
-- Name: SEQUENCE "Comment_id_seq"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON SEQUENCE public."Comment_id_seq" TO pghero;
GRANT SELECT,USAGE ON SEQUENCE public."Comment_id_seq" TO "civitai-read";
GRANT ALL ON SEQUENCE public."Comment_id_seq" TO retool;
GRANT ALL ON SEQUENCE public."Comment_id_seq" TO "civitai-jobs";


--
-- Name: TABLE "Cosmetic"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."Cosmetic" TO retool;
GRANT ALL ON TABLE public."Cosmetic" TO "civitai-read";
GRANT SELECT ON TABLE public."Cosmetic" TO hasura;
GRANT ALL ON TABLE public."Cosmetic" TO "civitai-jobs";


--
-- Name: TABLE "CosmeticShopItem"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."CosmeticShopItem" TO "civitai-read";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."CosmeticShopItem" TO retool;
GRANT ALL ON TABLE public."CosmeticShopItem" TO "civitai-jobs";


--
-- Name: SEQUENCE "CosmeticShopItem_id_seq"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON SEQUENCE public."CosmeticShopItem_id_seq" TO pghero;
GRANT SELECT ON SEQUENCE public."CosmeticShopItem_id_seq" TO "civitai-read";
GRANT ALL ON SEQUENCE public."CosmeticShopItem_id_seq" TO retool;
GRANT ALL ON SEQUENCE public."CosmeticShopItem_id_seq" TO "civitai-jobs";


--
-- Name: TABLE "CosmeticShopSection"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."CosmeticShopSection" TO "civitai-read";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."CosmeticShopSection" TO retool;
GRANT ALL ON TABLE public."CosmeticShopSection" TO "civitai-jobs";


--
-- Name: TABLE "CosmeticShopSectionItem"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."CosmeticShopSectionItem" TO "civitai-read";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."CosmeticShopSectionItem" TO retool;
GRANT ALL ON TABLE public."CosmeticShopSectionItem" TO "civitai-jobs";


--
-- Name: SEQUENCE "CosmeticShopSection_id_seq"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON SEQUENCE public."CosmeticShopSection_id_seq" TO pghero;
GRANT SELECT ON SEQUENCE public."CosmeticShopSection_id_seq" TO "civitai-read";
GRANT ALL ON SEQUENCE public."CosmeticShopSection_id_seq" TO retool;
GRANT ALL ON SEQUENCE public."CosmeticShopSection_id_seq" TO "civitai-jobs";


--
-- Name: TABLE "CoveredCheckpoint"; Type: ACL; Schema: public; Owner: civitai
--

GRANT ALL ON TABLE public."CoveredCheckpoint" TO "civitai-read";
GRANT SELECT ON TABLE public."CoveredCheckpoint" TO hasura;
GRANT SELECT ON TABLE public."CoveredCheckpoint" TO retool;
GRANT ALL ON TABLE public."CoveredCheckpoint" TO "civitai-jobs";


--
-- Name: TABLE "Model"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT,UPDATE ON TABLE public."Model" TO retool;
GRANT ALL ON TABLE public."Model" TO "civitai-read";
GRANT SELECT ON TABLE public."Model" TO hasura;
GRANT ALL ON TABLE public."Model" TO "civitai-jobs";


--
-- Name: TABLE "ModelVersion"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT,UPDATE ON TABLE public."ModelVersion" TO retool;
GRANT ALL ON TABLE public."ModelVersion" TO "civitai-read";
GRANT SELECT ON TABLE public."ModelVersion" TO hasura;
GRANT ALL ON TABLE public."ModelVersion" TO "civitai-jobs";


--
-- Name: TABLE "CoveredCheckpointDetails"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."CoveredCheckpointDetails" TO "civitai-read";
GRANT SELECT ON TABLE public."CoveredCheckpointDetails" TO hasura;
GRANT SELECT ON TABLE public."CoveredCheckpointDetails" TO retool;
GRANT ALL ON TABLE public."CoveredCheckpointDetails" TO "civitai-jobs";


--
-- Name: TABLE "CsamReport"; Type: ACL; Schema: public; Owner: civitai
--

GRANT ALL ON TABLE public."CsamReport" TO "civitai-read";
GRANT SELECT ON TABLE public."CsamReport" TO hasura;
GRANT SELECT ON TABLE public."CsamReport" TO retool;
GRANT ALL ON TABLE public."CsamReport" TO "civitai-jobs";


--
-- Name: SEQUENCE "CsamReport_id_seq"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON SEQUENCE public."CsamReport_id_seq" TO pghero;
GRANT SELECT,USAGE ON SEQUENCE public."CsamReport_id_seq" TO "civitai-read";
GRANT ALL ON SEQUENCE public."CsamReport_id_seq" TO retool;
GRANT ALL ON SEQUENCE public."CsamReport_id_seq" TO "civitai-jobs";


--
-- Name: TABLE "CustomerSubscription"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."CustomerSubscription" TO retool;
GRANT ALL ON TABLE public."CustomerSubscription" TO "civitai-read";
GRANT SELECT ON TABLE public."CustomerSubscription" TO hasura;
GRANT ALL ON TABLE public."CustomerSubscription" TO "civitai-jobs";


--
-- Name: TABLE "Donation"; Type: ACL; Schema: public; Owner: doadmin
--

GRANT ALL ON TABLE public."Donation" TO civitai;
GRANT SELECT ON TABLE public."Donation" TO "civitai-read";
GRANT SELECT ON TABLE public."Donation" TO retool;
GRANT ALL ON TABLE public."Donation" TO "civitai-jobs";


--
-- Name: TABLE "DonationGoal"; Type: ACL; Schema: public; Owner: doadmin
--

GRANT ALL ON TABLE public."DonationGoal" TO civitai;
GRANT SELECT ON TABLE public."DonationGoal" TO "civitai-read";
GRANT SELECT ON TABLE public."DonationGoal" TO retool;
GRANT ALL ON TABLE public."DonationGoal" TO "civitai-jobs";


--
-- Name: SEQUENCE "DonationGoal_id_seq"; Type: ACL; Schema: public; Owner: doadmin
--

GRANT ALL ON SEQUENCE public."DonationGoal_id_seq" TO civitai;
GRANT SELECT ON SEQUENCE public."DonationGoal_id_seq" TO pghero;
GRANT SELECT,USAGE ON SEQUENCE public."DonationGoal_id_seq" TO "civitai-read";
GRANT ALL ON SEQUENCE public."DonationGoal_id_seq" TO retool;
GRANT ALL ON SEQUENCE public."DonationGoal_id_seq" TO "civitai-jobs";


--
-- Name: SEQUENCE "Donation_id_seq"; Type: ACL; Schema: public; Owner: doadmin
--

GRANT ALL ON SEQUENCE public."Donation_id_seq" TO civitai;
GRANT SELECT ON SEQUENCE public."Donation_id_seq" TO pghero;
GRANT SELECT,USAGE ON SEQUENCE public."Donation_id_seq" TO "civitai-read";
GRANT ALL ON SEQUENCE public."Donation_id_seq" TO retool;
GRANT ALL ON SEQUENCE public."Donation_id_seq" TO "civitai-jobs";


--
-- Name: TABLE "DownloadHistory"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."DownloadHistory" TO retool;
GRANT ALL ON TABLE public."DownloadHistory" TO "civitai-read";
GRANT SELECT ON TABLE public."DownloadHistory" TO hasura;
GRANT ALL ON TABLE public."DownloadHistory" TO "civitai-jobs";


--
-- Name: TABLE "EntityAccess"; Type: ACL; Schema: public; Owner: civitai
--

GRANT ALL ON TABLE public."EntityAccess" TO "civitai-read";
GRANT SELECT ON TABLE public."EntityAccess" TO hasura;
GRANT SELECT ON TABLE public."EntityAccess" TO retool;
GRANT ALL ON TABLE public."EntityAccess" TO "civitai-jobs";


--
-- Name: TABLE "EntityCollaborator"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."EntityCollaborator" TO "civitai-read";
GRANT SELECT ON TABLE public."EntityCollaborator" TO retool;
GRANT ALL ON TABLE public."EntityCollaborator" TO "civitai-jobs";


--
-- Name: TABLE "EntityMetric"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."EntityMetric" TO "civitai-read";
GRANT SELECT ON TABLE public."EntityMetric" TO retool;
GRANT ALL ON TABLE public."EntityMetric" TO "civitai-jobs";


--
-- Name: TABLE "EntityMetricImage"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."EntityMetricImage" TO "civitai-read";
GRANT SELECT ON TABLE public."EntityMetricImage" TO retool;
GRANT ALL ON TABLE public."EntityMetricImage" TO "civitai-jobs";


--
-- Name: TABLE "File"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."File" TO retool;
GRANT ALL ON TABLE public."File" TO "civitai-read";
GRANT SELECT ON TABLE public."File" TO hasura;
GRANT ALL ON TABLE public."File" TO "civitai-jobs";


--
-- Name: SEQUENCE "File_id_seq"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON SEQUENCE public."File_id_seq" TO pghero;
GRANT SELECT,USAGE ON SEQUENCE public."File_id_seq" TO "civitai-read";
GRANT ALL ON SEQUENCE public."File_id_seq" TO retool;
GRANT ALL ON SEQUENCE public."File_id_seq" TO "civitai-jobs";


--
-- Name: TABLE "ModelFile"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."ModelFile" TO retool;
GRANT ALL ON TABLE public."ModelFile" TO "civitai-read";
GRANT SELECT ON TABLE public."ModelFile" TO hasura;
GRANT ALL ON TABLE public."ModelFile" TO "civitai-jobs";


--
-- Name: TABLE "GenerationCoverage"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."GenerationCoverage" TO "civitai-read";
GRANT SELECT ON TABLE public."GenerationCoverage" TO hasura;
GRANT SELECT ON TABLE public."GenerationCoverage" TO retool;
GRANT ALL ON TABLE public."GenerationCoverage" TO "civitai-jobs";


--
-- Name: TABLE "GenerationServiceProvider"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."GenerationServiceProvider" TO retool;
GRANT ALL ON TABLE public."GenerationServiceProvider" TO "civitai-read";
GRANT SELECT ON TABLE public."GenerationServiceProvider" TO hasura;
GRANT ALL ON TABLE public."GenerationServiceProvider" TO "civitai-jobs";


--
-- Name: TABLE "HomeBlock"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."HomeBlock" TO retool;
GRANT ALL ON TABLE public."HomeBlock" TO "civitai-read";
GRANT SELECT ON TABLE public."HomeBlock" TO hasura;
GRANT ALL ON TABLE public."HomeBlock" TO "civitai-jobs";


--
-- Name: TABLE "Image"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT,UPDATE ON TABLE public."Image" TO retool;
GRANT ALL ON TABLE public."Image" TO "civitai-read";
GRANT SELECT ON TABLE public."Image" TO hasura;
GRANT SELECT ON TABLE public."Image" TO mleng;
GRANT ALL ON TABLE public."Image" TO "civitai-jobs";


--
-- Name: TABLE "ImageConnection"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."ImageConnection" TO retool;
GRANT ALL ON TABLE public."ImageConnection" TO "civitai-read";
GRANT SELECT ON TABLE public."ImageConnection" TO hasura;
GRANT ALL ON TABLE public."ImageConnection" TO "civitai-jobs";


--
-- Name: TABLE "ImageEngagement"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."ImageEngagement" TO retool;
GRANT ALL ON TABLE public."ImageEngagement" TO "civitai-read";
GRANT SELECT ON TABLE public."ImageEngagement" TO hasura;
GRANT ALL ON TABLE public."ImageEngagement" TO "civitai-jobs";


--
-- Name: TABLE "ImageFlag"; Type: ACL; Schema: public; Owner: doadmin
--

GRANT ALL ON TABLE public."ImageFlag" TO civitai;
GRANT SELECT ON TABLE public."ImageFlag" TO "civitai-read";
GRANT SELECT ON TABLE public."ImageFlag" TO retool;
GRANT ALL ON TABLE public."ImageFlag" TO "civitai-jobs";


--
-- Name: TABLE "ImageMetric"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."ImageMetric" TO retool;
GRANT ALL ON TABLE public."ImageMetric" TO "civitai-read";
GRANT SELECT ON TABLE public."ImageMetric" TO hasura;
GRANT ALL ON TABLE public."ImageMetric" TO "civitai-jobs";


--
-- Name: TABLE "ImageReport"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."ImageReport" TO retool;
GRANT ALL ON TABLE public."ImageReport" TO "civitai-read";
GRANT SELECT ON TABLE public."ImageReport" TO hasura;
GRANT ALL ON TABLE public."ImageReport" TO "civitai-jobs";


--
-- Name: TABLE "Report"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT,UPDATE ON TABLE public."Report" TO retool;
GRANT ALL ON TABLE public."Report" TO "civitai-read";
GRANT SELECT ON TABLE public."Report" TO hasura;
GRANT ALL ON TABLE public."Report" TO "civitai-jobs";


--
-- Name: TABLE "ImageModHelper"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."ImageModHelper" TO retool;
GRANT ALL ON TABLE public."ImageModHelper" TO "civitai-read";
GRANT SELECT ON TABLE public."ImageModHelper" TO hasura;
GRANT ALL ON TABLE public."ImageModHelper" TO "civitai-jobs";


--
-- Name: TABLE "ImageRank"; Type: ACL; Schema: public; Owner: civitai
--

GRANT ALL ON TABLE public."ImageRank" TO "civitai-read";
GRANT SELECT ON TABLE public."ImageRank" TO hasura;
GRANT SELECT ON TABLE public."ImageRank" TO retool;
GRANT ALL ON TABLE public."ImageRank" TO "civitai-jobs";


--
-- Name: TABLE "ImageRank_Live"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."ImageRank_Live" TO retool;
GRANT ALL ON TABLE public."ImageRank_Live" TO "civitai-read";
GRANT SELECT ON TABLE public."ImageRank_Live" TO hasura;
GRANT ALL ON TABLE public."ImageRank_Live" TO "civitai-jobs";


--
-- Name: TABLE "ImageRatingRequest"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."ImageRatingRequest" TO "civitai-read";
GRANT SELECT ON TABLE public."ImageRatingRequest" TO hasura;
GRANT SELECT,DELETE,UPDATE ON TABLE public."ImageRatingRequest" TO retool;
GRANT ALL ON TABLE public."ImageRatingRequest" TO "civitai-jobs";


--
-- Name: TABLE "ImageReaction"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT,DELETE,UPDATE ON TABLE public."ImageReaction" TO retool;
GRANT ALL ON TABLE public."ImageReaction" TO "civitai-read";
GRANT SELECT ON TABLE public."ImageReaction" TO hasura;
GRANT ALL ON TABLE public."ImageReaction" TO "civitai-jobs";


--
-- Name: SEQUENCE "ImageReaction_id_seq"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON SEQUENCE public."ImageReaction_id_seq" TO pghero;
GRANT SELECT,USAGE ON SEQUENCE public."ImageReaction_id_seq" TO "civitai-read";
GRANT ALL ON SEQUENCE public."ImageReaction_id_seq" TO retool;
GRANT ALL ON SEQUENCE public."ImageReaction_id_seq" TO "civitai-jobs";


--
-- Name: TABLE "ImageResource"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."ImageResource" TO retool;
GRANT ALL ON TABLE public."ImageResource" TO "civitai-read";
GRANT SELECT ON TABLE public."ImageResource" TO hasura;
GRANT ALL ON TABLE public."ImageResource" TO "civitai-jobs";


--
-- Name: TABLE "ModelVersionMetric"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."ModelVersionMetric" TO retool;
GRANT ALL ON TABLE public."ModelVersionMetric" TO "civitai-read";
GRANT SELECT ON TABLE public."ModelVersionMetric" TO hasura;
GRANT ALL ON TABLE public."ModelVersionMetric" TO "civitai-jobs";


--
-- Name: TABLE "ResourceReview"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT,UPDATE ON TABLE public."ResourceReview" TO retool;
GRANT ALL ON TABLE public."ResourceReview" TO "civitai-read";
GRANT SELECT ON TABLE public."ResourceReview" TO hasura;
GRANT ALL ON TABLE public."ResourceReview" TO "civitai-jobs";


--
-- Name: TABLE "ImageResourceHelper"; Type: ACL; Schema: public; Owner: doadmin
--

GRANT ALL ON TABLE public."ImageResourceHelper" TO civitai;
GRANT ALL ON TABLE public."ImageResourceHelper" TO "civitai-read";
GRANT SELECT ON TABLE public."ImageResourceHelper" TO hasura;
GRANT SELECT ON TABLE public."ImageResourceHelper" TO retool;
GRANT ALL ON TABLE public."ImageResourceHelper" TO "civitai-jobs";


--
-- Name: SEQUENCE "ImageResource_id_seq"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON SEQUENCE public."ImageResource_id_seq" TO pghero;
GRANT SELECT,USAGE ON SEQUENCE public."ImageResource_id_seq" TO "civitai-read";
GRANT ALL ON SEQUENCE public."ImageResource_id_seq" TO retool;
GRANT ALL ON SEQUENCE public."ImageResource_id_seq" TO "civitai-jobs";


--
-- Name: TABLE "ImageStat"; Type: ACL; Schema: public; Owner: civitai
--

GRANT ALL ON TABLE public."ImageStat" TO "civitai-read";
GRANT SELECT ON TABLE public."ImageStat" TO hasura;
GRANT SELECT ON TABLE public."ImageStat" TO retool;
GRANT ALL ON TABLE public."ImageStat" TO "civitai-jobs";


--
-- Name: TABLE "Tag"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT,UPDATE ON TABLE public."Tag" TO retool;
GRANT ALL ON TABLE public."Tag" TO "civitai-read";
GRANT SELECT ON TABLE public."Tag" TO hasura;
GRANT SELECT ON TABLE public."Tag" TO mleng;
GRANT ALL ON TABLE public."Tag" TO "civitai-jobs";


--
-- Name: TABLE "TagsOnImage"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."TagsOnImage" TO retool;
GRANT ALL ON TABLE public."TagsOnImage" TO "civitai-read";
GRANT SELECT ON TABLE public."TagsOnImage" TO hasura;
GRANT SELECT ON TABLE public."TagsOnImage" TO mleng;
GRANT ALL ON TABLE public."TagsOnImage" TO "civitai-jobs";


--
-- Name: TABLE "TagsOnImageVote"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."TagsOnImageVote" TO retool;
GRANT ALL ON TABLE public."TagsOnImageVote" TO "civitai-read";
GRANT SELECT ON TABLE public."TagsOnImageVote" TO hasura;
GRANT ALL ON TABLE public."TagsOnImageVote" TO "civitai-jobs";


--
-- Name: TABLE "ImageTag"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."ImageTag" TO "civitai-read";
GRANT SELECT ON TABLE public."ImageTag" TO hasura;
GRANT SELECT ON TABLE public."ImageTag" TO retool;
GRANT ALL ON TABLE public."ImageTag" TO "civitai-jobs";


--
-- Name: TABLE "ImageTechnique"; Type: ACL; Schema: public; Owner: doadmin
--

GRANT ALL ON TABLE public."ImageTechnique" TO civitai;
GRANT SELECT ON TABLE public."ImageTechnique" TO "civitai-read";
GRANT SELECT ON TABLE public."ImageTechnique" TO retool;
GRANT ALL ON TABLE public."ImageTechnique" TO "civitai-jobs";


--
-- Name: TABLE "ImageTool"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."ImageTool" TO "civitai-read";
GRANT SELECT ON TABLE public."ImageTool" TO retool;
GRANT ALL ON TABLE public."ImageTool" TO "civitai-jobs";


--
-- Name: SEQUENCE "Image_id_seq"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON SEQUENCE public."Image_id_seq" TO pghero;
GRANT SELECT,USAGE ON SEQUENCE public."Image_id_seq" TO "civitai-read";
GRANT ALL ON SEQUENCE public."Image_id_seq" TO retool;
GRANT ALL ON SEQUENCE public."Image_id_seq" TO "civitai-jobs";


--
-- Name: TABLE "ImagesOnModels"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."ImagesOnModels" TO retool;
GRANT ALL ON TABLE public."ImagesOnModels" TO "civitai-read";
GRANT SELECT ON TABLE public."ImagesOnModels" TO hasura;
GRANT ALL ON TABLE public."ImagesOnModels" TO "civitai-jobs";


--
-- Name: TABLE "Import"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."Import" TO retool;
GRANT ALL ON TABLE public."Import" TO "civitai-read";
GRANT SELECT ON TABLE public."Import" TO hasura;
GRANT ALL ON TABLE public."Import" TO "civitai-jobs";


--
-- Name: SEQUENCE "Import_id_seq"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON SEQUENCE public."Import_id_seq" TO pghero;
GRANT SELECT,USAGE ON SEQUENCE public."Import_id_seq" TO "civitai-read";
GRANT ALL ON SEQUENCE public."Import_id_seq" TO retool;
GRANT ALL ON SEQUENCE public."Import_id_seq" TO "civitai-jobs";


--
-- Name: TABLE "JobQueue"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."JobQueue" TO "civitai-read";
GRANT SELECT ON TABLE public."JobQueue" TO hasura;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."JobQueue" TO retool;
GRANT ALL ON TABLE public."JobQueue" TO "civitai-jobs";


--
-- Name: TABLE "KeyValue"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."KeyValue" TO retool;
GRANT ALL ON TABLE public."KeyValue" TO "civitai-read";
GRANT SELECT ON TABLE public."KeyValue" TO hasura;
GRANT ALL ON TABLE public."KeyValue" TO "civitai-jobs";


--
-- Name: TABLE "Leaderboard"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."Leaderboard" TO retool;
GRANT ALL ON TABLE public."Leaderboard" TO "civitai-read";
GRANT SELECT ON TABLE public."Leaderboard" TO hasura;
GRANT ALL ON TABLE public."Leaderboard" TO "civitai-jobs";


--
-- Name: TABLE "LeaderboardResult"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."LeaderboardResult" TO retool;
GRANT ALL ON TABLE public."LeaderboardResult" TO "civitai-read";
GRANT SELECT ON TABLE public."LeaderboardResult" TO hasura;
GRANT ALL ON TABLE public."LeaderboardResult" TO "civitai-jobs";


--
-- Name: TABLE "LegendsBoardResult"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."LegendsBoardResult" TO "civitai-read";


--
-- Name: TABLE "License"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."License" TO retool;
GRANT ALL ON TABLE public."License" TO "civitai-read";
GRANT SELECT ON TABLE public."License" TO hasura;
GRANT ALL ON TABLE public."License" TO "civitai-jobs";


--
-- Name: SEQUENCE "License_id_seq"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON SEQUENCE public."License_id_seq" TO pghero;
GRANT SELECT,USAGE ON SEQUENCE public."License_id_seq" TO "civitai-read";
GRANT ALL ON SEQUENCE public."License_id_seq" TO retool;
GRANT ALL ON SEQUENCE public."License_id_seq" TO "civitai-jobs";


--
-- Name: TABLE "Link"; Type: ACL; Schema: public; Owner: civitai
--

GRANT ALL ON TABLE public."Link" TO "civitai-read";
GRANT SELECT ON TABLE public."Link" TO hasura;
GRANT SELECT ON TABLE public."Link" TO retool;
GRANT ALL ON TABLE public."Link" TO "civitai-jobs";


--
-- Name: SEQUENCE "Link_id_seq"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON SEQUENCE public."Link_id_seq" TO pghero;
GRANT SELECT,USAGE ON SEQUENCE public."Link_id_seq" TO "civitai-read";
GRANT ALL ON SEQUENCE public."Link_id_seq" TO retool;
GRANT ALL ON SEQUENCE public."Link_id_seq" TO "civitai-jobs";


--
-- Name: TABLE "Log"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."Log" TO retool;
GRANT ALL ON TABLE public."Log" TO "civitai-read";
GRANT SELECT ON TABLE public."Log" TO hasura;
GRANT ALL ON TABLE public."Log" TO "civitai-jobs";


--
-- Name: TABLE "MetricUpdateQueue"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."MetricUpdateQueue" TO retool;
GRANT ALL ON TABLE public."MetricUpdateQueue" TO "civitai-read";
GRANT SELECT ON TABLE public."MetricUpdateQueue" TO hasura;
GRANT ALL ON TABLE public."MetricUpdateQueue" TO "civitai-jobs";


--
-- Name: TABLE "ModActivity"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."ModActivity" TO retool;
GRANT ALL ON TABLE public."ModActivity" TO "civitai-read";
GRANT SELECT ON TABLE public."ModActivity" TO hasura;
GRANT ALL ON TABLE public."ModActivity" TO "civitai-jobs";


--
-- Name: SEQUENCE "ModActivity_id_seq"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON SEQUENCE public."ModActivity_id_seq" TO pghero;
GRANT SELECT,USAGE ON SEQUENCE public."ModActivity_id_seq" TO "civitai-read";
GRANT ALL ON SEQUENCE public."ModActivity_id_seq" TO retool;
GRANT ALL ON SEQUENCE public."ModActivity_id_seq" TO "civitai-jobs";


--
-- Name: TABLE "ModelAssociations"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."ModelAssociations" TO retool;
GRANT ALL ON TABLE public."ModelAssociations" TO "civitai-read";
GRANT SELECT ON TABLE public."ModelAssociations" TO hasura;
GRANT ALL ON TABLE public."ModelAssociations" TO "civitai-jobs";


--
-- Name: SEQUENCE "ModelAssociations_id_seq"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON SEQUENCE public."ModelAssociations_id_seq" TO pghero;
GRANT SELECT,USAGE ON SEQUENCE public."ModelAssociations_id_seq" TO "civitai-read";
GRANT ALL ON SEQUENCE public."ModelAssociations_id_seq" TO retool;
GRANT ALL ON SEQUENCE public."ModelAssociations_id_seq" TO "civitai-jobs";


--
-- Name: TABLE "ModelEngagement"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."ModelEngagement" TO retool;
GRANT ALL ON TABLE public."ModelEngagement" TO "civitai-read";
GRANT SELECT ON TABLE public."ModelEngagement" TO hasura;
GRANT ALL ON TABLE public."ModelEngagement" TO "civitai-jobs";


--
-- Name: TABLE "ModelFileHash"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."ModelFileHash" TO retool;
GRANT ALL ON TABLE public."ModelFileHash" TO "civitai-read";
GRANT SELECT ON TABLE public."ModelFileHash" TO hasura;
GRANT ALL ON TABLE public."ModelFileHash" TO "civitai-jobs";


--
-- Name: SEQUENCE "ModelFile_id_seq"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON SEQUENCE public."ModelFile_id_seq" TO pghero;
GRANT SELECT,USAGE ON SEQUENCE public."ModelFile_id_seq" TO "civitai-read";
GRANT ALL ON SEQUENCE public."ModelFile_id_seq" TO retool;
GRANT ALL ON SEQUENCE public."ModelFile_id_seq" TO "civitai-jobs";


--
-- Name: TABLE "ModelFlag"; Type: ACL; Schema: public; Owner: doadmin
--

GRANT ALL ON TABLE public."ModelFlag" TO civitai;
GRANT SELECT ON TABLE public."ModelFlag" TO "civitai-read";
GRANT SELECT ON TABLE public."ModelFlag" TO retool;
GRANT ALL ON TABLE public."ModelFlag" TO "civitai-jobs";


--
-- Name: TABLE "ModelHash"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."ModelHash" TO retool;
GRANT ALL ON TABLE public."ModelHash" TO "civitai-read";
GRANT SELECT ON TABLE public."ModelHash" TO hasura;
GRANT ALL ON TABLE public."ModelHash" TO "civitai-jobs";


--
-- Name: TABLE "ModelInterest"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."ModelInterest" TO retool;
GRANT ALL ON TABLE public."ModelInterest" TO "civitai-read";
GRANT SELECT ON TABLE public."ModelInterest" TO hasura;
GRANT ALL ON TABLE public."ModelInterest" TO "civitai-jobs";


--
-- Name: TABLE "ModelMetric"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."ModelMetric" TO retool;
GRANT ALL ON TABLE public."ModelMetric" TO "civitai-read";
GRANT SELECT ON TABLE public."ModelMetric" TO hasura;
GRANT ALL ON TABLE public."ModelMetric" TO "civitai-jobs";


--
-- Name: TABLE "ModelMetricDaily"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."ModelMetricDaily" TO retool;
GRANT ALL ON TABLE public."ModelMetricDaily" TO "civitai-read";
GRANT SELECT ON TABLE public."ModelMetricDaily" TO hasura;
GRANT ALL ON TABLE public."ModelMetricDaily" TO "civitai-jobs";


--
-- Name: TABLE "ModelRank_Live"; Type: ACL; Schema: public; Owner: civitai
--

GRANT ALL ON TABLE public."ModelRank_Live" TO "civitai-read";
GRANT SELECT ON TABLE public."ModelRank_Live" TO hasura;
GRANT SELECT ON TABLE public."ModelRank_Live" TO retool;
GRANT ALL ON TABLE public."ModelRank_Live" TO "civitai-jobs";


--
-- Name: TABLE "ModelRank_New"; Type: ACL; Schema: public; Owner: civitai
--

GRANT ALL ON TABLE public."ModelRank_New" TO "civitai-read";
GRANT SELECT ON TABLE public."ModelRank_New" TO hasura;
GRANT SELECT ON TABLE public."ModelRank_New" TO retool;
GRANT ALL ON TABLE public."ModelRank_New" TO "civitai-jobs";


--
-- Name: TABLE "ModelReport"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."ModelReport" TO retool;
GRANT ALL ON TABLE public."ModelReport" TO "civitai-read";
GRANT SELECT ON TABLE public."ModelReport" TO hasura;
GRANT ALL ON TABLE public."ModelReport" TO "civitai-jobs";


--
-- Name: TABLE "ModelReportStat"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."ModelReportStat" TO retool;
GRANT ALL ON TABLE public."ModelReportStat" TO "civitai-read";
GRANT SELECT ON TABLE public."ModelReportStat" TO hasura;
GRANT ALL ON TABLE public."ModelReportStat" TO "civitai-jobs";


--
-- Name: TABLE "TagsOnModels"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."TagsOnModels" TO retool;
GRANT ALL ON TABLE public."TagsOnModels" TO "civitai-read";
GRANT SELECT ON TABLE public."TagsOnModels" TO hasura;
GRANT ALL ON TABLE public."TagsOnModels" TO "civitai-jobs";


--
-- Name: TABLE "TagsOnModelsVote"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."TagsOnModelsVote" TO retool;
GRANT ALL ON TABLE public."TagsOnModelsVote" TO "civitai-read";
GRANT SELECT ON TABLE public."TagsOnModelsVote" TO hasura;
GRANT ALL ON TABLE public."TagsOnModelsVote" TO "civitai-jobs";


--
-- Name: TABLE "ModelTag"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."ModelTag" TO retool;
GRANT ALL ON TABLE public."ModelTag" TO "civitai-read";
GRANT SELECT ON TABLE public."ModelTag" TO hasura;
GRANT ALL ON TABLE public."ModelTag" TO "civitai-jobs";


--
-- Name: TABLE "ModelVersionEngagement"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."ModelVersionEngagement" TO retool;
GRANT ALL ON TABLE public."ModelVersionEngagement" TO "civitai-read";
GRANT SELECT ON TABLE public."ModelVersionEngagement" TO hasura;
GRANT ALL ON TABLE public."ModelVersionEngagement" TO "civitai-jobs";


--
-- Name: TABLE "ModelVersionExploration"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."ModelVersionExploration" TO retool;
GRANT ALL ON TABLE public."ModelVersionExploration" TO "civitai-read";
GRANT SELECT ON TABLE public."ModelVersionExploration" TO hasura;
GRANT ALL ON TABLE public."ModelVersionExploration" TO "civitai-jobs";


--
-- Name: TABLE "ModelVersionMonetization"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."ModelVersionMonetization" TO retool;
GRANT ALL ON TABLE public."ModelVersionMonetization" TO "civitai-read";
GRANT SELECT ON TABLE public."ModelVersionMonetization" TO hasura;
GRANT ALL ON TABLE public."ModelVersionMonetization" TO "civitai-jobs";


--
-- Name: SEQUENCE "ModelVersionMonetization_id_seq"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON SEQUENCE public."ModelVersionMonetization_id_seq" TO pghero;
GRANT SELECT,USAGE ON SEQUENCE public."ModelVersionMonetization_id_seq" TO "civitai-read";
GRANT ALL ON SEQUENCE public."ModelVersionMonetization_id_seq" TO retool;
GRANT ALL ON SEQUENCE public."ModelVersionMonetization_id_seq" TO "civitai-jobs";


--
-- Name: TABLE "ModelVersionRank"; Type: ACL; Schema: public; Owner: civitai
--

GRANT ALL ON TABLE public."ModelVersionRank" TO "civitai-read";
GRANT SELECT ON TABLE public."ModelVersionRank" TO hasura;
GRANT SELECT ON TABLE public."ModelVersionRank" TO retool;
GRANT ALL ON TABLE public."ModelVersionRank" TO "civitai-jobs";


--
-- Name: TABLE "ModelVersionRank_Live"; Type: ACL; Schema: public; Owner: civitai
--

GRANT ALL ON TABLE public."ModelVersionRank_Live" TO "civitai-read";
GRANT SELECT ON TABLE public."ModelVersionRank_Live" TO hasura;
GRANT SELECT ON TABLE public."ModelVersionRank_Live" TO retool;
GRANT ALL ON TABLE public."ModelVersionRank_Live" TO "civitai-jobs";


--
-- Name: TABLE "ModelVersionSponsorshipSettings"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."ModelVersionSponsorshipSettings" TO retool;
GRANT ALL ON TABLE public."ModelVersionSponsorshipSettings" TO "civitai-read";
GRANT SELECT ON TABLE public."ModelVersionSponsorshipSettings" TO hasura;
GRANT ALL ON TABLE public."ModelVersionSponsorshipSettings" TO "civitai-jobs";


--
-- Name: SEQUENCE "ModelVersionSponsorshipSettings_id_seq"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON SEQUENCE public."ModelVersionSponsorshipSettings_id_seq" TO pghero;
GRANT SELECT,USAGE ON SEQUENCE public."ModelVersionSponsorshipSettings_id_seq" TO "civitai-read";
GRANT ALL ON SEQUENCE public."ModelVersionSponsorshipSettings_id_seq" TO retool;
GRANT ALL ON SEQUENCE public."ModelVersionSponsorshipSettings_id_seq" TO "civitai-jobs";


--
-- Name: SEQUENCE "ModelVersion_id_seq"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON SEQUENCE public."ModelVersion_id_seq" TO pghero;
GRANT SELECT,USAGE ON SEQUENCE public."ModelVersion_id_seq" TO "civitai-read";
GRANT ALL ON SEQUENCE public."ModelVersion_id_seq" TO retool;
GRANT ALL ON SEQUENCE public."ModelVersion_id_seq" TO "civitai-jobs";


--
-- Name: SEQUENCE "Model_id_seq"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON SEQUENCE public."Model_id_seq" TO pghero;
GRANT SELECT,USAGE ON SEQUENCE public."Model_id_seq" TO "civitai-read";
GRANT ALL ON SEQUENCE public."Model_id_seq" TO retool;
GRANT ALL ON SEQUENCE public."Model_id_seq" TO "civitai-jobs";


--
-- Name: TABLE "OauthClient"; Type: ACL; Schema: public; Owner: doadmin
--

GRANT ALL ON TABLE public."OauthClient" TO civitai;
GRANT SELECT ON TABLE public."OauthClient" TO "civitai-read";
GRANT SELECT ON TABLE public."OauthClient" TO retool;
GRANT ALL ON TABLE public."OauthClient" TO "civitai-jobs";


--
-- Name: TABLE "OauthToken"; Type: ACL; Schema: public; Owner: doadmin
--

GRANT ALL ON TABLE public."OauthToken" TO civitai;
GRANT SELECT ON TABLE public."OauthToken" TO "civitai-read";
GRANT SELECT ON TABLE public."OauthToken" TO retool;
GRANT ALL ON TABLE public."OauthToken" TO "civitai-jobs";


--
-- Name: TABLE "Partner"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."Partner" TO retool;
GRANT ALL ON TABLE public."Partner" TO "civitai-read";
GRANT SELECT ON TABLE public."Partner" TO hasura;
GRANT ALL ON TABLE public."Partner" TO "civitai-jobs";


--
-- Name: TABLE "OnDemandRunStrategy"; Type: ACL; Schema: public; Owner: doadmin
--

GRANT ALL ON TABLE public."OnDemandRunStrategy" TO civitai;
GRANT ALL ON TABLE public."OnDemandRunStrategy" TO "civitai-read";
GRANT SELECT ON TABLE public."OnDemandRunStrategy" TO hasura;
GRANT SELECT ON TABLE public."OnDemandRunStrategy" TO retool;
GRANT ALL ON TABLE public."OnDemandRunStrategy" TO "civitai-jobs";


--
-- Name: SEQUENCE "Partner_id_seq"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON SEQUENCE public."Partner_id_seq" TO pghero;
GRANT SELECT,USAGE ON SEQUENCE public."Partner_id_seq" TO "civitai-read";
GRANT ALL ON SEQUENCE public."Partner_id_seq" TO retool;
GRANT ALL ON SEQUENCE public."Partner_id_seq" TO "civitai-jobs";


--
-- Name: TABLE "Post"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT,UPDATE ON TABLE public."Post" TO retool;
GRANT ALL ON TABLE public."Post" TO "civitai-read";
GRANT SELECT ON TABLE public."Post" TO hasura;
GRANT ALL ON TABLE public."Post" TO "civitai-jobs";


--
-- Name: TABLE "PostHelper"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."PostHelper" TO retool;
GRANT ALL ON TABLE public."PostHelper" TO "civitai-read";
GRANT SELECT ON TABLE public."PostHelper" TO hasura;
GRANT ALL ON TABLE public."PostHelper" TO "civitai-jobs";


--
-- Name: TABLE "PostImageTag"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."PostImageTag" TO retool;
GRANT ALL ON TABLE public."PostImageTag" TO "civitai-read";
GRANT SELECT ON TABLE public."PostImageTag" TO hasura;
GRANT ALL ON TABLE public."PostImageTag" TO "civitai-jobs";


--
-- Name: TABLE "PostMetric"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."PostMetric" TO retool;
GRANT ALL ON TABLE public."PostMetric" TO "civitai-read";
GRANT SELECT ON TABLE public."PostMetric" TO hasura;
GRANT ALL ON TABLE public."PostMetric" TO "civitai-jobs";


--
-- Name: TABLE "PostRank"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."PostRank" TO "civitai-read";
GRANT SELECT ON TABLE public."PostRank" TO retool;
GRANT ALL ON TABLE public."PostRank" TO "civitai-jobs";


--
-- Name: TABLE "PostRank_Live"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."PostRank_Live" TO retool;
GRANT ALL ON TABLE public."PostRank_Live" TO "civitai-read";
GRANT SELECT ON TABLE public."PostRank_Live" TO hasura;
GRANT ALL ON TABLE public."PostRank_Live" TO "civitai-jobs";


--
-- Name: TABLE "PostReaction"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."PostReaction" TO retool;
GRANT ALL ON TABLE public."PostReaction" TO "civitai-read";
GRANT SELECT ON TABLE public."PostReaction" TO hasura;
GRANT ALL ON TABLE public."PostReaction" TO "civitai-jobs";


--
-- Name: SEQUENCE "PostReaction_id_seq"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON SEQUENCE public."PostReaction_id_seq" TO pghero;
GRANT SELECT,USAGE ON SEQUENCE public."PostReaction_id_seq" TO "civitai-read";
GRANT ALL ON SEQUENCE public."PostReaction_id_seq" TO retool;
GRANT ALL ON SEQUENCE public."PostReaction_id_seq" TO "civitai-jobs";


--
-- Name: TABLE "PostReport"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."PostReport" TO retool;
GRANT ALL ON TABLE public."PostReport" TO "civitai-read";
GRANT SELECT ON TABLE public."PostReport" TO hasura;
GRANT ALL ON TABLE public."PostReport" TO "civitai-jobs";


--
-- Name: TABLE "PostResourceHelper"; Type: ACL; Schema: public; Owner: doadmin
--

GRANT ALL ON TABLE public."PostResourceHelper" TO civitai;
GRANT ALL ON TABLE public."PostResourceHelper" TO "civitai-read";
GRANT SELECT ON TABLE public."PostResourceHelper" TO hasura;
GRANT SELECT ON TABLE public."PostResourceHelper" TO retool;
GRANT ALL ON TABLE public."PostResourceHelper" TO "civitai-jobs";


--
-- Name: TABLE "PostStat"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."PostStat" TO retool;
GRANT ALL ON TABLE public."PostStat" TO "civitai-read";
GRANT SELECT ON TABLE public."PostStat" TO hasura;
GRANT ALL ON TABLE public."PostStat" TO "civitai-jobs";


--
-- Name: TABLE "TagsOnPost"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."TagsOnPost" TO retool;
GRANT ALL ON TABLE public."TagsOnPost" TO "civitai-read";
GRANT SELECT ON TABLE public."TagsOnPost" TO hasura;
GRANT ALL ON TABLE public."TagsOnPost" TO "civitai-jobs";


--
-- Name: TABLE "TagsOnPostVote"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."TagsOnPostVote" TO retool;
GRANT ALL ON TABLE public."TagsOnPostVote" TO "civitai-read";
GRANT SELECT ON TABLE public."TagsOnPostVote" TO hasura;
GRANT ALL ON TABLE public."TagsOnPostVote" TO "civitai-jobs";


--
-- Name: TABLE "PostTag"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."PostTag" TO retool;
GRANT ALL ON TABLE public."PostTag" TO "civitai-read";
GRANT SELECT ON TABLE public."PostTag" TO hasura;
GRANT ALL ON TABLE public."PostTag" TO "civitai-jobs";


--
-- Name: SEQUENCE "Post_id_seq"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON SEQUENCE public."Post_id_seq" TO pghero;
GRANT SELECT,USAGE ON SEQUENCE public."Post_id_seq" TO "civitai-read";
GRANT ALL ON SEQUENCE public."Post_id_seq" TO retool;
GRANT ALL ON SEQUENCE public."Post_id_seq" TO "civitai-jobs";


--
-- Name: TABLE "PressMention"; Type: ACL; Schema: public; Owner: civitai
--

GRANT ALL ON TABLE public."PressMention" TO "civitai-read";
GRANT SELECT ON TABLE public."PressMention" TO hasura;
GRANT SELECT ON TABLE public."PressMention" TO retool;
GRANT ALL ON TABLE public."PressMention" TO "civitai-jobs";


--
-- Name: SEQUENCE "PressMention_id_seq"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON SEQUENCE public."PressMention_id_seq" TO pghero;
GRANT SELECT,USAGE ON SEQUENCE public."PressMention_id_seq" TO "civitai-read";
GRANT ALL ON SEQUENCE public."PressMention_id_seq" TO retool;
GRANT ALL ON SEQUENCE public."PressMention_id_seq" TO "civitai-jobs";


--
-- Name: TABLE "Price"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."Price" TO retool;
GRANT ALL ON TABLE public."Price" TO "civitai-read";
GRANT SELECT ON TABLE public."Price" TO hasura;
GRANT ALL ON TABLE public."Price" TO "civitai-jobs";


--
-- Name: TABLE "Product"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."Product" TO retool;
GRANT ALL ON TABLE public."Product" TO "civitai-read";
GRANT SELECT ON TABLE public."Product" TO hasura;
GRANT ALL ON TABLE public."Product" TO "civitai-jobs";


--
-- Name: TABLE "PurchasableReward"; Type: ACL; Schema: public; Owner: civitai
--

GRANT ALL ON TABLE public."PurchasableReward" TO "civitai-read";
GRANT SELECT ON TABLE public."PurchasableReward" TO hasura;
GRANT SELECT ON TABLE public."PurchasableReward" TO retool;
GRANT ALL ON TABLE public."PurchasableReward" TO "civitai-jobs";


--
-- Name: SEQUENCE "PurchasableReward_id_seq"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON SEQUENCE public."PurchasableReward_id_seq" TO pghero;
GRANT SELECT,USAGE ON SEQUENCE public."PurchasableReward_id_seq" TO "civitai-read";
GRANT ALL ON SEQUENCE public."PurchasableReward_id_seq" TO retool;
GRANT ALL ON SEQUENCE public."PurchasableReward_id_seq" TO "civitai-jobs";


--
-- Name: TABLE "Purchase"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."Purchase" TO retool;
GRANT ALL ON TABLE public."Purchase" TO "civitai-read";
GRANT SELECT ON TABLE public."Purchase" TO hasura;
GRANT ALL ON TABLE public."Purchase" TO "civitai-jobs";


--
-- Name: SEQUENCE "Purchase_id_seq"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON SEQUENCE public."Purchase_id_seq" TO pghero;
GRANT SELECT,USAGE ON SEQUENCE public."Purchase_id_seq" TO "civitai-read";
GRANT ALL ON SEQUENCE public."Purchase_id_seq" TO retool;
GRANT ALL ON SEQUENCE public."Purchase_id_seq" TO "civitai-jobs";


--
-- Name: TABLE "QueryDurationLog"; Type: ACL; Schema: public; Owner: doadmin
--

GRANT ALL ON TABLE public."QueryDurationLog" TO civitai;
GRANT SELECT ON TABLE public."QueryDurationLog" TO "civitai-read";
GRANT SELECT ON TABLE public."QueryDurationLog" TO retool;
GRANT ALL ON TABLE public."QueryDurationLog" TO "civitai-jobs";


--
-- Name: SEQUENCE "QueryDurationLog_id_seq"; Type: ACL; Schema: public; Owner: doadmin
--

GRANT ALL ON SEQUENCE public."QueryDurationLog_id_seq" TO civitai;
GRANT SELECT ON SEQUENCE public."QueryDurationLog_id_seq" TO pghero;
GRANT SELECT,USAGE ON SEQUENCE public."QueryDurationLog_id_seq" TO "civitai-read";
GRANT ALL ON SEQUENCE public."QueryDurationLog_id_seq" TO retool;
GRANT ALL ON SEQUENCE public."QueryDurationLog_id_seq" TO "civitai-jobs";


--
-- Name: TABLE "QueryParamsLog"; Type: ACL; Schema: public; Owner: doadmin
--

GRANT ALL ON TABLE public."QueryParamsLog" TO civitai;
GRANT SELECT ON TABLE public."QueryParamsLog" TO "civitai-read";
GRANT SELECT ON TABLE public."QueryParamsLog" TO retool;
GRANT ALL ON TABLE public."QueryParamsLog" TO "civitai-jobs";


--
-- Name: SEQUENCE "QueryParamsLog_id_seq"; Type: ACL; Schema: public; Owner: doadmin
--

GRANT ALL ON SEQUENCE public."QueryParamsLog_id_seq" TO civitai;
GRANT SELECT ON SEQUENCE public."QueryParamsLog_id_seq" TO pghero;
GRANT SELECT,USAGE ON SEQUENCE public."QueryParamsLog_id_seq" TO "civitai-read";
GRANT ALL ON SEQUENCE public."QueryParamsLog_id_seq" TO retool;
GRANT ALL ON SEQUENCE public."QueryParamsLog_id_seq" TO "civitai-jobs";


--
-- Name: TABLE "QuerySqlLog"; Type: ACL; Schema: public; Owner: doadmin
--

GRANT ALL ON TABLE public."QuerySqlLog" TO civitai;
GRANT SELECT ON TABLE public."QuerySqlLog" TO "civitai-read";
GRANT SELECT ON TABLE public."QuerySqlLog" TO retool;
GRANT ALL ON TABLE public."QuerySqlLog" TO "civitai-jobs";


--
-- Name: SEQUENCE "QuerySqlLog_id_seq"; Type: ACL; Schema: public; Owner: doadmin
--

GRANT ALL ON SEQUENCE public."QuerySqlLog_id_seq" TO civitai;
GRANT SELECT ON SEQUENCE public."QuerySqlLog_id_seq" TO pghero;
GRANT SELECT,USAGE ON SEQUENCE public."QuerySqlLog_id_seq" TO "civitai-read";
GRANT ALL ON SEQUENCE public."QuerySqlLog_id_seq" TO retool;
GRANT ALL ON SEQUENCE public."QuerySqlLog_id_seq" TO "civitai-jobs";


--
-- Name: TABLE "Question"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."Question" TO retool;
GRANT ALL ON TABLE public."Question" TO "civitai-read";
GRANT SELECT ON TABLE public."Question" TO hasura;
GRANT ALL ON TABLE public."Question" TO "civitai-jobs";


--
-- Name: TABLE "QuestionMetric"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."QuestionMetric" TO retool;
GRANT ALL ON TABLE public."QuestionMetric" TO "civitai-read";
GRANT SELECT ON TABLE public."QuestionMetric" TO hasura;
GRANT ALL ON TABLE public."QuestionMetric" TO "civitai-jobs";


--
-- Name: TABLE "QuestionRank"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."QuestionRank" TO retool;
GRANT ALL ON TABLE public."QuestionRank" TO "civitai-read";
GRANT SELECT ON TABLE public."QuestionRank" TO hasura;
GRANT ALL ON TABLE public."QuestionRank" TO "civitai-jobs";


--
-- Name: TABLE "QuestionReaction"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."QuestionReaction" TO retool;
GRANT ALL ON TABLE public."QuestionReaction" TO "civitai-read";
GRANT SELECT ON TABLE public."QuestionReaction" TO hasura;
GRANT ALL ON TABLE public."QuestionReaction" TO "civitai-jobs";


--
-- Name: SEQUENCE "QuestionReaction_id_seq"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON SEQUENCE public."QuestionReaction_id_seq" TO pghero;
GRANT SELECT,USAGE ON SEQUENCE public."QuestionReaction_id_seq" TO "civitai-read";
GRANT ALL ON SEQUENCE public."QuestionReaction_id_seq" TO retool;
GRANT ALL ON SEQUENCE public."QuestionReaction_id_seq" TO "civitai-jobs";


--
-- Name: SEQUENCE "Question_id_seq"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON SEQUENCE public."Question_id_seq" TO pghero;
GRANT SELECT,USAGE ON SEQUENCE public."Question_id_seq" TO "civitai-read";
GRANT ALL ON SEQUENCE public."Question_id_seq" TO retool;
GRANT ALL ON SEQUENCE public."Question_id_seq" TO "civitai-jobs";


--
-- Name: TABLE "RecommendedResource"; Type: ACL; Schema: public; Owner: civitai
--

GRANT ALL ON TABLE public."RecommendedResource" TO "civitai-read";
GRANT SELECT ON TABLE public."RecommendedResource" TO hasura;
GRANT SELECT ON TABLE public."RecommendedResource" TO retool;
GRANT ALL ON TABLE public."RecommendedResource" TO "civitai-jobs";


--
-- Name: SEQUENCE "RecommendedResource_id_seq"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON SEQUENCE public."RecommendedResource_id_seq" TO pghero;
GRANT SELECT,USAGE ON SEQUENCE public."RecommendedResource_id_seq" TO "civitai-read";
GRANT ALL ON SEQUENCE public."RecommendedResource_id_seq" TO retool;
GRANT ALL ON SEQUENCE public."RecommendedResource_id_seq" TO "civitai-jobs";


--
-- Name: TABLE "RedeemableCode"; Type: ACL; Schema: public; Owner: doadmin
--

GRANT ALL ON TABLE public."RedeemableCode" TO civitai;
GRANT SELECT ON TABLE public."RedeemableCode" TO "civitai-read";
GRANT SELECT ON TABLE public."RedeemableCode" TO hasura;
GRANT SELECT ON TABLE public."RedeemableCode" TO retool;
GRANT ALL ON TABLE public."RedeemableCode" TO "civitai-jobs";


--
-- Name: SEQUENCE "Report_id_seq"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON SEQUENCE public."Report_id_seq" TO pghero;
GRANT SELECT,USAGE ON SEQUENCE public."Report_id_seq" TO "civitai-read";
GRANT ALL ON SEQUENCE public."Report_id_seq" TO retool;
GRANT ALL ON SEQUENCE public."Report_id_seq" TO "civitai-jobs";


--
-- Name: TABLE "ResourceReviewHelper"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."ResourceReviewHelper" TO retool;
GRANT ALL ON TABLE public."ResourceReviewHelper" TO "civitai-read";
GRANT SELECT ON TABLE public."ResourceReviewHelper" TO hasura;
GRANT ALL ON TABLE public."ResourceReviewHelper" TO "civitai-jobs";


--
-- Name: TABLE "ResourceReviewReaction"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."ResourceReviewReaction" TO retool;
GRANT ALL ON TABLE public."ResourceReviewReaction" TO "civitai-read";
GRANT SELECT ON TABLE public."ResourceReviewReaction" TO hasura;
GRANT ALL ON TABLE public."ResourceReviewReaction" TO "civitai-jobs";


--
-- Name: SEQUENCE "ResourceReviewReaction_id_seq"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON SEQUENCE public."ResourceReviewReaction_id_seq" TO pghero;
GRANT SELECT,USAGE ON SEQUENCE public."ResourceReviewReaction_id_seq" TO "civitai-read";
GRANT ALL ON SEQUENCE public."ResourceReviewReaction_id_seq" TO retool;
GRANT ALL ON SEQUENCE public."ResourceReviewReaction_id_seq" TO "civitai-jobs";


--
-- Name: TABLE "ResourceReviewReport"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."ResourceReviewReport" TO retool;
GRANT ALL ON TABLE public."ResourceReviewReport" TO "civitai-read";
GRANT SELECT ON TABLE public."ResourceReviewReport" TO hasura;
GRANT ALL ON TABLE public."ResourceReviewReport" TO "civitai-jobs";


--
-- Name: SEQUENCE "ResourceReview_id_seq"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON SEQUENCE public."ResourceReview_id_seq" TO pghero;
GRANT SELECT,USAGE ON SEQUENCE public."ResourceReview_id_seq" TO "civitai-read";
GRANT ALL ON SEQUENCE public."ResourceReview_id_seq" TO retool;
GRANT ALL ON SEQUENCE public."ResourceReview_id_seq" TO "civitai-jobs";


--
-- Name: TABLE "RunStrategy"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."RunStrategy" TO retool;
GRANT ALL ON TABLE public."RunStrategy" TO "civitai-read";
GRANT SELECT ON TABLE public."RunStrategy" TO hasura;
GRANT ALL ON TABLE public."RunStrategy" TO "civitai-jobs";


--
-- Name: TABLE "SavedModel"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."SavedModel" TO retool;
GRANT ALL ON TABLE public."SavedModel" TO "civitai-read";
GRANT SELECT ON TABLE public."SavedModel" TO hasura;
GRANT ALL ON TABLE public."SavedModel" TO "civitai-jobs";


--
-- Name: TABLE "SearchIndexUpdateQueue"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."SearchIndexUpdateQueue" TO retool;
GRANT ALL ON TABLE public."SearchIndexUpdateQueue" TO "civitai-read";
GRANT SELECT ON TABLE public."SearchIndexUpdateQueue" TO hasura;
GRANT ALL ON TABLE public."SearchIndexUpdateQueue" TO "civitai-jobs";


--
-- Name: TABLE "Session"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."Session" TO retool;
GRANT ALL ON TABLE public."Session" TO "civitai-read";
GRANT SELECT ON TABLE public."Session" TO hasura;
GRANT ALL ON TABLE public."Session" TO "civitai-jobs";


--
-- Name: TABLE "SessionInvalidation"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."SessionInvalidation" TO retool;
GRANT ALL ON TABLE public."SessionInvalidation" TO "civitai-read";
GRANT SELECT ON TABLE public."SessionInvalidation" TO hasura;
GRANT ALL ON TABLE public."SessionInvalidation" TO "civitai-jobs";


--
-- Name: SEQUENCE "Session_id_seq"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON SEQUENCE public."Session_id_seq" TO pghero;
GRANT SELECT,USAGE ON SEQUENCE public."Session_id_seq" TO "civitai-read";
GRANT ALL ON SEQUENCE public."Session_id_seq" TO retool;
GRANT ALL ON SEQUENCE public."Session_id_seq" TO "civitai-jobs";


--
-- Name: TABLE "TagEngagement"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."TagEngagement" TO retool;
GRANT ALL ON TABLE public."TagEngagement" TO "civitai-read";
GRANT SELECT ON TABLE public."TagEngagement" TO hasura;
GRANT ALL ON TABLE public."TagEngagement" TO "civitai-jobs";


--
-- Name: TABLE "TagMetric"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."TagMetric" TO retool;
GRANT ALL ON TABLE public."TagMetric" TO "civitai-read";
GRANT SELECT ON TABLE public."TagMetric" TO hasura;
GRANT ALL ON TABLE public."TagMetric" TO "civitai-jobs";


--
-- Name: TABLE "TagRank"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."TagRank" TO "civitai-read";


--
-- Name: TABLE "TagStat"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."TagStat" TO retool;
GRANT ALL ON TABLE public."TagStat" TO "civitai-read";
GRANT SELECT ON TABLE public."TagStat" TO hasura;
GRANT ALL ON TABLE public."TagStat" TO "civitai-jobs";


--
-- Name: TABLE "TagRank_Live"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."TagRank_Live" TO retool;
GRANT ALL ON TABLE public."TagRank_Live" TO "civitai-read";
GRANT SELECT ON TABLE public."TagRank_Live" TO hasura;
GRANT ALL ON TABLE public."TagRank_Live" TO "civitai-jobs";


--
-- Name: SEQUENCE "Tag_id_seq"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON SEQUENCE public."Tag_id_seq" TO pghero;
GRANT SELECT,USAGE ON SEQUENCE public."Tag_id_seq" TO "civitai-read";
GRANT ALL ON SEQUENCE public."Tag_id_seq" TO retool;
GRANT ALL ON SEQUENCE public."Tag_id_seq" TO "civitai-jobs";


--
-- Name: TABLE "TagsOnArticle"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."TagsOnArticle" TO retool;
GRANT ALL ON TABLE public."TagsOnArticle" TO "civitai-read";
GRANT SELECT ON TABLE public."TagsOnArticle" TO hasura;
GRANT ALL ON TABLE public."TagsOnArticle" TO "civitai-jobs";


--
-- Name: TABLE "TagsOnBounty"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."TagsOnBounty" TO retool;
GRANT ALL ON TABLE public."TagsOnBounty" TO "civitai-read";
GRANT SELECT ON TABLE public."TagsOnBounty" TO hasura;
GRANT ALL ON TABLE public."TagsOnBounty" TO "civitai-jobs";


--
-- Name: TABLE "TagsOnCollection"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."TagsOnCollection" TO retool;
GRANT ALL ON TABLE public."TagsOnCollection" TO "civitai-read";
GRANT SELECT ON TABLE public."TagsOnCollection" TO hasura;
GRANT ALL ON TABLE public."TagsOnCollection" TO "civitai-jobs";


--
-- Name: TABLE "TagsOnQuestions"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."TagsOnQuestions" TO retool;
GRANT ALL ON TABLE public."TagsOnQuestions" TO "civitai-read";
GRANT SELECT ON TABLE public."TagsOnQuestions" TO hasura;
GRANT ALL ON TABLE public."TagsOnQuestions" TO "civitai-jobs";


--
-- Name: TABLE "TagsOnTags"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."TagsOnTags" TO retool;
GRANT ALL ON TABLE public."TagsOnTags" TO "civitai-read";
GRANT SELECT ON TABLE public."TagsOnTags" TO hasura;
GRANT ALL ON TABLE public."TagsOnTags" TO "civitai-jobs";


--
-- Name: TABLE "Technique"; Type: ACL; Schema: public; Owner: doadmin
--

GRANT ALL ON TABLE public."Technique" TO civitai;
GRANT SELECT ON TABLE public."Technique" TO "civitai-read";
GRANT SELECT ON TABLE public."Technique" TO retool;
GRANT ALL ON TABLE public."Technique" TO "civitai-jobs";


--
-- Name: SEQUENCE "Technique_id_seq"; Type: ACL; Schema: public; Owner: doadmin
--

GRANT ALL ON SEQUENCE public."Technique_id_seq" TO civitai;
GRANT SELECT ON SEQUENCE public."Technique_id_seq" TO pghero;
GRANT SELECT,USAGE ON SEQUENCE public."Technique_id_seq" TO "civitai-read";
GRANT ALL ON SEQUENCE public."Technique_id_seq" TO retool;
GRANT ALL ON SEQUENCE public."Technique_id_seq" TO "civitai-jobs";


--
-- Name: TABLE "Thread"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."Thread" TO retool;
GRANT ALL ON TABLE public."Thread" TO "civitai-read";
GRANT SELECT ON TABLE public."Thread" TO hasura;
GRANT ALL ON TABLE public."Thread" TO "civitai-jobs";


--
-- Name: SEQUENCE "Thread_id_seq"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON SEQUENCE public."Thread_id_seq" TO pghero;
GRANT SELECT,USAGE ON SEQUENCE public."Thread_id_seq" TO "civitai-read";
GRANT ALL ON SEQUENCE public."Thread_id_seq" TO retool;
GRANT ALL ON SEQUENCE public."Thread_id_seq" TO "civitai-jobs";


--
-- Name: TABLE "TipConnection"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."TipConnection" TO retool;
GRANT ALL ON TABLE public."TipConnection" TO "civitai-read";
GRANT SELECT ON TABLE public."TipConnection" TO hasura;
GRANT ALL ON TABLE public."TipConnection" TO "civitai-jobs";


--
-- Name: TABLE "Tool"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."Tool" TO "civitai-read";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."Tool" TO retool;
GRANT ALL ON TABLE public."Tool" TO "civitai-jobs";


--
-- Name: SEQUENCE "Tool_id_seq"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON SEQUENCE public."Tool_id_seq" TO pghero;
GRANT SELECT ON SEQUENCE public."Tool_id_seq" TO "civitai-read";
GRANT ALL ON SEQUENCE public."Tool_id_seq" TO retool;
GRANT ALL ON SEQUENCE public."Tool_id_seq" TO "civitai-jobs";


--
-- Name: TABLE "User"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT,UPDATE ON TABLE public."User" TO retool;
GRANT ALL ON TABLE public."User" TO "civitai-read";
GRANT SELECT ON TABLE public."User" TO hasura;
GRANT ALL ON TABLE public."User" TO "civitai-jobs";


--
-- Name: TABLE "UserCosmetic"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."UserCosmetic" TO retool;
GRANT ALL ON TABLE public."UserCosmetic" TO "civitai-read";
GRANT SELECT ON TABLE public."UserCosmetic" TO hasura;
GRANT ALL ON TABLE public."UserCosmetic" TO "civitai-jobs";


--
-- Name: TABLE "UserCosmeticShopPurchases"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."UserCosmeticShopPurchases" TO "civitai-read";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."UserCosmeticShopPurchases" TO retool;
GRANT ALL ON TABLE public."UserCosmeticShopPurchases" TO "civitai-jobs";


--
-- Name: TABLE "UserEngagement"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."UserEngagement" TO retool;
GRANT ALL ON TABLE public."UserEngagement" TO "civitai-read";
GRANT SELECT ON TABLE public."UserEngagement" TO hasura;
GRANT ALL ON TABLE public."UserEngagement" TO "civitai-jobs";


--
-- Name: TABLE "UserLink"; Type: ACL; Schema: public; Owner: civitai
--

GRANT ALL ON TABLE public."UserLink" TO retool;
GRANT ALL ON TABLE public."UserLink" TO "civitai-read";
GRANT SELECT ON TABLE public."UserLink" TO hasura;
GRANT ALL ON TABLE public."UserLink" TO "civitai-jobs";


--
-- Name: SEQUENCE "UserLink_id_seq"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON SEQUENCE public."UserLink_id_seq" TO pghero;
GRANT SELECT,USAGE ON SEQUENCE public."UserLink_id_seq" TO "civitai-read";
GRANT ALL ON SEQUENCE public."UserLink_id_seq" TO retool;
GRANT ALL ON SEQUENCE public."UserLink_id_seq" TO "civitai-jobs";


--
-- Name: TABLE "UserMetric"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."UserMetric" TO retool;
GRANT ALL ON TABLE public."UserMetric" TO "civitai-read";
GRANT SELECT ON TABLE public."UserMetric" TO hasura;
GRANT ALL ON TABLE public."UserMetric" TO "civitai-jobs";


--
-- Name: TABLE "UserNotificationSettings"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."UserNotificationSettings" TO retool;
GRANT ALL ON TABLE public."UserNotificationSettings" TO "civitai-read";
GRANT SELECT ON TABLE public."UserNotificationSettings" TO hasura;
GRANT ALL ON TABLE public."UserNotificationSettings" TO "civitai-jobs";


--
-- Name: SEQUENCE "UserNotificationSettings_id_seq"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON SEQUENCE public."UserNotificationSettings_id_seq" TO pghero;
GRANT SELECT,USAGE ON SEQUENCE public."UserNotificationSettings_id_seq" TO "civitai-read";
GRANT ALL ON SEQUENCE public."UserNotificationSettings_id_seq" TO retool;
GRANT ALL ON SEQUENCE public."UserNotificationSettings_id_seq" TO "civitai-jobs";


--
-- Name: TABLE "UserProfile"; Type: ACL; Schema: public; Owner: civitai
--

GRANT ALL ON TABLE public."UserProfile" TO "civitai-read";
GRANT SELECT ON TABLE public."UserProfile" TO hasura;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."UserProfile" TO retool;
GRANT ALL ON TABLE public."UserProfile" TO "civitai-jobs";


--
-- Name: TABLE "UserPurchasedRewards"; Type: ACL; Schema: public; Owner: civitai
--

GRANT ALL ON TABLE public."UserPurchasedRewards" TO "civitai-read";
GRANT SELECT ON TABLE public."UserPurchasedRewards" TO hasura;
GRANT SELECT ON TABLE public."UserPurchasedRewards" TO retool;
GRANT ALL ON TABLE public."UserPurchasedRewards" TO "civitai-jobs";


--
-- Name: TABLE "UserRank"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."UserRank" TO "civitai-read";


--
-- Name: TABLE "UserStat"; Type: ACL; Schema: public; Owner: doadmin
--

GRANT ALL ON TABLE public."UserStat" TO civitai;
GRANT ALL ON TABLE public."UserStat" TO "civitai-read";
GRANT SELECT ON TABLE public."UserStat" TO hasura;
GRANT SELECT ON TABLE public."UserStat" TO retool;
GRANT ALL ON TABLE public."UserStat" TO "civitai-jobs";


--
-- Name: TABLE "UserRank_Live"; Type: ACL; Schema: public; Owner: doadmin
--

GRANT ALL ON TABLE public."UserRank_Live" TO civitai;
GRANT ALL ON TABLE public."UserRank_Live" TO "civitai-read";
GRANT SELECT ON TABLE public."UserRank_Live" TO hasura;
GRANT SELECT ON TABLE public."UserRank_Live" TO retool;
GRANT ALL ON TABLE public."UserRank_Live" TO "civitai-jobs";


--
-- Name: TABLE "UserReferral"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."UserReferral" TO retool;
GRANT ALL ON TABLE public."UserReferral" TO "civitai-read";
GRANT SELECT ON TABLE public."UserReferral" TO hasura;
GRANT ALL ON TABLE public."UserReferral" TO "civitai-jobs";


--
-- Name: TABLE "UserReferralCode"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."UserReferralCode" TO retool;
GRANT ALL ON TABLE public."UserReferralCode" TO "civitai-read";
GRANT SELECT ON TABLE public."UserReferralCode" TO hasura;
GRANT ALL ON TABLE public."UserReferralCode" TO "civitai-jobs";


--
-- Name: SEQUENCE "UserReferralCode_id_seq"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON SEQUENCE public."UserReferralCode_id_seq" TO pghero;
GRANT SELECT,USAGE ON SEQUENCE public."UserReferralCode_id_seq" TO "civitai-read";
GRANT ALL ON SEQUENCE public."UserReferralCode_id_seq" TO retool;
GRANT ALL ON SEQUENCE public."UserReferralCode_id_seq" TO "civitai-jobs";


--
-- Name: SEQUENCE "UserReferral_id_seq"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON SEQUENCE public."UserReferral_id_seq" TO pghero;
GRANT SELECT,USAGE ON SEQUENCE public."UserReferral_id_seq" TO "civitai-read";
GRANT ALL ON SEQUENCE public."UserReferral_id_seq" TO retool;
GRANT ALL ON SEQUENCE public."UserReferral_id_seq" TO "civitai-jobs";


--
-- Name: TABLE "UserReport"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."UserReport" TO retool;
GRANT ALL ON TABLE public."UserReport" TO "civitai-read";
GRANT SELECT ON TABLE public."UserReport" TO hasura;
GRANT ALL ON TABLE public."UserReport" TO "civitai-jobs";


--
-- Name: TABLE "UserStripeConnect"; Type: ACL; Schema: public; Owner: civitai
--

GRANT ALL ON TABLE public."UserStripeConnect" TO "civitai-read";
GRANT SELECT ON TABLE public."UserStripeConnect" TO hasura;
GRANT SELECT ON TABLE public."UserStripeConnect" TO retool;
GRANT ALL ON TABLE public."UserStripeConnect" TO "civitai-jobs";


--
-- Name: SEQUENCE "User_id_seq"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON SEQUENCE public."User_id_seq" TO pghero;
GRANT SELECT,USAGE ON SEQUENCE public."User_id_seq" TO "civitai-read";
GRANT ALL ON SEQUENCE public."User_id_seq" TO retool;
GRANT ALL ON SEQUENCE public."User_id_seq" TO "civitai-jobs";


--
-- Name: TABLE "Vault"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."Vault" TO "civitai-read";
GRANT SELECT ON TABLE public."Vault" TO hasura;
GRANT SELECT ON TABLE public."Vault" TO retool;
GRANT ALL ON TABLE public."Vault" TO "civitai-jobs";


--
-- Name: TABLE "VaultItem"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."VaultItem" TO "civitai-read";
GRANT SELECT ON TABLE public."VaultItem" TO hasura;
GRANT SELECT ON TABLE public."VaultItem" TO retool;
GRANT ALL ON TABLE public."VaultItem" TO "civitai-jobs";


--
-- Name: SEQUENCE "VaultItem_id_seq"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON SEQUENCE public."VaultItem_id_seq" TO pghero;
GRANT SELECT ON SEQUENCE public."VaultItem_id_seq" TO "civitai-read";
GRANT ALL ON SEQUENCE public."VaultItem_id_seq" TO retool;
GRANT ALL ON SEQUENCE public."VaultItem_id_seq" TO "civitai-jobs";


--
-- Name: TABLE "VerificationToken"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."VerificationToken" TO retool;
GRANT ALL ON TABLE public."VerificationToken" TO "civitai-read";
GRANT SELECT ON TABLE public."VerificationToken" TO hasura;
GRANT ALL ON TABLE public."VerificationToken" TO "civitai-jobs";


--
-- Name: TABLE "Webhook"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."Webhook" TO retool;
GRANT ALL ON TABLE public."Webhook" TO "civitai-read";
GRANT SELECT ON TABLE public."Webhook" TO hasura;
GRANT ALL ON TABLE public."Webhook" TO "civitai-jobs";


--
-- Name: SEQUENCE "Webhook_id_seq"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON SEQUENCE public."Webhook_id_seq" TO pghero;
GRANT SELECT,USAGE ON SEQUENCE public."Webhook_id_seq" TO "civitai-read";
GRANT ALL ON SEQUENCE public."Webhook_id_seq" TO retool;
GRANT ALL ON SEQUENCE public."Webhook_id_seq" TO "civitai-jobs";


--
-- Name: TABLE "_LicenseToModel"; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public."_LicenseToModel" TO retool;
GRANT ALL ON TABLE public."_LicenseToModel" TO "civitai-read";
GRANT SELECT ON TABLE public."_LicenseToModel" TO hasura;
GRANT ALL ON TABLE public."_LicenseToModel" TO "civitai-jobs";


--
-- Name: TABLE _prisma_migrations; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public._prisma_migrations TO retool;
GRANT ALL ON TABLE public._prisma_migrations TO "civitai-read";
GRANT SELECT ON TABLE public._prisma_migrations TO hasura;
GRANT ALL ON TABLE public._prisma_migrations TO "civitai-jobs";


--
-- Name: SEQUENCE collection_id_seq; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON SEQUENCE public.collection_id_seq TO pghero;
GRANT SELECT,USAGE ON SEQUENCE public.collection_id_seq TO "civitai-read";
GRANT ALL ON SEQUENCE public.collection_id_seq TO retool;
GRANT ALL ON SEQUENCE public.collection_id_seq TO "civitai-jobs";


--
-- Name: SEQUENCE collectionitem_id_seq; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON SEQUENCE public.collectionitem_id_seq TO pghero;
GRANT SELECT,USAGE ON SEQUENCE public.collectionitem_id_seq TO "civitai-read";
GRANT ALL ON SEQUENCE public.collectionitem_id_seq TO retool;
GRANT ALL ON SEQUENCE public.collectionitem_id_seq TO "civitai-jobs";


--
-- Name: SEQUENCE cosmetic_id_seq; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON SEQUENCE public.cosmetic_id_seq TO pghero;
GRANT SELECT,USAGE ON SEQUENCE public.cosmetic_id_seq TO "civitai-read";
GRANT ALL ON SEQUENCE public.cosmetic_id_seq TO retool;
GRANT ALL ON SEQUENCE public.cosmetic_id_seq TO "civitai-jobs";


--
-- Name: SEQUENCE homeblock_id_seq; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON SEQUENCE public.homeblock_id_seq TO pghero;
GRANT SELECT,USAGE ON SEQUENCE public.homeblock_id_seq TO "civitai-read";
GRANT ALL ON SEQUENCE public.homeblock_id_seq TO retool;
GRANT ALL ON SEQUENCE public.homeblock_id_seq TO "civitai-jobs";


--
-- Name: TABLE internal_leaderboard_models; Type: ACL; Schema: public; Owner: doadmin
--

GRANT ALL ON TABLE public.internal_leaderboard_models TO civitai;
GRANT ALL ON TABLE public.internal_leaderboard_models TO "civitai-read";
GRANT SELECT ON TABLE public.internal_leaderboard_models TO hasura;
GRANT SELECT ON TABLE public.internal_leaderboard_models TO retool;
GRANT ALL ON TABLE public.internal_leaderboard_models TO "civitai-jobs";


--
-- Name: TABLE research_ratings; Type: ACL; Schema: public; Owner: doadmin
--

GRANT ALL ON TABLE public.research_ratings TO civitai;
GRANT SELECT ON TABLE public.research_ratings TO "civitai-read";
GRANT SELECT ON TABLE public.research_ratings TO hasura;
GRANT SELECT ON TABLE public.research_ratings TO retool;
GRANT ALL ON TABLE public.research_ratings TO "civitai-jobs";


--
-- Name: TABLE research_ratings_resets; Type: ACL; Schema: public; Owner: doadmin
--

GRANT ALL ON TABLE public.research_ratings_resets TO civitai;
GRANT SELECT ON TABLE public.research_ratings_resets TO "civitai-read";
GRANT SELECT ON TABLE public.research_ratings_resets TO hasura;
GRANT SELECT ON TABLE public.research_ratings_resets TO retool;
GRANT ALL ON TABLE public.research_ratings_resets TO "civitai-jobs";


--
-- Name: TABLE subscriptions; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public.subscriptions TO "civitai-read";
GRANT SELECT ON TABLE public.subscriptions TO retool;
GRANT ALL ON TABLE public.subscriptions TO "civitai-jobs";


--
-- Name: TABLE temp_deleted_user_posts; Type: ACL; Schema: public; Owner: doadmin
--

GRANT ALL ON TABLE public.temp_deleted_user_posts TO civitai;
GRANT SELECT ON TABLE public.temp_deleted_user_posts TO "civitai-read";
GRANT ALL ON TABLE public.temp_deleted_user_posts TO "civitai-jobs";


--
-- Name: TABLE temp_goals; Type: ACL; Schema: public; Owner: doadmin
--

GRANT ALL ON TABLE public.temp_goals TO civitai;
GRANT SELECT ON TABLE public.temp_goals TO "civitai-read";
GRANT SELECT ON TABLE public.temp_goals TO retool;
GRANT ALL ON TABLE public.temp_goals TO "civitai-jobs";


--
-- Name: TABLE temp_model_files; Type: ACL; Schema: public; Owner: doadmin
--

GRANT ALL ON TABLE public.temp_model_files TO civitai;
GRANT SELECT ON TABLE public.temp_model_files TO "civitai-read";
GRANT SELECT ON TABLE public.temp_model_files TO retool;
GRANT ALL ON TABLE public.temp_model_files TO "civitai-jobs";


--
-- Name: TABLE temp_paddle_import; Type: ACL; Schema: public; Owner: doadmin
--

GRANT ALL ON TABLE public.temp_paddle_import TO civitai;
GRANT SELECT ON TABLE public.temp_paddle_import TO "civitai-read";
GRANT SELECT ON TABLE public.temp_paddle_import TO retool;
GRANT ALL ON TABLE public.temp_paddle_import TO "civitai-jobs";


--
-- Name: TABLE tmp_s; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public.tmp_s TO "civitai-read";
GRANT SELECT ON TABLE public.tmp_s TO retool;
GRANT ALL ON TABLE public.tmp_s TO "civitai-jobs";


--
-- Name: TABLE untitled_table_419; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public.untitled_table_419 TO "civitai-read";
GRANT SELECT ON TABLE public.untitled_table_419 TO retool;
GRANT ALL ON TABLE public.untitled_table_419 TO "civitai-jobs";


--
-- Name: SEQUENCE untitled_table_419_id_seq; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON SEQUENCE public.untitled_table_419_id_seq TO pghero;
GRANT SELECT ON SEQUENCE public.untitled_table_419_id_seq TO "civitai-read";
GRANT ALL ON SEQUENCE public.untitled_table_419_id_seq TO retool;
GRANT ALL ON SEQUENCE public.untitled_table_419_id_seq TO "civitai-jobs";


--
-- Name: TABLE untitled_table_420; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON TABLE public.untitled_table_420 TO "civitai-read";
GRANT SELECT ON TABLE public.untitled_table_420 TO retool;
GRANT ALL ON TABLE public.untitled_table_420 TO "civitai-jobs";


--
-- Name: SEQUENCE untitled_table_420_id_seq; Type: ACL; Schema: public; Owner: civitai
--

GRANT SELECT ON SEQUENCE public.untitled_table_420_id_seq TO pghero;
GRANT SELECT ON SEQUENCE public.untitled_table_420_id_seq TO "civitai-read";
GRANT ALL ON SEQUENCE public.untitled_table_420_id_seq TO retool;
GRANT ALL ON SEQUENCE public.untitled_table_420_id_seq TO "civitai-jobs";


--
-- Name: TABLE username_bak; Type: ACL; Schema: public; Owner: doadmin
--

GRANT ALL ON TABLE public.username_bak TO civitai;
GRANT SELECT ON TABLE public.username_bak TO retool;
GRANT ALL ON TABLE public.username_bak TO "civitai-read";
GRANT SELECT ON TABLE public.username_bak TO hasura;
GRANT ALL ON TABLE public.username_bak TO "civitai-jobs";


--
-- Name: SEQUENCE username_bak_id_seq; Type: ACL; Schema: public; Owner: doadmin
--

GRANT ALL ON SEQUENCE public.username_bak_id_seq TO civitai;
GRANT SELECT ON SEQUENCE public.username_bak_id_seq TO pghero;
GRANT SELECT,USAGE ON SEQUENCE public.username_bak_id_seq TO "civitai-read";
GRANT ALL ON SEQUENCE public.username_bak_id_seq TO retool;
GRANT ALL ON SEQUENCE public.username_bak_id_seq TO "civitai-jobs";


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: doadmin
--

ALTER DEFAULT PRIVILEGES FOR ROLE doadmin IN SCHEMA public GRANT ALL ON SEQUENCES  TO civitai;
ALTER DEFAULT PRIVILEGES FOR ROLE doadmin IN SCHEMA public GRANT SELECT ON SEQUENCES  TO pghero;
ALTER DEFAULT PRIVILEGES FOR ROLE doadmin IN SCHEMA public GRANT SELECT,USAGE ON SEQUENCES  TO "civitai-read";
ALTER DEFAULT PRIVILEGES FOR ROLE doadmin IN SCHEMA public GRANT ALL ON SEQUENCES  TO "civitai-jobs";


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: civitai
--

ALTER DEFAULT PRIVILEGES FOR ROLE civitai IN SCHEMA public GRANT SELECT ON SEQUENCES  TO pghero;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: doadmin
--

ALTER DEFAULT PRIVILEGES FOR ROLE doadmin IN SCHEMA public GRANT ALL ON FUNCTIONS  TO "civitai-jobs";


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: doadmin
--

ALTER DEFAULT PRIVILEGES FOR ROLE doadmin IN SCHEMA public GRANT ALL ON TABLES  TO civitai;
ALTER DEFAULT PRIVILEGES FOR ROLE doadmin IN SCHEMA public GRANT SELECT ON TABLES  TO "civitai-read";
ALTER DEFAULT PRIVILEGES FOR ROLE doadmin IN SCHEMA public GRANT ALL ON TABLES  TO "civitai-jobs";


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: civitai-read
--

ALTER DEFAULT PRIVILEGES FOR ROLE "civitai-read" IN SCHEMA public GRANT SELECT ON TABLES  TO "civitai-read";


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: -; Owner: civitai
--

ALTER DEFAULT PRIVILEGES FOR ROLE civitai GRANT SELECT ON SEQUENCES  TO "civitai-read";


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: -; Owner: civitai
--

ALTER DEFAULT PRIVILEGES FOR ROLE civitai GRANT SELECT ON TABLES  TO "civitai-read";


--
-- PostgreSQL database dump complete
--
