import type { ParamMatcher } from '@sveltejs/kit';
import { siteAppealQueueForSlug } from '$lib/site-appeals';

// `/appeals/[queue=appealQueue]`: one page per appeal category, each granted on its own path.
export const match = ((param: string) =>
  siteAppealQueueForSlug(param) !== undefined) satisfies ParamMatcher;
