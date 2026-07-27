/**
 * Curated configuration for ecosystem SEO hub pages (`/ecosystems/[key]`).
 *
 * Presence in `ECOSYSTEM_SEO` is the allow-list: a key with no entry 404s, so
 * pages launch deliberately. Everything here is human-curated — the *generic*
 * counterpart (stat counts, top LoRAs) is queried + cached in
 * `server/services/ecosystem-seo.service.ts`. See
 * docs/features/ecosystem-seo-pages.md for why the split exists (ranking
 * checkpoints by downloads surfaces GGUF/NF4 quant dumps, not marquee models).
 *
 * Featured model/image IDs are re-validated against NSFW state at fetch time —
 * a later re-rating can't leak explicit content onto an indexable page.
 */

export type EcosystemSeoModality = 'image' | 'video';

export type FeaturedModel = {
  modelId: number;
  /**
   * For a Checkpoint, this version MUST be in the `EcosystemCheckpoints` table (always
   * generatable) — the service drops featured checkpoints that aren't, since other
   * checkpoints are only available depending on auction results. LoRAs aren't gated.
   */
  versionId: number;
  /**
   * Curated SFW thumbnail for the card. Re-checked against nsfwLevel at fetch time
   * and dropped if it fails — a card only ever shows a safe image (or none).
   */
  imageId: number;
  /** Overrides the fetched model name if the canonical name is cryptic (e.g. "FLUX" → "FLUX.1 [dev]"). */
  displayName?: string;
  /** Short curated tag under the name, e.g. "Civitai-hosted · default". */
  note?: string;
};

export type FeaturedExample = {
  imageId: number;
  /** Curated (SFW) caption — the prompt shown on the card. */
  prompt: string;
  /** e.g. "Steps 20 · Guidance 3.5 · FLUX.1 [dev]". For video: include fps. */
  settings: string;
  /**
   * Media type of THIS example. Defaults to the config's `modality`. Set it on a dual-modality
   * page (e.g. Grok does image + video) to mix real images and clips in the same gallery — the
   * card renders and remixes each item as its own type.
   */
  type?: EcosystemSeoModality;
};

export type ComparisonRow = {
  label: string;
  /**
   * [thisEcosystem, peer1, peer2, peer3] — must align with `comparison.peers`.
   *
   * A value may embed a `{loras:Key}` token (Key = an ECOSYSTEM_SEO key), replaced at render
   * time with that ecosystem's live LoRA count. Always use the token for LoRA counts: the
   * hand-written numbers drifted, so the same ecosystem read differently on every page.
   */
  values: [string, string, string, string];
  /** Index into `values` to highlight as the winner, if any. */
  winner?: 0 | 1 | 2 | 3;
};

export type EcosystemSeoFaq = { q: string; a: string };

export type EcosystemSeoConfig = {
  /** Primary ecosystem key from basemodel.constants (must resolve via ecosystemByKey). */
  key: string;
  /**
   * Extra ecosystem keys this page also represents (combined pages, e.g. Z-Image =
   * ZImageTurbo + ZImageBase). Stats/browse union base models across key + these.
   */
  additionalEcosystemKeys?: string[];
  /** URL slug override. Defaults to `key.toLowerCase()`; set when the key isn't a nice slug (Wan, Z-Image). */
  slug?: string;
  /** Display name for the H1 / title. */
  name: string;
  /**
   * ~150–160 char SERP meta description — unique per page, condensed from the grounded
   * hero/overview copy (no new claims). Controls the search snippet; front-load the name +
   * "Civitai" + the core value. Falls back to nothing if omitted, so keep it populated.
   */
  metaDescription: string;
  /** Primary media type — drives featured-model covers, the funnel, and the default example type. */
  modality: EcosystemSeoModality;
  /** Flag a freshly-launched ecosystem — renders a "New" badge on the page + index card. Set by hand. */
  isNew?: boolean;
  /**
   * Set when the ecosystem also generates the OTHER media type (e.g. Grok: modality 'video',
   * secondaryModality 'image'). Makes the stat label + example heading neutral ("Images & videos")
   * and signals the gallery may hold both — curate mixed `featuredExamples` with per-item `type`.
   */
  secondaryModality?: EcosystemSeoModality;
  /**
   * `YYYY-MM-DD` of the last meaningful editorial change to THIS ecosystem's content
   * (overview, featured picks, comparison, FAQ, hero). Drives the sitemap `<lastmod>`.
   * Bump it by hand when you edit the config — do NOT tie it to the daily stats refresh,
   * which changes only the numbers and would make lastmod churn (search engines discount
   * always-current lastmods).
   */
  updatedAt: string;
  hero: {
    intro: string;
    /** e.g. ["Text-to-Image", "By Black Forest Labs", "Open weights + API"] */
    badges: string[];
  };
  /**
   * Long-form, genuinely unique prose for the "Overview" section — the primary SEO
   * differentiator (depth + de-duplication vs. the templated blocks). Each string is a
   * paragraph. Omit on pages not yet written up (the section just doesn't render).
   */
  overview?: string[];
  /** "How to prompt" bullets — ecosystem-specific, unique guidance. Renders under the overview. */
  promptTips?: string[];
  /** modelVersionId the primary "Generate" CTA deep-links to. */
  generatorVersionId: number;
  featuredModels: FeaturedModel[];
  featuredExamples: FeaturedExample[];
  comparison: {
    /** Peer ecosystem display names for the table columns (3). */
    peers: [string, string, string];
    rows: ComparisonRow[];
  };
  faq: EcosystemSeoFaq[];
  /**
   * Announced end-of-life for a hosted model. Before `date` the page carries a warning banner;
   * from `date` on it delists itself — noindex, and dropped from the sitemap — rather than
   * ranking for a model nobody can generate with any more.
   */
  sunset?: {
    /** `YYYY-MM-DD` the endpoints shut down. */
    date: string;
    /** One line shown in the banner, e.g. who is shutting it down and what to use instead. */
    note: string;
  };
  /** Local-run honesty box. Omit for API-only ecosystems (renders an "API only" note instead). */
  localRun?: { vram: string; weightsSize: string; tool: string };
  /** Attribution line in the footer. */
  attribution: string;
  /**
   * Moderator-only fact-check flags — AI-authored claims a human should verify before we treat
   * them as authoritative. Rendered in a mod-only review panel on the page and NEVER sent to
   * non-moderators (stripped in getServerSideProps). Clear a flag by removing it once verified.
   */
  factCheck?: EcosystemSeoFactCheckFlag[];
};

export type EcosystemSeoFactCheckFlag = {
  /** Page area the claim lives in: 'overview' | 'promptTips' | 'comparison' | 'faq' | 'hero' |
   *  'localRun' | 'attribution' | 'metaDescription' | 'featuredExamples' | 'featuredModels'. */
  field: string;
  /** The specific claim to verify — a short quote or description. */
  claim: string;
  /** Why it's flagged / what to confirm (source conflict, unsourced number, editorial judgment…). */
  note: string;
  /**
   * Exact substring of the rendered copy to highlight inline (mod-only) — verbatim from the
   * field's text so it can be matched and wrapped. Omit for whole-section concerns (the section
   * header gets a "verify" chip instead).
   */
  highlight?: string;
};

