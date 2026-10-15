import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { userReportUrl } from '$lib/entity-url';
import { SUSPECT_TABS } from '../../reports/user/tabs';

// The user report queue moved to `/reports/user` (2026-10-14), beside the other report queues. Kept so
// bookmarks and links already handed round still land on the account they named. `?user=` and `?tab=`
// are the path there now (`/reports/user/<id>/<tab>`); every other param (`page`, the queue and image
// filters) means the same and is carried as it is.
export const load: PageServerLoad = ({ url }) => {
  const params = new URLSearchParams(url.search);
  const user = Number(params.get('user'));
  const tab = params.get('tab') ?? undefined;
  params.delete('user');
  params.delete('tab');
  const path =
    Number.isInteger(user) && user > 0
      ? userReportUrl(
          user,
          tab && (SUSPECT_TABS as readonly string[]).includes(tab) ? tab : undefined
        )
      : '/reports/user';
  redirect(308, params.size ? `${path}?${params}` : path);
};
