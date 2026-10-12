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
  ScrollArea,
  SegmentedControl,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { useMutation, useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import type { ChatMcpServer } from '~/components/Apps/AppAssistant/AppAssistantChat';
import { AppAssistantChat } from '~/components/Apps/AppAssistant/AppAssistantChat';
import { AppAssistantPreview } from '~/components/Apps/AppAssistant/AppAssistantPreview';
import { isAppBlockId } from '~/components/Apps/AppAssistant/appKey';
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
import { SandboxPanel } from '~/components/Apps/AppAssistant/SandboxPanel';
import { useSandboxes } from '~/components/Apps/AppAssistant/useSandboxes';
import { env } from '~/env/client';
import { APP_ASSISTANT_DAILY_BUZZ_CAP } from '~/shared/constants/app-assistant.constants';
import { numberWithCommas } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';
import classes from './AppAssistant.module.scss';

const NO_MCP_SERVERS: ChatMcpServer[] = [];

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
            The assistant builds your app in a sandbox of your own, and can make images and other
            media for it with your Buzz, up to {numberWithCommas(APP_ASSISTANT_DAILY_BUZZ_CAP)} Buzz
            a day. You can change that limit or turn the assistant off at any time under connected
            apps in your account settings.
          </Text>
          {!!error && (
            <Alert color="red" variant="light">
              {error instanceof Error ? error.message : 'App Assistant could not be turned on.'}
            </Alert>
          )}
          <Group justify="flex-end">
            <Button onClick={onEnable} loading={pending}>
              Turn on App Assistant
            </Button>
          </Group>
        </Stack>
      </Paper>
    </Center>
  );
}

export function AppAssistantWorkspace({ canPreview }: { canPreview: boolean }) {
  // A revoke under connected apps surfaces as `consent_required` on the next mint, for every purpose
  // (the consent row is gone); show the turn-on card rather than leaving every call failing.
  const [revoked, setRevoked] = useState(false);
  const tokens = useMemo(
    () => createAssistantTokenProvider({ onConsentRequired: () => setRevoked(true) }),
    []
  );
  const sandboxUrl = env.NEXT_PUBLIC_APP_ASSISTANT_SANDBOX_URL;
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

  const [activeName, setActiveName] = useState<string | null>(null);
  const active = sandboxes.list.data?.find((s) => s.name === activeName) ?? null;
  const [session, setSession] = useState<PreviewSession | null>(null);
  const [tab, setTab] = useState<'chat' | 'preview'>('chat');
  const [drawerOpen, setDrawerOpen] = useState(false);

  const startDevTunnel = trpc.blocks.startDevTunnel.useMutation();
  const stopDevTunnel = trpc.blocks.stopDevTunnel.useMutation();

  // The chat reads tools and instructions through these on every call, so neither has to be rebuilt.
  const live = useRef({ active, session, canPreview });
  live.current = { active, session, canPreview };
  const stopRef = useRef(stopDevTunnel.mutateAsync);
  stopRef.current = stopDevTunnel.mutateAsync;
  const startRef = useRef(startDevTunnel.mutateAsync);
  startRef.current = startDevTunnel.mutateAsync;

  const stopPreview = useCallback(() => {
    const current = live.current.session;
    if (!current) return;
    setSession(null);
    stopRef.current({ sessionId: current.sessionId }).catch(() => undefined);
  }, []);

  const tools = useMemo(
    () =>
      createPreviewTools({
        canPreview,
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
    [canPreview]
  );

  const instructions = useCallback(
    () =>
      buildAssistantInstructions({
        sandbox: live.current.active,
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
              id: 'sandbox',
              url: mcpUrl,
              label: 'Sandbox',
              token: () => tokens.getToken({ purpose: 'sandbox' }),
            },
          ]
        : NO_MCP_SERVERS,
    [mcpUrl, tokens]
  );

  // A preview belongs to the sandbox it was started from; tear it down when that changes or the
  // page goes away. The tunnel also expires on its own.
  useEffect(() => stopPreview, [activeName, stopPreview]);
  useEffect(() => {
    if (active?.state === 'suspended') stopPreview();
  }, [active?.state, stopPreview]);
  useEffect(() => {
    if (activeName && sandboxes.list.isSuccess && !active) setActiveName(null);
  }, [activeName, active, sandboxes.list.isSuccess]);

  const openSandbox = (sandbox: Sandbox) => {
    setActiveName(sandbox.name);
    setDrawerOpen(false);
  };

  if (!sandboxUrl)
    return (
      <Alert color="yellow" variant="light">
        Sandboxes are not configured on this deployment, so App Assistant can’t build apps here yet.
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
        {access.error instanceof Error ? access.error.message : 'App Assistant is unavailable.'}
      </Alert>
    );

  const panel = (
    <SandboxPanel
      sandboxes={sandboxes}
      activeName={activeName}
      onOpened={openSandbox}
      onRemoved={(name) => {
        if (name === activeName) setActiveName(null);
      }}
    />
  );

  return (
    <div className={clsx('flex flex-col gap-3', classes.workspace)}>
      <Group justify="space-between" wrap="nowrap" gap="sm" className="shrink-0">
        {active ? (
          <Group gap="xs" wrap="nowrap" className="min-w-0">
            <Text fw={600} truncate>
              {active.app}
            </Text>
            <Badge size="sm" variant="light" color={active.state === 'running' ? 'green' : 'gray'}>
              {active.state}
            </Badge>
          </Group>
        ) : (
          <Text size="sm" c="dimmed">
            Open a sandbox to start building.
          </Text>
        )}
        <Group gap={6} wrap="nowrap">
          {active && active.state !== 'suspended' && (
            <Button
              size="compact-sm"
              variant="default"
              loading={sandboxes.suspend.isPending}
              onClick={() => sandboxes.suspend.mutate(active.name)}
            >
              Suspend
            </Button>
          )}
          {active?.state === 'suspended' && (
            <Button
              size="compact-sm"
              loading={sandboxes.open.isPending}
              onClick={() => sandboxes.open.mutate(active.app)}
            >
              Resume
            </Button>
          )}
          <Button size="compact-sm" variant="light" onClick={() => setDrawerOpen(true)}>
            Sandboxes
          </Button>
        </Group>
      </Group>

      <SegmentedControl
        className="shrink-0 md:hidden"
        fullWidth
        value={tab}
        onChange={(value) => setTab(value as 'chat' | 'preview')}
        data={[
          { value: 'chat', label: 'Chat' },
          { value: 'preview', label: active ? 'Preview' : 'Sandboxes' },
        ]}
      />

      <div className="flex min-h-0 flex-1 gap-3">
        <Paper
          withBorder
          radius="md"
          className={clsx(
            'min-h-0 flex-col overflow-hidden md:flex md:w-5/12 md:shrink-0',
            tab === 'chat' ? 'flex w-full' : 'hidden'
          )}
        >
          <AppAssistantChat
            tokens={tokens}
            tools={tools}
            instructions={instructions}
            mcpServers={mcpServers}
          />
        </Paper>
        <Paper
          withBorder
          radius="md"
          className={clsx(
            'min-h-0 flex-1 flex-col overflow-hidden md:flex',
            tab === 'preview' ? 'flex' : 'hidden'
          )}
        >
          {active ? (
            <AppAssistantPreview canPreview={canPreview} session={session} />
          ) : (
            <ScrollArea className="h-full" p="md">
              {panel}
            </ScrollArea>
          )}
        </Paper>
      </div>

      <Drawer
        opened={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        position="right"
        title="Sandboxes"
        size="md"
      >
        {panel}
      </Drawer>
    </div>
  );
}
