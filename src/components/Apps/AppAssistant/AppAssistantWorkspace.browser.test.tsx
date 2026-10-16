import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { ModalsProvider } from '@mantine/modals';
import type { ChatTool } from '@civitai/components-chat/civitai-chat';
import type * as TrpcMod from '~/utils/trpc';
import type * as TokenMod from '~/components/Apps/AppAssistant/assistantToken';
import type { Sandbox } from '~/components/Apps/AppAssistant/sandboxClient';
import { SandboxApiError } from '~/components/Apps/AppAssistant/sandboxClient';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';
import { makeTrpcProxy } from '../../../../test/trpcProxyStub';

const BASE = 'https://sandbox.example';
const sandbox = (name: string, overrides: Partial<Sandbox> = {}): Sandbox => ({
  name,
  app: `app-${name.slice(-4)}`,
  state: 'running',
  mcpUrl: `${BASE}/s/${name}/mcp`,
  createdAt: null,
  lastActivityAt: null,
  expiresAt: null,
  ...overrides,
});

const m = vi.hoisted(() => ({
  chat: null as null | {
    tools: Record<string, ChatTool>;
    instructions: () => string;
    mcpServers: { id: string; url: string; label?: string }[];
    holdReason?: string;
    beforeToolCall?: (
      name: string,
      input: unknown,
      context: { conversationId: string; reply: number }
    ) => { allow: true } | { refuse: string; stop?: boolean; message?: string };
    onToolResult?: (result: {
      name: string;
      input: unknown;
      output: unknown;
      isError: boolean;
    }) => void;
    chatRef?: { current: unknown };
  },
  list: [] as Sandbox[],
  open: vi.fn(),
  openReject: null as unknown,
  start: vi.fn(),
  stop: vi.fn(),
  suspend: vi.fn(),
  remove: vi.fn(),
  newChat: vi.fn(),
  getToken: vi.fn<(opts?: unknown) => Promise<string>>(async () => 'sandbox-token'),
  enable: vi.fn(async () => 'chat-token'),
  sandboxClient: null as null | { list: () => Promise<unknown> },
  onConsentRequired: null as null | (() => void),
  openError: null as unknown,
  listError: null as unknown,
  listNeverLoaded: true,
}));

vi.mock('~/components/Apps/AppAssistant/AppAssistantChat', () => ({
  AppAssistantChat: (props: NonNullable<typeof m.chat>) => {
    m.chat = props;
    if (props.chatRef) props.chatRef.current = { newChat: m.newChat };
    return <div data-testid="chat" />;
  },
}));
vi.mock('~/components/Apps/AppAssistant/AppAssistantPreview', () => ({
  AppAssistantPreview: () => <div data-testid="preview" />,
}));
vi.mock('~/components/Apps/AppAssistant/useSandboxes', () => ({
  useSandboxes: (client: { list: () => Promise<unknown> } | null) => {
    m.sandboxClient = client;
    /** The service: finds the app's sandbox, or creates one, which the next list then includes. */
    const serve = (app: string) => {
      m.open(app);
      if (m.openReject) throw m.openReject;
      const found = m.list.find((s) => s.app === app);
      if (found) return { sandbox: found, created: false };
      const made = sandbox(`sbx-new-${app}`, { app, state: 'starting' });
      m.list = [...m.list, made];
      return { sandbox: made, created: true };
    };
    return {
      list: {
        // A list that never loaded has no data; one whose later poll failed keeps it.
        data: client && !(m.listError && m.listNeverLoaded) ? m.list : undefined,
        isSuccess: !!client,
        isLoading: false,
        error: m.listError,
      },
      open: {
        mutate: (app: string, opts?: { onSuccess?: (r: { sandbox: Sandbox }) => void }) =>
          opts?.onSuccess?.(serve(app)),
        mutateAsync: async (app: string) => serve(app),
        isPending: false,
        error: m.openError,
      },
      suspend: { mutate: m.suspend, isPending: false, error: null },
      remove: {
        mutate: (name: string, opts?: { onSuccess?: () => void }) => {
          m.remove(name);
          m.list = m.list.filter((s) => s.name !== name);
          opts?.onSuccess?.();
        },
        isPending: false,
        error: null,
      },
    };
  },
}));
vi.mock('~/components/Apps/AppAssistant/assistantToken', async (importOriginal) => ({
  ...(await importOriginal<typeof TokenMod>()),
  createAssistantTokenProvider: (opts?: { onConsentRequired?: () => void }) => {
    m.onConsentRequired = opts?.onConsentRequired ?? null;
    return { getToken: m.getToken, enable: m.enable };
  },
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  trpc: makeTrpcProxy({
    'blocks.startDevTunnel': { useMutation: () => ({ mutateAsync: m.start }) },
    'blocks.stopDevTunnel': { useMutation: () => ({ mutateAsync: m.stop }) },
  }),
}));

