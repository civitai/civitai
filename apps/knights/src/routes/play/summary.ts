import { imageUrl } from '$lib/server/image-url';
import type { TrialSummary } from '$lib/server/trials/trials.service';

/** The summary as the page receives it: pictures as URLs, dates as ISO strings. */
export function summaryPayload(summary: TrialSummary, now: Date) {
  const remaining = summary.cooldownUntil ? summary.cooldownUntil.getTime() - now.getTime() : 0;
  return {
    kind: 'summary' as const,
    result: summary.result,
    scored: summary.scored,
    right: summary.right,
    passMark: summary.passMark,
    // The server's remaining wait, so the browser clock cannot skew the countdown.
    secondsLeft: remaining > 0 ? Math.ceil(remaining / 1000) : null,
    items: summary.items.map((item) => ({
      referenceId: item.referenceId,
      src: item.imageKey ? imageUrl(item.imageKey) : null,
      width: item.width,
      height: item.height,
      answerLabel: item.answerLabel,
      correctLabel: item.correctLabel,
      correct: item.correct,
      scored: item.scored,
      explanation: item.explanation,
    })),
  };
}

export type SummaryView = ReturnType<typeof summaryPayload>;
