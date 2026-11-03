import { describe, expect, it, vi } from 'vitest';
import {
  APP_ASSISTANT_RULES,
  APP_ASSISTANT_SUBAGENT_TOOLS,
  DOCS_BODY_MAX_CHARS,
  DOCS_MAX_CHARS,
  NO_SANDBOX_FEATURES,
  READ_DOCS,
  REPORT_READY,
  RUN_CHECKS,
  SANDBOX_RESULT_LIMIT,
  SANDBOX_TOOL_RULES,
  SET_CHECKLIST,
  assistantRules,
  assistantSubagentInstructions,
  assistantSubagentRules,
  assistantSystemPrompt,
  changesApp,
  checkExitCodesOf,
  createDocsTool,
  createGateCore,
  docsUrlOf,
  readBody,
  reportReadyDescription,
  sandboxFeaturesOf,
  type SandboxFeatures,
  type ToolResult,
} from '@civitai/app-assistant';

const ctx = { conversationId: 'conv-1', reply: 1 };
const ALL: SandboxFeatures = { readFiles: true, batchEdits: true, runChecks: true };

/** A `sandbox__run_checks` result as the sandbox writes it (see the format's describe below). */
const checks = (test: number, typecheck: number, isError = false): ToolResult => ({
  name: RUN_CHECKS,
  input: { cwd: 'my-app' },
  output: `exit_code: ${
    test === 0 && typecheck === 0 ? 0 : 1
  }\ntest: exit_code ${test} (npm test, 3.1s)\ntypecheck: exit_code ${typecheck} (npx tsc --noEmit, 5.2s)\n${
    typecheck === 0 ? '' : '\n--- typecheck output (last 1 lines) ---\nsrc/a.ts(1,1): error\n'
  }`,
  isError,
});
const preview: ToolResult = {
  name: 'sandbox__preview_check',
  input: {},
  output: 'render: ok\npage_errors: 0',
  isError: false,
};

async function gateWith(features: SandboxFeatures | null) {
  const gate = createGateCore({ sandboxFeatures: () => features });
  gate.beforeToolCall('sandbox__list_dir', {}, ctx);
  await gate.tools[SET_CHECKLIST].execute({ items: [{ label: 'Tip calculator', done: true }] });
  gate.onToolResult(preview);
  return gate;
}
const ready = (gate: Awaited<ReturnType<typeof gateWith>>) =>
  gate.beforeToolCall(REPORT_READY, { data: 'civitai' }, ctx);

const RUN_BOTH =
  'Run sandbox__run_checks with cwd <blockId>: the tests and the typecheck have not run since your last file change or other command.';

