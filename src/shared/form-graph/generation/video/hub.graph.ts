import { z } from 'zod';
import { branch, defFamily, defineGraph } from 'form-graph';
import { VID_QUANTITY_ECOSYSTEMS } from '~/shared/constants/generation.constants';
import { getEcosystemStates } from '../ecosystem-gates';
import { modelSelectorRules } from '../reconcile';
import { ecosystemFieldSchemas, type RootCtx } from '../shared';

import { ltx } from './ltx.graph';
import { seedance } from './seedance.graph';
import { wan } from './wan.graph';
import { grokVideo } from './grok.graph';
import { mochi } from './mochi.graph';
import { sora } from './sora.graph';
import { hunyuan } from './hunyuan.graph';
import { flux3Video } from './flux3-video.graph';
import { minimax } from './minimax.graph';
import { happyHorse } from './happy-horse.graph';
import { veo3 } from './veo3.graph';
import { vidu } from './vidu.graph';
import { kling } from './kling.graph';

/**
 * The VIDEO hub: ecosystem selection scoped to video output, quantity for the
 * video ecosystems that batch, then the family dispatch — a keyed branch
 * whose table types each arm's `ecosystem` as its literal (the model-wins
 * families' own emits then narrow it to the keys they can rewrite to).
 * Workflow and the output/input computeds live on the root (`../hub.graph.ts`).
 */

const QUANTITY = defFamily((max: number) => {
  const snap = (val: number) => Math.min(Math.max(Math.round(val), 1), max);
  return {
    input: z.coerce
      .number()
      .optional()
      .transform((val) => (val === undefined ? undefined : snap(val))),
    output: z.number().min(1).max(max),
    default: 1,
    meta: { min: 1, max, step: 1 },
  };
});

export const videoHub = defineGraph<RootCtx>()
  .field('ecosystem', ({ _ext }) => {
    const { compatibleEcosystems, hiddenEcosystems, ecosystemStates } = getEcosystemStates(
      _ext.workflow,
      _ext
    );
    const disabledSet = new Set(ecosystemStates.map((e) => e.key));
    const usableEcosystems = disabledSet.size
      ? compatibleEcosystems.filter((key) => !disabledSet.has(key))
      : compatibleEcosystems;
    const defaultValue = usableEcosystems.includes('Seedance')
      ? 'Seedance'
      : usableEcosystems[0] ?? compatibleEcosystems[0] ?? 'Seedance';

    return {
      ...ecosystemFieldSchemas(
        _ext.workflow,
        hiddenEcosystems,
        ecosystemStates.map((e) => e.key)
      ),
      default: defaultValue,
      // v1 stores the ecosystem selection per OUTPUT type
      scope: 'video',
      meta: {
        compatibleEcosystems,
        hiddenEcosystems,
        ecosystemStates,
        mediaType: 'video' as const,
      },
      // the SELECTION: shadowed off the wire by the model-wins families'
      // `emit: 'ecosystem'` computeds, which carry the derived backend
    };
  })
  .field('quantity', ({ ecosystem, _ext }) => {
    if (!VID_QUANTITY_ECOSYSTEMS.has(ecosystem)) return null;
    return QUANTITY(_ext.limits.vidQuantity);
  })
  .use(
    // one entry per family, however many ecosystems it serves — the keys
    // type each arm's `ecosystem` literal
    branch('ecosystem', [
      [
        [
          'WanVideo',
          'WanVideo14B_T2V',
          'WanVideo14B_I2V_720p',
          'WanVideo14B_I2V_480p',
          'WanVideo-22-T2V-A14B',
          'WanVideo-22-I2V-A14B',
          'WanVideo-22-TI2V-5B',
          'WanVideo-25-T2V',
          'WanVideo-25-I2V',
          'WanVideo27',
          'WanVideo30',
        ],
        wan,
      ],
      [['LTXV2', 'LTXV23', 'LTXV25'], ltx],
      [['Seedance'], seedance],
      [['Grok'], grokVideo],
      [['Mochi'], mochi],
      [['Sora2'], sora],
      [['HyV1'], hunyuan],
      [['Flux3Video'], flux3Video],
      [['MiniMaxH3'], minimax],
      [['HappyHorse'], happyHorse],
      [['Veo3'], veo3],
      [['Vidu'], vidu],
      [['Kling'], kling],
    ] as const)
  )
  // interactive model picks reconcile selectors the same way the parse boundary does
  .effect(modelSelectorRules);

export type VideoState = ReturnType<typeof videoHub.resolve>;