const { AppAssistantWorkspace } = await import('./AppAssistantWorkspace');
const { AssistantTokenError } = await import('~/components/Apps/AppAssistant/assistantToken');

const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleExample sandbox-dev-tunnel';
const ctx = { signal: new AbortController().signal, conversationId: 'c', files: [] };
const conv = { conversationId: 'c', reply: 1 };

const Workspace = () => (
  <ModalsProvider>
    <AppAssistantWorkspace canPreview sandboxUrl={BASE} />
  </ModalsProvider>
);

async function mount() {
  await page.viewport(1440, 900);
  const screen = renderWithProviders(<Workspace />);
  await expect.element(page.getByTestId('chat')).toBeInTheDocument();
  return screen;
}

/** Opens `app` from the Your apps list, as a user does. */
async function openFromYourApps(app: string) {
  await page.getByRole('button', { name: /^Your apps/ }).click();
  await page.getByRole('button', { name: new RegExp(`^${app}`) }).click();
  await expect.element(page.getByRole('dialog')).not.toBeInTheDocument();
}

async function openFirst() {
  await openFromYourApps('app-aaaa');
  await expect.element(page.getByTestId('preview')).toBeInTheDocument();
}

async function startPreview(blockId: string) {
  await m.chat!.tools.start_preview.execute({ public_key: KEY, block_id: blockId }, ctx);
}

beforeEach(() => {
  m.chat = null;
  m.list = [sandbox('sbx-aaaaaaaaaaaa'), sandbox('sbx-bbbbbbbbbbbb')];
  m.open.mockReset();
  m.openReject = null;
  m.start.mockReset().mockResolvedValue({
    sessionId: 'bki_1',
    host: 'dev-0123456789abcdef.civit.ai',
    sshHostPublicKey: 'ssh-ed25519 AAAAhostkey',
  });
  m.stop.mockReset().mockResolvedValue({ ok: true });
  m.suspend.mockReset();
  m.remove.mockReset();
  m.newChat.mockReset();
  m.getToken.mockReset().mockResolvedValue('sandbox-token');
  m.enable.mockClear();
  m.sandboxClient = null;
  m.onConsentRequired = null;
  m.openError = null;
  m.listError = null;
  m.listNeverLoaded = true;
});

