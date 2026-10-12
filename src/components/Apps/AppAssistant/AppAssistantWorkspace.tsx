import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Drawer,
  Group,
  Paper,
  ScrollArea,
  SegmentedControl,
  Text,
} from '@mantine/core';
import clsx from 'clsx';
import type { ChatMcpServer } from '~/components/Apps/AppAssistant/AppAssistantChat';
import { AppAssistantChat } from '~/components/Apps/AppAssistant/AppAssistantChat';
import { AppAssistantPreview } from '~/components/Apps/AppAssistant/AppAssistantPreview';
import { isAppBlockId } from '~/components/Apps/AppAssistant/appKey';
import { buildAssistantInstructions } from '~/components/Apps/AppAssistant/assistantInstructions';
import { createAssistantTokenProvider } from '~/components/Apps/AppAssistant/assistantToken';
import type { PreviewSession } from '~/components/Apps/AppAssistant/previewTools';
import { createPreviewTools } from '~/components/Apps/AppAssistant/previewTools';
import type { Sandbox } from '~/components/Apps/AppAssistant/sandboxClient';
import { createSandboxClient } from '~/components/Apps/AppAssistant/sandboxClient';
import { SandboxPanel } from '~/components/Apps/AppAssistant/SandboxPanel';
import { useSandboxes } from '~/components/Apps/AppAssistant/useSandboxes';
import { env } from '~/env/client';
import { trpc } from '~/utils/trpc';
import classes from './AppAssistant.module.scss';

const NO_MCP_SERVERS: ChatMcpServer[] = [];

export function AppAssistantWorkspace({ canPreview }: { canPreview: boolean }) {
  const tokens = useMemo(() => createAssistantTokenProvider(), []);
  const sandboxUrl = env.NEXT_PUBLIC_APP_ASSISTANT_SANDBOX_URL;
  const sandboxClient = useMemo(
    () =>
      sandboxUrl ? createSandboxClient({ baseUrl: sandboxUrl, getToken: tokens.getToken }) : null,
    [sandboxUrl, tokens]
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

  const mcpUrl = active?.state === 'running' ? active.mcpUrl : null;
  const mcpServers = useMemo<ChatMcpServer[]>(
    () =>
      mcpUrl
        ? [{ id: 'sandbox', url: mcpUrl, label: 'Sandbox', token: () => tokens.getToken() }]
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

  if (!sandboxClient)
    return (
      <Alert color="yellow" variant="light">
        Sandboxes are not configured on this deployment, so App Assistant can’t build apps here yet.
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
