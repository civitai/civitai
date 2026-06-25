import { error } from '@sveltejs/kit';

// Small shared request helpers so the auth route handlers (switch / impersonate / refresh) follow one shape.

/** Parse `{ userId }` from a JSON body; throws a 400 if it's missing or non-numeric. */
export async function readUserId(request: Request): Promise<number> {
  let body: { userId?: unknown };
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const userId = Number(body.userId);
  if (!Number.isFinite(userId)) error(400, 'bad userId');
  return userId;
}

/** The Bearer token from the Authorization header, or '' if absent. */
export function bearerToken(request: Request): string {
  const header = request.headers.get('authorization') ?? '';
  return /^bearer /i.test(header) ? header.slice(7).trim() : '';
}
