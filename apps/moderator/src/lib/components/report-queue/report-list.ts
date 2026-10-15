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
};
