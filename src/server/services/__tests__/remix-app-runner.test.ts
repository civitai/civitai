import { describe, expect, it } from 'vitest';
import { fakeRemixRunner } from '~/__tests__/mocks/remix-runner.fake';
import {
  callRemixRunner,
  remixRunnerOutcome,
  REMIX_ANSWER_PLACEHOLDER,
  userRemixAuthorPrompt,
  userRemixBranchReplayer,
  userRemixReplayer,
} from '~/server/services/remix-app-runner';
import { validateRemixApp } from '~/shared/remix-apps/validate';
import type { RemixApp } from '~/shared/remix-apps/define';
import { RemixReplayError, type RemixLogEntry } from '~/shared/remix-apps/replay';
import { createHash } from 'crypto';
import { firstAnswer } from '~/shared/remix-apps/mock-host';

const SECRET = 's'.repeat(32);
const config = { url: 'http://runner', secret: SECRET };
const image = { imageId: 7, url: 'https://img/source.jpeg', width: 512, height: 512 };

/** Generates, asks a style, generates again from the first result, returns the last. */
const app: Pick<RemixApp, 'run'> = {
  async run(ctx) {
    const first = await ctx.workflow({
      kind: 'image',
      prompt: 'a portrait',
      images: [ctx.source],
      aspectRatio: 'source',
      quantity: 1,
    });
    const style = await ctx.ask({
      kind: 'choice',
      prompt: 'Style?',
      options: [
        { value: 'ink', label: 'Ink' },
        { value: 'oil', label: 'Oil' },
      ],
    });
    const second = await ctx.workflow({
      kind: 'image',
      prompt: `in ${style}`,
      images: [first.images[0]],
      aspectRatio: 'source',
      quantity: 1,
    });
    return second.images;
  },
};

// The fake runner runs `app` itself; the source the host reads its fixed text from is its code.
const SOURCE = `export default defineRemixApp({ ${app.run.toString()} });`;
const SHA = createHash('sha256').update(SOURCE).digest('hex');

const made = (n: number): RemixLogEntry => ({
  type: 'workflow',
  result: { workflowId: `wf-${n}`, images: [{ url: `https://img/out-${n}.jpeg` }] },
});

const replayerOn = (runner: ReturnType<typeof fakeRemixRunner>) =>
  userRemixReplayer('u7-probe', 'remix-u7-probe', async () => SOURCE, {
    config,
    fetchImpl: runner.fetchImpl,
  });

const REFUSALS: Record<string, string> = {
  'a workflow naming an image the run did not make': 'neither the source nor from this run',
  'outputs the run did not make': 'returned an image this run did not make',
  'a step it answered itself': 'answered a step itself',
  'a step past the one with no result': 'went on past step 0',
  'nothing at all': 'stopped without asking',
};

