import type { ModelMessage } from 'ai';
import { describe, expect, it } from 'vitest';

import {
  chosenAppIn,
  CivitaiTurnReports,
  toolCallCounts,
  TURN_REPORT_PATH,
  turnReportOf,
} from '../app-assistant/turn-report';
import type { TurnEnded } from '../core/interfaces';

// TEST-ONLY placeholders: never a real credential.
const SECRET = 'test-only-runner-secret-turns-4417';
const GRANT = 'test-only-grant-turns-9032';

/** An assistant step calling `toolName`, and the tool's answer. */
function call(id: string, toolName: string, input: unknown, output: unknown): ModelMessage[] {
  return [
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: id, toolName, input }] },
    {
      role: 'tool',
      content: [
        { type: 'tool-result', toolCallId: id, toolName, output: { type: 'json', value: output } },
      ],
    },
  ] as ModelMessage[];
}

// Pairwise-distinct everywhere: apps, ids, counts, times, Buzz.
const EARLIER = call('e1', 'create_app', { name: 'First' }, { app: 'first-app-71' });
const CURRENT = [
  ...call('c1', 'use_open_app', { app: 'second-app-38' }, { app: 'second-app-38' }),
  ...call('c2', 'read_docs', { path: 'sdk/theme' }, { text: 'docs' }),
  ...call('c3', 'sandbox__write_file', { path: 'a.ts' }, { ok: true }),
  ...call('c4', 'read_docs', { path: 'sdk/blocks' }, { text: 'docs' }),
  ...call('c5', 'read_docs', { path: 'sdk/auth' }, { text: 'docs' }),
] as ModelMessage[];

const TURN: TurnEnded = {
  userId: '5521',
  runId: 'run-abc-604',
  conversationId: 'conv-xyz-193',
  seq: 7,
  model: 'model-under-test',
  status: 'done',
  buzz: 23,
  startedAt: new Date('2026-11-20T10:00:00.000Z'),
  endedAt: new Date('2026-11-20T10:00:04.500Z'),
  messages: CURRENT,
  earlier: EARLIER,
};

const quiet = () => {
  const warned: string[] = [];
  return {
    warned,
    log: {
      info: () => undefined,
      warn: (_object: object, message?: string) => void warned.push(message ?? ''),
      error: () => undefined,
    },
  };
};

describe('turnReportOf', () => {
  it('reports the app the chat chose last, its tool calls by name, its Buzz and its duration', () => {
    expect(turnReportOf(TURN)).toEqual({
      v: 1,
      app: 'second-app-38',
      seq: 7,
      runId: 'run-abc-604',
      model: 'model-under-test',
      status: 'done',
      buzz: 23,
      toolCalls: { use_open_app: 1, read_docs: 3, sandbox__write_file: 1 },
      durationMs: 4_500,
      startedAt: '2026-11-20T10:00:00.000Z',
      endedAt: '2026-11-20T10:00:04.500Z',
    });
  });

  it('carries the app an earlier reply chose when this one chose none', () => {
    expect(turnReportOf({ ...TURN, messages: [] }).app).toBe('first-app-71');
    expect(turnReportOf({ ...TURN, messages: [], earlier: [] }).app).toBeNull();
  });

  it('does not count an app a failed or existing-app call named as chosen', () => {
    const existed = call('x1', 'create_app', {}, { app: 'taken-app-55', existed: true });
    const failed = call('x2', 'use_open_app', {}, { app: 'broken-app-62', error: 'nope' });
    expect(chosenAppIn([...EARLIER, ...existed, ...failed])).toBe('first-app-71');
  });

  it('counts no tool calls for a reply that made none, and no Buzz when none was charged', () => {
    const report = turnReportOf({
      ...TURN,
      buzz: undefined,
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'hi' }] }],
    });
    expect(report.toolCalls).toEqual({});
    expect(report.buzz).toBe(0);
    expect(toolCallCounts([])).toEqual({});
  });
});

