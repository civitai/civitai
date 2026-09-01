import {
  Anchor,
  Button,
  Code,
  CopyButton,
  Flex,
  Group,
  List,
  Loader,
  Modal,
  Paper,
  Stack,
  Stepper,
  Text,
  ThemeIcon,
  Title,
  Tooltip,
} from '@mantine/core';
import {
  IconBoxMultiple,
  IconCheck,
  IconChevronRight,
  IconCopy,
  IconDeviceDesktop,
  IconInfoCircle,
} from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { useCivitaiLink } from '~/components/CivitaiLink/CivitaiLinkProvider';
import type { CivitaiLinkConnectPath } from '~/components/CivitaiLink/civitai-link-paths';
import {
  CIVITAI_LINK_DESKTOP_RELEASES,
  CIVITAI_LINK_NODE_PACK_NAME,
  CIVITAI_LINK_NODE_PACK_REPO,
} from '~/components/CivitaiLink/civitai-link-paths';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { fetchLinkReleases } from '~/utils/fetch-link-releases';
import { CivitaiLinkDownloadButton } from './CivitaiLinkDownloadButton';
import { createDialogTrigger } from '~/components/Dialog/dialogStore';

const CivitaiLinkSuccessModal = dynamic(
  () => import('~/components/CivitaiLink/CivitaiLinkSuccessModal'),
  { ssr: false }
);
const openCivitaiLinkSuccessModal = createDialogTrigger(CivitaiLinkSuccessModal);

const paths: Array<{
  value: CivitaiLinkConnectPath;
  icon: typeof IconBoxMultiple;
  label: string;
  description: string;
  badge?: string;
}> = [
  {
    value: 'nodepack',
    icon: IconBoxMultiple,
    label: 'ComfyUI node pack',
    description: `Already running ComfyUI? Install the Civitai node pack from the Manager and pair it from the sidebar.`,
    badge: 'New',
  },
  {
    value: 'desktop',
    icon: IconDeviceDesktop,
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
      p="md"
      className="flex-1 cursor-pointer text-left"
      // Tailwind's preflight zeroes `border` on `button`, which beats Mantine's
      // `withBorder`. Set the border here so the selected state is visible.
      style={{
        border: `${selected ? 2 : 1}px solid ${
          selected ? 'var(--mantine-color-blue-6)' : 'var(--mantine-color-default-border)'
        }`,
      }}
      aria-pressed={selected}
    >
      <Stack gap="xs">
        <Group justify="space-between" wrap="nowrap">
          <ThemeIcon variant="light" color={selected ? 'blue' : 'gray'} size="lg" radius="sm">
            <Icon size={20} />
          </ThemeIcon>
          {path.badge && (
            <Text c="blue.4" size="xs" fw={700} tt="uppercase">
              {path.badge}
            </Text>
          )}
        </Group>
        <Text fw={600}>{path.label}</Text>
        <Text size="sm" c="dimmed">
          {path.description}
        </Text>
      </Stack>
    </Paper>
  );
}

