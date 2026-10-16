import { describe, expect, it, vi } from 'vitest';
import { NO_APP_REFUSAL, createAppTools } from '~/components/Apps/AppAssistant/appTools';
import type { Sandbox } from '~/components/Apps/AppAssistant/sandboxClient';
import { SandboxApiError } from '~/components/Apps/AppAssistant/sandboxClient';

const ctx = { signal: new AbortController().signal, conversationId: 'c', files: [] };

const sandbox = (app: string, state: Sandbox['state'] = 'starting'): Sandbox => ({
  name: `sbx-${app}`,
  app,
  state,
  mcpUrl: `https://sandbox.example/s/${app}/mcp`,
  createdAt: null,
  lastActivityAt: null,
  expiresAt: null,
});

function tool(
  apps: Sandbox[] | undefined,
  open: (app: string) => Promise<unknown>,
  current: Sandbox | null = null
) {
  return createAppTools({ apps: () => apps, current: () => current, open: open as never })
    .create_app;
}

const run = (t: ReturnType<typeof tool>, name: unknown) =>
  Promise.resolve(t.execute({ name }, ctx));

/**
 * The chat shows the user every thrown error and refusal ("<activity> didn't work" and the text), so
 * none may carry an id, the service's wording, a tool name or the word sandbox.
 */
function expectReadableByTheUser(text: string, serviceMessage = '') {
  expect(text).not.toMatch(/sbx-|sandbox|create_app|set_checklist|__/i);
  if (serviceMessage) expect(text).not.toContain(serviceMessage);
  expect(text.length).toBeGreaterThan(20);
}

async function failureOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected a failure');
}

describe('create_app', () => {
  it('opens a new app under a key made from the name and unused among the user’s apps', async () => {
    const open = vi.fn(async (app: string) => ({ sandbox: sandbox(app), created: true }));
    const result = await run(tool([sandbox('quiz-game', 'suspended')], open), 'Quiz Game');
    expect(open).toHaveBeenCalledWith('quiz-game-2');
    expect(result).toEqual({
      app: 'quiz-game-2',
      state: 'starting',
      note: expect.stringMatching(/^The app quiz-game-2 is starting.*call set_checklist now/),
    });
    // A result with no `error` is not shown to the user, so only this one may name tools.
    expect(result).not.toHaveProperty('error');
  });

  it('tells the assistant to ask first when the service had the app already', async () => {
    const open = vi.fn(async (app: string) => ({
      sandbox: sandbox(app, 'running'),
      created: false,
    }));
    const result = await run(tool([], open), 'Tip calculator');
    expect(result).toEqual({
      app: 'tip-calculator',
      state: 'running',
      existed: true,
      note: expect.stringMatching(/already had an app called tip-calculator.*do not build over it/),
    });
  });

  it('creates one app when the assistant asks twice in one step', async () => {
    let finish!: () => void;
    const open = vi.fn(
      (app: string) =>
        new Promise((resolve) => (finish = () => resolve({ sandbox: sandbox(app), created: true })))
    );
    const t = tool([], open);
    const first = run(t, 'Tip calculator');
    const second = run(t, 'Tip calculator');
    finish();
    const results = await Promise.all([first, second]);
    expect(open.mock.calls).toEqual([['tip-calculator']]);
    expect(results[1]).toEqual(results[0]);

    // Once it has settled, a later call is a call of its own.
    const later = run(t, 'Quiz');
    finish();
    await later;
    expect(open.mock.calls).toEqual([['tip-calculator'], ['quiz']]);
  });

  it('lets a later create run after one that failed', async () => {
    const open = vi
      .fn()
      .mockRejectedValueOnce(new SandboxApiError('down', 503, 'unavailable'))
      .mockResolvedValueOnce({ sandbox: sandbox('quiz'), created: true });
    const t = tool([], open);
    await expect(run(t, 'Quiz')).rejects.toThrow();
    await expect(run(t, 'Quiz')).resolves.toMatchObject({ app: 'quiz' });
  });

  it('keeps building the open app when asked again for it, instead of making a copy', async () => {
    const open = vi.fn();
    const openApp = sandbox('tip-calculator', 'running');
    const result = await run(tool([openApp], open, openApp), 'Tip Calculator');
    expect(open).not.toHaveBeenCalled();
    expect(result).toMatchObject({ app: 'tip-calculator', existed: true });
  });

  it('still starts a different app while one is open', async () => {
    const open = vi.fn(async (app: string) => ({ sandbox: sandbox(app), created: true }));
    const openApp = sandbox('tip-calculator', 'running');
    await run(tool([openApp], open, openApp), 'Quiz game');
    expect(open).toHaveBeenCalledWith('quiz-game');
  });

  it('names an app from no usable name rather than refusing', async () => {
    const open = vi.fn(async (app: string) => ({ sandbox: sandbox(app), created: true }));
    await run(tool([], open), undefined);
    expect(open).toHaveBeenCalledWith('my-app');
  });
});

describe('what the user can read when create_app fails', () => {
  it('while the apps are loading, opening nothing', async () => {
    const open = vi.fn();
    const text = await failureOf(run(tool(undefined, open), 'Anything'));
    expect(text).toBe('Your apps are still loading. Try again in a moment.');
    expectReadableByTheUser(text);
    expect(open).not.toHaveBeenCalled();
  });

  it.each([
    [
      'the kept-apps limit',
      new SandboxApiError('sandbox limit (3) reached; delete one first', 409, 'limit'),
      'You already have as many apps as you can keep. Delete one under Your apps at the top of the page, then ask again.',
    ],
    [
      'the running limit',
      new SandboxApiError(
        'running-sandbox limit (1) reached: sbx-0123456789ab (app "alpha") is running; suspend it first',
        409,
        'limit'
      ),
      'Another of your apps is still running. Pause it under Your apps at the top of the page, then ask again.',
    ],
    [
      'a concurrent change',
      new SandboxApiError('the sandbox changed concurrently; retry', 409, 'conflict'),
      'Your apps were changing at the same moment. Try again.',
    ],
    [
      'an outage',
      new SandboxApiError('Sandbox service error (503)', 503, 'unavailable'),
      'Your apps could not be reached right now. Try again in a moment.',
    ],
    [
      'any other error',
      new Error('fetch failed: sbx-0123456789ab'),
      'Your apps could not be reached right now. Try again in a moment.',
    ],
  ])('on %s, in plain words', async (_label, error, said) => {
    const open = vi.fn(async () => {
      throw error;
    });
    const text = await failureOf(run(tool([], open), 'Fourth'));
    expect(text).toBe(said);
    expectReadableByTheUser(text, error.message);
  });

  it('when features are planned before there is an app', () => {
    expectReadableByTheUser(NO_APP_REFUSAL);
  });
});