describe('CivitaiTurnReports', () => {
  function reports(
    answer: (init: RequestInit) => Promise<Response>,
    grant: () => Promise<string | null> = async () => GRANT
  ) {
    const sent: { url: string; init: RequestInit }[] = [];
    const { warned, log } = quiet();
    const turnReports = new CivitaiTurnReports({
      civitaiUrl: 'https://civitai.example/',
      secret: SECRET,
      grantFor: () => grant(),
      log,
      timeoutMs: 50,
      fetch: async (input, init) => {
        sent.push({ url: String(input), init: init! });
        return answer(init!);
      },
    });
    return { sent, warned, turnReports };
  }

  it('posts the report with the runner’s secret and the run’s grant', async () => {
    const { sent, turnReports } = reports(async () => Response.json({ recorded: true }));
    await turnReports.turnEnded(TURN);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(`https://civitai.example/${TURN_REPORT_PATH}`);
    expect(sent[0]!.init.headers).toEqual({
      authorization: `Bearer ${SECRET}`,
      'content-type': 'application/json',
    });
    expect(JSON.parse(String(sent[0]!.init.body))).toEqual({
      ...turnReportOf(TURN),
      grant: GRANT,
    });
  });

  it('a grant read that throws at once never throws out of turnEnded, which the runner calls bare', () => {
    const { warned, log } = quiet();
    const turnReports = new CivitaiTurnReports({
      civitaiUrl: 'https://civitai.example',
      secret: SECRET,
      grantFor: () => {
        throw new Error('pool gone');
      },
      log,
    });
    expect(() => turnReports.turnEnded(TURN)).not.toThrow();
    expect(warned).toEqual(['a turn report was not built']);
  });

  it('a civitai 500 is logged and dropped, never thrown', async () => {
    const { warned, turnReports } = reports(async () =>
      Response.json({ error: 'boom' }, { status: 500 })
    );
    await expect(turnReports.turnEnded(TURN)).resolves.toBeUndefined();
    expect(warned).toEqual(['civitai refused a turn report']);
  });

  it('a civitai that never answers is cut off by the timeout, logged and dropped', async () => {
    const { warned, turnReports } = reports(
      (init) =>
        new Promise<Response>((_resolve, reject) =>
          init.signal!.addEventListener('abort', () => reject(init.signal!.reason))
        )
    );
    const startedAt = Date.now();
    await expect(turnReports.turnEnded(TURN)).resolves.toBeUndefined();
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(warned).toEqual(['a turn report to civitai failed']);
  });

  it('a network failure is logged and dropped, never thrown', async () => {
    const { warned, turnReports } = reports(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(turnReports.turnEnded(TURN)).resolves.toBeUndefined();
    expect(warned).toEqual(['a turn report to civitai failed']);
  });

  it('sends nothing once the run’s grant is gone, and a grant read that fails is dropped too', async () => {
    const gone = reports(
      async () => Response.json({}),
      async () => null
    );
    await gone.turnReports.turnEnded(TURN);
    expect(gone.sent).toHaveLength(0);
    expect(gone.warned).toEqual(['a turn report was not sent: the run’s grant is gone']);

    const failing = reports(
      async () => Response.json({}),
      async () => {
        throw new Error('pool closed');
      }
    );
    await expect(failing.turnReports.turnEnded(TURN)).resolves.toBeUndefined();
    expect(failing.sent).toHaveLength(0);
  });

  it('never logs the grant or the secret', async () => {
    const logged: unknown[] = [];
    const turnReports = new CivitaiTurnReports({
      civitaiUrl: 'https://civitai.example',
      secret: SECRET,
      grantFor: async () => GRANT,
      log: {
        info: (...args) => void logged.push(args),
        warn: (...args) => void logged.push(args),
        error: (...args) => void logged.push(args),
      },
      fetch: async () => Response.json({}, { status: 503 }),
    });
    await turnReports.turnEnded(TURN);
    expect(logged).toHaveLength(1);
    expect(JSON.stringify(logged)).not.toContain(GRANT);
    expect(JSON.stringify(logged)).not.toContain(SECRET);
  });
});
