import {
  APP_ACTIVITY,
  APP_ACTIVITY_NOT_FOUND,
  APP_ACTIVITY_UNAVAILABLE,
  type AppActivity,
  type AppActivitySource,
} from '@civitai/app-assistant';
import type { ToolSet } from 'ai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { APP_ACTIVITY_PATH, CivitaiAppActivity } from '../app-assistant/app-activity';
import { FEEDBACK_GRANT_GONE } from '../app-assistant/app-feedback';
import { AppAssistantTools } from '../app-assistant/provider';
import type { OpenTools } from '../core/interfaces';
import { chosenApp } from '../test-support/chosen-app';
import { FakeSandboxService } from '../test-support/fake-sandbox';

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
// TEST-ONLY placeholders: never a real credential.
const SECRET = 'test-only-runner-secret-activity-0123';
const GRANT = 'test-only-grant-activity';

const ACTIVITY: AppActivity = {
  app: 'my-app',
  summary: '1 generation: 1 succeeded (last 3 min ago); 0 failed; 0 in progress; 1 error',
  items: [
    {
      kind: 'error',
      at: '2026-10-30T11:59:00.000Z',
      source: 'unhandledrejection',
      fatal: false,
      message: 'boom',
      stack: null,
    },
  ],
  omitted: 0,
  unavailable: [],
};

describe('CivitaiAppActivity', () => {
  function client(answer: (url: string, init: RequestInit) => Response | Promise<Response>) {
    const sent: { url: string; init: RequestInit }[] = [];
    const activity = new CivitaiAppActivity({
      civitaiUrl: 'https://civitai.example/',
      secret: SECRET,
      log: quiet,
      fetch: async (input, init) => {
        sent.push({ url: String(input), init: init! });
        return answer(String(input), init!);
      },
    });
    return { sent, activity };
  }

  it('posts the read with the runner’s secret and the run’s grant, read per call', async () => {
    let grants = 0;
    const { sent, activity } = client(() => Response.json(ACTIVITY));
    const source = activity.forRun(async () => {
      grants++;
      return GRANT;
    });
    expect(await source.read('my-app')).toEqual(ACTIVITY);
    await source.read('my-app');
    expect(grants).toBe(2);
    expect(sent.map((s) => s.url)).toEqual([
      `https://civitai.example/${APP_ACTIVITY_PATH}`,
      `https://civitai.example/${APP_ACTIVITY_PATH}`,
    ]);
    expect(APP_ACTIVITY_PATH).toBe('api/internal/app-assistant/app-activity');
    expect(new Headers(sent[0]!.init.headers).get('authorization')).toBe(`Bearer ${SECRET}`);
    expect(JSON.parse(String(sent[0]!.init.body))).toEqual({ grant: GRANT, app: 'my-app' });
  });

  it('reads civitai’s NOT_FOUND as not the user’s app, and any other 404 as unavailable', async () => {
    const notFound = client(() =>
      Response.json({ error: 'x', code: 'NOT_FOUND' }, { status: 404 })
    );
    expect(await notFound.activity.forRun(async () => GRANT).read('their-app')).toBeNull();
    const noRoute = client(() => new Response('<html>404</html>', { status: 404 }));
    await expect(noRoute.activity.forRun(async () => GRANT).read('my-app')).rejects.toThrow(
      APP_ACTIVITY_UNAVAILABLE
    );
  });

  it('says why civitai refused the user, never calls without a grant, and refuses an odd answer', async () => {
    const refused = client(() =>
      Response.json(
        { error: 'You do not have access to Apps authoring', code: 'FORBIDDEN' },
        { status: 403 }
      )
    );
    await expect(refused.activity.forRun(async () => GRANT).read('my-app')).rejects.toThrow(
      'You do not have access to Apps authoring'
    );
    const none = client(() => Response.json(ACTIVITY));
    await expect(none.activity.forRun(async () => null).read('my-app')).rejects.toThrow(
      FEEDBACK_GRANT_GONE
    );
    expect(none.sent).toEqual([]);
    const odd = client(() => Response.json({ items: 'nope' }));
    await expect(odd.activity.forRun(async () => GRANT).read('my-app')).rejects.toThrow(
      APP_ACTIVITY_UNAVAILABLE
    );
  });
});

