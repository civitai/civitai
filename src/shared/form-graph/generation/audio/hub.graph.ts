import { z } from 'zod';
import { branch, defineGraph } from 'form-graph';
import { getEcosystemStates, resolveCompatibleEcosystem } from '../ecosystem-gates';
import type { RootCtx, FamilyExt } from '../shared';

import { ace } from './ace.graph';
import { minimaxMusic } from './minimax-music.graph';

/**
 * The AUDIO hub: ecosystem selection scoped to audio output, then the family
 * dispatch. No quantity/priority/outputFormat — those are image (or partly
 * video) concerns in the oracle. Workflow and the output/input computeds live
 * on the root (`../hub.graph.ts`).
 */

/** Which family graph owns an ecosystem. Untagged: the oracle has no family key. */
const families = branch((ext: FamilyExt) => {
  switch (ext.ecosystem) {
    case 'MiniMaxMusic3':
      return minimaxMusic;
    case 'Ace':
    default:
      return ace;
  }
});

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
      scope: 'audio',
      meta: {
        compatibleEcosystems,
        hiddenEcosystems,
        ecosystemStates,
        mediaType: 'audio',
      },
    };
  })
  .use(families);

export type AudioState = ReturnType<typeof audioHub.resolve>;
