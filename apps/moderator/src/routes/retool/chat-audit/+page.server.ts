import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// The bare route has no content of its own. The report queue is the entry point when a moderator
// arrives without a subject; a link carrying a search or a chat id is already an investigation and
// belongs on Chats.
export const load: PageServerLoad = async ({ url }) => {
  const params = url.searchParams;
  const tab = params.get('q') || params.get('chat') ? 'chats' : 'reports';
  const qs = params.toString();
  redirect(307, `/retool/chat-audit/${tab}${qs ? `?${qs}` : ''}`);
};
