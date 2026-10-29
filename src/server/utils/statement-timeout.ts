export function isStatementTimeout(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;

  const { code, message } = error as { code?: unknown; message?: unknown };
  // PostgreSQL uses 57014 for timeouts and user cancellations, so check the message too.
  return code === '57014' && typeof message === 'string' && message.includes('statement timeout');
}
