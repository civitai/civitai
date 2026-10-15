import { describe, expect, it, vi } from 'vitest';
import type { ChatToolResult } from '@civitai/components-chat/civitai-chat';
import {
  APP_ASSISTANT_TURN_TOOL_CALL_LIMIT,
  REPORT_READY,
  SET_CHECKLIST,
  TURN_LIMIT_REFUSAL,
  checkKindOf,
  createAssistantGate,
  exitCodeOf,
  previewVerdictOf,
} from '~/components/Apps/AppAssistant/assistantGate';

const ctx = { conversationId: 'conv-1' };
const toolCtx = { signal: new AbortController().signal, conversationId: 'conv-1', files: [] };

const run = (command: string, exitCode: number): ChatToolResult => ({
  name: 'sandbox__run_command',
  input: { command },
  output: `exit_code: ${exitCode}\ntimed_out: false\nduration_ms: 900\noutput_bytes: 10\n---\nout`,
  isError: false,
});
const preview = (verdict: string): ChatToolResult => ({
  name: 'sandbox__preview_check',
  input: {},
  output: `render: ${verdict}\npage_errors: 0  console_errors: 0  failed_requests: 0  unanswered_host_requests: 0`,
  isError: false,
});
const write: ChatToolResult = {
  name: 'sandbox__write_file',
  input: { path: 'my-app/src/block.ts', content: 'x' },
  output: 'wrote 1 bytes',
  isError: false,
};

/** A gate whose conversation is `conv-1`, as the chat's first gated call of a reply sets it. */
function gateInConversation() {
  const gate = createAssistantGate();
  gate.startTurn();
  gate.beforeToolCall('sandbox__list_dir', {}, ctx);
  return gate;
}

async function setChecklist(
  gate: ReturnType<typeof createAssistantGate>,
  items: { label: string; done?: boolean }[]
) {
  return gate.tools[SET_CHECKLIST].execute({ items }, toolCtx);
}

/** Every condition report_ready asks for, met. */
async function allPassing(gate: ReturnType<typeof createAssistantGate>) {
  await setChecklist(gate, [{ label: 'Type a description', done: true }]);
  gate.onToolResult(preview('ok'));
  gate.onToolResult(run('cd my-app && npm test', 0));
  gate.onToolResult(run('cd my-app && npx tsc --noEmit', 0));
}

const readyDecision = (gate: ReturnType<typeof createAssistantGate>) =>
  gate.beforeToolCall(REPORT_READY, {}, ctx);

describe('per-reply tool-call limit', () => {
  it('refuses every call after the limit, until the next reply starts', () => {
    const onTurnLimit = vi.fn();
    const gate = createAssistantGate({ onTurnLimit });
    gate.startTurn();
    for (let i = 0; i < APP_ASSISTANT_TURN_TOOL_CALL_LIMIT; i++)
      expect(gate.beforeToolCall('sandbox__read_file', {}, ctx)).toEqual({ allow: true });
    expect(gate.beforeToolCall('sandbox__read_file', {}, ctx)).toEqual({
      refuse: TURN_LIMIT_REFUSAL,
    });
    // Any tool, including the page's own.
    expect(gate.beforeToolCall('start_preview', {}, ctx)).toEqual({ refuse: TURN_LIMIT_REFUSAL });
    expect(onTurnLimit.mock.calls).toEqual([[true]]);

    gate.startTurn();
    expect(onTurnLimit.mock.calls).toEqual([[true], [false]]);
    expect(gate.beforeToolCall('sandbox__read_file', {}, ctx)).toEqual({ allow: true });
  });

  it('is well below the 1,000-step ceiling and names it in the refusal', () => {
    expect(APP_ASSISTANT_TURN_TOOL_CALL_LIMIT).toBe(150);
    expect(TURN_LIMIT_REFUSAL).toBe(
      'This reply has made 150 tool calls, the most one reply may make, so nothing more runs in it. Stop now: tell the user what is done and what is left, and that they can say "continue" to carry on.'
    );
  });
});

