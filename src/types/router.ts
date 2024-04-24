import { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '~/server/routers';

export type RouterOutput = inferRouterOutputs<AppRouter>;

type ModelRouter = RouterOutput['model'];
export type ModelById = ModelRouter['getById'];
export type ModelGetAll = ModelRouter['getAll'];
export type ModelGetVersions = ModelRouter['getVersions'];
export type MyDraftModelGetAll = ModelRouter['getMyDraftModels'];
export type MyTrainingModelGetAll = ModelRouter['getMyTrainingModels'];
export type ModelGetAllPagedSimple = ModelRouter['getAllPagedSimple'];
export type ModelGetAssociatedResourcesSimple = ModelRouter['getAssociatedResourcesSimple'];

type CommentRouter = RouterOutput['comment'];
export type CommentGetReactions = CommentRouter['getReactions'];
export type CommentGetAll = CommentRouter['getAll'];
export type CommentGetAllItem = CommentGetAll['comments'][number];
export type CommentGetById = CommentRouter['getById'];
export type CommentGetCommentsById = CommentRouter['getCommentsById'];

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

type TagRouter = RouterOutput['tag'];
export type TagGetAll = TagRouter['getAll']['items'];
export type TagGetVotableTags = TagRouter['getVotableTags'];

type ResourceReviewRouter = RouterOutput['resourceReview'];
export type ResourceReviewInfiniteModel = ResourceReviewRouter['getInfinite']['items'][number];
export type ResourceReviewRatingTotals = ResourceReviewRouter['getRatingTotals'];
export type ResourceReviewPaged = ResourceReviewRouter['getPaged'];
export type ResourceReviewPagedModel = ResourceReviewRouter['getPaged']['items'][number];
export type ResourceReviewGetById = ResourceReviewRouter['get'];

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

type TrainingRouter = RouterOutput['training'];
export type TrainingModelData = TrainingRouter['getModelBasic'];

type BountyRouter = RouterOutput['bounty'];
export type BountyGetAll = BountyRouter['getInfinite']['items'];
export type BountyGetById = BountyRouter['getById'];
export type BountyGetEntries = BountyRouter['getEntries'];

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
