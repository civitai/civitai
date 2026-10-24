import type { ParamMatcher } from '@sveltejs/kit';
import { SUSPECT_TABS, type SuspectTab } from '../routes/reports/user/tabs';

// `/reports/user/[userId]/[[tab=suspectTab]]`: an unknown tab is a 404, not a page that loads nothing.
export const match = ((param: string): param is SuspectTab =>
  (SUSPECT_TABS as readonly string[]).includes(param)) satisfies ParamMatcher;
