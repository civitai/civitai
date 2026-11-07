import { describe, expect, it } from 'vitest';
import { compileRemixApp } from '~/shared/remix-apps/compile';
import type { RemixAsk } from '~/shared/remix-apps/define';
import { dryRunRemixApp } from '~/shared/remix-apps/mock-host';
import { SEED_REMIX_APPS } from '~/shared/remix-apps/seed';
import { CODE_REMIX_APPS } from '~/shared/remix-apps/system-apps';
import type { RemixDeclarativeSpec } from '~/shared/remix-apps/row.schema';

const NO_TEXT = "Don't add any text";
const source = { imageId: 7, url: 'https://image.example/s.png', width: 800, height: 800 };

const SEED_APPS = SEED_REMIX_APPS.map(({ slug, name, spec }) =>
  'code' in spec ? CODE_REMIX_APPS[spec.code] : compileRemixApp({ slug, name, version: 1 }, spec)
);
const restyle = SEED_APPS.find((app) => app.slug === 'restyle')!;
const restyleSpec = SEED_REMIX_APPS.find((app) => app.slug === 'restyle')!
  .spec as RemixDeclarativeSpec;
/** Every style the seed offers, so a style added without the no-text fragment fails here. */
const STYLES = restyleSpec.asks.flatMap((ask) =>
  ask.kind === 'choice' && ask.id === 'style' ? ask.options.map((option) => option.value) : []
);

/** A choice answer, refusing an option the ask does not offer rather than answering another. */
function choose(spec: Extract<RemixAsk, { kind: 'choice' }>, option?: string) {
  if (option === undefined) return spec.options[0].value;
  if (!spec.options.some((o) => o.value === option))
    throw new Error(`"${option}" is not an option of "${spec.prompt}"`);
  return option;
}

/** The image prompts a run sends, answering text asks with `extra` and choices with `option`. */
async function promptsOf(app: (typeof SEED_APPS)[number], extra = '', option?: string) {
  const answer = (spec: RemixAsk) =>
    spec.kind === 'text' ? extra : spec.kind === 'pick' ? 0 : choose(spec, option);
  const { trace } = await dryRunRemixApp(app, source, { answer });
  return trace.flatMap((step) =>
    step.type === 'workflow' && step.request.kind === 'image' ? [step.request.prompt] : []
  );
}

describe('seeded remix app prompts forbid added text', () => {
  it.each(SEED_APPS.map((app) => [app.slug, app] as const))('%s', async (_, app) => {
    const prompts = await promptsOf(app);
    expect(prompts.length).toBeGreaterThan(0);
    for (const prompt of prompts) expect(prompt).toContain(NO_TEXT);
  });

  it('reads the styles from the seed', () => expect(STYLES.length).toBeGreaterThan(1));

  it.each(STYLES)('restyle %s, with and without an extra', async (style) => {
    expect((await promptsOf(restyle, '', style))[0]).toContain(NO_TEXT);
    expect((await promptsOf(restyle, 'a red paper umbrella', style))[0]).toMatch(
      /Don't add any text[^.]*\.$/
    );
  });

  it('ukiyo-e also forbids seals and stamps', async () => {
    expect((await promptsOf(restyle, '', 'ukiyo-e'))[0]).toMatch(
      /Don't add any text, lettering, seals or stamps\.$/
    );
  });
});