export default function CivitaiLinkWizardModal() {
  const dialog = useDialogContext();

  const [active, setActive] = useState(0);
  const [path, setPath] = useState<CivitaiLinkConnectPath>('nodepack');
  const [buttonData, setButtonData] = useState({
    text: 'Download the Link App',
    secondaryText: '',
    href: CIVITAI_LINK_DESKTOP_RELEASES,
  });
  const nextStep = () => setActive((current) => (current < 2 ? current + 1 : current));
  const prevStep = () => setActive((current) => (current > 0 ? current - 1 : current));

  const { connected, instance, createInstance } = useCivitaiLink();

  const handleCreateInstance = () => {
    nextStep();
    createInstance();
  };

  useEffect(() => {
    if (connected) {
      openCivitaiLinkSuccessModal();
    }
  }, [connected]);

  useEffect(() => {
    if (path !== 'desktop') return;

    const fetchReleases = async () => {
      const userAgent = navigator.userAgent;
      const data = await fetchLinkReleases(userAgent);

      setButtonData({
        text: 'Download the Link App',
        secondaryText: `${data.os} ${data.tag_name}`,
        href: data.href,
      });
    };

    fetchReleases();
  }, [path]);

  const isNodePack = path === 'nodepack';

  return (
    <Modal {...dialog} title="Civitai Link" size="lg">
      <Stepper active={active} onStepClick={setActive} allowNextStepsSelect={false}>
        <Stepper.Step label="Choose app">
          <Stack mt="sm">
            <Stack gap={4}>
              <Title order={3} style={{ lineHeight: 1.1 }}>
                How do you want to connect?
              </Title>
              <Text c="dimmed">
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
            <Group gap="xs" align="flex-start" wrap="nowrap">
              <IconInfoCircle size={16} className="mt-0.5 shrink-0 opacity-60" />
              <Text size="xs" c="dimmed">
                Both connect the same way and do the same things. You can add more apps later.
              </Text>
            </Group>
            <Group justify="space-between" mt="xl">
              <Button variant="default" onClick={dialog.onClose}>
                Not now
              </Button>
              <Button onClick={nextStep} rightSection={<IconChevronRight />}>
                Continue
              </Button>
            </Group>
          </Stack>
        </Stepper.Step>
        <Stepper.Step label="Install">
          <Stack mt="sm">
            {isNodePack ? (
              <Stack gap={4}>
                <Title order={3} mb={0} style={{ lineHeight: 1 }}>
                  Install the Civitai node pack
                </Title>
                <Text mb="md" c="dimmed">
                  It lives inside ComfyUI — nothing to download from this page.
                </Text>
                <List type="ordered" spacing="xs">
                  <List.Item>
                    Open <b>ComfyUI Manager</b>, then <b>Custom Nodes Manager</b>.
                  </List.Item>
                  <List.Item>
                    Search for <b>{CIVITAI_LINK_NODE_PACK_NAME}</b> (publisher <Code>civitai</Code>)
                    and install it.
                  </List.Item>
                  <List.Item>Restart ComfyUI.</List.Item>
                </List>
                <Text size="xs" c="dimmed" mt="md">
                  {`Prefer the CLI? Run `}
                  <Code>comfy node registry-install civitai-comfy-nodes</Code>
                  {`, or install `}
                  <Anchor
                    inherit
                    href={CIVITAI_LINK_NODE_PACK_REPO}
                    target="_blank"
                    rel="nofollow noreferrer"
                  >
                    from source
                  </Anchor>
                  .
                </Text>
              </Stack>
            ) : (
              <Stack gap={4}>
                <Title order={3} mb={0} style={{ lineHeight: 1 }}>
                  Install the Link desktop app
                </Title>
                <Text mb="md" c="dimmed">
                  A small background app that watches one models folder and keeps it in sync.
                </Text>
                <Flex justify="center" w="100%">
                  <CivitaiLinkDownloadButton {...buttonData} isMember />
                </Flex>
                <List type="ordered" spacing="xs" mt="md">
                  <List.Item>Run the installer and open the Link app.</List.Item>
                  <List.Item>Choose the folder your models live in.</List.Item>
                </List>
              </Stack>
            )}
            <Group justify="space-between" mt="xl">
              <Button variant="default" onClick={prevStep}>
                Go Back
              </Button>
              <Button onClick={handleCreateInstance} rightSection={<IconChevronRight />}>
                {`Ok, it's installed`}
              </Button>
            </Group>
          </Stack>
        </Stepper.Step>
        <Stepper.Step label="Connect">
          <Stack mt="sm">
            <Stack gap={4}>
              <Title order={3} mb={0} style={{ lineHeight: 1 }}>
                Pair your app
              </Title>
              <Text mb="md" c="dimmed">
                {isNodePack
                  ? `In ComfyUI, open the Civitai sidebar tab and paste the code below into the Civitai Link panel.`
                  : `In the Link app, paste the code below to finish pairing.`}
              </Text>
              <Stack align="center" gap={5} my="lg">
                <Title order={4}>Link Key</Title>
                {instance?.key ? (
                  <CopyButton value={instance.key}>
                    {({ copied, copy }) => (
                      <Tooltip label="copy">
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
                      <span>Generating key</span>
                    </Group>
                  </Button>
                )}
              </Stack>
            </Stack>
            <Group justify="space-between" mt="xl">
              <Button variant="default" onClick={prevStep}>
                Go Back
              </Button>
            </Group>
          </Stack>
        </Stepper.Step>
      </Stepper>
    </Modal>
  );
}
