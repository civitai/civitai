/**
 * The three daily-loop notifications, best first. `type` is the processor key registered in the main
 * app (`src/server/notifications/new-order.notifications.ts`); keep the two in step.
 */
export const NOTIFY_KINDS = [
  { kind: 'verdicts', type: 'knights-verdicts-in' },
  { kind: 'streak', type: 'knights-streak-ends-soon' },
  { kind: 'new-images', type: 'knights-new-images' },
] as const;

export type NotifyKind = (typeof NOTIFY_KINDS)[number]['kind'];

export const typeOf = (kind: NotifyKind): string => NOTIFY_KINDS.find((k) => k.kind === kind)!.type;

export const NOTIFY = {
  /** UTC hour from which "streak ends soon" is sent. */
  streakWarningHourUtc: 21,
  verdictLookbackDays: 3,
  /** Votes older than this are not searched at all (the ledger is partitioned by month). */
  voteSearchDays: 30,
} as const;
