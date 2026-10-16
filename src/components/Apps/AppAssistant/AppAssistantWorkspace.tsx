import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Center,
  Drawer,
  Group,
  Loader,
  Paper,
  SegmentedControl,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { useMutation, useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import type {
  ChatMcpServer,
  ChatToolGate,
  CivitaiChat,
} from '@civitai/components-chat/civitai-chat';
import { AppAssistantChat } from '~/components/Apps/AppAssistant/AppAssistantChat';
import { AppAssistantPreview } from '~/components/Apps/AppAssistant/AppAssistantPreview';
import { isAppBlockId } from '~/components/Apps/AppAssistant/appKey';
import { NO_APP_REFUSAL, createAppTools } from '~/components/Apps/AppAssistant/appTools';
import {
  SANDBOX_SERVER_ID,
  SET_CHECKLIST,
  createAssistantGate,
} from '~/components/Apps/AppAssistant/assistantGate';
import { buildAssistantInstructions } from '~/components/Apps/AppAssistant/assistantInstructions';
import {
  AssistantTokenError,
  createAssistantTokenProvider,
} from '~/components/Apps/AppAssistant/assistantToken';
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
  AppMenu,
  YourAppsList,
} from '~/components/Apps/AppAssistant/YourApps';
import { APP_ASSISTANT_DAILY_BUZZ_CAP } from '~/shared/constants/app-assistant.constants';
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

export function AppAssistantWorkspace({
  canPreview,
  sandboxUrl,
}: {
  canPreview: boolean;
  /** The hosted sandbox service's base URL, from the server; null when not configured. */
  sandboxUrl: string | null;
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
  const shownTab = active ? tab : 'chat';
  const [drawerOpen, setDrawerOpen] = useState(false);
  const chatRef = useRef<CivitaiChat | null>(null);

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

  const gate = useMemo(() => createAssistantGate(), []);
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
          if (next) setTab('preview');
        },
      }),
      ...createAppTools({
        apps: () => live.current.apps,
        open: async (app) => {
          const { sandbox } = await openRef.current(app);
          // The assistant's next call (set_checklist) can come before the next render.
          live.current.active = sandbox;
          setActiveName(sandbox.name);
          return sandbox;
        },
      }),
      ...gate.tools,
    }),
    [canPreview, gate]
  );

  // The features are built in an app, so they are not planned before one exists.
  const beforeToolCall = useCallback<ChatToolGate>(
    (name, input, context) =>
      name === SET_CHECKLIST && !live.current.active
        ? { refuse: NO_APP_REFUSAL }
        : gate.beforeToolCall(name, input, context),
    [gate]
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
              // The chat names it in "Connecting to …" and when it cannot be reached.
              label: 'your app',
              token: () => tokens.getToken({ purpose: 'sandbox' }),
            },
          ]
        : NO_MCP_SERVERS,
    [mcpUrl, tokens]
  );

  // A preview belongs to the sandbox it was started from; tear it down when that changes or the
  // page goes away. The tunnel also expires on its own.
  useEffect(() => stopPreview, [activeName, stopPreview]);
  // `session` too: a preview start already in flight can land after the suspend or revoke.
  useEffect(() => {
    if (session && (active?.state === 'suspended' || revoked)) stopPreview();
  }, [session, active?.state, revoked, stopPreview]);
  useEffect(() => {
    if (activeName && sandboxes.list.isSuccess && !active) setActiveName(null);
  }, [activeName, active, sandboxes.list.isSuccess]);

  const openApp = (app: string) => {
    if (active?.app === app && active.state !== 'suspended') return setDrawerOpen(false);
    sandboxes.open.mutate(app, {
      onSuccess: ({ sandbox }: { sandbox: Sandbox }) => {
        setActiveName(sandbox.name);
        setDrawerOpen(false);
      },
    });
  };
  const onRemoved = (name: string) => {
    if (name === activeName) setActiveName(null);
  };
  const startNewApp = () => {
    setActiveName(null);
    chatRef.current?.newChat();
    setDrawerOpen(false);
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
        <Group justify="space-between" wrap="nowrap" gap="sm" className="shrink-0">
          {active ? (
            <Group gap={4} wrap="nowrap" className="min-w-0">
              <div className="min-w-0">
                <Text fw={600} truncate>
                  {active.app}
                </Text>
                <Text size="xs" c="dimmed">
                  {APP_STATUS[active.state]}
                </Text>
              </div>
              <AppMenu
                sandbox={active}
                sandboxes={sandboxes}
                onOpen={openApp}
                onRemoved={onRemoved}
              />
            </Group>
          ) : (
            <Text size="sm" c="dimmed">
              Describe a new app, or open one of yours.
            </Text>
          )}
          <Button
            variant="default"
            className="min-h-11 shrink-0"
            rightSection={
              <Badge size="sm" variant="light" circle>
                {apps.length}
              </Badge>
            }
            onClick={() => setDrawerOpen(true)}
          >
            Your apps
          </Button>
        </Group>
      )}
      {active?.state === 'suspended' && (
        <Alert color="gray" variant="light" className="shrink-0" py="xs">
          <Group justify="space-between" wrap="nowrap" gap="sm">
            <Text size="sm">This app is paused, so the assistant can’t work on it.</Text>
            <Button
              className="min-h-11 shrink-0"
              loading={sandboxes.open.isPending}
              onClick={() => openApp(active.app)}
            >
              Resume
            </Button>
          </Group>
        </Alert>
      )}
      {!drawerOpen && (
        <AppError
          error={sandboxes.open.error ?? sandboxes.suspend.error ?? sandboxes.remove.error}
        />
      )}

      {active && (
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
            active ? 'md:flex md:w-5/12 md:shrink-0' : 'w-full',
            shownTab === 'chat' ? 'flex w-full' : 'hidden'
          )}
        >
          <AppAssistantChat
            tokens={tokens}
            tools={tools}
            instructions={instructions}
            mcpServers={mcpServers}
            holdReason={active?.state === 'starting' ? APP_STARTING_HOLD : undefined}
            beforeToolCall={beforeToolCall}
            onToolResult={gate.onToolResult}
            chatRef={chatRef}
          />
        </Paper>
        {active && (
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

      <Drawer
        opened={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        position="right"
        title="Your apps"
        size="md"
      >
        <YourAppsList
          sandboxes={sandboxes}
          activeName={activeName}
          onOpen={openApp}
          onRemoved={onRemoved}
          onNewApp={startNewApp}
        />
      </Drawer>
    </div>
  );
}
