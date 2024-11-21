import {
  ActionIcon,
  Anchor,
  Card,
  Center,
  Chip,
  Group,
  Image,
  Indicator,
  Loader,
  Menu,
  Popover,
  ScrollArea,
  Stack,
  Text,
  createStyles,
} from '@mantine/core';
import { getHotkeyHandler } from '@mantine/hooks';
import { openConfirmModal } from '@mantine/modals';
import { ModelVersionExploration } from '~/shared/utils/prisma/models';
import {
  IconChevronLeft,
  IconChevronRight,
  IconDotsVertical,
  IconEdit,
  IconTrash,
} from '@tabler/icons-react';
import { IconInfoCircle, IconPlus } from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';

import { DismissibleAlert } from '~/components/DismissibleAlert/DismissibleAlert';
import { GenerationPromptModal } from '~/components/Model/Generation/GenerationPromptModal';
import { usePicFinder } from '~/libs/picfinder';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

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

  root: { display: 'flex' },

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

type Props = {
  columnWidth: number;
  height: number;
  versionId: number;
  modelId?: number;
  withEditingActions?: boolean;
};
type State = { modalOpened: boolean; editingPrompt: ModelVersionExploration | undefined };

export function ModelGenerationCard({
  columnWidth,
  height,
  versionId,
  modelId,
  withEditingActions,
}: Props) {
  const { classes, theme } = useStyles();
  const queryUtils = trpc.useContext();

  const { data = [] } = trpc.modelVersion.getExplorationPromptsById.useQuery({ id: versionId });

  const [state, setState] = useState<State>({
    modalOpened: false,
    editingPrompt: data[0],
  });
  const [availablePrompts, setAvailablePrompts] = useState(
    data.reduce((acc, prompt) => {
      acc[prompt.name] = { imageIndex: 0 };

      return acc;
    }, {} as Record<string, { imageIndex: number }>)
  );
  const viewportRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  const initialPrompt = data[0]?.prompt;
  const { images, loading, getImages, prompt, setPrompt } = usePicFinder({
    initialPrompt,
    modelId,
    initialFetchCount: 9,
  });

  const deletePromptMutation = trpc.modelVersion.deleteExplorationPrompt.useMutation({
    async onMutate({ name }) {
      await queryUtils.modelVersion.getExplorationPromptsById.cancel();
      const previousData = queryUtils.modelVersion.getExplorationPromptsById.getData({
        id: versionId,
      });

      if (previousData) {
        const updated = previousData.filter((p) => p.name !== name);
        queryUtils.modelVersion.getExplorationPromptsById.setData({ id: versionId }, updated);

        if (updated.length > 0) setPrompt(updated[0].prompt);
      }

      return { previousData };
    },
    onError(error, _, context) {
      showErrorNotification({
        title: 'Failed to delete prompt',
        error: new Error(error.message),
        reason: 'Unable to delete prompt. Please try again',
      });
      queryUtils.modelVersion.getExplorationPromptsById.setData(
        { id: versionId },
        context?.previousData
      );
    },
  });
  const handleDeletePrompt = (promptName: string) => {
    openConfirmModal({
      title: 'Delete Prompt',
      children: `Are you sure you want to delete this prompt?`,
      labels: { confirm: 'Delete', cancel: "No, don't delete it" },
      confirmProps: { color: 'red' },
      onConfirm: () => {
        deletePromptMutation.mutate({ id: versionId, name: promptName, modelId });
      },
    });
  };

  const selectedPrompt = data.find((p) => p.prompt === prompt);
  const currentIndex = selectedPrompt ? availablePrompts[selectedPrompt.name]?.imageIndex : 0;
  // get viewport width
  const imageContainerWidth = cardRef.current?.clientWidth ?? 0;

  useEffect(() => {
    if (data.length > 0 && !prompt) setPrompt(data[0].prompt);
  }, [data, prompt, setPrompt]);

  return (
    <>
      <Indicator
        label="New"
        radius="sm"
        color="yellow"
        size={24}
        styles={{ indicator: { transform: 'translate(5px,-10px) !important' } }}
        withBorder
      >
        <Card
          ref={cardRef}
          sx={{
            backgroundColor: theme.colors.dark[7],
            boxShadow: `0 0 8px 0 ${theme.colors.yellow[7]}`,
          }}
          withBorder
        >
          <Card.Section py="xs" inheritPadding withBorder>
            <Stack spacing={4}>
              <Group spacing="xs" position="apart">
                <Group spacing={8}>
                  <Image
                    src="https://downloads.intercomcdn.com/i/o/415875/17821df0928378c5e14e54e6/17c1c63527031e39c565ab2c57308471.png"
                    width={32}
                    height={32}
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
                        rel="nofollow noreferrer"
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
                    Select one of the pre-defined prompts from the creator below to start exploring
                    the unlimited possibilities.
                  </Popover.Dropdown>
                </Popover>
              </Group>
              <DismissibleAlert
                id="generated-exploration"
                content="These images are generated on demand. Press the next button to generate another image or select a different preset prompt below."
              />
            </Stack>
          </Card.Section>
          <Card.Section
            sx={{ position: 'relative', height, overflow: 'hidden' }}
            onKeyDown={getHotkeyHandler([
              ['ArrowLeft', (e) => e.preventDefault()],
              ['ArrowRight', (e) => e.preventDefault()],
            ])}
          >
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
                      width={imageContainerWidth}
                      alt={`AI generated image with prompt: ${prompt}`}
                      styles={{
                        image: { objectPosition: 'top' },
                        root: { scrollSnapAlign: 'start' },
                      }}
                    />
                  ))}
                </div>
                {!!data.length && !!images.length && currentIndex > 0 && (
                  <ActionIcon
                    className={classes.nextButton}
                    radius="xl"
                    size="md"
                    color="gray"
                    p={4}
                    sx={{ position: 'absolute', top: '50%', left: 10 }}
                    onClick={() => {
                      viewportRef.current?.scrollBy({
                        left: imageContainerWidth * -1,
                        behavior: 'smooth',
                      });

                      if (selectedPrompt) {
                        setAvailablePrompts((current) => ({
                          ...current,
                          [selectedPrompt.name]: {
                            imageIndex: (current[selectedPrompt.name]?.imageIndex ?? 0) - 1,
                          },
                        }));
                      }
                    }}
                  >
                    <IconChevronLeft />
                  </ActionIcon>
                )}
                {!!data.length && !!images.length && (
                  <ActionIcon
                    className={classes.nextButton}
                    radius="xl"
                    size="md"
                    color="gray"
                    p={4}
                    loading={loading && currentIndex >= images.length}
                    sx={{ position: 'absolute', top: '50%', right: 10 }}
                    onClick={() => {
                      viewportRef.current?.scrollBy({
                        left: imageContainerWidth,
                        behavior: 'smooth',
                      });
                      const shouldGetMoreImages = currentIndex > images.length - 3;
                      if (shouldGetMoreImages) getImages(9);

                      if (selectedPrompt)
                        setAvailablePrompts((current) => ({
                          ...current,
                          [selectedPrompt.name]: {
                            imageIndex: (current[selectedPrompt.name]?.imageIndex ?? 0) + 1,
                          },
                        }));
                    }}
                  >
                    <IconChevronRight />
                  </ActionIcon>
                )}
              </>
            )}
          </Card.Section>
          <Card.Section pt="xs" inheritPadding withBorder>
            <Group spacing={8} align="flex-start" noWrap>
              {withEditingActions && (
                <ActionIcon
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setState((current) => ({
                      ...current,
                      modalOpened: true,
                      editingPrompt: undefined,
                    }))
                  }
                >
                  <IconPlus />
                </ActionIcon>
              )}
              <ScrollArea styles={{ viewport: { overflowY: 'hidden' } }} offsetScrollbars>
                <Chip.Group
                  spacing={4}
                  value={prompt}
                  onChange={(prompt) => {
                    setPrompt(prompt);
                    const selected = data.find((p) => p.prompt === prompt);

                    if (selected) {
                      const imageIndex = availablePrompts[selected.name]?.imageIndex;
                      viewportRef.current?.scrollTo({ left: columnWidth * imageIndex });
                    }
                  }}
                  multiple={false}
                  noWrap
                >
                  {data.map((prompt) => (
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
                        {withEditingActions && (
                          <Menu position="top-end" withinPortal>
                            <Menu.Target>
                              <ActionIcon size="xs" variant="transparent">
                                <IconDotsVertical />
                              </ActionIcon>
                            </Menu.Target>
                            <Menu.Dropdown>
                              <Menu.Item
                                color="red"
                                icon={<IconTrash size={14} stroke={1.5} />}
                                onClick={() => handleDeletePrompt(prompt.name)}
                              >
                                Delete
                              </Menu.Item>
                              <Menu.Item
                                icon={<IconEdit size={14} stroke={1.5} />}
                                onClick={() => {
                                  const selected = data.find((p) => p.prompt === prompt.prompt);
                                  if (selected)
                                    setState((current) => ({
                                      ...current,
                                      modalOpened: true,
                                      editingPrompt: selected,
                                    }));
                                }}
                              >
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
      </Indicator>
      {withEditingActions && (
        <GenerationPromptModal
          prompt={state.editingPrompt}
          opened={state.modalOpened}
          onClose={() => {
            setState((current) => ({ ...current, modalOpened: false, editingPrompt: undefined }));
          }}
          modelId={modelId}
          versionId={versionId}
          nextIndex={data.length}
        />
      )}
    </>
  );
}