export const ECOSYSTEM_SEO: Record<string, EcosystemSeoConfig> = {
  Flux1: {
    key: 'Flux1',
    updatedAt: '2026-07-23',
    additionalEcosystemKeys: ['FluxKrea', 'Flux1Kontext'],
    name: 'FLUX.1',
    metaDescription:
      "Generate with FLUX.1 on Civitai — Black Forest Labs' open model with strong prompt adherence and legible in-image text. Browse top FLUX.1 checkpoints, LoRAs & prompts.",
    modality: 'image',
    hero: {
      intro:
        'FLUX.1 is Black Forest Labs’ family of open-weight text-to-image models, with class-leading prompt adherence, legible in-image text, and striking photorealism. Generate detailed images from a description in seconds — no GPU, no install. Run every FLUX.1 model right here on Civitai.',
      badges: ['Text-to-Image', 'By Black Forest Labs', 'Open weights + API'],
    },
    overview: [
      'FLUX.1 comes from Black Forest Labs, a team founded by several of the original Stable Diffusion researchers. Its models are 12-billion-parameter rectified-flow transformers, and when FLUX.1 launched in 2024 it reset expectations for open image generation — sharper prompt adherence, coherent hands and anatomy, and readable in-image text that earlier open models struggled with. Unlike the SD and SDXL lineage, FLUX.1 pairs a large transformer with the T5 text encoder, so it reads long, natural-language descriptions instead of relying on comma-separated Danbooru tags.',
      'The family is really a set of specialized tools rather than one model. FLUX.1 [dev] is the quality-first workhorse; FLUX.1 [schnell] is a few-step distillation for near-instant drafts; FLUX.1 Krea is tuned for photographic realism and believable skin; and FLUX.1 Kontext performs in-context editing, changing an existing image from a text instruction. On Civitai all of them are hosted, so you can jump between [dev], [schnell], Krea, and Kontext without downloading tens of gigabytes of weights for each.',
      'Choose FLUX.1 when prompt fidelity, photorealism, typography, or complex multi-subject scenes matter — it is a top open choice for product shots, posters, and text-in-image work. For anime and character art, the SDXL-based Pony and Illustrious ecosystems still lead on style range and sheer LoRA depth. FLUX.1’s own LoRA library is smaller but growing quickly, and because each image runs a 12B model it costs more Buzz per generation than lighter checkpoints — a worthwhile trade when you need the prompt followed exactly.',
    ],
    promptTips: [
      'Write in natural language — complete sentences, not comma-separated tags. FLUX.1’s T5-XXL text encoder actually parses grammar, so describe the scene as you would to a person. Aim for roughly 30–80 words ([dev] handles up to 512 tokens, [schnell] 256).',
      'Put the most important element first — FLUX.1 weights earlier words more heavily.',
      'Skip weight syntax and negative prompts: (word:1.5) and ((word)) are ignored, and there is no negative prompt. Describe what you want instead — "sharp, crisp focus" rather than "no blur."',
      'Lighting drives quality more than anything else, so be specific — "warm golden light from a window on the left" beats "warm lighting." Camera and film references work too, e.g. "shot on Hasselblad, 80mm, f/2.8" or "Kodak Portra 400."',
      'For text in the image, wrap the words in quotation marks. On Dev, avoid the phrase "white background" (it can blur) — say "clean bright backdrop" instead.',
    ],
    generatorVersionId: 691639, // FLUX (model 618692) — Civitai-hosted FLUX.1 [dev] standard
    featuredModels: [
      {
        modelId: 618692,
        versionId: 691639,
        imageId: 137412471,
        displayName: 'FLUX.1 [dev]',
        note: 'Civitai-hosted · default',
      },
      {
        modelId: 618692,
        versionId: 2068000,
        imageId: 137387022,
        displayName: 'FLUX.1 Krea',
        note: 'Civitai-hosted · photoreal',
      },
      {
        modelId: 1672021,
        versionId: 1892509,
        imageId: 137414152,
        displayName: 'FLUX.1 Kontext',
        note: 'Civitai-hosted · in-context editing',
      },
      {
        modelId: 631986,
        versionId: 706528,
        imageId: 133448965,
        displayName: 'XLabs Flux Realism',
      },
      {
        modelId: 639937,
        versionId: 810340,
        imageId: 111107168,
        displayName: 'Boreal-FD (Boring Reality)',
      },
      {
        modelId: 721039,
        versionId: 806265,
        imageId: 137353043,
        displayName: 'Retro Anime Flux',
      },
    ],
    featuredExamples: [
      {
        imageId: 137412471,
        prompt:
          'A picturesque Mediterranean hillside estate near Capri, overlooking crystal-clear sea',
        settings: 'FLUX.1 [dev] · 832×1216',
      },
      {
        imageId: 137412193,
        prompt: 'A woman on a wooden boardwalk extending into a shimmering, star-speckled expanse',
        settings: 'FLUX.1 [dev] · 832×1216',
      },
      {
        imageId: 137412759,
        prompt: 'Dynamic anime-style vector illustration, bold linework, flat color',
        settings: 'FLUX.1 [dev]',
      },
      {
        imageId: 137403710,
        prompt:
          'A towering herald in orange-and-black ceremonial armor above a floating stone platform',
        settings: 'FLUX.1 [dev] · 832×1216',
      },
      {
        imageId: 137403240,
        prompt:
          'A neat row of weathered coastal rocks under dramatic sky, wide cinematic landscape',
        settings: 'FLUX.1 [dev] · 2400×1800',
      },
      {
        imageId: 137403087,
        prompt:
          'An epic fantasy landscape: an imposing pyramidal mountain of white rock, frozen light',
        settings: 'FLUX.1 [dev] · 832×1216',
      },
    ],
    comparison: {
      peers: ['SDXL', 'Pony', 'Illustrious'],
      rows: [
        {
          label: 'Best for',
          values: [
            'Photorealism, text, versatility',
            'General purpose, speed',
            'Anime & illustration',
            'Stylized anime art',
          ],
        },
        {
          label: 'Prompt adherence',
          values: ['Excellent', 'Good', 'Good', 'Very good'],
          winner: 0,
        },
        { label: 'Text in images', values: ['Strong', 'Weak', 'Fair', 'Fair'], winner: 0 },
        {
          label: 'Speed on Civitai',
          values: ['Fast (4–8s)', 'Fastest (2–4s)', 'Fast (3–6s)', 'Medium (5–10s)'],
          winner: 1,
        },
        {
          label: 'LoRA ecosystem',
          values: ['{loras:Flux1}', '{loras:SDXL}', '{loras:Pony}', '{loras:Illustrious}'],
        },
        { label: 'Available on Civitai', values: ['✓ Yes', '✓ Yes', '✓ Yes', '✓ Yes'] },
      ],
    },
    faq: [
      {
        q: 'How much does it cost to generate with FLUX.1?',
        a: 'Generation on Civitai runs on Buzz, and FLUX.1 sits toward the higher end of the cost range because it runs a 12-billion-parameter model — a FLUX.1 image costs more Buzz than a lighter SD 1.5 or Illustrious render. Every account still earns free Blue Buzz daily by reacting to images and other on-site activity, so you can generate with FLUX.1 without spending real money; you will just work through your daily Blue Buzz faster than on cheaper models, or add a membership for higher limits. FLUX.1 [schnell] is the most Buzz-efficient way to iterate before committing to a [dev] render.',
      },
      {
        q: "What's the difference between FLUX.1 [dev] and [schnell]?",
        a: '[dev] prioritizes quality and prompt adherence; [schnell] is tuned for speed, producing images in far fewer steps. Both run in the Civitai generator — pick either one.',
      },
      {
        q: 'Can I train my own FLUX.1 LoRA?',
        a: 'Yes. FLUX.1 supports LoRA fine-tuning, and you can train one directly on Civitai — no local GPU needed. Publish it to earn Buzz when others generate with it.',
      },
      {
        q: 'Do I need a GPU to run FLUX.1?',
        a: 'Not on Civitai — we run the compute for you. Locally, FLUX.1 wants a 16GB+ VRAM GPU.',
      },
      {
        q: 'How do I combine a checkpoint with LoRAs?',
        a: 'Pick a FLUX.1 checkpoint, then stack up to 5 LoRAs in the generator to blend styles. Remix an example to see how the settings carry over.',
      },
    ],
    localRun: { vram: '16GB+ VRAM', weightsSize: '~24GB', tool: 'ComfyUI' },
    attribution: 'an open-weight model family by Black Forest Labs',
  },
  SDXL: {
    key: 'SDXL',
    updatedAt: '2026-07-23',
    name: 'SDXL',
    metaDescription:
      "Generate with SDXL on Civitai — Stability AI's high-res open model behind the largest LoRA ecosystem in open image generation. Browse checkpoints, LoRAs & prompts.",
    modality: 'image',
    hero: {
      intro:
        "SDXL (Stable Diffusion XL) is Stability AI's open-weight text-to-image model and the backbone of the largest fine-tune and LoRA ecosystem in open image generation. It renders high-resolution 1024px images with strong composition and broad style range — and it powers popular offshoots like Pony and Illustrious. Generate with SDXL right here on Civitai, no GPU or install required.",
      badges: ['Text-to-Image', 'By Stability AI', 'Open weights'],
    },
    overview: [
      "SDXL (Stable Diffusion XL) is Stability AI's open-weight, latent-diffusion text-to-image model and the direct successor to Stable Diffusion 1.5 and 2.1. It renders natively at 1024px and pairs two fixed, pretrained text encoders — OpenCLIP-ViT/bigG and CLIP-ViT/L — which give it noticeably better composition and prompt understanding than the single-encoder SD 1.x line. Its open weights and modest hardware needs turned it into the backbone of the largest fine-tune and LoRA ecosystem in open image generation.",
      "Architecturally, SDXL ships as a two-step pipeline: a base model generates latents at the target size, and an optional specialized refiner then applies an img2img (SDEdit) pass over those latents using the same prompt to sharpen high-frequency detail. Stability's own evaluations put the base model well ahead of SD 1.5 and 2.1 on user preference, with the refiner adding a further bump. It is not without limits — the original card notes it cannot render legible text, struggles with strict compositional prompts (for example, 'a red cube on top of a blue sphere'), and can be inconsistent with faces — gaps that the community's enormous library of fine-tunes largely papers over.",
      'Choose SDXL when you want broad style range, deep LoRA coverage, and fast, inexpensive iteration on a proven architecture. Because it is a comparatively light model, it is a strong default for versatile realism and for stacking community LoRAs. For anime and illustration specifically, the SDXL-based Pony and Illustrious offshoots push style and tag-driven character control further, while FLUX.1 leads on strict prompt adherence and in-image text — but all of them build on or sit alongside the SDXL foundation, and switching between them on Civitai takes no downloads.',
    ],
    promptTips: [
      'Prompt in tags, not sentences: comma-separated keywords, same style as SD 1.5. SDXL reads tag-style input through its dual CLIP encoders — natural-language paragraphs work less well than a clean tag list.',
      'Lead with a few quality tags — masterpiece, best quality, highly detailed, sharp focus — then follow the template subject → scene → lighting → camera/lens → style → details. SDXL needs fewer quality boosters than SD 1.5 to come out clean.',
      'Weight with (word:1.2) to raise attention, but keep it subtle: 1.1–1.3 is the safe ceiling, since high weights distort SDXL faster than SD 1.5. Shorthand (word) ≈ 1.1x, ((word)) ≈ 1.21x, and [word] ≈ 0.91x to de-emphasize.',
      'Keep prompts in the 40–80 word sweet spot (each encoder caps at 77 tokens). When two subjects or colors bleed together, insert the BREAK keyword to force a fresh chunk and separate the concepts.',
      'Use a short, targeted negative prompt rather than a long one — something like "low quality, blurry, distorted, extra limbs, watermark, text, deformed hands" is usually enough. Add LoRAs inline with <lora:name:0.7>.',
    ],
    generatorVersionId: 128078,
    featuredModels: [
      {
        modelId: 101055,
        versionId: 128078,
        imageId: 137428594,
        displayName: 'SDXL 1.0',
        note: 'Civitai-hosted · default',
      },
      {
        modelId: 120096,
        versionId: 135931,
        imageId: 133269264,
        displayName: 'Pixel Art XL',
      },
      {
        modelId: 118427,
        versionId: 128461,
        imageId: 137255499,
        displayName: 'Perfect Eyes XL',
      },
      {
        modelId: 251417,
        versionId: 283697,
        imageId: 137370862,
        displayName: 'Midjourney Mimic',
      },
      {
        modelId: 120663,
        versionId: 131991,
        imageId: 135162958,
        displayName: 'Juggernaut Cinematic XL',
      },
      {
        modelId: 232746,
        versionId: 262705,
        imageId: 137074182,
        displayName: 'Real Humans',
      },
    ],
    featuredExamples: [
      {
        imageId: 137428578,
        prompt: 'A luminous dragon rendered in rose-quartz and jade gemstone scales, sharp focus',
        settings: 'Steps 20 · SDXL 1.0 · 832×1216',
      },
      {
        imageId: 137426443,
        prompt: 'A majestic dragon with intricate anatomy and vivid color, high detail',
        settings: 'Steps 20 · SDXL 1.0 · 832×1216',
      },
      {
        imageId: 137394118,
        prompt: 'A busy coffee shop where friendly robots serve customers, highly detailed',
        settings: 'Steps 20 · SDXL 1.0 · 832×1216',
      },
      {
        imageId: 137392804,
        prompt: 'An ancient colossal tree of life with copper vines and glowing luminous fruit',
        settings: 'Steps 20 · SDXL 1.0 · 832×1216',
      },
      {
        imageId: 137392780,
        prompt: 'Tiny explorers journeying through the vast glowing interior of a machine world',
        settings: 'Steps 20 · SDXL 1.0 · 832×1216',
      },
      {
        imageId: 137392776,
        prompt: 'A gigantic dragon built from glowing components and copper cable tendons',
        settings: 'Steps 20 · SDXL 1.0 · 832×1216',
      },
    ],
    comparison: {
      peers: ['FLUX.1', 'Pony', 'Illustrious'],
      rows: [
        {
          label: 'Best for',
          values: [
            'Versatile realism & huge LoRA depth',
            'Photorealism, text, versatility',
            'Anime & concepts',
            'Anime & illustration',
          ],
        },
        {
          label: 'Prompt adherence',
          values: ['Good', 'Excellent', 'Good', 'Very good'],
          winner: 1,
        },
        { label: 'Text in images', values: ['Weak', 'Strong', 'Weak', 'Fair'], winner: 1 },
        {
          label: 'Speed on Civitai',
          values: ['Fastest (2–5s)', 'Medium (4–8s)', 'Fast (3–6s)', 'Medium (5–10s)'],
          winner: 0,
        },
        {
          label: 'LoRA ecosystem',
          values: ['{loras:SDXL}', '{loras:Flux1}', '{loras:Pony}', '{loras:Illustrious}'],
        },
        { label: 'Available on Civitai', values: ['✓ Yes', '✓ Yes', '✓ Yes', '✓ Yes'] },
      ],
    },
    faq: [
      {
        q: 'How much does it cost to generate with SDXL?',
        a: 'Generation on Civitai runs on Buzz, and SDXL sits at the affordable end of the range — it is a lighter model than FLUX.1 or the big video checkpoints, so each image costs relatively little Buzz. Every account earns free Blue Buzz daily by reacting to images and other on-site activity, and because SDXL renders are cheap, that daily Blue Buzz stretches a long way — you can iterate on prompts and stack LoRAs without spending real money. Heavier use, higher resolutions, or premium models simply draw down Buzz faster, so you can let it accumulate or add a membership for higher limits.',
      },
      {
        q: 'What makes SDXL different from SD 1.5?',
        a: 'SDXL is a larger, later Stability AI model that renders natively at 1024px with better composition and prompt understanding than SD 1.5. Try both on Civitai and compare.',
      },
      {
        q: 'How do SDXL, Pony, and Illustrious relate?',
        a: 'Pony and Illustrious are community models built on the SDXL architecture, so many SDXL LoRAs and tools carry over. Explore all three in the Civitai generator.',
      },
      {
        q: 'Can I train my own SDXL LoRA?',
        a: 'Yes. SDXL has one of the deepest LoRA ecosystems anywhere, and you can train one directly on Civitai — no local GPU needed. Publish it to earn Buzz when others generate with it.',
      },
      {
        q: 'Do I need a GPU to run SDXL?',
        a: 'Not on Civitai — we run the compute for you. Locally, SDXL runs on an 8GB+ VRAM GPU in ComfyUI.',
      },
    ],
    localRun: { vram: '8GB+ VRAM', weightsSize: '~6.9GB', tool: 'ComfyUI' },
    attribution: 'an open model by Stability AI',
  },

  Illustrious: {
    key: 'Illustrious',
    updatedAt: '2026-07-23',
    name: 'Illustrious',
    metaDescription:
      'Generate with Illustrious on Civitai — the SDXL-based anime model built for booru-tag prompting, character consistency, and clean linework. Browse LoRAs & prompts.',
    modality: 'image',
    hero: {
      intro:
        'Illustrious is an SDXL-based text-to-image model built by OnomaAI for anime and illustration. It nails Danbooru-style tag prompting, character consistency, and clean linework, and it anchors one of the largest anime LoRA ecosystems anywhere. Generate straight from a prompt in seconds — no GPU, no install. Run Illustrious right here on Civitai.',
      badges: ['Text-to-Image', 'By OnomaAI', 'SDXL-based · Open weights'],
    },
    overview: [
      'Illustrious (Illustrious-XL) is an open-source, SDXL-based text-to-image model developed by OnomaAI Research and optimized specifically for illustration and animation. Rather than training from scratch, it was built on the Kohaku XL-Beta (Revision 5) checkpoint, inheriting a strong anime-oriented SDXL foundation and then refining it for cleaner linework and tag adherence. Because it keeps the SDXL architecture and CLIP-based text encoding, it reads comma-separated Danbooru-style tags rather than the long natural-language prompts that transformer models like FLUX.1 expect. The technical details are published in the team’s arXiv paper (2409.19946).',
      'The model is deliberately positioned as an open-collaboration project: OnomaAI released the weights openly and asks the community to keep improvements in the open rather than folding them into closed, proprietary products. That openness is a big reason the Illustrious lineage became a foundation others build on — most notably NoobAI-XL, which starts from Illustrious and extends its training on a broader Danbooru/e621 dataset. On Civitai the base Illustrious-XL checkpoint is hosted and ready to run, so you can generate from a tag prompt without downloading the ~6.5GB of weights.',
      'Choose Illustrious when you want clean, tag-driven anime and illustration with strong character consistency and precise control over pose, outfit, and composition through booru tags. It anchors one of the largest anime LoRA ecosystems anywhere, so styles and characters are easy to layer on. If you want the same booru-native approach with even deeper character coverage, its descendant NoobAI is worth comparing; if you want photorealism, legible in-image text, or long natural-language prompts, a FLUX-class model is the better fit. For general-purpose versatility outside anime, the parent SDXL ecosystem covers more ground.',
    ],
    promptTips: [
      'Prompt in Danbooru-style tags, not sentences: short comma-separated descriptors (e.g. "1girl, green hair, low ponytail, school uniform, outdoors") read far better than natural-language phrasing on this SDXL-based model.',
      'Lead with quality and aesthetic tags — terms like "masterpiece, best quality, very aesthetic, absurdres" up front measurably lift fidelity, since the model was tuned on booru-tagged illustration data.',
      'Order tags by importance (subject and character first, then attributes, then setting and style); tags earlier in the prompt carry more weight in the composition.',
      'Use SDXL weighting syntax to emphasize or de-emphasize a tag — "(tag:1.2)" to strengthen, "(tag:0.8)" to soften — rather than repeating tags or writing emphatic prose.',
      'Keep a standard anime negative prompt to clean up output (e.g. "worst quality, low quality, bad anatomy, extra digits, jpeg artifacts"), and layer character or style LoRAs on top — Illustrious has by far the largest anime LoRA library to draw from.',
    ],
    generatorVersionId: 889818,
    featuredModels: [
      {
        modelId: 795765,
        versionId: 889818,
        imageId: 137426222,
        displayName: 'Illustrious-XL v0.1',
        note: 'Civitai-hosted · default',
      },
      {
        modelId: 1232765,
        versionId: 1389133,
        imageId: 57120893,
        displayName: 'Illustrious XL 1.0',
        note: 'Official 1.0 release · download',
      },
      {
        modelId: 966483,
        versionId: 1082928,
        imageId: 137428155,
        displayName: '96YOTTEA Style',
      },
      {
        modelId: 1061826,
        versionId: 1191626,
        imageId: 137354346,
        displayName: 'Detailer (Tool / Concept)',
      },
      {
        modelId: 1105790,
        versionId: 1242320,
        imageId: 137426850,
        displayName: 'haiz ai — Niji Style',
      },
      {
        modelId: 1187259,
        versionId: 1336431,
        imageId: 137190866,
        displayName: 'Frieren (Sousou no Frieren)',
      },
    ],
    featuredExamples: [
      {
        imageId: 137426222,
        prompt: 'Green-haired character with a low ponytail, crisp anime lineart',
        settings: 'Steps 20 · Illustrious-XL · 832×1216',
      },
      {
        imageId: 137389878,
        prompt: 'Ultra-detailed anime screencap, very aesthetic, clean shading',
        settings: 'Steps 20 · Illustrious-XL · 832×1216',
      },
      {
        imageId: 137380706,
        prompt: 'Makima (Chainsaw Man) in a white shirt and tie, soft window light',
        settings: 'Steps 20 · Illustrious-XL · 832×1216',
      },
      {
        imageId: 137369590,
        prompt: 'Character in a black coat against night city lights, anime coloring',
        settings: 'Steps 20 · Illustrious-XL · 832×1216',
      },
      {
        imageId: 137364201,
        prompt: 'Retro PC-98 style illustration with dithering',
        settings: 'Steps 20 · Illustrious-XL · 832×1216',
      },
      {
        imageId: 137351358,
        prompt: 'Yu Yu Hakusho-style anime scene, smooth linework, high resolution',
        settings: 'Steps 20 · Illustrious-XL · 832×1216',
      },
    ],
    comparison: {
      peers: ['NoobAI', 'Pony', 'SDXL'],
      rows: [
        {
          label: 'Best for',
          values: [
            'Anime & illustration',
            'Anime, booru-native prompting',
            'Stylized characters & poses',
            'General purpose, versatility',
          ],
        },
        { label: 'Prompt adherence', values: ['Very good', 'Very good', 'Good', 'Good'] },
        { label: 'Text in images', values: ['Fair', 'Fair', 'Weak', 'Fair'] },
        {
          label: 'Speed on Civitai',
          values: ['Fast (3–6s)', 'Fast (3–6s)', 'Fast (3–6s)', 'Fastest (2–4s)'],
          winner: 3,
        },
        {
          label: 'LoRA ecosystem',
          values: ['{loras:Illustrious}', '{loras:NoobAI}', '{loras:Pony}', '{loras:SDXL}'],
        },
        { label: 'Available on Civitai', values: ['✓ Yes', '✓ Yes', '✓ Yes', '✓ Yes'] },
      ],
    },
    faq: [
      {
        q: 'What is Illustrious best at?',
        a: 'Illustrious specializes in anime and illustration, with strong Danbooru-tag prompting and character consistency. Try it in the Civitai generator.',
      },
      {
        q: 'How much does it cost to generate with Illustrious?',
        a: 'Generation on Civitai runs on Buzz. You can claim free Blue Buzz every day — through actions like reacting to images and other on-site activity — and put it straight toward generating, no real money required. Illustrious is a lightweight SDXL-based checkpoint, so it costs relatively little Buzz per image and your daily free Blue Buzz stretches a long way; if you generate heavily or stack lots of LoRAs, you can let your Blue Buzz accumulate or add a membership for higher limits.',
      },
      {
        q: 'How is Illustrious different from Pony and NoobAI?',
        a: 'All three are SDXL-based anime models, but Illustrious leans into clean tag-driven illustration and has the largest LoRA library of the group. Compare them yourself by remixing an example.',
      },
      {
        q: 'Can I train my own Illustrious LoRA?',
        a: 'Yes. Illustrious supports LoRA fine-tuning, and you can train one directly on Civitai — no local GPU needed. Publish it to earn Buzz when others generate with it.',
      },
      {
        q: 'Do I need a GPU to run Illustrious?',
        a: 'Not on Civitai — we run the compute for you. Locally, being SDXL-based, it fits comfortably on an 8GB+ VRAM GPU.',
      },
    ],
    localRun: { vram: '8GB+ VRAM', weightsSize: '~6.5GB', tool: 'ComfyUI' },
    attribution: 'an SDXL-based anime model by OnomaAI',
    factCheck: [
      {
        field: 'promptTips',
        claim: 'booru-tag prompting guidance',
        note: 'Orchestrator prompt guide returned a generic fallback for this key — tips are grounded in the model card + general SDXL/booru practice, not a model-specific guide.',
      },
    ],
  },

  NoobAI: {
    key: 'NoobAI',
    updatedAt: '2026-07-23',
    name: 'NoobAI',
    metaDescription:
      'Generate with NoobAI-XL on Civitai — an Illustrious-based anime checkpoint with deep character knowledge and strong booru-tag prompting. Browse LoRAs & prompts.',
    modality: 'image',
    hero: {
      intro:
        'NoobAI-XL (NAI-XL) is an Illustrious-based anime checkpoint trained by Laxhar Lab on a massive Danbooru/e621 dataset, giving it deep character knowledge and strong booru-tag prompt understanding. It renders clean, expressive anime and illustration art with excellent tag adherence. Generate with it right here on Civitai — no GPU, no install.',
      badges: ['Text-to-Image', 'By Laxhar Lab', 'Illustrious / SDXL-based'],
    },
    overview: [
      'NoobAI-XL (NAI-XL) is an anime and illustration checkpoint from Laxhar Lab, built on SDXL by way of Illustrious (fine-tuned from Laxhar/noobai-XL_v1.0). What sets it apart is the training data: the full Danbooru and e621 datasets, captioned with both native booru tags and natural-language descriptions. That combination gives it unusually deep character, artist, and concept knowledge, and it responds tightly to comma-separated booru-style tag prompts.',
      'A key technical detail: the flagship NoobAI-XL is a v-prediction model, not the eps-prediction most SDXL checkpoints use. That means it expects specific sampler settings (v-prediction with zero-terminal-SNR rescaling) rather than the defaults you would use for a normal SDXL model — the model card leads with a bold warning that "this model works different from EPS models." On Civitai the generator already applies the right configuration for you, so you get the intended output without hand-tuning schedulers.',
      'Choose NoobAI when you want the strongest booru-tag adherence and the broadest built-in knowledge of anime characters and artists — it recognizes more tags than the Illustrious base it extends. If you prefer natural-language prompting or a lighter, faster general-purpose anime model, Illustrious or Pony are close siblings worth comparing; NoobAI trades a little simplicity for reach and precision on tags. All three are available on Civitai, so you can run the same prompt across them and pick the look you like.',
    ],
    promptTips: [
      'Prompt with comma-separated Danbooru/e621 tags rather than full sentences — NoobAI was trained on native booru tags and rewards concise, tag-style descriptions (e.g. "1girl, green hair, cat ears, portrait").',
      'Lead with quality tags. The model card\'s own sample opens with "masterpiece, best quality"; adding these boosters up front consistently improves fidelity.',
      'Call artists and named characters directly with booru conventions — the card uses "artist:john_kafka" style tags and character tags to steer style and identity, which works because those tags come straight from the training set.',
      'Escape parentheses that are part of a tag with a backslash, e.g. "arlecchino \\(genshin impact\\)" or "horror \\(theme\\)", so they read as booru tags and are not parsed as prompt-weighting syntax.',
      'Use a strong negative prompt. The card recommends "nsfw, worst quality, old, early, low quality, lowres, signature, username, logo, bad hands, mutated hands" as a baseline to clean up anatomy and artifacts.',
    ],
    generatorVersionId: 1190596,
    featuredModels: [
      {
        modelId: 833294,
        versionId: 1190596,
        imageId: 137421510,
        displayName: 'NoobAI-XL (NAI-XL)',
        note: 'Civitai-hosted · default',
      },
      {
        modelId: 703211,
        versionId: 1531793,
        imageId: 131791301,
        displayName: 'Maid Classic',
      },
      {
        modelId: 512070,
        versionId: 2025370,
        imageId: 121336341,
        displayName: 'Witch Costume',
      },
      {
        modelId: 441397,
        versionId: 2017748,
        imageId: 128366973,
        displayName: 'Hanfu',
      },
      {
        modelId: 452666,
        versionId: 1527159,
        imageId: 69630278,
        displayName: 'One-Piece Dress',
      },
      {
        modelId: 447008,
        versionId: 1533938,
        imageId: 106181780,
        displayName: 'Formal Style',
      },
    ],
    featuredExamples: [
      {
        imageId: 137421510,
        prompt: 'A green-haired cat girl with animal ears, soft portrait, detailed anime shading',
        settings: 'Steps 20 · NoobAI-XL · 832×1216',
      },
      {
        imageId: 137155768,
        prompt: 'A lone figure in flowing robes against a deep starfield night sky',
        settings: 'Steps 20 · NoobAI-XL · 832×1216',
      },
      {
        imageId: 137016649,
        prompt: 'A short-haired student in a white school uniform shirt, facing the viewer',
        settings: 'Steps 20 · NoobAI-XL · 832×1216',
      },
      {
        imageId: 136947154,
        prompt: 'Close-up anime portrait: blue eyes, freckles, hime-cut hair, gentle smile',
        settings: 'Steps 20 · NoobAI-XL · 832×1216',
      },
      {
        imageId: 136911543,
        prompt: 'A cheerful character illustration in a bright, clean anime style',
        settings: 'Steps 20 · NoobAI-XL · 832×1216',
      },
      {
        imageId: 136836097,
        prompt: 'A 3D-style anime scene, character seated in a softly lit bedroom interior',
        settings: 'Steps 20 · NoobAI-XL · 832×1216',
      },
    ],
    comparison: {
      peers: ['Illustrious', 'Pony', 'SDXL'],
      rows: [
        {
          label: 'Best for',
          values: [
            'Anime with deep booru-tag knowledge',
            'Anime & illustration',
            'Stylized characters, general purpose',
            'Photorealism & versatility',
          ],
        },
        {
          label: 'Prompt adherence',
          values: ['Very good (booru tags)', 'Very good', 'Good', 'Good'],
        },
        { label: 'Text in images', values: ['Fair', 'Fair', 'Weak', 'Fair'] },
        {
          label: 'Speed on Civitai',
          values: ['Medium (5–10s)', 'Medium (5–10s)', 'Fast (3–6s)', 'Fast (3–6s)'],
        },
        {
          label: 'LoRA ecosystem',
          values: ['{loras:NoobAI}', '{loras:Illustrious}', '{loras:Pony}', '{loras:SDXL}'],
        },
        { label: 'Available on Civitai', values: ['✓ Yes', '✓ Yes', '✓ Yes', '✓ Yes'] },
      ],
    },
    faq: [
      {
        q: 'How much does it cost to generate with NoobAI?',
        a: 'NoobAI generations run on Buzz, and every Civitai account earns free Blue Buzz daily just by reacting to images and staying active on the site. As an SDXL-class anime checkpoint, NoobAI is moderately priced per image — heavier than a base SD model but far from the most expensive options — so your daily free Blue Buzz covers a steady stream of images, and you can add a membership or accumulate more Buzz if you want to generate at higher volume or larger sizes.',
      },
      {
        q: 'What is NoobAI-XL?',
        a: 'NoobAI-XL (NAI-XL) is an anime-focused checkpoint built on Illustrious/SDXL and trained by Laxhar Lab on a large Danbooru/e621 tag dataset. Try it in the Civitai generator.',
      },
      {
        q: 'How is NoobAI different from Illustrious?',
        a: 'NoobAI starts from Illustrious and extends its training on a broader booru dataset, so it recognizes more characters and tags. You can generate with both on Civitai and compare side by side.',
      },
      {
        q: 'How should I prompt NoobAI?',
        a: 'It responds best to comma-separated Danbooru-style tags plus quality tags like "masterpiece, best quality". Remix any example above to see the exact tags that produced it.',
      },
      {
        q: 'Can I train a NoobAI LoRA?',
        a: 'Yes — NoobAI supports LoRA fine-tuning and you can train one directly on Civitai, no local GPU required. Publish it to earn Buzz when others generate with it.',
      },
      {
        q: 'Do I need a GPU to run NoobAI?',
        a: 'Not on Civitai — we run the compute for you. Locally it wants an 8GB+ VRAM GPU and roughly 6.5GB of weights. Start generating in the browser instead.',
      },
    ],
    localRun: { vram: '8GB+ VRAM', weightsSize: '~6.5GB', tool: 'ComfyUI' },
    attribution: 'an Illustrious-based anime model (NoobAI-XL) by Laxhar Lab',
    factCheck: [
      {
        field: 'promptTips',
        claim: 'booru-tag prompting guidance',
        note: 'Orchestrator prompt guide returned a generic fallback for this key — tips are grounded in the model card + general booru practice, not a model-specific guide.',
      },
    ],
  },

  Qwen: {
    key: 'Qwen',
    updatedAt: '2026-07-23',
    name: 'Qwen',
    metaDescription:
      "Generate with Qwen-Image on Civitai — Alibaba's open model with sharp prompt adherence and unusually legible in-image text, including Chinese. Browse LoRAs & prompts.",
    modality: 'image',
    hero: {
      intro:
        'Qwen-Image is an open-weight text-to-image model from Alibaba, built for sharp prompt adherence and unusually legible in-image text — including strong results with Chinese characters. It also ships an image-editing variant for in-context edits. Generate with every Qwen-Image model right here on Civitai — no GPU, no install.',
      badges: ['Text-to-Image', 'By Alibaba (Qwen)', 'Open weights'],
    },
    overview: [
      'Qwen-Image is an open-weight text-to-image foundation model from Alibaba, part of the broader Qwen series. Its headline capability is high-fidelity in-image text rendering: it preserves typographic detail, layout, and contextual harmony across both alphabetic scripts like English and logographic ones like Chinese, integrating text into the image rather than overlaying it. Beyond typography it is a general-purpose generator that adapts across styles — photoreal, painterly, anime, and minimalist design — and it is released under the permissive Apache 2.0 license.',
      'The family is a set of specialized tools built on the same 20B foundation. The base Qwen-Image is the quality-first text-to-image workhorse; Qwen-Image-2512 is the December refresh that reduces the "AI-generated" look, sharpens human realism, and renders finer natural detail like landscapes and animal fur while further improving text layout. Qwen-Image-Edit is the editing variant: it feeds the input image into both Qwen2.5-VL for semantic control and a VAE encoder for appearance control, enabling in-context edits — object add/remove, style transfer, novel-view rotation, and direct bilingual text editing that keeps the original font, size, and style. All three are hosted on Civitai, so you can switch between them without downloading tens of gigabytes of weights.',
      'Choose Qwen-Image when legible text-in-image — signage, posters, packaging, or Chinese characters — is central, or when you want strong prompt adherence across a wide stylistic range from a single open model. Reach for Qwen-Image-2512 when photographic realism of people and nature is the priority, and Qwen-Image-Edit when you are modifying an existing image rather than generating from scratch. For anime and character art the SDXL-based Pony and Illustrious ecosystems still lead on style range and LoRA depth, but Qwen’s own LoRA library on Civitai is already substantial and growing.',
    ],
    promptTips: [
      'Write in natural language, not comma-separated tags. One to three sentences is the sweet spot, and order matters — lead with the main subject, then the environment, then finer details.',
      'Structure the prompt by category: Subject → Environment → Lighting → Style. A good template is "[Subject description]. [Scene and environment]. [Style, lighting, and atmosphere]." Separating these categories measurably improves precision.',
      'For text in the image, wrap the exact words in quotation marks — it dramatically improves rendering accuracy. Qwen is especially strong at Chinese characters as well as English.',
      'Skip weight syntax like (word:1.5) — it is not supported. Emphasize with descriptive language instead of numeric weights.',
      'Do not rely on negative prompts. The parameter exists but has minimal effect since the model was not trained on negative conditioning — describe everything you want in the positive prompt.',
    ],
    generatorVersionId: 2110043,
    featuredModels: [
      {
        modelId: 1864281,
        versionId: 2110043,
        imageId: 137356570,
        displayName: 'Qwen-Image',
        note: 'Civitai-hosted · default',
      },
      {
        modelId: 2268063,
        versionId: 2552908,
        imageId: 137400292,
        displayName: 'Qwen-Image-2512',
        note: 'Civitai-hosted · latest',
      },
      {
        modelId: 1884704,
        versionId: 2133258,
        imageId: 136373993,
        displayName: 'Qwen-Image-Edit',
        note: 'Civitai-hosted · in-context editing',
      },
      {
        modelId: 1927710,
        versionId: 2181911,
        imageId: 131459846,
        displayName: 'Qwen-Image-Boreal (Boring Reality)',
      },
      {
        modelId: 1940557,
        versionId: 2196307,
        imageId: 114708555,
        displayName: 'Outfit Extractor · Qwen Edit',
      },
      {
        modelId: 2056953,
        versionId: 2327746,
        imageId: 130048272,
        displayName: 'Real Life LoRA · Qwen',
      },
    ],
    featuredExamples: [
      {
        imageId: 137103981,
        prompt: 'Ultra-detailed cinematic fantasy portrait with photoreal lighting',
        settings: 'Steps 20 · Qwen-Image · 1024×1024',
      },
      {
        imageId: 137220420,
        prompt: 'A cyberpunk woman under neon light, sharp edges, highly detailed, 4k',
        settings: 'Steps 20 · Qwen-Image · 1024×1024',
      },
      {
        imageId: 136309301,
        prompt: 'A toucan perched in a jungle tree, glossy feathers, ultra-sharp nature scene',
        settings: 'Steps 20 · Qwen-Image · 1024×1024',
      },
      {
        imageId: 135203767,
        prompt: 'A stained-glass tiger, wildlife close-up, vivid color',
        settings: 'Steps 20 · Qwen-Image · 1024×1024',
      },
      {
        imageId: 135132276,
        prompt: 'Anime-style full-body character illustration, front view',
        settings: 'Steps 20 · Qwen-Image · 1024×1024',
      },
      {
        imageId: 136373993,
        prompt: 'A single gilded koi fish, traditional Chinese ink-wash style on xuan paper',
        settings: 'Steps 20 · Qwen-Image · 1024×1024',
      },
    ],
    comparison: {
      peers: ['FLUX.1', 'SDXL', 'HiDream'],
      rows: [
        {
          label: 'Best for',
          values: [
            'Prompt accuracy & in-image text',
            'Photorealism & versatility',
            'General purpose, speed',
            'Photoreal prompt following',
          ],
        },
        { label: 'Prompt adherence', values: ['Excellent', 'Excellent', 'Good', 'Very good'] },
        { label: 'Text in images', values: ['Strong', 'Strong', 'Weak', 'Fair'] },
        {
          label: 'Speed on Civitai',
          values: ['Medium (6–12s)', 'Fast (4–8s)', 'Fastest (2–4s)', 'Medium (6–12s)'],
          winner: 2,
        },
        {
          label: 'LoRA ecosystem',
          values: ['{loras:Qwen}', '{loras:Flux1}', '{loras:SDXL}', '{loras:HiDream}'],
        },
        { label: 'Available on Civitai', values: ['✓ Yes', '✓ Yes', '✓ Yes', '✓ Yes'] },
      ],
    },
    faq: [
      {
        q: 'How much does it cost to generate with Qwen-Image?',
        a: 'Generation on Civitai runs on Buzz. You can claim free Blue Buzz every day — through actions like reacting to images and other on-site activity — and put it straight toward generating, no real money required. Qwen-Image is a 20B model, so each image costs more Buzz than lighter checkpoints; for heavier use let your Blue Buzz accumulate or add a membership for higher limits.',
      },
      {
        q: "What's the difference between Qwen-Image and Qwen-Image-Edit?",
        a: 'Qwen-Image is the base text-to-image model; Qwen-Image-Edit takes an input image and applies in-context edits from a prompt. Both are hosted on Civitai — pick either from the generator.',
      },
      {
        q: 'Is Qwen-Image good at rendering text?',
        a: 'Yes — legible in-image text, including Chinese characters, is one of its headline strengths. Try it yourself by remixing one of the examples above.',
      },
      {
        q: 'Can I use LoRAs with Qwen-Image?',
        a: 'Yes. Civitai already hosts 1,600+ Qwen LoRAs — stack them in the generator to blend styles and subjects. Remix an example to see how the settings carry over.',
      },
      {
        q: 'Do I need a GPU to run Qwen-Image?',
        a: 'Not on Civitai — we run the compute for you. Locally, Qwen-Image wants a 16GB+ VRAM GPU and roughly 20GB of weights.',
      },
    ],
    localRun: { vram: '16GB+ VRAM', weightsSize: '~20GB', tool: 'ComfyUI' },
    attribution: 'an open-weight image model by Alibaba (Qwen-Image)',
  },
  Pony: {
    key: 'Pony',
    updatedAt: '2026-07-23',
    name: 'Pony',
    metaDescription:
      'Generate with Pony Diffusion V6 XL on Civitai — the SDXL fine-tune for characters, anime, and stylized art via score_ tag prompts. Browse top LoRAs & prompts.',
    modality: 'image',
    hero: {
      intro:
        'Pony Diffusion V6 XL is an SDXL fine-tune by PurpleSmartAI built for characters, anime, and stylized art with strong control over pose and composition through its tag-based "score_" prompt system. It anchors one of the largest LoRA and community ecosystems on Civitai. Generate with it right here — no GPU, no install.',
      badges: ['Text-to-Image', 'By PurpleSmartAI', 'SDXL fine-tune'],
    },
    overview: [
      'Pony Diffusion V6 XL is an SDXL fine-tune from PurpleSmartAI, the studio founded by its creator AstraliteHeart, built as a versatile character and stylized-art model that handles SFW and NSFW output across anthro, feral, and humanoid subjects. Its defining feature is an opinionated "score_" prompt template: prefixing a prompt with a quality chain steers the model toward higher-fidelity results with no negative prompt and otherwise default settings. Because it was trained on a mix of natural-language captions and booru-style tags, it reads plain descriptions and comma-separated tags equally well, and it recognizes a wide range of popular and obscure characters and series.',
      'The score system is the model\'s signature lever. V6 XL expects the full chain — "score_9, score_8_up, score_7_up, score_6_up, score_5_up, score_4_up" — which the author notes was itself a training quirk that arrived too late to correct; the shorter "score_9" from earlier Pony versions still works but has a much weaker effect. Beyond quality, it exposes special data-selection tags: "source_pony", "source_furry", "source_cartoon", and "source_anime" to bias overall style, plus "rating_safe", "rating_questionable", and "rating_explicit" to control content. It must be loaded with clip skip 2, or generations degrade into low-quality blobs.',
      'As an SDXL fine-tune, Pony inherits SDXL\'s native resolutions and is compatible with the enormous SDXL-family LoRA library, and it anchors one of the largest community and LoRA ecosystems on Civitai. Choose it when you want deep character knowledge, the tag-driven "score_" workflow, and that vast LoRA depth. For cleaner anime linework and newer concepts, the sibling SDXL fine-tunes Illustrious and NoobAI are strong alternatives; reach for base SDXL when you want a neutral, general-purpose starting point instead of Pony\'s opinionated defaults.',
    ],
    promptTips: [
      'Lead with the score chain: "score_9, score_8_up, score_7_up, score_6_up, score_5_up, score_4_up". The full string is the intended quality trigger — "score_9" alone still works but is much weaker.',
      'Mix natural language and tags freely. Pony was trained on both, so describe the scene in plain language for the main idea, then append tags after it to boost specific elements.',
      'Skip negative prompts and generic quality words. The model is designed to produce clean results with no negative prompt, and modifiers like "hd" or "masterpiece" are unnecessary.',
      'Steer style and content with the special tags: "source_pony", "source_furry", "source_cartoon", or "source_anime" for overall look, and "rating_safe", "rating_questionable", or "rating_explicit" for content level.',
      'Load with clip skip 2 (or -2) to avoid low-quality blobs. The author recommends Euler a at 25 steps and 1024px, though most SDXL resolutions work; note that V6 can produce hard-to-remove pseudo-signatures.',
    ],
    generatorVersionId: 290640,
    featuredModels: [
      {
        modelId: 257749,
        versionId: 290640,
        imageId: 137399618,
        displayName: 'Pony Diffusion V6 XL',
        note: 'Civitai-hosted · default',
      },
      {
        modelId: 1486921,
        versionId: 1681921,
        imageId: 137411292,
        displayName: 'Real Skin Slider',
      },
      {
        modelId: 888213,
        versionId: 486749,
        imageId: 134365253,
        displayName: "Vixon's Pony Styles — Detailed",
      },
      {
        modelId: 670378,
        versionId: 750428,
        imageId: 137259569,
        displayName: 'Eyes High Definition',
      },
      {
        modelId: 317578,
        versionId: 389962,
        imageId: 131455792,
        displayName: 'PDV6XL Artist Tags',
      },
      {
        modelId: 517355,
        versionId: 574903,
        imageId: 132744042,
        displayName: 'Reality Enhancer [Pony]',
      },
    ],
    featuredExamples: [
      {
        imageId: 137399618,
        prompt: 'Upper-body character portrait with crisp linework and clean cel shading',
        settings: 'Steps 20 · Pony V6 XL · 832×1216',
      },
      {
        imageId: 137396552,
        prompt: 'Soft-focus semi-realistic portrait with a detailed face and gentle bokeh',
        settings: 'Steps 20 · Pony V6 XL · 832×1216',
      },
      {
        imageId: 137386211,
        prompt: 'Stylized face close-up with bold color and defined features',
        settings: 'Steps 20 · Pony V6 XL · 832×1216',
      },
      {
        imageId: 137352178,
        prompt: 'Anime-style character illustration in a bright, colorful outfit',
        settings: 'Steps 20 · Pony V6 XL · 832×1216',
      },
      {
        imageId: 135911913,
        prompt: 'Anime girl in a flowing traditional-style dress, upper body',
        settings: 'Steps 20 · Pony V6 XL · 832×1216',
      },
      {
        imageId: 135828890,
        prompt: 'Comic-style illustration with shallow depth of field',
        settings: 'Steps 20 · Pony V6 XL · 832×1216',
      },
    ],
    comparison: {
      peers: ['Illustrious', 'NoobAI', 'SDXL'],
      rows: [
        {
          label: 'Best for',
          values: [
            'Characters, anime, community LoRAs',
            'Anime & illustration',
            'Anime, newer concepts',
            'General-purpose base',
          ],
        },
        {
          label: 'Prompt adherence',
          values: ['Good (tag-based)', 'Very good', 'Very good', 'Good'],
        },
        { label: 'Text in images', values: ['Weak', 'Weak', 'Weak', 'Fair'], winner: 3 },
        {
          label: 'Speed on Civitai',
          values: ['Fast (3–6s)', 'Fast (3–6s)', 'Fast (3–6s)', 'Fast (3–6s)'],
        },
        {
          label: 'LoRA ecosystem',
          values: ['{loras:Pony}', '{loras:Illustrious}', '{loras:NoobAI}', '{loras:SDXL}'],
        },
        { label: 'Available on Civitai', values: ['✓ Yes', '✓ Yes', '✓ Yes', '✓ Yes'] },
      ],
    },
    faq: [
      {
        q: 'What are the "score_9, score_8_up" tags in Pony prompts?',
        a: 'Pony was trained with quality tags, so most prompts start with a chain like "score_9, score_8_up, score_7_up" to steer toward higher-quality results. Remix any example on this page to see the full prompt and tweak it.',
      },
      {
        q: 'How much does it cost to generate with Pony?',
        a: 'Generation on Civitai runs on Buzz, and you can claim free Blue Buzz every day through actions like reacting to images and other on-site activity. Pony is a lightweight SDXL fine-tune that generates fast, so it costs relatively little Buzz per image and your daily Blue Buzz stretches a long way — no real money required. For heavy or high-volume use, let your Blue Buzz accumulate or add a membership for higher limits.',
      },
      {
        q: 'What is Pony based on?',
        a: 'Pony Diffusion V6 XL is a fine-tune of SDXL, so it inherits SDXL resolutions and is compatible with the huge library of SDXL-family LoRAs. Pick a LoRA and stack it on Pony right in the generator.',
      },
      {
        q: 'Can I train my own Pony LoRA?',
        a: 'Yes. Pony supports LoRA fine-tuning and you can train one directly on Civitai — no local GPU needed. Publish it to earn Buzz when others generate with it.',
      },
      {
        q: 'Do I need a GPU to run Pony?',
        a: 'Not on Civitai — we run the compute for you. Locally, Pony needs about 8GB of VRAM and runs in ComfyUI.',
      },
    ],
    localRun: { vram: '8GB+ VRAM', weightsSize: '~6.5GB', tool: 'ComfyUI' },
    attribution: 'a fine-tune of SDXL by PurpleSmartAI (AstraliteHeart)',
    factCheck: [
      {
        field: 'promptTips',
        claim: 'score_ tag prompt guidance',
        note: 'Orchestrator prompt guide returned a generic fallback for this key — tips are grounded in the model card + general Pony/booru practice, not a model-specific guide.',
      },
    ],
  },

  SD1: {
    key: 'SD1',
    updatedAt: '2026-07-23',
    slug: 'stable-diffusion',
    name: 'Stable Diffusion',
    metaDescription:
      'Generate with Stable Diffusion (SD 1.5) on Civitai — the fast, lightweight original with the largest LoRA library anywhere. Browse checkpoints, LoRAs & prompts.',
    modality: 'image',
    hero: {
      intro:
        'Stable Diffusion is the open model that kicked off the AI-art community — and its 1.5 release is still the fastest, lightest, and most widely supported version to generate with. SD 1.5 renders in seconds on almost any hardware and is backed by the largest LoRA and fine-tune library anywhere. Generate from a text prompt with no GPU and no install — run SD 1.5 and thousands of its checkpoints and LoRAs right here on Civitai.',
      badges: ['Text-to-Image', 'By Runway / Stability AI', 'Open weights'],
    },
    overview: [
      'SD 1.5 is the original open-weights Stable Diffusion release from Runway and Stability AI, and it is the model that started the community. It is a latent diffusion model built on the CLIP text encoder with a native resolution of 512×512, which is why it is tiny to run and lightning-fast — it fits comfortably on GPUs with well under 10GB of VRAM, or none at all when you run it here. Rather than reading long natural-language descriptions, it works from short, comma-separated tag prompts, the same style that shaped years of community workflows.',
      'Almost nobody runs the raw base checkpoint today — the ecosystem lives in its fine-tunes. The default hosted here is DreamShaper, a long-running community model whose author set out to build "a better Stable Diffusion," a versatile "swiss-knife" checkpoint aimed first at art and illustration. Around SD 1.5 sits the deepest support stack of any open model: textual inversions, LoRAs, ControlNet, negative embeddings like the DreamShaper author’s "Bad Dream," and img2img / highres-fix upscaling pipelines that push its 512-native output to higher resolutions.',
      'Choose SD 1.5 when speed, low hardware cost, and sheer breadth of styles matter more than raw prompt fidelity — it renders in a second or two and has the largest LoRA and fine-tune library anywhere. For higher native resolution and cleaner anatomy, the SDXL-based ecosystems (SDXL, Pony, Illustrious) are the natural step up, and FLUX.1 leads on prompt adherence and in-image text. But for fast iteration, stylized art, and reusing a decade of community resources, SD 1.5 remains the lightest and most flexible starting point.',
    ],
    promptTips: [
      'Prompt in tags, not sentences — short, comma-separated keywords following the pattern [quality tags], [subject], [scene], [lighting], [camera/lens], [style]. Front-load the most important concepts, since SD 1.5 weights early tokens more heavily.',
      'Mind the 77-token CLIP limit (75 usable per chunk). Keep prompts focused; anything past 75 tokens rolls into a new chunk with diminishing effect. Use the BREAK keyword to force a fresh chunk and stop concepts (like colors) bleeding between subjects.',
      'Use weight syntax to steer attention: (word:1.3) emphasizes, with a safe range of about 0.5–1.5 — above 1.5 introduces artifacts. Shorthand (word) is ~1.1×, ((word)) ~1.21×, and [word] lowers it to ~0.91×.',
      'Write a strong negative prompt — it is essential on SD 1.5, and extensive negatives (30+ terms) are common and effective. Combine anatomy fixes (bad hands, extra fingers), quality terms (low quality, blurry, jpeg artifacts), and any unwanted styles; negative embeddings like Bad Dream can stand in for a long list.',
      'Lead with quality tags (masterpiece, best quality, highly detailed, sharp focus), add LoRAs inline with <lora:name:0.7>, and remember the model is 512-native — generate at or near 512 and use highres-fix or img2img upscaling for larger, cleaner results.',
    ],
    generatorVersionId: 128713,
    featuredModels: [
      {
        modelId: 4384,
        versionId: 128713,
        imageId: 137428694,
        displayName: 'DreamShaper',
        note: 'Civitai-hosted · default',
      },
      {
        modelId: 25995,
        versionId: 48150,
        imageId: 66394794,
        displayName: 'Blindbox (3D Chibi)',
      },
      {
        modelId: 6526,
        versionId: 10913,
        imageId: 121383002,
        displayName: 'Studio Ghibli Style',
      },
      {
        modelId: 54233,
        versionId: 125985,
        imageId: 117888501,
        displayName: 'Ghibli Background',
      },
      {
        modelId: 109043,
        versionId: 122580,
        imageId: 92622344,
        displayName: 'Skin & Hands (Polyhedron)',
      },
      {
        modelId: 5529,
        versionId: 6433,
        imageId: 131026757,
        displayName: 'Eye LoRA',
      },
    ],
    featuredExamples: [
      {
        imageId: 127054434,
        prompt: 'A surreal scene, the protagonist of an ancient book, muted painterly tones',
        settings: 'Steps 20 · DreamShaper · 512×768',
      },
      {
        imageId: 116891944,
        prompt: 'Interior of an abandoned warehouse, flaking green paint on crumbling walls',
        settings: 'Steps 20 · DreamShaper · 512×768',
      },
      {
        imageId: 131568242,
        prompt: 'Ultra-detailed macro of a goddess face sculpted from blue-veined white marble',
        settings: 'Steps 20 · DreamShaper · 512×768',
      },
      {
        imageId: 123856753,
        prompt: 'A floating city of futuristic architecture, a surreal muted dreamscape',
        settings: 'Steps 20 · DreamShaper · 512×768',
      },
      {
        imageId: 119708012,
        prompt: 'A lion formed from glowing magical energy in cyberspace',
        settings: 'Steps 20 · DreamShaper · 512×768',
      },
      {
        imageId: 124169458,
        prompt: 'A vintage sepia scene on a bridge, the Millennium Bridge in the background',
        settings: 'Steps 20 · DreamShaper · 512×768',
      },
    ],
    comparison: {
      peers: ['SDXL', 'FLUX.1', 'Pony'],
      rows: [
        {
          label: 'Best for',
          values: [
            'Speed, low VRAM, huge LoRA library',
            'Higher-res realism',
            'Photorealism, text, versatility',
            'Anime & characters',
          ],
        },
        { label: 'Prompt adherence', values: ['Fair', 'Good', 'Excellent', 'Good'], winner: 2 },
        { label: 'Text in images', values: ['Weak', 'Weak', 'Strong', 'Weak'], winner: 2 },
        {
          label: 'Speed on Civitai',
          values: ['Fastest (1–3s)', 'Fast (3–6s)', 'Medium (4–8s)', 'Fast (3–6s)'],
          winner: 0,
        },
        {
          label: 'LoRA ecosystem',
          values: ['{loras:SD1}', '{loras:SDXL}', '{loras:Flux1}', '{loras:Pony}'],
        },
        { label: 'Available on Civitai', values: ['✓ Yes', '✓ Yes', '✓ Yes', '✓ Yes'] },
      ],
    },
    faq: [
      {
        q: 'How much does it cost to generate with SD 1.5?',
        a: 'Generation on Civitai runs on Buzz, and SD 1.5 is the cheapest ecosystem to run — it is a small, 512-native model, so each image costs only a little Buzz. Every account earns free Blue Buzz daily by reacting to images and other on-site activity, and because SD 1.5 renders are so light, that daily Blue Buzz stretches a long way: you can iterate through many images without spending real money. Heavier models cost more per render, so reserve a membership for when you move up to SDXL or FLUX.1 — for SD 1.5, free Blue Buzz alone goes far.',
      },
      {
        q: 'Why use SD 1.5 when newer models exist?',
        a: 'It is the fastest and lightest option, and it has the largest catalog of community LoRAs and fine-tunes by far. For quick iteration and niche styles it is still unbeaten — try it on Civitai.',
      },
      {
        q: 'Can I train my own SD 1.5 LoRA?',
        a: 'Yes. SD 1.5 is the easiest and cheapest base to fine-tune, and you can train a LoRA directly on Civitai — no local GPU needed. Publish it to earn Buzz when others generate with it.',
      },
      {
        q: 'Do I need a GPU to run SD 1.5?',
        a: 'Not on Civitai — we run the compute for you. Locally it is very light, running on as little as 4GB of VRAM.',
      },
      {
        q: 'How do I combine a checkpoint with LoRAs?',
        a: 'Pick an SD 1.5 checkpoint, then stack up to 5 LoRAs in the generator to blend styles. Remix an example to see how the settings carry over.',
      },
    ],
    localRun: { vram: '4GB+ VRAM', weightsSize: '~2–4GB', tool: 'ComfyUI' },
    attribution: 'the original open Stable Diffusion 1.5 by Runway / Stability AI',
  },

  HiDream: {
    key: 'HiDream',
    updatedAt: '2026-07-23',
    name: 'HiDream',
    metaDescription:
      'Generate with HiDream I1 on Civitai — an open 17B mixture-of-experts model with strong prompt adherence and legible in-image text. Browse HiDream models & prompts.',
    modality: 'image',
    hero: {
      intro:
        'HiDream I1 is an open-weight text-to-image model from HiDream.ai built on a 17B sparse mixture-of-experts transformer, known for strong prompt adherence and legible in-image text. Generate detailed images from a plain-language description in seconds — no GPU, no install. Run HiDream right here on Civitai.',
      badges: ['Text-to-Image', 'By HiDream.ai', 'Open weights (17B MoE)'],
    },
    overview: [
      'HiDream I1 is an open-weight text-to-image foundation model from HiDream.ai, released with 17 billion parameters and positioned as a state-of-the-art open model for high-quality generation in seconds. It is widely documented as a sparse mixture-of-experts transformer that pairs strong prompt adherence with unusually legible in-image text — the kind of typography earlier open models struggled with. The weights and reference implementation are public (github.com/HiDream-ai/HiDream-I1), and on Civitai the checkpoint is hosted so you can generate without downloading the roughly 17GB of weights or owning a GPU.',
      'HiDream I1 ships in a few variants that trade speed for control. The Full variant runs the long 50-step sampling path and supports classifier-free guidance, which is what makes true negative prompts work; the distilled Dev and Fast variants run at CFG 1 for far quicker drafts, but negative prompts stop helping there and can actually hurt. The model reads natural-language descriptions rather than tag lists, responds strongly to explicit style cues, and handles complex multi-subject scenes and detailed backgrounds well. Around it, the community has built practical LoRAs — skin and face detailers, photorealism and color-correction packs, and stylistic sets like coloring-book, comic, and vector looks — that stack on top of the base checkpoint in the generator.',
      'Choose HiDream when prompt fidelity and clean rendered text are the priority — layered scenes, posters, signage, and prompts where every described element needs to land. It sits alongside FLUX.1 and Qwen as a natural-language, adherence-first model; FLUX.1 carries a much larger LoRA library and a photorealism reputation, and lighter SDXL-based checkpoints remain faster and deeper for anime and character styles. HiDream is the pick when you would rather the model follow a detailed description exactly than reach for a specialized style ecosystem, and its 17B size means each image costs more Buzz than a lighter checkpoint.',
    ],
    promptTips: [
      'Write in natural language — full descriptive sentences, not comma-separated tags. Detailed descriptions yield sharper results than tag lists. A useful template is: subject and action, then setting and environment, then style descriptors, then lighting and mood.',
      'Do not use weight syntax or brackets. Constructs like (word:1.4) and ((word)) are not supported and cause issues — describe emphasis in words instead.',
      'Negative prompts only work in the Full (50-step) variant via CFG. In the distilled Dev and Fast variants CFG is 1, so negatives are detrimental — leave them empty there.',
      'For text in an image, put the exact words in double quotation marks (e.g. a sign reading "OPEN"). HiDream renders quoted text far more reliably than unquoted.',
      'Lean on style cues — HiDream responds strongly to them. Append "in the style of ..." for zero-shot styles, and stack styles when you want a blend, but note the later style token tends to dominate.',
    ],
    generatorVersionId: 1771369,
    featuredModels: [
      {
        modelId: 1562709,
        versionId: 1771369,
        imageId: 136632803,
        displayName: 'HiDream I1',
        note: 'Civitai-hosted · default',
      },
      {
        modelId: 1498919,
        versionId: 1695611,
        imageId: 111309075,
        displayName: 'HiDream Skin Detailer',
      },
      {
        modelId: 1747094,
        versionId: 1977271,
        imageId: 127220467,
        displayName: 'Hi-Dream Photorealism',
      },
      {
        modelId: 1693007,
        versionId: 2021612,
        imageId: 89847519,
        displayName: 'Rogue Ligne Claire Comic',
      },
      {
        modelId: 1518899,
        versionId: 1718480,
        imageId: 72889384,
        displayName: 'Coloring Book HiDream',
      },
      {
        modelId: 1539779,
        versionId: 1742231,
        imageId: 73992500,
        displayName: 'Simple Vector HiDream',
      },
    ],
    featuredExamples: [
      {
        imageId: 136632801,
        prompt:
          'Close-up portrait of a woman with delicate freckles, wavy brown hair, soft melancholic gaze',
        settings: 'Steps 20 · HiDream I1 · 1024×1024',
      },
      {
        imageId: 135179102,
        prompt:
          'A LEGO spiral stairway to heaven with brick doors climbing the exterior of the coil',
        settings: 'Steps 20 · HiDream I1 · 1024×1024',
      },
      {
        imageId: 135155940,
        prompt:
          'A 3D render of a futuristic multi-layered object of concentric rings with intricate internal geometry',
        settings: 'Steps 20 · HiDream I1 · 1024×1024',
      },
      {
        imageId: 134791850,
        prompt:
          'A warm realistic portrait of a vibrant 66-year-old hippie woman, silver hair with daisies and beads',
        settings: 'Steps 20 · HiDream I1 · 1024×1024',
      },
      {
        imageId: 134581807,
        prompt:
          'A surreal silhouette walking into a massive vertical wall of solid, unmoving black water',
        settings: 'Steps 20 · HiDream I1 · 1024×1024',
      },
      {
        imageId: 133427618,
        prompt:
          'Photo-realistic group of cheerful students smiling together inside a bright library',
        settings: 'Steps 20 · HiDream I1 · 1024×1024',
      },
    ],
    comparison: {
      peers: ['FLUX.1', 'SDXL', 'Qwen'],
      rows: [
        {
          label: 'Best for',
          values: [
            'Prompt accuracy, in-image text',
            'Photorealism, versatility',
            'General purpose, speed',
            'Complex prompts, text',
          ],
        },
        { label: 'Prompt adherence', values: ['Excellent', 'Excellent', 'Good', 'Excellent'] },
        { label: 'Text in images', values: ['Strong', 'Strong', 'Weak', 'Strong'] },
        {
          label: 'Speed on Civitai',
          values: ['Medium (6–12s)', 'Fast (4–8s)', 'Fastest (2–4s)', 'Medium (6–12s)'],
          winner: 2,
        },
        {
          label: 'LoRA ecosystem',
          values: ['{loras:HiDream}', '{loras:Flux1}', '{loras:SDXL}', '{loras:Qwen}'],
        },
        { label: 'Available on Civitai', values: ['✓ Yes', '✓ Yes', '✓ Yes', '✓ Yes'] },
      ],
    },
    faq: [
      {
        q: 'How much does it cost to generate with HiDream?',
        a: 'Generation on Civitai runs on Buzz. You can claim free Blue Buzz every day — through actions like reacting to images and other on-site activity — and put it straight toward generating, no real money required. HiDream I1 is a large 17B model, so it costs more Buzz per image than lighter checkpoints; for heavier use let your Blue Buzz accumulate or add a membership for higher limits.',
      },
      {
        q: 'What makes HiDream different from FLUX.1?',
        a: 'HiDream I1 uses a 17B sparse mixture-of-experts architecture tuned for prompt accuracy and clean in-image text, while FLUX.1 leans into photorealism and a huge LoRA library. Try HiDream on Civitai and compare for yourself.',
      },
      {
        q: 'Can I train my own HiDream LoRA?',
        a: 'Yes. HiDream supports LoRA fine-tuning, and you can train one directly on Civitai — no local GPU needed. Publish it to earn Buzz when others generate with it.',
      },
      {
        q: 'Do I need a GPU to run HiDream?',
        a: 'Not on Civitai — we run the compute for you. Locally, HiDream wants a 16GB+ VRAM GPU and about 17GB of weights.',
      },
      {
        q: 'How do I combine HiDream with LoRAs?',
        a: 'Pick the HiDream I1 checkpoint, then stack LoRAs like the Skin Detailer or Photorealism packs in the generator. Remix an example to see how the settings carry over.',
      },
    ],
    localRun: { vram: '16GB+ VRAM', weightsSize: '~17GB', tool: 'ComfyUI' },
    attribution: 'an open-weight image model by HiDream.ai',
    factCheck: [
      {
        field: 'overview',
        claim: '17B sparse mixture-of-experts transformer',
        highlight: '17B sparse mixture-of-experts transformer',
        note: 'Verify the parameter count / MoE architecture against HiDream I1 release notes.',
      },
    ],
  },

  Flux2: {
    key: 'Flux2',
    updatedAt: '2026-07-23',
    additionalEcosystemKeys: [
      'Flux2Klein_9B',
      'Flux2Klein_9B_base',
      'Flux2Klein_4B',
      'Flux2Klein_4B_base',
    ],
    name: 'FLUX.2',
    metaDescription:
      "Generate with FLUX.2 on Civitai — Black Forest Labs' latest, with sharper prompt adherence, cleaner in-image text, and stronger photorealism. Browse models & prompts.",
    modality: 'image',
    hero: {
      intro:
        'FLUX.2 is the latest generation of Black Forest Labs text-to-image models — sharper prompt adherence, cleaner in-image text, and stronger photorealism than the original FLUX.1. The open-weight FLUX.2 [klein] variants run locally, while Pro and Flex are available through the API. Generate with every FLUX.2 model right here on Civitai — no GPU, no install.',
      badges: ['Text-to-Image', 'By Black Forest Labs', 'Open weights (Klein) + API'],
    },
    overview: [
      'FLUX.2 is the current generation of open and API text-to-image models from Black Forest Labs, the team of former Stable Diffusion researchers behind the original FLUX.1. Where the first FLUX.1 paired its transformer with a T5 text encoder, FLUX.2 moves to the Mistral Small 3.2 text encoder, giving it noticeably stronger language understanding — it parses long, natural-language descriptions and handles instructions in multiple languages. The result is sharper prompt following, cleaner in-image text, and more believable photorealism than the model it replaces.',
      'The lineup is a set of tiers rather than a single model. FLUX.2 [dev] is the open-weight, quality-first checkpoint (weights are published on Hugging Face and hosted here on Civitai); the FLUX.2 [klein] family — released in 9B and 4B sizes, plus matching "base" variants — is Black Forest Labs’ fastest line yet, folding generation and editing into one compact architecture that can finish an image in roughly a second. Above the open weights sit the API-only tiers — Pro and Flex — tuned for higher fidelity and finer control. Every one of them is generatable on Civitai, so you can move between the open [klein] and [dev] checkpoints and the hosted API tiers without downloading weights or standing up a local rig.',
      'Choose FLUX.2 when prompt fidelity, legible typography, precise color, or photographic realism matter most — product shots, posters, text-in-image work, and complex multi-subject scenes are where it shines. If you want the smallest, fastest footprint for local iteration, reach for a [klein] variant; if you want maximum quality and are generating on Civitai anyway, [dev] or the API tiers give you more headroom. For anime and character art the SDXL-based Pony and Illustrious ecosystems still hold a deeper LoRA library, but FLUX.2’s own LoRA catalog is growing quickly on top of the open [klein] and [dev] bases.',
    ],
    promptTips: [
      'Write in natural language — full sentences, not comma-separated tags. FLUX.2 uses the Mistral Small 3.2 text encoder, so describe the scene the way you would to a person. It technically accepts very long prompts, but the sweet spot is still about 30–80 words.',
      'Front-load what matters. Word order carries weight in FLUX.2, so lead with the subject and its action before layering in style, lighting, and mood.',
      'Skip weight syntax and negative prompts. (word:1.5) and similar SD-style emphasis are completely ignored, and there is no negative prompt — state what you want ("sharp, crisp focus") instead of what to avoid.',
      'For precise color, name exact shades and materials — "a deep cobalt-blue ceramic vase with a glossy glaze" — rather than a vague word like "blue."',
      'Specific lighting and camera/lens references land well ("warm golden window light," "shot on 80mm, f/2.8"), and prompting in a native language can produce more culturally authentic results.',
    ],
    generatorVersionId: 2439067,
    featuredModels: [
      {
        modelId: 2165902,
        versionId: 2439067,
        imageId: 137385357,
        displayName: 'FLUX.2 [dev]',
        note: 'Civitai-hosted · default',
      },
      {
        modelId: 2322332,
        versionId: 2612554,
        imageId: 137403800,
        displayName: 'FLUX.2 [klein] 9B',
        note: 'Open weights · runs local',
      },
      {
        modelId: 2324991,
        versionId: 2615475,
        imageId: 130046417,
        displayName: 'Klein Anatomy / Quality Fixer',
      },
      {
        modelId: 144142,
        versionId: 2693132,
        imageId: 121223171,
        displayName: 'Stickers.Redmond',
      },
      {
        modelId: 2324315,
        versionId: 2614707,
        imageId: 128790832,
        displayName: 'Klein Base → Turbo LoRA',
      },
      {
        modelId: 137562,
        versionId: 2702260,
        imageId: 127780446,
        displayName: 'StudioGhibli.Redmond',
      },
    ],
    featuredExamples: [
      {
        imageId: 137403800,
        prompt: 'Soft-lit studio portrait of a woman with detailed features and a flowing dress',
        settings: 'Steps 20 · FLUX.2 [klein] 9B · 832×1216',
      },
      {
        imageId: 137403602,
        prompt: 'Dark-fantasy oil painting of a towering monstrous figure, gritty card-art style',
        settings: 'Steps 20 · FLUX.2 · 832×1216',
      },
      {
        imageId: 137392809,
        prompt: 'Hyperrealistic illustration of a girl against a vibrant pink-themed background',
        settings: 'Steps 20 · FLUX.2 · 832×1216',
      },
      {
        imageId: 137391442,
        prompt:
          'A menacing hooded figure cloaked in a tattered dark robe, chains hanging in shadow',
        settings: 'Steps 20 · FLUX.2 · 832×1216',
      },
      {
        imageId: 137384687,
        prompt:
          'A desert wraith with glowing orange eyes, wrapped in earth-toned fabric among ruins',
        settings: 'Steps 20 · FLUX.2 · 832×1216',
      },
      {
        imageId: 137379838,
        prompt: 'Dramatic fashion portrait of a tall woman with cinematic studio lighting',
        settings: 'Steps 20 · FLUX.2 · 832×1216',
      },
    ],
    comparison: {
      peers: ['FLUX.1', 'SDXL', 'Qwen'],
      rows: [
        {
          label: 'Best for',
          values: [
            'Photorealism, text, prompt control',
            'Photorealism, versatility',
            'General purpose, huge LoRA library',
            'Prompt adherence, in-image text',
          ],
        },
        {
          label: 'Prompt adherence',
          values: ['Excellent', 'Excellent', 'Good', 'Excellent'],
          winner: 0,
        },
        {
          label: 'Text in images',
          values: ['Excellent', 'Strong', 'Weak', 'Excellent'],
          winner: 0,
        },
        {
          label: 'Speed on Civitai',
          values: ['Fast', 'Fast (4–8s)', 'Fastest (2–4s)', 'Medium'],
          winner: 2,
        },
        {
          label: 'LoRA ecosystem',
          values: ['{loras:Flux2}', '{loras:Flux1}', '{loras:SDXL}', '{loras:Qwen}'],
        },
        { label: 'Available on Civitai', values: ['✓ Yes', '✓ Yes', '✓ Yes', '✓ Yes'] },
      ],
    },
    faq: [
      {
        q: 'How much does it cost to generate with FLUX.2?',
        a: 'Generation on Civitai runs on Buzz, and how far it goes depends on which FLUX.2 tier you pick. The heavier FLUX.2 [dev] and the API Pro/Max/Flex tiers cost more Buzz per image, while the compact [klein] variants are the fastest and lightest way to iterate. Every account earns free Blue Buzz daily by reacting to images and other on-site activity, so you can generate with FLUX.2 without spending real money — your daily Blue Buzz stretches furthest on [klein], and you can let it accumulate or add a membership for heavier [dev] and API-tier use.',
      },
      {
        q: "What's the difference between FLUX.2 [klein], [dev], Pro and Flex?",
        a: 'Klein 9B and 4B are the open-weight variants you can download and run locally; Dev is the standard Civitai-hosted checkpoint; Pro and Flex are API-only tiers tuned for higher quality and control. All of them are generatable on Civitai.',
      },
      {
        q: 'How is FLUX.2 different from the original FLUX.1?',
        a: 'FLUX.2 is the newer generation from Black Forest Labs, with improved prompt adherence, cleaner in-image text, and better photorealism. Try the same prompt on both and remix the result to compare.',
      },
      {
        q: 'Can I run FLUX.2 locally?',
        a: 'The Klein variants are open weights — roughly 9GB (Klein 9B) or 4GB (Klein 4B) — and run in ComfyUI on a 16GB+ VRAM GPU. The Pro and Flex tiers are API-only. No GPU? Generate any of them on Civitai.',
      },
      {
        q: 'Can I train a FLUX.2 LoRA?',
        a: 'Yes — the open Klein base models support LoRA fine-tuning, and the ecosystem already has thousands of community LoRAs. Publish your own to earn Buzz when others generate with it.',
      },
    ],
    localRun: {
      vram: '16GB+ VRAM (Klein)',
      weightsSize: '~9GB (Klein 9B) / ~4GB (Klein 4B); Pro/Max/Flex are API-only',
      tool: 'ComfyUI',
    },
    attribution: 'the latest FLUX.1 generation by Black Forest Labs',
  },
  Krea2: {
    key: 'Krea2',
    updatedAt: '2026-07-23',
    name: 'Krea 2',
    metaDescription:
      "Generate with Krea 2 on Civitai — Krea AI's model for sharp photorealism, strong aesthetics, and dependable prompt adherence. Browse checkpoints, LoRAs & prompts.",
    modality: 'image',
    isNew: true,
    hero: {
      intro:
        "Krea 2 is Krea AI's in-house text-to-image model, built for sharp photorealism, strong aesthetics, and dependable prompt adherence. Describe a scene and get a polished, high-resolution image in seconds — no GPU, no install. Run every Krea 2 variant right here on Civitai.",
      badges: ['Text-to-Image', 'By Krea', 'Open weights + API'],
    },
    overview: [
      "Krea 2 is Krea AI's first foundation image model, trained from scratch to prioritize how an image feels — its mood, lighting, and texture — rather than just what it contains. It's served on Civitai through the official fal.ai API partnership, so you can generate with the closed-weights hosted build directly on-site with no GPU or install. The model is designed around aesthetic control: style references with per-reference strength, moodboards, and a tunable creativity dial (raw, low, medium, high) that governs how far the model may drift from your inputs, making the prompt only one input among several.",
      "The hosted model ships in two sizes. Large is the bigger build, with softer post-training that leaves more of the raw base character intact; it's the pick for photorealism of humans and animals, motion blur, film grain, low dynamic range, and imperfect lighting that reads as a real photograph. Medium is smaller, faster, and cheaper, with heavier post-training that pushes it toward illustration, anime, painting, and other stylized aesthetics with clean line work. Alongside these, Krea released two open-weight checkpoints on Hugging Face: Raw, the undistilled full-guidance build (Krea recommends ~52 steps at CFG 3.5) that carries the highest quality ceiling and is the intended target for fine-tuning and LoRA training; and Turbo, an 8-step distilled build of Raw that runs without classifier-free guidance for fast inference at 1K–2K resolution (up to 2048×2048).",
      'Choose Krea 2 when you want photoreal grit or a defined illustration style with minimal fuss — it has a noticeable edge on the hard cases other models fight you on: lens flares, chrome and metallic surfaces, motion blur, glitter and iridescent textures, film grain, and starburst highlights. Reach for Large for chrome, lens flares, and photographic realism; Medium for clean stylized art; Raw when you want the maximum quality ceiling or a predictable base for training; and Turbo when you want Krea 2 aesthetics at a fraction of the compute. LoRAs trained on Raw carry over to Turbo, so you can train once on the full model and run inference fast on the distilled build.',
    ],
    promptTips: [
      'Write in natural, descriptive language — Krea 2 was trained to interpret how an image should feel, so adjectives about mood, lighting, material, and texture carry real weight. A useful order is subject and action, setting and composition, lighting and atmosphere, material and texture, then aesthetic or film-stock reference.',
      'Skip weight syntax — (word:1.5), [word], and ((word)) are read as literal text and ignored as weights. Emphasize by describing what you want more vividly instead.',
      'Steer with what you DO want, not negatives — negative prompts have minimal effect here. Krea 2 is built around style references, moodboards, and the creativity dial (raw/low/medium/high) rather than a "what to avoid" channel.',
      'Lean into its strengths with specific language — for lens flares, chrome, motion blur, glitter, iridescence, film grain, or starburst highlights, name the exact look rather than describing it generically.',
      'Keep prompts around 300 words as the practical sweet spot — there is no published token limit, but longer prompts stop adding signal past that. Aesthetic direction lives outside the text: attach a style reference or moodboard if your prompt is style-light, and pick Large (photoreal) vs. Medium (illustration) via the variant selector, not the prompt.',
    ],
    generatorVersionId: 2983022,
    featuredModels: [
      {
        modelId: 2656567,
        versionId: 2983022,
        imageId: 137356834,
        displayName: 'Krea 2 (Large)',
        note: 'Civitai-hosted · default',
      },
      {
        modelId: 2732656,
        versionId: 3072332,
        imageId: 137421220,
        displayName: 'Krea 2 Turbo',
        note: 'Open weights · fast',
      },
      {
        modelId: 2732654,
        versionId: 3072329,
        imageId: 137414876,
        displayName: 'Krea 2 Raw',
        note: 'Open weights · base checkpoint',
      },
      {
        modelId: 2656567,
        versionId: 2983023,
        imageId: 137426132,
        displayName: 'Krea 2 (Medium)',
        note: 'Civitai-hosted · lighter tier',
      },
      {
        modelId: 2756809,
        versionId: 3102079,
        imageId: 137190906,
        displayName: "Elusarca's Krea 2 Detail Enhancer",
      },
      {
        modelId: 2764349,
        versionId: 3111281,
        imageId: 136138587,
        displayName: 'Krea 2 Style Reference LoRA',
      },
    ],
    featuredExamples: [
      {
        imageId: 137403105,
        prompt: 'A contemplative photo through a tinted office glass wall at blue hour',
        settings: 'Steps 20 · Krea 2 · 1024×1024',
      },
      {
        imageId: 137403095,
        prompt: 'A candid shot through a city bus window at night',
        settings: 'Steps 20 · Krea 2 · 1024×1024',
      },
      {
        imageId: 137403085,
        prompt: 'A moody photograph through a rain-streaked cafe window at dusk',
        settings: 'Steps 20 · Krea 2 · 1024×1024',
      },
      {
        imageId: 137403066,
        prompt: 'A young couple in the back seat of a yellow taxi at night',
        settings: 'Steps 20 · Krea 2 · 1024×1024',
      },
      {
        imageId: 137402767,
        prompt: 'An architectural photo through the glass partition of a modern open-plan office',
        settings: 'Steps 20 · Krea 2 · 1024×1024',
      },
      {
        imageId: 137402740,
        prompt: 'An intimate photograph through half-open white venetian blinds',
        settings: 'Steps 20 · Krea 2 · 1024×1024',
      },
    ],
    comparison: {
      peers: ['FLUX.1', 'SDXL', 'Qwen'],
      rows: [
        {
          label: 'Best for',
          values: [
            'Photorealism & aesthetics',
            'Photorealism, text, versatility',
            'General purpose & speed',
            'Prompt adherence & text',
          ],
        },
        {
          label: 'Prompt adherence',
          values: ['Very good', 'Excellent', 'Good', 'Excellent'],
          winner: 1,
        },
        { label: 'Text in images', values: ['Good', 'Strong', 'Weak', 'Strong'], winner: 1 },
        {
          label: 'Speed on Civitai',
          values: ['Fast with Turbo (3–6s)', 'Fast (4–8s)', 'Fastest (2–4s)', 'Medium (5–10s)'],
          winner: 2,
        },
        {
          label: 'LoRA ecosystem',
          values: ['{loras:Krea2}', '{loras:Flux1}', '{loras:SDXL}', '{loras:Qwen}'],
        },
        { label: 'Available on Civitai', values: ['✓ Yes', '✓ Yes', '✓ Yes', '✓ Yes'] },
      ],
    },
    faq: [
      {
        q: 'What is Krea 2?',
        a: "Krea 2 is Krea AI's in-house text-to-image model, tuned for photorealism and clean aesthetics. You can generate with it on Civitai — no GPU or install required.",
      },
      {
        q: 'How much does it cost to generate with Krea 2?',
        a: 'Generation on Civitai runs on Buzz. You can claim free Blue Buzz every day — through actions like reacting to images and other on-site activity — and put it straight toward generating, no real money required. The lighter, distilled Turbo build (8 steps) is the cheapest way to sample Krea 2, so your daily Blue Buzz stretches further, while the larger hosted Large tier and the full-guidance Raw build cost more Buzz per image — heavier use means letting your Blue Buzz accumulate or adding a membership for higher limits.',
      },
      {
        q: "What's the difference between Krea 2, Turbo, and Raw?",
        a: 'The default Large/Medium tiers balance quality and cost, Turbo trades a little detail for faster generations, and Raw is the base checkpoint. Try each in the generator and keep the one that fits your shot.',
      },
      {
        q: 'Can I run Krea 2 locally or train a LoRA?',
        a: 'The Raw and Turbo checkpoints ship open weights you can download, and Krea 2 supports LoRA fine-tuning. You can also train a LoRA directly on Civitai with no local GPU and earn Buzz when others use it.',
      },
      {
        q: 'Do I need a GPU to use Krea 2?',
        a: 'Not on Civitai — we run the compute for you. Locally, plan on a 16GB+ VRAM GPU for the open-weight checkpoints.',
      },
    ],
    localRun: { vram: '16GB+ VRAM', weightsSize: '~12.5–25GB', tool: 'ComfyUI' },
    attribution: 'an image model by Krea',
  },

  Anima: {
    key: 'Anima',
    updatedAt: '2026-07-23',
    name: 'Anima',
    metaDescription:
      "Generate with Anima on Civitai — CircleStone Labs' open anime model for clean linework, expressive characters, and vivid color. Browse top Anima LoRAs & prompts.",
    modality: 'image',
    hero: {
      intro:
        'Anima is an open-weight anime and illustration model from CircleStone Labs, built for clean linework, expressive characters, and vivid color straight from a prompt. It reads booru-style tags and natural language, and pairs with a fast-growing library of community LoRAs. Generate with it right here on Civitai — no GPU, no install.',
      badges: ['Text-to-Image', 'By CircleStone Labs', 'Open weights · Non-commercial'],
    },
    overview: [
      'Anima is a 2-billion-parameter text-to-image model built through a collaboration between CircleStone Labs and Comfy Org. It is focused on anime concepts, characters, and styles, and extends to other non-photorealistic, illustrative art — but it is explicitly not built for photorealism and will not do it well. It was trained on several million anime images plus roughly 800k non-anime artistic images, with no synthetic data, and an anime knowledge cut-off of September 2025. Architecturally it is compact and Comfy-native: it pairs the diffusion model with a Qwen 3 0.6B text encoder and the Qwen-Image VAE, and reads Danbooru-style tags, natural-language captions, or any mix of the two.',
      'Anima ships as a small family rather than a single checkpoint. Anima-Base is the pretrained, unrefined model — maximum flexibility, diversity, and style adherence, and the version you should train LoRAs against. Anima-Aesthetic is fine-tuned on high-quality images for a more consistent, better default art style, and no longer needs quality tags in the prompt. Anima-Turbo is a distilled few-step variant meant for CFG 1 and roughly 8–12 steps: it generates fast and gains stability and a strong default style, at the cost of some diversity. The authors suggest starting with Turbo for quick iteration, since it is only slightly behind Aesthetic while being much cheaper on step-scaled platforms.',
      'Choose Anima when you want clean anime and illustration work from a lightweight model — its Danbooru vocabulary, artist-tag control, and low compute footprint make it fast and cheap to iterate on. Because it runs at native ~1MP resolutions and is a preview checkpoint, it is strongest at square-ish and standard portrait/landscape sizes rather than very large canvases, and its plain base style rewards adding quality and artist tags. For heavy character-and-booru breadth or the deepest LoRA libraries, the SDXL-based Illustrious, Pony, and NoobAI ecosystems still lead — but Anima trades that scale for speed, a modern September-2025 anime knowledge base, and a growing set of community LoRAs.',
    ],
    promptTips: [
      'Prompt with Danbooru-style tags, natural-language captions, or a mix of both — Anima was trained with tag dropout, so you do not need to list every relevant tag. When using tags, follow the order [quality/meta/year/safety] [1girl/1boy/etc] [character] [series] [artist] [general tags], lowercase with spaces instead of underscores.',
      'Prefix every artist tag with "@" (e.g. "@nnn yryr"). Without the "@" the artist effect is very weak. Artist and quality tags meaningfully improve aesthetics because the base checkpoint is intentionally neutral — though Anima-Aesthetic already looks good and does not need quality or score tags.',
      'Prompt weighting works, but Anima needs a higher weight than SDXL to register — reach for something like (word:2) rather than the usual (word:1.2). Beyond emphasis, steer mainly with tags and description.',
      'Negative prompts are supported and useful, especially for quality ("worst quality, low quality, jpeg artifacts") and for safety steering — add a safety tag (safe / sensitive / nsfw / explicit) in the positive and/or negative to control content.',
      'When naming a character, also describe their basic appearance (hair, eyes, outfit) — critical in multi-character scenes, where names alone make the model confuse characters. If prompting in pure natural language, write at least two sentences; very short prompts give unpredictable results on this preview checkpoint, and you can place quality/safety/@artist tags at the start of an NL prompt.',
    ],
    generatorVersionId: 2945208,
    featuredModels: [
      {
        modelId: 2458426,
        versionId: 2945208,
        imageId: 137428630,
        displayName: 'Anima (base v1.0)',
        note: 'Civitai-hosted · default',
      },
      {
        modelId: 2458426,
        versionId: 3108589,
        imageId: 137420504,
        displayName: 'Anima (turbo v1.0)',
        note: 'Civitai-hosted · few-step',
      },
      {
        modelId: 2540444,
        versionId: 2855073,
        imageId: 137421907,
        displayName: 'Anima Highres / Aesthetic Boost',
      },
      {
        modelId: 2612570,
        versionId: 2945328,
        imageId: 137340659,
        displayName: 'Anima Quality Enhance Slider',
      },
      {
        modelId: 30480,
        versionId: 2946118,
        imageId: 130728738,
        displayName: 'LOGH Fleet Style',
      },
      {
        modelId: 441397,
        versionId: 3024562,
        imageId: 133502481,
        displayName: 'Hanfu',
      },
    ],
    featuredExamples: [
      {
        imageId: 137408742,
        prompt: 'A female knight in ornate armor standing in a sunlit meadow, 3D-animated style',
        settings: 'Steps 20 · Anima · 832×1216',
      },
      {
        imageId: 137408748,
        prompt: 'An ethereal fantasy figure with pale green skin, vibrant vertical illustration',
        settings: 'Steps 20 · Anima · 832×1216',
      },
      {
        imageId: 137408746,
        prompt: 'A dark-elf mage in an ancient overgrown temple, dramatic dark-fantasy scene',
        settings: 'Steps 20 · Anima · 832×1216',
      },
      {
        imageId: 137408744,
        prompt: 'A young woman in a dark blue hooded cloak kneeling, cinematic digital painting',
        settings: 'Steps 20 · Anima · 832×1216',
      },
      {
        imageId: 137413878,
        prompt: 'A playful fox girl with a mischievous smirk, vertical anime illustration',
        settings: 'Steps 20 · Anima · 832×1216',
      },
      {
        imageId: 137408740,
        prompt: 'A woman with long flowing blonde hair, surreal high-quality anime illustration',
        settings: 'Steps 20 · Anima · 832×1216',
      },
    ],
    comparison: {
      peers: ['Illustrious', 'Pony', 'NoobAI'],
      rows: [
        {
          label: 'Best for',
          values: [
            'Anime & illustration',
            'Anime & illustration',
            'Stylized anime art',
            'Anime, booru-accurate',
          ],
        },
        { label: 'Prompt adherence', values: ['Very good', 'Very good', 'Good', 'Very good'] },
        { label: 'Text in images', values: ['Fair', 'Fair', 'Weak', 'Fair'] },
        {
          label: 'Speed on Civitai',
          values: ['Fast (3–6s)', 'Medium (5–10s)', 'Fast (3–6s)', 'Medium (5–10s)'],
          winner: 0,
        },
        {
          label: 'LoRA ecosystem',
          values: ['{loras:Anima}', '{loras:Illustrious}', '{loras:Pony}', '{loras:NoobAI}'],
        },
        { label: 'Available on Civitai', values: ['✓ Yes', '✓ Yes', '✓ Yes', '✓ Yes'] },
      ],
    },
    faq: [
      {
        q: 'What is Anima?',
        a: 'Anima is an open-weight anime image model from CircleStone Labs, tuned for clean linework and expressive character art. You can generate with it on Civitai — no setup required.',
      },
      {
        q: 'How much does it cost to generate with Anima?',
        a: 'Generation on Civitai runs on Buzz, and Anima is one of the cheaper models to run — it is a compact 2-billion-parameter checkpoint, and the distilled Anima-Turbo variant renders in only about 8–12 steps, so each image costs relatively little Buzz. Every account earns free Blue Buzz daily by reacting to images and other on-site activity, which stretches a long way on a light model like this — you can iterate on prompts without spending real money. Add a membership only if you want higher limits for heavy batches.',
      },
      {
        q: 'How do I prompt Anima?',
        a: 'Anima understands both booru-style tags and natural-language descriptions, so you can mix quality tags with a plain scene description. Remix any example to see the exact settings.',
      },
      {
        q: 'Can I train or use Anima LoRAs?',
        a: 'Yes. Anima supports LoRA fine-tuning, and you can train one directly on Civitai — no local GPU needed. Stack community LoRAs in the generator to blend styles.',
      },
      {
        q: 'Can I use Anima commercially?',
        a: 'Anima ships under the CircleStone Non-Commercial License, so check its terms before commercial use. You can still generate and experiment with it on Civitai.',
      },
    ],
    localRun: { vram: '8GB+ VRAM', weightsSize: '~7GB', tool: 'ComfyUI' },
    attribution: 'an open-weight anime image model by CircleStone Labs',
  },

  ZImageTurbo: {
    key: 'ZImageTurbo',
    updatedAt: '2026-07-23',
    additionalEcosystemKeys: ['ZImageBase'],
    slug: 'z-image',
    name: 'Z-Image',
    metaDescription:
      "Generate with Z-Image on Civitai — Alibaba's compact ~6B open model that punches above its size on prompt adherence and in-image text. Browse models & prompts.",
    modality: 'image',
    hero: {
      intro:
        "Z-Image is a family of open-weight text-to-image models from Alibaba's Tongyi Lab, built on a compact ~6B architecture that punches well above its size on prompt adherence, clean composition, and legible in-image text — including Chinese and English. The Turbo variant renders in just a handful of steps, while the Base model trades speed for maximum fidelity. Generate with both right here on Civitai — no GPU, no install.",
      badges: ['Text-to-Image', 'By Alibaba · Tongyi Lab', 'Open weights'],
    },
    overview: [
      "Z-Image is an open-weight text-to-image family from Alibaba's Tongyi Lab (released under the Tongyi-MAI banner), built on a compact ~6-billion-parameter architecture. Despite its small size it targets photorealistic image generation, bilingual text rendering in both English and Chinese, and robust instruction adherence — the kind of prompt-following that usually demands a much larger model. Because the weights are lightweight, the Turbo variant fits comfortably within 16GB of consumer VRAM and reaches sub-second latency on enterprise H800 GPUs.",
      'The family ships as three checkpoints tuned for different jobs. Z-Image Turbo is a distilled model that produces a finished image in just 8 sampling steps (NFEs), making it the fast, few-step default; Z-Image Base is the non-distilled foundation model, released to unlock the full quality ceiling and to give the community a clean base for fine-tuning and custom development; and Z-Image Edit is a separate variant tuned for instruction-driven image-to-image editing. On Civitai, Turbo and Base are both hosted, so you can iterate quickly on Turbo and switch to Base when you want maximum fidelity — no downloads, no local GPU.',
      "Reach for Z-Image when you want faithful prompt adherence and clean, legible in-image text — especially mixed English/Chinese text — at a fraction of the cost and wait of heavier models. Turbo is the natural pick for fast drafting and high-volume work, while Base rewards patience with the full step count for its best output. For the deepest style and character LoRA libraries, the SDXL-based Pony and Illustrious ecosystems still lead; Z-Image's own fine-tune library is smaller but growing, and its speed-to-quality ratio makes it a strong everyday text-to-image workhorse.",
    ],
    promptTips: [
      "Write in natural language and follow Z-Image's 6-part structure: Subject, Scene, Composition, Lighting, Style, Constraints — in that order. Lead with the subject (and any text you want rendered), since it matters most.",
      'Keep prompts short: attention fades after roughly 75 tokens (about 50–60 words), so front-load the important content and trim trailing detail that will otherwise be ignored.',
      'Do not use negative prompts. Turbo is a few-step distilled model with no CFG at inference, so every constraint has to be phrased positively inside the main prompt — describe what you want, not what you want to avoid.',
      'Skip weight syntax like (word:1.3) — it is not supported. Control emphasis through word order and description instead.',
      'For photorealism, lighting is the single strongest lever — be specific about it — and add sensory detail such as "skin texture," "fabric detail," "imperfections," or "film grain." For text in the image, Z-Image renders English and Chinese directly, so just state the words you want.',
    ],
    generatorVersionId: 2442439,
    featuredModels: [
      {
        modelId: 2168935,
        versionId: 2442439,
        imageId: 137428695,
        displayName: 'Z-Image Turbo',
        note: 'Civitai-hosted · fast few-step default',
      },
      {
        modelId: 2342797,
        versionId: 2635223,
        imageId: 137506011,
        displayName: 'Z-Image Base',
        note: 'Civitai-hosted · max fidelity',
      },
      {
        modelId: 144142,
        versionId: 2693208,
        imageId: 134628877,
        displayName: 'Stickers.Redmond',
      },
      {
        modelId: 137562,
        versionId: 2702273,
        imageId: 121598609,
        displayName: 'StudioGhibli.Redmond',
      },
      {
        modelId: 10706,
        versionId: 2448620,
        imageId: 122976314,
        displayName: 'LuisaP Pixel Art Refiner',
      },
      {
        modelId: 668468,
        versionId: 2691642,
        imageId: 132223106,
        displayName: 'Soothing Atmosphere',
      },
    ],
    featuredExamples: [
      {
        imageId: 123166451,
        prompt:
          'Close-up photo of a black cat in a bubble bath, thick white foam filling the frame',
        settings: 'Z-Image Turbo · 896×1248',
      },
      {
        imageId: 128243899,
        prompt:
          'Post-apocalyptic sunrise over San Francisco, the Golden Gate Bridge ruined but standing',
        settings: 'Z-Image Turbo · 832×1216',
      },
      {
        imageId: 115610275,
        prompt:
          'An open antique clock box on countryside grass, a miniature village built inside it',
        settings: 'Z-Image Turbo · 1664×2432',
      },
      {
        imageId: 128033929,
        prompt: 'Silhouetted figure under a cherry blossom tree, luminous pink petals drifting',
        settings: 'Z-Image Turbo · 2800×4096',
      },
      {
        imageId: 123089267,
        prompt:
          'High-end food photography of a fresh sushi platter, glistening salmon and soy sheen',
        settings: 'Z-Image Turbo · 1088×1920',
      },
      {
        imageId: 113237256,
        prompt:
          'A fluffy white creature with large expressive eyes floating on its back in an ethereal meadow',
        settings: 'Z-Image Turbo · 720×1280',
      },
    ],
    comparison: {
      peers: ['FLUX.1', 'SDXL', 'Qwen'],
      rows: [
        {
          label: 'Best for',
          values: [
            'Fast, faithful text-to-image',
            'Photorealism & text',
            'General purpose, speed',
            'Prompt adherence & text',
          ],
        },
        { label: 'Prompt adherence', values: ['Very good', 'Excellent', 'Good', 'Excellent'] },
        { label: 'Text in images', values: ['Strong (EN + CN)', 'Strong', 'Weak', 'Strong'] },
        {
          label: 'Speed on Civitai',
          values: ['Fastest (few-step)', 'Fast (4–8s)', 'Fast (2–4s)', 'Medium (6–12s)'],
          winner: 0,
        },
        {
          label: 'LoRA ecosystem',
          values: ['{loras:ZImageTurbo}', '{loras:Flux1}', '{loras:SDXL}', '{loras:Qwen}'],
        },
        { label: 'Available on Civitai', values: ['✓ Yes', '✓ Yes', '✓ Yes', '✓ Yes'] },
      ],
    },
    faq: [
      {
        q: 'How much does it cost to generate with Z-Image?',
        a: "Generation on Civitai runs on Buzz, and Z-Image is one of the more affordable options — its compact ~6B architecture and few-step Turbo variant mean each image costs less Buzz than heavier models like FLUX.1. Every account earns free Blue Buzz daily by reacting to images and other on-site activity, and because Z-Image is so light that daily Blue Buzz stretches a long way, letting you generate a lot without spending real money. Lean on Turbo for high-volume, few-step drafting; switch to Base when you want full fidelity and don't mind a slightly higher per-image cost, or add a membership for higher limits.",
      },
      {
        q: "What's the difference between Z-Image Turbo and Z-Image Base?",
        a: 'Turbo is distilled for speed, producing images in just a handful of steps, while Base runs the full step count for maximum fidelity. Both are hosted on Civitai — try each and remix an example to compare.',
      },
      {
        q: 'Who made Z-Image?',
        a: "Z-Image is developed and open-weighted by Alibaba's Tongyi Lab. You can run the official models on Civitai without downloading anything.",
      },
      {
        q: 'Can I train my own Z-Image LoRA?',
        a: 'Yes. Z-Image supports LoRA fine-tuning, and you can train one directly on Civitai — no local GPU needed. Publish it to earn Buzz when others generate with it.',
      },
      {
        q: 'Do I need a GPU to run Z-Image?',
        a: 'Not on Civitai — we run the compute for you. Locally, the ~6B weights fit comfortably on an 8GB+ VRAM GPU. Skip the setup and generate here instead.',
      },
    ],
    localRun: { vram: '8GB+ VRAM', weightsSize: '~12GB', tool: 'ComfyUI' },
    attribution: 'the Z-Image models by Alibaba (Tongyi Lab)',
    factCheck: [
      {
        field: 'overview',
        claim: 'compact ~6B architecture',
        highlight: 'compact ~6B architecture',
        note: 'Verify the parameter count against the Z-Image release notes.',
      },
    ],
  },
  WanVideo: {
    key: 'WanVideo',
    updatedAt: '2026-07-23',
    slug: 'wan',
    additionalEcosystemKeys: [
      'WanVideo1_3B_T2V',
      'WanVideo14B_T2V',
      'WanVideo14B_I2V_480p',
      'WanVideo14B_I2V_720p',
      'WanVideo-22-TI2V-5B',
      'WanVideo-22-I2V-A14B',
      'WanVideo-22-T2V-A14B',
      'WanVideo-25-T2V',
      'WanVideo-25-I2V',
      'WanVideo27',
    ],
    name: 'Wan',
    metaDescription:
      "Generate Wan video on Civitai — Alibaba's open models turn text or a still image into short, cinematic clips with fluid motion. Browse Wan LoRAs & example clips.",
    modality: 'video',
    hero: {
      intro:
        'Wan is a family of open-weight video models from Alibaba that turn a text prompt or a still image into short, cinematic clips with fluid, realistic motion. It covers both text-to-video and image-to-video, and anchors the deepest LoRA and motion-effect ecosystem in open video generation. Generate a clip from a description in seconds — no GPU, no install. Run every Wan model right here on Civitai.',
      badges: ['Text-to-Video & Image-to-Video', 'By Alibaba (Wan)', 'Open weights'],
    },
    overview: [
      "Wan is a family of open-weight video models from Alibaba, spanning both text-to-video (T2V) and image-to-video (I2V). The line is built around Alibaba's Wan-VAE, an efficient video autoencoder, and Wan 2.1 was notable as the first open video model able to render both Chinese and English text inside a clip. It scales across sizes — from a lightweight 1.3B T2V model that fits in about 8GB of VRAM up to the flagship 14B models — so the same ecosystem covers everything from quick consumer-GPU drafts to high-fidelity cinematic generation.",
      'The versions diverge in architecture and focus. Wan 2.2 introduces a Mixture-of-Experts (MoE) design that splits the denoising process across specialized expert models, enlarging capacity at the same compute cost, and adds a fast 5B TI2V variant (16×16×4 compression via Wan2.2-VAE) that generates 720p at 24fps on a card like a 4090; its A14B T2V and I2V models were trained on substantially more data with curated cinematic-aesthetic labels for lighting, composition, and color. Wan 2.5 is the hosted, audio-aware generation — synchronized voices, ambient sound, and music alongside cinematic 1080p output — while Wan 2.7 pushes temporal consistency and subject stability, reducing flicker, distortion, and identity drift across frames.',
      'Choose Wan when you want open, controllable video with strong native image-to-video and the deepest LoRA and motion-effect ecosystem in open video generation. Reach for the 2.2 A14B models as the open-weight workhorses for T2V and I2V, the 5B variant when speed matters, and the hosted 2.5 / 2.7 releases when you want the best prompt adherence, motion realism, or audio-synced clips. Against closed APIs like Kling you trade some polish for open weights, stackable LoRAs, and no local install when you run it here.',
    ],
    promptTips: [
      'Write in natural language, not tags — describe a cinematic scene in the order subject → action → setting → lighting → camera. Wan reads full descriptions, and weight syntax like (word:1.5) is ignored.',
      'Always include a camera direction; a missing one is the most common weak spot. Use Wan\'s vocabulary: "slow zoom in," "camera pans left," "dolly shot," "tracking shot," "aerial drone shot," or "static camera."',
      'Control motion explicitly with intensity cues like "gentle breeze," "slow-motion," or "rapid movement," and keep a single clip to one continuous action — a short shot can\'t hold several sequential events.',
      'Unlike many open image models, Wan supports negative prompts — a good default is "blurry, distorted, low quality, watermark, static, morphing, deformed hands" to suppress common video artifacts.',
      'For image-to-video, prompt only the motion you want added, not the static scene already in your image — describe what should move or change, plus the camera move and lighting/mood. For text-to-video, layer quality modifiers such as "cinematic lighting," "film grain," "HDR," or "shallow depth of field."',
    ],
    generatorVersionId: 2114154,
    featuredModels: [
      {
        modelId: 1817671,
        versionId: 2114154,
        imageId: 137027436,
        displayName: 'Wan 2.2 T2V-A14B',
        note: 'Civitai-hosted · default',
      },
      {
        modelId: 1992179,
        versionId: 2254989,
        imageId: 134237147,
        displayName: 'Wan 2.5 T2V',
        note: 'Civitai-hosted · latest',
      },
      {
        modelId: 2516027,
        versionId: 2828005,
        imageId: 137362549,
        displayName: 'Wan 2.7',
        note: 'Civitai-hosted · newest',
      },
      {
        modelId: 1329096,
        versionId: 1707796,
        imageId: 136125690,
        displayName: 'Wan 2.1 14B T2V',
        note: 'Civitai-hosted · open weights',
      },
      {
        modelId: 1346623,
        versionId: 1520902,
        imageId: 86739001,
        displayName: '360° Rotation (I2V)',
      },
      {
        modelId: 1340141,
        versionId: 1513385,
        imageId: 78849448,
        displayName: 'Squish Effect (I2V)',
      },
    ],
    featuredExamples: [
      {
        imageId: 137055622,
        prompt: 'Cinematic nighttime chase through a rain-soaked futuristic street market',
        settings: 'Wan 2.2 T2V · 480×832 · 16fps',
      },
      {
        imageId: 137055620,
        prompt: 'Six dancers in a synchronized rooftop routine over a coastal city at sunset',
        settings: 'Wan 2.2 T2V · 480×832 · 16fps',
      },
      {
        imageId: 136170283,
        prompt: 'A tiny frog hopping up and down a large leaf, wet from rain',
        settings: 'Wan 2.2 T2V · 480×832 · 16fps',
      },
      {
        imageId: 136196483,
        prompt: 'A gothic vampire portrait with subtle, moody motion',
        settings: 'Wan 2.2 I2V · 480×832 · 16fps',
      },
      {
        imageId: 134053701,
        prompt: 'A magical-girl heroine in a bright transformation-style scene',
        settings: 'Wan 2.2 I2V · 480×832 · 16fps',
      },
      {
        imageId: 132485484,
        prompt: 'An elegant character gliding toward the camera on a sunlit seaside balcony',
        settings: 'Wan 2.2 I2V · 480×832 · 16fps',
      },
    ],
    comparison: {
      peers: ['Hunyuan Video', 'LTXV', 'Kling'],
      rows: [
        {
          label: 'Best for',
          values: [
            'T2V + I2V, huge LoRA ecosystem',
            'Cinematic text-to-video',
            'Fast, lightweight clips',
            'Polished cinematic clips (API)',
          ],
        },
        {
          label: 'Prompt adherence',
          values: ['Very good', 'Very good', 'Good', 'Excellent'],
          winner: 3,
        },
        { label: 'Image-to-video', values: ['Native, strong', 'Limited', 'Yes', 'Yes'], winner: 0 },
        {
          label: 'Speed on Civitai',
          values: ['Medium', 'Medium', 'Fast', 'Medium (API)'],
          winner: 2,
        },
        {
          label: 'LoRA ecosystem',
          values: ['{loras:WanVideo}', 'Growing', '{loras:LTXV}', 'None (closed)'],
        },
        { label: 'Available on Civitai', values: ['✓ Yes', '✓ Yes', '✓ Yes', '✓ Yes'] },
      ],
    },
    faq: [
      {
        q: 'How much does it cost to generate with Wan?',
        a: 'Generation on Civitai runs on Buzz, and you can claim free Blue Buzz every day — through actions like reacting to images and other on-site activity — to put straight toward generating, no real money required. Because Wan spans a wide size range, cost tracks the model: the lighter 1.3B and 5B variants are cheap per clip so your daily Blue Buzz stretches far, while the 14B and newer hosted 2.5 / 2.7 releases cost more Buzz per generation, so heavier use means letting your Blue Buzz accumulate or adding a membership for higher limits.',
      },
      {
        q: "What's the difference between Wan text-to-video and image-to-video?",
        a: 'Text-to-video (T2V) builds a clip from a written prompt, while image-to-video (I2V) animates a still image you provide. Wan does both, and you can pick either mode right in the Civitai generator.',
      },
      {
        q: 'Which Wan version should I use?',
        a: 'Wan 2.2 is the open-weight workhorse for T2V and I2V; 2.5 and 2.7 are the newer hosted releases with improved motion and detail. All of them are generatable on Civitai — try a prompt on each and compare.',
      },
      {
        q: 'Can I use LoRAs and motion effects with Wan?',
        a: 'Yes. Civitai hosts 2,500+ Wan LoRAs — including motion effects like 360° rotation and squish — that you can stack in the generator. Remix any example above to see how the settings carry over.',
      },
      {
        q: 'Do I need a GPU to run Wan?',
        a: 'Not on Civitai — we run the compute for you. Locally the 14B models want a 16GB+ VRAM GPU in ComfyUI, though the lighter 1.3B and 5B variants run on less. Skip the setup and generate in the browser.',
      },
    ],
    localRun: {
      vram: '16GB+ VRAM (14B); less for 1.3B / 5B',
      weightsSize: '~16–32GB (14B)',
      tool: 'ComfyUI',
    },
    attribution: 'an open-weight video model by Alibaba (Wan)',
  },
  LTXV: {
    key: 'LTXV',
    updatedAt: '2026-07-23',
    additionalEcosystemKeys: ['LTXV2', 'LTXV23'],
    name: 'LTX Video',
    metaDescription:
      "Generate LTX Video on Civitai — Lightricks' fast open video model makes cinematic clips from text or an image at near real-time. Browse models & example clips.",
    modality: 'video',
    hero: {
      intro:
        'LTX Video (LTXV) is an open-weight video model from Lightricks built around a diffusion transformer tuned for speed — it generates coherent, cinematic clips from a text prompt or a starting image at close to real-time rates. The family spans the light, fast 2B model up to the latest LTX Video 2.3. Generate video right here on Civitai — no GPU, no install.',
      badges: ['Text/Image-to-Video', 'By Lightricks', 'Open weights'],
    },
    overview: [
      'LTX Video (LTXV) comes from Lightricks, the team behind the LTX-Video research line. It is built on a diffusion transformer (DiT) rather than the U-Net used by the SD/SDXL lineage, and it was the first DiT-based video model able to generate high-quality clips in real time — the original release produces 24 FPS video faster than it can be watched. Like other transformer models it reads long, natural-language descriptions through a T5 text encoder, and it handles both text-to-video and image-to-video from a single starting frame.',
      'The family has grown from a fast, lightweight base into a full audio-visual foundation model. The 2B model (0.9.x) is the light, near-real-time option; LTX Video 2 (19B) is a joint audio-video model that generates synchronized video and audio together within one network; and LTX Video 2.3 is a significant update to LTX-2 with improved audio and visual quality and stronger prompt adherence. All are open-weight and built for practical local execution, and the ecosystem has already spawned community fine-tunes — such as the uncensored Sulphur 2, built directly on the LTX 2.3 pipeline.',
      'Choose LTXV when iteration speed matters most: its diffusion-transformer design turns prompts and starting images into coherent clips far faster than heavier video models, and newer versions add synchronized audio in the same pass. For the deepest LoRA library and the most detailed motion control, the Wan ecosystem still leads; Hunyuan Video leans toward cinematic realism, and Kling is a closed cloud API. Because even the larger LTXV models are engineered for efficiency, they generally cost less Buzz per second of video than the heaviest open alternatives.',
    ],
    promptTips: [
      'Write in natural language, not tags — LTXV uses a T5 text encoder, and moderate detail of two to four sentences works best. A reliable template is: [Subject and action]. [Setting]. [Camera movement]. [Lighting and style].',
      'Describe subject movement and camera movement separately, and always include a camera cue — e.g. "camera panning slowly to the right," "slow zoom in," or "static wide shot." Missing camera direction is the most common weak spot in LTXV prompts.',
      'Skip weight syntax — (word:1.5) and similar emphasis markers are not used. Say what you want directly instead.',
      'Negative prompts are supported (applied via CFG). A solid default is "worst quality, blurry, jittery, distorted, watermark, low resolution, inconsistent motion."',
      'Keep clips short and describe one continuous action. Packing many sequential events into a short clip hurts temporal consistency.',
    ],
    generatorVersionId: 2749908,
    featuredModels: [
      {
        modelId: 2445735,
        versionId: 2749908,
        imageId: 137300543,
        displayName: 'Lightricks LTX Video 2.3',
        note: 'Civitai-hosted · default',
      },
      {
        modelId: 2291192,
        versionId: 2578325,
        imageId: 131556870,
        displayName: 'Lightricks LTX Video 2 (19B)',
        note: 'Civitai-hosted · higher fidelity',
      },
      {
        modelId: 982559,
        versionId: 1499827,
        imageId: 83658016,
        displayName: 'Lightricks LTXV 2B (0.9.5)',
        note: 'Civitai-hosted · fast / lightweight',
      },
      {
        modelId: 2601098,
        versionId: 2921800,
        imageId: 136022137,
        displayName: 'Sulphur 2 Base',
        note: 'Civitai-hosted · LTXV 2.3 fine-tune',
      },
      {
        modelId: 2500098,
        versionId: 2810376,
        imageId: 126739110,
        displayName: 'LTX 2.3 Dual-Character (IC-LoRA)',
      },
      {
        modelId: 2552181,
        versionId: 2868212,
        imageId: 131165432,
        displayName: 'Realism (LTX 2.3)',
      },
    ],
    featuredExamples: [
      {
        imageId: 137191028,
        prompt:
          'Cinematic medium shot of a bartender in a posh 1950s bar picking up an old telephone',
        settings: 'LTX Video 2.3 · 1280×704 · 24fps',
      },
      {
        imageId: 137191027,
        prompt:
          'Cinematic full shot of a young businessman presenting beside a chart with a red downward curve',
        settings: 'LTX Video 2.3 · 1280×704 · 24fps',
      },
      {
        imageId: 137190596,
        prompt: 'A man in a hoodie and cap pushing through a crowd in a busy subway station',
        settings: 'LTX Video 2.3 · 1280×704 · 24fps',
      },
      {
        imageId: 137190595,
        prompt: 'Cinematic close-up of a young woman seated in a dark confession booth, side view',
        settings: 'LTX Video 2.3 · 1280×704 · 24fps',
      },
      {
        imageId: 137190592,
        prompt:
          'An elderly bishop preaching from the pulpit of a gothic cathedral in rich vestments',
        settings: 'LTX Video 2.3 · 1280×704 · 24fps',
      },
      {
        imageId: 137190589,
        prompt: 'A wizard seated on a stone floor at the center of a chalk pentagram, candlelit',
        settings: 'LTX Video 2.3 · 1280×704 · 24fps',
      },
    ],
    comparison: {
      peers: ['Wan', 'Hunyuan Video', 'Kling'],
      rows: [
        {
          label: 'Best for',
          values: [
            'Fast, near real-time video',
            'Detailed motion & LoRAs',
            'Cinematic realism',
            'Polished cinematic clips',
          ],
        },
        { label: 'Prompt adherence', values: ['Very good', 'Excellent', 'Very good', 'Excellent'] },
        { label: 'Image-to-video', values: ['Yes', 'Yes', 'Yes', 'Yes'] },
        {
          label: 'Speed on Civitai',
          values: ['Fastest (near real-time)', 'Medium', 'Medium', 'API (cloud)'],
          winner: 0,
        },
        {
          label: 'LoRA ecosystem',
          values: ['{loras:LTXV}', '{loras:WanVideo}', 'Small', 'None (closed)'],
        },
        {
          label: 'Available on Civitai',
          values: ['✓ Yes', '✓ Yes', '✓ Yes', 'Paid API'],
          winner: 0,
        },
      ],
    },
    faq: [
      {
        q: 'What is LTX Video best at?',
        a: 'LTX Video is built for speed — its diffusion-transformer design renders coherent clips close to real time, making it ideal for fast iteration on text- and image-to-video. Try it in the Civitai generator.',
      },
      {
        q: 'How much does it cost to generate with LTX Video?',
        a: 'Generation on Civitai runs on Buzz. You can claim free Blue Buzz every day — through actions like reacting to images and other on-site activity — and put it straight toward generating, no real money required. LTX Video is engineered for efficiency, so it tends to cost less Buzz per clip than heavier video models: the light 2B model stretches your daily Blue Buzz especially far, while the larger 19B and 2.3 versions cost a bit more per generation. For heavier use, let your Blue Buzz accumulate or add a membership for higher limits.',
      },
      {
        q: "What's the difference between the LTXV versions?",
        a: 'The 2B model is the lightest and fastest; LTX Video 2 (19B) and LTX Video 2.3 trade some speed for higher fidelity and better motion. All are hosted on Civitai — pick any from the generator and compare.',
      },
      {
        q: 'Can I use LoRAs and image-to-video with LTX Video?',
        a: 'Yes. Civitai hosts 500+ LTX Video LoRAs for styles, camera moves, and characters, and LTXV supports starting from an image. Remix an example to see how the settings carry over.',
      },
      {
        q: 'Do I need a GPU to run LTX Video?',
        a: 'Not on Civitai — we run the compute for you. Locally, the 2B model is unusually light for video and runs in ComfyUI on a consumer GPU, while the larger 19B/2.3 models want more VRAM.',
      },
    ],
    localRun: { vram: '~12GB+ VRAM (2B model)', weightsSize: '~6GB (2B)', tool: 'ComfyUI' },
    attribution: 'an open-weight video model by Lightricks (LTX Video)',
  },

  Kling: {
    key: 'Kling',
    updatedAt: '2026-07-22',
    name: 'Kling',
    metaDescription:
      "Kling on Civitai — Kuaishou's hosted text-to-video & image-to-video model makes cinematic, realistic video clips. Browse Kling versions & example clips.",
    modality: 'video',
    hero: {
      intro:
        "Kling is a family of high-end text-to-video and image-to-video models from Kuaishou, one of China's largest short-form video platforms. It was built to produce coherent, cinematic clips with realistic motion, consistent subjects, and natural camera moves rather than short abstract loops. On Civitai every available Kling version is hosted, so you can turn a prompt or a still image into a clip right in the browser — no GPU, no install.",
      badges: ['Text-to-Video', 'Image-to-Video', 'By Kuaishou'],
    },
    overview: [
      "Kling is a family of text-to-video and image-to-video generation models developed by Kuaishou, one of China's largest short-form video platforms and a peer to TikTok/Douyin. Best known for its consumer video apps, Kuaishou introduced Kling in 2024 as its move into foundational generative video. Rather than the earlier 'motion-from-image' approach built around short loops or abstract movement, Kling was designed from the ground up to produce coherent clips with realistic physics, consistent subjects, and natural camera motion.",
      'In practice the models focus on realistic, temporally stable video from a text prompt, a reference image, or both. Their strengths are smooth, believable motion — walking, flowing fabric, water, facial movement — along with consistent characters and objects across frames, natural camera behavior like pans, dolly moves, and tracking shots, and strong prompt adherence on cinematic, real-world scenes. Compared with many diffusion-based video models, Kling leans toward realism and continuity rather than surreal or heavily stylized output.',
      'Civitai hosts several Kling releases — v1.6, v2, v2.5 Turbo, and the newest Kling 3.0 — so you can move between them without any local setup. Kling is a closed, hosted model: there are no downloadable weights and no Kling LoRAs, so control comes from prompting, reference images, and Kling’s built-in camera settings rather than community fine-tunes. Choose it when you want polished, realistic motion and cinematic camera work out of the box; for open weights, stackable LoRAs, and deep motion-effect control, the Wan ecosystem is the natural alternative to compare against.',
    ],
    promptTips: [
      'Write in natural language, not tags — Kling reads detailed scene descriptions and is tuned for both English and Chinese. A reliable order is subject and action, then setting, then camera/perspective, then style and lighting.',
      "Lean into motion. Kling is built for strong, dynamic movement, so action and clear physical motion ('sprinting', 'fabric billowing in the wind', 'water splashing') play to its strengths — vague, static scenes waste its main advantage.",
      "Direct the camera. Kling exposes separate camera-motion controls (zoom, pan, tilt, rotate) and also responds to prompt cues like 'first-person perspective', 'bird's eye view', or 'slow-motion close-up'.",
      'Keep a clip to one continuous action — a prompt describing several sequential events won’t fit. Describe a single moment and use clip extension for longer sequences.',
      'Negative prompts are supported, so add standard quality negatives to suppress artifacts. For image-to-video, the first frame is anchored for stronger consistency — prompt the motion and camera you want added rather than re-describing the still.',
    ],
    generatorVersionId: 2698632,
    featuredModels: [
      {
        modelId: 2332540,
        versionId: 2698632,
        imageId: 136950722,
        displayName: 'Kling 3.0',
        note: 'Civitai-hosted · default · newest',
      },
      {
        modelId: 2332540,
        versionId: 2623821,
        imageId: 134900886,
        displayName: 'Kling 2.5 Turbo',
        note: 'Civitai-hosted · faster turbo mode',
      },
      {
        modelId: 2332540,
        versionId: 2623817,
        imageId: 126793482,
        displayName: 'Kling v2',
        note: 'Civitai-hosted',
      },
      {
        modelId: 2332540,
        versionId: 2623815,
        imageId: 135570741,
        displayName: 'Kling v1.6',
        note: 'Civitai-hosted · earlier release',
      },
    ],
    featuredExamples: [
      {
        imageId: 136950722,
        prompt:
          'A dynamic anime-style swordswoman drawing a glowing purple lightning sword in a lightning-fast iai-ken combo',
        settings: 'Kling 3.0 · 960×960',
      },
      {
        imageId: 134900886,
        prompt:
          'A sleepy sloth working as a food-delivery courier, moving in extreme slow motion while the world rushes past at normal speed',
        settings: 'Kling 2.5 Turbo · 1440×1440',
      },
      {
        imageId: 133284218,
        prompt:
          'A fierce nordic woman with platinum braids riding a massive bio-engineered mount through a desert-punk scene at golden hour',
        settings: 'Kling 3.0 · 828×1108',
      },
      {
        imageId: 136956093,
        prompt:
          'A group of tiny kitten chefs with soft fluffy fur working together to bake a red tortoise-shaped cake',
        settings: 'Kling 2.5 Turbo · 1440×1440',
      },
      {
        imageId: 132808315,
        prompt:
          'A stylish anthropomorphic cephalopod receptionist at an office desk looking up as the camera slowly zooms in',
        settings: 'Kling 2.5 Turbo · 1440×1440',
      },
      {
        imageId: 126793482,
        prompt:
          'Princess Celestia, a majestic alicorn with large ethereal wings, a golden crown, and a flowing rainbow mane',
        settings: 'Kling v2 · 1280×720',
      },
    ],
    comparison: {
      peers: ['Wan', 'Seedance', 'Hailuo by MiniMax'],
      rows: [
        {
          label: 'Best for',
          values: [
            'Polished cinematic clips & motion',
            'Open T2V/I2V + huge LoRA ecosystem',
            'Cinematic camera control (API)',
            'Fast, expressive motion (API)',
          ],
        },
        {
          label: 'Provider',
          values: ['Kuaishou', 'Alibaba', 'ByteDance', 'MiniMax'],
        },
        {
          label: 'Access',
          values: ['API-only (hosted)', 'Open weights', 'API-only (hosted)', 'API-only (hosted)'],
        },
        {
          label: 'Image-to-video',
          values: ['Yes, first-frame anchored', 'Native, strong', 'Yes', 'Yes'],
          winner: 1,
        },
        {
          label: 'LoRA support',
          values: ['None (closed)', '2,500+ (largest for video)', 'None (closed)', 'None (closed)'],
          winner: 1,
        },
        { label: 'Available on Civitai', values: ['✓ Yes', '✓ Yes', '✓ Yes', '✓ Yes'] },
      ],
    },
    faq: [
      {
        q: 'How much does it cost to generate with Kling?',
        a: 'Generation on Civitai runs on Buzz, and every account earns free Blue Buzz daily through on-site actions like reacting to images. Kling is a premium hosted video model — a clip is far heavier to produce than a single image, so a Kling generation costs more Buzz per clip than most models, and longer clips cost more than shorter ones. You can put your daily free Blue Buzz toward it, but for regular Kling use you’ll want to let Buzz accumulate or add a membership for higher limits.',
      },
      {
        q: "What's the difference between text-to-video and image-to-video?",
        a: 'Text-to-video builds a clip from a written prompt, while image-to-video animates a still image you provide — anchoring its first frame for stronger consistency. Kling does both, and you can pick either mode right in the Civitai generator.',
      },
      {
        q: 'Which Kling version should I use?',
        a: 'Civitai hosts v1.6, v2, v2.5 Turbo, and the newest Kling 3.0. Newer versions generally improve motion and prompt adherence, while the Turbo mode trades some fidelity for speed. Try a prompt across a few and compare the results.',
      },
      {
        q: 'Can I use LoRAs with Kling?',
        a: 'No — Kling is a closed, hosted model with no downloadable weights or LoRAs. You steer results through prompting, reference images, and Kling’s built-in camera controls instead. If you want stackable video LoRAs and motion effects, the open Wan ecosystem is the place to look.',
      },
      {
        q: 'How long can a Kling clip be?',
        a: 'Kling generates short clips, with clip extension available for longer sequences, and you set the length in the generator. Keep each prompt focused on a single continuous action for the cleanest result, then remix an example above to see how it works.',
      },
      {
        q: 'Do I need a GPU to run Kling?',
        a: 'No. Kling is API-only, and Civitai runs the generation for you in the cloud — there are no weights to download and nothing to install. Just enter a prompt or upload an image and generate in the browser.',
      },
    ],
    attribution: 'a hosted text-to-video and image-to-video model by Kuaishou (Kling)',
    factCheck: [
      {
        field: 'comparison',
        claim: 'peer facts (Seedance = ByteDance, Hailuo = MiniMax) + qualitative ratings',
        note: 'Peer positioning is editorial / general knowledge, not sourced metrics.',
      },
    ],
  },

  Seedance: {
    key: 'Seedance',
    updatedAt: '2026-07-22',
    name: 'Seedance',
    metaDescription:
      "Generate Seedance video on Civitai — ByteDance's hosted model turns text or an image into short clips with natively synchronized dialogue, sound, and lip-sync.",
    modality: 'video',
    hero: {
      intro:
        "Seedance is ByteDance's hosted multimodal video model that turns a text prompt or a still image into a short clip — and generates the audio with it, producing synchronized dialogue, lip-sync, and ambient sound in a single pass. It reads full cinematic descriptions with real camera direction and runs entirely on Civitai, so there's no GPU or install to worry about. Generate a clip, with sound, straight from a description.",
      badges: ['Text-to-Video', 'Audio + Video', 'By ByteDance'],
    },
    overview: [
      "Seedance 2.0 is a hosted multimodal video generator from ByteDance's Seed team. It's built on a Dual-branch DiT (Diffusion Transformer) architecture that jointly generates the visuals, dialogue, lip-sync, and ambient sound in one pipeline, natively fusing text, image, and audio inputs rather than treating audio as a separate post step. Weights aren't published — the ByteDance-Seed org is on Hugging Face, but Seedance runs as a hosted model, which on Civitai means you generate it through the on-site generator instead of downloading it.",
      'Two variants are available on Civitai: Seedance 2.0, the full-quality model set as the generator default, and Seedance 2.0 Fast, a speed-optimized variant that trades some fidelity for quicker turnaround. Both do text-to-video and image-to-video and both produce synchronized audio. Clips run from 480p up to 4K native, and the model can take reference inputs — up to nine images plus short audio and video clips — to steer a generation. Because it is API-only there are no LoRAs or local runs; you prompt it directly in the generator.',
      'Choose Seedance when you want video and matching audio in a single generation — synchronized speech, sound effects, and ambience without a separate audio pass. Against a polished closed API like Kling or a fast one like Hailuo you get the joint audio-plus-video pipeline; against open-weight Wan you trade downloadable models and a LoRA ecosystem for that one-pass audio and ByteDance hosting. It runs right here on Civitai either way.',
    ],
    promptTips: [
      'Write like a mini-screenplay in natural language, not tags. Seedance follows the order subject and performance → action → camera → lighting and environment → mood → audio. Weight syntax like (word:1.5) is ignored.',
      "Don't write a negative prompt — Seedance doesn't use them. Say what you want positively instead of listing what to avoid.",
      "Describe the audio, since Seedance generates it natively: name the dialogue lines, music style, sound effects, ambient noise, or ASMR detail you want synced to the picture. Leaving audio out wastes the model's signature feature.",
      'Use real cinematography vocabulary over the vague word "cinematic": "Steadicam long take," "push-in," "pull-back," "over-the-shoulder," "macro shot," "slow rotation." Explicit camera technique reads far better than generic quality words.',
      'Keep a clip to one continuous take — avoid describing multiple hard cuts or sequential scenes. Lean on physical detail ("wet-pavement reflections," "visible breath vapor," "weight and inertia") and performance cues ("solemn," "explosive") to direct the motion.',
    ],
    generatorVersionId: 2864671,
    featuredModels: [
      {
        modelId: 2549116,
        versionId: 2864671,
        imageId: 136180167,
        displayName: 'Seedance 2.0',
        note: 'Civitai-hosted · default',
      },
      {
        modelId: 2549116,
        versionId: 2868300,
        imageId: 136424192,
        displayName: 'Seedance 2.0 Fast',
        note: 'Civitai-hosted · speed-optimized',
      },
    ],
    featuredExamples: [
      {
        imageId: 136180167,
        prompt:
          'A man striding forward, as a pulsing rope of energy surrounds him like vapor. Dark shadowy tendrils on the left whip wildly in the wind, while the golden tendrils on the right glow and spark with fire.',
        settings: 'Seedance 2.0 · 864×496',
      },
      {
        imageId: 134788273,
        prompt:
          'A studio-quality American 2D animation from the 90s or 2000s. A surfer dog in a drinking-helmet hat flips on her surfboard mid-wave, lands cleanly, and says "Is this radical enough for you, dawg?"',
        settings: 'Seedance 2.0 · 1280×720',
      },
      {
        imageId: 134679254,
        prompt:
          'The scene takes place inside a lively football stadium in USA. Two young adult Japanese girls in matching national-team jerseys cheer, one shouts a funny goal-celebration impression and her friend bursts out laughing.',
        settings: 'Seedance 2.0 · 864×496',
      },
      {
        imageId: 136424192,
        prompt:
          'A cinematic ultra-realistic video of a daring cyberpunk bullet-train robbery racing through a spectacular neon city night, aerial shots following masked outlaws on motorcycles alongside the speeding train.',
        settings: 'Seedance 2.0 Fast · 864×496',
      },
      {
        imageId: 135486457,
        prompt:
          'A majestic Japanese castle viewed from a fixed camera. The castle remains completely still while the sky changes in a smooth cinematic time-lapse from morning through golden hour, sunset, night, and back to dawn.',
        settings: 'Seedance 2.0 Fast · 1112×834',
      },
      {
        imageId: 134178690,
        prompt:
          'Video-game style, race through a Tokyo city background — a mutt-dog dreamer drives a turbo sport race car, drifting and using nitro, teleporting Hot Wheels style through the neon streets.',
        settings: 'Seedance 2.0 Fast · 1280×720',
      },
    ],
    comparison: {
      peers: ['Kling', 'Wan', 'Hailuo by MiniMax'],
      rows: [
        {
          label: 'Best for',
          values: [
            'One-pass audio + video (T2V & I2V)',
            'Polished cinematic clips (API)',
            'Open T2V/I2V with a huge LoRA ecosystem',
            'Fast stylized clips (API)',
          ],
        },
        {
          label: 'Native synchronized audio',
          values: ['Yes (dialogue, SFX, ambience)', 'Limited', 'No (video only)', 'No'],
          winner: 0,
        },
        {
          label: 'Image-to-video',
          values: ['Yes', 'Yes', 'Native, strong', 'Yes'],
        },
        {
          label: 'Prompt adherence',
          values: ['Very good', 'Excellent', 'Very good', 'Good'],
          winner: 1,
        },
        {
          label: 'Open weights / LoRAs',
          values: ['No (hosted API)', 'No (closed)', 'Yes (open + LoRAs)', 'No (closed)'],
          winner: 2,
        },
        { label: 'Available on Civitai', values: ['✓ Yes', '✓ Yes', '✓ Yes', '✓ Yes'] },
      ],
    },
    faq: [
      {
        q: 'How much does it cost to generate with Seedance?',
        a: 'Generation on Civitai runs on Buzz, and you can claim free Blue Buzz every day — through actions like reacting to images and other on-site activity — to put straight toward generating, no real money required. Seedance is a premium hosted model that produces synchronized audio and video in one pass, so it costs more Buzz per clip than lighter models; heavier use means letting your Blue Buzz accumulate or adding a membership for higher limits. Seedance 2.0 Fast is the cheaper of the two variants when you want to stretch your Buzz further.',
      },
      {
        q: 'Does Seedance really generate the audio too?',
        a: "Yes — that's its defining feature. Seedance natively generates synchronized dialogue, lip-sync, sound effects, and ambient sound in the same pipeline as the visuals, so describe the sound you want (voices, music style, SFX, ambience) right in your prompt. Try it in the generator and add an audio line to your next clip.",
      },
      {
        q: "What's the difference between Seedance 2.0 and 2.0 Fast?",
        a: 'Seedance 2.0 is the full-quality model and the generator default; 2.0 Fast is a speed-optimized variant that returns clips more quickly and costs less Buzz, trading a little fidelity. Run the same prompt on each and compare — both are available on Civitai.',
      },
      {
        q: 'Can I use my own image or reference clips with Seedance?',
        a: 'Yes. Seedance does image-to-video and can take reference inputs — up to nine images plus short audio and video clips — to guide a generation, so you can animate a still or steer style and motion from your own material. Pick image-to-video in the Civitai generator to start from an image.',
      },
      {
        q: 'How long can a Seedance clip be, and what resolution?',
        a: 'Clips run from 480p up to 4K native. Single continuous takes work best, so aim for one camera move and one action rather than several hard cuts. Set length and size in the generator when you create a clip.',
      },
      {
        q: 'Do I need a GPU to run Seedance?',
        a: "No — Seedance is a hosted, API-only model with no public weights, so there's nothing to download and no LoRAs or local setup. Civitai runs the compute for you; just open the generator and prompt it in the browser.",
      },
    ],
    attribution: 'a hosted text-to-video model by ByteDance (Seedance)',
    factCheck: [
      {
        field: 'comparison',
        claim: 'qualitative ratings (prompt adherence, native audio peers)',
        note: 'Editorial judgment, not sourced metrics — spot-check the peer cells.',
      },
    ],
  },

  Grok: {
    key: 'Grok',
    updatedAt: '2026-07-22',
    name: 'Grok Imagine',
    metaDescription:
      "Generate with Grok Imagine on Civitai — xAI's hosted model turns a text prompt or a still image into short animated video clips. Browse examples and start generating.",
    modality: 'video',
    secondaryModality: 'image',
    hero: {
      intro:
        "Grok Imagine is xAI's hosted model for turning a text prompt or a reference image into short animated video clips — and it generates still images too. There's nothing to download or set up: describe a scene and get a clip back in seconds. Run Grok Imagine right here on Civitai.",
      badges: ['Text-to-Video', 'Text-to-Image', 'By xAI'],
    },
    overview: [
      "Grok started as the conversational AI assistant from Elon Musk's xAI, launched in November 2023, and has since grown into a multimodal system. Grok Imagine is xAI's dedicated model for visual generation — creating images and short videos from text prompts and reference visuals. On these pages we treat it as a video ecosystem, but it is genuinely dual-purpose: the same model handles text-to-image alongside its short-form video generation.",
      "Its capabilities span three modes. Text-to-image renders across styles from photorealism and illustration to anime and sketches (xAI's image generation is built on its Aurora model, an autoregressive generator with strong instruction-following). Image editing and transformation restyle or modify an existing image from a written instruction. And video generation produces short animated clips — either straight from a text prompt or by animating a still image you provide, often with synced audio — which is the workflow these pages center on.",
      'Grok Imagine runs API-only: it is a hosted xAI model with no open weights and no local install, so the way to use it is right here in the Civitai generator, where the compute runs for you. Choose it when you want fast, prompt-driven short clips or quick concept and storyboard visuals from a single service that also does stills. If you want open weights, stackable LoRAs, and deep motion-effect control, the Wan ecosystem leads; for the most polished cinematic API clips, Kling and Seedance are the peers to compare against.',
    ],
    promptTips: [
      "Write in plain natural language, not comma-separated tags. Grok's image model is autoregressive with strong instruction-following, so describe the scene in full sentences the way you would explain it to a person.",
      'Skip weight syntax and negative prompts — (word:1.5) and negative prompts are unsupported. State what you want directly ("empty street, soft morning light") rather than listing what to avoid.',
      'Keep the prompt reasonably tight — up to roughly 1,000 characters. It follows precise text instructions well and is strong at photorealistic rendering, so specific detail pays off more than length.',
      'For video, spell out the motion and the camera: what moves, how fast, and the shot ("slow push-in," "static wide shot," "camera pans left"). Keep each clip to a single continuous action rather than several sequential events.',
      'A reliable structure is: subject in setting, then style, lighting, and composition — e.g. "a fox trotting through a snowy pine forest, cinematic style, soft golden light, wide tracking shot, highly detailed."',
    ],
    generatorVersionId: 2738377,
    featuredModels: [
      {
        modelId: 2435474,
        versionId: 2738377,
        imageId: 137144533,
        displayName: 'Grok Imagine',
        note: 'Civitai-hosted · by xAI',
      },
    ],
    featuredExamples: [
      {
        imageId: 137144533,
        prompt:
          'Anime style, looped clip: a cat running dynamically through an urban park, motion blur, golden-hour lighting, wide angle',
        settings: 'Grok Imagine · 1280×720',
      },
      {
        imageId: 134432710,
        prompt:
          'A realistic medium shot of a sports commentator in a high-tech broadcasting studio, blurred screens glowing behind her',
        settings: 'Grok Imagine · 1280×720',
      },
      {
        imageId: 136594603,
        prompt: 'A magic fairy world where everything is moving, full of magic',
        settings: 'Grok Imagine · 720×720',
      },
      {
        imageId: 137451444,
        prompt:
          'An ancient man, his beard flowing like a silver waterfall, sits on a throne carved from solidified moonlight, commanding celestial energies',
        settings: 'Grok Imagine · text-to-image · 1776×2368',
        type: 'image',
      },
      {
        imageId: 137436344,
        prompt:
          'A museum-worthy illustration of a mythical garden where every flower blooms into a miniature galaxy and astronomers cultivate constellations',
        settings: 'Grok Imagine · text-to-image · 2816×1584',
        type: 'image',
      },
      {
        imageId: 137351318,
        prompt:
          'A fluffy, wide-eyed puppy in an impressionistic meadow bathed in the soft, dappled light of a summer afternoon, surrounded by vibrant wildflowers',
        settings: 'Grok Imagine · text-to-image · 1776×2368',
        type: 'image',
      },
    ],
    comparison: {
      peers: ['Kling', 'Seedance', 'Wan'],
      rows: [
        {
          label: 'Best for',
          values: [
            'Fast short clips + stills, one hosted model',
            'Polished cinematic clips (API)',
            'Cinematic multi-shot video (API)',
            'Open T2V + I2V, huge LoRA ecosystem',
          ],
        },
        {
          label: 'Modalities',
          values: ['Video + image', 'Video', 'Video', 'Video'],
          winner: 0,
        },
        {
          label: 'Image-to-video',
          values: ['Yes', 'Yes', 'Yes', 'Native, strong'],
          winner: 3,
        },
        {
          label: 'Open weights / LoRAs',
          values: ['No (hosted)', 'No (closed)', 'No (closed)', 'Yes — 2,500+ LoRAs'],
          winner: 3,
        },
        {
          label: 'Maker',
          values: ['xAI', 'Kuaishou', 'ByteDance', 'Alibaba'],
        },
        { label: 'Available on Civitai', values: ['✓ Yes', '✓ Yes', '✓ Yes', '✓ Yes'] },
      ],
    },
    faq: [
      {
        q: 'How much does it cost to generate with Grok Imagine?',
        a: "Generation on Civitai runs on Buzz, and every account earns free Blue Buzz daily through on-site activity like reacting to images. Grok Imagine is a premium hosted model from xAI, so it costs more Buzz per clip than lighter checkpoints — it isn't free generation, but you can still put your daily Blue Buzz toward it, and for heavier use let your Buzz accumulate or add a membership for higher limits. Short clips at smaller resolutions stretch your Buzz further than long, high-resolution ones.",
      },
      {
        q: 'What is Grok Imagine?',
        a: "Grok Imagine is xAI's dedicated model for creating images and short videos from text prompts and reference visuals. It handles text-to-image, image editing, and short video generation — including animating a still image. Try it in the Civitai generator.",
      },
      {
        q: 'Can Grok Imagine make images as well as video?',
        a: 'Yes — it does both. Grok Imagine generates still images across styles like photorealism, illustration, and anime, and it also produces short animated clips. These pages focus on its video output, but the same model covers stills. Remix an example to start.',
      },
      {
        q: 'Can I animate my own image with Grok Imagine?',
        a: 'Yes. Its image-to-video mode takes a still picture and brings it to life with motion, so you can start from an image you already have rather than a text prompt alone. Pick the image-to-video flow in the generator.',
      },
      {
        q: 'Do I need a GPU or any install to run Grok Imagine?',
        a: 'No. Grok Imagine is an API-only hosted model — there are no open weights to download and nothing to install. Civitai runs the compute for you, so you generate straight from the browser.',
      },
      {
        q: 'How should I prompt Grok Imagine?',
        a: 'Write in natural language with full sentences — it follows instructions closely and does not use weight syntax or negative prompts. For video, describe the motion and camera and keep to one continuous action. Remix any example above to see a working prompt.',
      },
    ],
    attribution: 'a hosted image-and-video model by xAI (Grok Imagine)',
    factCheck: [
      {
        field: 'promptTips',
        claim: 'video motion/camera prompt tip',
        note: "The real grok prompt guide is image-oriented (Aurora); there's no Grok-video guide, so the video-motion tip is general best practice, not sourced.",
      },
      {
        field: 'comparison',
        claim: 'peer positioning / ratings',
        note: 'Editorial, not sourced metrics.',
      },
    ],
  },

  HappyHorse: {
    key: 'HappyHorse',
    updatedAt: '2026-07-22',
    name: 'HappyHorse',
    metaDescription:
      'Generate HappyHorse video on Civitai — a hosted model that turns text or a still image into short clips with synchronized audio and physics-aware motion.',
    modality: 'video',
    hero: {
      intro:
        'HappyHorse is a hosted video model that turns a text prompt — or a single still image — into a short clip, and it generates the matching sound in the same pass, so effects like a splashing wave or engine noise line up with the on-screen action. It also animates static images with strong character and background consistency. No GPU, no install, no local weights: run it right here on Civitai.',
      badges: ['Text-to-Video', 'Synced Audio', 'Image-to-Video'],
    },
    overview: [
      'HappyHorse is a hosted, API-only video model that generates both video and synchronized sound effects from a single text prompt. Rather than treating audio as a separate post step, it processes video and audio tokens within one unified Transformer sequence, so auditory elements — a splashing wave, engine noise, ambient room tone — are aligned to what happens on screen. That native audio-video synthesis is its defining trait and removes much of the manual sound work a silent clip would need.',
      'Beyond text-to-video, HappyHorse does image-to-video: hand it a still and it animates the scene while working to preserve character identity and environmental detail, which makes it a practical option for bringing concept art, portraits, and product photos to life. Its motion engine is built to respect real-world physics — aiming for fluid human gaits, believable fluid dynamics, and stable camera moves — to reduce the warping and distortion common in earlier AI video. As a native multimodal model it also reads prompts directly in multiple languages, including English, Chinese, and Japanese, without an intermediate translation step.',
      'Choose HappyHorse when you want a hosted clip with sound baked in and solid image-to-video consistency, without managing weights or a local pipeline. It sits alongside other cloud video models on Civitai: Kling and Seedance are polished closed APIs, while Wan is the open-weight option with the deepest LoRA and motion-effect ecosystem. HappyHorse has no LoRAs and no local run — it is generated entirely on Civitai as a premium hosted model, so its edge is native synchronized audio and physics-aware motion rather than customization.',
    ],
    promptTips: [
      'Write in plain English prose — full natural sentences. Comma-separated Booru-style tag lists, JSON, weighted parentheses, and non-English prompts all underperform, so describe the shot as you would say it out loud.',
      'Aim for about 20 words per shot using the shape: [Subject] [action] in [setting], [time of day], [one camera or atmosphere cue]. Going much longer degrades faces, hands, and gait toward a generic average.',
      'Skip weight syntax like (word:1.3) and lean on camera vocabulary instead — "steadicam push," "slow dolly-in," "lateral orbit," or "tracking shot." Use exactly one cinematography cue per shot; competing camera moves confuse the model.',
      'Drop hedging adjectives ("beautiful," "stunning," "epic," "cinematic," "hyperrealistic") — they steer nothing and crowd out concrete description. Negative prompts also have minimal effect here, so only add one to suppress a specific artifact you have actually seen.',
      'For anything with multiple beats, do not pack them into one sentence — the model compresses them into a single motion. Use a timecoded shot list instead (e.g. "0:00–0:02: … | 0:02–0:04: …"), keeping each line to roughly one shot.',
    ],
    generatorVersionId: 3063263,
    featuredModels: [
      {
        modelId: 2583501,
        versionId: 3063263,
        imageId: 136525739,
        displayName: 'HappyHorse 1.1',
        note: 'Civitai-hosted',
      },
    ],
    featuredExamples: [
      {
        imageId: 134839104,
        prompt:
          'A photo-realistic gazelle standing beside a lush green desert oasis with date palms and a still pond',
        settings: 'HappyHorse v1.0 · 1280×720',
      },
      {
        imageId: 132339182,
        prompt: 'Two young women at a busy taiyaki food cart in a Japanese neighborhood',
        settings: 'HappyHorse v1.0 · 1920×1080',
      },
      {
        imageId: 132233436,
        prompt:
          'A time-lapse static shot, clouds rushing overhead as night falls and building lights switch on',
        settings: 'HappyHorse v1.0 · 1214×1708',
      },
      {
        imageId: 130711989,
        prompt: 'A diverse group of female astronauts emerging into a lush green tropical setting',
        settings: 'HappyHorse v1.0 · 1920×1080',
      },
      {
        imageId: 130325689,
        prompt:
          'A little girl seen from behind sits beside a black cat on a hill, both looking calmly toward the sunset',
        settings: 'HappyHorse v1.0 · 1280×720',
      },
      {
        imageId: 129042530,
        prompt:
          'A lone figure in a long black coat walks away through dense fog along a wet industrial dock at dusk',
        settings: 'HappyHorse v1.0 · 1280×720',
      },
    ],
    comparison: {
      peers: ['Kling', 'Seedance', 'Wan'],
      rows: [
        {
          label: 'Best for',
          values: [
            'T2V + I2V with native synced audio',
            'Polished cinematic clips (API)',
            'One-pass audio + video (API)',
            'T2V + I2V, huge LoRA ecosystem',
          ],
        },
        {
          label: 'Native audio',
          values: ['Yes, generated in one pass', 'No', 'Yes', 'Some versions (hosted)'],
        },
        {
          label: 'Image-to-video',
          values: ['Yes, consistency-focused', 'Yes', 'Yes', 'Native, strong'],
        },
        {
          label: 'LoRAs / customization',
          values: ['None (hosted)', 'None (closed)', 'None (closed)', 'Largest for video'],
          winner: 3,
        },
        {
          label: 'Local run',
          values: ['No (API-only)', 'No (API-only)', 'No (API-only)', 'Yes (open weights)'],
        },
        { label: 'Available on Civitai', values: ['✓ Yes', '✓ Yes', '✓ Yes', '✓ Yes'] },
      ],
    },
    faq: [
      {
        q: 'How much does it cost to generate with HappyHorse?',
        a: 'Generation on Civitai runs on Buzz, and you can claim free Blue Buzz every day — through actions like reacting to images and other on-site activity — to put toward generating, no real money required. HappyHorse is a premium hosted model that renders video and its synchronized audio together in a single pass, so it costs more Buzz per clip than lighter open models; heavier use means letting your Blue Buzz accumulate or adding a membership for higher limits.',
      },
      {
        q: 'What makes HappyHorse different from other video models?',
        a: 'Its defining feature is native audio: it generates video and synchronized sound effects together within one unified Transformer sequence, so on-screen action and audio line up without a separate sound step. It also emphasizes physics-aware motion and character consistency for image-to-video.',
      },
      {
        q: "What's the difference between HappyHorse text-to-video and image-to-video?",
        a: 'Text-to-video builds a clip from a written prompt, while image-to-video animates a still image you provide — HappyHorse focuses on preserving the character and background of that image as it adds motion. You can pick either mode right in the Civitai generator.',
      },
      {
        q: 'Does HappyHorse really generate sound?',
        a: 'Yes. It produces synchronized sound effects alongside the video from the same prompt — the model aligns audio like a splashing wave or engine noise to the matching on-screen action, which reduces the need for audio post-production.',
      },
      {
        q: 'Can I run HappyHorse locally or use LoRAs with it?',
        a: 'No — HappyHorse is a hosted, API-only model with no downloadable weights and no LoRA support. You generate it on Civitai and we run the compute for you. If you want open weights, local runs, or a large LoRA library, Wan is the better fit.',
      },
      {
        q: 'What languages can I prompt HappyHorse in?',
        a: 'As a native multimodal model it processes prompts directly in multiple languages, including English, Chinese, and Japanese, without an intermediate translation step — though for best results keep each shot to plain, concrete prose of around 20 words.',
      },
    ],
    attribution:
      'a hosted text-to-video and image-to-video model (HappyHorse), attributed to Alibaba',
    factCheck: [
      {
        field: 'attribution',
        claim: '"attributed to Alibaba"',
        highlight: 'attributed to Alibaba',
        note: 'Corporate parent unconfirmed — the guide said "Alibaba, via fal.ai"; Civitai groups it under an Alibaba–Taotian family. Confirm the real owner.',
      },
    ],
  },

  NanoBanana: {
    key: 'NanoBanana',
    updatedAt: '2026-07-23',
    slug: 'nano-banana',
    name: 'Nano Banana',
    metaDescription:
      "Generate and edit images with Nano Banana on Civitai — Google's Gemini model that keeps a subject's likeness across edits. Browse Nano Banana examples & prompts.",
    modality: 'image',
    hero: {
      intro:
        "Nano Banana is Google's Gemini-based image generation and editing model, best known for keeping a subject looking like themselves across edits — change an outfit, hairstyle, or setting while the face stays consistent. It also does text-to-image from a plain description, and it runs right here on Civitai with no GPU or install.",
      badges: ['Text-to-Image', 'Image Editing', 'By Google'],
    },
    overview: [
      "Nano Banana is Google's image generation and editing model, delivered through the Gemini app's native image editing and hosted on Civitai. Google built it around a specific problem: when you edit a photo of yourself or someone you know, a result that is \"close but not quite the same\" doesn't feel right. So the model is tuned to maintain a character's likeness from one image to the next — you hand it a photo, describe the change you want, and it keeps the person (or pet) recognizably themselves while applying the edit.",
      "Its standout is identity-preserving editing rather than raw text-to-image novelty. You can give a subject a costume or location change and keep their look consistent across every variation; blend multiple photos into one new scene (you plus your dog on a basketball court); edit in multiple turns, altering one part at a time — paint a room's walls, then add a bookshelf, then furniture — while the rest of the image is preserved; or apply the style of one image to an object in another, like mapping a butterfly's wing pattern onto a dress. It also generates images from a text prompt when you are starting from scratch.",
      'Three versions are available on Civitai: the original Nano Banana, Nano Banana Pro, and Nano Banana 2. All are hosted (API-only) — there are no open weights to download and no local run — so you switch between versions in the generator without any setup. Choose Nano Banana when the job is editing or personalizing an existing photo with the subject kept intact; for open-weight photorealism, deep LoRA libraries, or fully local workflows, an ecosystem like FLUX.1 is the better fit.',
    ],
    promptTips: [
      'For edits, write the change as a plain instruction rather than a full scene description — "give her a 1960s beehive haircut" or "put a tutu on the dog." The model applies the change and keeps the subject looking like themselves, so you rarely need to re-describe the person.',
      "Provide a reference photo when likeness matters. Nano Banana is built to preserve a person's or pet's identity across edits, so upload the subject and describe only what should differ — the outfit, profession, decade, or location.",
      'Blend by supplying multiple images in one prompt. Give it two or more photos (for example you and your pet) and describe the combined scene; it composes them into a single coherent image instead of picking one.',
      'Edit in multiple turns for complex changes. Make one adjustment at a time and feed the result back in — paint the walls, then add a bookshelf, then a coffee table — so each step alters its target while preserving everything else.',
      'For text-to-image from scratch, describe the subject, setting, and lighting in natural sentences. For style transfer, name the source look and the target object explicitly — "apply the color and texture of these flower petals to a pair of rain boots."',
    ],
    generatorVersionId: 2725610,
    featuredModels: [
      {
        modelId: 1903424,
        versionId: 2725610,
        imageId: 137451474,
        displayName: 'Nano Banana 2',
        note: 'Civitai-hosted · latest',
      },
      {
        modelId: 1903424,
        versionId: 2436219,
        imageId: 137439192,
        displayName: 'Nano Banana Pro',
        note: 'Civitai-hosted · Pro',
      },
      {
        modelId: 1903424,
        versionId: 2154472,
        imageId: 137277916,
        displayName: 'Nano Banana',
        note: 'Civitai-hosted',
      },
    ],
    featuredExamples: [
      {
        imageId: 137486876,
        prompt:
          'A highly detailed, humorous four-frame cartoon with bright vivid colours, expressive characters, and a clean polished illustrated style',
        settings: 'Nano Banana 2 · 1792×2400',
      },
      {
        imageId: 137472268,
        prompt: 'Staircase in a modern brutalist interior, raw concrete, dramatic geometry',
        settings: 'Nano Banana 2 · 1536×2752',
      },
      {
        imageId: 137405924,
        prompt:
          'A rocky alien landscape with purple ground, a massive ringed planet filling the sky, two small moons, and a starry black sky',
        settings: 'Nano Banana 2 · 1248×1824',
      },
      {
        imageId: 137351060,
        prompt: 'Street view of a busy intersection near Seoul Station, South Korea, daytime',
        settings: 'Nano Banana Pro · 4800×3584',
      },
      {
        imageId: 137439192,
        prompt:
          'A photorealistic cinematic scene: a matte-black 1970 Dodge Challenger charging at extreme speed along a shattered highway through the ruins of a once-great city',
        settings: 'Nano Banana Pro · 1792×2400',
      },
      {
        imageId: 137277916,
        prompt: 'The receptionist at the adventurers guild, anime style',
        settings: 'Nano Banana · 1024×1024',
      },
    ],
    comparison: {
      peers: ['Imagen 4', 'Seedream', 'FLUX.1'],
      rows: [
        {
          label: 'Best for',
          values: [
            'Likeness-preserving photo editing',
            'Photoreal text-to-image',
            'High-res text-to-image',
            'Photorealism, text, versatility',
          ],
        },
        {
          label: 'Image editing',
          values: ['Native, multi-turn', 'Limited', 'Via edit variant', 'In-context (Kontext)'],
          winner: 0,
        },
        {
          label: 'Character consistency',
          values: ['Excellent', 'Fair', 'Good', 'Fair'],
          winner: 0,
        },
        {
          label: 'Text-to-image quality',
          values: ['Very good', 'Excellent', 'Excellent', 'Excellent'],
        },
        {
          label: 'Access',
          values: ['API (hosted)', 'API (hosted)', 'API (hosted)', 'Open weights + API'],
        },
        { label: 'Available on Civitai', values: ['✓ Yes', '✓ Yes', '✓ Yes', '✓ Yes'] },
      ],
    },
    faq: [
      {
        q: 'How much does it cost to generate with Nano Banana?',
        a: 'Generation on Civitai runs on Buzz, and Nano Banana is a premium hosted model from Google, so each image costs more Buzz than a lightweight open checkpoint — you are paying for compute Google runs on its side. Every account still earns free Blue Buzz daily by reacting to images and other on-site activity, so you can try Nano Banana without spending real money; you will just work through daily Blue Buzz faster than on cheaper models. For steady use, let your Buzz accumulate or add a membership for higher limits.',
      },
      {
        q: 'What makes Nano Banana different from other image models?',
        a: 'Its signature strength is identity-preserving editing: hand it a photo and describe a change, and it keeps the person or pet looking like themselves across the edit — new outfit, hairstyle, era, or setting. Try it by remixing one of the examples above.',
      },
      {
        q: "What's the difference between Nano Banana, Nano Banana Pro, and Nano Banana 2?",
        a: 'They are successive versions of the same Google model, all hosted on Civitai. Nano Banana 2 is the latest, Nano Banana Pro is the higher-tier variant, and the original Nano Banana is the first release. Pick any of them in the generator and compare the output on your own prompt.',
      },
      {
        q: 'Can it keep a person or pet looking consistent across edits?',
        a: "Yes — that is exactly what it was built for. Provide a reference photo and describe only the change you want, and Nano Banana maintains the subject's likeness from one image to the next. You can also blend multiple photos or edit in several turns while preserving the rest of the image.",
      },
      {
        q: 'Can I use LoRAs with Nano Banana?',
        a: 'No. Nano Banana is a hosted Google model without LoRA support, so you steer it with prompts and reference images rather than stacked LoRAs. If you want a deep LoRA ecosystem, an open model like FLUX.1 or SDXL is the better choice — all are in the Civitai generator.',
      },
      {
        q: 'Do I need a GPU to run Nano Banana?',
        a: 'No local setup is possible or needed — Nano Banana is API-only, with no open weights to download. Google runs the model and Civitai handles the generation for you, so you can start editing straight from the browser.',
      },
    ],
    attribution: 'a hosted image generation and editing model by Google (Nano Banana)',
    factCheck: [
      {
        field: 'promptTips',
        claim: 'editing / prompting tips',
        note: 'No model-specific prompt guide exists (generic fallback) — tips are grounded in the model card’s documented editing capabilities, not a guide.',
      },
    ],
  },

  Imagen4: {
    key: 'Imagen4',
    updatedAt: '2026-07-23',
    slug: 'imagen-4',
    name: 'Imagen 4',
    metaDescription:
      "Generate with Imagen 4 on Civitai — Google DeepMind's text-to-image model for photorealism, fine detail, and legible in-image text. Browse examples & prompts.",
    modality: 'image',
    hero: {
      intro:
        "Imagen 4 is Google DeepMind's latest text-to-image model, built to turn natural-language prompts into ultra-high-quality, photorealistic images with a focus on visual fidelity, fine detail, and compositional accuracy. It also renders legible in-image text. Generate with it right here on Civitai — no GPU, no install.",
      badges: ['Text-to-Image', 'Photorealism', 'By Google DeepMind'],
    },
    overview: [
      "Imagen 4 is the latest iteration of Google DeepMind's Imagen text-to-image line, designed to generate ultra-high-quality, photorealistic images from natural-language prompts. Its emphasis is on visual fidelity, fine detail, and compositional accuracy — reading a plain description of a scene and rendering it with convincing lighting, materials, and structure rather than relying on tag-style keywords. It responds strongly to cinematic, descriptive prompting that specifies perspective, lighting, environment, and action.",
      'Unlike open-weight families such as FLUX.1 or SDXL, Imagen 4 is a closed, hosted model — there are no downloadable weights and no local checkpoints or LoRAs. It is served exclusively through an API, which Civitai runs for you: you write a prompt, pick an aspect ratio, and the image comes back without any local setup. That makes it a fast way to reach Google-grade photorealism directly in the browser.',
      'Choose Imagen 4 when photorealism, fine detail, accurate composition, or legible in-image text matter most, and when you want a polished result from a natural-language description without tuning samplers or stacking LoRAs. For deep style customization, community fine-tunes, and huge LoRA libraries — especially for anime and character art — the open SDXL-based ecosystems (Pony, Illustrious) or FLUX.1 remain the better fit, since Imagen 4 trades that openness for a hosted, ready-to-run pipeline.',
    ],
    promptTips: [
      'Write in natural, cinematic language and follow the template [Subject] + [Context/Background] + [Style] + [Lighting and technical details]. Descriptive full sentences beat comma-separated tags on Imagen 4.',
      'Be explicit about lighting — Imagen 4 responds strongly to lighting cues. "Warm late-afternoon sun raking across the wall from the left" gives far more than "nice lighting."',
      'Skip weight syntax like (word:1.5) — it is not supported. Emphasize an element by describing it in more vivid detail instead of using numeric weights.',
      'State everything positively — Imagen 4 has no negative-prompt field. Instead of listing what to avoid, describe the clean scene you do want (an empty plaza rather than "no people").',
      'For text in the image, spell out the exact words in quotes and describe the type: e.g. "a bold sans-serif title at the top reading \'HELLO\'," specifying font style, size, and placement. Then refine iteratively, changing one variable at a time.',
    ],
    generatorVersionId: 1889632,
    featuredModels: [
      {
        modelId: 1669468,
        versionId: 1889632,
        imageId: 134163949,
        displayName: 'Imagen 4',
        note: 'Civitai-hosted · by Google DeepMind',
      },
    ],
    featuredExamples: [
      {
        imageId: 135412138,
        prompt: 'A frigate-sized futuristic spaceship with dark grey armor drifting in deep space',
        settings: 'Imagen 4 · 1280×896',
      },
      {
        imageId: 134505718,
        prompt:
          'A traditional black-and-yellow taxi rolling through a Mumbai street in the afternoon',
        settings: 'Imagen 4 · 1280×896',
      },
      {
        imageId: 134257673,
        prompt: 'A Disney-themed supermarket with food aisles based on Disney films',
        settings: 'Imagen 4 · 1024×1024',
      },
      {
        imageId: 134215036,
        prompt:
          'A red-crowned crane in shallow water, Japanese ukiyo-e woodblock and watercolor style',
        settings: 'Imagen 4 · 1024×1024',
      },
      {
        imageId: 134163951,
        prompt:
          'A tranquil sunset over a mirror-like lake reflecting a lone tree and flitting birds',
        settings: 'Imagen 4 · 1024×1024',
      },
      {
        imageId: 134163946,
        prompt: 'Itsukushima Shrine at high tide, golden hour, telephoto compression',
        settings: 'Imagen 4 · 1024×1024',
      },
    ],
    comparison: {
      peers: ['Nano Banana', 'Seedream', 'FLUX.1'],
      rows: [
        {
          label: 'Best for',
          values: [
            'Photorealism & fine detail',
            'Conversational image editing',
            'High-res photoreal generation',
            'Prompt adherence & text',
          ],
        },
        { label: 'Prompt adherence', values: ['Excellent', 'Very good', 'Very good', 'Excellent'] },
        { label: 'Text in images', values: ['Strong', 'Fair', 'Fair', 'Strong'], winner: 0 },
        {
          label: 'Prompt style',
          values: ['Natural language', 'Conversational', 'Natural language', 'Natural language'],
        },
        {
          label: 'Access',
          values: ['API only', 'API only', 'API only', 'Open weights + API'],
        },
        { label: 'Available on Civitai', values: ['✓ Yes', '✓ Yes', '✓ Yes', '✓ Yes'] },
      ],
    },
    faq: [
      {
        q: 'How much does it cost to generate with Imagen 4?',
        a: 'Generation on Civitai runs on Buzz, and Imagen 4 is a premium, Google-hosted model, so it sits toward the higher end of the range — each image costs more Buzz than a lightweight open checkpoint like SDXL. Every account still earns free Blue Buzz daily by reacting to images and staying active on the site, so you can try Imagen 4 without spending real money; you will just work through your daily Blue Buzz faster than on cheaper models. For heavier use, let your Buzz accumulate or add a membership for higher limits.',
      },
      {
        q: 'What is Imagen 4?',
        a: "Imagen 4 is Google DeepMind's latest text-to-image model, built for ultra-high-quality, photorealistic images with strong visual fidelity, fine detail, and compositional accuracy. Try it directly in the Civitai generator.",
      },
      {
        q: 'Can I run Imagen 4 locally?',
        a: "No — Imagen 4 is a closed, hosted model with no public weights, so there is nothing to download or run on your own GPU. Civitai runs it through Google's API for you, so you can generate in the browser with no setup.",
      },
      {
        q: 'Is Imagen 4 good at rendering text in images?',
        a: 'Yes — it supports typography and can render legible in-image text. Spell out the exact words in quotes and describe the font style, size, and placement. Remix an example above to see how the prompt carries over.',
      },
      {
        q: 'Can I use LoRAs or custom checkpoints with Imagen 4?',
        a: 'No — because Imagen 4 is API-only with no open weights, it does not support community LoRAs or fine-tuned checkpoints. If you want to stack LoRAs and custom styles, an open ecosystem like FLUX.1, SDXL, Pony, or Illustrious is the better choice, and all of them run on Civitai too.',
      },
      {
        q: 'How should I prompt Imagen 4?',
        a: 'Use natural, cinematic language following [Subject] + [Context] + [Style] + [Lighting], be specific about lighting, and phrase everything positively — Imagen 4 has no negative-prompt field. Remix any example above to start from a working prompt.',
      },
    ],
    sunset: {
      date: '2026-08-17',
      note: 'Google is shutting down the Imagen 4 endpoints, after which it will no longer be generatable on Civitai. Nano Banana and Seedream are the closest hosted alternatives.',
    },
    attribution: 'a hosted text-to-image model by Google DeepMind (Imagen 4)',
  },

  Seedream: {
    key: 'Seedream',
    updatedAt: '2026-07-23',
    name: 'Seedream',
    metaDescription:
      "Generate with Seedream on Civitai — ByteDance's text-to-image model with 4K resolution, sharp typography, and strong prompt adherence. Browse models & prompts.",
    modality: 'image',
    hero: {
      intro:
        "Seedream is ByteDance's text-to-image model, built for high-resolution output, strong prompt adherence, and fine-grained typography — legible text inside the image, including Chinese characters. Seedream 4.0 adds native 4K resolution. Generate with every Seedream version right here on Civitai — no GPU, no install.",
      badges: ['Text-to-Image', '4K + Typography', 'By ByteDance'],
    },
    overview: [
      "Seedream is ByteDance's text-to-image model, developed by the company's Seed research team. It is designed around high-resolution output, strong prompt adherence, and fine-grained typography — rendering legible text inside the image, including Chinese characters, rather than overlaying it. According to ByteDance's technical write-ups, Seedream 3.0 introduced native 2K output, and Seedream 4.0 raised that to native 4K resolution. It is a distinct model from Seedance, ByteDance's video generator.",
      'The family has iterated quickly. Compared with Seedream 2.0, later releases roughly doubled the training data and improved image resolution, complex-attribute adherence, fine-grained text rendering, and overall aesthetics and fidelity. On Civitai you can run several generations — v3.0, v4.0, v4.5, and the v5.0 Lite and v5.0 Pro tiers — with v5.0 Pro as the current flagship. Because Seedream is API-only, there are no open weights to download and no LoRAs to stack; every version is hosted and ready to generate directly in the browser.',
      'Choose Seedream when legible in-image text and typography, high-resolution output, or careful adherence to complex prompts matter — it is a strong fit for posters, signage, packaging, and text-heavy design work, and ByteDance publishes an official prompting guide for it. For the deepest library of community styles and characters via LoRAs, the SDXL-based Pony and Illustrious ecosystems still lead; Qwen-Image is the closest open-weight alternative for text-in-image work. As a premium hosted model, Seedream costs more Buzz per image than lighter open checkpoints — a fair trade when resolution and prompt precision are the priority.',
    ],
    promptTips: [
      'Write in natural language, not tag lists. Describe the subject, setting, lighting, and style in plain sentences — Seedream is built to follow detailed, descriptive prompts rather than comma-separated Danbooru tags.',
      'For text in the image, put the exact words in quotation marks. Fine-grained typography is a Seedream strength — it renders legible small text and long layouts, and handles Chinese characters as well as English.',
      'Ask for the resolution you want. Seedream supports high-resolution output (up to 4K from Seedream 4.0 on), so state the aspect ratio and a high-detail intent when you need crisp, print-scale results.',
      'Be explicit about complex attributes and composition. Later Seedream versions were tuned for complex-attribute adherence, so spell out counts, colors, spatial relationships, and per-object details rather than leaving them implied.',
      "Consult ByteDance's official Seedream prompting guide for model-specific structure, and skip SD-style weight syntax like (word:1.5) — describe emphasis in words instead.",
    ],
    generatorVersionId: 3110984,
    featuredModels: [
      {
        modelId: 1951069,
        versionId: 3110984,
        imageId: 136836725,
        displayName: 'Seedream v5.0 Pro',
        note: 'Civitai-hosted · default',
      },
      {
        modelId: 1951069,
        versionId: 2720141,
        imageId: 136615972,
        displayName: 'Seedream v5.0 Lite',
        note: 'Civitai-hosted · lighter tier',
      },
      {
        modelId: 1951069,
        versionId: 2470991,
        imageId: 137204380,
        displayName: 'Seedream v4.5',
        note: 'Civitai-hosted · added 4K',
      },
      {
        modelId: 1951069,
        versionId: 2208278,
        imageId: 136848505,
        displayName: 'Seedream v4.0',
      },
    ],
    featuredExamples: [
      {
        imageId: 137442851,
        prompt:
          'A peaceful countryside bathed in the warm glow of golden hour, soft light over a tranquil landscape',
        settings: 'Seedream v5.0 Pro · 2400×1800',
      },
      {
        imageId: 137098380,
        prompt:
          'A cinematic photograph of an old-fashioned Norwegian fishing port lined with traditional red houses',
        settings: 'Seedream v5.0 Pro · 1152×864',
      },
      {
        imageId: 137342758,
        prompt:
          'Hyper-cool 1990s anime cel animation style, hand-painted cel texture, grainy analog finish',
        settings: 'Seedream v5.0 Pro · 1776×2368',
      },
      {
        imageId: 137381146,
        prompt:
          'A fox in the Spanish national soccer kit laughs at donkeys in the Argentine kit — playful multi-subject scene',
        settings: 'Seedream v5.0 Pro · 2720×1536',
      },
      {
        imageId: 137351319,
        prompt:
          'A fluffy, wide-eyed puppy in an impressionistic meadow, dappled summer light, vibrant wildflowers',
        settings: 'Seedream v4.0 · 2304×1728',
      },
      {
        imageId: 137182418,
        prompt:
          'A snow-capped mountain range at twilight, a tranquil lake reflecting an aurora-filled sky',
        settings: 'Seedream v4.0 · 2304×1728',
      },
    ],
    comparison: {
      peers: ['Nano Banana', 'Imagen 4', 'Qwen'],
      rows: [
        {
          label: 'Best for',
          values: [
            'Typography & high-res realism',
            'Image editing & consistency',
            'Photoreal & in-image text',
            'Prompt accuracy & text',
          ],
        },
        {
          label: 'Prompt adherence',
          values: ['Excellent', 'Very good', 'Excellent', 'Excellent'],
        },
        {
          label: 'Text in images',
          values: ['Strong (incl. Chinese)', 'Fair', 'Strong', 'Strong'],
          winner: 0,
        },
        {
          label: 'Open weights',
          values: ['No (API)', 'No (API)', 'No (API)', 'Yes (Apache 2.0)'],
          winner: 3,
        },
        {
          label: 'Custom LoRAs',
          values: ['None', 'None', 'None', 'Yes (on Civitai)'],
          winner: 3,
        },
        { label: 'Available on Civitai', values: ['✓ Yes', '✓ Yes', '✓ Yes', '✓ Yes'] },
      ],
    },
    faq: [
      {
        q: 'How much does it cost to generate with Seedream?',
        a: 'Generation on Civitai runs on Buzz, and Seedream sits toward the premium end — it is a hosted, API-only model from ByteDance, and its high-resolution, 4K-capable renders cost more Buzz per image than lighter open checkpoints like SDXL or Illustrious. Every account still earns free Blue Buzz daily by reacting to images and other on-site activity, so you can try Seedream without spending real money; you will simply work through Buzz faster than on cheaper models, so let your daily Blue Buzz accumulate or add a membership for higher limits.',
      },
      {
        q: 'What is Seedream best at?',
        a: 'Legible in-image text and fine-grained typography, high-resolution output up to 4K, and adherence to complex, detailed prompts — a strong fit for posters, signage, packaging, and text-heavy design. Try it in the Civitai generator.',
      },
      {
        q: 'Is Seedream the same as Seedance?',
        a: "No. Seedream is ByteDance's text-to-image model; Seedance is their separate video model. This page covers Seedream image generation — both are available on Civitai.",
      },
      {
        q: 'Can I use LoRAs with Seedream?',
        a: 'No — Seedream is an API-only hosted model with no open weights, so custom LoRAs do not apply. If you want to stack LoRAs, reach for an SDXL-based or FLUX.1 checkpoint on Civitai instead.',
      },
      {
        q: 'Do I need a GPU to run Seedream?',
        a: 'Seedream is API-only — there are no public weights to run locally. On Civitai we host it and run the compute for you, so you can generate straight from the browser.',
      },
      {
        q: 'Which Seedream version should I use?',
        a: 'v5.0 Pro is the current flagship and the default; v5.0 Lite is a lighter tier, and v4.0 is where 4K resolution arrived. Remix an example above to compare versions on the same prompt.',
      },
    ],
    attribution: 'a hosted text-to-image model by ByteDance (Seedream)',
    factCheck: [
      {
        field: 'promptTips',
        claim: 'prompting tips',
        note: 'Prompt guide was a generic fallback — tips grounded in the model card. ByteDance publishes an official Seedream guide worth mirroring.',
      },
    ],
  },

  Veo3: {
    key: 'Veo3',
    updatedAt: '2026-07-22',
    slug: 'veo-3',
    name: 'Veo 3',
    metaDescription:
      "Generate Veo 3 video on Civitai — Google DeepMind's hosted text-to-video & image-to-video model with native audio: dialogue, sound effects, and music from a prompt.",
    modality: 'video',
    hero: {
      intro:
        "Veo 3 is Google DeepMind's state-of-the-art AI video model, and its headline feature is native audio — it generates dialogue, sound effects, and even music together with the picture, from a text prompt or a reference image. It reads cinematic direction like a mini screenplay and renders high-quality, temporally consistent clips. Every Veo 3 variant is hosted on Civitai, so you can generate a clip with sound right in the browser — no GPU, no install.",
      badges: ['Text-to-Video', 'Native Audio', 'By Google DeepMind'],
    },
    overview: [
      'Veo 3 is a state-of-the-art text-to-video and image-to-video model from Google DeepMind. Its defining advance over earlier AI video models is native audio generation: rather than producing a silent clip and bolting sound on afterward, Veo 3 generates dialogue, sound effects, and music together with the visuals in a single pass, for more realistic and immersive results. It reads detailed natural-language direction — characters, action, camera work, mood, and the sound you want — and turns it into a coherent clip.',
      'In practice, Veo 3 is tuned for cinematic, real-world scenes with strong temporal consistency and an unusually deep understanding of camera and film vocabulary — tracking shots, crane and steadicam moves, slow motion, time-lapse, whip pans, and lens/film references. It works from a text prompt, a reference image, or both, and handles temporal progression cues like "as the sun sets." Because it prompts in plain natural language, there is no weight syntax and no negative prompt — you describe everything you want, including the audio, positively.',
      'Veo 3 is a closed, hosted model: there are no downloadable weights and no Veo LoRAs, so control comes from prompting, reference images, and camera direction rather than community fine-tunes. It is also a PG/SFW model by design — profanity or sexually explicit prompts are filtered, so it is best suited to SFW work. On Civitai several releases are hosted — Veo 3 and Veo 3 Fast for text-to-video, plus Veo 3 Image-to-Video and its Fast variant — so you can move between quality and speed without any local setup. For open weights and a stackable video LoRA ecosystem, the Wan ecosystem is the natural alternative to compare against.',
    ],
    promptTips: [
      'Write like a mini screenplay in natural language, not tags: describe the characters, the action, the mood, and the visual style in full sentences. A reliable order is scene and characters → action sequence → camera work → visual style → audio.',
      "Describe the audio, since Veo 3 generates it natively. Name the dialogue lines, sound effects, ambient noise, or music you want synced to the picture — leaving audio out wastes the model's signature feature.",
      'Direct the camera with real cinematography terms. Veo 3 understands "tracking shot," "crane shot," "steadicam," "time-lapse," "slow motion," and "whip pan," plus lens and film references like "shot on ARRI Alexa," "anamorphic lens," or "film grain."',
      'Skip weight syntax and negative prompts — neither is supported. There is no (word:1.5) and no "no blur" list; describe what you want positively instead.',
      'Keep it to one continuous take. For longer clips describe gradual progression ("transitioning from day to night") rather than discrete scene cuts, and remember Veo 3 is a PG/SFW model — explicit prompts are filtered, so keep it clean.',
    ],
    generatorVersionId: 1885367,
    featuredModels: [
      {
        modelId: 1665714,
        versionId: 1885367,
        imageId: 130405124,
        displayName: 'Veo 3',
        note: 'Civitai-hosted · default · text-to-video',
      },
      {
        modelId: 1665714,
        versionId: 1995399,
        imageId: 129368560,
        displayName: 'Veo 3 Fast',
        note: 'Civitai-hosted · speed-optimized',
      },
      {
        modelId: 1665714,
        versionId: 1996013,
        imageId: 125883219,
        displayName: 'Veo 3 Image-to-Video',
        note: 'Civitai-hosted · animate a still',
      },
      {
        modelId: 1665714,
        versionId: 2082027,
        imageId: 135396489,
        displayName: 'Veo 3 Image-to-Video Fast',
        note: 'Civitai-hosted · faster image-to-video',
      },
    ],
    featuredExamples: [
      {
        imageId: 131640138,
        prompt:
          'A small white kitten trembling and meowing nervously walks toward a skateboard, climbs on, and it suddenly starts moving like a car',
        settings: 'Veo 3 · 720×1280',
      },
      {
        imageId: 130438816,
        prompt:
          'A cute puppy shaking on two legs with frosting on him, next to a giant bitten cake and a sleeping cat, with a caption reading "it was the cat not me"',
        settings: 'Veo 3 · 1280×720',
      },
      {
        imageId: 126141741,
        prompt:
          'Two brave 3D chibi explorers — a tiger in an adventure hat and backpack and a squirrel in goggles — discovering a hidden treasure cave',
        settings: 'Veo 3 · 1280×720',
      },
      {
        imageId: 129440678,
        prompt:
          'A cinematic wide shot of a desolate battlefield at dusk, filled with drifting ash, broken war machines, and scattered debris under an overcast orange sky',
        settings: 'Veo 3 · 720×1280',
      },
      {
        imageId: 130302649,
        prompt:
          'A static locked-off shot of a single solitary garden snail sitting motionless on a pile of green glow-sticks in a dark environment',
        settings: 'Veo 3 · 1080×1920',
      },
      {
        imageId: 126691377,
        prompt:
          "A figure moves slowly as the stars behind him twinkle; he bows in a gentleman's salute, then stands at attention",
        settings: 'Veo 3 · 720×1280',
      },
    ],
    comparison: {
      peers: ['Sora 2', 'Kling', 'Seedance'],
      rows: [
        {
          label: 'Best for',
          values: [
            'Cinematic clips with native audio',
            'Cinematic video with synced audio',
            'Polished realistic motion',
            'One-pass video + audio',
          ],
        },
        {
          label: 'Provider',
          values: ['Google DeepMind', 'OpenAI', 'Kuaishou', 'ByteDance'],
        },
        {
          label: 'Native audio',
          values: ['Yes (dialogue, SFX, music)', 'Yes', 'No', 'Yes (dialogue + lip-sync)'],
          winner: 0,
        },
        {
          label: 'Access',
          values: [
            'API-only (hosted)',
            'API-only (hosted)',
            'API-only (hosted)',
            'API-only (hosted)',
          ],
        },
        {
          label: 'Image-to-video',
          values: ['Yes', 'Yes', 'Yes, first-frame anchored', 'Yes'],
        },
        { label: 'Available on Civitai', values: ['✓ Yes', '✓ Yes', '✓ Yes', '✓ Yes'] },
      ],
    },
    faq: [
      {
        q: 'How much does it cost to generate with Veo 3?',
        a: "Generation on Civitai runs on Buzz, and every account earns free Blue Buzz daily through on-site actions like reacting to images. Veo 3 is a premium hosted video model — a clip with native audio is far heavier to produce than a single image, so a Veo 3 generation costs more Buzz per clip than most models, and the standard Veo 3 costs more than the Fast variants. You can put your daily free Blue Buzz toward it, but for regular Veo 3 use you'll want to let Buzz accumulate or add a membership for higher limits.",
      },
      {
        q: 'What makes Veo 3 different from other video models?',
        a: 'Its headline feature is native audio: Veo 3 generates dialogue, sound effects, and even music together with the video in a single pass, rather than producing a silent clip. It also has an unusually deep grasp of cinematic camera direction. Describe the sound you want in your prompt and remix an example above to hear it.',
      },
      {
        q: 'Is Veo 3 SFW only?',
        a: "Yes. Veo 3 is a PG/SFW model by design — profanity or sexually explicit prompts are filtered — so it's best used for SFW content. Keep prompts clean and lean into its strengths: cinematic action, characters, and synced audio.",
      },
      {
        q: "What's the difference between text-to-video and image-to-video?",
        a: 'Text-to-video builds a clip from a written prompt, while image-to-video animates a still image you provide. Veo 3 does both — plus Fast variants of each that trade some fidelity for quicker turnaround — and you pick the mode right in the Civitai generator.',
      },
      {
        q: 'Can I use LoRAs with Veo 3?',
        a: 'No — Veo 3 is a closed, hosted model with no downloadable weights or LoRAs. You steer results through prompting, reference images, and camera direction instead. If you want stackable video LoRAs and motion effects, the open Wan ecosystem is the place to look.',
      },
      {
        q: 'Do I need a GPU to run Veo 3?',
        a: 'No. Veo 3 is API-only, and Civitai runs the generation for you in the cloud — there are no weights to download and nothing to install. Just enter a prompt or upload an image and generate in the browser.',
      },
    ],
    attribution: 'a hosted text-to-video and image-to-video model by Google DeepMind (Veo 3)',
    factCheck: [
      {
        field: 'comparison',
        claim: 'peer native-audio cells (Sora 2 = Yes, Kling = No, …)',
        note: 'Cross-checked against the Sora 2 config (consistent), but peer cells are general knowledge, not re-verified against each provider.',
      },
    ],
  },

  Sora2: {
    key: 'Sora2',
    updatedAt: '2026-07-23',
    slug: 'sora-2',
    name: 'Sora 2',
    metaDescription:
      "Generate Sora 2 video on Civitai — OpenAI's hosted text-to-video model known for physical realism and synchronized audio. Browse example clips & prompts.",
    modality: 'video',
    hero: {
      intro:
        "Sora 2 is OpenAI's text-to-video generation model, built for physically plausible motion, coherent multi-shot scenes, and synchronized audio generated alongside the video. It reads long, natural-language descriptions and holds character and world state steady across a clip. On Civitai it's fully hosted, so you can turn a prompt into a video right in the browser — no GPU, no install.",
      badges: ['Text-to-Video', 'Physical Realism', 'By OpenAI'],
    },
    overview: [
      'Sora 2 is OpenAI\'s text-to-video generation model and the successor to the original Sora, unveiled in February 2024. OpenAI frames that first Sora as a "GPT-1 moment" for video — the point at which simple behaviors like object permanence first emerged from scaling up pre-training compute. Sora 2 is the team\'s next major step, focused less on raw novelty and more on world simulation: modeling how objects, people, and physics actually behave over time rather than deforming reality to satisfy a prompt.',
      'The headline improvement is physical plausibility. OpenAI notes that where earlier video models will bend reality to complete a prompt — teleporting a missed basketball into the hoop — Sora 2 is more likely to let the shot rebound off the backboard, modeling failure as well as success. It also improves controllability, following intricate multi-shot instructions while keeping world state consistent, and it works across realistic, cinematic, and anime styles. As a general-purpose video-and-audio system it can generate synchronized speech, sound effects, and background soundscapes in the same pass rather than as a separate step.',
      "Sora 2 is a closed, hosted model: there are no downloadable weights and no Sora LoRAs, so control comes from prompting, reference material, and the generator's settings rather than community fine-tunes. On Civitai it runs entirely in the browser — no GPU, no install. Choose it when you want realistic motion, coherent physics, and cinematic multi-shot direction out of the box. For open weights, stackable LoRAs, and deep community control the Wan ecosystem is the natural alternative, while Veo 3 and Kling are the closest hosted peers to compare against.",
    ],
    promptTips: [
      "Write in natural language — vivid, descriptive paragraphs, not comma-separated tags. Sora 2's strong language understanding handles complex multi-element scenes, so describe the subject, action, setting, and mood as full prose.",
      'Skip weight syntax and negative prompts — neither is supported. Rephrase anything negative as a positive description: say "sharp, crystal clear" instead of "no blur."',
      'Direct the camera explicitly. Sora 2 responds to real cinematography language — "the camera follows behind a woman walking," "drone aerial shot rising over the city," "low-angle tracking shot," or "slow push-in on the character\'s face."',
      "Describe characters thoroughly. Sora's world-model approach maintains appearance across a clip, but sparse descriptions lead to drift — spell out who or what is on screen in detail.",
      'Add temporal and stylistic cues to shape the shot: "as the sun sets" or "transitioning from day to night" for motion over time, and references like "in the style of a Wes Anderson film," "noir aesthetic," or "documentary footage" for a consistent look. A reliable order is subject → action and scene → camera work → visual style and mood.',
    ],
    generatorVersionId: 2320065,
    featuredModels: [
      {
        modelId: 2049999,
        versionId: 2320065,
        imageId: 136011852,
        displayName: 'Sora 2',
        note: 'Civitai-hosted · by OpenAI',
      },
    ],
    featuredExamples: [
      {
        imageId: 136011852,
        prompt: 'Anthropomorphic dog and cat having a party, saying "magnificent"',
        settings: 'Sora 2 · 720×1280',
      },
      {
        imageId: 132779682,
        prompt:
          'A cozy cinematic animated scene filled with warmth and nostalgia. Early autumn evening in a small countryside town. A fluffy orange cat wearing a tiny hat',
        settings: 'Sora 2 · 720×1280',
      },
      {
        imageId: 134305014,
        prompt: "Cat walking on two legs. It's on the beach. It strikes a pose",
        settings: 'Sora 2 · 1280×720',
      },
      {
        imageId: 134601390,
        prompt: 'Cartoon kangaroo, twirling around, rainbow park',
        settings: 'Sora 2 · 720×1280',
      },
      {
        imageId: 126602082,
        prompt:
          'In the style of a Studio Ghibli action movie with gritty 24fps cinematic flair, a pack of sleek anthropomorphic robots crafted from rusted brass gears and glowing blue eyes',
        settings: 'Sora 2 · 720×1280',
      },
      {
        imageId: 126981587,
        prompt: 'Anthropomorphic badger, victory dance',
        settings: 'Sora 2 · 720×1280',
      },
    ],
    comparison: {
      peers: ['Veo 3', 'Kling', 'Wan'],
      rows: [
        {
          label: 'Best for',
          values: [
            'Physical realism & cinematic multi-shot video',
            'Cinematic clips with native audio',
            'Polished cinematic motion & camera control',
            'Open T2V/I2V + huge LoRA ecosystem',
          ],
        },
        {
          label: 'Provider',
          values: ['OpenAI', 'Google DeepMind', 'Kuaishou', 'Alibaba'],
        },
        {
          label: 'Access',
          values: ['API-only (hosted)', 'API-only (hosted)', 'API-only (hosted)', 'Open weights'],
        },
        {
          label: 'Native audio',
          values: [
            'Synchronized speech + sound',
            'Synchronized speech + sound',
            'No native audio',
            'No native audio',
          ],
        },
        {
          label: 'LoRA support',
          values: ['None (closed)', 'None (closed)', 'None (closed)', '2,500+ (largest for video)'],
          winner: 3,
        },
        { label: 'Available on Civitai', values: ['✓ Yes', '✓ Yes', '✓ Yes', '✓ Yes'] },
      ],
    },
    faq: [
      {
        q: 'How much does it cost to generate Sora 2 video on Civitai?',
        a: "Generation on Civitai runs on Buzz, and every account earns free Blue Buzz daily through on-site actions like reacting to images. Sora 2 is a premium hosted video model — producing a clip is far heavier than rendering a single image, so a Sora 2 generation costs more Buzz per clip than most models, and longer clips cost more than shorter ones. You can put your daily free Blue Buzz toward it, but for regular Sora 2 use you'll want to let Buzz accumulate or add a membership for higher limits.",
      },
      {
        q: 'Does Sora 2 generate audio?',
        a: 'Yes. Sora 2 is a general-purpose video-and-audio system: OpenAI describes it as able to create synchronized speech, sound effects, and background soundscapes along with the video in a single pass. Remix an example above to try it yourself.',
      },
      {
        q: 'Can I use LoRAs with Sora 2?',
        a: 'No — Sora 2 is a closed, hosted model with no downloadable weights or LoRAs. You steer results through prompting, reference material, and the generator settings instead. If you want stackable video LoRAs and motion effects, the open Wan ecosystem is the place to look.',
      },
      {
        q: 'How is Sora 2 different from the original Sora?',
        a: 'OpenAI positions the first Sora (February 2024) as an early breakthrough where basic behaviors like object permanence emerged, and Sora 2 as a larger step toward genuine world simulation — better physics, stronger controllability across multiple shots, and synchronized audio. Try a prompt in the Civitai generator to see the difference.',
      },
      {
        q: 'What is Sora 2 best at?',
        a: 'Sora 2 leans toward realistic, physically coherent motion and cinematic, multi-shot direction — OpenAI highlights its ability to model real-world dynamics rather than deforming a scene to hit a prompt, and it also handles cinematic and anime styles. Describe a single clear scene and remix an example to see how it performs.',
      },
      {
        q: 'Do I need a GPU to run Sora 2?',
        a: 'No. Sora 2 is API-only, and Civitai runs the generation for you in the cloud — there are no weights to download and nothing to install. Just enter a prompt and generate in the browser.',
      },
    ],
    sunset: {
      date: '2026-09-24',
      note: 'OpenAI is permanently shutting down the Sora and Sora 2 endpoints, after which they will no longer be generatable on Civitai. Veo 3, Kling, and the open Wan ecosystem are the closest alternatives.',
    },
    attribution: 'a hosted text-to-video model by OpenAI (Sora 2)',
    factCheck: [
      {
        field: 'overview',
        claim: 'synchronized audio (speech, SFX, soundscapes)',
        highlight: 'synchronized speech, sound effects, and background soundscapes',
        note: 'Claimed from the model card only; the sora2 prompt guide does not mention audio. Verify the capability.',
      },
      {
        field: 'comparison',
        claim: 'peer native-audio / provider cells',
        note: 'From general knowledge / sibling configs, not independently re-verified.',
      },
    ],
  },

  Chroma: {
    key: 'Chroma',
    updatedAt: '2026-07-23',
    name: 'Chroma',
    metaDescription:
      "Generate with Chroma on Civitai — Lodestone's open, Apache-2.0 base image model (a de-distilled FLUX.1 [schnell], ~8.9B) built for fine-tuning. Browse Chroma LoRAs & prompts.",
    modality: 'image',
    hero: {
      intro:
        'Chroma is an open-weight, Apache-2.0 text-to-image model by Lodestone — a true base model with no aesthetic tuning, meant as a raw, neutral foundation for fine-tuning. Built as a de-distilled FLUX.1 [schnell] (~8.9B parameters) with a T5 text encoder, it reads natural-language prompts and stays deliberately un-opinionated. Generate with the Civitai-hosted Chroma checkpoint right here — no GPU, no install.',
      badges: ['Text-to-Image', 'Open weights (Apache 2.0)', 'By Lodestone'],
    },
    overview: [
      'Chroma is an open-source foundational image model from Lodestone, released fully under Apache 2.0 with no gatekeeping. It is positioned explicitly as a true base model: no aesthetic tuning and no post-training such as DPO, so it ships as a raw, neutral starting point designed for the community to fine-tune rather than a polished, ready-styled generator. Architecturally it is a de-distill of FLUX.1 [schnell] at roughly 8.9 billion parameters, pairing the transformer with a T5 text encoder that actually parses grammar — so it reads natural-language descriptions rather than comma-separated tags. The base-model training run consumed about 105,000 H100 hours, packing in a broad data distribution intended to make fine-tuning on top of it converge quickly.',
      'Chroma is really a small family rather than one file. Chroma1-Base is the core 512×512 foundation, aimed at longer fine-tunes; Chroma1-HD is the 1024×1024 high-res fine-tune of that base and the best starting point for high-res LoRAs — it is the version hosted on Civitai. On the research branch, Chroma1-Flash is an experimental speed fine-tune whose delta weights can be applied to other Chroma versions, and Chroma1-Radiance is a work-in-progress pixel-space variant meant to sidestep VAE compression artifacts. For local users there are FP8-scaled and GGUF quantized builds that lower the VRAM needed to run it.',
      'Choose Chroma when you want a permissive, un-tuned open foundation to build on — a neutral canvas for fine-tunes and LoRAs rather than a model with a baked-in house style. Because it is a FLUX-derived model with a T5 encoder, it follows natural-language prompts well, but it will not hand you the polished, aesthetic-tuned look that a post-trained model like FLUX.1 [dev] produces out of the box; that is by design. For maximum prompt polish and in-image text, FLUX.1 leads; for the deepest LoRA library and versatile realism, SDXL is the safer default; for legible typography, Qwen-Image is stronger. Reach for Chroma when openness, a clean license, and a raw base to fine-tune are what you actually need.',
    ],
    promptTips: [
      'Write in natural language — full descriptive sentences, not comma-separated tags. Chroma’s T5 text encoder parses grammar, so tag-style prompts underperform. A useful template is: [subject with detail], [setting/scene], [style and color palette], [lighting], [composition].',
      'Give the encoder enough to work with. Very short prompts tend to underperform on Chroma — add concrete detail about materials, mood, and framing rather than leaving it terse.',
      'Skip weight syntax like (word:1.4) — it is not used here. Control emphasis through descriptive language and word choice instead of numeric weights.',
      'Use a negative prompt — Chroma supports it as a separate parameter and benefits from one. A solid quality-focused baseline is "low quality, ugly, unfinished, out of focus, deformed, disfigured, blurry, flat colors."',
      'Chroma uses true CFG (classifier-free guidance). The official example uses a guidance scale around 3.0; some nudge it a little higher for punchier output — worth trying both when dialing in a prompt.',
    ],
    generatorVersionId: 2164239,
    featuredModels: [
      {
        modelId: 1330309,
        versionId: 2164239,
        imageId: 103698898,
        displayName: 'Chroma',
        note: 'Civitai-hosted · open base model',
      },
    ],
    featuredExamples: [
      {
        imageId: 136230335,
        prompt:
          'Studio Ghibli dark fairytale, low-angle wide shot at midnight, a slender sorceress in a heavy embroidered velvet cloak',
        settings: 'Chroma v1.0-HD · 832×1216',
      },
      {
        imageId: 137454624,
        prompt:
          'Macro photograph of a male bard in a weathered emerald-green damask doublet with high collar and decorated dagger sheath',
        settings: 'Chroma v1.0-HD · 1024×1024',
      },
      {
        imageId: 137454546,
        prompt:
          'Vaporwave style, a male scholar in a fitted satin ivory-white jerkin at a dungeon entrance under overcast daylight',
        settings: 'Chroma v1.0-HD · 1024×1024',
      },
      {
        imageId: 137454551,
        prompt:
          'Cyberpunk cityscape, a feminine cleric in a fur-trimmed sapphire-blue court dress walking through a busy market',
        settings: 'Chroma v1.0-HD · 1024×1024',
      },
      {
        imageId: 137413940,
        prompt:
          'Digital artwork by artist:neurodyne — a white fox girl with yellow eyes in a black t-shirt and jeans, outdoors among flowers',
        settings: 'Chroma v1.0-HD · 1024×1280',
      },
      {
        imageId: 136985094,
        prompt:
          'The dark silhouette of an adventurer stands on a cliff as a colossal robot bends down toward the figure, cinematic semi-realistic',
        settings: 'Chroma v1.0-HD · 832×1216',
      },
    ],
    comparison: {
      peers: ['FLUX.1', 'SDXL', 'Qwen'],
      rows: [
        {
          label: 'Best for',
          values: [
            'Neutral open base for fine-tuning',
            'Polished photorealism & text',
            'Versatile realism & huge LoRA depth',
            'Prompt accuracy & in-image text',
          ],
        },
        {
          label: 'Prompt style',
          values: ['Natural language', 'Natural language', 'Tags', 'Natural language'],
        },
        {
          label: 'License',
          values: ['Apache 2.0', 'Non-commercial (Dev)', 'CreativeML / OpenRAIL', 'Apache 2.0'],
          winner: 0,
        },
        {
          label: 'Parameters',
          values: ['~8.9B', '12B', '~3.5B', '20B'],
        },
        {
          label: 'LoRA ecosystem',
          values: ['{loras:Chroma}', '{loras:Flux1}', '{loras:SDXL}', '{loras:Qwen}'],
        },
        { label: 'Available on Civitai', values: ['✓ Yes', '✓ Yes', '✓ Yes', '✓ Yes'] },
      ],
    },
    faq: [
      {
        q: 'How much does it cost to generate with Chroma?',
        a: 'Generation on Civitai runs on Buzz, not real money at the point of use. Chroma is an open model — a de-distilled FLUX.1 [schnell] at roughly 8.9B parameters — so it sits in the moderate range: lighter than a full 12B FLUX.1 [dev] or a 20B Qwen render, heavier than a small SD checkpoint. Every account earns free Blue Buzz daily just by reacting to images and staying active on the site, and because Chroma is relatively light that daily Blue Buzz stretches a long way — you can iterate on prompts and try fine-tunes without spending. Generate heavily or at large sizes and you will draw Buzz down faster, so you can let it accumulate or add a membership for higher limits.',
      },
      {
        q: 'What exactly is Chroma?',
        a: 'Chroma is an open-source foundational image model by Lodestone — a true base model with no aesthetic tuning and no post-training like DPO, meant as a raw, neutral starting point for fine-tuning. It is a de-distilled FLUX.1 [schnell] (~8.9B parameters) released under Apache 2.0. Try the hosted checkpoint in the Civitai generator.',
      },
      {
        q: 'How is Chroma different from FLUX.1?',
        a: 'Chroma is derived from FLUX.1 [schnell] but de-distilled and deliberately left un-tuned — no baked-in aesthetic — so it behaves as a neutral base to fine-tune, and it ships under a permissive Apache 2.0 license. FLUX.1 [dev] gives you a more polished look out of the box. Run both on Civitai and compare the raw base against the tuned model.',
      },
      {
        q: 'Can I train my own Chroma LoRA?',
        a: 'Yes — Chroma was designed to be fine-tuned, and its 1024px HD variant is a strong base for high-res LoRAs. Publish what you train to earn Buzz when others generate with it.',
      },
      {
        q: 'Which Chroma version does Civitai host?',
        a: 'The generator runs Chroma1-HD (v1.0-HD), the 1024×1024 high-res fine-tune of the Chroma base — the recommended starting point for high-res work. Pick it in the generator and start from a prompt.',
      },
      {
        q: 'Do I need a GPU to run Chroma?',
        a: 'Not on Civitai — we run the compute for you. Locally, Chroma wants roughly 12GB+ of VRAM at full precision, though FP8-scaled and GGUF quantized builds let it run on less. Start generating in the browser instead.',
      },
    ],
    localRun: {
      vram: '~12GB+ VRAM (FP8/GGUF quants run on less)',
      weightsSize: '~9–18GB (FP8 → FP16; GGUF smaller)',
      tool: 'ComfyUI',
    },
    attribution: 'an open-weight, Apache-2.0 base image model by Lodestone (Chroma)',
    factCheck: [
      {
        field: 'localRun',
        claim: '~12GB+ VRAM / ~9–18GB weights',
        highlight: '~12GB+',
        note: 'Estimates, not stated in the model card (card only confirms FP8/GGUF variants exist). Verify against Chroma release notes.',
      },
      {
        field: 'comparison',
        claim: 'peer parameter counts (SDXL ~3.5B, etc.)',
        highlight: '~3.5B',
        note: 'Approximate — adjust if you want exact figures.',
      },
    ],
  },
};

