import { timingSafeEqual } from 'node:crypto';
import { env } from '$env/dynamic/private';

export const JOBS_PATH_PREFIX = '/api/jobs/';

/** Scheduler calls carry `Authorization: Bearer <JOBS_TOKEN>`. Closed when no token is configured. */
export function isJobRequest(request: Request): boolean {
  const expected = env.JOBS_TOKEN;
  if (!expected) return false;
  const [scheme, presented] = (request.headers.get('authorization') ?? '').split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
