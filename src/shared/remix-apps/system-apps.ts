import { DEFAULT_ENGINE } from '~/shared/constants/remix-apps.constants';
import { defineRemixApp, type RemixApp } from '~/shared/remix-apps/define';
import type { RemixCodeSpec } from '~/shared/remix-apps/row.schema';

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

/**
 * Apps whose `run` stays code: a row lists one by naming it in `code`, and takes from the row only
 * its listing (name, description, icon, target, enabled, order).
 */
export const CODE_REMIX_APPS: Record<RemixCodeSpec['code'], RemixApp> = {
  'pick-of-four': pickOfFour,
};
