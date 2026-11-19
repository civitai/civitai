import { describe, expect, it } from 'vitest';
import { defineRemixApp, type RemixCtx, type RemixImage } from '~/shared/remix-apps/define';
import {
  REMIX_RUN_LIMITS,
  RemixReplayError,
  replayRemixApp,
  type RemixLogEntry,
} from '~/shared/remix-apps/replay';
import { DEFAULT_ENGINE } from '~/shared/constants/remix-apps.constants';

/**
 * The host's checks on every replay. Each case runs the same app twice: once at the limit, which
 * replays (the positive control), and once past it, which is refused.
 */

const source = { imageId: 7, url: 'https://image.example/source.png', width: 1200, height: 800 };
const take = (n: number): RemixImage => ({ url: `https://blobs.example/take-${n}.png` });
const takes = (count: number): RemixLogEntry => ({
  type: 'workflow',
  result: { workflowId: 'wf', images: Array.from({ length: count }, (_, i) => take(i)) },
});

const appOf = (run: (ctx: RemixCtx) => Promise<RemixImage[]>) =>
  defineRemixApp({
    slug: 'probe',
    name: 'Probe',
    icon: 'sparkles',
    version: 1,
    engine: DEFAULT_ENGINE,
    run,
  });

/** Runs one workflow on the source, then hands its images to `then`. */
const afterTakes = (
  count: number,
  then: (ctx: RemixCtx, images: RemixImage[]) => Promise<unknown>
) =>
  appOf(async (ctx) => {
    const { images } = await ctx.workflow({
      kind: 'image',
      prompt: 'takes',
      images: [ctx.source],
      aspectRatio: 'source',
      quantity: count === 4 ? 4 : 1,
    });
    await then(ctx, images);
    return images;
  });

const refused = (promise: Promise<unknown>) =>
  expect(promise).rejects.toBeInstanceOf(RemixReplayError);

describe('replay checks', () => {
  it(`refuses a run past ${REMIX_RUN_LIMITS.effects} effects, asks included`, async () => {
    const asker = appOf(async (ctx) => {
      for (let i = 0; i < 20; i++) await ctx.ask({ kind: 'text', prompt: 'More?', maxLength: 10 });
      return [];
    });
    const answers = (n: number): RemixLogEntry[] =>
      Array.from({ length: n }, () => ({ type: 'ask', answer: 'yes' }));
    await expect(
      replayRemixApp(asker, source, answers(REMIX_RUN_LIMITS.effects - 1))
    ).resolves.toMatchObject({
      status: 'effect',
      index: REMIX_RUN_LIMITS.effects - 1,
    });
    await refused(replayRemixApp(asker, source, answers(REMIX_RUN_LIMITS.effects)));
  });

  it(`refuses a text ask longer than ${REMIX_RUN_LIMITS.textMaxLength}`, async () => {
    const ask = (maxLength: number) =>
      replayRemixApp(
        appOf(async (ctx) => {
          await ctx.ask({ kind: 'text', prompt: 'Say', maxLength });
          return [];
        }),
        source,
        []
      );
    await expect(ask(REMIX_RUN_LIMITS.textMaxLength)).resolves.toMatchObject({ status: 'effect' });
    await refused(ask(REMIX_RUN_LIMITS.textMaxLength + 1));
  });

  it(`refuses a choice of more than ${REMIX_RUN_LIMITS.choiceOptions} options`, async () => {
    const ask = (count: number) =>
      replayRemixApp(
        appOf(async (ctx) => {
          const options = Array.from({ length: count }, (_, i) => ({
            value: `o${i}`,
            label: `O${i}`,
          }));
          await ctx.ask({ kind: 'choice', prompt: 'Which?', options });
          return [];
        }),
        source,
        []
      );
    await expect(ask(REMIX_RUN_LIMITS.choiceOptions)).resolves.toMatchObject({ status: 'effect' });
    await refused(ask(REMIX_RUN_LIMITS.choiceOptions + 1));
  });

  it(`refuses a pick of more than ${REMIX_RUN_LIMITS.pickImages} images`, async () => {
    // Every image is the run's own, so only the count can refuse it.
    const pick = (count: number) =>
      replayRemixApp(
        afterTakes(1, (ctx) =>
          ctx.ask({
            kind: 'pick',
            prompt: 'Pick',
            images: [take(0), take(1), take(2), take(3), take(4)].slice(0, count),
          })
        ),
        source,
        [takes(5)]
      );
    await expect(pick(REMIX_RUN_LIMITS.pickImages)).resolves.toMatchObject({ status: 'effect' });
    await refused(pick(REMIX_RUN_LIMITS.pickImages + 1));
  });

  it('refuses an effect the schema does not know, such as an extra field sent on to the viewer', async () => {
    const ask = (extra: object) =>
      replayRemixApp(
        appOf(async (ctx) => {
          await ctx.ask({ kind: 'text', prompt: 'Say', maxLength: 10, ...extra });
          return [];
        }),
        source,
        []
      );
    await expect(ask({ optional: true })).resolves.toMatchObject({ status: 'effect' });
    await refused(ask({ html: '<img src=x>' }));
  });

  it('refuses an image that is neither the source nor an output of this run', async () => {
    const foreign = { url: 'https://elsewhere.example/a.png' };
    const edit = (image: RemixImage) =>
      replayRemixApp(
        afterTakes(1, (ctx) => ctx.workflow({ kind: 'upscale', image, scale: 2 })),
        source,
        [takes(1)]
      );
    await expect(edit(take(0))).resolves.toMatchObject({ status: 'effect', index: 1 });
    await expect(edit(source)).resolves.toMatchObject({ status: 'effect', index: 1 });
    await refused(edit(foreign));
  });

  it('refuses outputs this run did not make, the source included', async () => {
    const returning = (outputs: (images: RemixImage[]) => RemixImage[]) =>
      replayRemixApp(
        appOf(async (ctx) => {
          const { images } = await ctx.workflow({
            kind: 'image',
            prompt: 'one',
            images: [ctx.source],
            aspectRatio: 'source',
            quantity: 1,
          });
          return outputs(images);
        }),
        source,
        [takes(1)]
      );
    await expect(returning((images) => images)).resolves.toEqual({
      status: 'done',
      outputs: [take(0)],
    });
    await refused(returning(() => [source]));
  });

  it('stays refused when the app catches the refusal and goes on', async () => {
    const stubborn = appOf(async (ctx) => {
      try {
        await ctx.ask({
          kind: 'text',
          prompt: 'Say',
          maxLength: REMIX_RUN_LIMITS.textMaxLength + 1,
        });
      } catch {
        // swallowed: the replay must still refuse
      }
      return [];
    });
    await refused(replayRemixApp(stubborn, source, []));
  });

  it('stays suspended when the app catches the suspension and finishes', async () => {
    const stubborn = appOf(async (ctx) => {
      try {
        await ctx.workflow({ kind: 'upscale', image: ctx.source, scale: 2 });
      } catch {
        // swallowed: the replay must still stop here, never finish
      }
      return [];
    });
    await expect(replayRemixApp(stubborn, source, [])).resolves.toMatchObject({
      status: 'effect',
      index: 0,
    });
  });
});
