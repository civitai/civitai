import { describe, expect, it } from 'vitest';
import { REPORT_READY, createAssistantGate } from '~/components/Apps/AppAssistant/assistantGate';
import {
  APP_ASSISTANT_SUBAGENTS,
  APP_ASSISTANT_SUBAGENT_TOOLS,
} from '~/components/Apps/AppAssistant/assistantSubagents';

const ctx = { conversationId: 'conv-1', reply: 1 };
const toolCtx = { signal: new AbortController().signal, conversationId: 'conv-1', files: [] };

describe('the tools a subagent gets', () => {
  // A tool added here can let a subagent change the app, what report_ready counts as checked, or spend Buzz.
  it('are exactly these read-only tools', () => {
    expect([...APP_ASSISTANT_SUBAGENT_TOOLS].sort()).toEqual([
      'get_guide',
      'sandbox__dev_server_logs',
      'sandbox__dev_server_status',
      'sandbox__list_dir',
      'sandbox__read_file',
    ]);
    expect(APP_ASSISTANT_SUBAGENTS.tools).toBe(APP_ASSISTANT_SUBAGENT_TOOLS);
  });

  it('leave the caps and the model to the chat', () => {
    expect(Object.keys(APP_ASSISTANT_SUBAGENTS).sort()).toEqual(['instructions', 'tools']);
  });

  it('come with these rules: a reworded rule must be re-read here', () => {
    expect(APP_ASSISTANT_SUBAGENTS.instructions).toBe(
      [
        'You are helping App Assistant, which builds a Civitai App Block for the user inside their own hosted sandbox.',
        '- Files live under /workspace; each app is a project in its <blockId> directory there. Give paths relative to /workspace.',
        '- You can only read files, list directories, read the dev server’s status and logs, and read the guide. You cannot change files, run commands or fetch web pages.',
        '- Files under <blockId>/scratch/ are throwaway probes, not part of the app.',
        '- If you say how to check the app, give the tests and the typecheck as cd <blockId> && npm test and cd <blockId> && npx tsc --noEmit, each on its own and unpiped.',
        '- The user knows each sandbox as one of their apps: say "your app", never "sandbox".',
        '- Keep your findings to at most 200 words.',
      ].join('\n')
    );
  });

  it('never clear the checks report_ready relies on when a subagent calls them', async () => {
    const gate = createAssistantGate();
    gate.beforeToolCall('sandbox__list_dir', {}, ctx);
    gate.onToolResult({ name: 'sandbox__list_dir', input: {}, output: 'a', isError: false });
    await gate.tools.set_checklist.execute({ items: [{ label: 'A', done: true }] }, toolCtx);
    gate.onToolResult({
      name: 'sandbox__preview_check',
      input: {},
      output: 'render: ok',
      isError: false,
    });
    for (const command of ['cd a && npm test', 'cd a && npx tsc --noEmit'])
      gate.onToolResult({
        name: 'sandbox__run_command',
        input: { command },
        output: 'exit_code: 0\n---\nok',
        isError: false,
      });

    for (const name of APP_ASSISTANT_SUBAGENT_TOOLS) {
      const child = { ...ctx, subagent: `call-${name}` };
      expect(gate.beforeToolCall(name, { path: 'a/src/x.ts' }, child)).toEqual({ allow: true });
      gate.onToolResult({
        name,
        input: { path: 'a/src/x.ts' },
        output: 'text',
        isError: false,
        subagent: `call-${name}`,
      });
    }
    await expect(
      Promise.resolve(gate.tools[REPORT_READY].execute({ data: 'civitai' }, toolCtx))
    ).resolves.toMatchObject({ ready: true });
  });
});
