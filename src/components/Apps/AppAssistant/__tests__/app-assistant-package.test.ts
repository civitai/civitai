import { describe, expect, it } from 'vitest';
import * as shared from '@civitai/app-assistant';
import * as appKey from '~/components/Apps/AppAssistant/appKey';
import * as appTools from '~/components/Apps/AppAssistant/appTools';
import * as instructions from '~/components/Apps/AppAssistant/assistantInstructions';
import * as subagents from '~/components/Apps/AppAssistant/assistantSubagents';
import * as gate from '~/components/Apps/AppAssistant/assistantGate';
import * as sandboxClient from '~/components/Apps/AppAssistant/sandboxClient';
import { openApp } from '~/components/Apps/AppAssistant/useSandboxes';

/**
 * App Assistant's rules run in two places, the page and the server runner, from one module
 * (`@civitai/app-assistant`). These pin that the page's modules ARE that module's code, not copies of
 * it, so the two cannot drift.
 */
describe('App Assistant’s rules, one place for the page and the server runner', () => {
  it('the page’s modules hand out the shared code itself', () => {
    expect(appTools.createAppTools).toBe(shared.createAppTools);
    expect(appKey.newAppKey).toBe(shared.newAppKey);
    expect(instructions.buildAssistantInstructions).toBe(shared.buildAssistantInstructions);
    expect(instructions.buildAssistantSystemPrompt).toBe(shared.buildAssistantSystemPrompt);
    expect(instructions.APP_ASSISTANT_RULES).toBe(shared.APP_ASSISTANT_RULES);
    expect(subagents.APP_ASSISTANT_SUBAGENT_TOOLS).toBe(shared.APP_ASSISTANT_SUBAGENT_TOOLS);
    expect(subagents.APP_ASSISTANT_SUBAGENTS).toBe(shared.APP_ASSISTANT_SUBAGENTS);
    expect(gate.checkKindOf).toBe(shared.checkKindOf);
    expect(gate.TURN_LIMIT_REFUSAL).toBe(shared.TURN_LIMIT_REFUSAL);
    expect(sandboxClient.createSandboxClient).toBe(shared.createSandboxClient);
    expect(sandboxClient.SandboxApiError).toBe(shared.SandboxApiError);
    expect(openApp).toBe(shared.openApp);
  });
});

