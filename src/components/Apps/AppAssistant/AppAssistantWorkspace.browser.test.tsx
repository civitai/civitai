import { afterEach, beforeEach, describe, expect, inject, onTestFinished, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { ModalsProvider } from '@mantine/modals';
import type { ReactNode } from 'react';
import type { ChatTool } from '@civitai/components-chat/civitai-chat';
import { gateToolSet } from '@civitai/components-chat/core';
import { openAppNotChosen } from '@civitai/app-assistant';
import type * as TrpcMod from '~/utils/trpc';
import type * as TokenMod from '~/components/Apps/AppAssistant/assistantToken';
import type * as NotificationsMod from '~/utils/notifications';
import type { Sandbox } from '~/components/Apps/AppAssistant/sandboxClient';
import { SandboxApiError } from '~/components/Apps/AppAssistant/sandboxClient';
import type * as RemoteRunnerMod from '~/components/Apps/AppAssistant/remoteRunner';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';
import { makeTrpcProxy } from '../../../../test/trpcProxyStub';

declare module 'vitest' {
  interface ProvidedContext {
    quarantineRun?: boolean;
  }
}

/** True only in the non-blocking `component-quarantine` project (vitest.config.mts). */
const quarantineRun = inject('quarantineRun') === true;

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
    onBeforeSend?: (
      text: string,
      queue: (waiting?: string) => { text: string; release(): void; cancel(): void }
    ) => void;
    onReplyResume?: (trigger: 'retry' | 'visible' | 'online') => boolean;
    onChatChange?: (chatId: string | null) => void;
    subagents?: unknown;
    composerTop?: ReactNode;
    threadEnd?: ReactNode;
  },
  list: [] as Sandbox[],
  /**
   * The apps as the service has them now, when that differs from the list the page last fetched (the
   * page slept): its list's refetch brings them in.
   */
  service: null as null | Sandbox[],
  /** The list's refetch fails, or never answers. */
  refetchFails: false,
  refetchHangs: false,
  refetches: 0,
  /** The page's own list asks while its open app starts. */
  startPolls: 0,
  open: vi.fn(),
  openReject: null as unknown,
  start: vi.fn(),
  stop: vi.fn(),
  suspend: vi.fn(),
  remove: vi.fn(),
  newChat: vi.fn(),
  /** The chat's message box. */
  box: '',
  /** The chat is listing a just-added app's tools, so it holds as it does for `holdReason`. */
  listing: false,
  /** A saved chat is opening: the chat holds until it is open, as it does for `holdReason`. */
  opening: false,
  /** A message the chat took is on its way to its agent (say, asking for the viewer's grant): it holds. */
  sending: false,
  /** The chat is starting again for a new app: it holds. */
  starting: false,
  /** A reply is running. */
  running: false,
  /**
   * The chat's `dictating`: the user is recording, has just stopped, or what they said is being
   * turned into text. The box keeps what it held until the words are joined to it.
   */
  dictating: false,
  /** What the chat actually sent to the assistant. */
  delivered: [] as string[],
  /** The chat element as the page holds it (`chatRef.current`). */
  element: null as null | EventTarget,
  /** What the chat's `can-send-change` last said. */
  announced: false,
  /**
   * The message the page keeps back with `queue()`, as 0.15.0 shows it: waiting, with `waiting` as its
   * words, until released (then it goes once the chat can send) or cancelled (then it comes back).
   */
  queued: null as null | { text: string; waiting: string; held: boolean },
  /** How many times the page released a kept-back message. */
  releases: 0,
  /** "This message was not sent" notices the chat shows (0.15.0's `giveBack` when the box is taken). */
  notices: [] as string[],
  /** 0.15.0's `giveBack`: into an empty box when the user is not dictating, else a notice (one per text). */
  giveBack: vi.fn((text: string) => {
    if (m.box === text) return true;
    if (!m.box.trim() && !m.dictating) m.box = text;
    else if (!m.notices.includes(text)) m.notices.push(text);
    return true;
  }),
  /** A released message goes once nothing holds the chat but itself and no reply runs. */
  flush: () => {
    const q = m.queued;
    if (!q || q.held || m.running || m.holdsOther()) return;
    m.queued = null;
    m.delivered.push(q.text);
    // A new turn: the failed reply is no longer the latest.
    m.failed = false;
  },
  /**
   * Whether the element holds, as 0.13.0 does, keeping a send in an EMPTY box: the page's
   * `holdReason`, the chat starting again for a new app, a saved chat opening, a message on its way,
   * or a just-added app's tools being listed.
   */
  holds: () => m.holdsOther() || m.queued !== null,
  holdsOther: () =>
    Boolean(m.chat?.holdReason) || m.starting || m.opening || m.sending || m.listing,
  /**
   * The element's `canSend` as 0.13.0 has it: a send would go now (no reply running, nothing holding;
   * the fake chat is always signed in), and its `can-send-change`, fired once each time that changes.
   */
  canSend: () => !m.running && !m.holds(),
  announce: () => {
    m.flush();
    const canSend = m.canSend();
    if (canSend === m.announced) return;
    m.announced = canSend;
    m.element?.dispatchEvent(new CustomEvent('can-send-change', { detail: { canSend } }));
  },
  /**
   * The element's own send, as 0.13.0 has it: nothing while a reply runs; while it holds, the text
   * fills an EMPTY box and nothing fires; otherwise `before-send`, and it goes unless the page cancels
   * it. It never empties the box: the box empties itself when the user presses Send.
   */
  chatSend: async (text: string) => {
    if (m.running) return;
    if (m.holds()) {
      if (!m.box) m.box = text;
      return;
    }
    let open = true;
    let queued = false;
    const queue = (waiting = '') => {
      if (!open) throw new Error('queue() after before-send');
      const q = (m.queued ??= { text, waiting, held: true });
      queued = true;
      return {
        text,
        release: () => {
          if (m.queued !== q || !q.held) return;
          q.held = false;
          m.releases++;
          m.announce();
        },
        cancel: () => {
          if (m.queued !== q) return;
          m.queued = null;
          m.giveBack(text);
          m.announce();
        },
      };
    };
    m.chat?.onBeforeSend?.(text, queue);
    open = false;
    if (queued) {
      m.announce();
      return;
    }
    m.delivered.push(text);
    // The failed reply is no longer the latest: nothing asks for it again.
    m.failed = false;
  },
  send: vi.fn(async (text: string) => m.chatSend(text)),
  /** The latest reply lost its connection and can be asked for again (it has a resume point). */
  failed: false,
  /** The chat already asked for the failed reply again by itself: at most once, as 0.14.0 does. */
  autoResumed: false,
  /** The page cancelled the chat's ask by itself (`reply-resume`): its own `retryReply()` then counts as that one ask. */
  autoCancelled: false,
  /** Each time the chat asked for the failed reply again: the `reply-resume` trigger, or `retryReply`. */
  retried: [] as string[],
  /**
   * Whether a just-added server lists its tools as 0.14.0 does: in the element's NEXT update, so
   * `canSend` still reads true until `updateComplete` resolves.
   */
  listsOnUpdate: false,
  /** The element's pending update, as its `updateComplete`. */
  update: null as null | Promise<boolean>,
  /** As 0.14.0's `#retryable()`: a failed reply with a resume point, and the chat can send. */
  retryable: () => m.failed && m.canSend(),
  /** As 0.14.0's `#resumeReply()`: fires `reply-resume`, and asks again unless the page cancels it. */
  resumeReply: (trigger: 'retry' | 'visible' | 'online') => {
    if (m.chat?.onReplyResume?.(trigger)) return false;
    m.failed = false;
    m.retried.push(trigger);
    return true;
  },
  /**
   * As 0.14.0's `#autoResume()`: the page came back into view (or online); the failed reply is asked for
   * again, once, unless the page cancels the ask, which then does not count as the one ask.
   */
  pageWakes: (trigger: 'visible' | 'online' = 'visible') => {
    if (!m.retryable() || m.autoResumed) return;
    if (!m.resumeReply(trigger)) {
      m.autoCancelled = true;
      return;
    }
    m.autoResumed = true;
  },
  /** As 0.14.0's `retryReply()`: asks again, without `reply-resume`, only where Retry would be offered. */
  retryReply: vi.fn(async () => {
    if (!m.retryable()) return false;
    if (m.autoCancelled) m.autoResumed = true;
    m.failed = false;
    m.retried.push('retryReply');
    return true;
  }),
  /** Set to keep the next resume pending until the test settles it. */
  deferOpen: false,
  resume: vi.fn(),
  settleOpen: null as null | (() => void),
  compose: vi.fn(async (text: string) => {
    m.box = text;
  }),
  getToken: vi.fn<(opts?: unknown) => Promise<string>>(async () => 'sandbox-token'),
  enable: vi.fn(async () => 'chat-token'),
  sandboxClient: null as null | { list: () => Promise<unknown> },
  onConsentRequired: null as null | (() => void),
  openError: null as unknown,
  listError: null as unknown,
  listNeverLoaded: true,
  /** The session the preview pane was last rendered with. */
  previewSession: undefined as unknown,
  /** A delete the service refuses. */
  removeReject: null as unknown,
  /** Toasts the page showed. */
  toasts: [] as { kind: 'success' | 'error'; title?: string; message: unknown }[],
  /** Starts, export requests and downloads, in the order they happened. */
  events: [] as string[],
  /** How the gateway answers each export request in turn: a status, or a zip (200) once they run out. */
  exportAnswers: [] as number[],
  /** The bearer each export request carried. */
  exportAuth: [] as (string | null)[],
  /** Files the page handed the browser to save. */
  downloads: [] as { name: string; href: string }[],
}));

vi.mock('~/components/Apps/AppAssistant/AppAssistantChat', async () => {
  const { useLayoutEffect } = await import('react');
  return {
    AppAssistantChat: (props: NonNullable<typeof m.chat>) => {
      m.chat = props;
      useLayoutEffect(() => {
        // The element's public surface as 0.13.0 has it: `draft`, `dictating` and `canSend` are
        // read-only getters, and `can-send-change` fires on the element.
        if (!props.chatRef) return;
        m.element ??= Object.defineProperties(new EventTarget(), {
          newChat: { value: m.newChat },
          send: { value: m.send },
          compose: { value: m.compose },
          draft: { get: () => m.box },
          dictating: { get: () => m.dictating },
          canSend: { get: () => m.canSend() },
          giveBack: { value: m.giveBack },
          retryReply: { value: m.retryReply },
          updateComplete: { get: () => m.update ?? Promise.resolve(true) },
        });
        props.chatRef.current = m.element;
      });
      // A new `holdReason` re-renders the element, which announces a change of `canSend`.
      useLayoutEffect(() => m.announce(), [props.holdReason]);
      // 0.14.0 starts listing a new server's tools in its next update: `canSend` reads true until then.
      useLayoutEffect(() => {
        if (!m.listsOnUpdate || !props.mcpServers.length) return;
        m.update = new Promise((resolve) =>
          setTimeout(() => {
            m.listing = true;
            m.announce();
            resolve(true);
          }, 0)
        );
      }, [props.mcpServers]);
      // As the real one: the page's content in the chat element's named slots.
      return (
        <div data-testid="chat">
          {props.composerTop ? <div slot="composer-top">{props.composerTop}</div> : null}
          {props.threadEnd ? <div slot="thread-end">{props.threadEnd}</div> : null}
        </div>
      );
    },
  };
});
// The server runner's Restart preview: the page's look for a live preview, the runner's restart,
// and what the pane is handed (`restart`).
const r = vi.hoisted(() => ({
  /** `fetchPreviewFrame`: unanswered unless a test says otherwise, so no pane appears by itself. */
  probe: vi.fn<(blockId: string) => Promise<unknown>>(),
  restart: vi.fn<(app: string, options: unknown) => Promise<unknown>>(),
  pane: undefined as undefined | { onRestart: () => void; pending: boolean; error: string | null },
}));
vi.mock('~/components/Apps/AppAssistant/AppAssistantPreview', () => ({
  AppAssistantPreview: ({
    session,
    restart,
  }: {
    session: unknown;
    restart?: { onRestart: () => void; pending: boolean; error: string | null };
  }) => {
    m.previewSession = session;
    r.pane = restart;
    return <div data-testid="preview" />;
  },
}));
vi.mock('~/components/Apps/AppAssistant/previewFrame', () => ({
  fetchPreviewFrame: (blockId: string) => r.probe(blockId),
}));
vi.mock('~/components/Apps/AppAssistant/remoteRunner', async (importOriginal) => ({
  ...(await importOriginal<typeof RemoteRunnerMod>()),
  restartRunnerPreview: (app: string, options: unknown) => r.restart(app, options),
}));
beforeEach(() => {
  r.probe.mockReset().mockImplementation(() => new Promise(() => undefined));
  r.restart.mockReset();
  r.pane = undefined;
});
vi.mock('~/components/Apps/AppAssistant/useSandboxes', async () => {
  const { useReducer } = await import('react');
  return {
    useSandboxes: (client: { list: () => Promise<unknown> } | null) => {
      m.sandboxClient = client;
      // React Query re-renders its observer when a refetch brings new data.
      const [, rerender] = useReducer((n: number) => n + 1, 0);
      /** The service: finds the app's sandbox, or creates one, which the next list then includes. */
      const serve = (app: string) => {
        m.open(app);
        if (m.openReject) throw m.openReject;
        m.events.push(`start ${app}`);
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
          // As React Query's: resolves with the result (never throws); a failed one keeps the old data.
          // The page's own asks while its app starts pass `cancelRefetch: false`; they are counted apart,
          // and re-render with what they brought (the tests' other refetches read the result directly).
          refetch: async (opts?: { cancelRefetch?: boolean }) => {
            const startPoll = opts?.cancelRefetch === false;
            if (startPoll) m.startPolls++;
            else m.refetches++;
            await new Promise((resolve) => setTimeout(resolve, 0));
            if (m.refetchHangs) await new Promise<never>(() => undefined);
            if (m.refetchFails) return { isError: true, data: m.list };
            if (m.service) m.list = m.service;
            if (startPoll) rerender();
            return { isError: false, data: m.list };
          },
          isSuccess: !!client,
          isLoading: false,
          error: m.listError,
        },
        open: {
          mutate: (
            app: string,
            opts?: { onSuccess?: (r: { sandbox: Sandbox }) => void; onError?: (e: unknown) => void }
          ) => {
            const settle = () => {
              let served;
              try {
                served = serve(app);
              } catch (error) {
                return opts?.onError?.(error);
              }
              opts?.onSuccess?.(served);
            };
            m.resume(app);
            // The service answers later, never inside the call.
            if (m.deferOpen) m.settleOpen = settle;
            else setTimeout(settle, 0);
          },
          // As `mutate`: the service answers later (or when the test settles it).
          mutateAsync: (app: string) =>
            new Promise((resolve, reject) => {
              const settle = () => {
                try {
                  resolve(serve(app));
                } catch (error) {
                  reject(error);
                }
              };
              m.resume(app);
              if (m.deferOpen) m.settleOpen = settle;
              else setTimeout(settle, 0);
            }),
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
          mutateAsync: async (name: string) => {
            m.remove(name);
            await new Promise((resolve) => setTimeout(resolve, 0));
            if (m.removeReject) throw m.removeReject;
            m.list = m.list.filter((s) => s.name !== name);
          },
          isPending: false,
          error: null,
        },
      };
    },
  };
});
vi.mock('~/components/Apps/AppAssistant/assistantToken', async (importOriginal) => ({
  ...(await importOriginal<typeof TokenMod>()),
  createAssistantTokenProvider: (opts?: { onConsentRequired?: () => void }) => {
    m.onConsentRequired = opts?.onConsentRequired ?? null;
    return { getToken: m.getToken, enable: m.enable };
  },
}));
vi.mock('~/utils/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationsMod>()),
  showSuccessNotification: ({ title, message }: { title?: string; message: unknown }) =>
    m.toasts.push({ kind: 'success', title, message }),
  showErrorNotification: ({
    title,
    error,
    reason,
  }: {
    title?: string;
    error: { message: string };
    reason?: unknown;
  }) => m.toasts.push({ kind: 'error', title, message: reason ?? error.message }),
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  trpc: makeTrpcProxy({
    'blocks.startDevTunnel': { useMutation: () => ({ mutateAsync: m.start }) },
    'blocks.stopDevTunnel': { useMutation: () => ({ mutateAsync: m.stop }) },
  }),
}));

