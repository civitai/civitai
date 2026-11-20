import { describe, expect, it } from 'vitest';
import { fakeRemixRunner } from '~/__tests__/mocks/remix-runner.fake';
import {
  callRemixRunner,
  remixRunnerOutcome,
  userRemixReplayer,
} from '~/server/services/remix-app-runner';
import type { RemixApp } from '~/shared/remix-apps/define';
import { RemixReplayError, type RemixLogEntry } from '~/shared/remix-apps/replay';
import { createHash } from 'crypto';

const SECRET = 's'.repeat(32);
const config = { url: 'http://runner', secret: SECRET };
const SOURCE = 'export default defineRemixApp({ async run(ctx) { return []; } });';
const SHA = createHash('sha256').update(SOURCE).digest('hex');
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
      remixRunnerOutcome('u7-probe', image, [made(1)], result, { autoAnswers: true })
    ).toMatchObject({
      answered: ['ink'],
      outcome: { status: 'effect', index: 2, effect: { request: { prompt: 'in ink' } } },
    });
    expect(() => remixRunnerOutcome('u7-probe', image, [made(1)], result)).toThrow(
      RemixReplayError
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
