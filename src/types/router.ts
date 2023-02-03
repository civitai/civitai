import { inferRouterOutputs, inferRouterInputs } from '@trpc/server';
import type { AppRouter } from '~/server/routers';

export type RouterOutput = inferRouterOutputs<AppRouter>;
export type RouterInput = inferRouterInputs<AppRouter>;

type ModelRouter = RouterOutput['model'];
export type ModelById = ModelRouter['getById'];
export type ModelGetAll = ModelRouter['getAll'];

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
export type ImageGetAllInfinite = ImageRouter['getGalleryImagesInfinite']['items'];
