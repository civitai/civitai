import {
  Stack,
  Stepper,
  Group,
  Button,
  Text,
  List,
  Alert,
  CopyButton,
  Center,
  Loader,
  Tooltip,
} from '@mantine/core';
import { openContextModal } from '@mantine/modals';
import { IconCheck, IconChevronRight, IconCopy } from '@tabler/icons';
import { useEffect, useState } from 'react';
import { useCivitaiLink } from '~/components/CivitaiLink/CivitaiLinkProvider';
import { createContextModal } from '~/components/Modals/utils/createContextModal';

const { openModal, Modal } = createContextModal({
  name: 'civitai-link-wizard',
  title: 'Civitai Link Setup',
  size: 800,
  // withCloseButton: false,
  // closeOnClickOutside: false,
  Element: ({ context, props }) => {
    const [active, setActive] = useState(0);
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

    return (
      <Stepper
        active={active}
        onStepClick={setActive}
        breakpoint="sm"
        // allowNextStepsSelect={false} // TODO.civitai-link - update mantine
      >
        <Stepper.Step label="About Civitai Link" description="Learn what it does">
          <Stack>
            {/* TODO.justin */}
            {/* TODO.civitai-link - add intro content */}
            <Group position="apart" mt="xl">
              <Button variant="default" onClick={context.close}>
                Eh, nevermind...
              </Button>
              <Button onClick={nextStep} leftIcon={<IconChevronRight />}>{`Let's do it!`}</Button>
            </Group>
          </Stack>
        </Stepper.Step>
        <Stepper.Step label="Prepare SD" description="Add the extension">
          <Stack>
            <Text>Currently we only support Automatic 1111 Stable Diffusion Web UI.</Text>
            <List type="ordered">
              <List.Item>Ensure your installation is up to date</List.Item>
              <List.Item>Go to the extensions tab and...</List.Item>
              <List.Item>Restart Stable Diffusion</List.Item>
            </List>
            <Alert>
              <Text>Prefer watching a video? Check out this video guide.</Text>
              {/* TODO.justin */}
              {/* TODO.civitai-link - update video link */}
              <Text component="a" href="www.google.com" target="_blank" variant="link">
                www.something.com
              </Text>
            </Alert>
            <Group position="apart" mt="xl">
              <Button variant="default" onClick={prevStep}>
                Go Back
              </Button>
              <Button
                onClick={handleCreateInstance}
                leftIcon={<IconChevronRight />}
              >{`Ok, it's installed`}</Button>
            </Group>
          </Stack>
        </Stepper.Step>
        <Stepper.Step label="Connect SD" description="Link your account">
          <Stack>
            <Text>
              Now that you have the extension installed, lets get it connected to your Civitai
              Account.
            </Text>
            <Text> Paste this code into the Civitai Link settings and save.</Text>
            <Center>
              {instance?.key ? (
                <CopyButton value={instance.key}>
                  {({ copied, copy }) => (
                    <Tooltip label="copy">
                      <Button
                        variant="default"
                        onClick={copy}
                        rightIcon={copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
                      >
                        {!copied ? instance.key : 'Copied'}
                      </Button>
                    </Tooltip>
                  )}
                </CopyButton>
              ) : (
                <Button variant="default">
                  <Group spacing="xs" align="center">
                    <Loader size="xs" />
                    <span>generating key</span>
                  </Group>
                </Button>
              )}
            </Center>
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