export const getEcosystemSeoConfig = (key: string): EcosystemSeoConfig | undefined =>
  ECOSYSTEM_SEO[key];

/** Public URL slug for an ecosystem page — the `slug` override, else the lowercased key. */
export const getEcosystemSeoSlug = (config: EcosystemSeoConfig): string =>
  config.slug ?? config.key.toLowerCase();

/** Matches a `{loras:Key}` token in a comparison value. Global — use with `.replace`/`matchAll`. */
export const LORA_COUNT_TOKEN = /\{loras:([A-Za-z0-9_]+)\}/g;

/** ECOSYSTEM_SEO keys whose live LoRA count this page's comparison table needs. */
export const getComparisonLoraCountKeys = (config: EcosystemSeoConfig): string[] => [
  ...new Set(
    config.comparison.rows
      .flatMap((row) => row.values)
      .flatMap((value) => [...value.matchAll(LORA_COUNT_TOKEN)].map((m) => m[1]))
  ),
];

/** Every basemodel ecosystem key this page represents (primary + combined). */
export const getConfigEcosystemKeys = (config: EcosystemSeoConfig): string[] => [
  config.key,
  ...(config.additionalEcosystemKeys ?? []),
];

const configBySlug = new Map(
  Object.values(ECOSYSTEM_SEO).map((config) => [getEcosystemSeoSlug(config), config])
);

