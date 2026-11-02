import { describe, expect, it, vi } from 'vitest';
import type { ChatToolResult } from '@civitai/components-chat/civitai-chat';
import { NEW_APP_FAILED_KEEP_OPEN, changesApp, openAppNotChosen } from '@civitai/app-assistant';
import {
  KEEP_LIMIT,
  NO_APP_REFUSAL,
  createAppTools,
} from '~/components/Apps/AppAssistant/appTools';
import { SET_CHECKLIST, createAssistantGate } from '~/components/Apps/AppAssistant/assistantGate';
import type { Sandbox } from '~/components/Apps/AppAssistant/sandboxClient';
import { SandboxApiError } from '~/components/Apps/AppAssistant/sandboxClient';
import { buildAssistantInstructions } from '~/components/Apps/AppAssistant/assistantInstructions';

const OPEN = 'buzz-dashboard';

const sandbox = (app: string): Sandbox => ({
  name: `sbx-${app}`,
  app,
  state: 'running',
  mcpUrl: `https://sandbox.example/s/${app}/mcp`,
  createdAt: null,
  lastActivityAt: null,
  expiresAt: null,
});

/** Sandbox calls that can change the app. */
const CHANGES: readonly (readonly [string, Record<string, unknown>])[] = [
  ['sandbox__delete_path', { path: `${OPEN}/src/block.ts` }],
  ['sandbox__write_file', { path: `${OPEN}/src/block.ts`, content: 'explorer' }],
  ['sandbox__edit_file', { path: `${OPEN}/block.manifest.json` }],
  ['sandbox__run_command', { command: `cd ${OPEN} && rm -rf src` }],
  ['sandbox__dev_server_start', { command: `cd ${OPEN} && npm run dev` }],
  ['sandbox__dev_server_restart', {}],
  // One the sandbox may add later: refused until it is known to read only.
  ['sandbox__move_path', { from: 'a', to: 'b' }],
];
const READS: readonly (readonly [string, Record<string, unknown>])[] = [
  ['sandbox__list_dir', { path: OPEN }],
  ['sandbox__read_file', { path: `${OPEN}/src/block.ts` }],
  ['sandbox__preview_check', {}],
  ['sandbox__dev_server_logs', {}],
  ['sandbox__run_command', { command: `cd ${OPEN} && npm test` }],
  ['sandbox__run_command', { command: `cd ${OPEN} && npx tsc --noEmit` }],
  ['start_preview', {}],
];

/** The page's gate and app tools, as `AppAssistantWorkspace` builds them. */
function workspace({
  apps = [sandbox(OPEN)],
  open = vi.fn(async (app: string) => ({ sandbox: sandbox(app), created: true })),
}: {
  apps?: Sandbox[];
  open?: (app: string) => Promise<{ sandbox: Sandbox; created: boolean }>;
} = {}) {
  const live: { active: Sandbox | null } = { active: apps[0] ?? null };
  const appTools = createAppTools({
    apps: () => apps,
    current: () => live.active,
    open: async (app) => {
      const opened = await open(app);
      live.active = opened.sandbox;
      return opened;
    },
  });
  const gate = createAssistantGate({
    refuse: (name) =>
      name === SET_CHECKLIST && !live.active ? NO_APP_REFUSAL : appTools.refusal(name),
    onReply: appTools.newReply,
    currentApp: () => live.active?.name ?? null,
    openApp: () => live.active?.app ?? null,
  });
  /** One call as the chat makes it: the gate first, then (allowed) the tool, then its result. */
  const call = async (
    name: string,
    input: Record<string, unknown>,
    ctx: { conversationId: string; reply: number }
  ) => {
    const decision = await gate.beforeToolCall(name, input, ctx);
    if (!decision || !('allow' in decision)) return decision;
    const tool = appTools.tools[name];
    let result: ChatToolResult;
    try {
      const output = tool ? await tool.execute(input) : 'done';
      result = { name, input, output, isError: false };
    } catch (error) {
      result = { name, input, output: { error: (error as Error).message }, isError: true };
    }
    gate.onToolResult(result);
    return result.isError ? { error: (result.output as { error: string }).error } : decision;
  };
  /** The open chat, as `chat-change` names it. */
  const shown = { chatId: null as string | null };
  const tools = gate.restoringChoices(appTools.tools, () => shown.chatId);
  /** A saved call as a reopened chat renders it. */
  const render = (name: string, state: 'done' | 'error', output: unknown) =>
    tools[name].render?.({ name, input: {}, state, output });
  return { live, gate, call, open, shown, render };
}

const NEW_CHAT = { conversationId: 'chat-new', reply: 1 };

