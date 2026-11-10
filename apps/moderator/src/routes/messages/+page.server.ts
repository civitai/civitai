import type { PageServerLoad } from './$types';
import { getInbox } from '$lib/server/message-as-civitai';

export const load: PageServerLoad = async ({ url }) => {
  const awaitingOnly = url.searchParams.get('show') !== 'all';
  const result = await getInbox(awaitingOnly);
  return {
    awaitingOnly,
    threads: result.ok ? result.value : [],
    error: result.ok ? null : result.error,
  };
};
