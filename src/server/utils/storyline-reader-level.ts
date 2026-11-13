import type { Context } from '~/server/createContext';
import { resolveRequestBrowsingLevels, viewerBrowsingLevel } from '~/server/utils/browsing-level';
import { allBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';

/**
 * The level a storyline read is served at: the reader's own when they sent none, held to the
 * domain cap (signed out or on the SFW domain), with the SFW-domain backstop on top.
 */
export function storylineReaderLevel(
  ctx: Pick<Context, 'user' | 'features' | 'req'>,
  requested: number | undefined
) {
  const levels = { browsingLevel: requested };
  resolveRequestBrowsingLevels(levels, ctx);
  // Undefined only where nothing caps the request and nothing was asked for.
  return viewerBrowsingLevel(ctx as Context, levels.browsingLevel ?? allBrowsingLevelsFlag);
}
