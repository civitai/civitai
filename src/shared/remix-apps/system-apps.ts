import { DEFAULT_ENGINE, SYSTEM_REMIX_APPS } from '~/shared/constants/remix-apps.constants';
import { defineRemixApp, type RemixApp } from '~/shared/remix-apps/define';

export const animeIt = defineRemixApp({
  slug: 'anime-it',
  name: 'Anime it',
  icon: 'sparkles',
  version: 1,
  engine: DEFAULT_ENGINE,
  async run(ctx) {
    const { images } = await ctx.workflow({
      kind: 'image',
      prompt: 'Redraw this image as a high-quality anime illustration, keeping the composition.',
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
        'Reimagine this image: keep its subject and composition, and give it a fresh style, lighting and detail.',
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

export function restylePrompt(style: string, extra: string) {
  const { style: look } = RESTYLE_STYLES.find((s) => s.value === style) ?? RESTYLE_STYLES[0];
  const base = `Restyle this image as ${look}. Keep the subject, their pose and the composition the same.`;
  return extra ? `${base} Also add to the scene: ${extra}` : base;
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

export const SYSTEM_RUNTIME_APPS: RemixApp[] = [animeIt, pickOfFour, restyle];

export function getRuntimeRemixApp(slug: string) {
  return SYSTEM_RUNTIME_APPS.find((app) => app.slug === slug);
}

export type RemixMenuApp = Pick<RemixApp, 'slug' | 'name' | 'icon' | 'description' | 'engine'> & {
  /** Started through `remixApp.start` rather than the one-shot `remixApp.run`. */
  runtime: boolean;
};

export const REMIX_MENU_APPS: RemixMenuApp[] = [
  ...SYSTEM_RUNTIME_APPS.map((app) => ({ ...menuFields(app), runtime: true })),
  ...SYSTEM_REMIX_APPS.map((app) => ({ ...menuFields(app), runtime: false })),
];

function menuFields({
  slug,
  name,
  icon,
  description,
  engine,
}: Pick<RemixApp, 'slug' | 'name' | 'icon' | 'description' | 'engine'>) {
  return { slug, name, icon, description, engine };
}
