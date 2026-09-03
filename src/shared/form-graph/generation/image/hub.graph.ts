import { branch, defineGraph, rootScope } from 'form-graph';
import {
  getEcosystemStates,
  supportsEnhancedCompatibility,
  supportsSdcpp,
} from '../ecosystem-gates';
import { boolDef, quantityDef } from '../defs';
import { modelSelectorRules } from '../reconcile';
import { ecosystemFieldSchemas, familyScope, type RootCtx } from '../shared';

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
import { museImage } from './muse-image.graph';
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
import { wanImage } from './wan-image.graph';
import { grokImage } from './grok.graph';
import { sd } from './sd.graph';
import { zimage } from './zimage.graph';

/**
 * The IMAGE hub: ecosystem selection scoped to image output, the image-only
 * family dispatch (a keyed branch whose table types each arm) and the two
 * fields the oracle declares AFTER its family discriminator because they read
 * family state (`enhancedCompatibility` reads the model; `quantity` reads
 * both). Workflow and the output/input computeds live on the root
 * (`../hub.graph.ts`).
 */

export const imageHub = defineGraph<RootCtx>()
  .field('ecosystem', ({ _ext }) => {
    const { compatibleEcosystems, hiddenEcosystems, ecosystemStates } = getEcosystemStates(
      _ext.workflow,
      _ext
    );
    const disabledSet = new Set(ecosystemStates.map((e) => e.key));
    const usableEcosystems = disabledSet.size
      ? compatibleEcosystems.filter((key) => !disabledSet.has(key))
      : compatibleEcosystems;
    const defaultValue = usableEcosystems.includes('ZImageTurbo')
      ? 'ZImageTurbo'
      : usableEcosystems[0] ?? compatibleEcosystems[0] ?? 'SDXL';

    return {
      ...ecosystemFieldSchemas(
        _ext.workflow,
        hiddenEcosystems,
        ecosystemStates.map((e) => e.key)
      ),
      default: defaultValue,
      // v1 stores the ecosystem selection per OUTPUT type
      scope: 'image',
      meta: {
        compatibleEcosystems,
        hiddenEcosystems,
        ecosystemStates,
        mediaType: 'image' as const,
      },
    };
  })
  .use(
    // one entry per family, however many ecosystems it serves — the keys
    // type each arm's `ecosystem` literal
    branch('ecosystem', [
      [['SD1', 'SD2', 'SDXL', 'Pony', 'Illustrious', 'NoobAI'], sd],
      [['ZImageTurbo', 'ZImageBase'], zimage],
      [['Chroma'], chroma],
      [['Flux1', 'FluxKrea'], flux],
      [['Flux1Kontext'], fluxKontext],
      [['Flux2'], flux2],
      [['Flux2Klein_9B', 'Flux2Klein_9B_base', 'Flux2Klein_4B', 'Flux2Klein_4B_base'], flux2Klein],
      [['Boogu'], boogu],
      [['Krea2'], krea2],
      [['Imagen4'], imagen4],
      [['PonyV7'], ponyV7],
      [['Reve'], reve],
      [['MuseImage'], museImage],
      [['MAI'], mai],
      [['Ernie'], ernie],
      [['Seedream'], seedream],
      [['Anima'], anima],
      [['MageFlow'], mageFlow],
      [['HiDream'], hiDream],
      [['HiDream-O1'], hiDreamO1],
      [['OpenAI'], openai],
      [['Lens'], lens],
      [['Qwen', 'Qwen2', 'Qwen3'], qwen],
      [['NanoBanana'], nanoBanana],
      [['WanImage27'], wanImage],
      [['Grok'], grokImage],
    ] as const)
  )
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
