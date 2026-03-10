import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '~/server/routers';

export type RouterOutput = inferRouterOutputs<AppRouter>;

type ModelRouter = RouterOutput['model'];
export type ModelById = ModelRouter['getById'];
export type ModelGetAll = ModelRouter['getAll'];
export type ModelGetVersions = ModelRouter['getVersions'];
export type MyDraftModelGetAll = ModelRouter['getMyDraftModels'];
export type MyTrainingModelGetAll = ModelRouter['getMyTrainingModels'];
export type MyAvailTrainingModels = ModelRouter['getAvailableTrainingModels'];
export type MyRecentlyAddedModels = ModelRouter['getRecentlyManuallyAdded'];
export type MyRecentlyRecommended = ModelRouter['getRecentlyRecommended'];
export type ModelGetAllPagedSimple = ModelRouter['getAllPagedSimple'];
export type ModelGetAssociatedResourcesSimple = ModelRouter['getAssociatedResourcesSimple'];

type ModelVersionRouter = RouterOutput['modelVersion'];
export type ModelVersionById = ModelVersionRouter['getById'];

type ModelFileRouter = RouterOutput['modelFile'];
export type RecentTrainingData = ModelFileRouter['getRecentTrainingData']['items'];

type CommentRouter = RouterOutput['comment'];
export type CommentGetReactions = CommentRouter['getReactions'];
export type CommentGetAll = CommentRouter['getAll'];
export type CommentGetAllItem = CommentGetAll['comments'][number];
export type CommentGetById = CommentRouter['getById'];
export type CommentGetCommentsById = CommentRouter['getCommentsById'];

type CommentV2Router = RouterOutput['commentv2'];
export type CommentV2GetInfinite = CommentV2Router['getInfinite'];

type NotificationRouter = RouterOutput['notification'];
export type NotificationGetAll = NotificationRouter['getAllByUser'];
export type NotificationGetAllItem = NotificationGetAll['items'][number];

type DownloadRouter = RouterOutput['download'];
export type DownloadGetAll = DownloadRouter['getAllByUser'];
export type DownloadGetAllItem = DownloadGetAll['items'][number];

type UserRouter = RouterOutput['user'];
export type LeaderboardGetAll = UserRouter['getLeaderboard'];
export type CreatorsGetAll = UserRouter['getCreators'];
export type UsersGetAll = UserRouter['getAll'];
export type UsersGetCosmetics = UserRouter['getCosmetics'];

type ImageRouter = RouterOutput['image'];
export type ImageGetInfinite = ImageRouter['getInfinite']['items'];
export type ImageGetById = ImageRouter['get'];
export type ImageGetMyInfinite = ImageRouter['getMyImages']['items'];

type TagRouter = RouterOutput['tag'];
export type TagGetAll = TagRouter['getAll']['items'];
export type TagGetVotableTags = TagRouter['getVotableTags'];

type ResourceReviewRouter = RouterOutput['resourceReview'];
export type ResourceReviewInfiniteModel = ResourceReviewRouter['getInfinite']['items'][number];
export type ResourceReviewRatingTotals = ResourceReviewRouter['getRatingTotals'];
export type ResourceReviewPaged = ResourceReviewRouter['getPaged'];
export type ResourceReviewPagedModel = ResourceReviewRouter['getPaged']['items'][number];
export type ResourceReviewGetById = ResourceReviewRouter['get'];
export type ResourceReviewCreate = ResourceReviewRouter['create'];

type ArticleRouter = RouterOutput['article'];
export type ArticleGetById = ArticleRouter['getById'];
export type ArticleGetInfinite = ArticleRouter['getInfinite']['items'];

type LeaderboardRouter = RouterOutput['leaderboard'];
export type LeaderboardGetModel = LeaderboardRouter['getLeaderboard'][number];

type HomeBlockRouter = RouterOutput['homeBlock'];
export type HomeBlockGetAll = HomeBlockRouter['getHomeBlocks'];
export type HomeBlockGetById = HomeBlockRouter['getHomeBlock'];

type CollectionRouter = RouterOutput['collection'];
export type CollectionGetAllUserModel = CollectionRouter['getAllUser'][number];
export type CollectionByIdModel = CollectionRouter['getById']['collection'];
export type CollectionGetInfinite = CollectionRouter['getInfinite']['items'];
export type CollectionGetAllItems = CollectionRouter['getAllCollectionItems'];

type TrainingRouter = RouterOutput['training'];
export type TrainingModelData = TrainingRouter['getModelBasic'];