describe('app_activity on the runner', () => {
  let fake: FakeSandboxService;
  const opened: OpenTools[] = [];
  beforeEach(async () => {
    fake = new FakeSandboxService();
    await fake.start();
  });
  afterEach(async () => {
    await Promise.all(opened.splice(0).map((tools) => tools.close()));
    await fake.stop();
  });

  async function open(app: string, source?: AppActivitySource) {
    const runs: string[] = [];
    const tools = await new AppAssistantTools({
      sandboxUrl: fake.url,
      tokens: () => async (purpose) => `test-token-${purpose}`,
      ...(source
        ? {
            appActivity: (runId: string) => {
              runs.push(runId);
              return source;
            },
          }
        : {}),
      log: quiet,
      wakePollMs: 5,
      wakeTimeoutMs: 5_000,
    }).open({
      userId: 'u-1',
      runId: 'run-9',
      conversationId: 'conv-1',
      page: { app },
      history: chosenApp(app),
      signal: new AbortController().signal,
    });
    opened.push(tools);
    return { tools, runs };
  }

  let callId = 0;
  const call = (tools: ToolSet, name: string) => {
    const tool = tools[name];
    if (!tool?.execute) throw new Error(`no tool ${name}`);
    return Promise.resolve(
      tool.execute({} as never, { toolCallId: `a-${++callId}`, messages: [] } as never)
    ) as Promise<unknown>;
  };

  it('reads the open app through civitai for this run, as text, offered to the page as a host tool', async () => {
    fake.add('my-app');
    const asked: string[] = [];
    const { tools, runs } = await open('my-app', {
      read: async (app) => {
        asked.push(app);
        return app === 'my-app' ? ACTIVITY : null;
      },
    });
    expect(runs).toEqual(['run-9']);
    expect(tools.hostTools).toContain(APP_ACTIVITY);
    const out = await call(tools.tools, APP_ACTIVITY);
    expect(asked).toEqual(['my-app']);
    expect(typeof out).toBe('string');
    const lines = String(out).split('\n');
    expect(lines[0]).toBe('App activity of my-app in the last 2 hours, newest first:');
    expect(lines[1]).toBe(ACTIVITY.summary);
    expect(lines[2]).toMatch(/^- .* · error \(unhandledrejection\) · "boom"$/);
  });

  /** As sandbox-mcp's read_file answers a project's manifest: its text in `content`. */
  const manifestAt = (path: string, manifest: Record<string, unknown>) =>
    fake.tools.set('read_file', (args) =>
      args.path === path
        ? JSON.stringify({ path, size: 64, truncated: false, content: JSON.stringify(manifest) })
        : 'export {}'
    );

  // REGRESSION: the app key `slideshow` previews as `slideshow-2` when `slideshow` is taken (the
  // assistant picks another blockId in the manifest), and the preview's calls and errors are kept
  // under that block id. Reading by the app key answered "not one of your apps", or an empty
  // all-clear for an unclaimed slug.
  it('reads the block id the preview runs under (the manifest’s), not the app key', async () => {
    fake.add('slideshow');
    manifestAt('slideshow/block.manifest.json', { blockId: 'slideshow-2' });
    const asked: string[] = [];
    const { tools } = await open('slideshow', {
      read: async (app) => {
        asked.push(app);
        return { ...ACTIVITY, app };
      },
    });
    const out = await call(tools.tools, APP_ACTIVITY);
    expect(asked).toEqual(['slideshow-2']);
    expect(String(out).split('\n')[0]).toBe(
      'App activity of slideshow-2 in the last 2 hours, newest first:'
    );
  });

  // The control for the case above (an invariant guard: it held before the fix too).
  it('falls back to the app key when the project has no readable manifest block id', async () => {
    fake.add('slideshow');
    manifestAt('slideshow/block.manifest.json', { name: 'Slideshow' });
    const asked: string[] = [];
    const { tools } = await open('slideshow', {
      read: async (app) => {
        asked.push(app);
        return { ...ACTIVITY, app };
      },
    });
    await call(tools.tools, APP_ACTIVITY);
    expect(asked).toEqual(['slideshow']);
  });

  it('an app civitai says is not the user’s reads as not found', async () => {
    fake.add('their-app');
    const { tools } = await open('their-app', { read: async () => null });
    expect(await call(tools.tools, APP_ACTIVITY)).toMatchObject({ error: APP_ACTIVITY_NOT_FOUND });
  });

  it('without civitai’s activity read set up, the tool says so', async () => {
    fake.add('my-app');
    const { tools } = await open('my-app');
    expect(await call(tools.tools, APP_ACTIVITY)).toMatchObject({
      error: 'App activity cannot be read here.',
    });
  });
});
