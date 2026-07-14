// Moderator request provenance for analytics rows (e.g. the DeleteTOS ClickHouse event). getClientAddress
// throws when the adapter can't resolve an address, so guard it; both fields fall back to 'unknown' at the
// ClickHouse layer when undefined.
export function getActorMeta(event: {
  request: Request;
  getClientAddress: () => string;
}): { ip?: string; userAgent?: string } {
  let ip: string | undefined;
  try {
    ip = event.getClientAddress();
  } catch {
    ip = undefined;
  }
  return { ip, userAgent: event.request.headers.get('user-agent') ?? undefined };
}
