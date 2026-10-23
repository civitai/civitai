import { describe, expect, it } from 'vitest';
import type { ChatToolResult } from '@civitai/components-chat/core';
import { gateToolSet } from '@civitai/components-chat/core';
import {
  CREATE_APP,
  createAppTools,
  isKeepLimitResult,
} from '~/components/Apps/AppAssistant/appTools';
import type { Sandbox } from '~/components/Apps/AppAssistant/sandboxClient';
import { SandboxApiError } from '~/components/Apps/AppAssistant/sandboxClient';

const sandbox = (app: string): Sandbox => ({
  name: `sbx-${app}`,
  app,
  state: 'suspended',
  mcpUrl: `https://sandbox.example/s/sbx-${app}/mcp`,
  createdAt: null,
  lastActivityAt: null,
  expiresAt: null,
});

const KEEP_CAP = new SandboxApiError('sandbox limit (3) reached; delete one first', 409, 'limit');
const RUNNING_CAP = new SandboxApiError(
  'running-sandbox limit (1) reached: sbx-x (app "x") is running; suspend it first',
  409,
  'limit'
);

/**
 * The results the page's `tool-result` event carries, made the way the chat makes them: the real
 * `create_app` behind the chat's own gate (`gateToolSet`), whose refusals come from the app tools.
 */
async function resultsOf(error: unknown, calls = 1): Promise<ChatToolResult[]> {
  const results: ChatToolResult[] = [];
  const appTools = createAppTools({
    apps: () => [sandbox('first-app'), sandbox('second-app'), sandbox('third-app')],
    current: () => null,
    open: async () => {
      throw error;
    },
  });
  const gated = gateToolSet(appTools.tools as never, {
    conversationId: 'conv-1',
    gate: (name) => {
      const refused = appTools.refusal(name);
      return refused ? { refuse: refused } : undefined;
    },
    onResult: (result) => results.push(result),
  });
  for (let i = 0; i < calls; i++)
    await Promise.resolve(
      gated[CREATE_APP].execute!({ name: 'Fourth app' }, {
        toolCallId: `t-${i}`,
        messages: [],
      } as never)
    ).catch(() => undefined);
  return results;
}

describe('isKeepLimitResult (the one place the page tells a kept-apps refusal)', () => {
  it('is true for create_app thrown at the kept-apps cap', async () => {
    const [result] = await resultsOf(KEEP_CAP);
    expect(result).toMatchObject({ name: 'create_app', isError: true });
    expect(isKeepLimitResult(result)).toBe(true);
  });

  it('is true for the same reply’s next create_app, which the gate refuses without asking again', async () => {
    const results = await resultsOf(KEEP_CAP, 2);
    expect(results).toHaveLength(2);
    expect(results[1].refused).toBe(
      'You already have as many apps as you can keep. Delete one you no longer need from the app switcher at the top of the page, then ask again.'
    );
    expect(results.map(isKeepLimitResult)).toEqual([true, true]);
  });

  it('NEGATIVE CONTROL: is false at the running cap, which the page already handles by pausing', async () => {
    const [result] = await resultsOf(RUNNING_CAP);
    expect(result).toMatchObject({ name: 'create_app', isError: true });
    expect(isKeepLimitResult(result)).toBe(false);
  });

  it('is false for a conflict and for an unreachable service', async () => {
    const [conflict] = await resultsOf(new SandboxApiError('busy', 409, 'conflict'));
    const [down] = await resultsOf(
      new SandboxApiError('Sandbox service error (503)', 503, 'unavailable')
    );
    expect([isKeepLimitResult(conflict), isKeepLimitResult(down)]).toEqual([false, false]);
  });

  it('is false for another tool that reports the same words, and for a create_app that worked', () => {
    const words =
      'You already have as many apps as you can keep. Delete one you no longer need from the app switcher at the top of the page, then ask again.';
    expect(
      isKeepLimitResult({
        name: 'set_checklist',
        input: {},
        output: { error: words },
        isError: true,
      })
    ).toBe(false);
    expect(
      isKeepLimitResult({
        name: 'create_app',
        input: {},
        output: { app: 'quiz', state: 'starting', note: words },
        isError: false,
      })
    ).toBe(false);
    // The control: the same words as create_app's error are the limit.
    expect(
      isKeepLimitResult({ name: 'create_app', input: {}, output: { error: words }, isError: true })
    ).toBe(true);
  });
});
