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
import type { ChatMcpServer, CivitaiChat } from '@civitai/components-chat/civitai-chat';
import { AppAssistantChat } from '~/components/Apps/AppAssistant/AppAssistantChat';
import { AppAssistantPreview } from '~/components/Apps/AppAssistant/AppAssistantPreview';
import { isAppBlockId } from '~/components/Apps/AppAssistant/appKey';
import { NO_APP_REFUSAL, createAppTools } from '~/components/Apps/AppAssistant/appTools';
import {
  BUILD_IT_MESSAGE,
  SANDBOX_SERVER_ID,
  SET_CHECKLIST,
  createAssistantGate,
} from '~/components/Apps/AppAssistant/assistantGate';
import { buildAssistantInstructions } from '~/components/Apps/AppAssistant/assistantInstructions';
import {
  AssistantTokenError,
  createAssistantTokenProvider,
} from '~/components/Apps/AppAssistant/assistantToken';
import { createChatAppStore } from '~/components/Apps/AppAssistant/chatAdapter';
import type { PreviewSession } from '~/components/Apps/AppAssistant/previewTools';
import { createPreviewTools } from '~/components/Apps/AppAssistant/previewTools';
import type { Sandbox } from '~/components/Apps/AppAssistant/sandboxClient';
import {
  createSandboxClient,
  isSandboxServiceUrl,
} from '~/components/Apps/AppAssistant/sandboxClient';
import { useSandboxes } from '~/components/Apps/AppAssistant/useSandboxes';
import {
  APP_STATUS,
  AppError,
  appsError,
  YourAppsList,
} from '~/components/Apps/AppAssistant/YourApps';
import { APP_ASSISTANT_DAILY_BUZZ_CAP } from '~/shared/constants/app-assistant.constants';
import { sleep } from '~/utils/errorHandling';
import { numberWithCommas } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';
import classes from './AppAssistant.module.scss';

const NO_MCP_SERVERS: ChatMcpServer[] = [];
/** The app's tools are added only once it runs, so a message sent before then would go without them. */
export const APP_STARTING_HOLD = 'Your app is starting…';

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

const RELEASE_TRIES = 40;
const RELEASE_INTERVAL_MS = 500;

/** A message the page is sending as the user's; `went` once the chat let it through. */
export interface Release {
  text: string;
  went: boolean;
}

/**
 * Sends `text` as the user's. The chat holds silently while it lists a just-added app's tools, and a
 * send while it holds would only fill an empty message box, so the text waits in the box and is sent
 * again until it goes; then the box is cleared. Stopped (another message went, or the user moved on)
 * or never let through, it stays in the box for the user.
 */
export async function releaseHeld(
  chatRef: { current: Pick<CivitaiChat, 'send' | 'compose'> | null },
  replaying: { current: Release | null },
  text: string,
  interval = RELEASE_INTERVAL_MS
) {
  const release: Release = { text, went: false };
  replaying.current = release;
  const live = () => replaying.current === release && !release.went;
  await chatRef.current?.compose(text);
  for (let i = 0; i < RELEASE_TRIES && live(); i++) {
    await chatRef.current?.send(text);
    if (live()) await sleep(interval);
  }
  if (replaying.current === release) replaying.current = null;
  if (release.went) await chatRef.current?.compose('');
}

