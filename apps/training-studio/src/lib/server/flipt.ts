import { createFliptClient, type FliptFeatureFlags } from '@civitai/flipt';
import { buildFliptContext } from '@civitai/flipt/context';
import type { SessionUser } from '@civitai/auth';

// App shim around @civitai/flipt. Reads FLIPT_URL + FLIPT_FETCHER_SECRET from process.env (the vite.config
// shim bridges .env → process.env). Lazily constructed on first evaluation (so `vite build` never
// instantiates it) and cached on globalThis (dev HMR reuse). An unconfigured deploy degrades to every flag
// off rather than failing to boot.
const g = globalThis as unknown as { tsFlipt?: FliptFeatureFlags };

function getFlipt(): FliptFeatureFlags {
  if (!g.tsFlipt) {
    g.tsFlipt = createFliptClient({
      onInitError: (error) => console.warn('[training-studio] flipt init error', error),
    });
  }
  return g.tsFlipt;
}

// 🔴 Every evaluation must pass this. Segment constraints match on context properties, not the entity id,
// so a context-less call matches no segment and returns the flag's base `enabled` — false for a segmented
// flag. Omitting it silently closes the beta to everyone.
function fliptContext(user: SessionUser): Record<string, string> {
  return buildFliptContext(user);
}

/** The closed-beta gate. Create/segment this flag in the `civitai-app` Flipt environment to open the app to
 *  a cohort. Until the flag exists there, evaluation is null and the app is moderators-only (ships dark). */
export const TRAINING_STUDIO_FLAG = 'trainingStudio';

/** Whether this user may use Training Studio. Flag present → Flipt segment is authoritative; flag absent (or
 *  a Flipt outage) → moderators only, so the closed beta never opens to everyone by accident. */
export async function isTrainingStudioAllowed(user: SessionUser): Promise<boolean> {
  try {
    const flipt = getFlipt();
    await flipt.ensureInitialized();
    const evaluated = flipt.isEnabledSync(
      TRAINING_STUDIO_FLAG,
      String(user.id),
      fliptContext(user)
    );
    return evaluated ?? user.isModerator === true;
  } catch (error) {
    console.warn('[training-studio] closed-beta gate eval failed', error);
    return user.isModerator === true;
  }
}
