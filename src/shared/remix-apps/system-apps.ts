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

export const SYSTEM_RUNTIME_APPS: RemixApp[] = [animeIt, pickOfFour];

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
