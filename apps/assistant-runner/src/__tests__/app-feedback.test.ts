import {
  FEEDBACK_UNAVAILABLE,
  GET_REVIEW_FEEDBACK,
  GET_USER_FEEDBACK,
  NO_LISTING,
  SET_FEEDBACK_STATUS,
  UNTRUSTED_FEEDBACK_NOTICE,
  type AppFeedbackSource,
  type UserFeedbackPage,
} from '@civitai/app-assistant';
import type { ChatToolResult } from '@civitai/components-chat/runner-protocol';
import type { ToolSet } from 'ai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  APP_FEEDBACK_PATH,
  CivitaiAppFeedback,
  FEEDBACK_GRANT_GONE,
} from '../app-assistant/app-feedback';
import { AppAssistantTools } from '../app-assistant/provider';
import type { OpenTools } from '../core/interfaces';
import { chosenApp } from '../test-support/chosen-app';
import { FakeSandboxService } from '../test-support/fake-sandbox';

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
// TEST-ONLY placeholders: never a real credential.
const SECRET = 'test-only-runner-secret-feedback-0123';
const GRANT = 'test-only-grant-feedback';

describe('CivitaiAppFeedback', () => {
  function client(answer: (url: string, init: RequestInit) => Response | Promise<Response>) {
    const sent: { url: string; init: RequestInit }[] = [];
    const feedback = new CivitaiAppFeedback({
      civitaiUrl: 'https://civitai.example/',
      secret: SECRET,
      log: quiet,
      fetch: async (input, init) => {
        sent.push({ url: String(input), init: init! });
        return answer(String(input), init!);
      },
    });
    return { sent, feedback };
  }

  it('posts each read with the runner’s secret and the run’s grant, read per call', async () => {
    let grants = 0;
    const page: UserFeedbackPage = { appListingId: 'lst_1', items: [], nextCursor: null };
    const { sent, feedback } = client(() => Response.json(page));
    const source = feedback.forRun(async () => {
      grants++;
      return GRANT;
    });
    expect(await source.userFeedback('my-app', { status: 'new', limit: 5 })).toEqual(page);
    await source.userFeedback('my-app', { status: 'all', limit: 5, cursor: 9 });
    expect(grants).toBe(2);
    expect(sent.map((s) => s.url)).toEqual([
      `https://civitai.example/${APP_FEEDBACK_PATH}/user`,
      `https://civitai.example/${APP_FEEDBACK_PATH}/user`,
    ]);
    expect(new Headers(sent[0]!.init.headers).get('authorization')).toBe(`Bearer ${SECRET}`);
    expect(JSON.parse(String(sent[1]!.init.body))).toEqual({
      grant: GRANT,
      app: 'my-app',
      status: 'all',
      limit: 5,
      cursor: 9,
    });
  });

  it('reads civitai’s NOT_FOUND as no listing, and any other 404 as unavailable', async () => {
    const notFound = client(() =>
      Response.json({ error: 'x', code: 'NOT_FOUND' }, { status: 404 })
    );
    expect(await notFound.feedback.forRun(async () => GRANT).review('their-app')).toBeNull();
    // A civitai without this endpoint yet answers a page, not civitai's code.
    const noRoute = client(() => new Response('<html>404</html>', { status: 404 }));
    await expect(noRoute.feedback.forRun(async () => GRANT).review('my-app')).rejects.toThrow(
      FEEDBACK_UNAVAILABLE
    );
  });

  it('says why civitai refused the user, and never calls without a grant', async () => {
    const refused = client(() =>
      Response.json(
        { error: 'You do not have access to Apps authoring', code: 'FORBIDDEN' },
        { status: 403 }
      )
    );
    await expect(refused.feedback.forRun(async () => GRANT).review('my-app')).rejects.toThrow(
      'You do not have access to Apps authoring'
    );
    const none = client(() => Response.json({}));
    await expect(none.feedback.forRun(async () => null).review('my-app')).rejects.toThrow(
      FEEDBACK_GRANT_GONE
    );
    expect(none.sent).toEqual([]);
  });

  it('refuses an answer that is not the shape it asked for', async () => {
    const odd = client(() => Response.json({ items: 'nope' }));
    await expect(
      odd.feedback.forRun(async () => GRANT).userFeedback('my-app', { status: 'new', limit: 1 })
    ).rejects.toThrow(FEEDBACK_UNAVAILABLE);
  });
});