describe('a new chat beside an open app', () => {
  it('refuses every call that can change the open app, naming it, and lets reads through', async () => {
    const { call } = workspace();
    for (const [name, input] of CHANGES)
      expect(await call(name, input, NEW_CHAT), name).toEqual({ refuse: openAppNotChosen(OPEN) });
    for (const [name, input] of READS)
      expect(await call(name, input, NEW_CHAT), name).toEqual({ allow: true });
  });

  it('the refusal offers a new app, choosing the open one, and asking, and names the open app', () => {
    expect(openAppNotChosen(OPEN)).toBe(
      'Nothing in buzz-dashboard was changed: this chat has not been asked to change it. If the user asked for a different app, call create_app to make a new one and leave buzz-dashboard as it is. If they clearly asked to change buzz-dashboard itself, call use_open_app with app buzz-dashboard, then make the change. If it is not clear which, ask them "Make a new app, or replace buzz-dashboard?" and wait for their answer.'
    );
  });

  it('create_app makes the new app, and the chat then changes only that one', async () => {
    const { call, live, gate, open } = workspace();
    expect(await call('create_app', { name: 'LoRA explorer' }, NEW_CHAT)).toEqual({ allow: true });
    expect(open).toHaveBeenCalledWith('lora-explorer');
    // The page resets its gate as the new app opens (after the result): what was chosen stays.
    gate.reset();
    expect(live.active?.app).toBe('lora-explorer');
    const next = { ...NEW_CHAT, reply: 2 };
    expect(await call('sandbox__write_file', { path: 'lora-explorer/a' }, next)).toEqual({
      allow: true,
    });
    // The user picks the dashboard again from the switcher: this chat did not choose it.
    live.active = sandbox(OPEN);
    expect(await call('sandbox__write_file', { path: `${OPEN}/a` }, next)).toEqual({
      refuse: openAppNotChosen(OPEN),
    });
  });

  it('a follow-up in the same chat that chose the open app changes it (not over-fixed)', async () => {
    const { call } = workspace();
    expect(await call('use_open_app', { app: OPEN }, NEW_CHAT)).toEqual({ allow: true });
    for (const reply of [1, 2, 3])
      expect(
        await call('sandbox__write_file', { path: `${OPEN}/a` }, { ...NEW_CHAT, reply })
      ).toEqual({ allow: true });
  });

  it('another new chat after that does not inherit the choice', async () => {
    const { call } = workspace();
    await call('use_open_app', { app: OPEN }, NEW_CHAT);
    const another = { conversationId: 'chat-another', reply: 1 };
    expect(await call('sandbox__write_file', { path: `${OPEN}/a` }, another)).toEqual({
      refuse: openAppNotChosen(OPEN),
    });
    expect(
      await call('sandbox__write_file', { path: `${OPEN}/a` }, { ...NEW_CHAT, reply: 2 })
    ).toEqual({ allow: true });
  });

  it('use_open_app chooses only the app open now, and none when no app is open', async () => {
    const { call, live } = workspace();
    expect(await call('use_open_app', { app: 'lora-explorer' }, NEW_CHAT)).toEqual({
      error: expect.stringMatching(/^The app open now is buzz-dashboard, not lora-explorer\./),
    });
    expect(await call('sandbox__write_file', { path: `${OPEN}/a` }, NEW_CHAT)).toEqual({
      refuse: openAppNotChosen(OPEN),
    });
    live.active = null;
    expect(await call('use_open_app', { app: OPEN }, NEW_CHAT)).toMatchObject({
      error: expect.stringMatching(/^No app is open/),
    });
  });

  it('create_app finding an app the user already had does not choose it: they are asked first', async () => {
    const { call } = workspace({
      open: async (app) => ({ sandbox: sandbox(app), created: false }),
    });
    expect(await call('create_app', { name: 'Tip calculator' }, NEW_CHAT)).toEqual({
      allow: true,
    });
    expect(await call('sandbox__write_file', { path: 'tip-calculator/a' }, NEW_CHAT)).toEqual({
      refuse: openAppNotChosen('tip-calculator'),
    });
  });

  it('create_app naming the open app makes nothing, so it does not choose it either', async () => {
    const { call, open } = workspace();
    expect(await call('create_app', { name: 'Buzz dashboard' }, NEW_CHAT)).toEqual({
      allow: true,
    });
    expect(open).not.toHaveBeenCalled();
    expect(await call('sandbox__write_file', { path: `${OPEN}/a` }, NEW_CHAT)).toEqual({
      refuse: openAppNotChosen(OPEN),
    });
  });

  it('a gate without openApp refuses nothing (the control: the option is what turns it on)', async () => {
    const gate = createAssistantGate();
    expect(gate.beforeToolCall('sandbox__write_file', {}, NEW_CHAT)).toEqual({ allow: true });
  });

  it('changesApp: reads and the bare check runs only are not changes', () => {
    for (const [name, input] of CHANGES) expect(changesApp(name, input), name).toBe(true);
    for (const [name, input] of READS) expect(changesApp(name, input), name).toBe(false);
    // A check with anything after it is a command like any other.
    expect(changesApp('sandbox__run_command', { command: 'npm test && rm -rf src' })).toBe(true);
  });
});

