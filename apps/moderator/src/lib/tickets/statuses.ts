/** Freshdesk ticket status ids on this account. */
export const STATUS = {
  open: 2,
  pending: 3,
  resolved: 4,
  closed: 5,
  waitingOnCustomer: 6,
  waitingOnDev: 7,
  waitingOnMod: 8,
  customerResponded: 9,
  aiAgent: 9000,
} as const;

export const STATUS_LABEL: Record<number, string> = {
  [STATUS.open]: 'Open',
  [STATUS.pending]: 'Pending',
  [STATUS.resolved]: 'Resolved',
  [STATUS.closed]: 'Closed',
  [STATUS.waitingOnCustomer]: 'Waiting on Customer',
  [STATUS.waitingOnDev]: 'Waiting on Dev',
  [STATUS.waitingOnMod]: 'Waiting on Mod Lead',
  [STATUS.customerResponded]: 'Customer Responded',
  [STATUS.aiAgent]: 'Assigned to AI Agent',
};

export const LIVE_STATUSES: number[] = Object.values(STATUS).filter(
  (s) => s !== STATUS.resolved && s !== STATUS.closed
);

export const statusLabel = (status: number): string => STATUS_LABEL[status] ?? `Status ${status}`;

export const SETTABLE_STATUSES = [
  STATUS.pending,
  STATUS.waitingOnCustomer,
  STATUS.resolved,
  STATUS.closed,
] as const;

export const isSettableStatus = (v: number): v is (typeof SETTABLE_STATUSES)[number] =>
  (SETTABLE_STATUSES as readonly number[]).includes(v);