describe('the feedback tools on the runner', () => {
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

  /** civitai as one run reads it: only `my-app` is the user's. */
  function civitai() {
    const asked: string[] = [];
    const source: AppFeedbackSource = {
      review: async (app) => {
        asked.push(`review:${app}`);
        return app === 'my-app'
          ? {
              listing: { status: 'rejected', problems: [{ label: 'Add a cover', blocking: true }] },
              submissions: [
                {
                  kind: 'version',
                  version: '0.3.0',
                  status: 'rejected',
                  submittedAt: '2026-10-20T10:00:00.000Z',
                  reviewedAt: '2026-10-21T10:00:00.000Z',
                  rejectionReason: 'Blank on mobile.',
                  approvalNotes: null,
                  deployState: null,
                  deployProblem: null,
                },
              ],
            }
          : null;
      },
      userFeedback: async (app) => {
        asked.push(`user:${app}`);
        return app === 'my-app'
          ? {
              appListingId: 'lst_my_51',
              items: [
                {
                  id: 6631,
                  createdAt: '2026-10-22T10:00:00.000Z',
                  status: 'new',
                  appVersion: null,
                  message: 'Blank on my phone',
                },
              ],
              nextCursor: null,
            }
          : null;
      },
    };
    return { source, asked };
  }

  async function open(app: string, source: AppFeedbackSource) {
    const runs: string[] = [];
    const reported: ChatToolResult[] = [];
    const tools = await new AppAssistantTools({
      sandboxUrl: fake.url,
      tokens: () => async (purpose) => `test-token-${purpose}`,
      appFeedback: (runId) => {
        runs.push(runId);
        return source;
      },
      log: quiet,
      wakePollMs: 5,
      wakeTimeoutMs: 5_000,
    }).open({
      userId: 'u-1',
      runId: 'run-7',
      conversationId: 'conv-1',
      page: { app },
      history: chosenApp(app),
      signal: new AbortController().signal,
      report: (result) => reported.push(result),
    });
    opened.push(tools);
    return { tools, runs, reported };
  }

  let callId = 0;
  const call = (tools: ToolSet, name: string, input: Record<string, unknown> = {}) => {
    const tool = tools[name];
    if (!tool?.execute) throw new Error(`no tool ${name}`);
    return Promise.resolve(
      tool.execute(input as never, { toolCallId: `f-${++callId}`, messages: [] } as never)
    ) as Promise<Record<string, unknown>>;
  };

  it('reads the open app’s review through civitai for this run, framed as untrusted', async () => {
    fake.add('my-app');
    const { source, asked } = civitai();
    const { tools, runs } = await open('my-app', source);
    expect(runs).toEqual(['run-7']);
    const out = await call(tools.tools, GET_REVIEW_FEEDBACK);
    expect(asked).toEqual(['review:my-app']);
    expect(out).toMatchObject({
      app: 'my-app',
      cannotPublishYet: ['Add a cover'],
      submissions: [{ status: 'rejected', untrustedRejectionReason: 'Blank on mobile.' }],
      notice: UNTRUSTED_FEEDBACK_NOTICE,
    });
  });

  it('an app civitai has no listing of this user’s for reads as no listing', async () => {
    fake.add('their-app');
    const { source } = civitai();
    const { tools } = await open('their-app', source);
    expect(await call(tools.tools, GET_REVIEW_FEEDBACK)).toMatchObject({ error: NO_LISTING });
    expect(await call(tools.tools, GET_USER_FEEDBACK)).toMatchObject({ error: NO_LISTING });
  });

  it('offers a status change for the page’s card, and writes nothing', async () => {
    fake.add('my-app');
    const { source, asked } = civitai();
    const { tools, reported } = await open('my-app', source);
    await call(tools.tools, GET_USER_FEEDBACK);
    const offer = await call(tools.tools, SET_FEEDBACK_STATUS, { ids: [6631], status: 'resolved' });
    expect(offer).toMatchObject({
      awaitsUser: true,
      appListingId: 'lst_my_51',
      status: 'resolved',
      items: [{ id: 6631, from: 'new' }],
    });
    expect(String(offer.feedbackStatus)).toMatch(/^run-7-feedback-/);
    // Told to the page, whose card is the only thing that writes.
    expect(reported.find((r) => r.name === SET_FEEDBACK_STATUS)?.output).toEqual(offer);
    // The source has no write at all; it was asked for reads only.
    expect(asked).toEqual(['user:my-app']);
  });

  it('without civitai’s feedback reads set up, the tools say so', async () => {
    fake.add('my-app');
    const tools = await new AppAssistantTools({
      sandboxUrl: fake.url,
      tokens: () => async (purpose) => `test-token-${purpose}`,
      log: quiet,
      wakePollMs: 5,
      wakeTimeoutMs: 5_000,
    }).open({
      userId: 'u-1',
      runId: 'run-8',
      conversationId: 'conv-1',
      page: { app: 'my-app' },
      history: chosenApp('my-app'),
      signal: new AbortController().signal,
    });
    opened.push(tools);
    expect(await call(tools.tools, GET_REVIEW_FEEDBACK)).toMatchObject({
      error: 'App feedback cannot be read here.',
    });
  });
});
