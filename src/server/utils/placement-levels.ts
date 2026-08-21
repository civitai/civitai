import type { Context } from '~/server/createContext';
import {
  allBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';

/**
 * What the viewer may see, with the SFW domain applied.
 *
 * The level itself is client-supplied, as it is for every image listing. The
 * clamp is not a second opinion about the viewer's preference — it is the
 * domain's rule, and a placement surface shows content the host creator did not
 * choose, so it cannot inherit the host image's own admissibility.
 */
export const viewerBrowsingLevel = (ctx: Context, requested: number) =>
  ctx.features.isGreen ? requested & sfwBrowsingLevelsFlag : requested;

/**
 * What this domain may be SENT, as opposed to what the viewer asked for.
 *
 * The review queues carry no browsing level by design — an owner has to see what
 * is waiting on them whatever their own settings say — which makes them the one
 * path that hands an above-ceiling asset to a SFW client. Blur is not that
 * control: it is built from the viewer's own level and never reads the domain's.
 */
export const domainServableLevels = (ctx: Context) =>
  ctx.features.isGreen ? sfwBrowsingLevelsFlag : allBrowsingLevelsFlag;