describe('a user app replayed on the runner', () => {
  it('advances step by step over its log and finishes with outputs it made', async () => {
    const replay = replayerOn(fakeRemixRunner({ secret: SECRET, apps: { [SHA]: app } }));
    expect(await replay(image, [])).toMatchObject({ status: 'effect', index: 0 });
    expect(await replay(image, [made(1)])).toMatchObject({
      status: 'effect',
      index: 1,
      effect: { type: 'ask', spec: { kind: 'choice' } },
    });
    expect(await replay(image, [made(1), { type: 'ask', answer: 'oil' }])).toMatchObject({
      status: 'effect',
      index: 2,
      effect: { type: 'workflow', request: { prompt: 'in oil' } },
    });
    expect(await replay(image, [made(1), { type: 'ask', answer: 'oil' }, made(2)])).toEqual({
      status: 'done',
      outputs: [{ url: 'https://img/out-2.jpeg' }],
    });
  });

  it.each([
    [
      'a workflow naming an image the run did not make',
      [
        {
          type: 'workflow',
          request: { kind: 'upscale', image: { url: 'https://elsewhere/x.jpeg' }, scale: 2 },
        },
      ],
      undefined,
    ],
    ['outputs the run did not make', [], { outputs: [{ url: 'https://elsewhere/x.jpeg' }] }],
    [
      'a step it answered itself',
      [{ type: 'ask', spec: { kind: 'text', prompt: 'p', maxLength: 5 }, answer: 'hi' }],
      undefined,
    ],
    [
      'a step past the one with no result',
      [
        { type: 'ask', spec: { kind: 'text', prompt: 'p', maxLength: 5 } },
        { type: 'ask', spec: { kind: 'text', prompt: 'q', maxLength: 5 } },
      ],
      undefined,
    ],
    ['nothing at all', [], undefined],
  ])('refuses a runner that claims %s', async (claim, effects, done) => {
    const replay = replayerOn(
      fakeRemixRunner({
        secret: SECRET,
        apps: {},
        answer: () => [{ effects, ...(done ? { done } : {}) }],
      })
    );
    const error = await replay(image, []).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RemixReplayError);
    expect((error as Error).message).toContain(REFUSALS[claim]);
  });

  it("is the app's fault, not the host's, when the app throws or times out", async () => {
    const replay = replayerOn(
      fakeRemixRunner({
        secret: SECRET,
        apps: {},
        answer: () => [{ cause: 'timeout', detail: 'x' }],
      })
    );
    await expect(replay(image, [])).rejects.toThrow(
      new RemixReplayError('u7-probe stopped: timeout')
    );
  });

  it('checks and records answers the runner filled in, only when asked to', async () => {
    const runner = fakeRemixRunner({ secret: SECRET, apps: { [SHA]: app } });
    const [result] = await callRemixRunner(
      { appId: 'remix-u7-probe', source: SOURCE, image, base: [made(1)], autoAnswer: true },
      { config, fetchImpl: runner.fetchImpl }
    );
    expect(
      remixRunnerOutcome('u7-probe', image, [made(1)], result, { autoAnswer: firstAnswer })
    ).toMatchObject({
      answered: ['ink'],
      outcome: { status: 'effect', index: 2, effect: { request: { prompt: 'in ink' } } },
    });
    expect(() => remixRunnerOutcome('u7-probe', image, [made(1)], result)).toThrow(
      RemixReplayError
    );
  });

  it('refuses an answer the runner gave that the host would not', async () => {
    const runner = fakeRemixRunner({ secret: SECRET, apps: { [SHA]: app } });
    const [result] = await callRemixRunner(
      { appId: 'remix-u7-probe', source: SOURCE, image, base: [made(1)], autoAnswer: true },
      { config, fetchImpl: runner.fetchImpl }
    );
    const oil = {
      ...result,
      effects: (result as { effects: object[] }).effects.map((e) =>
        'answer' in e ? { ...e, answer: 'oil' } : e
      ),
    };
    expect(() =>
      remixRunnerOutcome('u7-probe', image, [made(1)], oil, { autoAnswer: firstAnswer })
    ).toThrow('with an answer the host would not');
  });

  it('refuses an ask whose text is not fixed in the reviewed code', async () => {
    const computed: Pick<RemixApp, 'run'> = {
      async run(ctx) {
        const style = await ctx.ask({
          kind: 'choice',
          prompt: 'Style?',
          options: [{ value: 'ink', label: ['In', 'k'].join('') }],
        });
        return [style as never];
      },
    };
    const source = `export default defineRemixApp({ ${computed.run.toString()} });`;
    const runner = fakeRemixRunner({
      secret: SECRET,
      apps: { [createHash('sha256').update(source).digest('hex')]: computed },
    });
    const replay = userRemixReplayer('u7-probe', 'remix-u7-probe', async () => source, {
      config,
      fetchImpl: runner.fetchImpl,
    });
    await expect(replay(image, [])).rejects.toThrow(
      'asked with text that is not fixed in its code'
    );
  });

  it.each([
    ['a response signed with another key', { secret: 't'.repeat(32), apps: { [SHA]: app } }],
    ['one result short', { secret: SECRET, apps: {}, answer: () => [] }],
  ])('is unavailable on %s', async (_, fake) => {
    const replay = replayerOn(fakeRemixRunner(fake));
    await expect(replay(image, [])).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });

  it('sends the source, its hash and the log as the contract says', async () => {
    const runner = fakeRemixRunner({ secret: SECRET, apps: { [SHA]: app } });
    await replayerOn(runner)(image, [made(1)]);
    expect(runner.calls[0]).toEqual({
      ts: expect.any(Number),
      appId: 'remix-u7-probe',
      sha256: SHA,
      source: SOURCE,
      input: { source: image, base: [made(1)] },
    });
  });
});

