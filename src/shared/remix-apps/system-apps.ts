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

export const SYSTEM_RUNTIME_APPS: RemixApp[] = [animeIt];

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