export function AppAssistantWorkspace({
  canPreview,
  sandboxUrl,
  userId = null,
}: {
  canPreview: boolean;
  /** The hosted sandbox service's base URL, from the server; null when not configured. */
  sandboxUrl: string | null;
  /** Keeps what each chat worked on apart per account in this browser. */
  userId?: number | null;
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
  // A message sent while the open app was paused, held until the app runs again.
  const [held, setHeld] = useState<{ text: string; app: string; chatId: string | null } | null>(
    null
  );
  const replaying = useRef<Release | null>(null);
  const chatApps = useMemo(() => createChatAppStore(String(userId ?? 'anon')), [userId]);
  const [chatId, setChatId] = useState<string | null>(null);
  // Read by the tools, which are built once.
  const chatRemembers = useRef({ chatApps, chatId });
  chatRemembers.current = { chatApps, chatId };
  /** This chat now works on `name`, so reopening it reopens that app. */
  const remember = useCallback((name: string) => {
    const { chatApps, chatId } = chatRemembers.current;
    if (chatId) chatApps.set(chatId, name);
  }, []);
  const previewShown = useRef(false);

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

  const stopPreview = useCallback(() => {
    const current = live.current.session;
    if (!current) return;
    setSession(null);
    stopRef.current({ sessionId: current.sessionId }).catch(() => undefined);
  }, []);

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
          remember(opened.sandbox.name);
          return opened;
        },
      }),
    [remember]
  );
  const gate = useMemo(
    () =>
      createAssistantGate({
        refuse: (name) =>
          // Features are planned for an app, so not before one exists.
          name === SET_CHECKLIST && !live.current.active ? NO_APP_REFUSAL : appTools.refusal(name),
        onReply: appTools.newReply,
        onBuild: () => void chatRef.current?.send(BUILD_IT_MESSAGE),
      }),
    [appTools]
  );
  // What was verified belongs to the sandbox it was verified in.
  useEffect(() => gate.reset(), [activeName, gate]);

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
        setSession: (next) => {
          live.current.session = next;
          setSession(next);
          // A reconnect (the tunnel dropped) leaves the user on the tab they chose.
          if (next && !previewShown.current) {
            previewShown.current = true;
            setTab('preview');
          }
        },
      }),
      ...appTools.tools,
      ...gate.tools,
    }),
    [canPreview, gate, appTools]
  );

  const instructions = useCallback(
    () =>
      buildAssistantInstructions({
        sandbox: live.current.active,
        apps: (live.current.apps ?? []).map((s) => s.app),
        canPreview: live.current.canPreview,
        previewHost: live.current.session?.host ?? null,
      }),
    []
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

  const resumeRef = useRef(sandboxes.open.mutate);
  resumeRef.current = sandboxes.open.mutate;
  const heldRef = useRef(held);
  heldRef.current = held;
  const giveBack = useCallback(() => {
    const message = heldRef.current;
    heldRef.current = null;
    setHeld(null);
    if (message) void chatRef.current?.compose(message.text);
  }, []);
  const onBeforeSend = useCallback(
    (text: string) => {
      gate.answered();
      const release = replaying.current;
      if (release?.text === text) release.went = true;
      // The user sent something else: stop sending the page's message.
      else if (release) replaying.current = null;
      const app = live.current.active;
      if (app) remember(app.name);
      if (app?.state !== 'suspended') return false;
      const resuming = heldRef.current !== null;
      // A follow-up while it resumes goes with the first, which has already left the message box.
      const before = heldRef.current?.text;
      heldRef.current = {
        text: before ? `${before}\n\n${text}` : text,
        app: app.app,
        chatId: chatRemembers.current.chatId,
      };
      setHeld(heldRef.current);
      if (!resuming)
        resumeRef.current(app.app, {
          // Unless the user moved on meanwhile.
          onSuccess: ({ sandbox }: { sandbox: Sandbox }) => {
            if (heldRef.current?.app === sandbox.app) setActiveName(sandbox.name);
          },
          onError: giveBack,
        });
      return true;
    },
    [gate, giveBack, remember]
  );
  // A message on its way out belongs to the chat and app it was written in.
  useEffect(() => {
    replaying.current = null;
  }, [activeName, chatId]);
  useEffect(() => {
    if (!held) return;
    // The app was closed, another opened, or another chat opened meanwhile.
    if (!active || active.app !== held.app || chatId !== held.chatId) return giveBack();
    if (active.state !== 'running') return;
    // Running, but its tools are not handed to the chat (an address outside the sandbox service).
    if (!mcpServers.length) return giveBack();
    heldRef.current = null;
    setHeld(null);
    void releaseHeld(chatRef, replaying, held.text);
  }, [held, active, chatId, mcpServers, giveBack]);

  const onChatChange = useCallback(
    (id: string | null) => {
      gate.answered();
      chatRemembers.current.chatId = id;
      setChatId(id);
      const app = id ? chatApps.get(id) : null;
      if (app) setActiveName(app);
    },
    [chatApps, gate]
  );

  const status = active && (held ? APP_STATUS.starting : APP_STATUS[active.state]);
  // Not resumed here: resuming pauses the running app, so it waits for a message that needs this one.
  const selectApp = (sandbox: Sandbox) => {
    setActiveName(sandbox.name);
    setSwitcherOpen(false);
  };
  const onRemoved = (name: string) => {
    appTools.forget(name);
    if (name === activeName) setActiveName(null);
  };
  const startNewApp = () => {
    setActiveName(null);
    chatRef.current?.newChat();
    setSwitcherOpen(false);
  };

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
    <div className={clsx('flex flex-col gap-3', classes.workspace)}>
      {(active || apps.length > 0) && (
        <Popover
          opened={switcherOpen}
          onChange={setSwitcherOpen}
          position="bottom-start"
          width={360}
          trapFocus
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
            />
          </Popover.Dropdown>
        </Popover>
      )}
      {!switcherOpen && <AppError error={appsError(sandboxes)} />}

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
            session ? 'md:flex md:w-5/12 md:shrink-0' : 'w-full',
            shownTab === 'chat' ? 'flex w-full' : 'hidden'
          )}
        >
          <AppAssistantChat
            tokens={tokens}
            tools={tools}
            instructions={instructions}
            mcpServers={mcpServers}
            holdReason={active?.state === 'starting' || held ? APP_STARTING_HOLD : undefined}
            beforeToolCall={gate.beforeToolCall}
            onToolResult={gate.onToolResult}
            chatRef={chatRef}
            onBeforeSend={onBeforeSend}
            onChatChange={onChatChange}
          />
        </Paper>
        {session && (
          <Paper
            withBorder
            radius="md"
            data-testid="app-assistant-preview-pane"
            className={clsx(
              'min-h-0 flex-1 flex-col overflow-hidden md:flex',
              shownTab === 'preview' ? 'flex' : 'hidden'
            )}
          >
            <AppAssistantPreview canPreview={canPreview} session={session} />
          </Paper>
        )}
      </div>
    </div>
  );
}