describe('report_ready', () => {
  it('is allowed once the preview, tests, typecheck and checklist all pass', async () => {
    const gate = gateInConversation();
    await allPassing(gate);
    expect(readyDecision(gate)).toEqual({ allow: true });
  });

  it('with nothing checked, is refused naming every missing check', () => {
    const decision = readyDecision(gateInConversation()) as { refuse: string };
    expect(decision.refuse).toMatch(/^Not ready yet\. /);
    expect(decision.refuse).toMatch(/Run sandbox__preview_check/);
    expect(decision.refuse).toMatch(/cd <blockId> && npm test, on its own and unpiped/);
    expect(decision.refuse).toMatch(/cd <blockId> && npx tsc --noEmit, on its own and unpiped/);
    expect(decision.refuse).toMatch(/Call set_checklist/);
  });

  it.each(['blank', 'start_error', 'still_loading', 'server_error'])(
    'is refused when the last preview check said %s',
    async (verdict) => {
      const gate = gateInConversation();
      await allPassing(gate);
      gate.onToolResult(preview(verdict));
      expect(readyDecision(gate)).toEqual({
        refuse: `Not ready yet. The last sandbox__preview_check said render: ${verdict}. Fix that, then run it again.`,
      });
    }
  );

  it('is refused when the last test run failed, even after an earlier pass', async () => {
    const gate = gateInConversation();
    await allPassing(gate);
    gate.onToolResult(run('cd my-app && npm test', 1));
    expect(readyDecision(gate)).toEqual({
      refuse:
        'Not ready yet. The last test run failed. Fix it, then run cd <blockId> && npm test again.',
    });
  });

  it('is refused when the last typecheck failed', async () => {
    const gate = gateInConversation();
    await allPassing(gate);
    gate.onToolResult(run('cd my-app && npx tsc --noEmit', 2));
    expect(readyDecision(gate)).toEqual({
      refuse:
        'Not ready yet. The last typecheck failed. Fix it, then run cd <blockId> && npx tsc --noEmit again.',
    });
  });

  it('does not count a piped or chained test run, whose exit code may not be the tests’', async () => {
    const gate = gateInConversation();
    await setChecklist(gate, [{ label: 'a', done: true }]);
    gate.onToolResult(preview('ok'));
    gate.onToolResult(run('cd my-app && npx tsc --noEmit', 0));
    gate.onToolResult(run('cd my-app && npm test 2>&1 | tail -20', 0));
    gate.onToolResult(run('cd my-app && npm test || true', 0));
    gate.onToolResult(run('cd my-app && npm test; echo done', 0));
    expect((readyDecision(gate) as { refuse: string }).refuse).toMatch(/Run the tests/);
  });

  it('forgets every check after any other command, which may have changed files', async () => {
    const gate = gateInConversation();
    await allPassing(gate);
    gate.onToolResult(run("cd my-app && sed -i 's/a/b/' src/block.ts", 0));
    const refusal = (readyDecision(gate) as { refuse: string }).refuse;
    expect(refusal).toMatch(/Run sandbox__preview_check/);
    expect(refusal).toMatch(/Run the tests/);
    expect(refusal).toMatch(/Run the typecheck/);
  });

  it('forgets every check after a file change', async () => {
    const gate = gateInConversation();
    await allPassing(gate);
    gate.onToolResult(write);
    const refusal = (readyDecision(gate) as { refuse: string }).refuse;
    expect(refusal).toMatch(/Run sandbox__preview_check/);
    expect(refusal).toMatch(/Run the tests/);
    expect(refusal).toMatch(/Run the typecheck/);
    expect(refusal).not.toMatch(/set_checklist/);
  });

  it('ignores a refused call: nothing ran, so nothing changed', async () => {
    const gate = gateInConversation();
    await allPassing(gate);
    gate.onToolResult({ ...write, isError: true, refused: 'no', output: { error: 'no' } });
    expect(readyDecision(gate)).toEqual({ allow: true });
  });

  it('counts a preview check that errored as not ok', async () => {
    const gate = gateInConversation();
    await allPassing(gate);
    gate.onToolResult({ ...preview('ok'), isError: true, output: { error: 'port in use' } });
    expect((readyDecision(gate) as { refuse: string }).refuse).toMatch(/render: error/);
  });

  it('is refused while a checklist item is open', async () => {
    const gate = gateInConversation();
    await allPassing(gate);
    await setChecklist(gate, [{ label: 'Type a description', done: false }]);
    expect(readyDecision(gate)).toEqual({
      refuse: 'Not ready yet. These checklist items are not done: Type a description.',
    });
  });

  it('starts over in another conversation, and after reset', async () => {
    const gate = gateInConversation();
    await allPassing(gate);
    expect(gate.beforeToolCall(REPORT_READY, {}, { conversationId: 'conv-2' })).toHaveProperty(
      'refuse'
    );

    const other = gateInConversation();
    await allPassing(other);
    other.reset();
    expect(readyDecision(other)).toHaveProperty('refuse');
  });
});

