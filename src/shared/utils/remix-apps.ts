import type { RemixAppDefinition, RemixAppEngine } from '~/shared/constants/remix-apps.constants';
import type { RemixTier } from '~/shared/constants/remix.constants';
import { getEngineRefusal, getRemixTier, type RemixSourceImage } from '~/shared/utils/remix-tier';

/**
 * The engine this app runs on for this source, or why it can't. Shared so the menu offers exactly
 * the apps the server will run.
 */
export function resolveRemixAppEngine(
  app: RemixAppDefinition,
  image: RemixSourceImage,
  viewer: { isGreen: boolean; showNsfw: boolean }
): { tier: RemixTier; engine: RemixAppEngine } | { refusal: string } {
  const refusal = getEngineRefusal(image);
  if (refusal) return { refusal };
  const tier = getRemixTier(image);
  if (tier === 'mature' && viewer.isGreen)
    return { refusal: 'Mature images cannot be remixed here.' };
  // The output of a mature source is mature, and this viewer would never be shown it.
  if (tier === 'mature' && !viewer.showNsfw)
    return { refusal: 'Turn on mature content to remix this image.' };
  const engine = app.engine[tier];
  if (!engine) return { refusal: `${app.name} does not run on mature images.` };
  return { tier, engine };
}
