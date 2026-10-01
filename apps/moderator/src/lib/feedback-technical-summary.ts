import { plural } from './format';
import type { FeedbackContext } from './feedback';

/**
 * The badge beside "Technical details" — what the collapsed block holds, without opening it.
 *
 * 🔴 IT EXISTS BECAUSE COLLAPSING THE BLOCK HID THE CHEAPEST TRIAGE SIGNAL ON THE PANEL. Console
 * errors and failed requests render in exactly one component, reachable only through
 * `FeedbackContextPanel`, and the queue's columns carry nothing about either — so once that block
 * is closed by default, a report whose session threw forty errors is indistinguishable from a clean
 * one at every level the operator can see. Three other panels in this app put the count in the
 * `<summary>` for the same reason.
 *
 * 🔴 "DISTINCT" IS LOAD-BEARING AND MUST NOT BE DROPPED TO SHORTEN THE STRING. The producer
 * collapses repeats into `entry.count`, so `consoleErrors.length` counts distinct MESSAGES and the
 * events behind it can be far more numerous. `FeedbackBrowserErrors.svelte` spells its own heading
 * "N distinct" for exactly this; a badge reading "3 console errors" would say something the data
 * does not support, and would disagree with the heading three lines below it.
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
