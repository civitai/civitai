import { describe, expect, it, vi } from 'vitest';
import { newAppKey } from '~/components/Apps/AppAssistant/appKey';
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

function appTools(
  apps: Sandbox[] | undefined,
  open: (app: string) => Promise<unknown>,
  current: Sandbox | null = null
) {
  return createAppTools({ apps: () => apps, current: () => current, open: open as never });
}

function tool(
  apps: Sandbox[] | undefined,
  open: (app: string) => Promise<unknown>,
  current: Sandbox | null = null
) {
  return appTools(apps, open, current).tools.create_app;
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
      note: expect.stringMatching(
        /^The app quiz-game-2 is starting.*tap Build it.*then call set_checklist/
      ),
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

  /**
   * The page as create_app sees it: opening an app lists it and makes it the open one. The service
   * creates each app (at a new time) unless `found` already holds one under that key.
   */
  function page(list: Sandbox[], open: Sandbox | null = null, found: Record<string, Sandbox> = {}) {
    const state = { list: [...list], open };
    let clock = 0;
    const service = vi.fn(async (app: string) => {
      const existing = found[app];
      const sandbox_ = existing ?? { ...sandbox(app, 'starting'), createdAt: `t${++clock}` };
      state.list = [...state.list.filter((s) => s.app !== app), sandbox_];
      state.open = sandbox_;
      return { sandbox: sandbox_, created: !existing };
    });
    const tools = createAppTools({
      apps: () => state.list,
      current: () => state.open,
      open: service as never,
    });
    return { state, service, tools, create: (name: string) => run(tools.tools.create_app, name) };
  }

  it('does not take an app the service found (the user’s own) for one it made', async () => {
    const theirs = { ...sandbox('game-2', 'running'), createdAt: 'elsewhere' };
    const p = page([sandbox('game', 'suspended')], null, { 'game-2': theirs });
    expect(await p.create('Game')).toMatchObject({ app: 'game-2', existed: true });
    // "No, make me a new one."
    await p.create('Game');
    expect(p.service.mock.calls).toEqual([['game-2'], ['game-3']]);
  });

  it('does not take a different app later made under the same key for the one it made', async () => {
    const p = page([sandbox('game', 'suspended')]);
    await p.create('Game');
    const made = p.state.open!;
    expect(made.app).toBe('game-2');
    // Deleted elsewhere and made again: same key, a new creation.
    const other = { ...made, createdAt: 'later' };
    p.state.list = p.state.list.map((s) => (s.name === made.name ? other : s));
    p.state.open = other;
    await p.create('Game');
    expect(p.service.mock.calls).toEqual([['game-2'], ['game-3']]);
  });

  it('keeps the new app it made when resuming one that had expired, so a third ask reuses it', async () => {
    const p = page([sandbox('game', 'suspended')]);
    await p.create('Game');
    const made = p.state.open!;
    expect(made.app).toBe('game-2');
    // Paused, then deleted by idle expiry while the list still shows it.
    const paused = { ...made, state: 'suspended' as const };
    p.state.list = p.state.list.map((s) => (s.name === made.name ? paused : s));
    p.state.open = paused;
    const expired = {
      ...sandbox('game-2', 'starting'),
      name: 'sbx-game-2-new',
      createdAt: 'later',
    };
    p.service.mockImplementationOnce(async () => {
      p.state.list = [...p.state.list.filter((s) => s.app !== 'game-2'), expired];
      p.state.open = expired;
      return { sandbox: expired, created: true };
    });
    expect(await p.create('Game')).toMatchObject({ app: 'game-2', state: 'starting' });
    await p.create('Game');
    expect(p.service.mock.calls).toEqual([['game-2'], ['game-2']]);
  });

  it('forgets an app the page deleted', async () => {
    const p = page([sandbox('game', 'suspended')]);
    await p.create('Game');
    const made = p.state.open!;
    p.tools.forget(made.name);
    await p.create('Game');
    expect(p.service.mock.calls).toEqual([['game-2'], ['game-3']]);
  });

  it('forgets an app that leaves the list', async () => {
    const p = page([sandbox('game', 'suspended')]);
    await p.create('Game');
    const made = p.state.open!;
    p.state.list = p.state.list.filter((s) => s.name !== made.name);
    p.state.open = null;
    await p.create('Quiz');
    // Back in the list (listed late, or another tab), and opened from there.
    p.state.list = [...p.state.list, made];
    p.state.open = made;
    await p.create('Game');
    expect(p.service.mock.calls).toEqual([['game-2'], ['quiz'], ['game-3']]);
  });

  it('keeps a copy it made when asked again, even after the original is deleted', async () => {
    const p = page([sandbox('tip-calculator', 'suspended')]);
    await p.create('Tip calculator');
    expect(p.state.open?.app).toBe('tip-calculator-2');
    p.state.list = p.state.list.filter((s) => s.app !== 'tip-calculator');
    const again = await p.create('Tip calculator');
    expect(p.service.mock.calls).toEqual([['tip-calculator-2']]);
    expect(again).toMatchObject({ app: 'tip-calculator-2', existed: true });
  });

  it('keeps a long-named copy it made, whose name was cut short to fit its number', async () => {
    const name = 'A really quite long name for a small budgeting app';
    const p = page([sandbox(newAppKey(name, []), 'suspended')]);
    await p.create(name);
    expect(p.state.open?.app).toBe('a-really-quite-long-name-for-a-small-b-2');
    await p.create(name);
    expect(p.service).toHaveBeenCalledTimes(1);
  });

  it('keeps an app opened from the list when asked for its exact name', async () => {
    const opened = sandbox('tip-calculator', 'running');
    const p = page([opened], opened);
    const result = await p.create('Tip calculator');
    expect(p.service).not.toHaveBeenCalled();
    expect(result).toMatchObject({ app: 'tip-calculator', existed: true });
  });

  it.each([
    ['room-101', 'Room', 'room'],
    ['game-2048', 'Game', 'game'],
    ['area-51', 'Area', 'area'],
    // Opened from the list, a numbered app is not known to be a copy of anything.
    ['game-2', 'Game', 'game'],
  ])(
    'makes a new app for a shorter name while %j, opened from the list, is open',
    async (openKey, name, made) => {
      const opened = sandbox(openKey, 'running');
      const p = page([opened], opened);
      await p.create(name);
      expect(p.service.mock.calls).toEqual([[made]]);
    }
  );

  it('tells the assistant a paused app it resumed was in fact gone, and is new and empty', async () => {
    const open = vi.fn(async (app: string) => ({
      sandbox: sandbox(app, 'starting'),
      created: true,
    }));
    const paused = sandbox('tip-calculator', 'suspended');
    const result = await run(tool([paused], open, paused), 'Tip calculator');
    expect(open.mock.calls).toEqual([['tip-calculator']]);
    expect(result).toEqual({
      app: 'tip-calculator',
      state: 'starting',
      note: expect.stringMatching(/had been deleted .* a new, empty app/),
    });
  });

  it('resumes the open app when it is paused, instead of saying it is ready', async () => {
    const open = vi.fn(async (app: string) => ({
      sandbox: sandbox(app, 'starting'),
      created: false,
    }));
    const paused = sandbox('tip-calculator', 'suspended');
    const result = await run(tool([paused], open, paused), 'Tip calculator');
    expect(open.mock.calls).toEqual([['tip-calculator']]);
    expect(result).toMatchObject({
      app: 'tip-calculator',
      state: 'starting',
      existed: true,
      note: expect.stringMatching(/was paused and is starting again/),
    });
  });

  it.each([
    ['tip-calculator', 'Quiz game', 'quiz-game'],
    ['tip-calculator-2', 'Quiz game', 'quiz-game'],
    ['game', 'Game 2', 'game-2'],
  ])('still starts a different app while %j is open: %j', async (openKey, name, made) => {
    const open = vi.fn(async (app: string) => ({ sandbox: sandbox(app), created: true }));
    const openApp = sandbox(openKey, 'running');
    await run(tool([openApp], open, openApp), name);
    expect(open).toHaveBeenCalledWith(made);
  });

  it('names an app from no usable name rather than refusing', async () => {
    const open = vi.fn(async (app: string) => ({ sandbox: sandbox(app), created: true }));
    await run(tool([], open), undefined);
    expect(open).toHaveBeenCalledWith('my-app');
  });
});

