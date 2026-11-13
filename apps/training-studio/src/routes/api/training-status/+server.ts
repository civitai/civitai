import { json, type RequestHandler } from '@sveltejs/kit';
import { getTrainingServiceStatus } from '$lib/server/service-status';
import { clientServiceStatus } from '$lib/service-status-core';

export const GET: RequestHandler = async () =>
  json(clientServiceStatus(await getTrainingServiceStatus()));