describe('sandbox__run_checks in the gate', () => {
  it('a passing run counts as a passing test run and typecheck run', async () => {
    const gate = await gateWith(ALL);
    gate.onToolResult(checks(0, 0));
    expect(ready(gate)).toEqual({ allow: true });
  });

  it('a failing run satisfies neither, and says to run run_checks again', async () => {
    const gate = await gateWith(ALL);
    gate.onToolResult(checks(1, 1));
    expect(ready(gate)).toEqual({
      refuse:
        'Not ready yet. The last test run and the last typecheck failed. Fix them, then run sandbox__run_checks with cwd <blockId> again. Then call report_ready again.',
    });
  });

  it('a mixed run (test 0, typecheck 2) satisfies the tests but not the typecheck', async () => {
    const gate = await gateWith(ALL);
    gate.onToolResult(checks(0, 2));
    expect(ready(gate)).toEqual({
      refuse:
        'Not ready yet. The last typecheck failed. Fix it, then run sandbox__run_checks with cwd <blockId> again. Then call report_ready again.',
    });
    // And the other way round: the typecheck alone passed.
    const other = await gateWith(ALL);
    other.onToolResult(checks(3, 0));
    expect(ready(other)).toEqual({
      refuse:
        'Not ready yet. The last test run failed. Fix it, then run sandbox__run_checks with cwd <blockId> again. Then call report_ready again.',
    });
  });

  it.each([
    [
      'no exit_code line',
      'test: exit_code 0 (npm test, 3.1s)\ntypecheck: exit_code 0 (npx tsc --noEmit, 5.2s)',
    ],
    ['no check lines', 'exit_code: 0\nall good'],
    ['prose', 'tests passed, typecheck passed'],
    ['not text', { exit_code: 0 }],
  ])('a malformed result (%s) counts as neither', async (_, output) => {
    const gate = await gateWith(ALL);
    gate.onToolResult({ name: RUN_CHECKS, input: {}, output, isError: false });
    expect(ready(gate)).toEqual({
      refuse: `Not ready yet. ${RUN_BOTH} Then call report_ready again.`,
    });
  });

  it('a run the tool reports as failed passes nothing, whatever its lines say', async () => {
    const gate = await gateWith(ALL);
    gate.onToolResult(checks(0, 0, true));
    expect(ready(gate)).toHaveProperty('refuse');
  });

  it('read_files keeps what was checked; edit_file with edits[] undoes it', async () => {
    const gate = await gateWith(ALL);
    gate.onToolResult(checks(0, 0));
    gate.onToolResult({
      name: 'sandbox__read_files',
      input: { paths: ['my-app/src/a.ts', 'my-app/src/b.ts'] },
      output: '==> my-app/src/a.ts <==\nexport {}\n==> my-app/src/b.ts <==\nexport {}',
      isError: false,
    });
    expect(ready(gate)).toEqual({ allow: true });
    gate.onToolResult({
      name: 'sandbox__edit_file',
      input: { path: 'my-app/src/a.ts', edits: [{ old_string: 'a', new_string: 'b' }] },
      output: 'edited',
      isError: false,
    });
    expect(ready(gate)).toEqual({
      refuse: expect.stringContaining('Run sandbox__preview_check: it has not run since'),
    });
    expect((ready(gate) as { refuse: string }).refuse).toContain(RUN_BOTH);
  });

  it('without run_checks listed, the refusals name npm test and tsc, as before', async () => {
    for (const features of [null, NO_SANDBOX_FEATURES]) {
      const gate = await gateWith(features);
      const refusal = (ready(gate) as { refuse: string }).refuse;
      expect(refusal).toContain('cd <blockId> && npm test');
      expect(refusal).toContain('cd <blockId> && npx tsc --noEmit');
      expect(refusal).not.toContain('run_checks');
    }
  });

  it('report_ready’s description follows the sandbox', () => {
    const listed = createGateCore({ sandboxFeatures: () => ALL });
    expect(listed.tools[REPORT_READY].description).toBe(reportReadyDescription(true));
    expect(reportReadyDescription(true)).toContain(
      'sandbox__run_checks with cwd <blockId> said test: exit_code 0 and typecheck: exit_code 0'
    );
    for (const gate of [createGateCore(), createGateCore({ sandboxFeatures: () => null })]) {
      expect(gate.tools[REPORT_READY].description).toBe(reportReadyDescription(false));
      expect(gate.tools[REPORT_READY].description).not.toContain('run_checks');
      expect(gate.tools[REPORT_READY].description).toContain(
        'cd <blockId> && npm test and cd <blockId> && npx tsc --noEmit each exited 0'
      );
    }
  });

  it('run_checks and read_files cannot change the app; edit_file can', () => {
    expect(changesApp(RUN_CHECKS, { cwd: 'my-app' })).toBe(false);
    expect(changesApp('sandbox__read_files', { paths: ['a'] })).toBe(false);
    expect(changesApp('sandbox__edit_file', { edits: [] })).toBe(true);
  });

  it('checkExitCodesOf reads each check’s own line', () => {
    expect(
      checkExitCodesOf(
        'exit_code: 1\ntest: exit_code 0 (npm test, 3.1s)\ntypecheck: exit_code 2 (npx tsc --noEmit, 5.2s)\n'
      )
    ).toEqual({ tests: 0, typecheck: 2 });
    expect(checkExitCodesOf('exit_code: 1\ntest: exit_code -1 (npm test, 0.0s)')).toEqual({
      tests: -1,
    });
    // A bare line with nothing after the number still reads; a number run into text does not.
    expect(checkExitCodesOf('exit_code: 1\ntest: exit_code 3')).toEqual({ tests: 3 });
    expect(checkExitCodesOf('exit_code: 0\ntest: exit_code 0x1 (npm test, 1.0s)')).toEqual({});
    expect(checkExitCodesOf('test: exit_code 0 (npm test, 3.1s)')).toBeNull();
  });
});

