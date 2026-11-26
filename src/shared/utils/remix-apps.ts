import type { RemixAppDefinition, RemixAppEngine } from '~/shared/constants/remix-apps.constants';
import type { RemixTier } from '~/shared/constants/remix.constants';
import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';
import { getEngineRefusal, getRemixTier, type RemixSourceImage } from '~/shared/utils/remix-tier';

export const REMIX_REFERENCE_UNSCANNED =
  'That image has not finished its safety scan. Pick it again once it has.';

/**
 * The engine this app runs on for this source, or why it can't. Shared so the menu offers exactly
 * the apps the server will run.
 */
export function resolveRemixAppEngine(
  app: Pick<RemixAppDefinition, 'name' | 'engine'>,
  image: RemixSourceImage,
  viewer: { isGreen: boolean; showNsfw: boolean },
  /** Images the viewer handed the app beside the source: checked as it is, and rated with it. */
  references: readonly RemixSourceImage[] = []
): { tier: RemixTier; engine: RemixAppEngine } | { refusal: string } {
  const inputs = [image, ...references];
  // The run is as mature as its most mature input, whichever one that is.
  const tier: RemixTier = inputs.some((input) => getRemixTier(input) === 'mature')
    ? 'mature'
    : 'safe';
  const refusal = inputs.map((input) => getEngineRefusal(input, tier)).find(Boolean);
  if (refusal) return { refusal };
  // Fails closed: unlike the source, a reference never leans on the safe provider's own refusal.
  if (references.some((r) => r.ingestion !== ImageIngestionStatus.Scanned))
    return { refusal: REMIX_REFERENCE_UNSCANNED };
  if (tier === 'mature' && viewer.isGreen)
    return { refusal: 'Mature images cannot be remixed here.' };
  // The output takes the run's tier, and this viewer would never be shown a mature one.
  if (tier === 'mature' && !viewer.showNsfw)
    return { refusal: 'Turn on mature content to remix this image.' };
  const engine = app.engine[tier];
  if (!engine) return { refusal: `${app.name} does not run on mature images.` };
  return { tier, engine };
}
