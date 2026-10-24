import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import {
  ReportEntity,
  reportEntities,
  reportEntityForSlug,
  reportPath,
  type ReportEntity as ReportEntityType,
} from '$lib/reports';

// Each report type is its own page now. `?type=` was how the old tabbed page selected one, so it is
// translated here rather than dropped — bookmarks and pasted links keep working.
function resolve(requested: string | null): ReportEntityType {
  if (!requested) return ReportEntity.Model;
  if ((reportEntities as string[]).includes(requested)) return requested as ReportEntityType;
  return reportEntityForSlug(requested) ?? ReportEntity.Model;
}

export const load: PageServerLoad = ({ url }) => {
  const target = new URL(url);
  target.pathname = reportPath(resolve(url.searchParams.get('type')));
  target.searchParams.delete('type');
  redirect(307, target.pathname + target.search);
};