describe("a mod's dry run on the runner", () => {
  const dryRun = (runner: ReturnType<typeof fakeRemixRunner>, source = SOURCE) =>
    validateRemixApp({
      branches: userRemixBranchReplayer('u7-probe', 'remix-u7-probe', async () => source, {
        config,
        fetchImpl: runner.fetchImpl,
      }),
    });

  it('walks every option, branches in one call, to the graph a one-by-one replay draws', async () => {
    const runner = fakeRemixRunner({ secret: SECRET, apps: { [SHA]: app } });
    const { graph, paths, issues } = await dryRun(runner);
    expect(issues).toEqual([]);
    expect(paths).toBe(2);
    expect(graph).toMatchObject({
      type: 'workflow',
      request: { prompt: 'a portrait' },
      next: {
        type: 'ask',
        branches: [
          { answer: 'ink', next: { type: 'workflow', request: { prompt: 'in ink' } } },
          { answer: 'oil', next: { type: 'workflow', request: { prompt: 'in oil' } } },
        ],
      },
    });
    const branched = runner.calls.length;
    const oneByOne = fakeRemixRunner({ secret: SECRET, apps: { [SHA]: app } });
    const replayed = await validateRemixApp(replayerOn(oneByOne));
    expect(replayed.graph).toEqual(graph);
    expect(branched).toBeLessThan(oneByOne.calls.length);
  });

  it('reports an app that replays differently, and an ask not fixed in the reviewed code', async () => {
    const random: Pick<RemixApp, 'run'> = {
      async run(ctx) {
        const out = await ctx.workflow({
          kind: 'image',
          prompt: `a portrait ${Math.random()}`,
          images: [ctx.source],
          aspectRatio: 'source',
          quantity: 1,
        });
        return out.images;
      },
    };
    const randomSource = 'export default defineRemixApp({ run: random });';
    const runner = fakeRemixRunner({
      secret: SECRET,
      apps: { [createHash('sha256').update(randomSource).digest('hex')]: random },
    });
    expect((await dryRun(runner, randomSource)).issues).toEqual([
      expect.objectContaining({ kind: 'nondeterministic' }),
    ]);
    // The choice's prompt and labels are not in this source: the ask is refused on every path.
    const unfixed = 'export default defineRemixApp({ run });';
    const asks = fakeRemixRunner({
      secret: SECRET,
      apps: { [createHash('sha256').update(unfixed).digest('hex')]: app },
    });
    expect((await dryRun(asks, unfixed)).issues).toEqual([
      expect.objectContaining({ kind: 'refused', message: expect.stringContaining('asked with') }),
    ]);
  });
});

describe("condition D: the author's part of a prompt", () => {
  const shouty: Pick<RemixApp, 'run'> = {
    async run(ctx) {
      const who = await ctx.ask({ kind: 'text', prompt: 'Who?', maxLength: 40 });
      const style = await ctx.ask({
        kind: 'choice',
        prompt: 'Style?',
        options: [{ value: 'ink', label: 'Ink' }],
      });
      // An app may transform the viewer's words; cutting them out of the prompt would miss this.
      const out = await ctx.workflow({
        kind: 'image',
        prompt: `a portrait of ${String(who).toUpperCase()} in ${style}`,
        images: [ctx.source],
        aspectRatio: 'source',
        quantity: 1,
      });
      return out.images;
    },
  };
  const source = `export default defineRemixApp({ ${shouty.run.toString()} });`;
  const authorPrompt = (app = shouty) =>
    userRemixAuthorPrompt('u7-probe', 'remix-u7-probe', async () => source, {
      config,
      fetchImpl: fakeRemixRunner({
        secret: SECRET,
        apps: { [createHash('sha256').update(source).digest('hex')]: app },
      }).fetchImpl,
    });
  const log: RemixLogEntry[] = [
    { type: 'ask', answer: 'bob' },
    { type: 'ask', answer: 'ink' },
  ];

  it("assembles it with a placeholder for the viewer's words, keeping the author's choices", async () => {
    expect(await authorPrompt()(image, log)).toEqual({
      prompt: `a portrait of ${REMIX_ANSWER_PLACEHOLDER} in ink`,
      answers: ['bob'],
    });
  });

  it('is null when the app, run on the placeholder, goes another way', async () => {
    const picky: Pick<RemixApp, 'run'> = {
      async run(ctx) {
        const who = await ctx.ask({ kind: 'text', prompt: 'Who?', maxLength: 40 });
        if (who !== 'bob') return [];
        return (
          await ctx.workflow({
            kind: 'image',
            prompt: 'p',
            images: [ctx.source],
            aspectRatio: 'source',
            quantity: 1,
          })
        ).images;
      },
    };
    expect(await authorPrompt(picky)(image, [{ type: 'ask', answer: 'bob' }])).toBeNull();
  });
});