// The seam with the sandbox: these reports are copied, line for line, from what the sandbox MCP
// server's run_checks writes: `exit_code: <overall>`, then one
// `<name>: exit_code <n> (<command>, <secs>s[, timed out])` line per check, then a blank line and
// each failed check's output. When that format changes, change these with it.
describe('run_checks reports in the sandbox’s own format', () => {
  const PASS = [
    'exit_code: 0',
    'test: exit_code 0 (npm test, 3.1s)',
    'typecheck: exit_code 0 (npx tsc --noEmit, 5.2s)',
    '',
  ].join('\n');
  const MIXED = [
    'exit_code: 1',
    'test: exit_code 0 (npm test, 3.1s)',
    'typecheck: exit_code 2 (npx tsc --noEmit, 5.2s)',
    '',
    '--- typecheck output (last 2 lines) ---',
    "src/a.ts(1,1): error TS2322: Type 'string' is not assignable to type 'number'.",
    'Found 1 error in src/a.ts:1',
    '',
  ].join('\n');
  const TIMED_OUT = [
    'exit_code: 1',
    'test: exit_code 0 (npm test, 3.1s)',
    'typecheck: exit_code 124 (npx tsc --noEmit, 120.0s, timed out)',
    '',
    '--- typecheck output (last 1 lines) ---',
    'still checking…',
    '',
  ].join('\n');
  // A failing check whose own output prints a passing summary line: the summary above it decides.
  const ECHOED = [
    'exit_code: 1',
    'test: exit_code 1 (npm test, 3.1s)',
    'typecheck: exit_code 0 (npx tsc --noEmit, 5.2s)',
    '',
    '--- test output (last 3 lines) ---',
    'test: exit_code 0',
    'typecheck: exit_code 0',
    'FAIL src/a.test.ts',
    '',
  ].join('\n');
  const report = (output: string): ToolResult => ({
    name: RUN_CHECKS,
    input: { cwd: 'my-app' },
    output,
    isError: false,
  });

  it('reads each check’s exit code from its summary line', () => {
    expect(checkExitCodesOf(PASS)).toEqual({ tests: 0, typecheck: 0 });
    expect(checkExitCodesOf(MIXED)).toEqual({ tests: 0, typecheck: 2 });
    expect(checkExitCodesOf(TIMED_OUT)).toEqual({ tests: 0, typecheck: 124 });
    expect(checkExitCodesOf(ECHOED)).toEqual({ tests: 1, typecheck: 0 });
  });

  it('a passing report lets report_ready through', async () => {
    const gate = await gateWith(ALL);
    gate.onToolResult(report(PASS));
    expect(ready(gate)).toEqual({ allow: true });
  });

  it('a failed or timed-out typecheck fails only the typecheck', async () => {
    for (const output of [MIXED, TIMED_OUT]) {
      const gate = await gateWith(ALL);
      gate.onToolResult(report(output));
      expect(ready(gate)).toEqual({
        refuse:
          'Not ready yet. The last typecheck failed. Fix it, then run sandbox__run_checks with cwd <blockId> again. Then call report_ready again.',
      });
    }
  });

  it('a passing line in a failed check’s output does not pass it', async () => {
    const gate = await gateWith(ALL);
    gate.onToolResult(report(ECHOED));
    expect(ready(gate)).toEqual({
      refuse:
        'Not ready yet. The last test run failed. Fix it, then run sandbox__run_checks with cwd <blockId> again. Then call report_ready again.',
    });
    // Nor does one when the summary line is missing: only the lines before the output count.
    expect(
      checkExitCodesOf('exit_code: 1\n\n--- test output (last 1 lines) ---\ntest: exit_code 0\n')
    ).toEqual({});
  });
});

describe('the sandbox’s newer tools', () => {
  it('are read from its own tool list', () => {
    expect(
      sandboxFeaturesOf([{ name: 'read_file' }, { name: 'edit_file', inputSchema: {} }])
    ).toEqual(NO_SANDBOX_FEATURES);
    expect(
      sandboxFeaturesOf([
        { name: 'read_files' },
        { name: 'run_checks' },
        {
          name: 'edit_file',
          inputSchema: { type: 'object', properties: { edits: { type: 'array' } } },
        },
      ])
    ).toEqual(ALL);
  });

  it('a subagent may read several files, never run the checks or edit', () => {
    expect(APP_ASSISTANT_SUBAGENT_TOOLS).toContain('sandbox__read_files');
    expect(APP_ASSISTANT_SUBAGENT_TOOLS).toContain(READ_DOCS);
    expect(APP_ASSISTANT_SUBAGENT_TOOLS).not.toContain(RUN_CHECKS);
    expect(APP_ASSISTANT_SUBAGENT_TOOLS).not.toContain('sandbox__edit_file');
  });

  it('the sandbox server’s result limit is 6,000 then 18,000 characters', () => {
    expect(SANDBOX_RESULT_LIMIT).toEqual({ head: 6000, tail: 18000 });
  });
});

