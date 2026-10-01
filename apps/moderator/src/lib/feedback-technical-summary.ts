import { plural } from './format';
import type { FeedbackContext } from './feedback';

/**
 * The badge beside "Technical details" — what the collapsed block holds, without opening it.
 *
 * 🔴 "DISTINCT" IS LOAD-BEARING AND MUST NOT BE DROPPED TO SHORTEN THE STRING. The producer
 * collapses repeats into `entry.count`, so `consoleErrors.length` counts distinct MESSAGES and the
 * events behind it can be far more numerous. `FeedbackBrowserErrors.svelte` spells its own heading
 * "N distinct" for exactly this, and a badge reading "3 console errors" would say something the
 * data does not support.
 *
 * ⚠️ That heading is NOT formatted — it prints the raw length, while `plural` here routes through
 * `num`. Where the viewer's locale groups, the badge groups and the heading does not. Four figures
 * is NOT enough to demonstrate that — CLDR `minimumGroupingDigits` is 2 in a large minority of
 * locales, where `1000` renders ungrouped on both sides. Live but cosmetic.
 *
 * `null` rather than an empty string when there is nothing to report: the caller renders no element
 * at all, so an empty badge cannot take up space or inherit a margin.
 */
export const feedbackTechnicalSummary = (
  context: Pick<FeedbackContext, 'consoleErrors' | 'networkErrors'>
): string | null => {
  const parts: string[] = [];
  if (context.consoleErrors.length) {
    parts.push(plural(context.consoleErrors.length, 'distinct console error'));
  }
  if (context.networkErrors.length) {
    parts.push(plural(context.networkErrors.length, 'failed request'));
  }
  return parts.length ? parts.join(' · ') : null;
};