/** Resolve a page config from a URL slug, case-insensitively (URLs are lowercase). */
export const getEcosystemSeoConfigBySlug = (slug: string): EcosystemSeoConfig | undefined =>
  configBySlug.get(slug.toLowerCase());

export type EcosystemSeoPage = {
  /** URL slug (lowercase) — the page lives at /ecosystems/<slug>. */
  slug: string;
  /** Display label for footer/nav cross-links. */
  label: string;
  /**
   * basemodel ecosystem key(s) this page represents. Usually one; multiple means a combined
   * page (e.g. Z-Image = ZImageTurbo + ZImageBase, which share basemodel family 11).
   */
  ecosystemKeys: string[];
};

/**
 * Authoritative list of ecosystems targeted for SEO hub pages — the single source of truth for:
 *  - the footer cross-links (every page links to the others),
 *  - the sitemap (only entries whose page is LIVE — has an ECOSYSTEM_SEO config — are emitted).
 *
 * An entry goes "live" when its `slug` resolves to an ECOSYSTEM_SEO config. Until then it's a
 * planned target: shown as a footer pill (unlinked) but NOT emitted to the sitemap (no 404s).
 * Adding a new ecosystem page = add its config to ECOSYSTEM_SEO + an entry here.
 */
export const ECOSYSTEM_SEO_PAGES: EcosystemSeoPage[] = [
  { slug: 'flux1', label: 'FLUX.1', ecosystemKeys: ['Flux1'] },
  { slug: 'flux2', label: 'FLUX.2', ecosystemKeys: ['Flux2'] },
  { slug: 'sdxl', label: 'SDXL', ecosystemKeys: ['SDXL'] },
  { slug: 'pony', label: 'Pony', ecosystemKeys: ['Pony'] },
  { slug: 'illustrious', label: 'Illustrious', ecosystemKeys: ['Illustrious'] },
  { slug: 'noobai', label: 'NoobAI', ecosystemKeys: ['NoobAI'] },
  { slug: 'wan', label: 'Wan', ecosystemKeys: ['WanVideo'] },
  { slug: 'ltxv', label: 'LTX Video', ecosystemKeys: ['LTXV', 'LTXV2', 'LTXV23'] },
  { slug: 'kling', label: 'Kling', ecosystemKeys: ['Kling'] },
  { slug: 'seedance', label: 'Seedance', ecosystemKeys: ['Seedance'] },
  { slug: 'grok', label: 'Grok Imagine', ecosystemKeys: ['Grok'] },
  { slug: 'happyhorse', label: 'HappyHorse', ecosystemKeys: ['HappyHorse'] },
  { slug: 'nano-banana', label: 'Nano Banana', ecosystemKeys: ['NanoBanana'] },
  { slug: 'imagen-4', label: 'Imagen 4', ecosystemKeys: ['Imagen4'] },
  { slug: 'seedream', label: 'Seedream', ecosystemKeys: ['Seedream'] },
  { slug: 'veo-3', label: 'Veo 3', ecosystemKeys: ['Veo3'] },
  { slug: 'sora-2', label: 'Sora 2', ecosystemKeys: ['Sora2'] },
  { slug: 'chroma', label: 'Chroma', ecosystemKeys: ['Chroma'] },
  { slug: 'qwen', label: 'Qwen', ecosystemKeys: ['Qwen'] },
  { slug: 'stable-diffusion', label: 'Stable Diffusion', ecosystemKeys: ['SD1'] },
  { slug: 'hidream', label: 'HiDream', ecosystemKeys: ['HiDream'] },
  { slug: 'krea2', label: 'Krea 2', ecosystemKeys: ['Krea2'] },
  { slug: 'anima', label: 'Anima', ecosystemKeys: ['Anima'] },
  { slug: 'z-image', label: 'Z-Image', ecosystemKeys: ['ZImageTurbo', 'ZImageBase'] },
];

