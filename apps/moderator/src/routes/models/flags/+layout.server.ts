import type { LayoutServerLoad } from './$types';
import { childLinks } from '$lib/server/access';
import { MODEL_FLAGS_PATH, MODEL_FLAG_TAB_HINTS } from '$lib/minor-flags/paths';

// Only the tabs this user holds. Counts are read client-side from the sidebar store so they never sit in
// the page-load path.
export const load: LayoutServerLoad = ({ locals }) => ({
  modelFlagTabs: childLinks(MODEL_FLAGS_PATH, locals.user).map((link) => ({
    label: link.label,
    href: link.path!,
    countKey: link.countKey,
    hint: MODEL_FLAG_TAB_HINTS[link.path!],
  })),
  // Every tab sizes itself against the viewport; the layout owns the header above them.
  fullBleed: true,
  // The title shares the sidebar trigger's row; the header below pads past it.
  headerInline: true,
});
