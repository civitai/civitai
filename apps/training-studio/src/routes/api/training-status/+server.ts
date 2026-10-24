import { json, type RequestHandler } from '@sveltejs/kit';
import { getTrainingServiceStatus } from '$lib/server/service-status';

export const GET: RequestHandler = async () => json(await getTrainingServiceStatus());
