import { z } from 'zod';
import { branch, defineGraph, rootScope } from 'form-graph';
import {
  getEcosystemStates,
  resolveCompatibleEcosystem,
  supportsEnhancedCompatibility,
  supportsSdcpp,
} from '../ecosystem-gates';
import { boolDef, quantityDef } from '../defs';
import { modelSelectorRules } from '../reconcile';
import { familyScope, type FamilyExt, type RootCtx } from '../shared';

import { chroma } from './chroma.graph';
import { flux } from './flux.graph';
import { fluxKontext } from './flux-kontext.graph';
import { flux2 } from './flux2.graph';
import { flux2Klein } from './flux2-klein.graph';
import { boogu } from './boogu.graph';
import { krea2 } from './krea2.graph';
import { imagen4 } from './imagen4.graph';
import { ponyV7 } from './pony-v7.graph';
import { reve } from './reve.graph';
import { mai } from './mai.graph';
import { ernie } from './ernie.graph';
import { seedream } from './seedream.graph';
import { anima } from './anima.graph';
import { mageFlow } from './mage-flow.graph';
import { hiDream } from './hi-dream.graph';
import { hiDreamO1 } from './hi-dream-o1.graph';
import { openai } from './openai.graph';
import { lens } from './lens.graph';
import { qwen } from './qwen.graph';
import { nanoBanana } from './nano-banana.graph';
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
    case 'Flux1':
    case 'FluxKrea':
      return flux;
    case 'Flux1Kontext':
      return fluxKontext;
    case 'Flux2':
      return flux2;
    case 'Flux2Klein_9B':
    case 'Flux2Klein_9B_base':
    case 'Flux2Klein_4B':
    case 'Flux2Klein_4B_base':
      return flux2Klein;
    case 'Boogu':
      return boogu;
    case 'Krea2':
      return krea2;
    case 'Imagen4':
      return imagen4;
    case 'PonyV7':
      return ponyV7;
    case 'Reve':
      return reve;
    case 'MAI':
      return mai;
    case 'Ernie':
      return ernie;
    case 'Seedream':
      return seedream;
    case 'Anima':
      return anima;
    case 'MageFlow':
      return mageFlow;
    case 'HiDream':
      return hiDream;
    case 'HiDream-O1':
      return hiDreamO1;
    case 'OpenAI':
      return openai;
    case 'Lens':
      return lens;
    case 'Qwen':
    case 'Qwen2':
    case 'Qwen3':
      return qwen;
    case 'NanoBanana':
      return nanoBanana;
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
      // v1 stores the ecosystem selection per OUTPUT type
      scope: 'image',
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
    const options: {
      label: string;
      value: (typeof priorityOptions)[number];
      offset: number;
      lineThrough?: boolean;
      memberOnly?: boolean;
    }[] = isMember
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
              { label: 'JPEG', value: 'jpeg' as const, offset: 0 },
              { label: 'PNG', value: 'png' as const, offset: 2 },
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
      ? { ...boolDef(false), scope: familyScope({ ecosystem }) }
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
    // draft's 4-step quantity gets its own bucket (v1's conditional group);
    // everywhere else quantity is global
    return {
      ...quantityDef({ max: _ext.limits.maxQuantity, step }),
      scope: isDraft ? rootScope(_ext.workflow) : rootScope(),
    };
  })
  // interactive model picks reconcile selectors the same way the parse boundary does
  .effect(modelSelectorRules);

export type ImageState = ReturnType<typeof imageHub.resolve>;