describe('at the kept-apps limit', () => {
  const atLimit = () =>
    workspace({
      open: async () => {
        throw new SandboxApiError('sandbox limit (3) reached; delete one first', 409, 'limit');
      },
    });

  it('the user is told, and the open app is neither chosen nor changed in the new one’s place', async () => {
    const { call, live } = atLimit();
    expect(await call('create_app', { name: 'LoRA explorer' }, NEW_CHAT)).toEqual({
      error: KEEP_LIMIT,
    });
    expect(await call('use_open_app', { app: OPEN }, NEW_CHAT)).toEqual({
      refuse: NEW_APP_FAILED_KEEP_OPEN,
    });
    for (const [name, input] of CHANGES)
      expect(await call(name, input, NEW_CHAT), name).toEqual({ refuse: openAppNotChosen(OPEN) });
    expect(live.active?.app).toBe(OPEN);
  });

  it('the user’s answer in the next reply may choose the open app (replace it on their yes)', async () => {
    const { call } = atLimit();
    await call('create_app', { name: 'LoRA explorer' }, NEW_CHAT);
    const answer = { ...NEW_CHAT, reply: 2 };
    expect(await call('use_open_app', { app: OPEN }, answer)).toEqual({ allow: true });
    expect(await call('sandbox__write_file', { path: `${OPEN}/a` }, answer)).toEqual({
      allow: true,
    });
  });

  it('NEGATIVE CONTROL: without a failed create_app, use_open_app is not refused', async () => {
    const { call } = workspace();
    expect(await call('use_open_app', { app: OPEN }, NEW_CHAT)).toEqual({ allow: true });
  });
});

describe('what the assistant is told about the open app', () => {
  // Instructions alone are not the control; the gate is.
  it.each(['browser', 'remote'] as const)('on the %s runner', (runner) => {
    const text = buildAssistantInstructions({
      sandbox: { name: 'sbx-1', app: OPEN, state: 'running' },
      apps: [OPEN],
      canPreview: true,
      previewHost: null,
      runner,
    });
    expect(text).toContain(
      'When the user asks for a different, new app, call create_app; the open one is paused and kept. A chat changes only an app it made or chose with use_open_app (other changes are refused): choose the open app only when the user clearly asks to change it, and when unsure, ask "Make a new app, or replace buzz-dashboard?" first.'
    );
  });
});

describe('a reloaded chat', () => {
  const SAVED = { conversationId: 'chat-saved', reply: 1 };
  const made = (app: string) => ({ app, state: 'running', note: 'n' });

  it('that made the open app may change it once its saved create_app shows', async () => {
    const { call, shown, render } = workspace();
    shown.chatId = SAVED.conversationId;
    render('create_app', 'done', made(OPEN));
    expect(await call('sandbox__write_file', { path: `${OPEN}/a` }, SAVED)).toEqual({
      allow: true,
    });
  });

  it('that chose the open app may change it once its saved use_open_app shows', async () => {
    const { call, shown, render } = workspace();
    shown.chatId = SAVED.conversationId;
    render('use_open_app', 'done', { app: OPEN, note: 'n' });
    expect(await call('sandbox__write_file', { path: `${OPEN}/a` }, SAVED)).toEqual({
      allow: true,
    });
  });

  it('that never made or chose the open app is still refused', async () => {
    const { call, shown, render } = workspace();
    shown.chatId = SAVED.conversationId;
    render('create_app', 'error', { error: KEEP_LIMIT });
    render('create_app', 'done', { ...made(OPEN), existed: true });
    render('create_app', 'done', made('another-app'));
    expect(await call('sandbox__write_file', { path: `${OPEN}/a` }, SAVED)).toEqual({
      refuse: openAppNotChosen(OPEN),
    });
  });

  it('a saved choice counts only for the chat it was shown in', async () => {
    const { call, shown, render } = workspace();
    render('create_app', 'done', made(OPEN));
    shown.chatId = 'chat-other';
    render('create_app', 'done', made(OPEN));
    expect(await call('sandbox__write_file', { path: `${OPEN}/a` }, SAVED)).toEqual({
      refuse: openAppNotChosen(OPEN),
    });
  });

  it('a saved call shown again never undoes a choice made since the reload', async () => {
    const { call, shown, render, live } = workspace({ apps: [sandbox('other-app')] });
    shown.chatId = SAVED.conversationId;
    render('create_app', 'done', made(OPEN));
    expect(await call('use_open_app', { app: 'other-app' }, SAVED)).toEqual({ allow: true });
    render('create_app', 'done', made(OPEN));
    expect(live.active?.app).toBe('other-app');
    expect(await call('sandbox__write_file', { path: 'other-app/a' }, SAVED)).toEqual({
      allow: true,
    });
  });
});
