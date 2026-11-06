// The system apps as code, exactly as they stood before they became rows (with civitai/civitai#8013's
// prompts): the oracle the seed parity test compares compiled rows against. Never edit to match a seed.
import { DEFAULT_ENGINE, type RemixAppDefinition } from '~/shared/constants/remix-apps.constants';
import { defineRemixApp } from '~/shared/remix-apps/define';

export const animeIt = defineRemixApp({
  slug: 'anime-it',
  name: 'Anime it',
  icon: 'sparkles',
  version: 1,
  engine: DEFAULT_ENGINE,
  async run(ctx) {
    const { images } = await ctx.workflow({
      kind: 'image',
      prompt:
        "Redraw this image as a 2D anime illustration with clean black line art, flat cel shading with hard-edged shadow shapes, and simple flat colors. If the source is a photo or a 3D render, convert every surface into hand-drawn anime style, with no photographic texture and no realistic rendering. Keep the subject, pose and composition. Don't add any text or lettering.",
      images: [ctx.source],
      aspectRatio: 'source',
      quantity: 1,
    });
    return images;
  },
});

/** The first app with more than one step: four takes, a pick, then upscale it or keep it. */
export const pickOfFour = defineRemixApp({
  slug: 'pick-of-four',
  name: 'Pick of four',
  icon: 'pick',
  description: 'Four takes on this image. Keep your favourite, or upscale it.',
  version: 1,
  engine: DEFAULT_ENGINE,
  async run(ctx) {
    const takes = await ctx.workflow({
      kind: 'image',
      prompt:
        "Reimagine this image: keep its subject and composition, and give it a fresh style, lighting and detail. Don't add any text or lettering.",
      images: [ctx.source],
      aspectRatio: 'source',
      quantity: 4,
    });
    const pick = await ctx.ask({
      kind: 'pick',
      prompt: 'Pick your favourite',
      images: takes.images,
    });
    const chosen = takes.images[pick];
    const finish = await ctx.ask({
      kind: 'choice',
      prompt: 'Finish it',
      image: chosen,
      options: [
        { value: 'upscale', label: 'Upscale 2×' },
        { value: 'keep', label: 'Keep it' },
      ],
    });
    if (finish === 'keep') return [chosen];
    const { images } = await ctx.workflow({ kind: 'upscale', image: chosen, scale: 2 });
    return images;
  },
});

export const RESTYLE_STYLES = [
  {
    value: 'watercolor',
    label: 'Watercolor',
    style:
      'a loose watercolor painting on textured paper, with soft washes and visible brush edges',
  },
  {
    value: 'oil-painting',
    label: 'Oil painting',
    style: 'a classical oil painting on canvas, with rich colour and visible brushstrokes',
  },
  {
    value: 'ukiyo-e',
    label: 'Ukiyo-e',
    style: 'a Japanese ukiyo-e woodblock print, with flat colour, bold outlines and paper grain',
    /** Ukiyo-e outputs drew a seal stamp with characters under the plain no-text line. */
    noText: "Don't add any text, lettering, seals or stamps.",
  },
  {
    value: 'cyberpunk-neon',
    label: 'Cyberpunk neon',
    style:
      'a cyberpunk night scene lit by neon signs, with magenta and cyan glow and wet reflections',
  },
  {
    value: 'claymation',
    label: 'Claymation',
    style: 'a stop-motion claymation scene, with plasticine figures and fingerprint texture',
  },
] as const;

export const RESTYLE_EXTRA_MAX_LENGTH = 120;

const NO_TEXT = "Don't add any text or lettering.";

export function restylePrompt(style: string, extra: string) {
  const picked: { style: string; noText?: string } =
    RESTYLE_STYLES.find((s) => s.value === style) ?? RESTYLE_STYLES[0];
  const base = `Restyle this image as ${picked.style}. Keep the subject, their pose and the composition the same.`;
  const withExtra = extra ? `${base} Also add to the scene: ${extra}.` : base;
  return `${withExtra} ${picked.noText ?? NO_TEXT}`;
}

/** Asks first: an optional addition, then a style whose options show the edit's price. */
export const restyle = defineRemixApp({
  slug: 'restyle',
  name: 'Restyle',
  icon: 'palette',
  description: 'Pick a style, and add something to the scene if you like.',
  version: 1,
  engine: DEFAULT_ENGINE,
  async run(ctx) {
    const extra = await ctx.ask({
      kind: 'text',
      prompt: 'Add something to the scene (optional)',
      maxLength: RESTYLE_EXTRA_MAX_LENGTH,
      optional: true,
    });
    const style = await ctx.ask({
      kind: 'choice',
      prompt: 'Pick a style',
      options: RESTYLE_STYLES.map(({ value, label }) => ({ value, label })),
    });
    const { images } = await ctx.workflow({
      kind: 'image',
      prompt: restylePrompt(style, extra.trim()),
      images: [ctx.source],
      aspectRatio: 'source',
      quantity: 1,
    });
    return images;
  },
});

export const SYSTEM_REMIX_APPS: RemixAppDefinition[] = [
  {
    slug: 'make-it-real',
    name: 'Make it real',
    icon: 'camera',
    output: 'image',
    engine: DEFAULT_ENGINE,
    prompt:
      "Turn this image into a live-action photograph of the real person (or the real animal or object) shown, in the same outfit, pose and setting, as if shot on a DSLR in natural light: real skin, hair, fabric and materials, and real surroundings. Nothing may look drawn, painted or rendered, with no line art, no cel shading and no glossy anime eyes. Keep the pose, outfit and composition. Don't add any text or lettering.",
    params: { aspectRatio: 'source', quantity: 1 },
  },
  {
    slug: 'toy-figure',
    name: 'Toy figure',
    icon: 'toy',
    output: 'image',
    engine: DEFAULT_ENGINE,
    prompt:
      "Turn the subject into a collectible toy figure in its packaging box, product photo. Don't add any text or lettering.",
    params: { aspectRatio: 'source', quantity: 1 },
  },
  {
    slug: 'pixel-art',
    name: 'Pixel art',
    icon: 'grid',
    output: 'image',
    engine: DEFAULT_ENGINE,
    prompt:
      "Redraw this image as true low-resolution pixel art, as if drawn on a 160 by 240 pixel grid and scaled up with nearest-neighbor: large, clearly visible square pixels, hard stair-stepped edges, no anti-aliasing or smooth gradients, and a limited palette of about 16 flat colors with simple dithering. Keep the subject, pose and composition. Don't add any text or lettering.",
    params: { aspectRatio: 'source', quantity: 1 },
  },
  {
    slug: 'pencil-sketch',
    name: 'Pencil sketch',
    icon: 'pencil',
    output: 'image',
    engine: DEFAULT_ENGINE,
    prompt:
      "Redraw this image as a detailed graphite pencil sketch on paper. Don't add any text or lettering.",
    params: { aspectRatio: 'source', quantity: 1 },
  },
  {
    slug: 'claymation',
    name: 'Claymation',
    icon: 'clay',
    output: 'image',
    engine: DEFAULT_ENGINE,
    prompt:
      "Recreate this image as a stop-motion claymation scene with plasticine figures. Don't add any text or lettering.",
    params: { aspectRatio: 'source', quantity: 1 },
  },
];