/** True once an announced sunset date has arrived — the ecosystem's endpoints are gone. */
export const isEcosystemSunset = (config: EcosystemSeoConfig, now = new Date()): boolean =>
  !!config.sunset && now.toISOString().slice(0, 10) >= config.sunset.date;

/** Whether an SEO page slug has a built config (renders 200) vs. is a planned target. */
export const isEcosystemSeoPageLive = (slug: string): boolean =>
  getEcosystemSeoConfigBySlug(slug) !== undefined;

/** Live pages only (built configs) — the set that belongs in the sitemap. */
export const getLiveEcosystemSeoPages = (): EcosystemSeoPage[] =>
  ECOSYSTEM_SEO_PAGES.filter((page) => isEcosystemSeoPageLive(page.slug));

/**
 * The live SEO landing page that represents a given basemodel ecosystem key (e.g. `'SD1'` →
 * the `stable-diffusion` page), or undefined if none is built. Handles combined pages, whose
 * `ecosystemKeys` list more than one key. Client-safe — used to link model pages to their
 * ecosystem hub. Pair with `getBaseModelGroup(baseModel)` to go from a `baseModel` string → key.
 */
export const getEcosystemSeoPageForKey = (ecosystemKey: string): EcosystemSeoPage | undefined =>
  ECOSYSTEM_SEO_PAGES.find(
    (page) => page.ecosystemKeys.includes(ecosystemKey) && isEcosystemSeoPageLive(page.slug)
  );
