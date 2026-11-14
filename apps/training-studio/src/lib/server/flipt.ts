import { createFliptClient, type FliptFeatureFlags } from '@civitai/flipt';
import { buildFliptContext } from '@civitai/flipt/context';
import type { SessionUser } from '@civitai/auth';
import { KOHYA_FLAG_KEY } from '$lib/data/trainingModels';

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

/** Which per-model catalog gates (`ModelCard.flagKey`) this user may see — the subset of `keys` that
 *  evaluates enabled. Same fail-closed policy as the app gate: a flag that doesn't exist yet, or a Flipt
 *  outage, falls back to moderators-only, so a newly-added model stays dark until its flag is created and
 *  opened. Pass `hostFlagKeys()`; returns [] when nothing is gated. */
export async function allowedModelFlags(user: SessionUser, keys: string[]): Promise<string[]> {
  if (keys.length === 0) return [];
  try {
    const flipt = getFlipt();
    await flipt.ensureInitialized();
    const context = fliptContext(user);
    return keys.filter(
      (key) => flipt.isEnabledSync(key, String(user.id), context) ?? user.isModerator === true
    );
  } catch (error) {
    console.warn('[training-studio] model flag eval failed', error);
    return user.isModerator === true ? [...keys] : [];
  }
}

/** Whether this user may train with Kohya: the `KOHYA_FLAG_KEY` gate, fail-closed like a catalog gate.
 *  The dev-login preview opens it, as it opens every catalog gate. */
export async function isKohyaAllowed(locals: App.Locals): Promise<boolean> {
  if (locals.devPreview) return true;
  return (await allowedModelFlags(locals.user, [KOHYA_FLAG_KEY])).length > 0;
}

/** This user's variant of a variant flag: null when the flag is off, matches no rule, doesn't exist, or
 *  Flipt is unreachable. */
export async function flagVariant(flag: string, user: SessionUser): Promise<string | null> {
  try {
    return await getFlipt().getVariant(flag, String(user.id), fliptContext(user));
  } catch (error) {
    console.warn('[training-studio] variant flag eval failed', flag, error);
    return null;
  }
}

/** Kill switch for Review's wait on dataset files. On unless the flag exists and is off for this user: off
 *  leaves only the submit's own refusal. */
export const UPLOAD_READINESS_FLAG = 'trainingStudioUploadReadiness';

export async function isUploadReadinessOn(user: SessionUser): Promise<boolean> {
  try {
    const flipt = getFlipt();
    await flipt.ensureInitialized();
    return flipt.isEnabledSync(UPLOAD_READINESS_FLAG, String(user.id), fliptContext(user)) ?? true;
  } catch (error) {
    console.warn('[training-studio] upload readiness flag eval failed', error);
    return true;
  }
}
