import { z } from 'zod';
import { branch, defineGraph } from 'form-graph';
import {
  getEcosystemStates,
  resolveCompatibleEcosystem,
  supportsEnhancedCompatibility,
  supportsSdcpp,
} from '../ecosystem-gates';
import { boolDef, quantityDef } from '../defs';
import type { FamilyExt, RootCtx } from '../shared';

import { chroma } from './chroma.graph';
import { sd } from './sd.graph';
import { zimage } from './zimage.graph';

/**
 * The IMAGE hub: ecosystem selection scoped to image output, the image-only
 * head fields (`priority`, `outputFormat`), the family dispatch, and the two
 * fields the oracle declares AFTER its family discriminator because they read
 * family state (`enhancedCompatibility` reads the model; `quantity` reads
 * both). Workflow and the output/input computeds live on the root (`../hub.ts`).
 */

// Copied from generation-graph.ts, which dies with the data-graph engine.
const priorityOptions = ['low', 'normal', 'high'] as const;
const outputFormatOptions = ['jpeg', 'png'] as const;

/** Untagged: the oracle has no family key in data. */
const families = branch((ext: FamilyExt) => {
  switch (ext.ecosystem) {
    case 'ZImageTurbo':
    case 'ZImageBase':
      return zimage;
    case 'Chroma':
      return chroma;
    case 'SD1':
    case 'SD2':
    case 'SDXL':
    case 'Pony':
    case 'Illustrious':
    case 'NoobAI':
    default:
      return sd;
  }
});

export const imageHub = defineGraph<RootCtx>()
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
    const defaultValue = usableEcosystems.includes('ZImageTurbo')
      ? 'ZImageTurbo'
      : usableEcosystems[0] ?? compatibleEcosystems[0] ?? 'SDXL';

    return {
      input: z
        .string()
        .optional()
        .transform((v) => {
          if (!v) return undefined;
          // Hidden values are dropped at the boundary so a stale stored value
          // falls back to the default; disabled/memberOnly are kept so the
          // picker can explain them, and refused on output. A value that
          // doesn't support the workflow redirects to the workflow's default
          // (v1's sync effect).
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
      meta: {
        compatibleEcosystems,
        hiddenEcosystems,
        ecosystemStates,
        mediaType: 'image',
      },
    };
  })
  .field('priority', ({ _ext }) => {
    const isMember = _ext.user?.isMember ?? false;
    const options = isMember
      ? [
          { label: 'High', value: 'low', offset: 10, lineThrough: true },
          { label: 'Highest', value: 'high', offset: 20 },
        ]
      : [
          { label: 'Standard', value: 'low', offset: 0 },
          { label: 'High', value: 'normal', offset: 10 },
          { label: 'Highest', value: 'high', offset: 20, memberOnly: true },
        ];
    return {
      input: z
        .enum(priorityOptions)
        .optional()
        .transform((val) => (!isMember && val === 'high' ? ('low' as const) : val)),
      output: z.enum(priorityOptions),
      default: 'low' as const,
      meta: { options, isMember },
    };
  })
  .field('outputFormat', ({ _ext }) =>
    _ext.workflow === 'img2img:remove-background'
      ? null
      : {
          input: z.enum(outputFormatOptions).optional(),
          output: z.enum(outputFormatOptions),
          default: 'jpeg' as const,
          meta: {
            options: [
              { label: 'JPEG', value: 'jpeg', offset: 0 },
              { label: 'PNG', value: 'png', offset: 2 },
            ],
            isMember: _ext.user?.isMember ?? false,
          },
        }
  )
  .use(families)
  // Both read the family's DERIVED ecosystem where one exists (v1 reads its
  // conflated key after the checkpoint effect has moved it); families without
  // a derivation declare nothing and the selection stands.
  .field('enhancedCompatibility', ({ model, effectiveEcosystem, ecosystem, _ext }) =>
    _ext.workflow === 'txt2img' &&
    supportsEnhancedCompatibility(effectiveEcosystem ?? ecosystem, model?.id)
      ? boolDef(false)
      : null
  )
  .field('quantity', ({ model, effectiveEcosystem, ecosystem, enhancedCompatibility, _ext }) => {
    const isDraft = _ext.workflow === 'txt2img:draft';
    const bogoActive =
      !!_ext.flags?.enhancedCompatibilitySdcpp &&
      _ext.workflow === 'txt2img' &&
      supportsSdcpp(effectiveEcosystem ?? ecosystem, model?.id) &&
      enhancedCompatibility !== true;
    const step = isDraft ? 4 : bogoActive ? 2 : 1;
    return quantityDef({ max: _ext.limits.maxQuantity, step });
  });

export type ImageState = ReturnType<typeof imageHub.resolve>;
