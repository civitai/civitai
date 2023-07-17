import { inferRouterOutputs, inferRouterInputs } from '@trpc/server';
import type { AppRouter } from '~/server/routers';

export type RouterOutput = inferRouterOutputs<AppRouter>;
export type RouterInput = inferRouterInputs<AppRouter>;

type ModelRouter = RouterOutput['model'];
export type ModelById = ModelRouter['getById'];
export type ModelGetAll = ModelRouter['getAll'];
export type ModelGetVersions = ModelRouter['getVersions'];
export type MyDraftModelGetAll = ModelRouter['getMyDraftModels'];
export type ModelGetAllPagedSimple = ModelRouter['getAllPagedSimple'];
export type ModelGetByCategory = ModelRouter['getByCategory']['items'][number];
export type ModelGetByCategoryModel = ModelGetByCategory['items'][number];
export type ModelGetAssociatedResourcesSimple = ModelRouter['getAssociatedResourcesSimple'];

type ModelVersionRouter = RouterOutput['modelVersion'];
export type ModelVersionById = ModelVersionRouter['getById'];

type ReviewRouter = RouterOutput['review'];
export type ReviewGetAll = ReviewRouter['getAll'];
export type ReviewGetAllItem = ReviewGetAll['reviews'][number];
export type ReviewGetById = ReviewRouter['getDetail'];
export type ReviewGetCommentsById = ReviewRouter['getCommentsById'];
export type ReviewGetReactions = ReviewRouter['getReactions'];

type CommentRouter = RouterOutput['comment'];
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
export type ImageGetGalleryInfinite = ImageRouter['getGalleryImagesInfinite']['items'];
export type ImageGetInfinite = ImageRouter['getInfinite']['items'];
export type ImageGetByCategoryModel = ImageRouter['getImagesByCategory']['items'][number];
export type ImageGetByCategoryImageModel = ImageGetByCategoryModel['items'][number];

type TagRouter = RouterOutput['tag'];
export type TagGetAll = TagRouter['getAll']['items'];
export type TagGetVotableTags = TagRouter['getVotableTags'];

type ResourceReviewRouter = RouterOutput['resourceReview'];
export type ResourceReviewInfiniteModel = ResourceReviewRouter['getInfinite']['items'][number];
export type ResourceReviewRatingTotals = ResourceReviewRouter['getRatingTotals'];
export type ResourceReviewPaged = ResourceReviewRouter['getPaged'];
export type ResourceReviewPagedModel = ResourceReviewRouter['getPaged']['items'][number];

type PostRouter = RouterOutput['post'];
export type PostGetByCategoryModel = PostRouter['getPostsByCategory']['items'][number];
export type PostGetByCategoryPostModel = PostGetByCategoryModel['items'][number];

type ArticleRouter = RouterOutput['article'];
export type ArticleGetAll = ArticleRouter['getInfinite'];
export type ArticleGetById = ArticleRouter['getById'];
export type ArticleGetByCategoryModel = ArticleRouter['getByCategory']['items'][number];
export type ArticleGetByCategoryArticleModel = ArticleGetByCategoryModel['items'][number];

type LeaderboardRouter = RouterOutput['leaderboard'];
export type LeaderboardGetModel = LeaderboardRouter['getLeaderboard'][number];

type HomeBlockRouter = RouterOutput['homeBlock'];
export type HomeBlockGetAll = HomeBlockRouter['getHomeBlocks'];

type CollectionRouter = RouterOutput['collection'];
export type CollectionGetAllUserModel = CollectionRouter['getAllUser'][number];