describe('the instructions on the server runner', () => {
  const input = {
    sandbox: { name: 'sb-1', app: 'tip-calc', state: 'running' as const },
    apps: ['tip-calc'],
    canPreview: true,
    previewHost: null,
  };

  it('tell the assistant the preview opens by itself once the dev server starts, and to look with preview_check', () => {
    const text = shared.buildAssistantInstructions({ ...input, runner: 'remote' });
    expect(text).toContain(shared.REMOTE_PREVIEW);
    // The whole sentence: a reworded preview step must be re-read here.
    expect(shared.REMOTE_PREVIEW).toBe(
      'Live preview (it opens beside this chat in the user’s page, and you can see the same running app): start the dev server with sandbox__dev_server_start (or sandbox__dev_server_restart when one is already running) and leave it running; the preview then opens for the user by itself, and the answer of that call says so (or why it could not). Do not call start_preview to open it. To see what the user sees, call sandbox__preview_check, which loads the same dev server, with screenshot: true when how it looks matters (and viewport: mobile for a phone); if no image comes back, go by its text and never describe a picture you did not receive. sandbox__preview_check needs the dev server running: start it first, or it answers render: server_error. Call start_preview only when the user asks to reopen the preview, and stop_preview when they ask to stop it.'
    );
    // The dev server comes before the check that needs it.
    const order = ['sandbox__dev_server_start', 'sandbox__preview_check'].map((name) =>
      shared.REMOTE_PREVIEW.indexOf(name)
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The runner does the tunnel steps itself.
    expect(text).not.toMatch(/sandbox__tunnel_/);
  });

  it('without the preview, still tell the assistant to start the dev server before preview_check', () => {
    for (const runner of ['remote', 'browser'] as const) {
      const text = shared.buildAssistantInstructions({ ...input, canPreview: false, runner });
      expect(text).toContain(shared.NO_PREVIEW);
      expect(text).not.toContain(shared.REMOTE_PREVIEW);
    }
    expect(shared.NO_PREVIEW).toBe(
      'Live preview is not enabled for this account: do not call start_preview, and tell the user there is no live preview. To see the app yourself, start the dev server with sandbox__dev_server_start and leave it running, then call sandbox__preview_check (with screenshot: true when how it looks matters; if no image comes back, go by its text and never describe a picture you did not receive); it answers render: server_error until the dev server runs.'
    );
  });

  it('leave the browser’s instructions exactly as they were', () => {
    expect(shared.buildAssistantInstructions({ ...input, runner: 'browser' })).toBe(
      shared.buildAssistantInstructions(input)
    );
    expect(shared.buildAssistantInstructions(input)).toContain('call start_preview with');
  });
});

describe('the shared gate and subagents’ calls', () => {
  const ctx = { conversationId: 'c-1', reply: 1 };
  const child = 'call-dispatch-1';
  const run = (command: string, exit = 0, subagent?: string): shared.ToolResult => ({
    name: 'sandbox__run_command',
    input: { command },
    output: `exit_code: ${exit}\n---\nout`,
    isError: false,
    ...(subagent ? { subagent } : {}),
  });
  const previewOk = (subagent?: string): shared.ToolResult => ({
    name: 'sandbox__preview_check',
    input: {},
    output: 'render: ok',
    isError: false,
    ...(subagent ? { subagent } : {}),
  });

  async function readyWith(results: shared.ToolResult[]) {
    const core = shared.createGateCore();
    core.beforeToolCall('sandbox__list_dir', {}, ctx);
    await core.tools.set_checklist.execute({ items: [{ label: 'Tips', done: true }] });
    for (const result of results) core.onToolResult(result);
    return core.beforeToolCall(shared.REPORT_READY, {}, ctx);
  }

  it('the parent’s checks make report_ready pass (the control)', async () => {
    expect(
      await readyWith([previewOk(), run('cd a && npm test'), run('cd a && npx tsc --noEmit')])
    ).toEqual({ allow: true });
  });

  it('a subagent’s file change or other command undoes the parent’s checks', async () => {
    const passing = [previewOk(), run('cd a && npm test'), run('cd a && npx tsc --noEmit')];
    const write: shared.ToolResult = {
      name: 'sandbox__write_file',
      input: { path: 'a/x.ts' },
      output: 'wrote 1 bytes',
      isError: false,
      subagent: child,
    };
    expect(await readyWith([...passing, write])).toMatchObject({ refuse: expect.any(String) });
    expect(await readyWith([...passing, run('npm install', 0, child)])).toMatchObject({
      refuse: expect.any(String),
    });
  });

  it('takes the checklist a server runner showed as the one waiting for Build it', () => {
    const core = shared.createGateCore({ currentApp: () => 'sb-1' });
    core.onToolResult({
      name: shared.SET_CHECKLIST,
      input: { items: [{ label: 'Tips' }] },
      output: { shown: true, awaitsUser: true, checklist: 'runner-1' },
      isError: false,
    });
    expect(core.awaiting()).toEqual({ id: 'runner-1', app: 'sb-1' });
    // A subagent cannot show one, and a refused call showed nothing.
    const other = shared.createGateCore();
    other.onToolResult({
      name: shared.SET_CHECKLIST,
      input: {},
      output: { awaitsUser: true, checklist: 'x' },
      isError: false,
      subagent: child,
    });
    expect(other.awaiting()).toBeNull();
  });
});

/**
 * Build it is for a list the user has not confirmed yet. The list the assistant shows as it ticks items
 * off, or once the app is finished, is no such list: on the server runner every reply is a new run, so
 * the gate starts from the conversation's last checklist (`restore`), and a changed list with every
 * item done never waits for the user. A conversation's first list always waits: no build starts before
 * the user confirms one.
 */
describe('which checklists wait for Build it', () => {
  const conv = 'c-1';
  const ctx = { conversationId: conv, reply: 2 };
  const SHOWN = ['Split the bill', 'Round up the tip'];
  const items = (done: boolean[]) => SHOWN.map((label, i) => ({ label, done: done[i] }));
  /** The `set_checklist` call an earlier reply made, as the runner showed it for `tip-calc`. */
  const shownEarlier: shared.ToolResult = {
    name: shared.SET_CHECKLIST,
    input: { items: items([false, false]) },
    output: { shown: true, awaitsUser: true, checklist: 'old-1', note: 'shown', app: 'tip-calc' },
    isError: false,
  };

  /** A runner gate on `tip-calc`, started from what the conversation already did. */
  function runnerGate(earlier: shared.ToolResult[]) {
    const core = shared.createGateCore({
      checklistPrefix: 'run2',
      currentApp: () => 'sb-tip',
      checklistApp: () => 'tip-calc',
    });
    core.restore({ conversationId: conv, earlier, current: [], app: 'tip-calc' });
    core.beforeToolCall(shared.SET_CHECKLIST, {}, ctx);
    return core;
  }

  it('a later reply ticking off the shown list’s items is progress, not a list to confirm', async () => {
    const core = runnerGate([shownEarlier]);
    expect(await core.tools.set_checklist.execute({ items: items([true, false]) })).toEqual({
      updated: true,
      open: 1,
      app: 'tip-calc',
    });
    expect(await core.tools.set_checklist.execute({ items: items([true, true]) })).toEqual({
      updated: true,
      open: 0,
      app: 'tip-calc',
    });
    expect(core.awaiting()).toBeNull();
  });

  it('a first list waits for Build it even with every item done', async () => {
    const core = runnerGate([]);
    expect(await core.tools.set_checklist.execute({ items: items([true, true]) })).toMatchObject({
      shown: true,
      awaitsUser: true,
      checklist: 'run2-1',
      app: 'tip-calc',
    });
    expect(core.awaiting()).toEqual({ id: 'run2-1', app: 'sb-tip' });
  });

  it('a changed list with every item done does not wait: there is nothing left to build', async () => {
    const relabelled = runnerGate([shownEarlier]);
    expect(
      await relabelled.tools.set_checklist.execute({
        items: [
          { label: 'Split the bill evenly', done: true },
          { label: 'Round up the tip', done: true },
        ],
      })
    ).toEqual({ updated: true, open: 0, app: 'tip-calc' });
    expect(relabelled.awaiting()).toBeNull();
  });

  it('a new list, with other labels and an item open, still waits for Build it', async () => {
    const core = runnerGate([shownEarlier]);
    expect(
      await core.tools.set_checklist.execute({
        items: [{ label: 'Split the bill' }, { label: 'Pick a currency' }],
      })
    ).toMatchObject({ shown: true, awaitsUser: true, checklist: 'run2-1', app: 'tip-calc' });
    expect(core.awaiting()).toEqual({ id: 'run2-1', app: 'sb-tip' });
    // And with no earlier list at all.
    const fresh = runnerGate([]);
    expect(await fresh.tools.set_checklist.execute({ items: items([true, false]) })).toMatchObject({
      awaitsUser: true,
      checklist: 'run2-1',
    });
  });

  it('the page takes no Build it from a runner for a list with every item done', () => {
    const core = shared.createGateCore({ currentApp: () => 'sb-tip' });
    // As a runner without the all-done rule reports it.
    core.onToolResult({
      name: shared.SET_CHECKLIST,
      input: { items: items([true, true]) },
      output: { shown: true, awaitsUser: true, checklist: 'runner-7' },
      isError: false,
    });
    expect(core.awaiting()).toBeNull();
    // Control: the same report with an item open is the one waiting.
    core.onToolResult({
      name: shared.SET_CHECKLIST,
      input: { items: items([true, false]) },
      output: { shown: true, awaitsUser: true, checklist: 'runner-8' },
      isError: false,
    });
    expect(core.awaiting()).toEqual({ id: 'runner-8', app: 'sb-tip' });
  });
});
