import { describe, expect, it } from 'vitest';
import { dryRunRemixApp, remixOptionEffects } from '~/shared/remix-apps/mock-host';
import type { RemixAsk } from '~/shared/remix-apps/define';
import { compileRemixApp } from '~/shared/remix-apps/compile';
import { SEED_REMIX_APPS } from '~/shared/remix-apps/seed';
import { CODE_REMIX_APPS, pickOfFour } from '~/shared/remix-apps/system-apps';

const SEED_APPS = SEED_REMIX_APPS.map(({ slug, name, spec }) =>
  'code' in spec ? CODE_REMIX_APPS[spec.code] : compileRemixApp({ slug, name, version: 1 }, spec)
);

const source = { imageId: 7, url: 'https://image.example/source.png', width: 1200, height: 800 };

describe('dryRunRemixApp', () => {
  it.each(SEED_APPS.map((app) => [app.slug, app] as const))(
    '%s gives the same trace on every run',
    async (_, app) => {
      const first = await dryRunRemixApp(app, source);
      const second = await dryRunRemixApp(app, source);

      expect(second).toEqual(first);
      // Answers are recorded on a workflow, so every app must reach one.
      expect(first.trace.some((step) => step.type === 'workflow')).toBe(true);
    }
  );

  it('traces Pick of four as four takes, a pick, a choice, then an upscale of the pick', async () => {
    const pickThird = (spec: RemixAsk) => (spec.kind === 'pick' ? 2 : 'upscale');
    const { trace, outputs } = await dryRunRemixApp(pickOfFour, source, { answer: pickThird });

    expect(
      trace.map((step) => (step.type === 'workflow' ? step.request.kind : step.spec.kind))
    ).toEqual(['image', 'pick', 'choice', 'upscale']);
    const [takes, , , upscale] = trace;
    if (takes.type !== 'workflow' || upscale.type !== 'workflow') throw new Error('not workflows');
    expect(takes.result.images).toHaveLength(4);
    expect(upscale.request).toEqual({ kind: 'upscale', image: takes.result.images[2], scale: 2 });
    expect(outputs).toEqual(upscale.result.images);
  });
});

describe('remixOptionEffects', () => {
  it('names the workflow each option leads to, and null for one that finishes the run', async () => {
    const { trace } = await dryRunRemixApp(pickOfFour, source, {
      answer: (spec) => (spec.kind === 'pick' ? 1 : 'keep'),
    });
    const log = trace
      .slice(0, 2)
      .map((step) =>
        step.type === 'workflow'
          ? { type: 'workflow' as const, result: step.result }
          : { type: 'ask' as const, answer: step.answer }
      );
    const choice = trace[2];
    if (choice.type !== 'ask' || choice.spec.kind !== 'choice') throw new Error('not a choice');
    const picked = trace[0].type === 'workflow' ? trace[0].result.images[1] : undefined;

    expect(await remixOptionEffects(pickOfFour, source, log, choice.spec)).toEqual([
      {
        value: 'upscale',
        next: { type: 'workflow', request: { kind: 'upscale', image: picked, scale: 2 } },
      },
      { value: 'keep', next: null },
    ]);
  });
});
