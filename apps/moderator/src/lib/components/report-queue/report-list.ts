/** One more reporter folded into a report (`withAdditionalReporters`): who, when, and what they said. */
export type AdditionalReporter = {
  userId: number;
  username: string | null;
  createdAt: string | null;
  comment: string | null;
};

/** What `ReportList` reads from a report row — the shape `getReports` returns, as both queues pass it. */
export type ReportListItem = {
  id: number;
  reason: string;
  status: string;
  details: unknown;
  reportedByUsername: string | null;
  reportedByEmail: string | null;
  alsoReportedByCount: number | null;
  createdAt: Date;
  /** Moderators' own notes on the report (`ReportNotes`). */
  internalNotes?: string | null;
  additionalReporters?: AdditionalReporter[];
};
