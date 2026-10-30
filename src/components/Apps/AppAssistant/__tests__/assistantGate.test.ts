import { describe, expect, it } from 'vitest';
import type { ChatToolResult } from '@civitai/components-chat/civitai-chat';
import {
  APP_ASSISTANT_TURN_TOOL_CALL_LIMIT,
  REPORT_READY,
  SET_CHECKLIST,
  TURN_LIMIT_MESSAGE,
  TURN_LIMIT_REFUSAL,
  checkKindOf,
  createAssistantGate,
  exitCodeOf,
  previewVerdictOf,
  READY_CARD_TEXT,
} from '~/components/Apps/AppAssistant/assistantGate';

const ctx = { conversationId: 'conv-1', reply: 1 };
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

/** A real-data app's report_ready, as every test not about the data declares it. */
const CIVITAI = { data: 'civitai' };
const readyDecision = (gate: ReturnType<typeof createAssistantGate>) =>
  gate.beforeToolCall(REPORT_READY, CIVITAI, ctx);

const STOP_AT_LIMIT = {
  refuse:
    'This reply made 150 tool calls, the most one reply may make, so it ended before this call ran.',
  stop: true,
  message:
    'App Assistant stopped this reply after 150 tool calls, the most one reply may make. Press Continue to let it carry on.',
};

describe('per-reply tool-call limit', () => {
  it('allows 150 calls in a reply, then ends the reply on the next', () => {
    const gate = createAssistantGate();
    for (let i = 0; i < 150; i++)
      expect(gate.beforeToolCall('sandbox__read_file', {}, ctx)).toEqual({ allow: true });
    expect(gate.beforeToolCall('sandbox__read_file', {}, ctx)).toEqual(STOP_AT_LIMIT);
    // Any tool, including the page's own.
    expect(gate.beforeToolCall('start_preview', {}, ctx)).toEqual(STOP_AT_LIMIT);
  });

  it('counts refused report_ready calls toward the limit', () => {
    const gate = createAssistantGate();
    for (let i = 0; i < 150; i++)
      expect(gate.beforeToolCall(REPORT_READY, {}, ctx)).toHaveProperty('refuse');
    expect(gate.beforeToolCall(REPORT_READY, {}, ctx)).toEqual(STOP_AT_LIMIT);
  });

  it('starts a fresh count for each reply the chat numbers, as Continue and Retry are', () => {
    const gate = createAssistantGate();
    for (let i = 0; i < 150; i++) gate.beforeToolCall('sandbox__read_file', {}, ctx);
    expect(gate.beforeToolCall('sandbox__read_file', {}, ctx)).toEqual(STOP_AT_LIMIT);

    const next = { ...ctx, reply: 2 };
    for (let i = 0; i < 150; i++)
      expect(gate.beforeToolCall('sandbox__read_file', {}, next)).toEqual({ allow: true });
    expect(gate.beforeToolCall('sandbox__read_file', {}, next)).toEqual(STOP_AT_LIMIT);
  });

  it('gives a new reply all 150 calls, whatever the last one used', () => {
    const gate = createAssistantGate();
    for (let i = 0; i < 100; i++) gate.beforeToolCall('sandbox__read_file', {}, ctx);
    gate.beforeToolCall('sandbox__read_file', {}, { ...ctx, reply: 2 });
    for (let i = 0; i < 149; i++)
      expect(gate.beforeToolCall('sandbox__read_file', {}, { ...ctx, reply: 2 })).toEqual({
        allow: true,
      });
    expect(gate.beforeToolCall('sandbox__read_file', {}, { ...ctx, reply: 2 })).toEqual(
      STOP_AT_LIMIT
    );
  });

  it('is well below the 1,000-step ceiling and says so in both texts', () => {
    expect(APP_ASSISTANT_TURN_TOOL_CALL_LIMIT).toBe(150);
    expect(TURN_LIMIT_REFUSAL).toBe(STOP_AT_LIMIT.refuse);
    expect(TURN_LIMIT_MESSAGE).toBe(STOP_AT_LIMIT.message);
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
        refuse: `Not ready yet. The last sandbox__preview_check said render: ${verdict}. Fix that, then run it again. Then call report_ready again.`,
      });
    }
  );

  it('is refused when the last test run failed, even after an earlier pass', async () => {
    const gate = gateInConversation();
    await allPassing(gate);
    gate.onToolResult(run('cd my-app && npm test', 1));
    expect(readyDecision(gate)).toEqual({
      refuse:
        'Not ready yet. The last test run failed. Fix it, then run cd <blockId> && npm test again. Then call report_ready again.',
    });
  });

  it('is refused when the last typecheck failed', async () => {
    const gate = gateInConversation();
    await allPassing(gate);
    gate.onToolResult(run('cd my-app && npx tsc --noEmit', 2));
    expect(readyDecision(gate)).toEqual({
      refuse:
        'Not ready yet. The last typecheck failed. Fix it, then run cd <blockId> && npx tsc --noEmit again. Then call report_ready again.',
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
      refuse:
        'Not ready yet. These checklist items are not done: Type a description. Then call report_ready again.',
    });
  });

  it('starts over in another conversation, and after reset', async () => {
    const gate = gateInConversation();
    await allPassing(gate);
    expect(gate.beforeToolCall(REPORT_READY, CIVITAI, { conversationId: 'conv-2' })).toHaveProperty(
      'refuse'
    );

    const other = gateInConversation();
    await allPassing(other);
    other.reset();
    expect(readyDecision(other)).toHaveProperty('refuse');
  });
});

