import { beforeEach, describe, expect, test, vi } from 'vitest';
import { ModalsProvider } from '@mantine/modals';
import type { ChatTool } from '@civitai/components-chat/civitai-chat';
import type * as TrpcMod from '~/utils/trpc';
import type * as TokenMod from '~/components/Apps/AppAssistant/assistantToken';
import type { Sandbox } from '~/components/Apps/AppAssistant/sandboxClient';
import {
  box,
  cascadeEvidence,
  nextLayout,
  renderAtViewport,
} from '../../../../test/geometry-setup';
import { makeTrpcProxy } from '../../../../test/trpcProxyStub';

const BASE = 'https://sandbox.example';

const m = vi.hoisted(() => ({
  tools: null as null | Record<string, ChatTool>,
  beforeToolCall: null as null | ((name: string, input: unknown, context: unknown) => unknown),
  list: [] as Sandbox[],
  state: 'running' as Sandbox['state'],
}));

vi.mock('~/components/Apps/AppAssistant/AppAssistantChat', () => ({
  AppAssistantChat: (props: {
    tools: Record<string, ChatTool>;
    beforeToolCall: NonNullable<typeof m.beforeToolCall>;
    chatRef: { current: unknown };
  }) => {
    m.tools = props.tools;
    m.beforeToolCall = props.beforeToolCall;
    // A chat that takes no message, with something typed in its box.
    props.chatRef.current = {
      send: vi.fn(),
      compose: vi.fn(),
      draft: 'my words',
      dictating: false,
    };
    return <div data-testid="chat" className="h-full" />;
  },
}));
vi.mock('~/components/Apps/AppAssistant/AppAssistantPreview', () => ({
  AppAssistantPreview: () => <div data-testid="preview" className="h-full" />,
}));
vi.mock('~/components/Apps/AppAssistant/useSandboxes', () => ({
  useSandboxes: (client: unknown) => {
    const serve = (app: string) => {
      const created: Sandbox = {
        name: `sbx-${app}`,
        app,
        state: m.state,
        mcpUrl: `${BASE}/s/${app}/mcp`,
        createdAt: null,
        lastActivityAt: null,
        expiresAt: null,
      };
      m.list = [...m.list, created];
      return { sandbox: created, created: true };
    };
    const idle = { mutate: vi.fn(), isPending: false, error: null };
    return {
      list: {
        data: client ? m.list : undefined,
        isSuccess: !!client,
        isLoading: false,
        error: null,
      },
      open: { ...idle, mutateAsync: async (app: string) => serve(app) },
      suspend: idle,
      remove: idle,
    };
  },
}));
vi.mock('~/components/Apps/AppAssistant/assistantToken', async (importOriginal) => ({
  ...(await importOriginal<typeof TokenMod>()),
  createAssistantTokenProvider: () => ({
    getToken: async () => 'sandbox-token',
    enable: async () => 'chat-token',
  }),
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  trpc: makeTrpcProxy({
    'blocks.startDevTunnel': {
      useMutation: () => ({
        mutateAsync: async () => ({
          sessionId: 'bki_1',
          host: 'dev-0123456789abcdef.civit.ai',
          sshHostPublicKey: 'ssh-ed25519 AAAAhostkey',
        }),
      }),
    },
    'blocks.stopDevTunnel': { useMutation: () => ({ mutateAsync: async () => ({ ok: true }) }) },
  }),
}));

const { AppAssistantWorkspace } = await import('./AppAssistantWorkspace');

const ctx = { signal: new AbortController().signal, conversationId: 'c', files: [] };
const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleExample sandbox-dev-tunnel';
const NARROW = [
  { width: 375, height: 812 },
  { width: 1023, height: 800 },
];
const WIDE = [
  { width: 1024, height: 800 },
  { width: 1280, height: 800 },
];

const pane = (id: 'chat' | 'preview') =>
  document.querySelector<HTMLElement>(`[data-testid="app-assistant-${id}-pane"]`);
const shown = (el: Element | null) => !!el && getComputedStyle(el).display !== 'none';
const tabs = () => document.querySelector('.mantine-SegmentedControl-root');

async function mount(viewport: { width: number; height: number }) {
  await renderAtViewport(
    <ModalsProvider>
      <AppAssistantWorkspace canPreview sandboxUrl={BASE} />
    </ModalsProvider>,
    viewport
  );
  await vi.waitFor(() => expect(pane('chat')).not.toBeNull());
  await nextLayout();
  expect(cascadeEvidence().tailwindFlexUtilityResolves, 'the real cascade did not load').toBe(true);
}

/** Opens a new app the way the assistant does on a first build request. */
async function createApp() {
  await m.tools!.create_app.execute({ name: 'Tip calculator' }, ctx);
  await vi.waitFor(() =>
    expect(document.querySelector('[aria-label^="Switch app: tip-calculator"]')).not.toBeNull()
  );
  await nextLayout();
}

async function startPreview() {
  await m.tools!.start_preview.execute({ public_key: KEY, block_id: 'tip-calculator' }, ctx);
  await vi.waitFor(() => expect(pane('preview')).not.toBeNull());
  await nextLayout();
}

function clickTab(label: string) {
  const el = [...document.querySelectorAll<HTMLElement>('.mantine-SegmentedControl-label')].find(
    (l) => l.textContent === label
  );
  if (!el) throw new Error(`no ${label} tab`);
  el.click();
}

