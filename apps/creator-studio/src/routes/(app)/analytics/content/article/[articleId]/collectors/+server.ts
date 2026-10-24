import { collectorsHandler } from '$lib/server/collectors';

export const GET = collectorsHandler('article', 'articleId');
