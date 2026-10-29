import { createFliptClient, type FliptFeatureFlags } from '@civitai/flipt';
import { buildFliptContext, type FliptTargetUser } from '@civitai/flipt/context';
import type { SessionUser } from '@civitai/auth';
import { decideAccess, type Access } from '$lib/access';

/** Rollout flag for the app. Open it to a cohort via the `testers` segment in the `civitai-app` Flipt
 *  environment; until it exists there the app is moderators-only. */
export const KNIGHTS_APP_FLAG = 'knights-of-new-order-app';

// Lazily built on first evaluation so `vite build` never instantiates it; cached on globalThis for dev HMR.
const g = globalThis as unknown as { knightsFlipt?: FliptFeatureFlags };

function getFlipt(): FliptFeatureFlags {
  g.knightsFlipt ??= createFliptClient({
    onInitError: (error) => console.warn('[knights] flipt init error', error),
  });
  return g.knightsFlipt;
}

// Segments match on context properties, not the entity id; a context-less call matches no segment.
async function isFlagOn(user: FliptTargetUser): Promise<boolean> {
  try {
    const flipt = getFlipt();
    await flipt.ensureInitialized();
    return flipt.isEnabledSync(KNIGHTS_APP_FLAG, String(user.id), buildFliptContext(user)) === true;
  } catch (error) {
    console.warn('[knights] access flag eval failed', error);
    return false;
  }
}

export async function accessFor(user: SessionUser): Promise<Access> {
  const isModerator = user.isModerator === true;
  return decideAccess({ isModerator, flagOn: isModerator ? false : await isFlagOn(user) });
}

/**
 * The ids among `users` that `accessFor` would let in, without a session. Flipt evaluates locally, so a
 * batch costs no network call per user. The context carries only the id and moderator status, so a
 * segment that matches on tier or early-adopter status does not see those users here: they are skipped,
 * never notified by mistake.
 */
export async function accessibleIds(
  users: { id: number; isModerator: boolean }[]
): Promise<number[]> {
  const open: number[] = [];
  for (const user of users) {
    const flagOn = user.isModerator ? false : await isFlagOn({ id: user.id });
    if (decideAccess({ isModerator: user.isModerator, flagOn }) === 'allow') open.push(user.id);
  }
  return open;
}
