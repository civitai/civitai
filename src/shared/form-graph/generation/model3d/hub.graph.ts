import { z } from 'zod';
import { branch, defineGraph } from 'form-graph';
import { ecosystemByKey } from '~/shared/constants/basemodel.constants';
import { getEcosystemStates, resolveCompatibleEcosystem } from '../ecosystem-gates';
import type { RootCtx } from '../shared';

import { polygen } from './polygen.graph';
import { tripo } from './tripo.graph';
import { hunyuan3d } from './hunyuan3d.graph';
import { pixal3d, trellis2 } from './trellis-family.graph';

/**
 * The MODEL3D hub: ecosystem selection scoped to model3d output, dispatching
 * to the family graphs via a keyed branch — the table keys type each arm's
 * `ecosystem` as its literal. No quantity/priority/outputFormat — those are
 * image (or partly video) concerns in the oracle. Workflow and the
 * output/input computeds live on the root (`../hub.graph.ts`).
 */

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
          // an unknown key would have no member graph — fall to the default,
          // like a hidden one; disabled/memberOnly are kept for the picker and
          // refused on output
          if (!ecosystemByKey.has(v) || hiddenSet.has(v)) return undefined;
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
        mediaType: 'model3d' as const,
      },
    };
  })
  .use(
    branch('ecosystem', [
      [['PolyGen'], polygen],
      [['Tripo'], tripo],
      [['Hunyuan3D'], hunyuan3d],
      [['Pixal3D'], pixal3d],
      [['Trellis2'], trellis2],
    ] as const)
  );

export type Model3dState = ReturnType<typeof model3dHub.resolve>;
