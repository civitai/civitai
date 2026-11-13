import { defineRemixApp, type RemixApp, type RemixImage } from '~/shared/remix-apps/define';
import type { RemixDeclarativeSpec } from '~/shared/remix-apps/row.schema';

/** The listing fields a row carries beside its spec. */
export type RemixAppListing = {
  slug: string;
  name: string;
  description?: string;
  version: number;
};

function fill(prompt: string, values: Map<string, string>) {
  return prompt.replace(/\{\{([^{}]*)\}\}/g, (_, name: string) => values.get(name) ?? '');
}

/**
 * A declarative row as a runtime app: its asks in order, then its steps, returning the last
 * step's images. Deterministic over `ctx`, as replay requires.
 */
export function compileRemixApp(listing: RemixAppListing, spec: RemixDeclarativeSpec): RemixApp {
  return defineRemixApp({
    ...listing,
    icon: spec.icon,
    engine: spec.engine,
    async run(ctx) {
      const values = new Map<string, string>();
      for (const ask of spec.asks) {
        if (ask.kind === 'text') {
          const answer = (
            await ctx.ask({
              kind: 'text',
              prompt: ask.prompt,
              maxLength: ask.maxLength,
              ...(ask.optional ? { optional: true } : {}),
            })
          ).trim();
          const wrapped = answer && ask.wrap ? ask.wrap.before + answer + ask.wrap.after : answer;
          values.set(ask.id, wrapped);
        } else {
          const value = await ctx.ask({
            kind: 'choice',
            prompt: ask.prompt,
            options: ask.options.map(({ value, label }) => ({ value, label })),
          });
          const option = ask.options.find((o) => o.value === value) ?? ask.options[0];
          for (const [key, fragment] of Object.entries(option.fragments)) values.set(key, fragment);
        }
      }

      let images: RemixImage[] = [];
      for (const step of spec.steps) {
        const input = step.kind === 'image' && step.input === 'source' ? ctx.source : images[0];
        if (step.kind === 'upscale') {
          ({ images } = await ctx.workflow({ kind: 'upscale', image: input, scale: step.scale }));
          continue;
        }
        ({ images } = await ctx.workflow({
          kind: 'image',
          prompt: fill(step.prompt, values),
          images: [input],
          aspectRatio: step.aspectRatio,
          quantity: step.quantity,
        }));
      }
      return images;
    },
  });
}