const {
  APP_LIST_REFRESH_TIMEOUT_MS,
  APP_START_POLL_MS,
  APP_START_TIMEOUT_MS,
  AppAssistantWorkspace,
  HELD_RECORD_MS,
  RESUME_ASK_TIMEOUT_MS,
} = await import('./AppAssistantWorkspace');
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

const switcher = () => page.getByRole('button', { name: /^Switch app:/ });

/** Opens `app` from the app switcher, as a user does. */
async function openFromSwitcher(app: string) {
  await switcher().click();
  await page
    .getByRole('dialog', { name: 'Apps' })
    .getByRole('button', { name: new RegExp(`^${app}`) })
    .click();
  await expect.element(page.getByRole('dialog')).not.toBeInTheDocument();
  await expect.element(switcher()).toHaveAccessibleName(new RegExp(`^Switch app: ${app},`));
}

async function openFirst() {
  await openFromSwitcher('app-aaaa');
}

/**
 * The user edits a field in the chat. Outside the chat's shadow root that is an `input` event
 * retargeted to the element itself, whichever field it came from.
 */
function fireInput() {
  document
    .querySelector('[data-testid="chat"]')!
    .dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }));
}

/** The user edits the message box. */
function type(text: string) {
  m.box = text;
  fireInput();
}

/** The chat starts or stops listing a just-added app's tools, and says so if that changes `canSend`. */
function setListing(listing: boolean) {
  m.listing = listing;
  m.announce();
}

/** The user types `text` and presses Send, which does nothing while the chat holds or replies. */
async function userSends(text: string) {
  type(text);
  // Send is off while the chat holds, a reply runs, or a message waits in it.
  if (m.chat?.holdReason || m.listing || m.running || m.queued) return;
  m.box = '';
  await m.chatSend(text);
}

/**
 * Dictation ends as 0.12.0 ends it: what was said is joined to whatever is in the box, and only then
 * does `dictating` read false.
 */
function endDictation(words: string) {
  m.box = [m.box.trim(), words].filter(Boolean).join(' ');
  m.dictating = false;
}

const settle = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

async function startPreview(blockId: string) {
  await m.chat!.tools.start_preview.execute({ public_key: KEY, block_id: blockId }, ctx);
}

afterEach(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  m.chat = null;
  m.list = [sandbox('sbx-aaaaaaaaaaaa'), sandbox('sbx-bbbbbbbbbbbb')];
  m.service = null;
  m.refetchFails = false;
  m.refetchHangs = false;
  m.refetches = 0;
  m.startPolls = 0;
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
  m.send.mockClear();
  m.box = '';
  m.listing = false;
  m.opening = false;
  m.sending = false;
  m.starting = false;
  m.running = false;
  m.dictating = false;
  m.delivered = [];
  m.failed = false;
  m.autoResumed = false;
  m.autoCancelled = false;
  m.retried = [];
  m.listsOnUpdate = false;
  m.update = null;
  m.retryReply.mockClear();
  m.element = null;
  m.announced = false;
  m.queued = null;
  m.releases = 0;
  m.notices = [];
  m.giveBack.mockClear();
  m.deferOpen = false;
  m.resume.mockClear();
  m.settleOpen = null;
  m.compose.mockClear();
  localStorage.clear();
  m.getToken.mockReset().mockResolvedValue('sandbox-token');
  m.enable.mockClear();
  m.sandboxClient = null;
  m.onConsentRequired = null;
  m.openError = null;
  m.listError = null;
  m.listNeverLoaded = true;
  m.previewSession = undefined;
  m.removeReject = null;
  m.toasts = [];
  m.events = [];
  m.exportAnswers = [];
  m.exportAuth = [];
  m.downloads = [];
});