type BountyRouter = RouterOutput['bounty'];
export type BountyGetAll = BountyRouter['getInfinite']['items'];
export type BountyGetById = BountyRouter['getById'];
export type BountyGetEntries = BountyRouter['getEntries']['items'];

type BountyEntryRouter = RouterOutput['bountyEntry'];
export type BountyEntryGetById = BountyEntryRouter['getById'];

export type UserOverview = RouterOutput['userProfile']['overview'];
export type UserWithProfile = RouterOutput['userProfile']['get'];

export type ImageModerationReviewQueueImage =
  RouterOutput['image']['getModeratorReviewQueue']['items'][number];

export type ClubGetById = RouterOutput['club']['getById'];
export type ClubTier = RouterOutput['club']['getTiers'][number];

export type UserClub = RouterOutput['club']['userContributingClubs'][number];
export type ClubGetAll = RouterOutput['club']['getInfinite']['items'];
export type ClubPostGetAll = RouterOutput['clubPost']['getInfiniteClubPosts']['items'];
export type ClubMembershipGetAllRecord =
  RouterOutput['clubMembership']['getInfinite']['items'][number];
export type ClubMembershipOnClub = RouterOutput['clubMembership']['getClubMembershipOnClub'];

export type ClubResourceGetPaginatedItem =
  RouterOutput['club']['getPaginatedClubResources']['items'][number];

export type UserPaymentMethod = RouterOutput['user']['getPaymentMethods'][number];

export type ClubAdminInvite = RouterOutput['clubAdmin']['getInvitesPaged']['items'][number];
export type ClubAdmin = RouterOutput['clubAdmin']['getAdminsPaged']['items'][number];
export type ClubPostResource = RouterOutput['clubPost']['resourcePostCreateDetails'];

type GenerationRouter = RouterOutput['generation'];
export type GenerationGetResources = GenerationRouter['getResources']['items'];

type ChatRouter = RouterOutput['chat'];
export type ChatListMessage = ChatRouter['getAllByUser'][number];
export type ChatAllMessages = ChatRouter['getInfiniteMessages']['items'];
export type ChatCreateChat = ChatRouter['createChat'];

export type PurchasableRewardGetById = RouterOutput['purchasableReward']['getById'];
export type PurchasableRewardGetPaged =
  RouterOutput['purchasableReward']['getPaged']['items'][number];

export type VaultItemGetPaged = RouterOutput['vault']['getItemsPaged']['items'][number];
export type CosmeticGetById = Exclude<RouterOutput['cosmetic']['getById'], null>;
export type CosmeticShopItemGetById = RouterOutput['cosmeticShop']['getShopItemById'];
export type CosmeticShopSectionGetById = RouterOutput['cosmeticShop']['getSectionById'];

export type ModelVersionDonationGoal = Exclude<
  RouterOutput['modelVersion']['donationGoals'],
  undefined
>[number];
export type PostContestCollectionItem =
  RouterOutput['post']['getContestCollectionDetails']['items'][number];

type BuzzRouter = RouterOutput['buzz'];
export type GetDailyBuzzCompensation = BuzzRouter['getDailyBuzzCompensation'];

type BuzzWithdrawalRequestRouter = RouterOutput['buzzWithdrawalRequest'];
export type BuzzWithdrawalRequestHistoryRecord =
  | BuzzWithdrawalRequestRouter['getPaginatedOwned']['items'][number]['history']
  | BuzzWithdrawalRequestRouter['getPaginated']['items'][number]['history'];
export type BuzzWithdrawalGetPaginatedItem =
  BuzzWithdrawalRequestRouter['getPaginated']['items'][number];

type ToolRouter = RouterOutput['tool'];
export type ToolGetAllModel = ToolRouter['getAll']['items'][number];

type OrchestratorRouter = RouterOutput['orchestrator'];
export type QueryGeneratedImages = OrchestratorRouter['queryGeneratedImages'];

export type CompensationPool = RouterOutput['creatorProgram']['getCompensationPool'];

type AuctionRouter = RouterOutput['auction'];
export type AuctionBySlug = AuctionRouter['getBySlug'];

type NewOrderRouter = RouterOutput['games']['newOrder'];
export type GetJudgmentHistoryItem = NewOrderRouter['getHistory']['items'][number];
export type GetPlayer = NewOrderRouter['getPlayer'];
export type GetPlayersItem = NewOrderRouter['getPlayers']['items'][number];
export type GetImagesQueueItem = NewOrderRouter['getImagesQueue'][number];
export type GetImageRaters = NewOrderRouter['getImageRaters'];

type ChallengeRouter = RouterOutput['challenge'];
export type GetActiveJudgesItem = ChallengeRouter['getJudges'][number];
