import { branch, defineGraph } from 'form-graph';
import { getEcosystemStates } from '../ecosystem-gates';
import { ecosystemFieldSchemas, type RootCtx } from '../shared';

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
    const disabledSet = new Set(ecosystemStates.map((e) => e.key));
    const usableEcosystems = disabledSet.size
      ? compatibleEcosystems.filter((key) => !disabledSet.has(key))
      : compatibleEcosystems;
    const defaultValue = usableEcosystems.includes('PolyGen')
      ? 'PolyGen'
      : usableEcosystems[0] ?? compatibleEcosystems[0] ?? 'PolyGen';

    return {
      ...ecosystemFieldSchemas(
        _ext.workflow,
        hiddenEcosystems,
        ecosystemStates.map((e) => e.key)
      ),
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
