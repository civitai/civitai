import {
  AspectRatio,
  Button,
  CopyButton,
  Divider,
  Flex,
  Group,
  Loader,
  Modal,
  Stack,
  Stepper,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import {
  IconCheck,
  IconChevronRight,
  IconCircleCheck,
  IconCirclePlus,
  IconCopy,
} from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { useCivitaiLink } from '~/components/CivitaiLink/CivitaiLinkProvider';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { PlanBenefitList } from '~/components/Subscriptions/PlanBenefitList';
import { YoutubeEmbed } from '~/components/YoutubeEmbed/YoutubeEmbed';
import { fetchLinkReleases } from '~/utils/fetch-link-releases';
import { CivitaiLinkDownloadButton } from './CivitaiLinkDownloadButton';
import { createDialogTrigger } from '~/components/Dialog/dialogStore';

const CivitaiLinkSuccessModal = dynamic(
  () => import('~/components/CivitaiLink/CivitaiLinkSuccessModal'),
  { ssr: false }
);
const openCivitaiLinkSuccessModal = createDialogTrigger(CivitaiLinkSuccessModal);

export default function CivitaiLinkWizardModal() {
  const dialog = useDialogContext();

  const [active, setActive] = useState(0);
  const [buttonData, setButtonData] = useState({
    text: 'Download the Link App',
    secondaryText: '',
    href: 'https://github.com/civitai/civitai-link-desktop/releases/latest',
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
  }, []);

  const vaultLink = (
    <Text component="a" c="blue.4" target="_blank" href="/user/vault" td="underline">
      your Vault
    </Text>
  );

  return (
    <Modal {...dialog} title="Civitai Link Setup">
      <Stepper active={active} onStepClick={setActive} allowNextStepsSelect={false}>
        <Stepper.Step label="About Civitai Link" description="Learn what it does">
          <Stack mt="sm">
            <Stack gap={4}>
              <Title order={3} style={{ lineHeight: 1.1 }}>
                About Civitai Link
              </Title>
              <Text>{`Civitai Link allows you to interact with your Stable Diffusion instance in realtime wherever it is from any device.`}</Text>

              <AspectRatio ratio={16 / 9}>
                <YoutubeEmbed videoId="EHUjiDgh-MI" />
              </AspectRatio>

              <Divider
                mt="lg"
                mb={5}
                label={
                  <Text fw={500} size="sm">
                    Supported Activities:
                  </Text>
                }
              />
              <PlanBenefitList
                useDefaultBenefits={false}
                benefits={[
                  {
                    content: 'Add & remove resources',
                    icon: <IconCircleCheck size={18} />,
                    iconColor: 'green',
                  },
                  {
                    content: <>Offload resources to {vaultLink}</>,
                    icon: <IconCircleCheck size={18} />,
                    iconColor: 'green',
                  },
                  {
                    content: <>Download resources from {vaultLink}</>,
                    icon: <IconCircleCheck size={18} />,
                    iconColor: 'green',
                  },
                ]}
              />
              <Divider
                mt="lg"
                mb={5}
                label={
                  <Text fw={500} size="sm">
                    Supported Stable Diffusion UIs:
                  </Text>
                }
              />
              <PlanBenefitList
                useDefaultBenefits={false}
                benefits={[
                  {
                    content: (
                      <Text
                        component="a"
                        c="blue.4"
                        td="underline"
                        href="https://github.com/comfyanonymous/ComfyUI"
                        target="_blank"
                        rel="nofollow noreferrer"
                      >
                        ComfyUI
                      </Text>
                    ),
                    icon: <IconCircleCheck size={18} />,
                    iconColor: 'green',
                  },
                  {
                    content: <Text>Connect any models folder</Text>,
                    icon: <IconCirclePlus size={18} />,
                  },
                ]}
              />
            </Stack>
            <Group justify="space-between" mt="xl">
              <Button variant="default" onClick={dialog.onClose}>
                Eh, nevermind...
              </Button>
              <Button
                onClick={nextStep}
                rightSection={<IconChevronRight />}
              >{`Let's do it!`}</Button>
            </Group>
          </Stack>
        </Stepper.Step>
        <Stepper.Step label="Install Link App" description="Install the Link application">
          <Stack mt="sm">
            <Stack gap={4}>
              <Title order={3} mb={0} style={{ lineHeight: 1 }}>
                Download the Link desktop application
              </Title>
              <Text mb="md" c="dimmed">
                Run the installer and head to the next step to get a Link key.
              </Text>
              <Flex justify="center" w="100%">
                <CivitaiLinkDownloadButton {...buttonData} isMember />
              </Flex>
            </Stack>
            <Group justify="space-between" mt="xl">
              <Button variant="default" onClick={prevStep}>
                Go Back
              </Button>
              <Button
                onClick={handleCreateInstance}
                rightSection={<IconChevronRight />}
              >{`Ok, it's installed`}</Button>
            </Group>
          </Stack>
        </Stepper.Step>
        <Stepper.Step label="Connect Link App" description="Link your account">
          <Stack mt="sm">
            <Stack gap={4}>
              <Title order={3} mb={0} style={{ lineHeight: 1 }}>
                Link your account
              </Title>
              <Text mb="md" c="dimmed">
                In your Link application, paste the code below to link your account and finish the
                setup.
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