describe('the rules name the newer tools only when the sandbox lists them', () => {
  const NEW_TOOLS = /sandbox__read_files|sandbox__run_checks|edits: \[/;

  it('not listed: the rules are exactly as before', () => {
    for (const runner of ['browser', 'remote'] as const) {
      expect(assistantRules(runner, null)).toBe(assistantRules(runner));
      expect(assistantRules(runner, NO_SANDBOX_FEATURES)).toBe(assistantRules(runner));
      expect(assistantRules(runner)).not.toMatch(NEW_TOOLS);
      expect(assistantRules(runner)).not.toContain(SANDBOX_TOOL_RULES.parallel);
    }
    expect(assistantRules('browser')).toBe(APP_ASSISTANT_RULES);
  });

  it('listed: each tool’s line, the parallel-calls line, and run_checks in place of npm test', () => {
    const lines = assistantRules('remote', ALL).split('\n');
    expect(lines).toEqual(
      expect.arrayContaining([
        SANDBOX_TOOL_RULES.runChecks,
        SANDBOX_TOOL_RULES.parallel,
        SANDBOX_TOOL_RULES.readFiles,
        SANDBOX_TOOL_RULES.batchEdits,
      ])
    );
    expect(lines.filter((line) => line.includes('npm test'))).toEqual([]);
    expect(SANDBOX_TOOL_RULES.runChecks).toBe(
      '- Verify with sandbox__run_checks with cwd <blockId>: it runs the tests and the typecheck. Never pipe test output through | tail, | grep or | head.'
    );
  });

  it('only the listed ones', () => {
    const rules = assistantRules('remote', { ...NO_SANDBOX_FEATURES, readFiles: true });
    expect(rules).toContain(SANDBOX_TOOL_RULES.readFiles);
    expect(rules).not.toContain('sandbox__run_checks');
    expect(rules).not.toContain(SANDBOX_TOOL_RULES.batchEdits);
    expect(rules).toContain('cd <blockId> && npm test');
    const prompt = assistantSystemPrompt('remote', false, {
      ...NO_SANDBOX_FEATURES,
      runChecks: true,
    });
    expect(prompt('D')).toContain(SANDBOX_TOOL_RULES.runChecks);
    expect(prompt('D')).not.toContain('sandbox__read_files');
  });

  it('the runner reads its setup guide with read_docs, never curl', () => {
    const rules = assistantRules('remote');
    expect(rules).toContain(
      'Your setup guide is https://developer.civitai.com/agent-setup/in-sandbox.md; read it, and the developer.civitai.com pages it links, with read_docs (the sandbox has no internet).'
    );
    expect(rules).not.toMatch(/curl/);
    expect(assistantRules('browser')).not.toContain(READ_DOCS);
  });

  it('the runner’s subagents are told they read the docs; the page’s are not', () => {
    expect(assistantSubagentInstructions('remote')).toContain(
      'read Civitai’s developer docs with read_docs'
    );
    expect(assistantSubagentRules('remote')).toContain('reads Civitai’s developer docs');
    expect(assistantSubagentRules('remote')).toContain('fetch other web pages');
    expect(assistantSubagentRules('browser')).not.toContain('developer docs');
  });
});

describe('read_docs', () => {
  const PAGE = 'https://developer.civitai.com/agent-setup/in-sandbox.md';
  const text = (body: string, init: ResponseInit = {}) =>
    new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/markdown; charset=utf-8' },
      ...init,
    });
  const tool = (fetch: typeof globalThis.fetch, timeoutMs?: number) =>
    createDocsTool({ fetch, ...(timeoutMs !== undefined ? { timeoutMs } : {}) });
  const read = (t: ReturnType<typeof createDocsTool>, url: string) =>
    Promise.resolve(t.execute({ url }));
  /** A read by a caller that can be stopped: the runner hands execute its signal. */
  const readStoppable = (t: ReturnType<typeof createDocsTool>, url: string, signal: AbortSignal) =>
    Promise.resolve(
      (t.execute as (input: Record<string, unknown>, context: { signal: AbortSignal }) => unknown)(
        { url },
        { signal }
      )
    );

  it('reads a developer.civitai.com page', async () => {
    const fetch = vi.fn(async (_url: string) => text('# Setup\nRun npx.'));
    await expect(read(tool(fetch as never), PAGE)).resolves.toEqual({
      url: PAGE,
      text: '# Setup\nRun npx.',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![0]).toBe(PAGE);
  });

  it.each([
    'https://civitai.com/agent-setup/in-sandbox.md',
    'http://developer.civitai.com/x.md',
    'https://developer.civitai.com.example.org/x.md',
    'https://user:pass@developer.civitai.com/x.md',
    'https://developer.civitai.com:8443/x.md',
    'file:///etc/passwd',
    'not a url',
  ])('refuses %s without fetching', async (url) => {
    const fetch = vi.fn(async () => text('no'));
    await expect(read(tool(fetch), url)).rejects.toThrow(
      'read_docs reads only https://developer.civitai.com/ pages'
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(docsUrlOf(url)).toBeNull();
  });

  it('follows a redirect within developer.civitai.com, never one off it', async () => {
    const within = vi.fn(async (url: string) =>
      url === PAGE
        ? new Response(null, { status: 301, headers: { location: '/agent-setup/v2.md' } })
        : text(`page at ${url}`)
    );
    await expect(read(tool(within as never), PAGE)).resolves.toMatchObject({
      text: 'page at https://developer.civitai.com/agent-setup/v2.md',
    });

    const off = vi.fn(
      async () =>
        new Response(null, { status: 302, headers: { location: 'https://example.org/x.md' } })
    );
    await expect(read(tool(off), PAGE)).rejects.toThrow(
      'redirects outside https://developer.civitai.com/'
    );
    expect(off).toHaveBeenCalledTimes(1);
  });

  it('fails within its timeout when the host never answers, even a fetch deaf to its signal', async () => {
    const fetch = vi.fn(() => new Promise<Response>(() => undefined));
    const started = Date.now();
    await expect(read(tool(fetch, 30), PAGE)).rejects.toThrow('did not answer within');
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('fails with a clear error when it cannot connect', async () => {
    const fetch = vi.fn(async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    });
    await expect(read(tool(fetch), PAGE)).rejects.toThrow(
      'Could not reach developer.civitai.com (ECONNREFUSED). Go on without it.'
    );
  });

  it('cuts a long page at 16,000 characters, with a note', async () => {
    const fetch = vi.fn(async () => text('a'.repeat(DOCS_MAX_CHARS) + 'b'.repeat(4_321)));
    const { text: got } = (await read(tool(fetch), PAGE)) as { text: string };
    expect(DOCS_MAX_CHARS).toBe(16_000);
    expect(got).toBe(
      `${'a'.repeat(16_000)}\n\n[cut: 4,321 more characters not shown; read on with offset 16000]`
    );
  });

  it('reads on from the offset a cut note names, from the one fetch', async () => {
    // 40,007 characters, each 1,000-character block its own letter, so a part's position shows.
    const page = Array.from({ length: 40 }, (_, i) =>
      String.fromCharCode(65 + (i % 26)).repeat(1_000)
    )
      .join('')
      .concat('the end');
    const fetch = vi.fn(async () => text(page));
    const t = tool(fetch);
    const at = async (offset?: number | string) =>
      (
        (await t.execute({ url: PAGE, ...(offset !== undefined ? { offset } : {}) })) as {
          text: string;
        }
      ).text;

    const first = await at();
    expect(first).toBe(
      `${page.slice(
        0,
        16_000
      )}\n\n[cut: 24,007 more characters not shown; read on with offset 16000]`
    );
    const second = await at(16_000);
    expect(second).toBe(
      `[from character 16,000 of 40,007]\n\n${page.slice(
        16_000,
        32_000
      )}\n\n[cut: 8,007 more characters not shown; read on with offset 32000]`
    );
    expect(await at('32000')).toBe(`[from character 32,000 of 40,007]\n\n${page.slice(32_000)}`);
    // Every part read back to back is the whole page.
    expect(page.slice(0, 16_000) + page.slice(16_000, 32_000) + page.slice(32_000)).toBe(page);
    expect(fetch).toHaveBeenCalledTimes(1);

    await expect(at(40_007)).rejects.toThrow('is 40,007 characters; offset 40,007 is past its end');
    for (const bad of [-1, 1.5, 'ten', Number.NaN])
      await expect(at(bad as never)).rejects.toThrow('offset must be a whole number');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('one caller stopping does not fail another reading the same page', async () => {
    let answer!: (r: Response) => void;
    const fetch = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          answer = resolve;
          init?.signal?.addEventListener('abort', () => reject(new DOMException('', 'AbortError')));
        })
    );
    const t = tool(fetch as never);
    const stopper = new AbortController();
    const stoppedRead = readStoppable(t, PAGE, stopper.signal);
    const otherRead = read(t, PAGE);
    stopper.abort();
    await expect(stoppedRead).rejects.toThrow('read_docs was stopped.');
    answer(text('guide'));
    await expect(otherRead).resolves.toMatchObject({ text: 'guide' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((fetch.mock.calls[0]![1] as RequestInit).signal!.aborted).toBe(false);
  });

  it('when every caller stops, the fetch is aborted and not kept', async () => {
    const signals: AbortSignal[] = [];
    let calls = 0;
    const fetch = vi.fn((_url: string, init?: RequestInit) => {
      signals.push(init!.signal!);
      if (++calls > 1) return Promise.resolve(text('second'));
      return new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener('abort', () => reject(new DOMException('', 'AbortError')))
      );
    });
    const t = tool(fetch as never);
    const stopper = new AbortController();
    const read1 = readStoppable(t, PAGE, stopper.signal);
    stopper.abort();
    await expect(read1).rejects.toThrow('read_docs was stopped.');
    expect(signals[0]!.aborted).toBe(true);
    await expect(read(t, PAGE)).resolves.toMatchObject({ text: 'second' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('reads at most the body cap of a response, and stops reading it there', async () => {
    let pulled = 0;
    const chunk = new TextEncoder().encode('x'.repeat(100_000));
    // Ends itself after 50 chunks, so a reader that lost its cap fails the count below
    // instead of reading forever.
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        if (pulled > 50) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const body = await readBody(new Response(endless), DOCS_BODY_MAX_CHARS);
    expect(body.length).toBe(DOCS_BODY_MAX_CHARS);
    expect(DOCS_BODY_MAX_CHARS).toBe(1_000_000);
    // 10 chunks reach the cap; the stream's high-water mark may pull one more ahead.
    expect(pulled).toBeLessThanOrEqual(12);
  });

  it('reads a page once per tool: a repeat is free, a failure is tried again', async () => {
    const fetch = vi.fn(async () => text('guide'));
    const t = tool(fetch);
    await read(t, PAGE);
    await read(t, `${PAGE}#section`);
    expect(fetch).toHaveBeenCalledTimes(1);
    // A new reply's tool reads it again.
    await read(tool(fetch), PAGE);
    expect(fetch).toHaveBeenCalledTimes(2);

    let fail = true;
    const flaky = vi.fn(async () => {
      if (fail) throw new TypeError('fetch failed');
      return text('back');
    });
    const f = tool(flaky);
    await expect(read(f, PAGE)).rejects.toThrow('Could not reach');
    fail = false;
    await expect(read(f, PAGE)).resolves.toMatchObject({ text: 'back' });
    expect(flaky).toHaveBeenCalledTimes(2);
  });

  it('turns an HTML page into readable text', async () => {
    const fetch = vi.fn(async () =>
      text(
        '<html><head><title>x</title><script>evil()</script></head><body><h2>Install</h2><p>Run <code>npm i</code> &amp; go.</p><ul><li>one</li><li>two</li></ul></body></html>',
        { headers: { 'content-type': 'text/html' } }
      )
    );
    const { text: got } = (await read(tool(fetch), PAGE)) as { text: string };
    expect(got).toBe('## Install\n\nRun npm i & go.\n\n- one\n- two');
  });

  it('refuses a page that is not text', async () => {
    const fetch = vi.fn(async () => text('x', { headers: { 'content-type': 'image/png' } }));
    await expect(read(tool(fetch), PAGE)).rejects.toThrow('is not a text page (image/png)');
  });
});
