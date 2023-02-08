import {
  Stack,
  Stepper,
  Title,
  Group,
  Button,
  Text,
  List,
  Alert,
  Paper,
  CopyButton,
  Center,
  ActionIcon,
  ThemeIcon,
  Loader,
  Tooltip,
} from '@mantine/core';
import { IconCheck, IconChevronRight, IconCopy } from '@tabler/icons';
import { useState } from 'react';
import { z } from 'zod';
import {
  createLinkInstance,
  useCreateLinkInstance,
  useUpdateLinkInstance,
} from '~/components/CivitaiLink/civitai-link-api';
import { useCivitaiLink } from '~/components/CivitaiLink/CivitaiLinkProvider';
import { createContextModal } from '~/components/Modals/utils/createContextModal';
import { Form, InputText, useForm } from '~/libs/form';

const schema = z.object({
  name: z.string(),
});

const { openModal, Modal } = createContextModal({
  name: 'civitai-link-wizard',
  title: 'Civitai Link Setup',
  closeOnClickOutside: false,
  size: 800,
  Element: ({ context, props }) => {
    const [key, setKey] = useState<string>('TEST_KEY');
    const [active, setActive] = useState(0);
    const nextStep = () => setActive((current) => (current < 2 ? current + 1 : current));
    const prevStep = () => setActive((current) => (current > 0 ? current - 1 : current));

    const form = useForm({
      schema,
    });

    const { connected, selectInstance, selectedInstance } = useCivitaiLink();
    const { mutate: createLinkInstance, isLoading: isCreatingLinkInstance } =
      useCreateLinkInstance();
    const { mutate: updateLinkInstance, isLoading: isUpdatingLinkInstance } =
      useUpdateLinkInstance();

    const handleCreateInstance = () => {
      nextStep();
      if (!key && !isCreatingLinkInstance) {
        createLinkInstance(undefined, {
          onSuccess: (result) => {
            selectInstance({ key: result.key });
            setKey(result.key);
            nextStep();
          },
        });
      }
    };

    const handleSubmit = (data: z.infer<typeof schema>) => {
      if (selectedInstance) updateLinkInstance({ ...data, id: selectedInstance.id });
    };

    return (
      <>
      {/* TODO.civitai-link - determine different variable to use here... `connected` is not correct */}
        {!connected ? (
          <Stepper
            active={active}
            onStepClick={setActive}
            breakpoint="sm"
            // allowNextStepsSelect={false} // TODO.civitai-link - update mantine
          >
            <Stepper.Step label="About Civitai Link" description="Learn what it does">
              <Stack>
                {/* TODO.civitai-link - add intro content */}
                <Group position="apart" mt="xl">
                  <Button variant="default" onClick={context.close}>
                    Eh, nevermind...
                  </Button>
                  <Button
                    onClick={nextStep}
                    leftIcon={<IconChevronRight />}
                  >{`Let's do it!`}</Button>
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
                    loading={isCreatingLinkInstance}
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
                  {key ? (
                    <CopyButton value={key}>
                      {({ copied, copy }) => (
                        <Tooltip label="copy">
                          <Button
                            variant="default"
                            onClick={copy}
                            rightIcon={copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
                          >
                            {!copied ? key : 'Copied'}
                          </Button>
                        </Tooltip>
                      )}
                    </CopyButton>
                  ) : (
                    <Button variant="default" px="xl" py="sm">
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
        ) : (
          <Center>
            <Stack>
              <Stack spacing={0} justify="center">
                <ThemeIcon color="green">
                  <IconCheck />
                </ThemeIcon>
                <Title align="center">{`You're connected!`}</Title>
              </Stack>

              <Form form={form} onSubmit={handleSubmit}>
                <Stack>
                  <InputText
                    name="name"
                    label="Name your stable diffusion instance"
                    placeholder="name"
                  />
                  <Button type="submit" loading={isUpdatingLinkInstance}>
                    Save
                  </Button>
                </Stack>
              </Form>
            </Stack>
          </Center>
        )}
      </>
    );
  },
});

export const openCivitaiLinkModal = openModal;
export default Modal;
