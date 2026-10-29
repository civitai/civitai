import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Center,
  Group,
  Loader,
  Paper,
  Popover,
  SegmentedControl,
  Stack,
  Text,
  Title,
  UnstyledButton,
} from '@mantine/core';
import { IconSelector } from '@tabler/icons-react';
import { useMutation, useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import type {
  BeforeSendDetail,
  ChatMcpServer,
  ChatToolResult,
  CivitaiChat,
  QueuedMessage,
  ReplyResumeDetail,
} from '@civitai/components-chat/civitai-chat';
import { AppAssistantChat } from '~/components/Apps/AppAssistant/AppAssistantChat';
import { AppAssistantPreview } from '~/components/Apps/AppAssistant/AppAssistantPreview';
import {
  AppExportError,
  EXPORT_FAILED,
  EXPORT_NOTE,
  exportAppZip,
  exportFileName,
  saveBlob,
} from '~/components/Apps/AppAssistant/appExport';
import { isAppBlockId } from '~/components/Apps/AppAssistant/appKey';
import { mostRecentApp } from '~/components/Apps/AppAssistant/appLifecycle';
import {
  CREATE_APP,
  NO_APP_REFUSAL,
  createAppTools,
  isKeepLimitResult,
} from '~/components/Apps/AppAssistant/appTools';
import {
  BUILD_IT_MESSAGE,
  SANDBOX_SERVER_ID,
  SET_CHECKLIST,
  createAssistantGate,
} from '~/components/Apps/AppAssistant/assistantGate';
import { useFillScrollParent } from '~/components/Apps/AppAssistant/useFillScrollParent';
import { buildAssistantInstructions } from '~/components/Apps/AppAssistant/assistantInstructions';
import { APP_ASSISTANT_SUBAGENTS } from '~/components/Apps/AppAssistant/assistantSubagents';
import {
  AssistantTokenError,
  createAssistantTokenProvider,
} from '~/components/Apps/AppAssistant/assistantToken';
import { isDictating, messageBoxText } from '~/components/Apps/AppAssistant/chatAdapter';
import {
  chatTokenOrchestration,
  createBrowserCoverArtDeps,
  createCoverArt,
} from '~/components/Apps/AppAssistant/coverArt';
import { FreeUpSlotCard } from '~/components/Apps/AppAssistant/FreeUpSlotCard';
import { PausedAppNotice } from '~/components/Apps/AppAssistant/PausedAppNotice';
import type { PreviewSession } from '~/components/Apps/AppAssistant/previewTools';
import {
  createPreviewTools,
  runnerPreviewAction,
} from '~/components/Apps/AppAssistant/previewTools';
import { fetchPreviewFrame } from '~/components/Apps/AppAssistant/previewFrame';
import { pingSandbox, usePreviewKeepAlive } from '~/components/Apps/AppAssistant/previewKeepAlive';
import { fetchSandboxTunnelStatus } from '~/components/Apps/AppAssistant/previewTunnelStatus';
import {
  RESTART_PREVIEW_FAILED,
  appAssistantRemoteRunnerFor,
  createRunnerCredentials,
  restartRunnerPreview,
} from '~/components/Apps/AppAssistant/remoteRunner';
import type { Sandbox } from '~/components/Apps/AppAssistant/sandboxClient';
import {
  SandboxApiError,
  createSandboxClient,
  isRunningLimit,
  isSandboxServiceUrl,
} from '~/components/Apps/AppAssistant/sandboxClient';
import { useSandboxes } from '~/components/Apps/AppAssistant/useSandboxes';
import {
  APP_STATUS,
  AppError,
  appsError,
  confirmDeleteApp,
  runningOtherApp,
  YourAppsList,
} from '~/components/Apps/AppAssistant/YourApps';
import {
  ForkSetupCard,
  ForkStatus,
  useAppFork,
} from '~/components/Apps/AppAssistant/AppAssistantFork';
import { APP_ASSISTANT_DAILY_BUZZ_CAP } from '~/shared/constants/app-assistant.constants';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { FORK_SETUP_MESSAGE } from '~/shared/constants/app-fork.constants';
import { numberWithCommas } from '~/utils/number-helpers';
import { trpc, trpcVanilla } from '~/utils/trpc';
import classes from './AppAssistant.module.scss';

const NO_MCP_SERVERS: ChatMcpServer[] = [];
/** The app's tools are added only once it runs, so a message sent before then would go without them. */
export const APP_STARTING_HOLD = 'Your app is starting…';

/** How long the page keeps its record of a held message: the chat's own `QUEUE_TIMEOUT_MS` (3 minutes). */
export const HELD_RECORD_MS = 3 * 60_000;

/** No Restart preview in progress, and none failed. */
const IDLE_RESTART = { pending: false, error: null } as const;

function EnableCard({
  onEnable,
  pending,
  error,
}: {
  onEnable: () => void;
  pending: boolean;
  error: unknown;
}) {
  return (
    <Center className="py-10">
      <Paper withBorder radius="md" p="xl" maw={520}>
        <Stack gap="sm">
          <Title order={3}>Turn on App Assistant</Title>
          <Text size="sm">
            Describe an app in your own words and the assistant builds it for you, in a private
            workspace of your own. It can make images and other media for your app with your Buzz,
            up to {numberWithCommas(APP_ASSISTANT_DAILY_BUZZ_CAP)} Buzz a day. You can change that
            limit or turn the assistant off at any time under connected apps in your account
            settings.
          </Text>
          {!!error && (
            <Alert color="red" variant="light">
              {error instanceof Error ? error.message : 'App Assistant could not be turned on.'}
            </Alert>
          )}
          <Group justify="flex-end">
            <Button onClick={onEnable} loading={pending} className="min-h-11">
              Turn on App Assistant
            </Button>
          </Group>
        </Stack>
      </Paper>
    </Center>
  );
}

/**
 * How long the app has to run when a failed reply is asked for again (Retry, or the chat by itself),
 * and the chat as long again to take the ask once it does; past that the ask is given up. On purpose
 * the same 3 minutes as a held message's wait (`HELD_RECORD_MS`), but its own constant: it bounds the
 * page's own ask, which the chat knows nothing of.
 */
export const RESUME_ASK_TIMEOUT_MS = 3 * 60_000;

/**
 * While the open app starts, the page asks for its apps this often itself, whatever the list's own
 * polling does (a stalled poll once left the page on "Starting…" long after the app ran).
 */
export const APP_START_POLL_MS = 3_000;
/** How long the page keeps asking before it says the start is taking long and offers Check again. */
export const APP_START_TIMEOUT_MS = 5 * 60_000;

/** How long the page waits for its app list when the chat asks for a failed reply by itself. */
export const APP_LIST_REFRESH_TIMEOUT_MS = 10_000;

/**
 * Sends `text` as the user's. A copy the chat keeps back in a box that was empty (while it holds, or
 * on a refused grant) is hidden while the user dictates, and their words would be joined to it: such a
 * copy is taken back out, so the caller can give the message back instead. components-chat 0.30.0
 * no longer keeps such a copy while the user dictates, so there it takes nothing out; kept for a
 * chat that does.
 */
export async function sendNotJoined(
  chat: Pick<CivitaiChat, 'send' | 'compose'>,
  text: string,
  box: () => string,
  dictating: () => boolean,
  went: () => boolean
): Promise<void> {
  const empty = !box();
  await chat.send(text);
  if (empty && !went() && dictating() && box() === text) await chat.compose('');
}

type RetryChat = Pick<
  CivitaiChat,
  'canSend' | 'retryReply' | 'updateComplete' | 'addEventListener' | 'removeEventListener'
>;

/**
 * Asks the chat for its failed reply again (`retryReply()`), once, as soon as it can send: tools just
 * handed to it start listing in its next update, and `canSend` reads true until then, so this waits for
 * that update first. Asks nothing once `signal` aborts or the chat goes; whether it asked.
 */
export async function retryWhenReady(
  chatRef: { current: RetryChat | null },
  signal: AbortSignal
): Promise<boolean> {
  const chat = chatRef.current;
  if (!chat || signal.aborted) return false;
  let woken = false;
  let resume: (() => void) | undefined;
  const wake = () => {
    woken = true;
    resume?.();
  };
  chat.addEventListener('can-send-change', wake);
  signal.addEventListener('abort', wake);
  try {
    await chat.updateComplete;
    while (!signal.aborted && chatRef.current === chat) {
      woken = false;
      if (chat.canSend) return await chat.retryReply();
      if (!woken) await new Promise<void>((resolve) => (resume = resolve));
      resume = undefined;
    }
    return false;
  } finally {
    chat.removeEventListener('can-send-change', wake);
    signal.removeEventListener('abort', wake);
  }
}

export function AppAssistantWorkspace({
  canPreview,
  sandboxUrl,
  subagents = false,
  remoteRunner = false,
}: {
  canPreview: boolean;
  /** The hosted sandbox service's base URL, from the server; null when not configured. */
  sandboxUrl: string | null;
  /** The assistant may start read-only subagents. */
  subagents?: boolean;
  /**
   * Replies run on the server runner (`appAssistantRemoteRunner`), so they keep going while the user
   * is away. Off, they run in the browser exactly as before.
   */
  remoteRunner?: boolean;
}) {
  // A revoke surfaces as `consent_required` on the next mint, for any purpose; show the turn-on card
  // rather than leaving every call failing.
  const [revoked, setRevoked] = useState(false);
  const tokens = useMemo(
    () => createAssistantTokenProvider({ onConsentRequired: () => setRevoked(true) }),
    []
  );
  // Whether the user has turned the assistant on: the sandbox token mints only against their consent.
  const access = useQuery({
    queryKey: ['app-assistant', 'access'],
    queryFn: () => tokens.getToken({ purpose: 'sandbox' }),
    enabled: !!sandboxUrl,
    retry: false,
    staleTime: Infinity,
  });
  const enable = useMutation({
    mutationFn: () => tokens.enable(),
    onSuccess: () => {
      setRevoked(false);
      void access.refetch();
    },
  });
  const sandboxClient = useMemo(
    () =>
      sandboxUrl && access.isSuccess && !revoked
        ? createSandboxClient({
            baseUrl: sandboxUrl,
            getToken: (opts) => tokens.getToken({ ...opts, purpose: 'sandbox' }),
          })
        : null,
    [sandboxUrl, tokens, access.isSuccess, revoked]
  );
  const sandboxes = useSandboxes(sandboxClient);
  const apps = sandboxes.list.data ?? [];

  const [activeName, setActiveName] = useState<string | null>(null);
  const active = apps.find((s) => s.name === activeName) ?? null;
  const [session, setSession] = useState<PreviewSession | null>(null);
  const [tab, setTab] = useState<'chat' | 'preview'>('chat');
  const shownTab = session ? tab : 'chat';
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const switcherTitleId = useId();
  const chatRef = useRef<CivitaiChat | null>(null);
  // A message sent while the open app was paused: the chat shows it waiting (`queue()`) while the app
  // resumes, and sends it once released. `started` once the app was seen starting.
  type Held = { message: QueuedMessage; app: string; chatId: string | null; started: boolean };
  const [held, setHeld] = useState<Held | null>(null);
  // A held message let go once its app ran: the chat may still be waiting to send it (listing the
  // app's tools, or a reply ending), so it is called back if the user moves to another app, the app
  // stops running or its tools go, or the user leaves the page. (Another chat: the chat itself gives
  // it back.) Calling back one that already went does nothing.
  const released = useRef<QueuedMessage | null>(null);
  const boxText = useCallback(() => messageBoxText(chatRef.current), []);
  const dictating = useCallback(() => isDictating(chatRef.current), []);
  const [chatId, setChatId] = useState<string | null>(null);
  const chatIdRef = useRef(chatId);
  const previewShown = useRef(false);
  const pickedOnLoad = useRef(false);
  // The message the user sent last in this chat: the one a kept-apps refusal answered.
  const lastSent = useRef<string | null>(null);
  type Slot = { message: string | null; deleting: boolean; error: unknown };
  const [slot, setSlot] = useState<Slot | null>(null);
  const slotRef = useRef(slot);
  slotRef.current = slot;
  // The app being started from the paused notice or a menu (its key), and why its last start failed.
  const [startingApp, setStartingApp] = useState<string | null>(null);
  const [startError, setStartError] = useState<{ app: string; error: unknown } | null>(null);
  // The sandbox being exported (its name); one export at a time.
  const [exporting, setExporting] = useState<string | null>(null);
  const exportingRef = useRef(exporting);
  // The open app was seen paused: its notice stays while it starts.
  const [pausedSeen, setPausedSeen] = useState<string | null>(null);

  // FORKABLE APPS — `?fork=<slug>`: the fork's app is created with its files (or, if it exists,
  // opened), and a fresh one gets a new chat once the chat has started. See `AppAssistantFork`.
  const [chatReady, setChatReady] = useState(false);
  const newChatFor = useRef<string | null>(null);
  const fork = useAppFork({
    sandboxes,
    active,
    onOpened: (sandbox, fresh) => {
      if (fresh) newChatFor.current = sandbox.name;
      setActiveName(sandbox.name);
    },
  });
  useEffect(() => {
    if (!chatReady || !newChatFor.current || newChatFor.current !== activeName) return;
    newChatFor.current = null;
    chatRef.current?.newChat();
  }, [chatReady, activeName]);
  const dismissForkSetup = fork.dismissSetup;

  const startDevTunnel = trpc.blocks.startDevTunnel.useMutation();
  const stopDevTunnel = trpc.blocks.stopDevTunnel.useMutation();

  // The chat reads tools and instructions through these on every call, so neither has to be rebuilt.
  const live = useRef({ active, session, canPreview, apps: sandboxes.list.data });
  live.current = { active, session, canPreview, apps: sandboxes.list.data };
  const stopRef = useRef(stopDevTunnel.mutateAsync);
  stopRef.current = stopDevTunnel.mutateAsync;
  const startRef = useRef(startDevTunnel.mutateAsync);
  startRef.current = startDevTunnel.mutateAsync;
  const openRef = useRef(sandboxes.open.mutateAsync);
  openRef.current = sandboxes.open.mutateAsync;

  // On the server runner, a reload (or opening an app) shows no preview until a reply starts one, so
  // the page looks for a live one itself (`probedApp`) and, finding none, offers the runner's Restart
  // preview in the pane (`noLivePreview`); `restart` is that restart's progress for the open app.
  const [noLivePreview, setNoLivePreview] = useState(false);
  const [restart, setRestart] = useState<{ pending: boolean; error: string | null }>(IDLE_RESTART);
  // The app (its key) whose restart is in flight: one at a time per app, so another app's is not held up.
  const restarting = useRef<string | null>(null);
  const probedApp = useRef<string | null>(null);
  // A preview the server runner started has no id here: it is hidden, and civitai lets it idle out.
  const stopPreview = useCallback(() => {
    const current = live.current.session;
    if (!current) return;
    live.current.session = null;
    setSession(null);
    if (current.sessionId) stopRef.current({ sessionId: current.sessionId }).catch(() => undefined);
  }, []);
  /** Shows a preview that (re)started: the first one of an app moves a phone to the Preview tab. */
  const showPreview = useCallback((next: PreviewSession | null) => {
    live.current.session = next;
    setSession(next);
    if (next) setNoLivePreview(false);
    // A reconnect (the tunnel dropped) leaves the user on the tab they chose.
    if (next && !previewShown.current) {
      previewShown.current = true;
      setTab('preview');
    }
  }, []);
  // Each preview the server runner starts gets its own frame, even on the same host.
  const runnerViews = useRef(0);

  const appTools = useMemo(
    () =>
      createAppTools({
        apps: () => live.current.apps,
        current: () => live.current.active,
        open: async (app) => {
          const opened = await openRef.current(app);
          // set_checklist can arrive before the next render, so the beforeToolCall gate reads live.current.
          live.current.active = opened.sandbox;
          setActiveName(opened.sandbox.name);
          return opened;
        },
      }),
    []
  );
  const gate = useMemo(
    () =>
      createAssistantGate({
        refuse: (name) =>
          // Features are planned for an app, so not before one exists.
          name === SET_CHECKLIST && !live.current.active ? NO_APP_REFUSAL : appTools.refusal(name),
        onReply: appTools.newReply,
        onBuild: () => void buildRef.current(),
        currentApp: () => live.current.active?.name ?? null,
        // A chat changes only the app it made or chose: a new chat never builds over the open one.
        openApp: () => live.current.active?.app ?? null,
      }),
    [appTools]
  );
  // What was verified belongs to the sandbox it was verified in, and so does a checklist's Build it.
  useEffect(() => {
    gate.reset();
    gate.appChanged(activeName);
  }, [activeName, gate]);

  // The store cover (`generate_app_cover`) is the page's own tool: the server runner does not offer it.
  const trpcUtils = trpc.useUtils();
  const coverTools = useMemo(
    () =>
      createCoverArt(
        createBrowserCoverArtDeps({
          currentApp: () => {
            const app = live.current.active?.app;
            return app && isAppBlockId(app) ? app : null;
          },
          api: {
            getMyListingForApp: (input) => trpcVanilla.appListings.getMyListingForApp.query(input),
            ingestAssetFromUrl: (input) => trpcVanilla.appListings.ingestAssetFromUrl.mutate(input),
            setCover: (input) => trpcVanilla.appListings.setCover.mutate(input),
          },
          orchestration: chatTokenOrchestration(tokens),
          onAttached: () => void trpcUtils.appListings.getMyListingForApp.invalidate(),
        })
      ),
    [tokens, trpcUtils]
  );

  const tools = useMemo(
    () => ({
      ...createPreviewTools({
        canPreview,
        currentSandbox: () => live.current.active?.name ?? null,
        defaultBlockId: () => {
          const app = live.current.active?.app;
          return app && isAppBlockId(app) ? app : null;
        },
        startDevTunnel: (input) => startRef.current(input),
        stopDevTunnel: (input) => stopRef.current(input),
        getSession: () => live.current.session,
        setSession: showPreview,
      }),
      // A reloaded chat keeps the app it made or chose: its saved calls tell the gate as they show.
      ...gate.restoringChoices(appTools.tools, () => chatIdRef.current),
      ...gate.tools,
      ...(remoteRunner ? {} : coverTools),
    }),
    [canPreview, gate, appTools, showPreview, remoteRunner, coverTools]
  );

  const instructions = useCallback(
    () =>
      buildAssistantInstructions({
        sandbox: live.current.active,
        apps: (live.current.apps ?? []).map((s) => s.app),
        canPreview: live.current.canPreview,
        previewHost: live.current.session?.host ?? null,
        ...(remoteRunner ? { runner: 'remote' as const } : {}),
      }),
    [remoteRunner]
  );

  // The server runner holds the tools and the gate; the page tells it which app is open, and signs
  // each request (a viewer token) and each start (a run grant). Read once, as the chat starts.
  const runnerCredentials = useMemo(() => createRunnerCredentials(), []);
  const runner = useMemo(
    () =>
      appAssistantRemoteRunnerFor(
        remoteRunner,
        () => ({ app: live.current.active?.app ?? null }),
        () => runnerCredentials
      ),
    [remoteRunner, runnerCredentials]
  );
  // On the runner, create_app opens an app the page did not: it follows, once its list has it. And
  // the runner's start_preview says only which block it shows and where (never the tunnel's id):
  // the pane fetches that block's frame, which civitai finds by the user's live tunnel.
  const onToolResult = useCallback(
    (result: ChatToolResult) => {
      gate.onToolResult(result);
      // In the browser and from the runner alike: the card offering to free a slot.
      if (isKeepLimitResult(result))
        setSlot((shown) => shown ?? { message: lastSent.current, deleting: false, error: null });
      if (!remoteRunner || result.isError) return;
      const preview = runnerPreviewAction(result);
      if (preview && 'show' in preview)
        return showPreview({ ...preview.show, sessionId: null, view: ++runnerViews.current });
      if (preview) return stopPreview();
      if (result.name !== CREATE_APP) return;
      const app = (result.output as { app?: unknown } | null)?.app;
      if (typeof app !== 'string') return;
      void refetchRef.current().then(({ data }) => {
        const opened = data?.find((s) => s.app === app);
        if (!opened) return;
        // Being built now: its preview opens with its dev server, so there is none to look for.
        probedApp.current = opened.name;
        setActiveName(opened.name);
      });
    },
    [gate, remoteRunner, showPreview, stopPreview]
  );

  // The token goes only to the configured sandbox service, whatever URL a response names.
  const mcpUrl =
    active?.state === 'running' && sandboxUrl && isSandboxServiceUrl(active.mcpUrl, sandboxUrl)
      ? active.mcpUrl
      : null;
  const mcpServers = useMemo<ChatMcpServer[]>(
    () =>
      mcpUrl
        ? [
            {
              id: SANDBOX_SERVER_ID,
              url: mcpUrl,
              label: 'your app',
              token: () => tokens.getToken({ purpose: 'sandbox' }),
            },
          ]
        : NO_MCP_SERVERS,
    [mcpUrl, tokens]
  );
  // Working in the preview keeps the running app from pausing as idle (previewKeepAlive.ts).
  const [previewPane, setPreviewPane] = useState<HTMLDivElement | null>(null);
  const keepAwake = useMemo(
    () =>
      mcpUrl
        ? () => pingSandbox(mcpUrl, (opts) => tokens.getToken({ ...opts, purpose: 'sandbox' }))
        : null,
    [mcpUrl, tokens]
  );
  usePreviewKeepAlive(previewPane, keepAwake);
  // The pane asks the open app's sandbox whether the preview's tunnel is still up (server runner).
  const tunnelStatus = useMemo(
    () =>
      mcpUrl && remoteRunner
        ? () =>
            fetchSandboxTunnelStatus(mcpUrl, (opts) =>
              tokens.getToken({ ...opts, purpose: 'sandbox' })
            )
        : undefined,
    [mcpUrl, remoteRunner, tokens]
  );

  // A failed reply the chat asks for again (Retry, or by itself as the page wakes) fires no before-send,
  // so a paused app would not be woken and the reply would go on without its tools. The ask is held
  // instead, the app woken, and the reply asked for once its tools are handed to the chat.
  // - `auto`: the chat asked by itself, as the page woke or came back online. The app list did not
  //   refresh while the page slept, so the page first asks for it again (`checking`) and decides on
  //   that: running with its tools, the reply is asked for; paused, the app is woken; else none.
  // - `started` once the app was seen starting; `asking` once it runs with its tools and the ask
  //   waits on the chat.
  type ResumeAsk = {
    app: string;
    chatId: string | null;
    key: string;
    auto: boolean;
    checking: boolean;
    started: boolean;
    asking: boolean;
    stop: AbortController;
  };
  const [resumeAsk, setResumeAsk] = useState<ResumeAsk | null>(null);
  const resumeAskRef = useRef(resumeAsk);
  // Per app and chat, until the user's next message there (a new turn). The chat asks by itself again
  // on every wake until it gets through: once the page gave such an ask up, it keeps the next ones back
  // and does nothing, and it wakes the app by itself once at most, so it never loops. Retry, which the
  // user presses, is always followed.
  const autoGaveUp = useRef(new Set<string>());
  const autoWoke = useRef(new Set<string>());
  const finishResumeAsk = useCallback((asked: boolean) => {
    const ask = resumeAskRef.current;
    ask?.stop.abort();
    if (ask?.auto && !asked) autoGaveUp.current.add(ask.key);
    resumeAskRef.current = null;
    setResumeAsk(null);
  }, []);
  const endResumeAsk = useCallback(() => finishResumeAsk(false), [finishResumeAsk]);
  const refetchRef = useRef(sandboxes.list.refetch);
  refetchRef.current = sandboxes.list.refetch;
  const wakeForAsk = useCallback(
    (app: string) =>
      resumeRef.current(app, {
        // Unless the user moved on meanwhile.
        onSuccess: ({ sandbox }: { sandbox: Sandbox }) => {
          if (resumeAskRef.current?.app === sandbox.app) setActiveName(sandbox.name);
        },
        onError: endResumeAsk,
      }),
    [endResumeAsk]
  );
  /** The chat asked by itself: decide on the app list as it is now, not as it was before the page slept. */
  const checkAutoAsk = useCallback(
    async (ask: ResumeAsk) => {
      // One refresh, bounded; one that fails or runs out gives the ask up.
      let fresh: Sandbox[] | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          refetchRef.current(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('timed out')), APP_LIST_REFRESH_TIMEOUT_MS);
          }),
        ]);
        fresh = result.isError ? undefined : result.data;
      } catch {
        fresh = undefined;
      } finally {
        clearTimeout(timer);
      }
      // Ended meanwhile (or the page went away), or taken over by Retry, which is followed as is.
      const now = resumeAskRef.current;
      if (!now || now.stop !== ask.stop || ask.stop.signal.aborted) return;
      // Retry, pressed by the user, falls back to the list the page has when the refresh failed.
      if (!fresh && !now.auto) fresh = live.current.apps;
      const app = fresh?.find((s) => s.app === ask.app);
      const paused = app?.state === 'suspended';
      // Waking it pauses whichever other app runs: not without the user asking.
      const pausesAnother = fresh?.some((s) => s.app !== ask.app && s.state !== 'suspended');
      if (
        !app ||
        (app.state !== 'running' && !paused && (now.auto || app.state !== 'starting')) ||
        (paused && now.auto && (pausesAnother || autoWoke.current.has(ask.key)))
      )
        return endResumeAsk();
      resumeAskRef.current = { ...now, checking: false };
      setResumeAsk(resumeAskRef.current);
      if (!paused) return;
      if (now.auto) autoWoke.current.add(ask.key);
      wakeForAsk(ask.app);
    },
    [endResumeAsk, wakeForAsk]
  );
  const onReplyResume = useCallback(
    (trigger: ReplyResumeDetail['trigger']) => {
      const app = live.current.active;
      if (!app) return false;
      const auto = trigger !== 'retry';
      const current = resumeAskRef.current;
      if (current) {
        // Retry pressed while the page refreshes the list for the chat's own ask: it is the user's.
        if (!auto && current.auto) {
          resumeAskRef.current = { ...current, auto: false };
          setResumeAsk(resumeAskRef.current);
        }
        return true;
      }
      // Retry: the user pressed it now, so the list is current.
      if (!auto && app.state !== 'suspended' && app.state !== 'starting') return false;
      const key = `${app.app}\n${chatIdRef.current}`;
      if (auto && autoGaveUp.current.has(key)) return true;
      const ask: ResumeAsk = {
        app: app.app,
        chatId: chatIdRef.current,
        key,
        auto,
        checking: auto,
        started: app.state === 'starting',
        asking: false,
        stop: new AbortController(),
      };
      resumeAskRef.current = ask;
      setResumeAsk(ask);
      if (auto) void checkAutoAsk(ask);
      else if (app.state === 'suspended') wakeForAsk(app.app);
      return true;
    },
    [checkAutoAsk, wakeForAsk]
  );
  useEffect(() => {
    if (!resumeAsk) return;
    // The app was closed, another opened, or another chat opened meanwhile.
    if (!active || active.app !== resumeAsk.app || chatId !== resumeAsk.chatId)
      return endResumeAsk();
    if (resumeAsk.checking) return;
    if (resumeAsk.asking) {
      if (active.state !== 'running' || !mcpServers.length) endResumeAsk();
      return;
    }
    // Paused again once it had started.
    if (active.state === 'suspended') {
      if (resumeAsk.started) endResumeAsk();
      return;
    }
    if (active.state === 'starting') {
      if (!resumeAsk.started) {
        resumeAskRef.current = { ...resumeAsk, started: true };
        setResumeAsk(resumeAskRef.current);
      }
      return;
    }
    // Running, but its tools are not handed to the chat: asking would go on without them.
    if (!mcpServers.length) return endResumeAsk();
    const asking: ResumeAsk = { ...resumeAsk, asking: true };
    resumeAskRef.current = asking;
    setResumeAsk(asking);
    void retryWhenReady(chatRef, asking.stop.signal).then((asked) => {
      if (resumeAskRef.current === asking) finishResumeAsk(asked);
    });
  }, [resumeAsk, active, chatId, mcpServers, endResumeAsk, finishResumeAsk]);
  // The app has RESUME_ASK_TIMEOUT_MS to run, and the chat as long again to take the ask once it does.
  const resuming = !!resumeAsk;
  const waitingOnChat = !!resumeAsk?.asking;
  useEffect(() => {
    if (!resuming) return;
    const timer = setTimeout(endResumeAsk, RESUME_ASK_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [resuming, waitingOnChat, endResumeAsk]);
  useEffect(() => () => resumeAskRef.current?.stop.abort(), []);

  // A preview belongs to the sandbox it was started from; tear it down when that changes or the
  // page goes away. The tunnel also expires on its own.
  useEffect(() => {
    previewShown.current = false;
    return stopPreview;
  }, [activeName, stopPreview]);
  // `session` too: a preview start already in flight can land after the suspend or revoke.
  useEffect(() => {
    if (session && (active?.state === 'suspended' || revoked)) stopPreview();
  }, [session, active?.state, revoked, stopPreview]);
  useEffect(() => {
    if (activeName && sandboxes.list.isSuccess && !active) setActiveName(null);
  }, [activeName, active, sandboxes.list.isSuccess]);
  // The Restart preview offer and its progress belong to the open app; a paused app has no preview.
  useEffect(() => {
    setNoLivePreview(false);
    setRestart(IDLE_RESTART);
  }, [activeName]);
  useEffect(() => {
    if (active?.state === 'suspended' || revoked) setNoLivePreview(false);
  }, [active?.state, revoked]);
  // On the server runner, once per app opened (on a visit, or from the switcher) and seen running: a
  // live preview of it is shown at once; none (or no answer) offers Restart preview. civitai lists a
  // tunnel until its idle window ends even when its sandbox side is gone, so a listed one can still
  // fail to load: the pane then offers Restart preview too (`AppAssistantPreview`).
  const runningApp = remoteRunner && canPreview && active?.state === 'running' ? active : null;
  useEffect(() => {
    if (!runningApp || probedApp.current === runningApp.name) return;
    probedApp.current = runningApp.name;
    if (live.current.session) return;
    const { name, app } = runningApp;
    const blockId = isAppBlockId(app) ? app : null;
    void (async () => {
      let frame: Awaited<ReturnType<typeof fetchPreviewFrame>> | null = null;
      try {
        frame = blockId ? await fetchPreviewFrame(blockId) : null;
      } catch {
        frame = null;
      }
      // Unless the user moved on, or a reply showed one meanwhile.
      if (live.current.active?.name !== name || live.current.session) return;
      if (frame && blockId)
        return showPreview({
          blockId,
          host: 'host' in frame ? frame.host ?? '' : '',
          sessionId: null,
          view: ++runnerViews.current,
        });
      setNoLivePreview(true);
    })();
  }, [runningApp, showPreview]);
  /** The pane's Restart preview: the runner opens the open app's preview again, with no reply. */
  const restartPreview = useCallback(async () => {
    const app = live.current.active;
    // One restart at a time: a second click joins nothing and sends nothing.
    if (!app || restarting.current === app.app) return;
    restarting.current = app.app;
    setRestart({ pending: true, error: null });
    try {
      // A paused app is started first, by the page's own start; the runner waits for it to run.
      if (app.state === 'suspended') await openRef.current(app.app);
      const shown = await restartRunnerPreview(app.app, { credentials: runnerCredentials });
      if (live.current.active?.app !== app.app) return;
      setRestart(IDLE_RESTART);
      showPreview({ ...shown, sessionId: null, view: ++runnerViews.current });
    } catch (error) {
      if (live.current.active?.app === app.app)
        setRestart({
          pending: false,
          error: error instanceof Error && error.message ? error.message : RESTART_PREVIEW_FAILED,
        });
    } finally {
      if (restarting.current === app.app) restarting.current = null;
    }
  }, [runnerCredentials, showPreview]);
  const previewRestart = useMemo(
    () =>
      remoteRunner && canPreview
        ? { onRestart: () => void restartPreview(), pending: restart.pending, error: restart.error }
        : undefined,
    [remoteRunner, canPreview, restartPreview, restart]
  );
  // Beside the chat on a wide screen; a phone's Chat/Preview switch still waits for a preview.
  const paneShown = !!session || (!!previewRestart && noLivePreview);
  // A visit opens the app worked on last, once, without starting it: starting pauses the running one.
  // Not on a visit for a fork: the fork opens its own app, and this effect, running in the same
  // commit with the pre-fork `activeName`, would otherwise open the recent app over it.
  const forkClaimsActiveApp = fork.claimsActiveApp;
  useEffect(() => {
    if (pickedOnLoad.current || !sandboxes.list.data) return;
    pickedOnLoad.current = true;
    if (activeName || forkClaimsActiveApp) return;
    const recent = mostRecentApp(sandboxes.list.data);
    if (recent) setActiveName(recent.name);
  }, [sandboxes.list.data, activeName, forkClaimsActiveApp]);

  const resumeRef = useRef(sandboxes.open.mutate);
  resumeRef.current = sandboxes.open.mutate;
  const heldRef = useRef(held);
  heldRef.current = held;
  // Build it: a send the chat could not take now (a reply still ending, or a hold) comes back to the
  // user to send instead, so it is never pressed twice. The chat puts it in an empty box, or offers it
  // back beside what the user has there.
  const buildWent = useRef(false);
  const buildRef = useRef(async () => {
    buildWent.current = false;
    const chat = chatRef.current;
    if (!chat) return;
    await sendNotJoined(chat, BUILD_IT_MESSAGE, boxText, dictating, () => buildWent.current);
    if (buildWent.current) return;
    chat.giveBack(BUILD_IT_MESSAGE);
    gate.answered();
  });
  // The held message comes back to the user (the chat puts it back in the box, or offers it back).
  const giveBackHeld = useCallback(() => {
    const message = heldRef.current;
    heldRef.current = null;
    setHeld(null);
    message?.message.cancel();
  }, []);
  const onBeforeSend = useCallback(
    (text: string, queue: BeforeSendDetail['queue']) => {
      gate.answered();
      if (text === BUILD_IT_MESSAGE) buildWent.current = true;
      const app = live.current.active;
      if (app?.state !== 'suspended') return;
      // The chat shows the message at once, waiting, and holds while the app resumes (so no other
      // message reaches here meanwhile; one whose wait the chat ended by itself is simply replaced).
      heldRef.current = {
        message: queue(APP_STARTING_HOLD),
        app: app.app,
        chatId: chatIdRef.current,
        started: false,
      };
      setHeld(heldRef.current);
      resumeRef.current(app.app, {
        // Unless the user moved on meanwhile.
        onSuccess: ({ sandbox }: { sandbox: Sandbox }) => {
          if (heldRef.current?.app === sandbox.app) setActiveName(sandbox.name);
        },
        onError: giveBackHeld,
      });
    },
    [gate, giveBackHeld]
  );
  // A released message belongs to the app it was written for, and to this page.
  useEffect(() => {
    released.current?.cancel();
    released.current = null;
  }, [activeName]);
  useEffect(
    () => () => {
      released.current?.cancel();
      heldRef.current?.message.cancel();
    },
    []
  );
  useEffect(() => {
    if (!held) return;
    // The app was closed, another opened, or another chat opened meanwhile.
    if (!active || active.app !== held.app || chatId !== held.chatId) return giveBackHeld();
    // Paused again once it had started (paused by hand, or from another tab).
    if (active.state === 'suspended') {
      if (held.started) giveBackHeld();
      return;
    }
    if (active.state === 'starting') {
      if (!held.started) {
        heldRef.current = { ...held, started: true };
        setHeld(heldRef.current);
      }
      return;
    }
    // Running, but its tools are not handed to the chat (an address outside the sandbox service).
    if (!mcpServers.length) return giveBackHeld();
    // Running with its tools handed over: the chat sends it once it can (after listing them).
    heldRef.current = null;
    setHeld(null);
    released.current = held.message;
    held.message.release();
  }, [held, active, chatId, mcpServers, giveBackHeld]);
  // Paused (or its tools gone) after the release but before the chat sent it: it would go without the
  // app's tools, and nothing would wake the app. It comes back to the user instead.
  const runningWithTools = active?.state === 'running' && mcpServers.length > 0;
  // Set up: one fixed message, as the user's, once (the card goes as it is pressed).
  const forkSetUp = () => {
    const chat = chatRef.current;
    if (!chat) return;
    dismissForkSetup();
    void chat.send(FORK_SETUP_MESSAGE);
  };
  useEffect(() => {
    if (runningWithTools || !released.current) return;
    released.current.cancel();
    released.current = null;
  }, [runningWithTools]);
  // The chat gives a held message back by itself after QUEUE_TIMEOUT_MS (or on its Edit) and says
  // nothing, so the page's record of it ends then too: the app's status stops reading "starting" if
  // the resume never got it going. Cancelling one the chat already gave back does nothing.
  const holding = !!held;
  useEffect(() => {
    if (!holding) return;
    const timer = setTimeout(giveBackHeld, HELD_RECORD_MS);
    return () => clearTimeout(timer);
  }, [holding, giveBackHeld]);

  const onChatChange = useCallback(
    (id: string | null) => {
      gate.answered();
      chatIdRef.current = id;
      setChatId(id);
    },
    [gate]
  );

  // A failed reply waiting on its app is not asked for after a message of the user's, nor in another
  // chat: at once, as the chat can say it can send before the next render.
  const onSend = useCallback(
    (text: string, queue: BeforeSendDetail['queue']) => {
      // Before the message may be kept back: a resume ask and a waiting message never both act.
      endResumeAsk();
      lastSent.current = text;
      // A message the user sends takes the free-a-slot card away (its own re-send goes after it went).
      setSlot(null);
      // A message of the user's (or Set up itself) answers the fork's Set up card.
      dismissForkSetup();
      // A new turn: the chat's own asks for a reply after it start afresh.
      const chat = `\n${chatIdRef.current}`;
      for (const keys of [autoGaveUp.current, autoWoke.current])
        keys.forEach((key) => key.endsWith(chat) && keys.delete(key));
      onBeforeSend(text, queue);
    },
    [endResumeAsk, onBeforeSend, dismissForkSetup]
  );
  const onChatReady = useCallback(() => setChatReady(true), []);
  const onChatOpened = useCallback(
    (id: string | null) => {
      if (id !== chatIdRef.current) {
        endResumeAsk();
        setSlot(null);
        // The card re-sends a message of the chat it was sent in, never of another.
        lastSent.current = null;
      }
      onChatChange(id);
    },
    [endResumeAsk, onChatChange]
  );

  const starting =
    !!held ||
    (sandboxes.open.isPending && sandboxes.open.variables === active?.app) ||
    (!!active && startingApp === active.app);
  const status = active && (starting ? APP_STATUS.starting : APP_STATUS[active.state]);
  /**
   * Starts a paused app (the paused notice, the app menu's Start, a switcher pick, an export): finds,
   * creates or resumes it, pausing the one that runs. The one start a user asks for by hand.
   */
  const startApp = useCallback(async (target: Sandbox) => {
    setStartingApp(target.app);
    setStartError(null);
    try {
      const result = await openRef.current(target.app);
      const opened = result.sandbox;
      // Unless the user moved on meanwhile; a deleted app comes back under a new name.
      if (live.current.active?.app === opened.app) setActiveName(opened.name);
      return result;
    } catch (error) {
      setStartError({ app: target.app, error });
      throw error;
    } finally {
      setStartingApp((current) => (current === target.app ? null : current));
    }
  }, []);
  const startByHand = useCallback(
    (target: Sandbox) => void startApp(target).catch(() => undefined),
    [startApp]
  );
  // Picking a paused app starts it, which pauses the one that runs.
  const selectApp = (sandbox: Sandbox) => {
    setActiveName(sandbox.name);
    setSwitcherOpen(false);
    if (sandbox.state === 'suspended') startByHand(sandbox);
  };
  const exportApp = useCallback(
    async (target: Sandbox) => {
      if (!sandboxClient || exportingRef.current) return;
      exportingRef.current = target.name;
      setExporting(target.name);
      try {
        const blob = await exportAppZip({
          client: sandboxClient,
          sandbox: target,
          start: startApp,
          discard: (name) => removeRef.current(name).then(() => onRemovedRef.current(name)),
        });
        const filename = exportFileName(target.app);
        saveBlob(blob, filename);
        showSuccessNotification({
          title: `Downloaded ${filename}`,
          message: EXPORT_NOTE,
          autoClose: 8000,
        });
      } catch (error) {
        showErrorNotification({
          error: new Error(error instanceof AppExportError ? error.message : EXPORT_FAILED),
        });
      } finally {
        exportingRef.current = null;
        setExporting(null);
      }
    },
    [sandboxClient, startApp]
  );
  const onRemoved = (name: string) => {
    appTools.forget(name);
    if (name === activeName) setActiveName(null);
  };
  const removeRef = useRef(sandboxes.remove.mutateAsync);
  removeRef.current = sandboxes.remove.mutateAsync;
  const onRemovedRef = useRef(onRemoved);
  onRemovedRef.current = onRemoved;
  /** The free-a-slot card's delete, once confirmed: then the message that hit the limit goes again. */
  const freeSlot = (target: Sandbox) =>
    confirmDeleteApp(target.app, async () => {
      setSlot((shown) => shown && { ...shown, deleting: true, error: null });
      try {
        await sandboxes.remove.mutateAsync(target.name);
      } catch (error) {
        setSlot((shown) => shown && { ...shown, deleting: false, error });
        return;
      }
      onRemoved(target.name);
      // Unless the card went meanwhile (the user sent something else).
      const message = slotRef.current?.message ?? null;
      const chat = chatRef.current;
      setSlot(null);
      if (!message || !chat) return;
      // Sent as the user's, once; a chat that cannot send now gives it back to them instead.
      if (chat.canSend) await chat.send(message);
      else chat.giveBack(message);
    });
  // A failed start is told on its app's notice, until another app is opened.
  useEffect(() => setStartError(null), [activeName]);
  // The paused notice stays with an app it showed paused while that app starts.
  useEffect(() => {
    if (active?.state === 'suspended') setPausedSeen(active.name);
    else if (active?.state !== 'starting') setPausedSeen(null);
  }, [active?.name, active?.state]);
  // The open app is starting (by any path): the page asks for its apps itself until it runs, a
  // stop at APP_START_TIMEOUT_MS saying so. Check again asks afresh.
  const waitingToRun = !!sandboxClient && !!active && (active.state === 'starting' || starting);
  const [startSlow, setStartSlow] = useState<string | null>(null);
  const [checks, setChecks] = useState(0);
  useEffect(() => {
    if (!waitingToRun || !active) {
      setStartSlow(null);
      return;
    }
    const name = active.name;
    // Never cancelling a list request already on its way.
    const poll = setInterval(
      () => void refetchRef.current({ cancelRefetch: false }),
      APP_START_POLL_MS
    );
    const timeout = setTimeout(() => {
      clearInterval(poll);
      setStartSlow(name);
    }, APP_START_TIMEOUT_MS);
    return () => {
      clearInterval(poll);
      clearTimeout(timeout);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- restarts per app and per Check again
  }, [waitingToRun, active?.name, checks]);
  const checkAgain = () => {
    setStartSlow(null);
    setChecks((n) => n + 1);
    void refetchRef.current();
  };
  const slow = !!active && waitingToRun && startSlow === active.name;
  const showNotice =
    slow ||
    (!!active &&
      (active.state === 'suspended' ||
        (active.state === 'starting' && pausedSeen === active.name)));
  const noticeError = active && startError?.app === active.app ? startError.error : null;
  // An error the notice or the card already shows is not shown twice, and while the card offers to
  // free a slot the kept-apps refusal is not also told above.
  const pageError = appsError(sandboxes);
  const shownBelow =
    !!pageError &&
    (pageError === noticeError ||
      pageError === slot?.error ||
      (!!slot &&
        pageError instanceof SandboxApiError &&
        pageError.kind === 'limit' &&
        !isRunningLimit(pageError)));
  const startNewApp = () => {
    setActiveName(null);
    chatRef.current?.newChat();
    setSwitcherOpen(false);
  };

  const fillRef = useFillScrollParent<HTMLDivElement>();

  if (!sandboxUrl)
    return (
      <Alert color="yellow" variant="light">
        App Assistant can’t build apps on this deployment yet.
      </Alert>
    );
  if (access.isPending)
    return (
      <Center className="py-10">
        <Loader size="sm" />
      </Center>
    );
  if (
    revoked ||
    (access.error instanceof AssistantTokenError && access.error.code === 'consent_required')
  )
    return (
      <EnableCard
        onEnable={() => enable.mutate()}
        pending={enable.isPending}
        error={enable.error}
      />
    );
  if (access.error)
    return (
      <Alert color="red" variant="light">
        <Group justify="space-between" wrap="nowrap" gap="sm">
          <Text size="sm">
            {access.error instanceof Error ? access.error.message : 'App Assistant is unavailable.'}
          </Text>
          <Button
            size="compact-sm"
            variant="light"
            color="red"
            className="min-h-11"
            loading={access.isFetching}
            onClick={() => void access.refetch()}
          >
            Retry
          </Button>
        </Group>
      </Alert>
    );

  return (
    <div ref={fillRef} className={clsx('flex flex-col gap-3', classes.workspace)}>
      {(active || apps.length > 0) && (
        <Popover
          opened={switcherOpen}
          onChange={setSwitcherOpen}
          position="bottom-start"
          width="min(360px, calc(100vw - 32px))"
          trapFocus
          returnFocus
          shadow="md"
        >
          <Popover.Target>
            <UnstyledButton
              className="flex min-h-11 min-w-0 max-w-full shrink-0 items-center gap-2 self-start rounded-md px-2"
              aria-label={`Switch app: ${active ? `${active.app}, ${status}` : 'no app open'}`}
              onClick={() => setSwitcherOpen((open) => !open)}
            >
              <div className="min-w-0">
                <Text fw={600} truncate>
                  {active ? active.app : 'No app open'}
                </Text>
                <Text size="xs" c="dimmed" truncate>
                  {active ? status : 'Open one of yours, or describe a new one'}
                </Text>
              </div>
              <IconSelector size={16} className="shrink-0" />
            </UnstyledButton>
          </Popover.Target>
          <Popover.Dropdown aria-labelledby={switcherTitleId}>
            <Text id={switcherTitleId} size="xs" fw={600} c="dimmed" tt="uppercase" mb="xs">
              Apps
            </Text>
            <YourAppsList
              sandboxes={sandboxes}
              activeName={activeName}
              onOpen={selectApp}
              onRemoved={onRemoved}
              onNewApp={startNewApp}
              onStart={startByHand}
              onExport={(sandbox) => void exportApp(sandbox)}
              starting={startingApp}
              exporting={exporting}
            />
          </Popover.Dropdown>
        </Popover>
      )}
      {!switcherOpen && !shownBelow && <AppError error={pageError} />}
      <ForkStatus
        creating={fork.creating}
        problem={fork.problem}
        retry={fork.retry}
        retrying={fork.retrying}
      />
      {fork.setup && active?.app === fork.setup.app && (
        <ForkSetupCard
          parentName={fork.setup.parentName}
          ready={runningWithTools}
          onSetUp={forkSetUp}
        />
      )}
      {session && (
        <SegmentedControl
          className="shrink-0 md:hidden"
          fullWidth
          size="md"
          classNames={{ label: 'min-h-11 flex items-center justify-center' }}
          value={shownTab}
          onChange={(value) => setTab(value as 'chat' | 'preview')}
          data={[
            { value: 'chat', label: 'Chat' },
            { value: 'preview', label: 'Preview' },
          ]}
        />
      )}

      <div className="flex min-h-0 flex-1 gap-3">
        <Paper
          withBorder
          radius="md"
          data-testid="app-assistant-chat-pane"
          className={clsx(
            'min-h-0 flex-col overflow-hidden',
            paneShown ? 'md:flex md:w-5/12 md:shrink-0' : 'w-full',
            shownTab === 'chat' ? 'flex w-full' : 'hidden'
          )}
        >
          <AppAssistantChat
            tokens={tokens}
            tools={tools}
            instructions={instructions}
            mcpServers={mcpServers}
            holdReason={active?.state === 'starting' ? APP_STARTING_HOLD : undefined}
            beforeToolCall={gate.beforeToolCall}
            onToolResult={onToolResult}
            chatRef={chatRef}
            onBeforeSend={onSend}
            onReplyResume={onReplyResume}
            onChatChange={onChatOpened}
            subagents={subagents ? APP_ASSISTANT_SUBAGENTS : undefined}
            remoteRunner={runner}
            composerTop={
              showNotice && active ? (
                <PausedAppNotice
                  app={active.app}
                  starting={starting || active.state === 'starting'}
                  canStart={
                    active.state === 'suspended' && (!starting || startingApp === active.app)
                  }
                  pending={startingApp === active.app}
                  pauses={runningOtherApp(apps, active)?.app ?? null}
                  error={noticeError}
                  slow={slow}
                  onCheckAgain={checkAgain}
                  onStart={() => startByHand(active)}
                />
              ) : null
            }
            threadEnd={
              slot ? (
                <FreeUpSlotCard
                  apps={apps}
                  openName={activeName}
                  deleting={slot.deleting}
                  error={slot.error}
                  exporting={exporting}
                  onExport={(sandbox) => void exportApp(sandbox)}
                  onDelete={freeSlot}
                />
              ) : null
            }
            onReady={onChatReady}
          />
        </Paper>
        {paneShown && (
          <Paper
            withBorder
            radius="md"
            ref={setPreviewPane}
            data-testid="app-assistant-preview-pane"
            className={clsx(
              'min-h-0 flex-1 flex-col overflow-hidden md:flex',
              shownTab === 'preview' ? 'flex' : 'hidden'
            )}
          >
            <AppAssistantPreview
              canPreview={canPreview}
              session={session}
              restart={previewRestart}
              tunnelStatus={tunnelStatus}
            />
          </Paper>
        )}
      </div>
    </div>
  );
}