describe('AppAssistantWorkspace with no apps', () => {
  test('shows only the chat: no app header, no Your apps, no preview and no Chat/Preview switch', async () => {
    m.list = [];
    await mount();
    expect(document.body.textContent).not.toMatch(/Your apps|sandbox|Preview/i);
    expect(document.querySelector('[data-testid="app-assistant-preview-pane"]')).toBeNull();
    expect(document.querySelector('[role="radiogroup"]')).toBeNull();
  });

  test('NEGATIVE CONTROL: with apps, Your apps shows how many, and an open app brings the preview and the switch', async () => {
    await mount();
    await expect
      .element(page.getByRole('button', { name: /^Your apps/ }))
      .toHaveTextContent('Your apps2');
    await expect.element(page.getByText('Describe a new app, or open one of yours.')).toBeVisible();
    await openFirst();
    expect(document.querySelector('[data-testid="app-assistant-preview-pane"]')).not.toBeNull();
    expect(document.querySelector('[role="radiogroup"]')).not.toBeNull();
  });

  test('a later poll that fails keeps the apps listed, without an alarm', async () => {
    m.listError = new SandboxApiError('Sandbox service error (503)', 503, 'unavailable');
    m.listNeverLoaded = false;
    await mount();
    await expect.element(page.getByRole('button', { name: /^Your apps/ })).toBeVisible();
    expect(document.body.textContent).not.toMatch(/could not be reached/);
    await page.getByRole('button', { name: /^Your apps/ }).click();
    await expect.element(page.getByRole('dialog').getByText('Start a new app')).toBeVisible();
    expect(document.body.textContent).not.toMatch(/could not be reached/);
  });

  test('a list that fails to load is reported, not shown as having no apps', async () => {
    m.list = [];
    m.listError = new SandboxApiError('Sandbox service error (503)', 503, 'unavailable');
    await mount();
    await expect
      .element(page.getByText('Your apps could not be reached right now. Try again in a moment.'))
      .toBeVisible();
    expect(document.body.textContent).not.toMatch(/Sandbox service error/);
  });
});

describe('AppAssistantWorkspace create_app (the first build request makes an app)', () => {
  test('creates an app named from the request, opens it and holds the chat until it runs', async () => {
    m.list = [];
    const screen = await mount();
    const result = await m.chat!.tools.create_app.execute({ name: 'Tip Calculator' }, ctx);
    expect(m.open).toHaveBeenCalledWith('tip-calculator');
    expect(result).toMatchObject({ app: 'tip-calculator', state: 'starting' });
    await expect.element(page.getByText('tip-calculator', { exact: true })).toBeVisible();
    await expect.element(page.getByText('Starting…')).toBeVisible();
    expect(m.chat!.holdReason).toBe('Your app is starting…');
    expect(m.chat!.instructions()).toMatch(/for the app "tip-calculator"/);

    // Once it runs, its tools are handed to the chat.
    m.list = [{ ...m.list[0], state: 'running' }];
    screen.rerender(<Workspace />);
    await vi.waitFor(() => expect(m.chat!.holdReason).toBeUndefined());
    expect(m.chat!.mcpServers).toEqual([
      expect.objectContaining({ id: 'sandbox', label: 'your app' }),
    ]);
  });

  test('after a limit, create_app is refused for the rest of the reply without asking the service again', async () => {
    m.list = [
      sandbox('sbx-aaaaaaaaaaaa', { state: 'suspended' }),
      sandbox('sbx-bbbbbbbbbbbb', { state: 'suspended' }),
      sandbox('sbx-cccccccccccc', { state: 'suspended' }),
    ];
    await mount();
    m.openReject = new SandboxApiError('sandbox limit (3) reached; delete one first', 409, 'limit');
    expect(m.chat!.beforeToolCall!('create_app', {}, conv)).toEqual({ allow: true });
    await expect(
      Promise.resolve(m.chat!.tools.create_app.execute({ name: 'Fourth app' }, ctx))
    ).rejects.toThrow(/Delete one under Your apps/);
    expect(m.open).toHaveBeenCalledTimes(1);

    expect(m.chat!.beforeToolCall!('create_app', {}, conv)).toEqual({
      refuse: expect.stringMatching(/^You already have as many apps as you can keep\./),
    });
    // The next reply may try again (the user may have deleted one).
    expect(m.chat!.beforeToolCall!('create_app', {}, { ...conv, reply: 2 })).toEqual({
      allow: true,
    });
  });

  test('a refused set_checklist still counts against the per-reply tool-call limit', async () => {
    m.list = [];
    await mount();
    for (let i = 0; i < 150; i++)
      expect(m.chat!.beforeToolCall!('set_checklist', {}, conv)).toHaveProperty('refuse');
    expect(m.chat!.beforeToolCall!('set_checklist', {}, conv)).toMatchObject({ stop: true });
  });

  test('numbers a name the user already has', async () => {
    m.list = [sandbox('sbx-aaaaaaaaaaaa', { app: 'tip-calculator', state: 'suspended' })];
    await mount();
    await m.chat!.tools.create_app.execute({ name: 'tip calculator' }, ctx);
    expect(m.open).toHaveBeenCalledWith('tip-calculator-2');
  });

  test('at the app limit, tells the assistant to have the user delete one, and shows why', async () => {
    m.list = [
      sandbox('sbx-aaaaaaaaaaaa', { state: 'suspended' }),
      sandbox('sbx-bbbbbbbbbbbb', { state: 'suspended' }),
      sandbox('sbx-cccccccccccc', { state: 'suspended' }),
    ];
    const screen = await mount();
    m.openReject = new SandboxApiError('sandbox limit (3) reached; delete one first', 409, 'limit');
    await expect(
      Promise.resolve(m.chat!.tools.create_app.execute({ name: 'Fourth app' }, ctx))
    ).rejects.toThrow(/Delete one under Your apps/);
    m.openError = m.openReject;
    screen.rerender(<Workspace />);
    await expect.element(page.getByText('You have as many apps as you can keep')).toBeVisible();
    await expect.element(page.getByText('Describe a new app, or open one of yours.')).toBeVisible();
  });

  test('refuses set_checklist until an app is open, then lets it through', async () => {
    m.list = [];
    await mount();
    expect(m.chat!.beforeToolCall!('set_checklist', {}, conv)).toEqual({
      refuse: expect.stringMatching(/^There is no app yet to plan features for\./),
    });
    await m.chat!.tools.create_app.execute({ name: 'Quiz' }, ctx);
    expect(m.chat!.beforeToolCall!('set_checklist', {}, conv)).toEqual({ allow: true });
  });
});

