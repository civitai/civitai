import { branch, defineGraph } from 'form-graph';
import { getEcosystemStates } from '../ecosystem-gates';
import { ecosystemFieldSchemas, type RootCtx } from '../shared';

import { ace } from './ace.graph';
import { minimaxMusic } from './minimax-music.graph';

/**
 * The AUDIO hub: ecosystem selection scoped to audio output, then the family
 * dispatch — a keyed branch whose table types each arm's `ecosystem` as its
 * literal. No quantity/priority/outputFormat — those are image (or partly
 * video) concerns in the oracle. Workflow and the output/input computeds live
 * on the root (`../hub.graph.ts`).
 */

export const audioHub = defineGraph<RootCtx>()
  .field('ecosystem', ({ _ext }) => {
    const { compatibleEcosystems, hiddenEcosystems, ecosystemStates } = getEcosystemStates(
      _ext.workflow,
      _ext
    );
    const disabledSet = new Set(ecosystemStates.map((e) => e.key));
    const usableEcosystems = disabledSet.size
      ? compatibleEcosystems.filter((key) => !disabledSet.has(key))
      : compatibleEcosystems;
    const defaultValue = usableEcosystems.includes('Ace')
      ? 'Ace'
      : usableEcosystems[0] ?? compatibleEcosystems[0] ?? 'Ace';

    return {
      ...ecosystemFieldSchemas(
        _ext.workflow,
        hiddenEcosystems,
        ecosystemStates.map((e) => e.key)
      ),
      default: defaultValue,
      // v1 stores the ecosystem selection per OUTPUT type
      scope: 'audio',
      meta: {
        compatibleEcosystems,
        hiddenEcosystems,
        ecosystemStates,
        mediaType: 'audio' as const,
      },
    };
  })
  .use(
    branch('ecosystem', [
      [['Ace'], ace],
      [['MiniMaxMusic3'], minimaxMusic],
    ] as const)
  );

export type AudioState = ReturnType<typeof audioHub.resolve>;
