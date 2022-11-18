import { inferRouterOutputs, inferRouterInputs } from '@trpc/server';
import type { AppRouter } from '~/server/routers';

export type RouterOutput = inferRouterOutputs<AppRouter>;
export type RouterInput = inferRouterInputs<AppRouter>;

export type ModelById = RouterOutput['model']['getById'];
export type ModelGetAll = RouterOutput['model']['getAll'];