describe('AppAssistantWorkspace with no apps', () => {
  test('shows only the chat: no app switcher, no preview and no Chat/Preview switch', async () => {
    m.list = [];
    await mount();
    expect(document.body.textContent).not.toMatch(/No app open|sandbox|Preview/i);
    expect(document.querySelector('[aria-label^="Switch app"]')).toBeNull();
    expect(document.querySelector('[data-testid="app-assistant-preview-pane"]')).toBeNull();
    expect(document.querySelector('[role="radiogroup"]')).toBeNull();
  });

  test('NEGATIVE CONTROL: with apps, the switcher says none is open, and a started preview brings the preview and the switch', async () => {
    await mount();
    await expect.element(switcher()).toHaveAccessibleName('Switch app: no app open');
    await expect.element(page.getByText('No app open')).toBeVisible();
    await openFirst();
    await startPreview('my-app');
    await expect.element(page.getByTestId('preview')).toBeInTheDocument();
    expect(document.querySelector('[role="radiogroup"]')).not.toBeNull();
  });

  test('a later poll that fails keeps the apps listed, without an alarm', async () => {
    m.listError = new SandboxApiError('Sandbox service error (503)', 503, 'unavailable');
    m.listNeverLoaded = false;
    await mount();
    await expect.element(switcher()).toBeVisible();
    expect(document.body.textContent).not.toMatch(/could not be reached/);
    await switcher().click();
    await expect.element(page.getByRole('dialog').getByText('New app')).toBeVisible();
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
    ).rejects.toThrow(/Choose one to delete in the card under the chat/);
    expect(m.open).toHaveBeenCalledTimes(1);

    expect(m.chat!.beforeToolCall!('create_app', {}, conv)).toEqual({
      refuse: expect.stringMatching(/^You already have as many apps as you can keep\./),
    });
    // The next reply may try again (the user may have deleted one).
    expect(m.chat!.beforeToolCall!('create_app', {}, { ...conv, reply: 2 })).toEqual({
      allow: true,
    });
  });

  test('an app create_app made and the page then deleted is not reused by name', async () => {
    m.list = [sandbox('sbx-aaaaaaaaaaaa', { app: 'game', state: 'suspended' })];
    await mount();
    await m.chat!.tools.create_app.execute({ name: 'Game' }, ctx);
    expect(m.open).toHaveBeenLastCalledWith('game-2');
    const made = m.list.find((s) => s.app === 'game-2')!;
    await switcher().click();
    await page.getByRole('button', { name: 'Actions for game-2' }).click();
    await page.getByRole('menuitem', { name: 'Delete app' }).click();
    await page.getByRole('button', { name: 'Delete app' }).click();
    expect(m.remove).toHaveBeenCalledWith(made.name);

    // The same app shows up again (listed late) and is opened from the list.
    m.list = [...m.list, made];
    await openFromSwitcher('game-2');
    m.open.mockClear();
    await m.chat!.tools.create_app.execute({ name: 'Game' }, ctx);
    expect(m.open).toHaveBeenCalledWith('game-3');
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
    ).rejects.toThrow(/Choose one to delete in the card under the chat/);
    m.openError = m.openReject;
    screen.rerender(<Workspace />);
    await expect.element(page.getByText('You have as many apps as you can keep')).toBeVisible();
    await expect.element(page.getByText('No app open')).toBeVisible();
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

describe('AppAssistantWorkspace app switcher', () => {
  test('lists the apps in plain words, and picking a paused one starts it', async () => {
    m.list = [sandbox('sbx-aaaaaaaaaaaa'), sandbox('sbx-bbbbbbbbbbbb', { state: 'suspended' })];
    await mount();
    await switcher().click();
    const dialog = page.getByRole('dialog', { name: 'Apps' });
    await expect.element(dialog.getByText('Running', { exact: true })).toBeVisible();
    await expect.element(dialog.getByText('Paused', { exact: true })).toBeVisible();
    expect(dialog.getByText(/^(running|suspended|starting)$/).elements()).toHaveLength(0);
    expect(document.querySelector('[role="dialog"]')!.textContent).not.toMatch(
      /suspended|sbx-|sandbox/
    );

    await dialog.getByRole('button', { name: /^app-bbbb/ }).click();
    expect(m.open).toHaveBeenCalledWith('app-bbbb');
    await expect.element(switcher()).toHaveAccessibleName(/^Switch app: app-bbbb,/);
  });

  test('INVARIANT: picking an app from the switcher puts focus back on it', async () => {
    await mount();
    await switcher().click();
    // Focus is trapped in the list while it is open, so it has to be given back.
    await vi.waitFor(() => expect(switcher().element()).not.toBe(document.activeElement));
    await page
      .getByRole('dialog', { name: 'Apps' })
      .getByRole('button', { name: /^app-aaaa/ })
      .click();
    await expect.element(page.getByRole('dialog')).not.toBeInTheDocument();
    await expect.element(switcher()).toHaveFocus();
  });

  test('NEGATIVE CONTROL: picking a running app does not ask the service', async () => {
    await mount();
    await openFirst();
    expect(m.open).not.toHaveBeenCalled();
  });

  test('a paused app is shown as paused, with no Resume to press', async () => {
    m.list = [sandbox('sbx-aaaaaaaaaaaa', { state: 'suspended' })];
    await mount();
    await openFirst();
    await expect.element(switcher()).toHaveAccessibleName('Switch app: app-aaaa, Paused');
    expect(document.body.textContent).not.toMatch(/paused, so the assistant|Resume/);
    await switcher().click();
    await page.getByRole('button', { name: 'Actions for app-aaaa' }).click();
    await expect.element(page.getByRole('menuitem', { name: 'Delete app' })).toBeVisible();
    expect(page.getByRole('menuitem', { name: /Resume|Pause/ }).elements()).toHaveLength(0);
  });

  test('the switcher pauses a running app from its menu', async () => {
    await mount();
    await openFirst();
    await switcher().click();
    await page.getByRole('button', { name: 'Actions for app-aaaa' }).click();
    await page.getByRole('menuitem', { name: 'Pause' }).click();
    expect(m.suspend).toHaveBeenCalledWith('sbx-aaaaaaaaaaaa');
  });

  test('deletes the open app only after the confirmation, and closes it', async () => {
    await mount();
    await openFirst();
    await switcher().click();
    await page.getByRole('button', { name: 'Actions for app-aaaa' }).click();
    await page.getByRole('menuitem', { name: 'Delete app' }).click();
    await page.getByRole('button', { name: 'Keep it' }).click();
    expect(m.remove).not.toHaveBeenCalled();

    await switcher().click();
    await page.getByRole('button', { name: 'Actions for app-aaaa' }).click();
    await page.getByRole('menuitem', { name: 'Delete app' }).click();
    await page.getByRole('button', { name: 'Delete app' }).click();
    expect(m.remove).toHaveBeenCalledWith('sbx-aaaaaaaaaaaa');
    await expect.element(switcher()).toHaveAccessibleName('Switch app: no app open');
  });

  test('deleting another app from the switcher leaves the open one open', async () => {
    await mount();
    await openFirst();
    await switcher().click();
    await page.getByRole('button', { name: 'Actions for app-bbbb' }).click();
    await page.getByRole('menuitem', { name: 'Delete app' }).click();
    await page.getByRole('button', { name: 'Delete app' }).click();
    expect(m.remove).toHaveBeenCalledWith('sbx-bbbbbbbbbbbb');
    await expect.element(switcher()).toHaveAccessibleName('Switch app: app-aaaa, Running');
  });

  test('an open app that disappears from the list (deleted elsewhere) is closed, with its preview', async () => {
    const screen = await mount();
    await openFirst();
    await startPreview('my-app');
    m.list = [m.list[1]];
    screen.rerender(<Workspace />);
    await expect.element(page.getByTestId('preview')).not.toBeInTheDocument();
    await expect.element(page.getByText('No app open')).toBeVisible();
    await vi.waitFor(() => expect(m.stop).toHaveBeenCalledWith({ sessionId: 'bki_1' }));
  });

  test('New app closes the open app and starts a new chat', async () => {
    await mount();
    await openFirst();
    await startPreview('my-app');
    await switcher().click();
    await page.getByRole('button', { name: 'New app' }).click();
    expect(m.newChat).toHaveBeenCalledTimes(1);
    await expect.element(page.getByText('No app open')).toBeVisible();
    expect(document.querySelector('[data-testid="preview"]')).toBeNull();
  });
});

describe('AppAssistantWorkspace auto-resume', () => {
  const paused = () => [
    sandbox('sbx-aaaaaaaaaaaa', { state: 'suspended' }),
    sandbox('sbx-bbbbbbbbbbbb'),
  ];
  /** Opens the paused app the way a visit finds it: open on the page, not started. */
  async function openPaused() {
    m.list = paused();
    const screen = await mount();
    m.chat!.onChatChange!('chat-1');
    // A paused app the page shows open without starting it (as after a visit or another tab pausing it).
    await openFromSwitcher('app-bbbb');
    m.list = [m.list[0], { ...m.list[1], state: 'suspended' }];
    screen.rerender(<Workspace />);
    m.open.mockClear();
    m.resume.mockClear();
    await expect.element(switcher()).toHaveAccessibleName('Switch app: app-bbbb, Paused');
    return screen;
  }
  const runsB = (screen: Awaited<ReturnType<typeof mount>>) => {
    m.list = [m.list[0], { ...m.list[1], state: 'running' }];
    screen.rerender(<Workspace />);
  };

  test('a message to a paused app is shown waiting in the chat, the app resumed, and the message sent once it runs', async () => {
    const screen = await openPaused();
    await userSends('Add a dark mode');
    expect(m.box).toBe('');
    // The chat shows it at once, as the user's, waiting with these words.
    expect(m.queued).toEqual({
      text: 'Add a dark mode',
      waiting: 'Your app is starting…',
      held: true,
    });
    expect(m.resume.mock.calls).toEqual([['app-bbbb']]);
    expect(m.delivered).toEqual([]);
    runsB(screen);
    await vi.waitFor(() => expect(m.delivered).toEqual(['Add a dark mode']));
    expect(m.queued).toBeNull();
    expect(m.box).toBe('');
    expect(m.chat!.holdReason).toBeUndefined();
  });

  test('NEGATIVE CONTROL: while the app is still paused, before its resume starts it, the message keeps waiting', async () => {
    await openPaused();
    m.deferOpen = true;
    await userSends('Add a dark mode');
    await settle(200);
    expect(m.queued).toEqual({
      text: 'Add a dark mode',
      waiting: 'Your app is starting…',
      held: true,
    });
    expect(m.box).toBe('');
  });

  test('NEGATIVE CONTROL: a message to a running app goes straight out', async () => {
    await mount();
    await openFirst();
    await userSends('Add a dark mode');
    expect(m.delivered).toEqual(['Add a dark mode']);
    expect(m.queued).toBeNull();
    expect(m.resume).not.toHaveBeenCalled();
  });

  test('🔴 a follow-up typed while it resumes stays in the box and is not lost', async () => {
    const screen = await openPaused();
    await userSends('Add a dark mode');
    await userSends('and a timer');
    expect(m.box).toBe('and a timer');
    setListing(true);
    runsB(screen);
    await settle(100);
    setListing(false);
    await vi.waitFor(() => expect(m.delivered).toEqual(['Add a dark mode']));
    expect(m.box).toBe('and a timer');
  });

  test('released once its app runs, it goes when the chat has listed the app’s tools', async () => {
    const screen = await openPaused();
    await userSends('Add a dark mode');
    setListing(true);
    runsB(screen);
    await vi.waitFor(() => expect(m.releases).toBe(1));
    await settle(200);
    expect(m.delivered).toEqual([]);
    // 0.15.0 keeps it in its waiting bubble, not as a copy in the box.
    expect(m.box).toBe('');
    setListing(false);
    await vi.waitFor(() => expect(m.delivered).toEqual(['Add a dark mode']));
    expect(m.releases).toBe(1);
  });

  test('NEGATIVE CONTROL: not released while the app is still starting', async () => {
    const screen = await openPaused();
    await userSends('Add a dark mode');
    m.list = [m.list[0], { ...m.list[1], state: 'starting' }];
    screen.rerender(<Workspace />);
    await vi.waitFor(() => expect(m.chat!.holdReason).toBe('Your app is starting…'));
    await settle(100);
    expect(m.releases).toBe(0);
    expect(m.delivered).toEqual([]);
  });

  test('🟡 an app paused again while the message waits gives it back', async () => {
    const screen = await openPaused();
    await userSends('Add a dark mode');
    m.list = [m.list[0], { ...m.list[1], state: 'starting' }];
    screen.rerender(<Workspace />);
    await vi.waitFor(() => expect(m.chat!.holdReason).toBe('Your app is starting…'));
    m.list = [m.list[0], { ...m.list[1], state: 'suspended' }];
    screen.rerender(<Workspace />);
    await vi.waitFor(() => expect(m.box).toBe('Add a dark mode'));
    expect(m.queued).toBeNull();
    expect(m.chat!.holdReason).toBeUndefined();
    expect(m.delivered).toEqual([]);
  });

  test('opening another chat while the app resumes gives the message back, and it is not sent when the app runs', async () => {
    const screen = await openPaused();
    await userSends('Add a dark mode');
    m.chat!.onChatChange!('chat-2');
    await vi.waitFor(() => expect(m.box).toBe('Add a dark mode'));
    runsB(screen);
    await settle(100);
    expect(m.delivered).toEqual([]);
  });

  test('opening another app while a released message still waits on the chat calls it back', async () => {
    const screen = await openPaused();
    await userSends('Add a dark mode');
    setListing(true);
    runsB(screen);
    await vi.waitFor(() => expect(m.releases).toBe(1));
    await openFromSwitcher('app-aaaa');
    setListing(false);
    await settle(100);
    expect(m.delivered).toEqual([]);
  });

  test('🟡 paused again after the release but before the chat sent it: called back, not sent without the app’s tools', async () => {
    const screen = await openPaused();
    await userSends('Add a dark mode');
    setListing(true);
    runsB(screen);
    await vi.waitFor(() => expect(m.releases).toBe(1));
    // The app is paused while the chat still lists its tools: they go, and so does the listing hold.
    m.list = [m.list[0], { ...m.list[1], state: 'suspended' }];
    screen.rerender(<Workspace />);
    await vi.waitFor(() => expect(m.chat!.mcpServers).toEqual([]));
    setListing(false);
    await settle(100);
    expect(m.delivered).toEqual([]);
    expect(m.box).toBe('Add a dark mode');
  });

  test('🟢 the page’s record of a held message ends with the chat’s own wait: a resume that never starts the app stops reading as starting', async () => {
    await openPaused();
    m.deferOpen = true;
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    await userSends('Add a dark mode');
    await expect.element(switcher()).toHaveAccessibleName('Switch app: app-bbbb, Starting…');
    await vi.advanceTimersByTimeAsync(HELD_RECORD_MS - 2000);
    await expect.element(switcher()).toHaveAccessibleName('Switch app: app-bbbb, Starting…');
    await vi.advanceTimersByTimeAsync(4000);
    vi.useRealTimers();
    await expect.element(switcher()).toHaveAccessibleName('Switch app: app-bbbb, Paused');
  });

  test('🟡 its tools gone after the release (still running) before the chat sent it: called back', async () => {
    const screen = await openPaused();
    await userSends('Add a dark mode');
    setListing(true);
    runsB(screen);
    await vi.waitFor(() => expect(m.releases).toBe(1));
    // The running app's address moves outside the sandbox service: its tools are no longer handed over.
    m.list = [m.list[0], { ...m.list[1], mcpUrl: 'https://elsewhere.example/s/x/mcp' }];
    screen.rerender(<Workspace />);
    await vi.waitFor(() => expect(m.chat!.mcpServers).toEqual([]));
    setListing(false);
    await settle(100);
    expect(m.delivered).toEqual([]);
    expect(m.box).toBe('Add a dark mode');
  });

  test('a released message still waiting is called back when the page goes away', async () => {
    const screen = await openPaused();
    await userSends('Add a dark mode');
    setListing(true);
    runsB(screen);
    await vi.waitFor(() => expect(m.releases).toBe(1));
    screen.unmount();
    setListing(false);
    await settle(100);
    expect(m.delivered).toEqual([]);
  });

  test('NEGATIVE CONTROL: a released message that already went is not called back by a later app change', async () => {
    const screen = await openPaused();
    await userSends('Add a dark mode');
    runsB(screen);
    await vi.waitFor(() => expect(m.delivered).toEqual(['Add a dark mode']));
    await openFromSwitcher('app-aaaa');
    await settle(100);
    expect(m.box).toBe('');
    expect(m.notices).toEqual([]);
  });

  test('🟢 a message given back goes back through the chat, and the page shows no notice of its own', async () => {
    await openPaused();
    m.deferOpen = true;
    await userSends('Add a dark mode');
    type('something else');
    m.chat!.onChatChange!('chat-2');
    // The chat (not the page) offers it back.
    await vi.waitFor(() => expect(m.giveBack).toHaveBeenCalledWith('Add a dark mode'));
    expect(document.body.textContent).not.toMatch(/was not sent/);
  });

  test('a resume that fails gives the message back and shows why', async () => {
    const screen = await openPaused();
    m.openReject = new SandboxApiError('busy', 409, 'conflict');
    await userSends('Add a dark mode');
    await vi.waitFor(() => expect(m.box).toBe('Add a dark mode'));
    expect(m.queued).toBeNull();
    m.openError = m.openReject;
    screen.rerender(<Workspace />);
    await expect
      .element(page.getByText('That app was changing at the same moment. Try again.'))
      .toBeVisible();
    expect(m.delivered).toEqual([]);
  });

  test('opening another app while one resumes gives the message back, and the resume does not pull the user back', async () => {
    const screen = await openPaused();
    m.deferOpen = true;
    await userSends('Add a dark mode');
    await openFromSwitcher('app-aaaa');
    await vi.waitFor(() => expect(m.box).toBe('Add a dark mode'));
    m.deferOpen = false;
    m.settleOpen!();
    runsB(screen);
    await settle(100);
    await expect.element(switcher()).toHaveAccessibleName(/^Switch app: app-aaaa,/);
    expect(m.delivered).toEqual([]);
  });

  test('a running app whose tools cannot be handed over gives the message back rather than holding forever', async () => {
    m.list = [
      sandbox('sbx-aaaaaaaaaaaa'),
      sandbox('sbx-bbbbbbbbbbbb', { mcpUrl: 'https://elsewhere.example/s/x/mcp' }),
    ];
    const screen = await mount();
    await openFromSwitcher('app-bbbb');
    m.list = [m.list[0], { ...m.list[1], state: 'suspended' }];
    screen.rerender(<Workspace />);
    await expect.element(switcher()).toHaveAccessibleName('Switch app: app-bbbb, Paused');
    await userSends('Add a dark mode');
    runsB(screen);
    await vi.waitFor(() => expect(m.box).toBe('Add a dark mode'));
    expect(m.queued).toBeNull();
    expect(m.delivered).toEqual([]);
  });

  test('after the chat itself gave the message back (its wait ran out), the next message to the still-paused app waits in turn', async () => {
    const screen = await openPaused();
    m.deferOpen = true;
    await userSends('Add a dark mode');
    // The page has rendered with its record of the held message (a page that also held the chat for
    // it, by holdReason, would now block the re-send below).
    await settle();
    // The chat's own wait (QUEUE_TIMEOUT_MS) runs out: it gives the message back by itself.
    m.queued = null;
    m.giveBack('Add a dark mode');
    m.announce();
    m.box = '';
    await userSends('Add a dark mode');
    expect(m.queued).toEqual({
      text: 'Add a dark mode',
      waiting: 'Your app is starting…',
      held: true,
    });
    m.deferOpen = false;
    m.settleOpen!();
    runsB(screen);
    await vi.waitFor(() => expect(m.delivered).toEqual(['Add a dark mode']));
  });

  // 0.14.0 asks again for a reply that lost its connection (Retry, or by itself as the page wakes) with
  // no before-send, so the page's hold above never sees it.
  // Skipped outside the `component-quarantine` run: tests in this group time out at 15s on CI runs;
  // the cause is not found, so the whole group waits. See scripts/ci/component-quarantine.mjs.
  describe.skipIf(!quarantineRun)('a failed reply the chat asks for again', () => {
    /** The paused app's failed reply, and the page waking: the chat asks for it again by itself. */
    async function wakesPaused() {
      const screen = await openPaused();
      m.failed = true;
      m.pageWakes('visible');
      await expectHeld();
      return screen;
    }
    /** The page kept the chat's ask back and is waking the paused app: nothing went on without its tools. */
    async function expectHeld() {
      expect(m.retried).toEqual([]);
      await vi.waitFor(() => expect(m.resume.mock.calls).toEqual([['app-bbbb']]));
    }

    test('🔴 while the app is paused, the ask is cancelled, the app woken, and the reply asked for once it runs', async () => {
      const screen = await wakesPaused();
      // Another wake while the app wakes is cancelled too, without waking it again.
      m.pageWakes('online');
      expect(m.retried).toEqual([]);
      await settle(100);
      expect(m.resume).toHaveBeenCalledTimes(1);
      expect(m.retryReply).not.toHaveBeenCalled();
      runsB(screen);
      await vi.waitFor(() => expect(m.retried).toEqual(['retryReply']));
      await settle(100);
      expect(m.retryReply).toHaveBeenCalledTimes(1);
      expect(m.retried).toEqual(['retryReply']);
      expect(m.resume).toHaveBeenCalledTimes(1);
    });

    test('🔴 Retry pressed while the app is paused wakes it too, and asks once it runs', async () => {
      const screen = await openPaused();
      m.failed = true;
      expect(m.resumeReply('retry')).toBe(false);
      expect(m.retried).toEqual([]);
      expect(m.resume.mock.calls).toEqual([['app-bbbb']]);
      runsB(screen);
      await vi.waitFor(() => expect(m.retried).toEqual(['retryReply']));
    });

    test('🔴 the reply is asked for only once the chat has listed the tools just handed to it', async () => {
      const screen = await wakesPaused();
      m.listsOnUpdate = true;
      runsB(screen);
      await vi.waitFor(() => expect(m.listing).toBe(true));
      await settle(100);
      expect(m.retryReply).not.toHaveBeenCalled();
      setListing(false);
      await vi.waitFor(() => expect(m.retried).toEqual(['retryReply']));
      expect(m.retryReply).toHaveBeenCalledTimes(1);
    });

    test('NEGATIVE CONTROL: Retry pressed while the app runs with its tools goes on, uncancelled', async () => {
      await mount();
      await openFirst();
      m.failed = true;
      expect(m.resumeReply('retry')).toBe(true);
      expect(m.retried).toEqual(['retry']);
      await settle(100);
      expect(m.refetches).toBe(0);
      expect(m.resume).not.toHaveBeenCalled();
      expect(m.retryReply).not.toHaveBeenCalled();
    });

    describe('when the chat asks by itself, as the page wakes, the app list is refreshed first', () => {
      /** App B open and, as far as the page last knew before it slept, running with its tools. */
      async function openRunningB() {
        const screen = await mount();
        m.chat!.onChatChange!('chat-1');
        await openFromSwitcher('app-bbbb');
        m.open.mockClear();
        m.resume.mockClear();
        return screen;
      }
      const pausedWhileAsleep = (other: Sandbox['state'] = 'suspended') => [
        { ...m.list[0], state: other },
        { ...m.list[1], state: 'suspended' as const },
      ];

      test('🔴 an app paused while the page slept is woken, and the reply asked for once it runs', async () => {
        const screen = await openRunningB();
        m.service = pausedWhileAsleep();
        m.failed = true;
        m.pageWakes('visible');
        // Kept back at once, though the page still read the app as running.
        expect(m.retried).toEqual([]);
        await vi.waitFor(() => expect(m.resume.mock.calls).toEqual([['app-bbbb']]));
        expect(m.refetches).toBe(1);
        expect(m.retryReply).not.toHaveBeenCalled();
        runsB(screen);
        await vi.waitFor(() => expect(m.retried).toEqual(['retryReply']));
        expect(m.retryReply).toHaveBeenCalledTimes(1);
      });

      test('🔴 an app still running with its tools gets the reply asked for, without waking it', async () => {
        await openRunningB();
        m.failed = true;
        m.pageWakes('online');
        expect(m.retried).toEqual([]);
        await vi.waitFor(() => expect(m.retried).toEqual(['retryReply']));
        expect(m.refetches).toBe(1);
        expect(m.resume).not.toHaveBeenCalled();
      });

      test('🟡 a refresh that fails gives the ask up: no wake, no ask', async () => {
        const screen = await openRunningB();
        m.service = pausedWhileAsleep();
        m.refetchFails = true;
        m.failed = true;
        m.pageWakes('visible');
        expect(m.retried).toEqual([]);
        await vi.waitFor(() => expect(m.refetches).toBe(1));
        await settle(100);
        runsB(screen);
        await settle(100);
        expect(m.resume).not.toHaveBeenCalled();
        expect(m.retryReply).not.toHaveBeenCalled();
        expect(m.refetches).toBe(1);
      });

      test('🟡 a refresh that never answers gives the ask up after APP_LIST_REFRESH_TIMEOUT_MS', async () => {
        await openRunningB();
        m.refetchHangs = true;
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        m.failed = true;
        m.pageWakes('visible');
        await vi.advanceTimersByTimeAsync(APP_LIST_REFRESH_TIMEOUT_MS + 1000);
        vi.useRealTimers();
        // Given up: the next wake is kept back and nothing more is asked or refreshed.
        m.refetchHangs = false;
        m.pageWakes('online');
        await settle(100);
        expect(m.retried).toEqual([]);
        expect(m.refetches).toBe(1);
        expect(m.retryReply).not.toHaveBeenCalled();
        // Nothing is still waiting on the refresh: Retry on the running app goes straight on.
        expect(m.resumeReply('retry')).toBe(true);
        expect(m.retried).toEqual(['retry']);
      });

      test('🟡 an app the refresh finds starting gives the ask up', async () => {
        const screen = await openRunningB();
        m.service = [m.list[0], { ...m.list[1], state: 'starting' }];
        m.failed = true;
        m.pageWakes('visible');
        await vi.waitFor(() => expect(m.refetches).toBe(1));
        await settle(100);
        runsB(screen);
        await settle(100);
        expect(m.resume).not.toHaveBeenCalled();
        expect(m.retryReply).not.toHaveBeenCalled();
      });

      test('🟡 an app the chat already woke by itself in this chat is not woken by it again', async () => {
        const screen = await openRunningB();
        m.service = pausedWhileAsleep();
        m.failed = true;
        m.pageWakes('visible');
        await vi.waitFor(() => expect(m.resume).toHaveBeenCalledTimes(1));
        runsB(screen);
        await vi.waitFor(() => expect(m.retried).toEqual(['retryReply']));
        // A later reply in the same chat fails, and the app is paused again while the page sleeps.
        m.failed = true;
        m.autoResumed = false;
        m.autoCancelled = false;
        m.service = pausedWhileAsleep();
        m.pageWakes('visible');
        await vi.waitFor(() => expect(m.refetches).toBe(2));
        await settle(100);
        expect(m.resume).toHaveBeenCalledTimes(1);
        expect(m.retryReply).toHaveBeenCalledTimes(1);
      });

      test('🟡 an app whose waking would pause another app the user has running is not woken; Retry still wakes it', async () => {
        await openRunningB();
        m.service = pausedWhileAsleep('running');
        m.failed = true;
        m.pageWakes('visible');
        await vi.waitFor(() => expect(m.refetches).toBe(1));
        await settle(100);
        expect(m.resume).not.toHaveBeenCalled();
        expect(m.retryReply).not.toHaveBeenCalled();
        expect(m.retried).toEqual([]);
        // The user pressing Retry wakes it, pausing the other as a typed message would.
        expect(m.resumeReply('retry')).toBe(false);
        expect(m.resume.mock.calls).toEqual([['app-bbbb']]);
      });

      test('🟡 Retry pressed while the page refreshes the list is followed as Retry: it wakes the app though another runs', async () => {
        await openRunningB();
        m.service = pausedWhileAsleep('running');
        m.failed = true;
        m.pageWakes('visible');
        // Before the refresh answers.
        expect(m.resumeReply('retry')).toBe(false);
        await vi.waitFor(() => expect(m.resume.mock.calls).toEqual([['app-bbbb']]));
        expect(m.refetches).toBe(1);
      });

      test('🟡 a message the user sends after a give-up lets the chat’s own ask for a later reply go again', async () => {
        await openRunningB();
        m.refetchFails = true;
        m.failed = true;
        m.pageWakes('visible');
        await vi.waitFor(() => expect(m.refetches).toBe(1));
        await settle(50);
        m.refetchFails = false;
        await userSends('Add a dark mode');
        // That reply fails too; the app still runs with its tools.
        m.failed = true;
        m.autoResumed = false;
        m.autoCancelled = false;
        m.pageWakes('online');
        await vi.waitFor(() => expect(m.retried).toEqual(['retryReply']));
        expect(m.refetches).toBe(2);
      });

      test('🟡 the page going away while it refreshes the list wakes nothing', async () => {
        const screen = await openRunningB();
        m.service = pausedWhileAsleep();
        m.failed = true;
        m.pageWakes('visible');
        screen.unmount();
        await vi.waitFor(() => expect(m.refetches).toBe(1));
        await settle(100);
        expect(m.resume).not.toHaveBeenCalled();
      });

      test('🟡 after the user’s next message, the chat asking by itself for a later reply wakes the app again', async () => {
        const screen = await openRunningB();
        m.service = pausedWhileAsleep();
        m.failed = true;
        m.pageWakes('visible');
        await vi.waitFor(() => expect(m.resume).toHaveBeenCalledTimes(1));
        runsB(screen);
        await vi.waitFor(() => expect(m.retried).toEqual(['retryReply']));
        // A new turn, whose reply fails; the app is paused again while the page sleeps.
        await userSends('and a timer');
        expect(m.delivered).toEqual(['and a timer']);
        m.failed = true;
        m.autoResumed = false;
        m.autoCancelled = false;
        m.service = pausedWhileAsleep();
        m.pageWakes('visible');
        await vi.waitFor(() => expect(m.resume).toHaveBeenCalledTimes(2));
        runsB(screen);
        await vi.waitFor(() => expect(m.retried).toEqual(['retryReply', 'retryReply']));
      });

      test('🟡 an app gone from the refreshed list (deleted elsewhere) gives the ask up, and is not made again', async () => {
        const screen = await openPaused();
        m.service = [m.list[0]];
        m.failed = true;
        m.pageWakes('visible');
        await vi.waitFor(() => expect(m.refetches).toBe(1));
        await settle(100);
        screen.rerender(<Workspace />);
        await settle(50);
        expect(m.resume).not.toHaveBeenCalled();
        expect(m.open).not.toHaveBeenCalled();
        expect(m.retryReply).not.toHaveBeenCalled();
      });

      test('🟢 Retry pressed while a refresh that then fails runs is followed on the list the page has', async () => {
        await openPaused();
        m.refetchFails = true;
        m.failed = true;
        m.pageWakes('visible');
        // Before the refresh answers.
        expect(m.resumeReply('retry')).toBe(false);
        await vi.waitFor(() => expect(m.refetches).toBe(1));
        await vi.waitFor(() => expect(m.resume.mock.calls).toEqual([['app-bbbb']]));
      });

      test('🟡 the chat asking by itself wakes an app once for a chat, however often the page wakes', async () => {
        const screen = await openRunningB();
        m.service = pausedWhileAsleep();
        m.failed = true;
        m.pageWakes('visible');
        await vi.waitFor(() => expect(m.resume).toHaveBeenCalledTimes(1));
        // Running, then paused again before the chat could take the ask: given up.
        setListing(true);
        runsB(screen);
        await settle(50);
        m.list = [m.list[0], { ...m.list[1], state: 'suspended' }];
        screen.rerender(<Workspace />);
        await settle(50);
        setListing(false);
        m.pageWakes('online');
        await settle(100);
        expect(m.resume).toHaveBeenCalledTimes(1);
        expect(m.retryReply).not.toHaveBeenCalled();
        // Kept back without a second refresh: given up, not merely not woken again.
        expect(m.refetches).toBe(1);
      });
    });

    test('🟡 a message the user sends meanwhile ends it: the reply is not asked for after it', async () => {
      const screen = await wakesPaused();
      await userSends('Add a dark mode');
      runsB(screen);
      await vi.waitFor(() => expect(m.delivered).toEqual(['Add a dark mode']));
      await settle(100);
      expect(m.retryReply).not.toHaveBeenCalled();
    });

    test('🔴 a waiting message and a resume ask never both act: the send ends the ask, and no ask starts while the message waits', async () => {
      const screen = await wakesPaused();
      // The user writes while the page wakes the app for the chat's ask: the ask ends before the message
      // is kept back.
      await userSends('Add a dark mode');
      expect(m.queued).toEqual({
        text: 'Add a dark mode',
        waiting: 'Your app is starting…',
        held: true,
      });
      // The page wakes again while the message waits: the chat holds, so it does not ask again.
      m.failed = true;
      m.pageWakes('online');
      expect(m.retried).toEqual([]);
      runsB(screen);
      await vi.waitFor(() => expect(m.delivered).toEqual(['Add a dark mode']));
      await settle(100);
      // Only the message went: no reply was asked for again, before or after it.
      expect(m.retryReply).not.toHaveBeenCalled();
      expect(m.retried).toEqual([]);
      expect(m.delivered).toEqual(['Add a dark mode']);
    });

    test('🟡 opening another chat meanwhile ends it', async () => {
      const screen = await wakesPaused();
      m.chat!.onChatChange!('chat-2');
      runsB(screen);
      await settle(100);
      expect(m.retryReply).not.toHaveBeenCalled();
    });

    test('🟡 opening another chat while it waits on the chat ends it, before the page re-renders', async () => {
      const screen = await wakesPaused();
      setListing(true);
      runsB(screen);
      await settle(100);
      expect(m.retryReply).not.toHaveBeenCalled();
      // As the element reports it: chat-change, then can-send-change, before the page re-renders.
      m.chat!.onChatChange!('chat-2');
      setListing(false);
      await settle(100);
      expect(m.retryReply).not.toHaveBeenCalled();
    });

    test('🟡 opening another app meanwhile ends it, and the wake does not pull the user back', async () => {
      const screen = await openPaused();
      m.deferOpen = true;
      m.failed = true;
      m.pageWakes('visible');
      await expectHeld();
      // Picking the other (paused) app starts it too, so keep the first wake's answer apart.
      const settleB = m.settleOpen!;
      await openFromSwitcher('app-aaaa');
      m.deferOpen = false;
      settleB();
      // Both apps then run with their tools: only the one the reply was for would have them.
      m.list = [
        { ...m.list[0], state: 'running' },
        { ...m.list[1], state: 'running' },
      ];
      screen.rerender(<Workspace />);
      await settle(100);
      await expect.element(switcher()).toHaveAccessibleName(/^Switch app: app-aaaa,/);
      expect(m.retryReply).not.toHaveBeenCalled();
    });

    test('🟡 an app that does not run within RESUME_ASK_TIMEOUT_MS ends it', async () => {
      const screen = await openPaused();
      m.deferOpen = true;
      vi.useFakeTimers({ toFake: ['setTimeout'] });
      m.failed = true;
      m.pageWakes('visible');
      await expectHeld();
      await vi.advanceTimersByTimeAsync(RESUME_ASK_TIMEOUT_MS + 1000);
      vi.useRealTimers();
      m.settleOpen!();
      runsB(screen);
      await settle(100);
      expect(m.retryReply).not.toHaveBeenCalled();
    });

    test('INVARIANT: an app that runs just inside RESUME_ASK_TIMEOUT_MS still gets its reply asked for', async () => {
      const screen = await openPaused();
      m.deferOpen = true;
      vi.useFakeTimers({ toFake: ['setTimeout'] });
      m.failed = true;
      m.pageWakes('visible');
      await vi.advanceTimersByTimeAsync(RESUME_ASK_TIMEOUT_MS - 2000);
      vi.useRealTimers();
      m.settleOpen!();
      runsB(screen);
      await vi.waitFor(() => expect(m.retried).toEqual(['retryReply']));
    });

    test('🟡 an app that runs just before RESUME_ASK_TIMEOUT_MS still gets that long again for the chat to take the ask', async () => {
      const screen = await openPaused();
      m.deferOpen = true;
      // Restarting the deadline clears the first one, so clearTimeout is faked too.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      m.failed = true;
      m.pageWakes('visible');
      await expectHeld();
      await vi.advanceTimersByTimeAsync(RESUME_ASK_TIMEOUT_MS - 2000);
      m.settleOpen!();
      setListing(true);
      runsB(screen);
      await vi.advanceTimersByTimeAsync(4000);
      vi.useRealTimers();
      setListing(false);
      await vi.waitFor(() => expect(m.retried).toEqual(['retryReply']));
    });

    test('🟡 a chat that never takes the ask once the app runs ends it after RESUME_ASK_TIMEOUT_MS again, so Retry goes on', async () => {
      const screen = await wakesPaused();
      // The deadline restarted once the app ran clears the first one, so clearTimeout is faked too.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      setListing(true);
      runsB(screen);
      await vi.advanceTimersByTimeAsync(RESUME_ASK_TIMEOUT_MS + 1000);
      vi.useRealTimers();
      // Given up: the listing ending asks nothing, and the user's Retry is no longer kept back.
      setListing(false);
      await settle(100);
      expect(m.retryReply).not.toHaveBeenCalled();
      expect(m.resumeReply('retry')).toBe(true);
      expect(m.retried).toEqual(['retry']);
    });

    // Skipped for CI browser-starvation timeouts, until it waits on state instead of time.
    test.skipIf(!quarantineRun)('🟡 an app paused again once it had started ends it', async () => {
      const screen = await wakesPaused();
      m.list = [m.list[0], { ...m.list[1], state: 'starting' }];
      screen.rerender(<Workspace />);
      await settle(50);
      m.list = [m.list[0], { ...m.list[1], state: 'suspended' }];
      screen.rerender(<Workspace />);
      await settle(50);
      runsB(screen);
      await settle(100);
      expect(m.retryReply).not.toHaveBeenCalled();
    });

    // Skipped for CI browser-starvation timeouts, until it waits on state instead of time.
    test.skipIf(!quarantineRun)(
      '🟡 an app paused while the reply waits on the chat ends it',
      async () => {
        const screen = await wakesPaused();
        setListing(true);
        runsB(screen);
        await settle(100);
        m.list = [m.list[0], { ...m.list[1], state: 'suspended' }];
        screen.rerender(<Workspace />);
        await settle(50);
        setListing(false);
        await settle(100);
        expect(m.retryReply).not.toHaveBeenCalled();
      }
    );

    test('🟡 a running app whose tools cannot be handed to the chat ends it rather than asking without them', async () => {
      m.list = [
        sandbox('sbx-aaaaaaaaaaaa'),
        sandbox('sbx-bbbbbbbbbbbb', { mcpUrl: 'https://elsewhere.example/s/x/mcp' }),
      ];
      const screen = await mount();
      m.chat!.onChatChange!('chat-1');
      await openFromSwitcher('app-bbbb');
      m.list = [m.list[0], { ...m.list[1], state: 'suspended' }];
      screen.rerender(<Workspace />);
      await expect.element(switcher()).toHaveAccessibleName('Switch app: app-bbbb, Paused');
      m.resume.mockClear();
      m.failed = true;
      // Retry: the user's press, so the other running app does not keep it from waking.
      expect(m.resumeReply('retry')).toBe(false);
      await expectHeld();
      runsB(screen);
      await settle(100);
      expect(m.retryReply).not.toHaveBeenCalled();
    });

    test('🟡 a wake that fails ends it, so the next ask wakes the app again', async () => {
      await openPaused();
      m.openReject = new SandboxApiError('busy', 409, 'conflict');
      m.failed = true;
      m.resumeReply('retry');
      await vi.waitFor(() => expect(m.open).toHaveBeenCalledTimes(1));
      await settle(50);
      m.openReject = null;
      expect(m.resumeReply('retry')).toBe(false);
      expect(m.resume.mock.calls).toEqual([['app-bbbb'], ['app-bbbb']]);
    });

    test('🟡 an app the wake brings back running without tools it can hand over, outside a test render, ends it', async () => {
      await openPaused();
      m.deferOpen = true;
      m.failed = true;
      m.pageWakes('visible');
      await expectHeld();
      // The service brings the app back under a new name, running at an address outside the sandbox
      // service. The page learns it from the wake's answer, as it would, not from a test re-render.
      m.list = [
        m.list[0],
        sandbox('sbx-bbbbnewnewnw', {
          app: 'app-bbbb',
          mcpUrl: 'https://elsewhere.example/s/x/mcp',
        }),
      ];
      m.settleOpen!();
      await expect.element(switcher()).toHaveAccessibleName(/^Switch app: app-bbbb, /);
      await settle(100);
      expect(m.retryReply).not.toHaveBeenCalled();
    });

    test('🟡 the chat asking again by itself wakes the app only once for a chat; Retry still wakes it', async () => {
      await openPaused();
      m.deferOpen = true;
      vi.useFakeTimers({ toFake: ['setTimeout'] });
      m.failed = true;
      m.pageWakes('visible');
      await expectHeld();
      await vi.advanceTimersByTimeAsync(RESUME_ASK_TIMEOUT_MS + 1000);
      vi.useRealTimers();
      // Given up: the chat asks again on the next wake, and the page keeps it back without waking the app.
      m.pageWakes('online');
      expect(m.retried).toEqual([]);
      expect(m.resume).toHaveBeenCalledTimes(1);
      await settle(50);
      expect(m.refetches).toBe(1);
      // The user pressing Retry still wakes it.
      expect(m.resumeReply('retry')).toBe(false);
      expect(m.resume).toHaveBeenCalledTimes(2);
    });

    test('🟡 the page going away while it waits on the chat ends it', async () => {
      const screen = await wakesPaused();
      setListing(true);
      runsB(screen);
      await settle(100);
      screen.unmount();
      setListing(false);
      await settle(100);
      expect(m.retryReply).not.toHaveBeenCalled();
    });
  });
});

describe('AppAssistantWorkspace subagents', () => {
  test('are off unless the page allows them', async () => {
    await mount();
    expect(m.chat!.subagents).toBeUndefined();
  });

  test('when allowed, the chat gets the read-only allowlist', async () => {
    const { APP_ASSISTANT_SUBAGENTS } = await import('./assistantSubagents');
    await page.viewport(1440, 900);
    renderWithProviders(
      <ModalsProvider>
        <AppAssistantWorkspace canPreview sandboxUrl={BASE} subagents />
      </ModalsProvider>
    );
    await expect.element(page.getByTestId('chat')).toBeInTheDocument();
    expect(m.chat!.subagents).toBe(APP_ASSISTANT_SUBAGENTS);
  });
});

describe('AppAssistantWorkspace on a visit', () => {
  test('opens the app used most recently, without starting it', async () => {
    m.list = [
      sandbox('sbx-aaaaaaaaaaaa', { state: 'suspended', lastActivityAt: '2026-10-01T10:00:00Z' }),
      sandbox('sbx-bbbbbbbbbbbb', { state: 'suspended', lastActivityAt: '2026-10-03T10:00:00Z' }),
      sandbox('sbx-cccccccccccc', { state: 'suspended', createdAt: '2026-10-02T10:00:00Z' }),
    ];
    await mount();
    await expect.element(switcher()).toHaveAccessibleName('Switch app: app-bbbb, Paused');
    expect(m.open).not.toHaveBeenCalled();
    expect(m.chat!.holdReason).toBeUndefined();
  });

  test('New app after that stays on no app', async () => {
    m.list = [sandbox('sbx-aaaaaaaaaaaa', { lastActivityAt: '2026-10-01T10:00:00Z' })];
    const screen = await mount();
    await expect.element(switcher()).toHaveAccessibleName(/^Switch app: app-aaaa,/);
    await switcher().click();
    await page.getByRole('button', { name: 'New app' }).click();
    screen.rerender(<Workspace />);
    await settle();
    await expect.element(switcher()).toHaveAccessibleName('Switch app: no app open');
  });
});

describe('AppAssistantWorkspace Build it', () => {
  /** A checklist card for a new app that runs, so the chat no longer holds. */
  async function checklistCard() {
    m.list = [];
    const screen = await mount();
    m.chat!.beforeToolCall!('create_app', {}, conv);
    await m.chat!.tools.create_app.execute({ name: 'Quiz' }, ctx);
    m.list = [{ ...m.list[0], state: 'running' }];
    screen.rerender(<Workspace />);
    await vi.waitFor(() => expect(m.chat!.holdReason).toBeUndefined());
    const input = { items: [{ label: 'Ask questions' }] };
    expect(m.chat!.beforeToolCall!('set_checklist', input, conv)).toEqual({ allow: true });
    const output = await m.chat!.tools.set_checklist.execute(input, ctx);
    const card = m.chat!.tools.set_checklist.render!({
      name: 'set_checklist',
      input,
      state: 'done',
      output,
    }) as HTMLElement;
    document.body.append(card);
    return card;
  }
  const buildIt = () => page.getByRole('button', { name: 'Build it' });

  test('the checklist card offers Build it, which sends the confirmation as the user', async () => {
    const card = await checklistCard();
    await buildIt().click();
    await vi.waitFor(() => expect(m.delivered).toEqual(['Looks good — build it.']));
    await expect.element(buildIt()).not.toBeInTheDocument();
    card.remove();
  });

  test('🟢 Build it pressed while the reply is still ending puts it in the box for the user to send', async () => {
    const card = await checklistCard();
    m.running = true;
    await buildIt().click();
    await expect.element(buildIt()).not.toBeInTheDocument();
    expect(m.box).toBe('Looks good — build it.');
    expect(m.delivered).toEqual([]);
    card.remove();
  });

  test('🟢 Build it pressed while the reply is still ending keeps what the user typed, and offers itself back', async () => {
    const card = await checklistCard();
    type('Also add a timer');
    m.running = true;
    await buildIt().click();
    await expect.element(buildIt()).not.toBeInTheDocument();
    expect(m.box).toBe('Also add a timer');
    // Offered back by the chat (0.15.0's giveBack), not by a notice of the page's own.
    await vi.waitFor(() => expect(m.notices).toEqual(['Looks good — build it.']));
    expect(m.delivered).toEqual([]);
    card.remove();
  });

  test('🟢 Build it pressed while the chat holds goes into the empty box once, and is not offered back as well', async () => {
    const card = await checklistCard();
    m.listing = true;
    await buildIt().click();
    await expect.element(buildIt()).not.toBeInTheDocument();
    expect(m.box).toBe('Looks good — build it.');
    await settle(100);
    expect(m.notices).toEqual([]);
    card.remove();
  });

  test('🟡 Build it pressed while the user dictates goes straight out when the chat does not hold', async () => {
    const card = await checklistCard();
    m.dictating = true;
    await buildIt().click();
    await vi.waitFor(() => expect(m.delivered).toEqual(['Looks good — build it.']));
    expect(m.box).toBe('');
    await settle(100);
    expect(m.giveBack).not.toHaveBeenCalled();
    card.remove();
  });

  test('🟡 Build it pressed while the user dictates and the chat holds is offered back, not joined to what they say', async () => {
    const card = await checklistCard();
    m.dictating = true;
    m.listing = true;
    await buildIt().click();
    await expect.element(buildIt()).not.toBeInTheDocument();
    endDictation('and a timer');
    expect(m.box).toBe('and a timer');
    await vi.waitFor(() => expect(m.notices).toEqual(['Looks good — build it.']));
    expect(m.delivered).toEqual([]);
    card.remove();
  });

  test('a message the user sends instead takes Build it away', async () => {
    const card = await checklistCard();
    await userSends('Also add a timer');
    expect(m.delivered).toEqual(['Also add a timer']);
    expect(card.querySelector('button')).toBeNull();
    card.remove();
  });

  test('opening another chat takes Build it away', async () => {
    const card = await checklistCard();
    m.chat!.onChatChange!('chat-2');
    expect(card.querySelector('button')).toBeNull();
    card.remove();
  });

  test('🟡 opening another app takes Build it away: the checklist was for the first', async () => {
    m.list = [sandbox('sbx-aaaaaaaaaaaa')];
    const screen = await mount();
    await openFirst();
    const input = { items: [{ label: 'Ask questions' }] };
    m.chat!.beforeToolCall!('set_checklist', input, conv);
    const output = await m.chat!.tools.set_checklist.execute(input, ctx);
    const card = m.chat!.tools.set_checklist.render!({
      name: 'set_checklist',
      input,
      state: 'done',
      output,
    }) as HTMLElement;
    document.body.append(card);
    expect(card.querySelector('button')).not.toBeNull();
    m.list = [...m.list, sandbox('sbx-bbbbbbbbbbbb')];
    screen.rerender(<Workspace />);
    await openFromSwitcher('app-bbbb');
    await vi.waitFor(() => expect(card.querySelector('button')).toBeNull());
    card.remove();
  });
});

describe('AppAssistantWorkspace mobile Chat/Preview', () => {
  test('switches to Preview the first time a preview starts, not on a reconnect', async () => {
    await mount();
    await page.viewport(375, 812);
    await openFirst();
    expect(document.querySelector('[role="radiogroup"]')).toBeNull();
    await startPreview('my-app');
    await expect.element(page.getByRole('radio', { name: 'Preview' })).toBeChecked();
    await page.getByText('Chat', { exact: true }).click();
    await expect.element(page.getByRole('radio', { name: 'Chat' })).toBeChecked();
    // The tunnel dropped and the assistant started it again.
    await startPreview('my-app');
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect.element(page.getByRole('radio', { name: 'Chat' })).toBeChecked();
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
    await openFromSwitcher('app-bbbb');
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
    await openFromSwitcher('app-bbbb');
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
  test('a resume refused for the running-app limit is shown as that, with the switcher closed', async () => {
    m.list = [sandbox('sbx-aaaaaaaaaaaa', { state: 'suspended' }), sandbox('sbx-bbbbbbbbbbbb')];
    const screen = await mount();
    await openFromSwitcher('app-aaaa');
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
    await switcher().click();
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
  test('offers create_app, generate_app_cover, report_ready and set_checklist beside the preview tools, and refuses an unchecked ready', async () => {
    await mount();
    expect(Object.keys(m.chat!.tools).sort()).toEqual([
      'create_app',
      'generate_app_cover',
      'report_ready',
      'set_checklist',
      'start_preview',
      'stop_preview',
      'use_open_app',
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
    expect(m.chat!.beforeToolCall!('report_ready', { data: 'civitai' }, conv)).toEqual({
      allow: true,
    });

    await openFromSwitcher('app-bbbb');
    await vi.waitFor(() =>
      expect(m.chat!.beforeToolCall!('report_ready', { data: 'civitai' }, conv)).toHaveProperty(
        'refuse'
      )
    );
  });

  test('a new chat beside the open app may not change it until it chooses it, and another app is not chosen', async () => {
    await mount();
    await openFirst();
    const write = (chat: typeof conv) =>
      m.chat!.beforeToolCall!('sandbox__write_file', { path: 'app-aaaa/src/block.ts' }, chat);
    // The page hands the gate the open app: the change is refused, naming it.
    expect(write(conv)).toEqual({ refuse: openAppNotChosen('app-aaaa') });
    // Choosing it (the user asked to change it) lets the chat change it.
    const chosen = await m.chat!.tools.use_open_app.execute({ app: 'app-aaaa' }, ctx);
    m.chat!.onToolResult!({ name: 'use_open_app', input: {}, output: chosen, isError: false });
    expect(write(conv)).toEqual({ allow: true });
    // Another chat (New chat) chose nothing.
    expect(write({ conversationId: 'c-new', reply: 1 })).toEqual({
      refuse: openAppNotChosen('app-aaaa'),
    });
    // The user switches app: this chat chose the first one, not this one.
    await openFromSwitcher('app-bbbb');
    await vi.waitFor(() =>
      expect(m.chat!.beforeToolCall!('sandbox__write_file', {}, { ...conv, reply: 2 })).toEqual({
        refuse: openAppNotChosen('app-bbbb'),
      })
    );
  });

  test('a reloaded chat that made the open app may change it once its saved create_app shows', async () => {
    await mount();
    await openFirst();
    const saved = { conversationId: 'chat-1', reply: 1 };
    const write = () =>
      m.chat!.beforeToolCall!('sandbox__write_file', { path: 'app-aaaa/a' }, saved);
    m.chat!.onChatChange!('chat-1');
    expect(write()).toEqual({ refuse: openAppNotChosen('app-aaaa') });
    m.chat!.tools.create_app.render!({
      name: 'create_app',
      input: { name: 'App aaaa' },
      state: 'done',
      output: { app: 'app-aaaa', state: 'running', note: 'n' },
    });
    expect(write()).toEqual({ allow: true });
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

describe('AppAssistantWorkspace preview after a reload on the server runner', () => {
  const HOST = 'dev-77aa88bb99cc00dd.civit.ai';
  const RESTARTED = 'dev-1122334455667788.civit.ai';
  const RATE_LIMITED =
    'Too many previews were started in the last hour. Wait a few minutes, then try again.';
  const pane = () => page.getByTestId('app-assistant-preview-pane');
  /** A visit: the app worked on last (`app-aaaa`) runs, and opens by itself. */
  async function reload({ remoteRunner = true }: { remoteRunner?: boolean } = {}) {
    m.list = [
      sandbox('sbx-aaaaaaaaaaaa', { lastActivityAt: '2026-10-23T10:00:00.000Z' }),
      sandbox('sbx-bbbbbbbbbbbb', {
        state: 'suspended',
        lastActivityAt: '2026-10-22T10:00:00.000Z',
      }),
    ];
    await page.viewport(1440, 900);
    renderWithProviders(
      <ModalsProvider>
        <AppAssistantWorkspace canPreview sandboxUrl={BASE} remoteRunner={remoteRunner} />
      </ModalsProvider>
    );
    await expect.element(page.getByTestId('chat')).toBeInTheDocument();
    await expect.element(switcher()).toHaveAccessibleName(/^Switch app: app-aaaa,/);
  }

  test('a live preview is shown at once, and the runner is asked for nothing', async () => {
    r.probe.mockResolvedValue({ blockId: 'app-aaaa', host: HOST, iframeSrc: `https://${HOST}/` });
    await reload();
    await expect.element(pane()).toBeInTheDocument();
    expect(m.previewSession).toEqual({ blockId: 'app-aaaa', host: HOST, sessionId: null, view: 1 });
    expect(r.probe.mock.calls).toEqual([['app-aaaa']]);
    expect(r.restart).not.toHaveBeenCalled();
  });

  test('no live preview: the pane offers Restart preview, and shows no preview', async () => {
    r.probe.mockRejectedValue(new Error('No live preview is running for this app'));
    await reload();
    await expect.element(pane()).toBeInTheDocument();
    await vi.waitFor(() =>
      expect(r.pane).toEqual({ onRestart: expect.any(Function), pending: false, error: null })
    );
    expect(m.previewSession).toBeNull();
    expect(r.restart).not.toHaveBeenCalled();
  });

  test('Restart preview asks the runner once, however often it is clicked, and shows its preview', async () => {
    r.probe.mockRejectedValue(new Error('No live preview is running for this app'));
    let answer!: (shown: unknown) => void;
    r.restart.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    await reload();
    await vi.waitFor(() => expect(r.pane).toBeDefined());
    r.pane!.onRestart();
    r.pane!.onRestart();
    await vi.waitFor(() => expect(r.pane).toMatchObject({ pending: true }));
    r.pane!.onRestart();
    answer({ blockId: 'app-aaaa', host: RESTARTED });
    await vi.waitFor(() =>
      expect(m.previewSession).toEqual({
        blockId: 'app-aaaa',
        host: RESTARTED,
        sessionId: null,
        view: 1,
      })
    );
    expect(r.restart).toHaveBeenCalledTimes(1);
    expect(r.restart.mock.calls[0]![0]).toBe('app-aaaa');
    expect(r.pane).toEqual({ onRestart: expect.any(Function), pending: false, error: null });
  });

  test('a refused restart (429) is told in the runner’s words, and the offer stays', async () => {
    r.probe.mockRejectedValue(new Error('No live preview is running for this app'));
    r.restart.mockRejectedValue(new Error(RATE_LIMITED));
    await reload();
    await vi.waitFor(() => expect(r.pane).toBeDefined());
    r.pane!.onRestart();
    await vi.waitFor(() =>
      expect(r.pane).toEqual({
        onRestart: expect.any(Function),
        pending: false,
        error: RATE_LIMITED,
      })
    );
    await expect.element(pane()).toBeInTheDocument();
    expect(m.previewSession).toBeNull();
  });

  test('opening another app looks for its preview too; a paused one is not looked at', async () => {
    r.probe.mockRejectedValue(new Error('No live preview is running for this app'));
    await reload();
    await vi.waitFor(() => expect(r.probe).toHaveBeenCalledTimes(1));
    await openFromSwitcher('app-bbbb');
    await settle();
    // Paused: no preview to look for, and no offer.
    expect(r.probe).toHaveBeenCalledTimes(1);
    expect(pane().query()).toBeNull();
  });

  test('an app the runner just made is not looked at: its preview opens with its dev server', async () => {
    await mountRunnerEmpty();
    m.chat!.onToolResult!({
      name: 'create_app',
      input: {},
      output: { app: 'fresh-app' },
      isError: false,
    });
    m.list = [...m.list, sandbox('sbx-fresh0000000', { app: 'fresh-app' })];
    await expect.element(switcher()).toHaveAccessibleName(/^Switch app: fresh-app,/);
    await settle();
    expect(r.probe).not.toHaveBeenCalled();
    expect(pane().query()).toBeNull();
  });

  test('NEGATIVE CONTROL: replies in the browser never look for one', async () => {
    r.probe.mockRejectedValue(new Error('No live preview is running for this app'));
    await reload({ remoteRunner: false });
    await settle();
    expect(r.probe).not.toHaveBeenCalled();
    expect(pane().query()).toBeNull();
  });

  /** The runner, with no app open on the visit (none says when it was used). */
  async function mountRunnerEmpty() {
    await page.viewport(1440, 900);
    renderWithProviders(
      <ModalsProvider>
        <AppAssistantWorkspace canPreview sandboxUrl={BASE} remoteRunner />
      </ModalsProvider>
    );
    await expect.element(page.getByTestId('chat')).toBeInTheDocument();
  }
});

describe('AppAssistantWorkspace preview on the server runner', () => {
  const HOST = 'dev-0123456789abcdef.civit.ai';
  const RunnerWorkspace = () => (
    <ModalsProvider>
      <AppAssistantWorkspace canPreview sandboxUrl={BASE} remoteRunner />
    </ModalsProvider>
  );
  async function mountRunner(width = 1440) {
    await page.viewport(width, 900);
    renderWithProviders(<RunnerWorkspace />);
    await expect.element(page.getByTestId('chat')).toBeInTheDocument();
  }
  /** The runner journaled a finished call (`tool-reported`); the chat hands it to the page. */
  const reported = (name: string, output: unknown, isError = false) =>
    m.chat!.onToolResult!({ name, input: {}, output, isError });
  const pane = () => page.getByTestId('app-assistant-preview-pane');

  test('does not hand the chat the page-only generate_app_cover tool', async () => {
    await mountRunner();
    expect(Object.keys(m.chat!.tools).sort()).toEqual([
      'create_app',
      'report_ready',
      'set_checklist',
      'start_preview',
      'stop_preview',
      'use_open_app',
    ]);
  });

  test('shows the preview the runner started, a fresh frame on each start, and hides it on stop', async () => {
    await mountRunner();
    await openFirst();
    expect(pane().query()).toBeNull();

    reported('start_preview', { shown: true, blockId: 'app-aaaa', host: HOST, next_step: 'x' });
    await expect.element(pane()).toBeInTheDocument();
    expect(m.previewSession).toEqual({ blockId: 'app-aaaa', host: HOST, sessionId: null, view: 1 });

    // Started again (the user came back): a new view, so the pane fetches a fresh frame.
    reported('start_preview', { shown: true, blockId: 'app-aaaa', host: HOST });
    await vi.waitFor(() => expect(m.previewSession).toMatchObject({ view: 2 }));

    reported('stop_preview', { stopped: true });
    await expect.element(pane()).not.toBeInTheDocument();
    // The page has no id for the runner's tunnel and never stops it: the runner and civitai do.
    expect(m.stop).not.toHaveBeenCalled();
  });

  test('a failed start shows nothing', async () => {
    await mountRunner();
    await openFirst();
    reported('start_preview', { error: 'Too many previews' }, true);
    await settle();
    expect(pane().query()).toBeNull();
  });

  test('NEGATIVE CONTROL: replies in the browser show only the page’s own start', async () => {
    await mount();
    await openFirst();
    reported('start_preview', { shown: true, blockId: 'app-aaaa', host: HOST });
    await settle();
    expect(pane().query()).toBeNull();
  });

  test('on a phone, Chat/Preview appears once the runner’s preview exists, on Preview', async () => {
    await mountRunner(375);
    await openFirst();
    expect(document.querySelector('[role="radiogroup"]')).toBeNull();
    reported('start_preview', { shown: true, blockId: 'app-aaaa', host: HOST });
    await expect.element(page.getByRole('radio', { name: 'Preview' })).toBeChecked();
  });

  test('opening another app hides it, stopping nothing', async () => {
    await mountRunner();
    await openFirst();
    reported('start_preview', { shown: true, blockId: 'app-aaaa', host: HOST });
    await expect.element(pane()).toBeInTheDocument();
    await openFromSwitcher('app-bbbb');
    await expect.element(pane()).not.toBeInTheDocument();
    expect(m.stop).not.toHaveBeenCalled();
  });
});

const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

describe('AppAssistantWorkspace paused-app notice', () => {
  // aaaa was used last, so a visit opens it; created in the other order.
  const pausedApps = () => [
    sandbox('sbx-aaaaaaaaaaaa', { state: 'suspended', lastActivityAt: ago(2), createdAt: ago(30) }),
    sandbox('sbx-bbbbbbbbbbbb', { state: 'suspended', lastActivityAt: ago(9), createdAt: ago(20) }),
  ];
  const notice = () => page.getByRole('region', { name: 'App status' });
  const startButton = () => notice().getByRole('button', { name: 'Start app' });

  test('🔴 a visit opens the app used last, says it is paused, and starts nothing by itself', async () => {
    m.list = pausedApps();
    await mount();
    await expect.element(switcher()).toHaveAccessibleName('Switch app: app-aaaa, Paused');
    await expect.element(notice().getByText('app-aaaa is paused.', { exact: true })).toBeVisible();
    await expect.element(startButton()).toBeVisible();
    await settle(300);
    expect(m.open).not.toHaveBeenCalled();
    expect(m.resume).not.toHaveBeenCalled();
  });

  test('the notice is in the chat’s composer-top slot', async () => {
    m.list = pausedApps();
    await mount();
    await expect.element(notice()).toBeVisible();
    expect(notice().element().closest('[slot]')?.getAttribute('slot')).toBe('composer-top');
    expect(notice().element().closest('[data-testid="chat"]')).not.toBeNull();
  });

  test('🔴 after Start, the page asks for its apps itself until the app runs, even with the list poll stalled', async () => {
    m.list = pausedApps();
    const screen = await mount();
    await startButton().click();
    // The service has it starting, and then running; the page's list only changes when it asks.
    m.list = [{ ...m.list[0], state: 'starting' }, m.list[1]];
    screen.rerender(<Workspace />);
    await expect.element(notice().getByText('Starting…', { exact: true })).toBeVisible();
    m.service = [{ ...m.list[0], state: 'running' }, m.list[1]];
    await vi.waitFor(
      () => expect(switcher()).toHaveAccessibleName('Switch app: app-aaaa, Running'),
      {
        timeout: APP_START_POLL_MS * 3,
      }
    );
    await expect.element(notice()).not.toBeInTheDocument();
    expect(m.startPolls).toBeGreaterThanOrEqual(1);
  });

  test('a start that never finishes stops asking after the timeout, says so, and Check again asks afresh', async () => {
    m.list = [
      sandbox('sbx-aaaaaaaaaaaa', {
        state: 'starting',
        lastActivityAt: ago(2),
        createdAt: ago(30),
      }),
      pausedApps()[1],
    ];
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await mount();
    await expect.element(switcher()).toHaveAccessibleName('Switch app: app-aaaa, Starting…');
    await vi.advanceTimersByTimeAsync(APP_START_TIMEOUT_MS + APP_START_POLL_MS);
    await expect
      .element(
        notice().getByText('app-aaaa is taking longer than expected to start.', { exact: true })
      )
      .toBeVisible();
    const polls = m.startPolls;
    expect(polls).toBeGreaterThan(1);
    // Stopped asking.
    await vi.advanceTimersByTimeAsync(APP_START_POLL_MS * 3);
    expect(m.startPolls).toBe(polls);
    // Check again: asks at once and keeps asking; once it runs, the notice goes.
    m.service = [{ ...m.list[0], state: 'running' }, m.list[1]];
    await notice().getByRole('button', { name: 'Check again' }).click();
    await vi.advanceTimersByTimeAsync(APP_START_POLL_MS * 2);
    await vi.waitFor(() =>
      expect(switcher()).toHaveAccessibleName('Switch app: app-aaaa, Running')
    );
    await expect.element(notice()).not.toBeInTheDocument();
  });

  test('NEGATIVE CONTROL: a running app is not asked about', async () => {
    m.list = [sandbox('sbx-aaaaaaaaaaaa', { lastActivityAt: ago(2), createdAt: ago(30) })];
    await mount();
    await settle(APP_START_POLL_MS + 500);
    expect(m.startPolls).toBe(0);
  });

  test('NEGATIVE CONTROL: a running app shows no notice', async () => {
    m.list = [sandbox('sbx-aaaaaaaaaaaa', { lastActivityAt: ago(2), createdAt: ago(30) })];
    await mount();
    await expect.element(switcher()).toHaveAccessibleName('Switch app: app-aaaa, Running');
    await settle();
    expect(notice().query()).toBeNull();
  });

  test('Start app starts it once, says Starting… while it starts, and goes once it runs', async () => {
    m.list = pausedApps();
    const screen = await mount();
    await expect.element(startButton()).toBeVisible();
    m.deferOpen = true;
    await startButton().click();
    expect(m.resume.mock.calls).toEqual([['app-aaaa']]);
    await expect.element(notice().getByText('Starting…', { exact: true })).toBeVisible();
    await expect.element(startButton()).toHaveAttribute('data-loading', 'true');

    m.settleOpen!();
    m.list = [{ ...m.list[0], state: 'starting' }, m.list[1]];
    screen.rerender(<Workspace />);
    await expect.element(notice().getByText('Starting…', { exact: true })).toBeVisible();
    await vi.waitFor(() => expect(notice().getByRole('button').elements()).toHaveLength(0));

    m.list = [{ ...m.list[0], state: 'running' }, m.list[1]];
    screen.rerender(<Workspace />);
    await expect.element(notice()).not.toBeInTheDocument();
    expect(m.open.mock.calls).toEqual([['app-aaaa']]);
    expect(m.resume).toHaveBeenCalledTimes(1);
  });

  test('a start that fails says why and keeps Start app', async () => {
    m.list = pausedApps();
    await mount();
    m.openReject = new SandboxApiError('Sandbox service error (500)', 500, 'unavailable');
    await startButton().click();
    await expect
      .element(
        notice().getByText('Your apps could not be reached right now. Try again in a moment.', {
          exact: true,
        })
      )
      .toBeVisible();
    await expect.element(startButton()).toBeEnabled();
    await expect.element(notice().getByText('app-aaaa is paused.', { exact: true })).toBeVisible();
  });

  test('says that starting it pauses the app that runs', async () => {
    m.list = [
      pausedApps()[0],
      sandbox('sbx-bbbbbbbbbbbb', { lastActivityAt: ago(9), createdAt: ago(20) }),
    ];
    await mount();
    await expect
      .element(notice().getByText('Starting it pauses app-bbbb.', { exact: true }))
      .toBeVisible();
  });

  test('NEGATIVE CONTROL: with no other app running, there is no such hint', async () => {
    m.list = pausedApps();
    await mount();
    await expect.element(startButton()).toBeVisible();
    expect(
      notice()
        .getByText(/pauses/)
        .elements()
    ).toHaveLength(0);
  });

  test('a message sent while paused goes through the existing hold, starting it once, and the notice follows', async () => {
    m.list = pausedApps();
    await mount();
    await userSends('Add a high-score table');
    expect(m.queued).toMatchObject({ text: 'Add a high-score table', held: true });
    expect(m.resume.mock.calls).toEqual([['app-aaaa']]);
    await expect.element(notice().getByText('Starting…', { exact: true })).toBeVisible();
  });
});

/** The gateway's export and the browser's download, stubbed for one test. */
function stubExport() {
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== BASE) throw new Error(`unexpected fetch ${url.href}`);
    const item = /^\/v1\/sandboxes\/([a-z0-9-]+)$/.exec(url.pathname);
    if (item && (init?.method ?? 'GET') === 'GET') {
      const found = m.list.find((s) => s.name === item[1]);
      // The app came up.
      return found
        ? Response.json({ ...found, state: 'running' })
        : Response.json({ error: 'not found' }, { status: 404 });
    }
    const exported = /^\/s\/([a-z0-9-]+)\/export$/.exec(url.pathname);
    if (exported) {
      m.events.push(`export ${exported[1]} ${url.searchParams.get('app')}`);
      m.exportAuth.push(new Headers(init?.headers).get('authorization'));
      const status = m.exportAnswers.shift();
      if (status) return Response.json({ error: `export refused (${status})` }, { status });
      return new Response(new Blob(['PK-zip-bytes'], { type: 'application/zip' }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url.href}`);
  });
  const clickSpy = vi
    .spyOn(HTMLAnchorElement.prototype, 'click')
    .mockImplementation(function (this: HTMLAnchorElement) {
      m.events.push(`download ${this.download}`);
      m.downloads.push({ name: this.download, href: this.href });
    });
  return () => {
    fetchSpy.mockRestore();
    clickSpy.mockRestore();
  };
}

const EXPORT_NOTE_TEXT =
  'It has the app’s own files only: no node_modules, build output, caches, logs, .git, keys or .env files (.env.example is kept).';

describe('AppAssistantWorkspace app menu: Start and Export', () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
  });
  const actions = (app: string) => page.getByRole('button', { name: `Actions for ${app}` });
  async function openMenu(app: string) {
    if (!document.querySelector('[role="dialog"]')) await switcher().click();
    await actions(app).click();
  }
  const twoApps = () => [
    sandbox('sbx-aaaaaaaaaaaa'),
    sandbox('sbx-bbbbbbbbbbbb', { state: 'suspended' }),
  ];

  test('a paused app’s menu offers Start, saying which running app it pauses, and Export', async () => {
    m.list = twoApps();
    await mount();
    await openMenu('app-bbbb');
    const start = page.getByRole('menuitem', { name: /^Start/ });
    await expect.element(start.getByText('Start', { exact: true })).toBeVisible();
    await expect.element(start.getByText('app-aaaa will be paused', { exact: true })).toBeVisible();
    const exportItem = page.getByRole('menuitem', { name: /^Export/ });
    await expect.element(exportItem.getByText('Export', { exact: true })).toBeVisible();
    await expect.element(exportItem.getByText('Download as zip', { exact: true })).toBeVisible();
    // Exporting a paused app starts it, so it says so too.
    await expect
      .element(exportItem.getByText('app-aaaa will be paused', { exact: true }))
      .toBeVisible();
  });

  test('NEGATIVE CONTROL: a running app’s menu has Export but no Start', async () => {
    m.list = twoApps();
    await mount();
    await openMenu('app-aaaa');
    await expect.element(page.getByRole('menuitem', { name: /^Export/ })).toBeVisible();
    expect(page.getByRole('menuitem', { name: /^Start/ }).elements()).toHaveLength(0);
    // A running app is exported as it is: nothing is paused.
    expect(
      page
        .getByRole('menuitem', { name: /^Export/ })
        .getByText(/will be paused/)
        .elements()
    ).toHaveLength(0);
  });

  test('Export of an app that is gone (its start made a new, empty one) deletes that one and says so, downloading nothing', async () => {
    restore = stubExport();
    m.list = twoApps();
    await mount();
    await openMenu('app-bbbb');
    // Deleted elsewhere since the page last listed it.
    m.list = [m.list[0]];
    await page.getByRole('menuitem', { name: /^Export/ }).click();
    await vi.waitFor(() => expect(m.toasts).toHaveLength(1));
    expect(m.toasts[0]).toMatchObject({
      kind: 'error',
      message: 'This app no longer exists, so there is nothing to export.',
    });
    expect(m.open.mock.calls).toEqual([['app-bbbb']]);
    expect(m.remove.mock.calls).toEqual([['sbx-new-app-bbbb']]);
    expect(m.events).toEqual(['start app-bbbb']);
    expect(m.downloads).toEqual([]);
  });

  test('one export at a time: while one runs, Export is off in every menu', async () => {
    restore = stubExport();
    m.list = twoApps();
    await mount();
    await openMenu('app-bbbb');
    m.deferOpen = true;
    await page.getByRole('menuitem', { name: /^Export/ }).click();
    await expect.element(actions('app-bbbb')).toHaveAttribute('data-loading', 'true');
    await actions('app-aaaa').click();
    await expect.element(page.getByRole('menuitem', { name: /^Export/ })).toBeDisabled();
    // NEGATIVE CONTROL: once it is done, Export is on again.
    m.settleOpen!();
    await vi.waitFor(() => expect(m.downloads).toHaveLength(1));
    // app-aaaa's menu is still open.
    await expect.element(page.getByRole('menuitem', { name: /^Export/ })).toBeEnabled();
  });

  test('Start starts that app, with only its own menu button busy', async () => {
    m.list = twoApps();
    await mount();
    await openMenu('app-bbbb');
    m.deferOpen = true;
    await page.getByRole('menuitem', { name: /^Start/ }).click();
    expect(m.resume.mock.calls).toEqual([['app-bbbb']]);
    await expect.element(actions('app-bbbb')).toHaveAttribute('data-loading', 'true');
    expect(actions('app-aaaa').element().hasAttribute('data-loading')).toBe(false);
    m.settleOpen!();
    await vi.waitFor(() =>
      expect(actions('app-bbbb').element().hasAttribute('data-loading')).toBe(false)
    );
    expect(m.open.mock.calls).toEqual([['app-bbbb']]);
  });

  test('Export downloads a running app as <app>.zip with the sandbox token, starting nothing, and says what it holds', async () => {
    restore = stubExport();
    m.list = twoApps();
    await mount();
    await openMenu('app-aaaa');
    await page.getByRole('menuitem', { name: /^Export/ }).click();
    await vi.waitFor(() => expect(m.downloads).toHaveLength(1));
    expect(m.downloads[0].name).toBe('app-aaaa.zip');
    expect(m.downloads[0].href).toMatch(/^blob:/);
    expect(m.events).toEqual(['export sbx-aaaaaaaaaaaa app-aaaa', 'download app-aaaa.zip']);
    expect(m.exportAuth).toEqual(['Bearer sandbox-token']);
    expect(m.getToken).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'sandbox' }));
    expect(m.open).not.toHaveBeenCalled();
    expect(m.toasts).toEqual([
      { kind: 'success', title: 'Downloaded app-aaaa.zip', message: EXPORT_NOTE_TEXT },
    ]);
  });

  test('Export of a paused app starts it first, then downloads, with its menu button busy meanwhile', async () => {
    restore = stubExport();
    m.list = twoApps();
    await mount();
    await openMenu('app-bbbb');
    m.deferOpen = true;
    await page.getByRole('menuitem', { name: /^Export/ }).click();
    await expect.element(actions('app-bbbb')).toHaveAttribute('data-loading', 'true');
    expect(actions('app-aaaa').element().hasAttribute('data-loading')).toBe(false);
    expect(m.events).toEqual([]);
    m.settleOpen!();
    await vi.waitFor(() => expect(m.downloads).toHaveLength(1));
    expect(m.events).toEqual([
      'start app-bbbb',
      'export sbx-bbbbbbbbbbbb app-bbbb',
      'download app-bbbb.zip',
    ]);
    await vi.waitFor(() =>
      expect(actions('app-bbbb').element().hasAttribute('data-loading')).toBe(false)
    );
  });

  test('a 413 says the app is too large, and downloads nothing', async () => {
    restore = stubExport();
    m.exportAnswers = [413];
    m.list = twoApps();
    await mount();
    await openMenu('app-aaaa');
    await page.getByRole('menuitem', { name: /^Export/ }).click();
    await vi.waitFor(() => expect(m.toasts).toHaveLength(1));
    expect(m.toasts[0]).toMatchObject({
      kind: 'error',
      message: 'This app is too large to export.',
    });
    expect(m.downloads).toEqual([]);
    expect(m.open).not.toHaveBeenCalled();
  });

  test('a 409 (not running) starts the app once and exports again', async () => {
    restore = stubExport();
    m.exportAnswers = [409];
    m.list = twoApps();
    await mount();
    await openMenu('app-aaaa');
    await page.getByRole('menuitem', { name: /^Export/ }).click();
    await vi.waitFor(() => expect(m.downloads).toHaveLength(1));
    expect(m.events).toEqual([
      'export sbx-aaaaaaaaaaaa app-aaaa',
      'start app-aaaa',
      'export sbx-aaaaaaaaaaaa app-aaaa',
      'download app-aaaa.zip',
    ]);
  });

  test('any other failure is a plain error, with no retry and no download', async () => {
    restore = stubExport();
    m.exportAnswers = [500];
    m.list = twoApps();
    await mount();
    await openMenu('app-aaaa');
    await page.getByRole('menuitem', { name: /^Export/ }).click();
    await vi.waitFor(() => expect(m.toasts).toHaveLength(1));
    expect(m.toasts[0]).toMatchObject({
      kind: 'error',
      message: 'The app could not be exported. Try again in a moment.',
    });
    expect(m.events).toEqual(['export sbx-aaaaaaaaaaaa app-aaaa']);
    expect(m.downloads).toEqual([]);
  });
});

describe('AppAssistantWorkspace free-a-slot card', () => {
  const KEEP =
    'You already have as many apps as you can keep. Choose one to delete in the card under the chat, and your message is sent again.';
  const RUNNING =
    'Another of your apps started at the same moment, so this one could not. Ask again: starting this app pauses the others.';
  const card = () => page.getByRole('region', { name: 'Free up a slot' });
  let restore: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
  });
  // Used: aaaa last (open on load, running), bbbb longest ago, cccc between; created in another order.
  const kept = () => [
    sandbox('sbx-aaaaaaaaaaaa', { lastActivityAt: ago(2), createdAt: ago(40) }),
    sandbox('sbx-bbbbbbbbbbbb', { state: 'suspended', lastActivityAt: ago(9), createdAt: ago(20) }),
    sandbox('sbx-cccccccccccc', { state: 'suspended', lastActivityAt: ago(5), createdAt: ago(30) }),
  ];
  const keepCap = () =>
    new SandboxApiError('sandbox limit (3) reached; delete one first', 409, 'limit');
  /** The chat runs create_app behind its own gate and reports the call to the page, as in the browser. */
  async function createApp(error: unknown) {
    m.openReject = error;
    const gated = gateToolSet(m.chat!.tools as never, {
      conversationId: 'c',
      gate: (name, input, context) => m.chat!.beforeToolCall!(name, input, context) as never,
      onResult: (result) => m.chat!.onToolResult!(result),
    });
    await Promise.resolve(
      gated.create_app.execute!({ name: 'Quiz night' }, {
        toolCallId: 't-1',
        messages: [],
      } as never)
    ).catch(() => undefined);
    m.openReject = null;
  }
  async function atLimit() {
    m.list = kept();
    const screen = await mount();
    await expect.element(switcher()).toHaveAccessibleName('Switch app: app-aaaa, Running');
    await userSends('Make a quiz night app');
    await createApp(keepCap());
    await expect.element(card()).toBeVisible();
    return screen;
  }
  async function confirmDelete(app: string) {
    await card().getByRole('button', { name: 'Delete and continue' }).click();
    await expect.element(page.getByRole('dialog', { name: `Delete ${app}?` })).toBeVisible();
    await page.getByRole('button', { name: 'Delete app' }).click();
  }

  test('appears after the limit refusal: every app with its status and last use, the one used longest ago chosen', async () => {
    await atLimit();
    await expect.element(card().getByText('Free up a slot', { exact: true })).toBeVisible();
    await expect
      .element(
        card().getByText(
          'You have as many apps as you can keep. Delete one and your message is sent again.',
          { exact: true }
        )
      )
      .toBeVisible();
    await expect.element(card().getByRole('radio', { name: 'app-bbbb' })).toBeChecked();
    await expect.element(card().getByRole('radio', { name: 'app-aaaa' })).not.toBeChecked();
    await expect.element(card().getByRole('radio', { name: 'app-cccc' })).not.toBeChecked();
    for (const line of [
      'Running · last used 2 days ago',
      'Paused · last used 9 days ago',
      'Paused · last used 5 days ago',
    ])
      await expect.element(card().getByText(line, { exact: true })).toBeVisible();
    await expect
      .element(
        card().getByText('Exporting a paused app starts it, which pauses app-aaaa.', {
          exact: true,
        })
      )
      .toBeVisible();
    expect(m.remove).not.toHaveBeenCalled();
  });

  test('while the card shows, the page does not also tell the limit above; once it goes, it does', async () => {
    const screen = await atLimit();
    // The start create_app asked for failed at the cap: the apps' latest error.
    m.openError = keepCap();
    screen.rerender(<Workspace />);
    await settle();
    expect(
      page.getByText('You have as many apps as you can keep', { exact: true }).elements()
    ).toHaveLength(0);
    await userSends('Actually, change the colors');
    await expect.element(card()).not.toBeInTheDocument();
    await expect
      .element(page.getByText('You have as many apps as you can keep', { exact: true }))
      .toBeVisible();
  });

  test('a limit reported after the user opened another chat sends nothing again', async () => {
    await atLimit();
    await userSends('Never mind');
    m.chat!.onChatChange!('chat-2');
    m.chat!.onToolResult!({
      name: 'create_app',
      input: { name: 'Quiz night' },
      output: { error: KEEP },
      isError: true,
    });
    await expect.element(card()).toBeVisible();
    await confirmDelete('app-bbbb');
    await vi.waitFor(() => expect(m.remove).toHaveBeenCalledTimes(1));
    await settle(100);
    expect(m.send).not.toHaveBeenCalled();
    await expect.element(card()).not.toBeInTheDocument();
  });

  test('the card is in the chat’s thread-end slot', async () => {
    await atLimit();
    expect(card().element().closest('[slot]')?.getAttribute('slot')).toBe('thread-end');
    expect(card().element().closest('[data-testid="chat"]')).not.toBeNull();
  });

  test('when the app used longest ago is the open one, the next oldest is chosen', async () => {
    m.list = [
      sandbox('sbx-aaaaaaaaaaaa', {
        state: 'suspended',
        lastActivityAt: ago(2),
        createdAt: ago(40),
      }),
      sandbox('sbx-bbbbbbbbbbbb', { lastActivityAt: ago(9), createdAt: ago(20) }),
      sandbox('sbx-cccccccccccc', {
        state: 'suspended',
        lastActivityAt: ago(5),
        createdAt: ago(30),
      }),
    ];
    await mount();
    await openFromSwitcher('app-bbbb');
    await userSends('Make a quiz night app');
    await createApp(keepCap());
    await expect.element(card().getByRole('radio', { name: 'app-cccc' })).toBeChecked();
    await expect.element(card().getByRole('radio', { name: 'app-bbbb' })).not.toBeChecked();
    await expect.element(card().getByRole('radio', { name: 'app-aaaa' })).not.toBeChecked();
  });

  test('NEGATIVE CONTROL: the running-app limit shows no card', async () => {
    m.list = kept();
    await mount();
    await userSends('Make a quiz night app');
    await createApp(
      new SandboxApiError(
        'running-sandbox limit (1) reached: sbx-aaaaaaaaaaaa (app "app-aaaa") is running; suspend it first',
        409,
        'limit'
      )
    );
    await settle(100);
    expect(card().query()).toBeNull();
  });

  test('Keep it in the confirmation deletes nothing and keeps the card', async () => {
    await atLimit();
    await card().getByRole('button', { name: 'Delete and continue' }).click();
    await expect.element(page.getByRole('dialog', { name: 'Delete app-bbbb?' })).toBeVisible();
    await page.getByRole('button', { name: 'Keep it' }).click();
    await settle();
    expect(m.remove).not.toHaveBeenCalled();
    expect(m.send).not.toHaveBeenCalled();
    await expect.element(card()).toBeVisible();
  });

  test('confirmed, deletes the app picked, then sends the message that hit the limit again, once', async () => {
    await atLimit();
    await card().getByRole('radio', { name: 'app-cccc' }).click();
    await confirmDelete('app-cccc');
    await vi.waitFor(() => expect(m.send).toHaveBeenCalledTimes(1));
    expect(m.remove.mock.calls).toEqual([['sbx-cccccccccccc']]);
    expect(m.send).toHaveBeenCalledWith('Make a quiz night app');
    expect(m.remove.mock.invocationCallOrder[0]).toBeLessThan(m.send.mock.invocationCallOrder[0]);
    await expect.element(card()).not.toBeInTheDocument();
    await settle(100);
    expect(m.send).toHaveBeenCalledTimes(1);
    expect(m.delivered).toEqual(['Make a quiz night app', 'Make a quiz night app']);
  });

  test('a delete that fails says why, keeps the card and sends nothing', async () => {
    await atLimit();
    m.removeReject = new SandboxApiError('Sandbox service error (500)', 500, 'unavailable');
    await confirmDelete('app-bbbb');
    await expect
      .element(
        card().getByText('Your apps could not be reached right now. Try again in a moment.', {
          exact: true,
        })
      )
      .toBeVisible();
    expect(m.remove.mock.calls).toEqual([['sbx-bbbbbbbbbbbb']]);
    await settle(100);
    expect(m.send).not.toHaveBeenCalled();
    await expect.element(card().getByRole('button', { name: 'Delete and continue' })).toBeEnabled();
  });

  test('goes once the user sends something else', async () => {
    await atLimit();
    await userSends('Actually, change the colors');
    await expect.element(card()).not.toBeInTheDocument();
    expect(m.remove).not.toHaveBeenCalled();
  });

  test('Export first downloads that app’s zip, starting it first, and deletes nothing', async () => {
    restore = stubExport();
    await atLimit();
    m.events = [];
    await card().getByRole('button', { name: 'Export app-bbbb first' }).click();
    await vi.waitFor(() => expect(m.downloads.map((d) => d.name)).toEqual(['app-bbbb.zip']));
    expect(m.events).toEqual([
      'start app-bbbb',
      'export sbx-bbbbbbbbbbbb app-bbbb',
      'download app-bbbb.zip',
    ]);
    expect(m.remove).not.toHaveBeenCalled();
    await expect.element(card()).toBeVisible();
  });

  test('on the server runner, appears from the reported limit, and not from the running limit', async () => {
    await page.viewport(1440, 900);
    m.list = kept();
    renderWithProviders(
      <ModalsProvider>
        <AppAssistantWorkspace canPreview sandboxUrl={BASE} remoteRunner />
      </ModalsProvider>
    );
    await expect.element(page.getByTestId('chat')).toBeInTheDocument();
    await expect.element(switcher()).toHaveAccessibleName('Switch app: app-aaaa, Running');
    await userSends('Make a quiz night app');
    // What the runner journals (`tool-reported`) and the chat hands the page.
    m.chat!.onToolResult!({
      name: 'create_app',
      input: { name: 'Quiz night' },
      output: { error: RUNNING },
      isError: true,
    });
    await settle(100);
    expect(card().query()).toBeNull();
    m.chat!.onToolResult!({
      name: 'create_app',
      input: { name: 'Quiz night' },
      output: { error: KEEP },
      isError: true,
    });
    await expect.element(card().getByRole('radio', { name: 'app-bbbb' })).toBeChecked();
    await confirmDelete('app-bbbb');
    await vi.waitFor(() => expect(m.send).toHaveBeenCalledTimes(1));
    expect(m.send).toHaveBeenCalledWith('Make a quiz night app');
  });

  test('on the server runner, appears from the limit in a released runner’s words (v0.0.9)', async () => {
    await page.viewport(1440, 900);
    m.list = kept();
    renderWithProviders(
      <ModalsProvider>
        <AppAssistantWorkspace canPreview sandboxUrl={BASE} remoteRunner />
      </ModalsProvider>
    );
    await expect.element(page.getByTestId('chat')).toBeInTheDocument();
    await expect.element(switcher()).toHaveAccessibleName('Switch app: app-aaaa, Running');
    await userSends('A tiny click counter app.');
    // The runner ships separately from the page and bundles the wording it was released with: this is
    // runner v0.0.9's KEEP_LIMIT, byte for byte (`git show assistant-runner-v0.0.9:packages/
    // civitai-app-assistant/src/app-tools.ts`), as its `tool-reported` result carries it.
    m.chat!.onToolResult!({
      name: 'create_app',
      input: { name: 'Click counter' },
      output: {
        error:
          'You already have as many apps as you can keep. Delete one you no longer need from the app switcher at the top of the page, then ask again.',
      },
      isError: true,
    });
    await expect.element(card().getByRole('radio', { name: 'app-bbbb' })).toBeChecked();
    await confirmDelete('app-bbbb');
    await vi.waitFor(() => expect(m.send).toHaveBeenCalledTimes(1));
    expect(m.send).toHaveBeenCalledWith('A tiny click counter app.');
  });
});

describe('AppAssistantWorkspace keeps the app awake while the user works in its preview', () => {
  const HOST = 'dev-0123456789abcdef.civit.ai';
  const MCP = `${BASE}/s/sbx-aaaaaaaaaaaa/mcp`;
  const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
  beforeEach(() => {
    fetchSpy.mockClear();
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const pings = () =>
    (fetchSpy.mock.calls as unknown as [string, RequestInit][]).filter(([url]) => url === MCP);
  const pressInPane = () =>
    document
      .querySelector('[data-testid="app-assistant-preview-pane"]')!
      .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));

  function expectOnePing() {
    expect(pings()).toHaveLength(1);
    const init = pings()[0]![1];
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sandbox-token');
    expect(JSON.parse(init.body as string)).toEqual({
      jsonrpc: '2.0',
      id: 'keepalive',
      method: 'ping',
    });
  }

  test('a press in the preview pings the open app’s MCP endpoint, the activity its idle clock counts', async () => {
    await mount();
    await openFirst();
    await startPreview('my-app');
    await expect.element(page.getByTestId('preview')).toBeInTheDocument();
    await settle();
    // NEGATIVE CONTROL: a preview on screen with no one working in it sends nothing.
    expect(pings()).toHaveLength(0);

    pressInPane();
    await vi.waitFor(() => expect(pings()).toHaveLength(1));
    expectOnePing();
  });

  test('on the server runner too', async () => {
    await page.viewport(1440, 900);
    renderWithProviders(
      <ModalsProvider>
        <AppAssistantWorkspace canPreview sandboxUrl={BASE} remoteRunner />
      </ModalsProvider>
    );
    await expect.element(page.getByTestId('chat')).toBeInTheDocument();
    await openFirst();
    m.chat!.onToolResult!({
      name: 'start_preview',
      input: {},
      output: { shown: true, blockId: 'app-aaaa', host: HOST },
      isError: false,
    });
    await expect.element(page.getByTestId('app-assistant-preview-pane')).toBeInTheDocument();

    pressInPane();
    await vi.waitFor(() => expect(pings()).toHaveLength(1));
    expectOnePing();
  });

  test('NEGATIVE CONTROL: on a phone with the Chat tab shown, a press in the hidden preview sends nothing', async () => {
    // The suite loads no Tailwind utilities, so the pane's `hidden` class would not hide it here as
    // it does in production (CI showed the pane still laid out, 0 px tall, and pinging). Give this
    // test that one rule; at this width no `md:` rule applies.
    const tailwindHidden = document.createElement('style');
    tailwindHidden.textContent = '.hidden { display: none; }';
    document.head.appendChild(tailwindHidden);
    onTestFinished(() => tailwindHidden.remove());
    await page.viewport(375, 900);
    renderWithProviders(<Workspace />);
    await expect.element(page.getByTestId('chat')).toBeInTheDocument();
    await openFirst();
    await startPreview('my-app');
    await settle();
    await page.getByRole('radio', { name: 'Chat' }).click();
    await expect.element(page.getByTestId('app-assistant-preview-pane')).not.toBeVisible();
    const before = pings().length;
    // Past the one-minute interval, so a ping before this point cannot be what hides one now.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 61_000);

    pressInPane();
    await settle();
    expect(pings()).toHaveLength(before);

    // Positive control: the same press with Preview shown does ping.
    await page.getByRole('radio', { name: 'Preview' }).click();
    pressInPane();
    await vi.waitFor(() => expect(pings()).toHaveLength(before + 1));
  });
});