describe('report_ready and the app’s data', () => {
  // Live on 2026-10-29: asked for a LoRA explorer of real Civitai models, a run hardcoded eight
  // invented models, passed report_ready, and told the user the app was ready. Literal texts, so a
  // reworded refusal is re-read here.
  const NO_DATA =
    "Not ready yet. Say where what the app shows comes from: call report_ready with data: 'civitai' (from Civitai), 'sample' (made-up sample data) or 'none' (no Civitai data). Then call report_ready again.";
  const NOT_AGREED =
    "Not ready yet. The user has not agreed to sample data. Tell them plainly the app would show made-up sample data, not real Civitai data, and why; offer to label it as sample data or to change the app to what Civitai provides. Only once they agree, call set_checklist with data: 'sample'. Then call report_ready again.";
  const NO_LABEL =
    'Not ready yet. An app showing sample data must say so: add a visible "Sample data" label at the top of the app, then run sandbox__preview_check, whose visible text must show it. Then call report_ready again.';
  const NOT_AS_PROMISED =
    'Not ready yet. The checklist told the user the app shows Civitai data, but report_ready says it shows none. Make it show the Civitai data the user asked for, or tell them why it cannot and agree a change through set_checklist. Then call report_ready again.';

  /** A passing preview check whose visible text is `text`. */
  const previewShowing = (text: string): ChatToolResult => ({
    ...preview('ok'),
    output: `render: ok\npage_errors: 0  console_errors: 0  failed_requests: 1  unanswered_host_requests: 0\n## failed requests\n- https://civitai.com/api/v1/models?query=pony — net::ERR_INTERNET_DISCONNECTED (offline-in-sandbox: not localhost)\n## visible text (#root)\n${text}`,
  });

  /** Every check passing, under a checklist that said `data` (left out when undefined). */
  async function passingWith(data: string | undefined, visible = 'LoRA Explorer') {
    const gate = gateInConversation();
    await gate.tools[SET_CHECKLIST].execute(
      { items: [{ label: 'Search models', done: true }], ...(data ? { data } : {}) },
      toolCtx
    );
    gate.onToolResult(previewShowing(visible));
    gate.onToolResult(run('cd my-app && npm test', 0));
    gate.onToolResult(run('cd my-app && npx tsc --noEmit', 0));
    return gate;
  }
  const ready = (gate: ReturnType<typeof createAssistantGate>, input: unknown) =>
    gate.beforeToolCall(REPORT_READY, input, ctx);

  it('is refused until the data is declared, whatever else passed', async () => {
    const gate = await passingWith(undefined);
    expect(ready(gate, {})).toEqual({ refuse: NO_DATA });
    expect(ready(gate, { data: 'real' })).toEqual({ refuse: NO_DATA });
    await expect(Promise.resolve(gate.tools[REPORT_READY].execute({}, toolCtx))).rejects.toThrow(
      NO_DATA
    );
  });

  it('refuses sample data the user never agreed to, labelled or not', async () => {
    // The live case: the checklist said nothing about the data.
    expect(ready(await passingWith(undefined, 'Sample data'), { data: 'sample' })).toEqual({
      refuse: NOT_AGREED,
    });
    // The checklist promised Civitai data.
    expect(ready(await passingWith('civitai', 'Sample data'), { data: 'sample' })).toEqual({
      refuse: NOT_AGREED,
    });
  });

  it('refuses agreed sample data until the app shows the label', async () => {
    expect(ready(await passingWith('sample', 'LoRA Explorer'), { data: 'sample' })).toEqual({
      refuse: NO_LABEL,
    });
  });

  it('counts the label only in the visible text, not elsewhere in the report', async () => {
    const gate = await passingWith('sample');
    gate.onToolResult({
      ...preview('ok'),
      output:
        'render: ok\npage_errors: 0  console_errors: 1  failed_requests: 0  unanswered_host_requests: 0\n## console errors\n- Sample data missing\n## visible text (#root)\nLoRA Explorer',
    });
    expect(ready(gate, { data: 'sample' })).toEqual({ refuse: NO_LABEL });
  });

  it('forgets the label when a later preview check no longer shows it', async () => {
    const gate = await passingWith('sample', 'Sample data\nLoRA Explorer');
    expect(ready(gate, { data: 'sample' })).toEqual({ allow: true });
    gate.onToolResult(previewShowing('LoRA Explorer'));
    expect(ready(gate, { data: 'sample' })).toEqual({ refuse: NO_LABEL });
  });

  it('says ready for agreed, labelled sample data, and tells the assistant to say so', async () => {
    const gate = await passingWith('sample', 'SAMPLE DATA · LoRA Explorer');
    expect(ready(gate, { data: 'sample' })).toEqual({ allow: true });
    await expect(
      Promise.resolve(gate.tools[REPORT_READY].execute({ data: 'sample' }, toolCtx))
    ).resolves.toEqual({
      ready: true,
      data: 'sample',
      note: 'Tell the user the app is ready for review, that it shows sample data, not real Civitai data, and what was checked: the preview check, the tests, the typecheck and each checklist item. The user sees a card saying these checks passed and that the data is sample data. If they want it in the App Store, call submit_for_review when they ask.',
    });
  });

  it('refuses "none" when the checklist promised Civitai data', async () => {
    expect(ready(await passingWith('civitai'), { data: 'none' })).toEqual({
      refuse: NOT_AS_PROMISED,
    });
  });

  // Over-fixing guards: a real-data app, and an app with no Civitai data, are not held up.
  it.each([
    [undefined, 'civitai'],
    ['civitai', 'civitai'],
    [undefined, 'none'],
    ['none', 'none'],
    ['sample', 'civitai'],
  ])('says ready under a checklist that said %s and data: %s', async (said, data) => {
    const gate = await passingWith(said);
    expect(ready(gate, { data })).toEqual({ allow: true });
    await expect(
      Promise.resolve(gate.tools[REPORT_READY].execute({ data }, toolCtx))
    ).resolves.toEqual({
      ready: true,
      data,
      note: 'Tell the user the app is ready for review, and what was checked: the preview check, the tests, the typecheck and each checklist item. The user sees a card saying these checks passed. If they want it in the App Store, call submit_for_review when they ask.',
    });
  });

  it('shows the list again when only its data changes, so the user agrees to sample data', async () => {
    const gate = gateInConversation();
    const items = [{ label: 'Search models' }];
    expect(
      await gate.tools[SET_CHECKLIST].execute({ items, data: 'civitai' }, toolCtx)
    ).not.toHaveProperty('awaitsUser');
    expect(
      await gate.tools[SET_CHECKLIST].execute({ items, data: 'sample' }, toolCtx)
    ).toMatchObject({ awaitsUser: true });
    // Ticking an item off without data keeps the agreed data and does not show the list again.
    expect(
      await gate.tools[SET_CHECKLIST].execute(
        { items: [{ label: 'Search models', done: true }] },
        toolCtx
      )
    ).toEqual({ updated: true, open: 0 });
    gate.onToolResult(previewShowing('Sample data'));
    gate.onToolResult(run('cd my-app && npm test', 0));
    gate.onToolResult(run('cd my-app && npx tsc --noEmit', 0));
    expect(ready(gate, { data: 'sample' })).toEqual({ allow: true });
  });

  it('rejects a data value it does not know', () => {
    const gate = gateInConversation();
    expect(() =>
      gate.tools[SET_CHECKLIST].execute({ items: ['a'], data: 'mock' }, toolCtx)
    ).toThrow('data must be one of civitai, sample, none.');
  });
});

