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
export type ReviewGetById = ReviewRouter['getById'];
export type ReviewGetReactions = ReviewRouter['getReactions'];

type CommentRouter = RouterOutput['comment'];
export type CommentGetAll = CommentRouter['getAll'];
export type CommentGetAllItem = CommentGetAll['comments'][number];
export type CommentGetById = CommentRouter['getById'];
