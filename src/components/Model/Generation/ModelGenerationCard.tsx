import {
  ActionIcon,
  Anchor,
  Card,
  Center,
  Chip,
  Group,
  Image,
  Loader,
  Menu,
  Popover,
  ScrollArea,
  Stack,
  Text,
  createStyles,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconChevronRight, IconDotsVertical, IconEdit, IconTrash } from '@tabler/icons-react';
import { IconInfoCircle, IconPlus } from '@tabler/icons-react';
import React, { useEffect, useRef, useState } from 'react';

import { GenerationPromptModal } from '~/components/Model/Generation/GenerationPromptModal';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { usePicFinder } from '~/libs/picfinder';

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

  nextButton: {
    backgroundColor: theme.colors.gray[0],
    color: theme.colors.dark[9],
    opacity: 0.65,
    transition: 'opacity 300ms ease',

    '&:hover': {
      opacity: 1,
      backgroundColor: theme.colors.gray[0],
    },

    '&[data-loading="true"]': {
      backgroundColor: theme.colors.dark[6],
    },
  },
}));

const hardPrompts = [
  { name: 'Woman', prompt: 'a woman -no bikini, underwear, nsfw', index: 0 },
  { name: 'Man', prompt: 'a man wearing sunglasses -no underware, nsfw', index: 1 },
  { name: 'Tiger', prompt: 'a tiger', index: 2 },
];

type Props = { columnWidth: number; height: number };

export function ModelGenerationCard({ columnWidth, height }: Props) {
  const currentUser = useCurrentUser();
  const { classes } = useStyles();

  const [selectedPrompt, setSelectedPrompt] = useState(hardPrompts[0]);
  const [state, setState] = useState(
    hardPrompts.reduce((acc, prompt) => {
      acc[prompt.name] = { imageIndex: 0 };

      return acc;
    }, {} as Record<string, { imageIndex: number }>)
  );
  const [opened, { toggle }] = useDisclosure();

  const viewportRef = useRef<HTMLDivElement>(null);
  const { images, loading, getImages, prompt, setPrompt } = usePicFinder({
    initialPrompt: selectedPrompt.prompt,
    initialFetchCount: 3,
  });

  const isModerator = currentUser?.isModerator ?? false;
  const currentIndex = state[selectedPrompt.name].imageIndex;

  return (
    <>
      <Card sx={{ maxWidth: columnWidth }} withBorder>
        <Card.Section py="xs" inheritPadding withBorder>
          <Group spacing="xs" position="apart">
            <Group spacing={8}>
              <Image
                src="http://placekitten.com/32/32"
                width="32"
                height="32"
                alt="some alt"
                radius="sm"
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
        <Card.Section sx={{ position: 'relative', height: height, overflow: 'hidden' }}>
          {loading && !images.length ? (
            <Center h="100%">
              <Loader size="md" variant="bars" />
            </Center>
          ) : (
            <>
              <div
                ref={viewportRef}
                style={{
                  overflow: 'hidden',
                  display: 'flex',
                  scrollSnapType: 'x mandatory',
                }}
              >
                {images.map((url, index) => (
                  <Image
                    key={index}
                    src={url}
                    height={height}
                    width={columnWidth}
                    alt={`AI generated image with prompt: ${prompt}`}
                    styles={{
                      image: { objectPosition: 'top' },
                      root: { scrollSnapAlign: 'start' },
                    }}
                  />
                ))}
              </div>
              <ActionIcon
                className={classes.nextButton}
                radius="xl"
                size="md"
                color="gray"
                p={4}
                loading={loading && currentIndex >= images.length}
                sx={{ position: 'absolute', top: '50%', right: 10 }}
                onClick={() => {
                  viewportRef.current?.scrollBy({ left: columnWidth, behavior: 'smooth' });
                  setState((current) => ({
                    ...current,
                    [selectedPrompt.name]: {
                      imageIndex: current[selectedPrompt.name].imageIndex + 1,
                    },
                  }));
                  getImages(2);
                }}
              >
                <IconChevronRight />
              </ActionIcon>
            </>
          )}
        </Card.Section>
        <Card.Section py="xs" inheritPadding withBorder>
          <Group spacing={8} noWrap>
            {isModerator && (
              <ActionIcon variant="outline" size="sm" onClick={toggle}>
                <IconPlus />
              </ActionIcon>
            )}
            <ScrollArea type="never">
              <Chip.Group
                spacing={4}
                value={prompt}
                onChange={(prompt) => {
                  setPrompt(prompt);
                  const selected = hardPrompts.find((p) => p.prompt === prompt);

                  if (selected) {
                    setSelectedPrompt(selected);
                    const imageIndex = state[selected.name].imageIndex;
                    viewportRef.current?.scrollTo({ left: columnWidth * imageIndex });
                  }
                }}
                multiple={false}
                noWrap
              >
                {hardPrompts.map((prompt) => (
                  <Chip
                    key={prompt.name}
                    classNames={classes}
                    value={prompt.prompt}
                    size="xs"
                    radius="sm"
                  >
                    <Group spacing={4} position="apart" noWrap>
                      <Text inherit inline>
                        {prompt.name}
                      </Text>
                      {isModerator && (
                        <Menu position="top-end" withinPortal>
                          <Menu.Target>
                            <ActionIcon size="xs" variant="transparent">
                              <IconDotsVertical />
                            </ActionIcon>
                          </Menu.Target>
                          <Menu.Dropdown>
                            <Menu.Item color="red" icon={<IconTrash size={14} stroke={1.5} />}>
                              Delete
                            </Menu.Item>
                            <Menu.Item icon={<IconEdit size={14} stroke={1.5} />} onClick={toggle}>
                              Edit
                            </Menu.Item>
                          </Menu.Dropdown>
                        </Menu>
                      )}
                    </Group>
                  </Chip>
                ))}
              </Chip.Group>
            </ScrollArea>
          </Group>
        </Card.Section>
      </Card>
      {isModerator && (
        <GenerationPromptModal prompt={selectedPrompt} opened={opened} onClose={toggle} />
      )}
    </>
  );
}
