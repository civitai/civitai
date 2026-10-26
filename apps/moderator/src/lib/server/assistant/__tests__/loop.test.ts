import { error as kitError } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  BUDGET_NOTICE,
  fitJson,
  MAX_REASONING_CHARS,
  MAX_ROUNDS,
  REASONING_CUT,
  REASONING_NOTE,
  runTurn,
  type AnyTool,
} from '../loop';
import type { Completion, ToolCall } from '../openrouter';
import type { ToolResult } from '../tools';

/**
 * The turn loop against a scripted model. These are the guardrails a prompt cannot provide: which
 * tools can run, how many model calls a turn may make, when the daily allowance stops it, and which
 * citations count as verified.
 */

const call = (name: string, args: unknown, id = name): ToolCall => ({
  id,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});
const reply = (content: string | null, calls: ToolCall[] = [], tokens = 10): Completion => ({
  message: { content, tool_calls: calls.length ? calls : undefined },
  finishReason: calls.length ? 'tool_calls' : 'stop',
  usage: { prompt: tokens, completion: 0 },
});

const lookup = vi.fn(
  async ({ userId }: { userId: number }): Promise<ToolResult> => ({
    data: { userId, username: 'five' },
    rows: 1,
    truncated: false,
    sources: [{ ref: `user:${userId}`, href: `/retool/user-lookup?q=${userId}`, label: 'five' }],
  })
);
const tools: AnyTool[] = [
  {
    name: 'lookup',
    input: z.object({ userId: z.number().int().positive() }),
    run: lookup as never,
  },
];

function turn(script: Completion[], over: Partial<Parameters<typeof runTurn>[0]> = {}) {
  const complete = vi.fn(async (_req: unknown) => {
    const next = script.shift();
    if (!next) throw new Error('script exhausted');
    return next;
  });
  const run = runTurn({
    system: 's',
    history: [],
    prompt: 'q',
    tools,
    specs: [],
    ctx: {
      moderatorId: 1,
      chatId: 1,
      turnId: 1,
      canAccess: () => true,
      hasGrant: () => true,
      mask: (c: string) => c,
      conversation: () => [],
    },
    budget: 1_000_000,
    knownRefs: [],
    complete,
    emit: () => {},
    ...over,
  });
  return { run, complete };
}

