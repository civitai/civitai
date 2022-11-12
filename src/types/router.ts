import { inferRouterOutputs, inferRouterInputs } from '@trpc/server';
import type { AppRouter } from '~/server/trpc/router';

export type RouterOutput = inferRouterOutputs<AppRouter>;
export type RouterInput = inferRouterInputs<AppRouter>;

export type ModelById = RouterOutput['model']['getById'];
