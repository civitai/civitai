import { z } from 'zod';
import { branch, defineGraph } from 'form-graph';
import { getEcosystemStates, resolveCompatibleEcosystem } from '../ecosystem-gates';
import type { RootCtx, FamilyExt } from '../shared';

import { polygen } from './polygen.graph';
import { tripo } from './tripo.graph';
import { hunyuan3d } from './hunyuan3d.graph';
import { pixal3d, trellis2 } from './trellis-family.graph';

/**
 * The MODEL3D hub: ecosystem selection scoped to model3d output, then the
 * family dispatch. No quantity/priority/outputFormat — those are image (or
 * partly video) concerns in the oracle. Workflow and the output/input
 * computeds live on the root (`../hub.graph.ts`).
 */

/** Which family graph owns an ecosystem. Untagged: the oracle has no family key. */
const families = branch((ext: FamilyExt) => {
  switch (ext.ecosystem) {
    case 'Tripo':
      return tripo;
    case 'Hunyuan3D':
      return hunyuan3d;
    case 'Pixal3D':
      return pixal3d;
    case 'Trellis2':
      return trellis2;
    case 'PolyGen':
    default:
      return polygen;
  }
});

export const model3dHub = defineGraph<RootCtx>()
  .field('ecosystem', ({ _ext }) => {
    const { compatibleEcosystems, hiddenEcosystems, ecosystemStates } = getEcosystemStates(
      _ext.workflow,
      _ext
    );
    const hiddenSet = new Set(hiddenEcosystems);
    const disabledSet = new Set(ecosystemStates.map((e) => e.key));
    const usableEcosystems = disabledSet.size
      ? compatibleEcosystems.filter((key) => !disabledSet.has(key))
      : compatibleEcosystems;
    const defaultValue = usableEcosystems.includes('PolyGen')
      ? 'PolyGen'
      : usableEcosystems[0] ?? compatibleEcosystems[0] ?? 'PolyGen';

    return {
      input: z
        .string()
        .optional()
        .transform((v) => {
          if (!v) return undefined;
          if (hiddenSet.has(v)) return undefined;
          return resolveCompatibleEcosystem(_ext.workflow, v);
        }),
      output:
        hiddenSet.size || disabledSet.size
          ? z.string().refine((v) => !hiddenSet.has(v) && !disabledSet.has(v), {
              message: 'Ecosystem is currently unavailable',
            })
          : z.string(),
      default: defaultValue,
      // v1 stores the ecosystem selection per OUTPUT type
      scope: 'model3d',
      meta: {
        compatibleEcosystems,
        hiddenEcosystems,
        ecosystemStates,
        mediaType: 'model3d',
      },
    };
  })
  .use(families);

export type Model3dState = ReturnType<typeof model3dHub.resolve>;