describe('create_app after a limit, in the same reply', () => {
  const keepLimit = () =>
    new SandboxApiError('sandbox limit (3) reached; delete one first', 409, 'limit');

  it('is refused with the same words until the next reply', async () => {
    const open = vi.fn(async () => {
      throw keepLimit();
    });
    const tools = appTools([], open);
    expect(tools.refusal('create_app')).toBeNull();
    const said = await failureOf(run(tools.tools.create_app, 'Fourth'));
    expect(tools.refusal('create_app')).toBe(said);
    expect(tools.refusal('set_checklist')).toBeNull();
    tools.newReply();
    expect(tools.refusal('create_app')).toBeNull();
  });

  it('is not refused after a failure a retry could clear', async () => {
    const open = vi.fn(async () => {
      throw new SandboxApiError('Sandbox service error (503)', 503, 'unavailable');
    });
    const tools = appTools([], open);
    await failureOf(run(tools.tools.create_app, 'Fourth'));
    expect(tools.refusal('create_app')).toBeNull();
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
      'You already have as many apps as you can keep. Choose one to delete in the card under the chat; your request then continues automatically.',
    ],
    [
      'the running limit',
      new SandboxApiError(
        'running-sandbox limit (1) reached: sbx-0123456789ab (app "alpha") is running; suspend it first',
        409,
        'limit'
      ),
      'Another of your apps started at the same moment, so this one could not. Ask again: starting this app pauses the others.',
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
