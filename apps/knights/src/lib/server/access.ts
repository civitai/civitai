import type { SessionUser } from '@civitai/auth';
import { env } from '$env/dynamic/private';
import { decideAccess, parseTesterIds, type Access } from '$lib/access';

export function accessFor(user: SessionUser): Access {
  return decideAccess(user, parseTesterIds(env.KNIGHTS_TESTER_USER_IDS));
}
