export function isStatementTimeout(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;

  const { code, message } = error as { code?: unknown; message?: unknown };
  // @ai: PostgreSQL also uses 57014 for user cancellations; distinguish them by the message.
  return code === '57014' && typeof message === 'string' && message.includes('statement timeout');
}
