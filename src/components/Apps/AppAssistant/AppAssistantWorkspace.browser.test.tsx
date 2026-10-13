import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
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
    mcpServers: { id: string; url: string }[];
  },
  list: [] as Sandbox[],
  start: vi.fn(),
  stop: vi.fn(),
  suspend: vi.fn(),
  getToken: vi.fn<(opts?: unknown) => Promise<string>>(async () => 'sandbox-token'),
  enable: vi.fn(async () => 'chat-token'),
  sandboxClient: null as null | { list: () => Promise<unknown> },
  onConsentRequired: null as null | (() => void),
  openError: null as unknown,
}));

vi.mock('~/components/Apps/AppAssistant/AppAssistantChat', () => ({
  AppAssistantChat: (props: NonNullable<typeof m.chat>) => {
    m.chat = props;
    return <div data-testid="chat" />;
  },
}));
vi.mock('~/components/Apps/AppAssistant/AppAssistantPreview', () => ({
  AppAssistantPreview: () => <div data-testid="preview" />,
}));
vi.mock('~/components/Apps/AppAssistant/useSandboxes', () => ({
  useSandboxes: (client: { list: () => Promise<unknown> } | null) => (
    (m.sandboxClient = client),
    {
      list: {
        data: client ? m.list : undefined,
        isSuccess: !!client,
        isLoading: false,
        error: null,
      },
      open: {
        mutate: (app: string, opts?: { onSuccess?: (r: { sandbox: Sandbox }) => void }) =>
          opts?.onSuccess?.({ sandbox: m.list.find((s) => s.app === app)! }),
        isPending: false,
        error: m.openError,
      },
      suspend: { mutate: m.suspend, isPending: false, error: null },
      remove: { mutate: vi.fn(), isPending: false, error: null },
    }
  ),
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

async function mount() {
  await page.viewport(1440, 900);
  const screen = renderWithProviders(<AppAssistantWorkspace canPreview sandboxUrl={BASE} />);
  await expect.element(page.getByTestId('chat')).toBeInTheDocument();
  return screen;
}

async function openFirst() {
  await page.getByRole('button', { name: 'Open', exact: true }).first().click();
  await expect.element(page.getByTestId('preview')).toBeInTheDocument();
}

async function startPreview(blockId: string) {
  await m.chat!.tools.start_preview.execute({ public_key: KEY, block_id: blockId }, ctx);
}

beforeEach(() => {
  m.chat = null;
  m.list = [sandbox('sbx-aaaaaaaaaaaa'), sandbox('sbx-bbbbbbbbbbbb')];
  m.start.mockReset().mockResolvedValue({
    sessionId: 'bki_1',
    host: 'dev-0123456789abcdef.civit.ai',
    sshHostPublicKey: 'ssh-ed25519 AAAAhostkey',
  });
  m.stop.mockReset().mockResolvedValue({ ok: true });
  m.suspend.mockReset();
  m.getToken.mockReset().mockResolvedValue('sandbox-token');
  m.enable.mockClear();
  m.sandboxClient = null;
  m.onConsentRequired = null;
  m.openError = null;
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

  test('stops the preview when another sandbox is opened', async () => {
    await mount();
    await openFirst();
    await startPreview('my-app');
    await page.getByRole('button', { name: 'Sandboxes', exact: true }).click();
    await page.getByRole('button', { name: 'Open', exact: true }).nth(1).click();
    await vi.waitFor(() => expect(m.stop).toHaveBeenCalledWith({ sessionId: 'bki_1' }));
    expect(m.stop).toHaveBeenCalledTimes(1);
  });

  test('stops the preview when its sandbox is suspended', async () => {
    const screen = await mount();
    await openFirst();
    await startPreview('my-app');
    m.list = [sandbox('sbx-aaaaaaaaaaaa', { state: 'suspended' }), m.list[1]];
    screen.rerender(<AppAssistantWorkspace canPreview sandboxUrl={BASE} />);
    await vi.waitFor(() => expect(m.stop).toHaveBeenCalledWith({ sessionId: 'bki_1' }));
    expect(m.stop).toHaveBeenCalledTimes(1);
  });
});

describe('AppAssistantWorkspace preview start racing a sandbox switch', () => {
  test('a preview that lands after the switch is stopped, not shown for the new sandbox', async () => {
    await mount();
    await openFirst();
    let land!: (v: unknown) => void;
    m.start.mockImplementation(() => new Promise((resolve) => (land = resolve)));
    const pending = m.chat!.tools.start_preview.execute(
      { public_key: KEY, block_id: 'my-app' },
      ctx
    );
    await page.getByRole('button', { name: 'Sandboxes', exact: true }).click();
    await page.getByRole('button', { name: 'Open', exact: true }).nth(1).click();
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
  test('hands the running sandbox to the chat with the sandbox token', async () => {
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
    renderWithProviders(<AppAssistantWorkspace canPreview sandboxUrl={BASE} />);
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

describe('AppAssistantWorkspace header actions', () => {
  test('a Resume refused for the running-sandbox limit is shown without opening the drawer', async () => {
    m.list = [sandbox('sbx-aaaaaaaaaaaa', { state: 'suspended' }), sandbox('sbx-bbbbbbbbbbbb')];
    const screen = await mount();
    await page.getByRole('button', { name: 'Resume', exact: true }).first().click();
    await expect.element(page.getByTestId('preview')).toBeInTheDocument();
    m.openError = new SandboxApiError(
      'running-sandbox limit (1) reached: sbx-bbbbbbbbbbbb (app "app-bbbb") is running; suspend it first',
      409,
      'limit'
    );
    screen.rerender(<AppAssistantWorkspace canPreview sandboxUrl={BASE} />);
    await expect.element(page.getByText('Sandbox limit reached')).toBeInTheDocument();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});

describe('AppAssistantWorkspace access failure', () => {
  test('a failed access check offers Retry, which recovers without a reload', async () => {
    m.getToken
      .mockRejectedValueOnce(new AssistantTokenError('Could not start a session', 503))
      .mockResolvedValue('sandbox-token');
    await page.viewport(1440, 900);
    renderWithProviders(<AppAssistantWorkspace canPreview sandboxUrl={BASE} />);
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
    renderWithProviders(<AppAssistantWorkspace canPreview sandboxUrl={BASE} />);
    await expect
      .element(page.getByRole('button', { name: 'Turn on App Assistant' }))
      .toBeInTheDocument();
    expect(document.body.textContent).not.toContain('Retry');
    expect(m.getToken).toHaveBeenCalledTimes(1);
  });
});

describe('AppAssistantWorkspace without a sandbox service', () => {
  test('says sandboxes are not configured and asks for no token', async () => {
    await page.viewport(1440, 900);
    renderWithProviders(<AppAssistantWorkspace canPreview sandboxUrl={null} />);
    await expect
      .element(page.getByText(/Sandboxes are not configured on this deployment/))
      .toBeInTheDocument();
    expect(m.getToken).not.toHaveBeenCalled();
  });
});
