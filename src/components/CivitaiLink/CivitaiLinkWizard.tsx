import {
  Stack,
  Stepper,
  Group,
  Button,
  Text,
  CopyButton,
  Loader,
  Tooltip,
  Title,
  Divider,
  AspectRatio,
  Flex,
} from '@mantine/core';
import { openContextModal } from '@mantine/modals';
import {
  IconCheck,
  IconChevronRight,
  IconCircleCheck,
  IconCirclePlus,
  IconClock,
  IconCopy,
} from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { useCivitaiLink } from '~/components/CivitaiLink/CivitaiLinkProvider';
import { createContextModal } from '~/components/Modals/utils/createContextModal';
import { PlanBenefitList } from '~/components/Stripe/PlanBenefitList';
import { YoutubeEmbed } from '~/components/YoutubeEmbed/YoutubeEmbed';
import { CivitaiLinkDownloadButton } from './CivitaiLinkDownloadButton';
import { fetchLinkReleases } from '~/utils/fetch-link-releases';

const { openModal, Modal } = createContextModal({
  name: 'civitai-link-wizard',
  title: 'Civitai Link Setup',
  size: 800,
  Element: ({ context }) => {
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
        openContextModal({
          modal: 'civitai-link-success',
          withCloseButton: false,
          closeOnClickOutside: false,
          closeOnEscape: false,
          innerProps: {},
        });
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
      <Text component="a" variant="link" target="_blank" href="/user/vault" td="underline">
        your Vault
      </Text>
    );

    return (
      <Stepper active={active} onStepClick={setActive} breakpoint="sm" allowNextStepsSelect={false}>
        <Stepper.Step label="About Civitai Link" description="Learn what it does">
          <Stack mt="sm">
            <Stack spacing={4}>
              <Title order={3} sx={{ lineHeight: 1.1 }}>
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
                  <Text weight={500} size="sm">
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
                  {
                    content: 'Generate images (coming soon)',
                    icon: <IconClock size={18} />,
                    iconColor: 'yellow',
                  },
                ]}
              />
              <Divider
                mt="lg"
                mb={5}
                label={
                  <Text weight={500} size="sm">
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
                        variant="link"
                        td="underline"
                        href="https://github.com/AUTOMATIC1111/stable-diffusion-webui"
                        target="_blank"
                        rel="nofollow noreferrer"
                      >
                        Automatic 1111 SD Web UI
                      </Text>
                    ),
                    icon: <IconCircleCheck size={18} />,
                    iconColor: 'green',
                  },
                  {
                    content: (
                      <Text
                        component="a"
                        variant="link"
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
            <Group position="apart" mt="xl">
              <Button variant="default" onClick={context.close}>
                Eh, nevermind...
              </Button>
              <Button onClick={nextStep} rightIcon={<IconChevronRight />}>{`Let's do it!`}</Button>
            </Group>
          </Stack>
        </Stepper.Step>
        <Stepper.Step label="Install Link App" description="Install the Link application">
          <Stack mt="sm">
            <Stack spacing={4}>
              <Title order={3} mb={0} sx={{ lineHeight: 1 }}>
                Download the Link desktop application
              </Title>
              <Text mb="md" color="dimmed">
                Run the installer and head to the next step to get a Link key.
              </Text>
              <Flex justify="center" w="100%">
                <CivitaiLinkDownloadButton {...buttonData} isMember />
              </Flex>
            </Stack>
            <Group position="apart" mt="xl">
              <Button variant="default" onClick={prevStep}>
                Go Back
              </Button>
              <Button
                onClick={handleCreateInstance}
                rightIcon={<IconChevronRight />}
              >{`Ok, it's installed`}</Button>
            </Group>
          </Stack>
        </Stepper.Step>
        <Stepper.Step label="Connect Link App" description="Link your account">
          <Stack mt="sm">
            <Stack spacing={4}>
              <Title order={3} mb={0} sx={{ lineHeight: 1 }}>
                Link your account
              </Title>
              <Text mb="md" color="dimmed">
                In your Link application, paste the code below to link your account and finish the
                setup.
              </Text>
              <Stack align="center" spacing={5} my="lg">
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
                          rightIcon={copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
                        >
                          {!copied ? instance.key : 'Copied'}
                        </Button>
                      </Tooltip>
                    )}
                  </CopyButton>
                ) : (
                  <Button variant="default" size="lg" px="sm">
                    <Group spacing="xs" align="center">
                      <Loader size="sm" />
                      <span>Generating key</span>
                    </Group>
                  </Button>
                )}
              </Stack>
            </Stack>
            <Group position="apart" mt="xl">
              <Button variant="default" onClick={prevStep}>
                Go Back
              </Button>
            </Group>
          </Stack>
        </Stepper.Step>
      </Stepper>
    );
  },
});

export const openCivitaiLinkModal = openModal;
export default Modal;
