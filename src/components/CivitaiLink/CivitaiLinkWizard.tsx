import {
  alpha,
  Anchor,
  Badge,
  Button,
  Center,
  CopyButton,
  Flex,
  Group,
  Loader,
  Modal,
  Paper,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import {
  IconCheck,
  IconAlertTriangle,
  IconChevronRight,
  IconCopy,
  IconPackages,
  IconDeviceDesktopDown,
  IconDownload,
  IconInfoCircle,
  IconLink,
  IconRefresh,
} from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { AppRow } from '~/components/CivitaiLink/CivitaiLinkAppRow';
import { useCivitaiLink } from '~/components/CivitaiLink/CivitaiLinkProvider';
import type { CivitaiLinkConnectPath } from '~/components/CivitaiLink/civitai-link-paths';
import type { PairingStatus } from '~/workers/civitai-link-worker-types';
import {
  CIVITAI_LINK_COMFYUI_DOWNLOAD,
  CIVITAI_LINK_DESKTOP_RELEASES,
  CIVITAI_LINK_NODE_PACK_NAME,
  CIVITAI_LINK_NODE_PACK_REPO,
} from '~/components/CivitaiLink/civitai-link-paths';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { fetchLinkReleases } from '~/utils/fetch-link-releases';
import clsx from 'clsx';
import classes from './civitai-link.module.scss';

const osLabels: Record<string, string> = {
  Windows: 'Windows',
  Mac: 'macOS',
  Linux: 'Linux',
  Unknown: 'your machine',
};
const downloadableOses = ['Windows', 'Mac', 'Linux'];

const paths: Array<{
  value: CivitaiLinkConnectPath;
  icon: typeof IconPackages;
  label: string;
  description: string;
  badge?: string;
}> = [
  {
    value: 'nodepack',
    icon: IconPackages,
    label: 'ComfyUI node pack',
    description: `Already running ComfyUI? Install the Civitai node pack from the Manager and pair it from the sidebar.`,
    badge: 'New',
  },
  {
    value: 'desktop',
    icon: IconDeviceDesktopDown,
    label: 'Link desktop app',
    description: `Point it at any models folder. Works with ComfyUI, Forge, or a plain library.`,
  },
];

function PathCard({
  path,
  selected,
  onSelect,
}: {
  path: (typeof paths)[number];
  selected: boolean;
  onSelect: () => void;
}) {
  const Icon = path.icon;

  return (
    <Paper
      component="button"
      type="button"
      onClick={onSelect}
      radius="md"
      p="lg"
      className={clsx(
        'mantine-focus-auto flex flex-1 cursor-pointer flex-col justify-start text-left',
        classes.surface
      )}
      // Tailwind's preflight zeroes `border` on `button`, which beats Mantine's
      // `withBorder`. Set the border here so the selected state is visible.
      style={{
        border: `${selected ? 2 : 1}px solid ${
          selected ? 'var(--mantine-color-blue-6)' : 'var(--mantine-color-default-border)'
        }`,
      }}
      aria-pressed={selected}
    >
      <Stack gap={10}>
        <Group justify="space-between" wrap="nowrap">
          <Center
            w={38}
            h={38}
            className={clsx(!selected && classes.surfaceRaised)}
            style={{
              borderRadius: 'var(--mantine-radius-sm)',
              background: selected ? 'var(--mantine-color-blue-light)' : undefined,
              flexShrink: 0,
            }}
          >
            <Icon size={20} className={selected ? classes.accentIcon : classes.neutralIcon} />
          </Center>
          {path.badge && (
            <Badge variant="light" color="blue" radius="xl" tt="none" fz={11} fw={700} px={9}>
              {path.badge}
            </Badge>
          )}
        </Group>
        <Text fz="md" fw={600} c="var(--mantine-color-bright)">
          {path.label}
        </Text>
        <Text fz={13} c="dimmed" lh={1.5}>
          {path.description}
        </Text>
      </Stack>
    </Paper>
  );
}

function NumberedStep({
  index,
  children,
  caption,
}: {
  index: number;
  children: React.ReactNode;
  caption?: string;
}) {
  return (
    <Group align="flex-start" wrap="nowrap" gap={12}>
      <Center
        w={22}
        h={22}
        className={classes.surfaceRaised}
        style={{ borderRadius: 999, flexShrink: 0 }}
      >
        <Text fz={11} fw={700} c="var(--mantine-color-text)">
          {index}
        </Text>
      </Center>
      <Stack gap={2} pt={2}>
        <Text fz="sm" fw={500} c="var(--mantine-color-text)" lh={1.45}>
          {children}
        </Text>
        {caption && (
          <Text fz="xs" c="dimmed" lh={1.45}>
            {caption}
          </Text>
        )}
      </Stack>
    </Group>
  );
}

function NoteStrip({ children, icon }: { children: React.ReactNode; icon?: React.ReactNode }) {
  return (
    <Group
      align="flex-start"
      wrap="nowrap"
      gap={10}
      p={12}
      className={classes.surface}
      style={{ borderRadius: 'var(--mantine-radius-sm)' }}
    >
      {icon ?? <IconInfoCircle size={15} className={clsx('mt-0.5 shrink-0', classes.dimIcon)} />}
      <Text fz="xs" c="dimmed" lh={1.5}>
        {children}
      </Text>
    </Group>
  );
}

function WizardFooter({ left, right }: { left: React.ReactNode; right?: React.ReactNode }) {
  return (
    <Group justify="space-between" mt="lg">
      {left}
      {right}
    </Group>
  );
}

function PairingState({ status, onRetry }: { status?: PairingStatus; onRetry: () => void }) {
  // A live region added alongside its own content announces unreliably, so one
  // wrapper spans all three states.
  return (
    <div role="status">
      {status === 'paired' ? (
        <Group justify="center" gap={10} my="md">
          <Center
            w={40}
            h={40}
            style={{ borderRadius: 999, background: 'var(--mantine-color-green-light)' }}
          >
            <IconCheck size={20} className="text-green-6" />
          </Center>
          <Text fz="md" fw={600} c="var(--mantine-color-bright)">
            Signed in — this app is connected
          </Text>
        </Group>
      ) : status === 'timeout' ? (
        <Stack align="center" gap="xs" my="md">
          <Text fz="sm" c="dimmed" ta="center" maw={420}>
            Still waiting? Make sure the app is running.
          </Text>
          <Button variant="default" onClick={onRetry} leftSection={<IconRefresh size={16} />}>
            Retry
          </Button>
        </Stack>
      ) : (
        <Group justify="center" gap={10} my="md">
          <Loader size="sm" />
          <Text fz="md" fw={600} c="var(--mantine-color-bright)">
            Waiting for the app…
          </Text>
        </Group>
      )}
    </div>
  );
}

export default function CivitaiLinkWizardModal() {
  const dialog = useDialogContext();

  const [active, setActive] = useState(0);
  const [path, setPath] = useState<CivitaiLinkConnectPath>('nodepack');
  const [release, setRelease] = useState({
    os: 'Unknown',
    tagName: '',
    href: CIVITAI_LINK_DESKTOP_RELEASES,
  });
  const nextStep = () => setActive((current) => (current < 2 ? current + 1 : current));
  const prevStep = () => setActive((current) => (current > 0 ? current - 1 : current));

  const {
    connected,
    instance,
    createInstance,
    renameInstance,
    awaitPairing,
    cancelAwaitPairing,
    pairingStatus,
  } = useCivitaiLink();
  const [name, setName] = useState('');
  const isNodePack = path === 'nodepack';

  const handleAdvance = () => {
    nextStep();
    if (isNodePack) createInstance();
    else awaitPairing();
  };

  const commitName = () => {
    const trimmed = name.trim();
    if (instance?.id && trimmed && trimmed !== instance.name) renameInstance(instance.id, trimmed);
  };

  useEffect(() => {
    if (connected) setActive(2);
  }, [connected]);

  useEffect(() => {
    if (active !== 2 || isNodePack) return;
    return () => {
      cancelAwaitPairing();
    };
  }, [active, isNodePack]); // eslint-disable-line

  useEffect(() => {
    if (active === 2 && !isNodePack && pairingStatus === 'paired') commitName();
  }, [active, isNodePack, pairingStatus, instance?.id]); // eslint-disable-line

  useEffect(() => {
    if (path !== 'desktop') return;

    const fetchReleases = async () => {
      const data = await fetchLinkReleases(navigator.userAgent);
      setRelease({ os: data.os, tagName: data.tag_name, href: data.href });
    };

    fetchReleases();
  }, [path]);

  const otherOses = downloadableOses.filter((os) => os !== release.os);

  return (
    <Modal
      {...dialog}
      title={
        <Group gap="xs">
          <IconLink size={18} className="text-blue-4" />
          <Text fw={600}>Civitai Link</Text>
        </Group>
      }
      size="lg"
    >
      {active === 0 && (
        <Stack gap="lg">
          <Stack gap={4}>
            <Text fz={24} fw={700} c="var(--mantine-color-bright)" lh={1.25}>
              How do you want to connect?
            </Text>
            <Text fz="sm" c="dimmed" lh={1.55}>
              Civitai Link sends models straight from the site to the machine you generate on — no
              downloads, no file shuffling. Pick whichever you already run.
            </Text>
          </Stack>
          <Flex direction={{ base: 'column', sm: 'row' }} gap="sm" align="stretch">
            {paths.map((option) => (
              <PathCard
                key={option.value}
                path={option}
                selected={path === option.value}
                onSelect={() => setPath(option.value)}
              />
            ))}
          </Flex>
          <NoteStrip>
            Both connect the same way and do the same things. You can add more apps later.
          </NoteStrip>
          <WizardFooter
            left={
              <Button variant="subtle" color="gray" onClick={dialog.onClose}>
                Not now
              </Button>
            }
            right={
              <Button onClick={nextStep} rightSection={<IconChevronRight size={16} />}>
                Continue
              </Button>
            }
          />
        </Stack>
      )}
      {active === 1 && (
        <Stack gap="lg">
          {isNodePack ? (
            <>
              <Stack gap={4}>
                <Text fz={24} fw={700} c="var(--mantine-color-bright)" lh={1.25}>
                  Install the Civitai node pack
                </Text>
                <Text fz="sm" c="dimmed" lh={1.55}>
                  It lives inside ComfyUI — nothing to download from this page.
                </Text>
                <Text fz="xs" c="dimmed" mt={2}>
                  {`Don't have ComfyUI yet? `}
                  <Anchor
                    inherit
                    href={CIVITAI_LINK_COMFYUI_DOWNLOAD}
                    target="_blank"
                    rel="nofollow noreferrer"
                  >
                    Download it here
                  </Anchor>
                  .
                </Text>
              </Stack>
              <Stack gap={16} pt={4}>
                <NumberedStep index={1}>
                  Open <b>ComfyUI Manager</b>, then <b>Custom Nodes Manager</b>.
                </NumberedStep>
                <NumberedStep index={2} caption="Takes a few seconds.">
                  Search for <b>{CIVITAI_LINK_NODE_PACK_NAME}</b> and install it.
                </NumberedStep>
                <NumberedStep index={3}>Restart ComfyUI.</NumberedStep>
                <NumberedStep
                  index={4}
                  caption="You'll paste a pairing code there in the next step."
                >
                  Open the <b>Civitai</b> panel in the ComfyUI sidebar.
                </NumberedStep>
              </Stack>
              <NoteStrip>
                {`Prefer a manual install? Clone `}
                <Anchor
                  inherit
                  href={CIVITAI_LINK_NODE_PACK_REPO}
                  target="_blank"
                  rel="nofollow noreferrer"
                >
                  {CIVITAI_LINK_NODE_PACK_REPO.replace('https://', '')}
                </Anchor>
                {` into your custom_nodes folder.`}
              </NoteStrip>
            </>
          ) : (
            <>
              <Stack gap={4}>
                <Text fz={24} fw={700} c="var(--mantine-color-bright)" lh={1.25}>
                  Install the Link desktop app
                </Text>
                <Text fz="sm" c="dimmed" lh={1.55}>
                  A small background app that watches one models folder and keeps it in sync.
                </Text>
              </Stack>
              <Stack align="center" gap="xs" mt="xs">
                <Button
                  component={Link}
                  href={release.href}
                  rel="nofollow noreferrer"
                  size="lg"
                  radius="xl"
                  leftSection={<IconDownload size={20} />}
                >
                  <Stack gap={0} align="flex-start">
                    <Text inherit>{`Download for ${
                      osLabels[release.os] ?? osLabels.Unknown
                    }`}</Text>
                    {release.tagName && (
                      <Text fz={10} fw={400} opacity={0.8}>
                        {release.tagName}
                      </Text>
                    )}
                  </Stack>
                </Button>
                <Group gap="xs">
                  {[...otherOses.map((os) => osLabels[os]), 'All releases'].map((label, index) => (
                    <Group key={label} gap="xs">
                      {index > 0 && (
                        <Text size="xs" c="dimmed">
                          ·
                        </Text>
                      )}
                      <Anchor
                        size="xs"
                        href={CIVITAI_LINK_DESKTOP_RELEASES}
                        target="_blank"
                        rel="nofollow noreferrer"
                      >
                        {label}
                      </Anchor>
                    </Group>
                  ))}
                </Group>
              </Stack>
              <Stack gap={16} pt={4}>
                <NumberedStep index={1}>Run the installer and open the Link app.</NumberedStep>
                <NumberedStep index={2}>Choose the folder your models live in.</NumberedStep>
                <NumberedStep
                  index={3}
                  caption="You'll paste a pairing code there in the next step."
                >
                  {`Open the app's `}
                  <b>Civitai Link</b>
                  {` panel.`}
                </NumberedStep>
              </Stack>
              <NoteStrip>
                On a different machine? Grab any build from the{' '}
                <Anchor
                  inherit
                  href={CIVITAI_LINK_DESKTOP_RELEASES}
                  target="_blank"
                  rel="nofollow noreferrer"
                >
                  releases page
                </Anchor>
                .
              </NoteStrip>
            </>
          )}
          <WizardFooter
            left={
              <Button variant="subtle" color="gray" onClick={prevStep}>
                Go back
              </Button>
            }
            right={
              <Button onClick={handleAdvance} rightSection={<IconChevronRight size={16} />}>
                {`I've installed it`}
              </Button>
            }
          />
        </Stack>
      )}
      {active === 2 && (
        <Stack gap="lg">
          {connected ? (
            <>
              <Stack gap={4}>
                <Text
                  fz={24}
                  fw={700}
                  c="var(--mantine-color-bright)"
                  lh={1.25}
                >{`You're connected`}</Text>
                <Text fz="sm" c="dimmed" lh={1.55}>
                  This machine can now receive models straight from Civitai.
                </Text>
              </Stack>
              <Center my="md">
                <Center
                  w={72}
                  h={72}
                  bg={alpha('var(--mantine-color-success-5)', 0.2)}
                  style={{ borderRadius: 999 }}
                >
                  <IconCheck size={32} stroke={2.5} color="var(--mantine-color-success-5)" />
                </Center>
              </Center>
            </>
          ) : isNodePack ? (
            <>
              <Stack gap={4}>
                <Text fz={24} fw={700} c="var(--mantine-color-bright)" lh={1.25}>
                  Pair with this code
                </Text>
                <Text fz="sm" c="dimmed" lh={1.55}>
                  Enter this code in ComfyUI once. The connection sticks — you won&apos;t need it
                  again.
                </Text>
              </Stack>
              <Stack align="center" gap="xs" my="md">
                <div className="relative flex size-24 items-center justify-center">
                  <span
                    className={clsx('absolute inset-0 rounded-full', classes.pairingHalo)}
                    style={{ background: 'var(--mantine-color-blue-light)' }}
                  />
                  <Center
                    w={66}
                    h={66}
                    className={clsx('relative', classes.surfaceRaised)}
                    style={{ borderRadius: 999, border: '2px solid var(--mantine-color-blue-6)' }}
                  >
                    <IconLink size={26} className="text-blue-6" />
                  </Center>
                </div>
                {instance?.key ? (
                  <CopyButton value={instance.key}>
                    {({ copied, copy }) => (
                      <Tooltip label="Copy">
                        <Button
                          variant="default"
                          onClick={copy}
                          size="lg"
                          px="sm"
                          rightSection={copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
                        >
                          {!copied ? instance.key : 'Copied'}
                        </Button>
                      </Tooltip>
                    )}
                  </CopyButton>
                ) : (
                  <Button variant="default" size="lg" px="sm">
                    <Group gap="xs" align="center">
                      <Loader size="sm" />
                      <span>Generating code</span>
                    </Group>
                  </Button>
                )}
                <Text size="sm" c="dimmed" ta="center" maw={420}>
                  {`In ComfyUI, open the Civitai panel and paste the code. We'll pick it up here automatically.`}
                </Text>
              </Stack>
            </>
          ) : (
            <>
              <Stack gap={4}>
                <Text fz={24} fw={700} c="var(--mantine-color-bright)" lh={1.25}>
                  Sign in from the app
                </Text>
                <Text fz="sm" c="dimmed" lh={1.55}>
                  No code to copy. Approve the sign-in in your browser and this page picks it up.
                </Text>
              </Stack>
              <Stack gap={16} pt={4}>
                <NumberedStep index={1}>
                  Open <b>Civitai Link</b> on that machine.
                </NumberedStep>
                <NumberedStep index={2}>
                  Click <b>Sign in with Civitai</b>.
                </NumberedStep>
                <NumberedStep index={3} caption="It opens in your default browser.">
                  Approve the request in the browser tab that opens.
                </NumberedStep>
              </Stack>
              <PairingState status={pairingStatus} onRetry={awaitPairing} />
            </>
          )}
          <TextInput
            label="Name this app"
            description="Shown wherever you pick where to send a model. You can change it later."
            placeholder="Workstation"
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitName();
            }}
          />
          {connected ? (
            <AppRow name={name.trim() || instance?.name || 'Workstation'} connected />
          ) : (
            <NoteStrip
              icon={
                <IconAlertTriangle size={15} className={clsx('mt-0.5 shrink-0', classes.dimIcon)} />
              }
            >
              {isNodePack
                ? `Nothing after a minute? Make sure ComfyUI is running, then reload this page.`
                : `Nothing after a minute? Make sure the Link app is running on that machine.`}
            </NoteStrip>
          )}
          <WizardFooter
            left={
              <Button variant="subtle" color="gray" onClick={prevStep}>
                Go back
              </Button>
            }
            right={
              <Button
                onClick={() => {
                  commitName();
                  dialog.onClose();
                }}
              >
                {connected ? 'Save and finish' : 'Done'}
              </Button>
            }
          />
        </Stack>
      )}
    </Modal>
  );
}
