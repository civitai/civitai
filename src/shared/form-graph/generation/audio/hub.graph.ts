import { branch, defineGraph } from 'form-graph';
import { getEcosystemField } from '../ecosystem-gates';
import { ecosystemFieldSchemas, type RootCtx } from '../shared';

import { ace } from './ace.graph';
import { minimaxMusic } from './minimax-music.graph';
import { yue2 } from './yue2.graph';
import { sonilo } from './sonilo.graph';

/**
 * The AUDIO hub: ecosystem selection scoped to audio output, then the family
 * dispatch — a keyed branch whose table types each arm's `ecosystem` as its
 * literal. No quantity/priority/outputFormat — those are image and video
 * concerns only. Workflow and the output/input computeds live
 * on the root (`../hub.graph.ts`).
 */

export const audioHub = defineGraph<RootCtx>()
  .field('ecosystem', ({ _ext }) => {
    const {
      compatibleEcosystems,
      hiddenEcosystems,
      ecosystemStates,
      gatedKeys,
      usableEcosystems,
      defaultEcosystem,
    } = getEcosystemField(_ext.workflow, _ext, { preferred: 'Ace' });

    return {
      ...ecosystemFieldSchemas(_ext.workflow, hiddenEcosystems, gatedKeys, usableEcosystems),
      default: defaultEcosystem,
      // The ecosystem selection is stored per OUTPUT type.
      scope: 'audio',
      meta: {
        compatibleEcosystems,
        hiddenEcosystems,
        ecosystemStates,
        usableEcosystems,
        defaultEcosystem,
        mediaType: 'audio' as const,
      },
    };
  })
  .use(
    branch('ecosystem', [
      [['Ace'], ace],
      [['MiniMaxMusic3'], minimaxMusic],
      [['YuE2'], yue2],
      [['Sonilo'], sonilo],
    ] as const)
  );

export type AudioState = ReturnType<typeof audioHub.resolve>;
