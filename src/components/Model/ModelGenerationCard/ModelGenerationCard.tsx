import {
  ActionIcon,
  Anchor,
  Button,
  Card,
  Chip,
  Group,
  Image,
  Menu,
  Modal,
  Popover,
  ScrollArea,
  Stack,
  Text,
  createStyles,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconAlertCircle, IconDotsVertical } from '@tabler/icons-react';
import { IconInfoCircle, IconPlus } from '@tabler/icons-react';
import React, { useState } from 'react';
import { z } from 'zod';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { Form, InputText, InputTextArea, useForm } from '~/libs/form';

const schema = z.object({
  name: z.string().trim().min(1, 'Please provide a name'),
  prompt: z.string().trim().min(1, 'Please provide a prompt'),
});

const useStyles = createStyles((theme, _params, getRef) => ({
  label: {
    padding: `0 ${theme.spacing.xs}px`,

    '&[data-checked]': {
      '&, &:hover': {
        backgroundColor: theme.colors.blue[theme.fn.primaryShade()],
        color: theme.white,
      },

      [`& .${getRef('iconWrapper')}`]: {
        display: 'none',
      },
    },
  },

  iconWrapper: {
    ref: getRef('iconWrapper'),
  },
}));

export function ModelGenerationCard() {
  const { classes } = useStyles();
  const [selectedPrompt, setSelectedPrompt] = useState('woman');
  const [opened, { toggle, close }] = useDisclosure();
  const form = useForm({ schema, defaultValues: { name: '', prompt: '' } });

  const handleSubmit = (data: z.infer<typeof schema>) => {
    console.log(data);
    close();
  };

  return (
    <>
      <Card sx={{ maxWidth: 300 }} withBorder>
        <Card.Section py="xs" inheritPadding>
          <Group spacing="xs" position="apart">
            <Group spacing={8}>
              <Image
                src="http://placekitten.com/32/32"
                width="32"
                height="32"
                alt="some alt"
                withPlaceholder
              />
              <Stack spacing={0}>
                <Text size="sm" weight="bold">
                  Generated Exploration
                </Text>
                <Text size="xs" color="dimmed">
                  A service provided by{' '}
                  <Anchor
                    href="https://picfinder.ai"
                    target="_blank"
                    rel="noopened noreferrer"
                    inherit
                    span
                  >
                    PicFinder
                  </Anchor>
                </Text>
              </Stack>
            </Group>
            <Popover width={300} withArrow withinPortal>
              <Popover.Target>
                <ActionIcon radius="xl" variant="transparent">
                  <IconInfoCircle />
                </ActionIcon>
              </Popover.Target>
              <Popover.Dropdown>
                The images you see here are being generated on demand by the PicFinder service.
                Select one of the pre-defined prompts from the creator below to start exploring the
                unlimited possibilities.
              </Popover.Dropdown>
            </Popover>
          </Group>
        </Card.Section>
        <Card.Section>
          <Image
            src="http://placekitten.com/300/300"
            height="300"
            width="300"
            alt="some alt"
            withPlaceholder
          />
        </Card.Section>
        <Card.Section py="xs" inheritPadding>
          <Group spacing={8}>
            <ActionIcon variant="outline" size="sm" onClick={toggle}>
              <IconPlus />
            </ActionIcon>
            <ScrollArea type="never">
              <Chip.Group
                spacing={4}
                value={selectedPrompt}
                onChange={setSelectedPrompt}
                multiple={false}
                noWrap
              >
                <Chip classNames={classes} value="woman" size="xs" radius="sm">
                  <Group spacing={4} position="apart" noWrap>
                    <Text inherit inline>
                      Woman
                    </Text>
                    <Menu position="top-end" withinPortal>
                      <Menu.Target>
                        <ActionIcon size="xs" variant="transparent">
                          <IconDotsVertical />
                        </ActionIcon>
                      </Menu.Target>
                      <Menu.Dropdown>
                        <Menu.Item color="red">Delete</Menu.Item>
                        <Menu.Item>Edit</Menu.Item>
                      </Menu.Dropdown>
                    </Menu>
                  </Group>
                </Chip>
                <Chip classNames={classes} value="man" size="xs" radius="sm">
                  <Group spacing={4} position="apart" noWrap>
                    <Text inherit inline>
                      Man
                    </Text>
                    <Menu position="top-end" withinPortal>
                      <Menu.Target>
                        <ActionIcon size="xs" variant="transparent">
                          <IconDotsVertical />
                        </ActionIcon>
                      </Menu.Target>
                      <Menu.Dropdown>
                        <Menu.Item color="red">Delete</Menu.Item>
                        <Menu.Item>Edit</Menu.Item>
                      </Menu.Dropdown>
                    </Menu>
                  </Group>
                </Chip>
              </Chip.Group>
            </ScrollArea>
          </Group>
        </Card.Section>
      </Card>
      <Modal opened={opened} onClose={toggle} title="Add Explorable Prompt">
        <Form form={form} onSubmit={handleSubmit}>
          <Stack spacing="xs">
            <AlertWithIcon icon={<IconAlertCircle />} px="xs">
              {`This will generate images similar to the one you've selected with the level of variation driven by your selection below.`}
            </AlertWithIcon>
            <InputText
              name="name"
              label="Display name"
              placeholder="e.g.: Unicorn kitten"
              withAsterisk
            />
            <InputTextArea
              name="prompt"
              label="Prompt"
              placeholder="Type in your prompt..."
              rows={3}
              withAsterisk
            />
            <Group position="right">
              <Button type="submit">Add</Button>
            </Group>
          </Stack>
        </Form>
      </Modal>
    </>
  );
}
