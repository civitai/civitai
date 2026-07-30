// getClientAddress throws when the adapter can't resolve an address — guard it.
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
