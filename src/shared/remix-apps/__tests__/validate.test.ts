import { describe, expect, it } from 'vitest';
import { compileRemixApp } from '~/shared/remix-apps/compile';
import { defineRemixApp, type RemixApp } from '~/shared/remix-apps/define';
import { replayRemixApp } from '~/shared/remix-apps/replay';
import { SEED_REMIX_APPS } from '~/shared/remix-apps/seed';
import { CODE_REMIX_APPS, pickOfFour } from '~/shared/remix-apps/system-apps';
import { DEFAULT_ENGINE } from '~/shared/constants/remix-apps.constants';
import { validateRemixApp } from '~/shared/remix-apps/validate';

/** The in-process replayer a system app uses; a user app's is the sandbox. */
const replayerOf =
  (app: RemixApp) =>
  (source: Parameters<typeof replayRemixApp>[1], log: Parameters<typeof replayRemixApp>[2]) =>
    replayRemixApp(app, source, log);

const app = (run: RemixApp['run']) =>
  defineRemixApp({
    slug: 'probe',
    name: 'Probe',
    icon: 'sparkles',
    version: 1,
    engine: DEFAULT_ENGINE,
    run,
  });

const image = (prompt: string, images: { url: string }[]) =>
  ({ kind: 'image', prompt, images, aspectRatio: 'source', quantity: 1 } as const);

describe('validateRemixApp', () => {
  it('walks Pick of four down both finishes, through its pick', async () => {
    const { graph, paths, issues } = await validateRemixApp(replayerOf(pickOfFour));

    expect(issues).toEqual([]);
    expect(paths).toBe(2);
    expect(graph).toMatchObject({
      type: 'workflow',
      request: { kind: 'image', quantity: 4 },
      next: {
        type: 'ask',
        spec: { kind: 'pick' },
        branches: [
          {
            answer: 0,
            next: {
              type: 'ask',
              spec: { kind: 'choice' },
              branches: [
                {
                  answer: 'upscale',
                  next: {
                    type: 'workflow',
                    request: { kind: 'upscale' },
                    next: { type: 'done', outputs: 1 },
                  },
                },
                { answer: 'keep', next: { type: 'done', outputs: 1 } },
              ],
            },
          },
        ],
      },
    });
  });

  // POSITIVE CONTROL for every issue below: each system app validates clean.
  it('finds nothing wrong with any seeded or code app', async () => {
    for (const seed of SEED_REMIX_APPS) {
      const runtime =
        'code' in seed.spec
          ? CODE_REMIX_APPS[seed.spec.code]
          : compileRemixApp({ slug: seed.slug, name: seed.name, version: 1 }, seed.spec);
      const { issues, paths } = await validateRemixApp(replayerOf(runtime));
      expect({ slug: seed.slug, issues }).toEqual({ slug: seed.slug, issues: [] });
      expect(paths).toBeGreaterThan(0);
    }
  });

  it('reports an app whose replays differ for the same answers', async () => {
    let calls = 0;
    const flaky = app(async (ctx) => {
      calls++;
      return (await ctx.workflow(image(calls % 2 ? 'odd' : 'even', [ctx.source]))).images;
    });
    const { issues } = await validateRemixApp(replayerOf(flaky));
    expect(issues.map((i) => i.kind)).toEqual(['nondeterministic']);
  });

  it('reports a step the host refuses, with the answers that reach it', async () => {
    const stranger = app(async (ctx) => {
      const style = await ctx.ask({
        kind: 'choice',
        prompt: 'Style?',
        options: [
          { value: 'ok', label: 'OK' },
          { value: 'bad', label: 'Bad' },
        ],
      });
      const from = style === 'bad' ? [{ url: 'https://elsewhere.example/x.png' }] : [ctx.source];
      return (await ctx.workflow(image(style, from))).images;
    });
    const { issues, paths } = await validateRemixApp(replayerOf(stranger));
    expect(paths).toBe(2);
    expect(issues).toEqual([
      { kind: 'refused', message: expect.stringContaining('neither the source'), answers: ['bad'] },
    ]);
  });

  it('reports an app that throws, and one that finishes without a workflow', async () => {
    const throws = app(async () => {
      throw new Error('boom');
    });
    expect((await validateRemixApp(replayerOf(throws))).issues).toEqual([
      { kind: 'error', message: 'boom', answers: [] },
    ]);
    const noWorkflow = app(async (ctx) => {
      await ctx.ask({ kind: 'text', prompt: 'Say?', maxLength: 10 });
      return [];
    });
    expect((await validateRemixApp(replayerOf(noWorkflow))).issues).toEqual([
      { kind: 'no-workflow', message: expect.any(String), answers: ['remix'] },
    ]);
  });

  it('stops at the path cap and says so', async () => {
    const options = Array.from({ length: 12 }, (_, i) => ({ value: `o${i}`, label: `O${i}` }));
    const wide = app(async (ctx) => {
      const a = await ctx.ask({ kind: 'choice', prompt: 'A?', options });
      const b = await ctx.ask({ kind: 'choice', prompt: 'B?', options });
      return (await ctx.workflow(image(a + b, [ctx.source]))).images;
    });
    const { paths, issues } = await validateRemixApp(replayerOf(wide), { maxPaths: 32 });
    expect(paths).toBe(32);
    expect(issues.map((i) => i.kind)).toEqual(['too-many-paths']);
  });

  it('stops a path past the step limit, whatever the replayer allows', async () => {
    let calls = 0;
    // Bounded, so a missing cap fails as a wrong issue instead of a hang.
    const endless = async () => {
      if (++calls > 200) throw new Error('runaway');
      return {
        status: 'effect',
        index: 0,
        effect: { type: 'ask', spec: { kind: 'text', prompt: 'More?', maxLength: 5 } },
      } as const;
    };
    const { issues, paths } = await validateRemixApp(endless as never);
    expect(paths).toBe(1);
    expect(issues).toEqual([
      { kind: 'refused', message: expect.stringContaining('steps'), answers: expect.any(Array) },
    ]);
  });
});