describe('runTurn', () => {
  it('runs a requested lookup, feeds the result back, and answers', async () => {
    lookup.mockClear();
    const { run, complete } = turn([
      reply(null, [call('lookup', { userId: 5 })]),
      reply('It is [user:5].'),
    ]);
    const out = await run;
    expect(out).toMatchObject({ status: 'done', answer: 'It is [user:5].', unverified: [] });
    expect(lookup).toHaveBeenCalledWith({ userId: 5 }, expect.anything());
    expect(out.toolCalls).toEqual([
      expect.objectContaining({ name: 'lookup', rows: 1, error: null }),
    ]);
    const second = (
      complete.mock.calls[1] as unknown as [{ messages: { role: string; content: string }[] }]
    )[0];
    expect(second.messages.at(-1)).toMatchObject({
      role: 'tool',
      content: expect.stringContaining('"five"'),
    });
  });

  it('logs which model round asked for each lookup', async () => {
    const { run } = turn([
      reply(null, [call('lookup', { userId: 5 }, 'a'), call('lookup', { userId: 6 }, 'b')]),
      reply(null, [call('lookup', { userId: 7 }, 'c')]),
      reply('done'),
    ]);
    expect((await run).toolCalls.map((c) => c.round)).toEqual([1, 1, 2]);
  });

  describe('a tool with its own timeout', () => {
    const slow = (ms: number, timeoutMs?: number): AnyTool => ({
      name: 'slow',
      input: z.object({ ids: z.array(z.string()) }),
      run: (async () => {
        await new Promise((r) => setTimeout(r, ms));
        return { data: { ok: true }, rows: 1, truncated: false, sources: [] };
      }) as never,
      timeoutMs,
      onTimeout: (({ ids }: { ids: string[] }) => ({ notChecked: ids })) as never,
    });
    const toolResult = async (tool: AnyTool) => {
      const { run, complete } = turn(
        [reply(null, [call('slow', { ids: ['a', 'b'] })]), reply('done')],
        {
          tools: [tool],
        }
      );
      await run;
      const messages = (
        complete.mock.calls[1][0] as { messages: { role: string; content: string }[] }
      ).messages;
      return JSON.parse(messages.find((m) => m.role === 'tool')!.content);
    };

    it('times out at its own limit and tells the model what went unchecked', async () => {
      expect(await toolResult(slow(200, 20))).toEqual({
        error: 'The lookup timed out.',
        notChecked: ['a', 'b'],
      });
    });

    it('is not cut off at its limit when it finishes within it', async () => {
      expect(await toolResult(slow(20, 2_000))).toMatchObject({ data: { ok: true } });
    });

    it('gives a measured-slow tool its full limit, not the 45 s default', async () => {
      vi.useFakeTimers();
      try {
        const result = toolResult(slow(60_000, 90_000));
        await vi.advanceTimersByTimeAsync(61_000);
        expect(await result).toMatchObject({ data: { ok: true } });
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps the generic error even if the detail names one, and survives a detail that throws', async () => {
      const own = (onTimeout: unknown): AnyTool => ({
        ...slow(200, 20),
        onTimeout: onTimeout as never,
      });
      expect(await toolResult(own(() => ({ error: 'SELECT * FROM secrets', x: 1 })))).toEqual({
        error: 'The lookup timed out.',
        x: 1,
      });
      expect(
        await toolResult(
          own(() => {
            throw new Error('SELECT * FROM secrets');
          })
        )
      ).toEqual({ error: 'The lookup timed out.' });
    });

    it('still answers when the turn deadline passes during a lookup', async () => {
      vi.useFakeTimers();
      try {
        // Like fetch: a call made with an already-aborted signal fails at once.
        const script = [
          reply(null, [call('slow', { ids: ['a'] })]),
          reply('found a; b not checked'),
        ];
        const complete = vi.fn(async (req: { signal?: AbortSignal }) => {
          if (req.signal?.aborted) throw new Error('aborted');
          return script.shift()!;
        });
        const { run } = turn([], { tools: [slow(250_000, 300_000)], complete: complete as never });
        await vi.advanceTimersByTimeAsync(251_000);
        expect(await run).toMatchObject({ status: 'done', answer: 'found a; b not checked' });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('never runs a tool the moderator was not given, whatever the model asks for', async () => {
    const { run } = turn([reply(null, [call('ban_user', { userId: 5 })]), reply('done')]);
    const out = await run;
    expect(out.toolCalls).toEqual([
      expect.objectContaining({ name: 'ban_user', error: 'No tool named "ban_user".' }),
    ]);
  });

  it('refuses arguments that fail the schema without running the tool', async () => {
    lookup.mockClear();
    const { run } = turn([reply(null, [call('lookup', { userId: '5 OR 1=1' })]), reply('done')]);
    const out = await run;
    expect(lookup).not.toHaveBeenCalled();
    expect(out.toolCalls[0].error).toMatch(/^Invalid arguments/);
  });

  it('stops calling tools after MAX_ROUNDS and makes the model answer', async () => {
    // A model that keeps asking for lookups even when told it may not: the loop must stop anyway.
    const forever = Array.from({ length: MAX_ROUNDS + 5 }, (_, i) =>
      reply(i === MAX_ROUNDS ? 'answer with what I have' : null, [
        call('lookup', { userId: i + 1 }, `c${i}`),
      ])
    );
    const { run, complete } = turn(forever);
    const out = await run;
    expect(complete).toHaveBeenCalledTimes(MAX_ROUNDS + 1);
    expect(out.toolCalls).toHaveLength(MAX_ROUNDS);
    expect(complete.mock.calls.at(-1)?.[0]).toMatchObject({ toolChoice: 'none' });
    expect(out.answer).toBe('answer with what I have');
  });

  it('stops at the daily allowance without running the lookups that crossed it', async () => {
    lookup.mockClear();
    const { run, complete } = turn([reply(null, [call('lookup', { userId: 5 })], 600)], {
      budget: 500,
    });
    const out = await run;
    expect(out.status).toBe('capped');
    expect(lookup).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('marks citations no lookup in this chat returned as unverified', async () => {
    const { run } = turn(
      [reply(null, [call('lookup', { userId: 5 })]), reply('[user:5] [user:7] [user:9]')],
      {
        knownRefs: ['user:9'],
      }
    );
    expect((await run).unverified).toEqual(['user:7']);
  });

  it('reports a failed lookup as a generic error, never the database text with its query', async () => {
    lookup.mockRejectedValueOnce(
      new Error("Code: 62. Syntax error in SELECT ... WHERE ip IN ('192.0.2.44')")
    );
    const { run, complete } = turn([
      reply(null, [call('lookup', { userId: 5 })]),
      reply('could not check'),
    ]);
    const out = await run;
    expect(out.status).toBe('done');
    expect(out.toolCalls[0].error).toBe('The lookup failed.');
    expect(JSON.stringify(complete.mock.calls)).not.toContain('192.0.2.44');
  });

  it('ends the turn after a filed tool request: no further lookups, and it asks', async () => {
    lookup.mockClear();
    const fileRequest = vi.fn(
      async (): Promise<ToolResult> => ({
        data: { filed: 1 },
        rows: 1,
        truncated: false,
        sources: [],
      })
    );
    const { run, complete } = turn(
      [
        reply(null, [call('request_tool', { need: 'crucible judges' })]),
        // Would keep digging if allowed to.
        {
          ...reply('I filed it. Want me to check anything else?', [call('lookup', { userId: 5 })]),
        },
      ],
      {
        tools: [
          ...tools,
          {
            name: 'request_tool',
            input: z.object({ need: z.string() }),
            run: fileRequest as never,
          },
        ],
      }
    );
    const out = await run;
    expect(out.status).toBe('done');
    expect(fileRequest).toHaveBeenCalledTimes(1);
    expect(lookup).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledTimes(2);
    const second = complete.mock.calls[1][0] as {
      toolChoice: string;
      messages: { content: string }[];
    };
    expect(second.toolChoice).toBe('none');
    expect(second.messages.at(-1)?.content).toMatch(
      /^You filed a tool request\. Stop investigating/
    );
  });

  it('stops at the per-question budget and says so in the answer, never silently', async () => {
    lookup.mockClear();
    const { run, complete } = turn(
      [reply(null, [call('lookup', { userId: 5 })], 700), reply('what I found so far')],
      { turnBudget: 500 }
    );
    const out = await run;
    expect(out.status).toBe('done');
    expect(out.answer).toBe(`what I found so far\n\n${BUDGET_NOTICE}`);
    expect((complete.mock.calls[1][0] as { toolChoice: string }).toolChoice).toBe('none');
  });

  it('a question under the budget is answered without the notice', async () => {
    const { run } = turn([reply(null, [call('lookup', { userId: 5 })], 10), reply('done')], {
      turnBudget: 500,
    });
    expect((await run).answer).toBe('done');
  });

  it('asks the model to reason briefly, after the question', async () => {
    const { run, complete } = turn([reply('ok')]);
    await run;
    const messages = (complete.mock.calls[0][0] as { messages: { content: string }[] }).messages;
    expect(messages.at(-1)?.content).toBe(`q${REASONING_NOTE}`);
  });

  it("keeps every round's reasoning, in order, and never sends it back to the model", async () => {
    const thinking = (content: string | null, thought: string, calls: ToolCall[] = []) => {
      const r = reply(content, calls);
      r.message.reasoning = thought;
      return r;
    };
    const { run, complete } = turn([
      thinking(null, '- need the account', [call('lookup', { userId: 5 })]),
      thinking('It is [user:5].', '- found it'),
    ]);
    const out = await run;
    expect(out.reasoning).toBe('- need the account\n\n- found it');
    expect(JSON.stringify(complete.mock.calls[1][0])).not.toContain('need the account');
  });

  it('records no reasoning when the model returns none', async () => {
    const { run } = turn([reply('ok')]);
    expect((await run).reasoning).toBeNull();
  });

  it('keeps the reasoning when the turn fails after it, so a failed turn can be read', async () => {
    const first = reply(null, [call('lookup', { userId: 5 })]);
    first.message.reasoning = '- need the account';
    const { run } = turn([first]);
    const out = await run;
    expect(out.status).toBe('error');
    expect(out.reasoning).toBe('- need the account');
  });

  it('cuts reasoning past the cap and says so', async () => {
    const long = reply('ok');
    long.message.reasoning = 'x'.repeat(MAX_REASONING_CHARS + 50);
    const { run } = turn([long]);
    expect((await run).reasoning).toBe('x'.repeat(MAX_REASONING_CHARS) + REASONING_CUT);
  });

  // SvelteKit's `error()` throws an HttpError, which is not an `Error`.
  it("shows a SvelteKit error's message, not its JSON", async () => {
    const { run } = turn([], {
      complete: async () => kitError(500, 'OPENROUTER_API_KEY is not configured'),
    });
    const out = await run;
    expect(out.status).toBe('error');
    expect(out.error).toBe('OPENROUTER_API_KEY is not configured');
  });
});

describe('fitJson', () => {
  it('trims the longest list until the result fits, and says so', () => {
    const { json, trimmed } = fitJson(
      { rows: Array.from({ length: 1000 }, (_, i) => ({ i })) },
      2000
    );
    expect(trimmed).toBe(true);
    expect(json.length).toBeLessThanOrEqual(2000);
    expect(JSON.parse(json)).toMatchObject({ trimmedForSize: true });
  });

  it('leaves a result that fits alone', () => {
    expect(fitJson({ a: [1, 2] }, 100)).toEqual({ json: '{"a":[1,2]}', trimmed: false });
  });
});
