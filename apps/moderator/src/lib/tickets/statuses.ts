/** Freshdesk ticket statuses on this account. */
export const STATUS_LABEL: Record<number, string> = {
  2: 'Open',
  3: 'Pending',
  4: 'Resolved',
  5: 'Closed',
  6: 'Waiting on Customer',
  7: 'Waiting on Dev',
  8: 'Waiting on Mod Lead',
  9: 'Customer Responded',
  9000: 'Assigned to AI Agent',
};

/** Every status except Resolved (4) and Closed (5). */
export const LIVE_STATUSES = [2, 3, 6, 7, 8, 9, 9000] as const;

export const statusLabel = (status: number): string => STATUS_LABEL[status] ?? `Status ${status}`;