describe('AppAssistantWorkspace Your apps', () => {
  test('lists the apps in plain words and opens one', async () => {
    m.list = [sandbox('sbx-aaaaaaaaaaaa'), sandbox('sbx-bbbbbbbbbbbb', { state: 'suspended' })];
    await mount();
    await page.getByRole('button', { name: /^Your apps/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Your apps' });
    await expect.element(dialog.getByText('Running', { exact: true })).toBeVisible();
    await expect.element(dialog.getByText('Paused', { exact: true })).toBeVisible();
    expect(dialog.getByText(/^(running|suspended|starting)$/).elements()).toHaveLength(0);
    expect(document.querySelector('[role="dialog"]')!.textContent).not.toMatch(
      /suspended|sbx-|sandbox/
    );

    await dialog.getByRole('button', { name: /^app-bbbb/ }).click();
    expect(m.open).toHaveBeenCalledWith('app-bbbb');
    await expect.element(page.getByText('app-bbbb', { exact: true })).toBeVisible();
  });

  test('a paused app’s menu in the list resumes and opens it', async () => {
    m.list = [sandbox('sbx-aaaaaaaaaaaa'), sandbox('sbx-bbbbbbbbbbbb', { state: 'suspended' })];
    await mount();
    await page.getByRole('button', { name: /^Your apps/ }).click();
    await page.getByRole('button', { name: 'Actions for app-bbbb' }).click();
    await expect.element(page.getByRole('menuitem', { name: 'Pause' })).not.toBeInTheDocument();
    await page.getByRole('menuitem', { name: 'Resume' }).click();
    expect(m.open).toHaveBeenCalledWith('app-bbbb');
    await expect.element(page.getByRole('dialog')).not.toBeInTheDocument();
    await expect.element(page.getByTestId('preview')).toBeInTheDocument();
  });

  test('the open app’s menu pauses it, and a paused app offers Resume', async () => {
    const screen = await mount();
    await openFirst();
    await page.getByRole('button', { name: 'Actions for app-aaaa' }).click();
    await page.getByRole('menuitem', { name: 'Pause' }).click();
    expect(m.suspend).toHaveBeenCalledWith('sbx-aaaaaaaaaaaa');

    m.list = [{ ...m.list[0], state: 'suspended' }, m.list[1]];
    screen.rerender(<Workspace />);
    await expect.element(page.getByText('Paused', { exact: true })).toBeVisible();
    m.open.mockClear();
    await page.getByRole('button', { name: 'Resume', exact: true }).click();
    expect(m.open).toHaveBeenCalledWith('app-aaaa');
  });

  test('deletes the open app only after the confirmation, and closes it', async () => {
    await mount();
    await openFirst();
    await page.getByRole('button', { name: 'Actions for app-aaaa' }).click();
    await page.getByRole('menuitem', { name: 'Delete app' }).click();
    await page.getByRole('button', { name: 'Keep it' }).click();
    expect(m.remove).not.toHaveBeenCalled();

    await page.getByRole('button', { name: 'Actions for app-aaaa' }).click();
    await page.getByRole('menuitem', { name: 'Delete app' }).click();
    await page.getByRole('button', { name: 'Delete app' }).click();
    expect(m.remove).toHaveBeenCalledWith('sbx-aaaaaaaaaaaa');
    await expect.element(page.getByTestId('preview')).not.toBeInTheDocument();
  });

  test('deleting another app from the list leaves the open one open', async () => {
    await mount();
    await openFirst();
    await page.getByRole('button', { name: /^Your apps/ }).click();
    await page.getByRole('button', { name: 'Actions for app-bbbb' }).click();
    await page.getByRole('menuitem', { name: 'Delete app' }).click();
    await page.getByRole('button', { name: 'Delete app' }).click();
    expect(m.remove).toHaveBeenCalledWith('sbx-bbbbbbbbbbbb');
    await expect.element(page.getByTestId('preview')).toBeInTheDocument();
    await expect.element(page.getByText('app-aaaa', { exact: true }).first()).toBeVisible();
  });

  test('an open app that disappears from the list (deleted elsewhere) is closed, with its preview', async () => {
    const screen = await mount();
    await openFirst();
    await startPreview('my-app');
    m.list = [m.list[1]];
    screen.rerender(<Workspace />);
    await expect.element(page.getByTestId('preview')).not.toBeInTheDocument();
    await expect.element(page.getByText('Describe a new app, or open one of yours.')).toBeVisible();
    await vi.waitFor(() => expect(m.stop).toHaveBeenCalledWith({ sessionId: 'bki_1' }));
  });

  test('Start a new app closes the open app and starts a new chat', async () => {
    await mount();
    await openFirst();
    await page.getByRole('button', { name: /^Your apps/ }).click();
    await page.getByRole('button', { name: 'Start a new app' }).click();
    expect(m.newChat).toHaveBeenCalledTimes(1);
    await expect.element(page.getByText('Describe a new app, or open one of yours.')).toBeVisible();
    expect(document.querySelector('[data-testid="preview"]')).toBeNull();
  });
});

describe('AppAssistantWorkspace preview teardown', () => {
  test('NEGATIVE CONTROL: opening and unmounting with no preview stops nothing', async () => {
    const screen = await mount();
    await openFirst();
    screen.unmount();
    expect(m.stop).not.toHaveBeenCalled();
  });

  test('stops the preview when the page unmounts', async () => {
    const screen = await mount();
    await openFirst();
    await startPreview('my-app');
    screen.unmount();
    expect(m.stop).toHaveBeenCalledTimes(1);
    expect(m.stop).toHaveBeenCalledWith({ sessionId: 'bki_1' });
  });

  test('stops the preview when another app is opened', async () => {
    await mount();
    await openFirst();
    await startPreview('my-app');
    await openFromYourApps('app-bbbb');
    await vi.waitFor(() => expect(m.stop).toHaveBeenCalledWith({ sessionId: 'bki_1' }));
    expect(m.stop).toHaveBeenCalledTimes(1);
  });

  test('stops the preview when its app is paused', async () => {
    const screen = await mount();
    await openFirst();
    await startPreview('my-app');
    m.list = [sandbox('sbx-aaaaaaaaaaaa', { state: 'suspended' }), m.list[1]];
    screen.rerender(<Workspace />);
    await vi.waitFor(() => expect(m.stop).toHaveBeenCalledWith({ sessionId: 'bki_1' }));
    expect(m.stop).toHaveBeenCalledTimes(1);
  });
});

describe('AppAssistantWorkspace preview start racing an app switch', () => {
  test('a preview that lands after the switch is stopped, not shown for the new app', async () => {
    await mount();
    await openFirst();
    let land!: (v: unknown) => void;
    m.start.mockImplementation(() => new Promise((resolve) => (land = resolve)));
    const pending = m.chat!.tools.start_preview.execute(
      { public_key: KEY, block_id: 'my-app' },
      ctx
    );
    await openFromYourApps('app-bbbb');
    land({
      sessionId: 'bki_late',
      host: 'dev-0123456789abcdef.civit.ai',
      sshHostPublicKey: 'ssh-ed25519 AAAAhostkey',
    });
    await expect(pending).rejects.toThrow(/sandbox changed/);
    expect(m.stop).toHaveBeenCalledWith({ sessionId: 'bki_late' });
  });
});

describe('AppAssistantWorkspace MCP wiring', () => {
  test('hands the running app to the chat with the sandbox token', async () => {
    await mount();
    expect(m.chat!.mcpServers).toEqual([]);
    await openFirst();
    await vi.waitFor(() =>
      expect(m.chat!.mcpServers).toEqual([
        expect.objectContaining({ id: 'sandbox', url: `${BASE}/s/sbx-aaaaaaaaaaaa/mcp` }),
      ])
    );
  });

  test('🔴 the sandbox service and its MCP only ever get the sandbox (UserRead) token', async () => {
    await mount();
    await openFirst();
    await vi.waitFor(() => expect(m.chat!.mcpServers).toHaveLength(1));
    m.getToken.mockClear();
    await (m.chat!.mcpServers[0] as unknown as { token: () => Promise<string> }).token();
    expect(m.getToken).toHaveBeenCalledWith({ purpose: 'sandbox' });

    // The REST client: a 401 makes it ask for a refreshed token, still for the sandbox.
    const fetchSpy = vi
      .spyOn(window, 'fetch')
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sandboxes: [] }), { status: 200 }));
    m.getToken.mockClear();
    await m.sandboxClient!.list();
    expect(m.getToken.mock.calls).toEqual([
      [expect.objectContaining({ purpose: 'sandbox', refresh: false })],
      [expect.objectContaining({ purpose: 'sandbox', refresh: true })],
    ]);
    // …and it talks to the service named by the server-provided prop.
    expect(fetchSpy.mock.calls.map(([url]) => String(url))).toEqual([
      `${BASE}/v1/sandboxes`,
      `${BASE}/v1/sandboxes`,
    ]);
    fetchSpy.mockRestore();
  });

  test('🔴 never sends the token to an MCP URL outside the sandbox service', async () => {
    m.list = [sandbox('sbx-aaaaaaaaaaaa', { mcpUrl: 'https://elsewhere.example/s/x/mcp' })];
    await mount();
    await openFirst();
    expect(m.chat!.mcpServers).toEqual([]);
  });
});

