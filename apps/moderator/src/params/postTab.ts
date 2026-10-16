import type { ParamMatcher } from '@sveltejs/kit';
import { POST_TABS, type PostTab } from '../routes/reports/post/tabs';

// `/reports/post/[postId]/[[tab=postTab]]`: an unknown tab is a 404, not a page that loads nothing.
export const match = ((param: string): param is PostTab =>
  (POST_TABS as readonly string[]).includes(param)) satisfies ParamMatcher;
