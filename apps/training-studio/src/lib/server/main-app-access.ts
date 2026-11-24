import { logToAxiom } from './axiom';
import { mainAppSessionOrigin } from './main-app';

const TIMEOUT_MS = 10_000;

/** The Studio routes the main app's embed forwards to this server (see its /api/training-studio/studio). */
export const EMBED_FORWARDED_PATHS: ReadonlySet<string> = new Set([
  '/api/train',
  '/api/continue-training',
  '/api/dataset-rating',
  '/api/edit-image',
  '/api/suggest-instruction',
  '/api/epoch-archive',
  '/api/license',
]);

/**
 * Whether the main app lets this user use the Training Studio it embeds, asked as the user with
 * their forwarded session cookie. Only an explicit `{ ok: true }` counts; anything else, including a
 * failed request, is no.
 */
export async function mainAppAllowsEmbed(cookie: string, userId: number): Promise<boolean> {
  try {
    const res = await fetch(`${mainAppSessionOrigin()}/api/training-studio/access`, {
      headers: { cookie },
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => null)) as { ok?: unknown } | null;
    return res.ok && body?.ok === true;
  } catch (err) {
    logToAxiom({
      name: 'training-studio-embed-access',
      type: 'error',
      userId,
      message: (err as Error)?.message,
    });
    return false;
  }
}