describe('AppAssistantWorkspace consent', () => {
  test('asks the user to turn the assistant on, and only their click writes consent', async () => {
    m.getToken
      .mockRejectedValueOnce(
        new AssistantTokenError('Turn on App Assistant', 403, 'consent_required')
      )
      .mockResolvedValue('sandbox-token');
    await page.viewport(1440, 900);
    renderWithProviders(<Workspace />);
    const button = page.getByRole('button', { name: 'Turn on App Assistant' });
    await expect.element(button).toBeInTheDocument();
    // Give any effect a chance to fire before asserting it did not.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(m.enable).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="chat"]')).toBeNull();

    await button.click();
    expect(m.enable).toHaveBeenCalledTimes(1);
    await expect.element(page.getByTestId('chat')).toBeInTheDocument();
  });
});

describe('AppAssistantWorkspace revoke', () => {
  test('a preview start that lands after the revoke is stopped too', async () => {
    await mount();
    await openFirst();
    const tools = m.chat!.tools;
    m.getToken.mockRejectedValue(
      new AssistantTokenError('Turn on App Assistant', 403, 'consent_required')
    );
    m.onConsentRequired!();
    await expect
      .element(page.getByRole('button', { name: 'Turn on App Assistant' }))
      .toBeInTheDocument();
    expect(m.stop).not.toHaveBeenCalled();
    await tools.start_preview.execute({ public_key: KEY, block_id: 'my-app' }, ctx);
    await vi.waitFor(() => expect(m.stop).toHaveBeenCalledWith({ sessionId: 'bki_1' }));
    expect(m.stop).toHaveBeenCalledTimes(1);
  });

  test('a revoke stops a running preview', async () => {
    await mount();
    await openFirst();
    await startPreview('my-app');
    m.getToken.mockRejectedValue(
      new AssistantTokenError('Turn on App Assistant', 403, 'consent_required')
    );
    m.onConsentRequired!();
    await vi.waitFor(() => expect(m.stop).toHaveBeenCalledWith({ sessionId: 'bki_1' }));
    expect(m.stop).toHaveBeenCalledTimes(1);
  });

  test('a revoke mid-session puts the turn-on card back', async () => {
    await mount();
    m.getToken.mockRejectedValue(
      new AssistantTokenError('Turn on App Assistant', 403, 'consent_required')
    );
    m.onConsentRequired!();
    await expect
      .element(page.getByRole('button', { name: 'Turn on App Assistant' }))
      .toBeInTheDocument();
    expect(document.querySelector('[data-testid="chat"]')).toBeNull();

    // Turning it back on brings the workspace back.
    m.getToken.mockResolvedValue('sandbox-token');
    await page.getByRole('button', { name: 'Turn on App Assistant' }).click();
    expect(m.enable).toHaveBeenCalledTimes(1);
    await expect.element(page.getByTestId('chat')).toBeInTheDocument();
  });
});