/** Every control the user taps on a phone. */
function expectTapTargets(targets: (HTMLElement | null | undefined)[], count: number) {
  const found = targets.filter((t): t is HTMLElement => !!t);
  expect(found).toHaveLength(count);
  for (const target of found) expect(box(target).height).toBeGreaterThanOrEqual(44);
}

const buttonStartingWith = (text: string) =>
  [...document.querySelectorAll<HTMLElement>('button')].find((b) =>
    b.textContent?.startsWith(text)
  );

/** Both panes, wherever shown, have height and end inside the window. */
function expectPanesOnScreen(viewport: { height: number }) {
  for (const el of [pane('chat'), pane('preview')]) {
    if (!shown(el)) continue;
    expect(box(el!).height).toBeGreaterThan(200);
    expect(box(el!).bottom).toBeLessThanOrEqual(viewport.height);
  }
}

beforeEach(() => {
  m.tools = null;
  m.beforeToolCall = null;
  m.list = [];
  m.state = 'running';
});

describe.each(NARROW)('App Assistant at $width px (narrow)', (viewport) => {
  test('with no app, the chat fills the width and there is no Chat/Preview switch', async () => {
    await mount(viewport);
    expect(tabs()).toBeNull();
    expect(pane('preview')).toBeNull();
    const workspace = pane('chat')!.parentElement!;
    expect(box(pane('chat')!).width).toBe(box(workspace).width);
  });

  test('with an app but no preview yet, only the chat shows, full width, with no switch', async () => {
    await mount(viewport);
    await createApp();
    expect(tabs()).toBeNull();
    expect(pane('preview')).toBeNull();
    expect(box(pane('chat')!).width).toBe(box(pane('chat')!.parentElement!).width);
  });

  test('a started preview brings the switch on Preview; Chat and Preview then switch, one pane at a time, on 44 px targets', async () => {
    await mount(viewport);
    await createApp();
    await startPreview();
    expect(shown(tabs())).toBe(true);
    expect(shown(pane('chat'))).toBe(false);
    expect(shown(pane('preview'))).toBe(true);

    clickTab('Chat');
    await nextLayout();
    expect(shown(pane('chat'))).toBe(true);
    expect(shown(pane('preview'))).toBe(false);

    clickTab('Preview');
    await nextLayout();
    expect(shown(pane('chat'))).toBe(false);
    expect(shown(pane('preview'))).toBe(true);

    expectPanesOnScreen(viewport);
    expectTapTargets(
      [
        ...document.querySelectorAll<HTMLElement>('.mantine-SegmentedControl-label'),
        document.querySelector<HTMLElement>('[aria-label^="Switch app"]'),
      ],
      3
    );
  });

  test('the app switcher and its list are 44 px targets', async () => {
    await mount(viewport);
    await createApp();
    document.querySelector<HTMLElement>('[aria-label^="Switch app"]')!.click();
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());
    await nextLayout();
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    await vi.waitFor(() => expect(box(dialog).right).toBeLessThanOrEqual(viewport.width));
    expectTapTargets(
      [
        document.querySelector<HTMLElement>('[aria-label^="Switch app"]'),
        buttonStartingWith('New app'),
        buttonStartingWith('tip-calculator'),
        dialog.querySelector<HTMLElement>('[aria-label="Actions for tip-calculator"]'),
      ],
      4
    );
  });
});

describe('App Assistant at 320 px', () => {
  test('the app list fits the window', async () => {
    const viewport = { width: 320, height: 640 };
    await mount(viewport);
    await createApp();
    document.querySelector<HTMLElement>('[aria-label^="Switch app"]')!.click();
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());
    await nextLayout();
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    await vi.waitFor(() => {
      expect(box(dialog).left).toBeGreaterThanOrEqual(0);
      expect(box(dialog).right).toBeLessThanOrEqual(viewport.width);
    });
  });
});

describe.each(WIDE)('App Assistant at $width px (wide)', (viewport) => {
  test('with no app, the chat fills the width', async () => {
    await mount(viewport);
    expect(pane('preview')).toBeNull();
    expect(box(pane('chat')!).width).toBe(box(pane('chat')!.parentElement!).width);
  });

  /** The chat takes 5/12 of the row and the preview the rest, both on screen. */
  function expectSideBySide() {
    expect(shown(tabs())).toBe(false);
    expect(shown(pane('chat'))).toBe(true);
    expect(shown(pane('preview'))).toBe(true);
    const row = box(pane('chat')!.parentElement!);
    const chat = box(pane('chat')!);
    const preview = box(pane('preview')!);
    expect(chat.width).toBeCloseTo((row.width * 5) / 12, 0);
    expect(chat.right).toBeLessThanOrEqual(preview.left);
    expect(preview.right).toBe(row.right);
    expect(preview.width).toBeGreaterThan(row.width / 3);
    expect(chat.top).toBe(preview.top);
    expectPanesOnScreen(viewport);
  }

  test('with an app but no preview yet, the chat fills the width', async () => {
    await mount(viewport);
    await createApp();
    expect(pane('preview')).toBeNull();
    expect(box(pane('chat')!).width).toBe(box(pane('chat')!.parentElement!).width);
  });

  test('a started preview, which selects the Preview tab, sits beside the chat with no switch', async () => {
    await mount(viewport);
    await createApp();
    await startPreview();
    expectSideBySide();
  });
});