describe('set_checklist', () => {
  it('never ends the reply for the user to confirm: a new list, ticked items or new labels', async () => {
    const gate = gateInConversation();
    expect(await setChecklist(gate, [{ label: 'a' }, { label: 'b' }])).toMatchObject({
      shown: true,
    });
    expect(await setChecklist(gate, [{ label: 'a' }, { label: 'b' }])).not.toHaveProperty(
      'awaitsUser'
    );
    expect(await setChecklist(gate, [{ label: 'a', done: true }, { label: 'b' }])).toEqual({
      updated: true,
      open: 1,
    });
    expect(await setChecklist(gate, [{ label: 'a' }])).toEqual({ updated: true, open: 1 });
  });

  it('takes 1-30 items of up to 200 characters, as objects or plain labels', async () => {
    const gate = gateInConversation();
    const execute = (items: unknown) => gate.tools[SET_CHECKLIST].execute({ items }, toolCtx);
    expect(await execute(['a', 'b'])).toMatchObject({ shown: true });
    expect(await execute(Array.from({ length: 30 }, (_, i) => `f${i}`))).toMatchObject({
      updated: true,
    });
    expect(await execute(['x'.repeat(200)])).toMatchObject({ updated: true });
    expect(() => execute(Array.from({ length: 31 }, (_, i) => `f${i}`))).toThrow(
      /items must be an array/
    );
    expect(() => execute(['x'.repeat(201)])).toThrow(/items must be an array/);
    expect(() => execute([])).toThrow(/items must be an array/);
  });

  it('accepts a JSON string of the items and rejects anything else', async () => {
    const gate = gateInConversation();
    expect(
      await gate.tools[SET_CHECKLIST].execute({ items: '[{"label":"a"}]' }, toolCtx)
    ).toMatchObject({ shown: true });
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

describe('what clears the checks', () => {
  const sandboxCall = (tool: string, input: unknown = {}): ChatToolResult => ({
    name: `sandbox__${tool}`,
    input,
    output: 'running: true',
    isError: false,
  });

  it.each([
    ['dev_server_start', { command: "sed -i 's/ok/broken/' my-app/src/App.tsx; npm run dev" }],
    ['dev_server_start', {}],
    ['dev_server_restart', { command: 'npm run dev' }],
    ['a_tool_added_later', {}],
  ])(
    'a %s call clears them, since it can run a command that changes files',
    async (tool, input) => {
      const gate = gateInConversation();
      await allPassing(gate);
      gate.onToolResult(sandboxCall(tool, input));
      const refusal = (readyDecision(gate) as { refuse: string }).refuse;
      expect(refusal).toMatch(/Run sandbox__preview_check/);
      expect(refusal).toMatch(/Run the tests/);
      expect(refusal).toMatch(/Run the typecheck/);
    }
  );

  it.each(['read_file', 'list_dir', 'dev_server_status', 'dev_server_logs', 'tunnel_status'])(
    'a %s call keeps them: it reads and changes nothing',
    async (tool) => {
      const gate = gateInConversation();
      await allPassing(gate);
      gate.onToolResult(sandboxCall(tool));
      expect(readyDecision(gate)).toEqual({ allow: true });
    }
  );

  it('a call outside the sandbox keeps them', async () => {
    const gate = gateInConversation();
    await allPassing(gate);
    gate.onToolResult({ name: 'start_preview', input: {}, output: { ok: true }, isError: false });
    gate.onToolResult({ name: 'fetch_page', input: {}, output: '# Docs', isError: false });
    expect(readyDecision(gate)).toEqual({ allow: true });
  });
});

describe('report_ready alongside other calls', () => {
  const readyResult = (gate: ReturnType<typeof createAssistantGate>) =>
    Promise.resolve(gate.tools[REPORT_READY].execute(CIVITAI, toolCtx));

  /** A gate with every check passing and no call left running. */
  async function settledAndPassing() {
    const gate = gateInConversation();
    gate.onToolResult({ name: 'sandbox__list_dir', input: {}, output: 'a', isError: false });
    await allPassing(gate);
    return gate;
  }

  it('says the app is ready when it is the only call running', async () => {
    const gate = await settledAndPassing();
    expect(readyDecision(gate)).toEqual({ allow: true });
    await expect(readyResult(gate)).resolves.toMatchObject({ ready: true });
  });

  it('fails when a call started before it in the same step is still running', async () => {
    const gate = await settledAndPassing();
    expect(gate.beforeToolCall('sandbox__write_file', {}, ctx)).toEqual({ allow: true });
    expect(readyDecision(gate)).toEqual({ allow: true });
    await expect(readyResult(gate)).rejects.toThrow(
      'Call report_ready on its own, once your other tool calls have returned: they can still change the app.'
    );
  });

  it('fails when a call of the same step starts just after it', async () => {
    const gate = await settledAndPassing();
    expect(readyDecision(gate)).toEqual({ allow: true });
    const result = readyResult(gate);
    expect(gate.beforeToolCall('sandbox__write_file', {}, ctx)).toEqual({ allow: true });
    await expect(result).rejects.toThrow(/Call report_ready on its own/);
  });

  it('says ready again once that call has returned and the app is checked again', async () => {
    const gate = await settledAndPassing();
    gate.beforeToolCall('sandbox__write_file', {}, ctx);
    gate.onToolResult(write);
    await allPassing(gate);
    await expect(readyResult(gate)).resolves.toMatchObject({ ready: true });
  });

  it('forgets calls left running by an earlier reply', async () => {
    const gate = await settledAndPassing();
    gate.beforeToolCall('sandbox__read_file', {}, ctx);
    expect(gate.beforeToolCall(REPORT_READY, CIVITAI, { ...ctx, reply: 2 })).toEqual({
      allow: true,
    });
    await expect(readyResult(gate)).resolves.toMatchObject({ ready: true });
  });

  it('ignores a call that did not run because its reply ended', async () => {
    const gate = await settledAndPassing();
    gate.onToolResult({
      ...write,
      output: { error: 'The page ended this reply before this call ran.' },
      isError: true,
      stopped: true,
    });
    gate.onToolResult({ ...run('cd my-app && npm test', 1), isError: true, stopped: true });
    expect(readyDecision(gate)).toEqual({ allow: true });
  });

  it('fails when the checks no longer pass by the time it runs', async () => {
    const gate = await settledAndPassing();
    expect(readyDecision(gate)).toEqual({ allow: true });
    gate.onToolResult(write);
    await expect(readyResult(gate)).rejects.toThrow(/^Not ready yet\. Run sandbox__preview_check/);
  });

  it('asks to be called again once a refusal is dealt with', () => {
    const decision = readyDecision(gateInConversation()) as { refuse: string };
    expect(decision.refuse).toMatch(/ Then call report_ready again\.$/);
  });
});

describe('subagent calls and the per-reply limit', () => {
  // The id of the dispatch_agent call that started the subagent, as the chat passes it.
  const child = { ...ctx, subagent: 'call-dispatch-1' };

  it('leaves a subagent’s calls out of the count, so parent and subagent calls past 150 run', () => {
    const gate = createAssistantGate();
    // 97 parent + 113 subagent = 210 calls, interleaved; the parent alone stays under 150.
    for (let i = 0; i < 113; i++) {
      if (i < 97)
        expect(gate.beforeToolCall('sandbox__read_file', {}, ctx)).toEqual({ allow: true });
      expect(gate.beforeToolCall('sandbox__read_file', {}, child)).toEqual({ allow: true });
    }
  });

  it('still ends the reply on the parent’s 151st call, however many subagent calls ran', () => {
    const gate = createAssistantGate();
    for (let i = 0; i < 150; i++) {
      expect(gate.beforeToolCall('sandbox__list_dir', {}, ctx)).toEqual({ allow: true });
      expect(gate.beforeToolCall('sandbox__list_dir', {}, child)).toEqual({ allow: true });
    }
    expect(gate.beforeToolCall('sandbox__list_dir', {}, ctx)).toEqual(STOP_AT_LIMIT);
    // The chat itself ends subagents still running when the reply ends; the page never refuses them.
    expect(gate.beforeToolCall('sandbox__list_dir', {}, child)).toEqual({ allow: true });
  });

  it('counts the dispatch_agent call itself, which is the parent’s', () => {
    const gate = createAssistantGate();
    for (let i = 0; i < 149; i++) gate.beforeToolCall('sandbox__read_file', {}, ctx);
    expect(gate.beforeToolCall('dispatch_agent', {}, ctx)).toEqual({ allow: true });
    expect(gate.beforeToolCall('dispatch_agent', {}, ctx)).toEqual(STOP_AT_LIMIT);
  });
});

describe('report_ready while a subagent runs', () => {
  const readyResult = (gate: ReturnType<typeof createAssistantGate>) =>
    Promise.resolve(gate.tools[REPORT_READY].execute(CIVITAI, toolCtx));
  const dispatched: ChatToolResult = {
    name: 'dispatch_agent',
    input: { task: 'Find where auth is handled', mode: 'read' },
    output: {
      kind: 'subagent',
      status: 'done',
      summary: 'In src/auth.ts.',
      steps: 3,
      toolCalls: 2,
      activity: [],
    },
    isError: false,
  };
  const childRead: ChatToolResult = {
    name: 'sandbox__read_file',
    input: { path: 'my-app/src/auth.ts' },
    output: 'export {}',
    isError: false,
    subagent: 'call-dispatch-1',
  };

  async function passingGate() {
    const gate = gateInConversation();
    gate.onToolResult({ name: 'sandbox__list_dir', input: {}, output: 'a', isError: false });
    await allPassing(gate);
    return gate;
  }

  it('fails while a dispatch_agent of the same step has not returned', async () => {
    const gate = await passingGate();
    expect(gate.beforeToolCall('dispatch_agent', dispatched.input, ctx)).toEqual({ allow: true });
    // The subagent's own calls come and go meanwhile.
    gate.beforeToolCall(childRead.name, childRead.input, { ...ctx, subagent: 'call-dispatch-1' });
    gate.onToolResult(childRead);
    expect(readyDecision(gate)).toEqual({ allow: true });
    await expect(readyResult(gate)).rejects.toThrow(/Call report_ready on its own/);
  });

  it('says ready once the subagent returned, since it only read', async () => {
    const gate = await passingGate();
    gate.beforeToolCall('dispatch_agent', dispatched.input, ctx);
    gate.beforeToolCall(childRead.name, childRead.input, { ...ctx, subagent: 'call-dispatch-1' });
    gate.onToolResult(childRead);
    gate.onToolResult(dispatched);
    await expect(readyResult(gate)).resolves.toMatchObject({ ready: true });
  });
});

describe('the ready card', () => {
  it('says what was checked: a test browser in the sandbox, not the user’s live preview', () => {
    expect(READY_CARD_TEXT).toBe(
      '✓ Checked: the app renders in a test browser, the tests and the typecheck pass, and every checklist item is done.'
    );
  });
});
