import { describe, expect, it, vi } from 'vitest';
import { createAppTools } from '~/components/Apps/AppAssistant/appTools';
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

function tool(apps: Sandbox[] | undefined, open: (app: string) => Promise<unknown>) {
  return createAppTools({ apps: () => apps, open: open as never }).create_app;
}

const run = (t: ReturnType<typeof tool>, name: unknown) =>
  Promise.resolve(t.execute({ name }, ctx));

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

  it('refuses while the user’s apps have not loaded, opening nothing', async () => {
    const open = vi.fn();
    await expect(run(tool(undefined, open), 'Anything')).rejects.toThrow(/have not loaded yet/);
    expect(open).not.toHaveBeenCalled();
  });

  it.each([
    [
      'the kept-apps limit',
      'sandbox limit (3) reached; delete one first',
      /keeps the most apps they may.*delete one under Your apps/,
    ],
    [
      'the running limit',
      'running-sandbox limit (1) reached: sbx-a (app "alpha") is running; suspend it first',
      /still running.*pause it under Your apps/,
    ],
  ])('turns %s into what the user can do about it', async (_label, message, said) => {
    const open = vi.fn(async () => {
      throw new SandboxApiError(message, 409, 'limit');
    });
    await expect(run(tool([], open), 'Fourth')).rejects.toThrow(said);
  });

  it('passes any other failure on as it is', async () => {
    const outage = new SandboxApiError('Sandbox service error (503)', 503, 'unavailable');
    const open = vi.fn(async () => {
      throw outage;
    });
    await expect(run(tool([], open), 'Fourth')).rejects.toBe(outage);
  });

  it('names an app from no usable name rather than refusing', async () => {
    const open = vi.fn(async (app: string) => ({ sandbox: sandbox(app), created: true }));
    await run(tool([], open), undefined);
    expect(open).toHaveBeenCalledWith('my-app');
  });
});
