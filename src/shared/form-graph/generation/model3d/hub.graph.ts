import { branch, defineGraph } from 'form-graph';
import { getEcosystemField } from '../ecosystem-gates';
import { ecosystemFieldSchemas, type RootCtx } from '../shared';

import { polygen } from './polygen.graph';
import { tripo } from './tripo.graph';
import { hunyuan3d } from './hunyuan3d.graph';
import { pixal3d, trellis2 } from './trellis-family.graph';

/**
 * The MODEL3D hub: ecosystem selection scoped to model3d output, dispatching
 * to the family graphs via a keyed branch — the table keys type each arm's
 * `ecosystem` as its literal. No quantity/priority/outputFormat — those are
 * image and video concerns only. Workflow and the
 * output/input computeds live on the root (`../hub.graph.ts`).
 */

export const model3dHub = defineGraph<RootCtx>()
  .field('ecosystem', ({ _ext }) => {
    const {
      compatibleEcosystems,
      hiddenEcosystems,
      ecosystemStates,
      gatedKeys,
      usableEcosystems,
      defaultEcosystem,
    } = getEcosystemField(_ext.workflow, _ext, { preferred: 'PolyGen' });

    return {
      ...ecosystemFieldSchemas(_ext.workflow, hiddenEcosystems, gatedKeys, usableEcosystems),
      default: defaultEcosystem,
      // The ecosystem selection is stored per OUTPUT type.
      scope: 'model3d',
      meta: {
        compatibleEcosystems,
        hiddenEcosystems,
        ecosystemStates,
        usableEcosystems,
        defaultEcosystem,
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
