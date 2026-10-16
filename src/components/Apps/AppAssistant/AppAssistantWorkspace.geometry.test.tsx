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
  list: [] as Sandbox[],
}));

vi.mock('~/components/Apps/AppAssistant/AppAssistantChat', () => ({
  AppAssistantChat: (props: { tools: Record<string, ChatTool> }) => {
    m.tools = props.tools;
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
        state: 'running',
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
    'blocks.startDevTunnel': { useMutation: () => ({ mutateAsync: vi.fn() }) },
    'blocks.stopDevTunnel': { useMutation: () => ({ mutateAsync: vi.fn() }) },
  }),
}));

const { AppAssistantWorkspace } = await import('./AppAssistantWorkspace');

const ctx = { signal: new AbortController().signal, conversationId: 'c', files: [] };
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

beforeEach(() => {
  m.tools = null;
  m.list = [];
});

describe.each(NARROW)('App Assistant at $width px (narrow)', (viewport) => {
  test('with no app, the chat fills the width and there is no Chat/Preview switch', async () => {
    await mount(viewport);
    expect(tabs()).toBeNull();
    expect(pane('preview')).toBeNull();
    const workspace = pane('chat')!.parentElement!;
    expect(box(pane('chat')!).width).toBe(box(workspace).width);
  });

  test('with an app, Chat and Preview switch, one pane at a time, on 44 px targets', async () => {
    await mount(viewport);
    await createApp();
    expect(shown(tabs())).toBe(true);
    expect(shown(pane('chat'))).toBe(true);
    expect(shown(pane('preview'))).toBe(false);

    clickTab('Preview');
    await nextLayout();
    expect(shown(pane('chat'))).toBe(false);
    expect(shown(pane('preview'))).toBe(true);

    clickTab('Chat');
    await nextLayout();
    expect(shown(pane('chat'))).toBe(true);
    expect(shown(pane('preview'))).toBe(false);

    const targets = [
      ...document.querySelectorAll<HTMLElement>('.mantine-SegmentedControl-label'),
      document.querySelector<HTMLElement>('[aria-label="Actions for tip-calculator"]')!,
      [...document.querySelectorAll<HTMLElement>('button')].find((b) =>
        b.textContent?.startsWith('Your apps')
      )!,
    ];
    expect(targets).toHaveLength(4);
    for (const target of targets) expect(box(target).height).toBeGreaterThanOrEqual(44);
  });
});

describe.each(WIDE)('App Assistant at $width px (wide)', (viewport) => {
  test('with no app, the chat fills the width', async () => {
    await mount(viewport);
    expect(pane('preview')).toBeNull();
    expect(box(pane('chat')!).width).toBe(box(pane('chat')!.parentElement!).width);
  });

  test('with an app, chat and preview sit side by side with no switch', async () => {
    await mount(viewport);
    await createApp();
    expect(shown(tabs())).toBe(false);
    expect(shown(pane('chat'))).toBe(true);
    expect(shown(pane('preview'))).toBe(true);
    const chat = box(pane('chat')!);
    const preview = box(pane('preview')!);
    expect(chat.right).toBeLessThanOrEqual(preview.left);
    expect(chat.top).toBe(preview.top);
  });
});
