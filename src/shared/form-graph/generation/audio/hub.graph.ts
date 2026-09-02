import { z } from 'zod';
import { branch, defineGraph } from 'form-graph';
import { ecosystemByKey } from '~/shared/constants/basemodel.constants';
import { getEcosystemStates, resolveCompatibleEcosystem } from '../ecosystem-gates';
import type { RootCtx } from '../shared';

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
    const hiddenSet = new Set(hiddenEcosystems);
    const disabledSet = new Set(ecosystemStates.map((e) => e.key));
    const usableEcosystems = disabledSet.size
      ? compatibleEcosystems.filter((key) => !disabledSet.has(key))
      : compatibleEcosystems;
    const defaultValue = usableEcosystems.includes('Ace')
      ? 'Ace'
      : usableEcosystems[0] ?? compatibleEcosystems[0] ?? 'Ace';

    return {
      input: z
        .string()
        .optional()
        .transform((v) => {
          if (!v) return undefined;
          // an unknown key would have no member graph — fall to the default,
          // like a hidden one; disabled/memberOnly are kept for the picker
          // and refused on output
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