describe('set_checklist', () => {
  it('ends the reply for the user to confirm when the list is new or its labels change', async () => {
    const gate = gateInConversation();
    expect(await setChecklist(gate, [{ label: 'a' }, { label: 'b' }])).toMatchObject({
      awaitsUser: true,
    });
    expect(await setChecklist(gate, [{ label: 'a', done: true }, { label: 'b' }])).toEqual({
      updated: true,
      open: 1,
    });
    expect(await setChecklist(gate, [{ label: 'a', done: true }])).toMatchObject({
      awaitsUser: true,
    });
  });

  it('takes 1-30 items of up to 200 characters, as objects or plain labels', async () => {
    const gate = gateInConversation();
    const execute = (items: unknown) => gate.tools[SET_CHECKLIST].execute({ items }, toolCtx);
    expect(await execute(['a', 'b'])).toMatchObject({ awaitsUser: true });
    expect(await execute(Array.from({ length: 30 }, (_, i) => `f${i}`))).toMatchObject({
      awaitsUser: true,
    });
    expect(await execute(['x'.repeat(200)])).toMatchObject({ awaitsUser: true });
    expect(() => execute(Array.from({ length: 31 }, (_, i) => `f${i}`))).toThrow(
      /items must be an array/
    );
    expect(() => execute(['x'.repeat(201)])).toThrow(/items must be an array/);
    expect(() => execute([])).toThrow(/items must be an array/);
  });

  it('accepts a JSON string of the items and rejects anything else', async () => {
    const gate = gateInConversation();
    expect(
      await gate.tools[SET_CHECKLIST].execute({ items: '[{"label":"a","done":true}]' }, toolCtx)
    ).toMatchObject({ awaitsUser: true });
    for (const items of [[], 'not json', [{ label: '' }], [{}], undefined])
      expect(() => gate.tools[SET_CHECKLIST].execute({ items }, toolCtx)).toThrow(
        /items must be an array/
      );
  });
});

describe('reading tool results', () => {
  it.each([
    ['npm test', 'tests'],
    ['cd my-app && npm test', 'tests'],
    ['cd avatar-gen && npm run test', 'tests'],
    ['cd my-app && npm run test -- src/block.test.ts', null],
    ['cd my-app&&npm test', 'tests'],
    ['cd my-app && npx -y vitest run', 'tests'],
    ['cd my-app && npx vitest run src/block.test.ts', null],
    ['cd my-app && npx tsc --noEmit', 'typecheck'],
    ['cd my-app && npx tsc --noEmit -p scratch/tsconfig.json', null],
    ['cd my-app && npm run typecheck', 'typecheck'],
    ['cd my-app && npm test | tail', null],
    ['cd my-app && npm test && npx tsc --noEmit', null],
    ['cd my-app && npm test > out.txt', null],
    ['cd my-app && npm install', null],
    ['echo npm test', null],
    ['cd my-app && npx tsc --version', null],
    ['cd my-app && npm test -- --help', null],
    ['cd my-app && npx vitest -h', null],
    ['cd my-app && npx tsc -v', null],
    ['cd my-app && npm test -- -u', null],
    ['cd my-app && npx vitest list', null],
    ['cd my-app && npx tsc', null],
    ['cd my-app && npx tsc --showConfig', null],
    ['cd my-app && npm test\ntrue', null],
    ['cd my-app && npm test\rtrue', null],
    ['cd my-app && npm test &', null],
    ['cd my-app && npm test $(true)', null],
    ['cd my-app && npm test `true`', null],
    ['cd my-app && npx tsc --noEmit\nexit 0', null],
  ] as const)('%s is a %s run', (command, kind) => {
    expect(checkKindOf(command)).toBe(kind);
  });

  it('reads the exit code and the preview verdict from the first line', () => {
    expect(exitCodeOf('exit_code: 0\ntimed_out: false')).toBe(0);
    expect(exitCodeOf('exit_code: 1\n')).toBe(1);
    expect(exitCodeOf('exit_code: null (signal SIGKILL)\n')).toBeNull();
    expect(exitCodeOf('out\nexit_code: 0')).toBeNull();
    expect(previewVerdictOf('render: ok\npage_errors: 0')).toBe('ok');
    expect(previewVerdictOf('render: still_loading\n')).toBe('still_loading');
    expect(previewVerdictOf({ error: 'x' })).toBeNull();
    expect(previewVerdictOf('page_errors: 0\nrender: ok')).toBeNull();
    expect(previewVerdictOf('ok')).toBeNull();
  });
});