describe('AppAssistantWorkspace header errors', () => {
  test('a Resume refused for the running-app limit is shown as that, without opening the drawer', async () => {
    m.list = [sandbox('sbx-aaaaaaaaaaaa', { state: 'suspended' }), sandbox('sbx-bbbbbbbbbbbb')];
    const screen = await mount();
    await openFromYourApps('app-aaaa');
    await expect.element(page.getByTestId('preview')).toBeInTheDocument();
    m.openError = new SandboxApiError(
      'running-sandbox limit (1) reached: sbx-bbbbbbbbbbbb (app "app-bbbb") is running; suspend it first',
      409,
      'limit'
    );
    screen.rerender(<Workspace />);
    await expect.element(page.getByText('Only one app can run at a time')).toBeInTheDocument();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});

describe('AppAssistantWorkspace app errors', () => {
  test('shows an error once: in the list while it is open, on the page otherwise', async () => {
    m.openError = new SandboxApiError('busy', 409, 'conflict');
    await mount();
    const copy = 'That app was changing at the same moment. Try again.';
    await expect.element(page.getByText(copy)).toBeVisible();
    await page.getByRole('button', { name: /^Your apps/ }).click();
    await expect.element(page.getByRole('dialog').getByText(copy)).toBeVisible();
    expect(page.getByText(copy).elements()).toHaveLength(1);
  });

  test('says what failed in words, not the service’s raw error', async () => {
    m.openError = new SandboxApiError('Sandbox service error (500)', 500, 'unavailable');
    await mount();
    await expect
      .element(page.getByText('Your apps could not be reached right now. Try again in a moment.'))
      .toBeVisible();
    expect(document.body.textContent).not.toMatch(/Sandbox service error/);
  });
});

describe('AppAssistantWorkspace access failure', () => {
  test('a failed access check offers Retry, which recovers without a reload', async () => {
    m.getToken
      .mockRejectedValueOnce(new AssistantTokenError('Could not start a session', 503))
      .mockResolvedValue('sandbox-token');
    await page.viewport(1440, 900);
    renderWithProviders(<Workspace />);
    const retry = page.getByRole('button', { name: 'Retry' });
    await expect.element(retry).toBeInTheDocument();
    expect(m.getToken).toHaveBeenCalledTimes(1);
    await retry.click();
    await expect.element(page.getByTestId('chat')).toBeInTheDocument();
  });

  test('a consent refusal shows the turn-on card, not Retry', async () => {
    m.getToken.mockRejectedValue(
      new AssistantTokenError('Turn on App Assistant', 403, 'consent_required')
    );
    await page.viewport(1440, 900);
    renderWithProviders(<Workspace />);
    await expect
      .element(page.getByRole('button', { name: 'Turn on App Assistant' }))
      .toBeInTheDocument();
    expect(document.body.textContent).not.toContain('Retry');
    expect(m.getToken).toHaveBeenCalledTimes(1);
  });
});

describe('AppAssistantWorkspace without a sandbox service', () => {
  test('says it cannot build apps here and asks for no token', async () => {
    await page.viewport(1440, 900);
    renderWithProviders(<AppAssistantWorkspace canPreview sandboxUrl={null} />);
    await expect
      .element(page.getByText('App Assistant can’t build apps on this deployment yet.'))
      .toBeInTheDocument();
    expect(m.getToken).not.toHaveBeenCalled();
  });
});

describe('AppAssistantWorkspace hold while the app starts', () => {
  test('holds the composer while the open app is starting, and lifts it once it runs', async () => {
    m.list = [sandbox('sbx-aaaaaaaaaaaa', { state: 'starting' })];
    const screen = await mount();
    expect(m.chat!.holdReason).toBeUndefined();
    await openFirst();
    await vi.waitFor(() => expect(m.chat!.holdReason).toBe('Your app is starting…'));
    expect(m.chat!.mcpServers).toEqual([]);

    m.list = [sandbox('sbx-aaaaaaaaaaaa')];
    screen.rerender(<Workspace />);
    await vi.waitFor(() => expect(m.chat!.holdReason).toBeUndefined());
    expect(m.chat!.mcpServers).toHaveLength(1);
  });
});

describe('AppAssistantWorkspace tool gate', () => {
  test('offers create_app, report_ready and set_checklist beside the preview tools, and refuses an unchecked ready', async () => {
    await mount();
    expect(Object.keys(m.chat!.tools).sort()).toEqual([
      'create_app',
      'report_ready',
      'set_checklist',
      'start_preview',
      'stop_preview',
    ]);
    expect(m.chat!.beforeToolCall!('report_ready', {}, conv)).toHaveProperty('refuse');
  });

  /** What the sandbox reports when the app was checked: a passing preview, tests and typecheck. */
  async function checkEverything() {
    await m.chat!.tools.set_checklist.execute({ items: [{ label: 'Avatar', done: true }] }, ctx);
    const run = (command: string) =>
      m.chat!.onToolResult!({
        name: 'sandbox__run_command',
        input: { command },
        output: 'exit_code: 0\ntimed_out: false\n---\nok',
        isError: false,
      });
    m.chat!.onToolResult!({
      name: 'sandbox__preview_check',
      input: {},
      output: 'render: ok\npage_errors: 0',
      isError: false,
    });
    run('cd my-app && npm test');
    run('cd my-app && npx tsc --noEmit');
  }

  test('allows report_ready once the chat reports passing checks, and forgets them in another app', async () => {
    await mount();
    await openFirst();
    m.chat!.beforeToolCall!('sandbox__list_dir', {}, conv);
    await checkEverything();
    expect(m.chat!.beforeToolCall!('report_ready', {}, conv)).toEqual({ allow: true });

    await openFromYourApps('app-bbbb');
    await vi.waitFor(() =>
      expect(m.chat!.beforeToolCall!('report_ready', {}, conv)).toHaveProperty('refuse')
    );
  });

  test('hands the chat a gate that ends a reply at the tool-call limit, and counts each reply afresh', async () => {
    await mount();
    for (let i = 0; i < 150; i++)
      expect(m.chat!.beforeToolCall!('sandbox__read_file', {}, conv)).toEqual({ allow: true });
    expect(m.chat!.beforeToolCall!('sandbox__read_file', {}, conv)).toMatchObject({ stop: true });
    expect(m.chat!.beforeToolCall!('sandbox__read_file', {}, { ...conv, reply: 2 })).toEqual({
      allow: true,
    });
  });
});
