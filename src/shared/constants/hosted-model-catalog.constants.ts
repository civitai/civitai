import { ECO } from '~/shared/constants/basemodel.constants';

/**
 * Curated hosted (single-model, API-only) generators, matched by capability for block callers that
 * recommend resources. These ecosystems have no add-ons, so the add-on/checkpoint lists never
 * surface them. Deliberately separate from `ECOSYSTEM_SEO`: that copy is written for SEO pages, and
 * this list is matched against programmatically, so neither should move when the other is edited.
 */

/** `high_resolution` means a claimed native output of at least 2048 px on a side. */
export const HOSTED_MODEL_CAPABILITIES = [
  'legible_text',
  'design_layout',
  'photoreal',
  'image_editing',
  'character_consistency',
  'high_resolution',
  'transparent_background',
  'reference_images',
] as const;
export type HostedModelCapability = (typeof HOSTED_MODEL_CAPABILITIES)[number];

export type HostedModelCatalogEntry = {
  ecosystemId: number;
  name: string;
  maker: string;
  modelId: number;
  goodAt: string;
  capabilities: readonly HostedModelCapability[];
};

// Array order is the tie-break when two entries match the same number of needs.
export const HOSTED_MODEL_CATALOG: readonly HostedModelCatalogEntry[] = [
  {
    ecosystemId: ECO.OpenAI,
    name: 'GPT Image',
    maker: 'OpenAI',
    modelId: 1532032,
    goodAt:
      'Follows plain-English prompts, renders text inside an image better than most, and edits a picture you supply.',
    capabilities: ['legible_text', 'image_editing'],
  },
  {
    ecosystemId: ECO.NanoBanana,
    name: 'Nano Banana',
    maker: 'Google',
    modelId: 1903424,
    goodAt:
      "Keeps a subject's likeness across edits to outfit, hair or setting, and also does text-to-image.",
    capabilities: ['character_consistency', 'image_editing'],
  },
  {
    ecosystemId: ECO.Seedream,
    name: 'Seedream',
    maker: 'ByteDance',
    modelId: 1951069,
    goodAt:
      'Output up to 4K with strong prompt adherence and fine typography, including Chinese characters.',
    capabilities: ['high_resolution', 'legible_text'],
  },
  {
    ecosystemId: ECO.Grok,
    name: 'Grok Imagine',
    maker: 'xAI',
    modelId: 2435474,
    goodAt: 'Still images and short clips from a text prompt or a reference image.',
    capabilities: ['reference_images'],
  },
  {
    ecosystemId: ECO.MAI,
    name: 'MAI-Image-2.5',
    maker: 'Microsoft',
    modelId: 2673730,
    goodAt:
      'Photoreal, design-ready images and product shots, with stronger text rendering and pixel-level editing.',
    capabilities: ['photoreal', 'legible_text', 'image_editing'],
  },
  {
    ecosystemId: ECO.MuseImage,
    name: 'Muse Image',
    maker: 'Meta',
    modelId: 2909814,
    goodAt:
      'Plans its composition and reviews its own output, edits one element while leaving the rest pixel-identical, and composes from tagged reference images.',
    capabilities: ['image_editing', 'reference_images'],
  },
  {
    ecosystemId: ECO.Reve,
    name: 'Reve 2.1',
    maker: 'Reve',
    modelId: 2781889,
    goodAt: 'Region-structured layout control, native 4K output, and dense scenes with fine text.',
    capabilities: ['design_layout', 'high_resolution', 'legible_text'],
  },
  {
    ecosystemId: ECO.Ideogram,
    name: 'Ideogram 4.5',
    maker: 'Ideogram',
    modelId: 2872974,
    goodAt:
      'Accurate text for posters, logos and typography-led design, plus editing with up to three reference images.',
    capabilities: ['legible_text', 'design_layout', 'image_editing', 'reference_images'],
  },
  {
    ecosystemId: ECO.Ming,
    name: 'Ming Image Design',
    maker: 'inclusionAI',
    modelId: 2961930,
    goodAt:
      'UI mockups, infographics, posters and slides with legible type, including RGBA output on a transparent background.',
    capabilities: ['design_layout', 'legible_text', 'transparent_background'],
  },
  {
    ecosystemId: ECO.WanImage27,
    name: 'Wan 2.7 Image',
    maker: 'Alibaba',
    modelId: 2516180,
    goodAt:
      'Varied faces, stable text rendering, colour and layout control, and instruction editing.',
    capabilities: ['legible_text', 'design_layout', 'image_editing'],
  },
  {
    ecosystemId: ECO.Flux3,
    name: 'FLUX 3 Image',
    maker: 'Black Forest Labs',
    modelId: 2839203,
    goodAt: 'Generation and editing across styles and aspect ratios, including complex prompts.',
    capabilities: ['image_editing'],
  },
  {
    ecosystemId: ECO.Ernie,
    name: 'ERNIE-Image',
    maker: 'Baidu',
    modelId: 2548387,
    goodAt: 'An open 8B DiT text-to-image model with a built-in prompt enhancer for short prompts.',
    capabilities: [],
  },
  {
    ecosystemId: ECO.Lens,
    name: 'Microsoft Lens',
    maker: 'Microsoft',
    modelId: 2655865,
    goodAt:
      'A compact 3.8B model with flexible resolution up to 1440×1440 and aspect ratios from 1:2 to 2:1.',
    capabilities: [],
  },
  {
    ecosystemId: ECO.MageFlow,
    name: 'Mage Flow',
    maker: 'Microsoft',
    modelId: 2812690,
    goodAt:
      'A 4B model for generation and editing at native 512–2048 px in any aspect ratio, with strong prompt following.',
    capabilities: ['image_editing', 'high_resolution'],
  },
  {
    ecosystemId: ECO.HiDreamO1,
    name: 'HiDream O1 Image',
    maker: 'HiDream',
    modelId: 2618495,
    goodAt:
      'An 8B pixel-level model for text-to-image, instruction editing and multi-reference subject personalization up to 2048×2048.',
    capabilities: ['image_editing', 'reference_images', 'character_consistency', 'high_resolution'],
  },
];

export function hostedModelUrl(modelId: number): string {
  return `https://civitai.com/models/${modelId}`;
}
