// The operations the bulk bar can start. Each opens a form — nothing applies straight from the bar.
export const BULK_ACTIONS = [
  'fee',
  'paidAccess',
  'usageControl',
  'clearFee',
  'removeAccess',
] as const;
export type BulkAction = (typeof BULK_ACTIONS)[number];

export const DESTRUCTIVE_ACTIONS: readonly BulkAction[] = ['clearFee', 'removeAccess'];

export const BULK_ACTION_TITLE: Record<BulkAction, string> = {
  fee: 'Set licensing fee',
  paidAccess: 'Set early or paid access',
  usageControl: 'Set usage control',
  clearFee: 'Clear licensing fee',
  removeAccess: 'Remove paid access',
};

export const BULK_ACTION_FORM: Record<BulkAction, string> = {
  fee: '?/bulkSetFee',
  paidAccess: '?/bulkSetPaidAccess',
  usageControl: '?/bulkSetUsageControl',
  clearFee: '?/bulkClearFee',
  removeAccess: '?/bulkRemovePaidAccess',
};
