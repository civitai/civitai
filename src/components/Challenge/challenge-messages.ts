/**
 * What a moderator is told after ending a challenge by hand.
 *
 * Extracted from the two pages that call `endAndPickWinners` because the wrong string here is
 * worse than silence: a challenge on a comparison engine is QUEUED rather than judged inline, and
 * reporting its `winnersCount: 0` as "0 winner(s) selected" says judging ran and found nobody —
 * the opposite of what happened, and an invitation to click again to fix it.
 *
 * A string inside a page component is also unreachable from any test we run; here it is a function
 * with a test, so reverting it fails something.
 */
export function challengeEndedMessage(result: { queued?: boolean; winnersCount: number }): string {
  if (result.queued) {
    return 'Challenge ended. Judging has been queued — winners will be posted when it completes.';
  }
  return `Challenge ended. ${result.winnersCount} winner(s) selected.`;
}
